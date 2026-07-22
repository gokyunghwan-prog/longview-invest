import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubDateTrustedClock,
  HTTP_DATE_RESOLUTION_MS,
  TrustedClockError,
  createGitHubDateTrustedClock
} from "../autotrade/trusted-clock.mjs";

const DATE_HEADER = "Wed, 22 Jul 2026 10:23:45 GMT";
const DATE_MS = Date.parse(DATE_HEADER);

function response({
  status = 200,
  date = DATE_HEADER,
  age = null,
  redirected = false
} = {}) {
  return {
    status,
    redirected,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === "date") return date;
        if (String(name).toLowerCase() === "age") return age;
        return null;
      }
    }
  };
}

function assertCode(expected) {
  return (error) => {
    assert.ok(error instanceof TrustedClockError);
    assert.equal(error.code, expected);
    return true;
  };
}

test("GitHub Date와 RTT로 보수적인 현재시각 범위를 만든다", async () => {
  let monotonic = 1_000;
  const clock = createGitHubDateTrustedClock({
    sample: async () => {
      monotonic += 40;
      return response();
    },
    monotonicNow: () => monotonic,
    maxRttMs: 100,
    ttlMs: 2_000
  });

  const refreshed = await clock.refresh();
  assert.equal(refreshed.earliest.getTime(), DATE_MS);
  assert.equal(
    refreshed.latest.getTime(),
    DATE_MS + HTTP_DATE_RESOLUTION_MS - 1 + 40
  );
  assert.equal(refreshed.uncertaintyMs, 1_039);
  assert.equal(refreshed.rttMs, 40);
  assert.equal(refreshed.ageMs, 0);

  monotonic += 250;
  const later = clock.bounds();
  assert.equal(later.earliest.getTime(), DATE_MS + 250);
  assert.equal(later.latest.getTime(), DATE_MS + 1_289);
  assert.equal(later.ageMs, 250);
  assert.equal(clock.now().getTime(), DATE_MS + 769);
});

test("로컬 wall clock 없이 monotonic 경과시간만으로 진행한다", async () => {
  let monotonic = 50;
  const clock = new GitHubDateTrustedClock({
    sample: async () => response(),
    monotonicNow: () => monotonic,
    ttlMs: 10_000
  });
  await clock.refresh();
  const first = clock.now().getTime();
  monotonic += 3_500;
  const second = clock.now().getTime();
  assert.equal(second - first, 3_500);
});

test("동시에 요청된 refresh는 한 GitHub 샘플을 공유한다", async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const clock = new GitHubDateTrustedClock({
    sample: async () => {
      calls += 1;
      await pending;
      return response();
    },
    monotonicNow: () => 10
  });

  const first = clock.refresh();
  const second = clock.refresh();
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("동기화 전과 TTL 만료 후에는 fail-closed 한다", async () => {
  let monotonic = 100;
  const clock = new GitHubDateTrustedClock({
    sample: async () => response(),
    monotonicNow: () => monotonic,
    ttlMs: 500
  });
  assert.throws(() => clock.now(), assertCode("TRUSTED_CLOCK_NOT_READY"));
  await clock.refresh();
  monotonic += 500;
  assert.doesNotThrow(() => clock.bounds());
  monotonic += 1;
  assert.throws(() => clock.bounds(), assertCode("TRUSTED_CLOCK_STALE"));
});

test("GitHub 응답 실패와 신뢰할 수 없는 HTTP metadata를 거부한다", async (t) => {
  const cases = [
    ["응답 형식 누락", null, "TRUSTED_CLOCK_SAMPLE_INVALID"],
    ["status 누락", { dateHeader: DATE_HEADER }, "TRUSTED_CLOCK_SAMPLE_INVALID"],
    ["비 2xx", response({ status: 503 }), "TRUSTED_CLOCK_HTTP_ERROR"],
    ["redirect", response({ redirected: true }), "TRUSTED_CLOCK_REDIRECTED"],
    ["Date 누락", response({ date: null }), "TRUSTED_CLOCK_DATE_MISSING"],
    ["Date 형식 오류", response({ date: "2026-07-22T10:23:45Z" }), "TRUSTED_CLOCK_DATE_INVALID"],
    ["요일 불일치", response({ date: "Thu, 22 Jul 2026 10:23:45 GMT" }), "TRUSTED_CLOCK_DATE_INVALID"],
    ["캐시 응답", response({ age: "1" }), "TRUSTED_CLOCK_CACHED_RESPONSE"],
    ["잘못된 Age", response({ age: "invalid" }), "TRUSTED_CLOCK_CACHED_RESPONSE"]
  ];

  for (const [name, sampled, code] of cases) {
    await t.test(name, async () => {
      const clock = new GitHubDateTrustedClock({
        sample: async () => sampled,
        monotonicNow: () => 10
      });
      await assert.rejects(clock.refresh(), assertCode(code));
      assert.throws(() => clock.bounds(), assertCode("TRUSTED_CLOCK_NOT_READY"));
    });
  }
});

test("샘플 함수 오류 메시지를 노출하지 않고 고정 오류로 닫힌다", async () => {
  const secret = "github_pat_must_not_leak";
  const clock = new GitHubDateTrustedClock({
    sample: async () => {
      throw new Error(secret);
    },
    monotonicNow: () => 1
  });
  await assert.rejects(clock.refresh(), (error) => {
    assert.equal(error.code, "TRUSTED_CLOCK_SAMPLE_FAILED");
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

test("RTT가 상한을 넘으면 샘플을 설치하지 않는다", async () => {
  let monotonic = 0;
  const clock = new GitHubDateTrustedClock({
    sample: async () => {
      monotonic = 101;
      return response();
    },
    monotonicNow: () => monotonic,
    maxRttMs: 100
  });
  await assert.rejects(clock.refresh(), assertCode("TRUSTED_CLOCK_RTT_EXCEEDED"));
  assert.throws(() => clock.now(), assertCode("TRUSTED_CLOCK_NOT_READY"));
});

test("refresh 도중과 사용 도중 monotonic rollback을 거부한다", async (t) => {
  await t.test("refresh 도중 rollback", async () => {
    let reads = 0;
    const clock = new GitHubDateTrustedClock({
      sample: async () => response(),
      monotonicNow: () => (reads++ === 0 ? 10 : 9)
    });
    await assert.rejects(clock.refresh(), assertCode("TRUSTED_CLOCK_MONOTONIC_ROLLBACK"));
  });

  await t.test("사용 도중 rollback", async () => {
    let monotonic = 10;
    const clock = new GitHubDateTrustedClock({
      sample: async () => response(),
      monotonicNow: () => monotonic
    });
    await clock.refresh();
    monotonic = 9;
    assert.throws(() => clock.bounds(), assertCode("TRUSTED_CLOCK_MONOTONIC_ROLLBACK"));
  });
});

test("유효기간 안의 연속 Date 샘플이 불일치하면 기존 시각을 보존한다", async () => {
  let monotonic = 0;
  let date = DATE_HEADER;
  const clock = new GitHubDateTrustedClock({
    sample: async () => response({ date }),
    monotonicNow: () => monotonic,
    ttlMs: 5_000
  });
  await clock.refresh();
  const before = clock.bounds();

  monotonic += 100;
  date = "Wed, 22 Jul 2026 16:53:45 GMT";
  await assert.rejects(
    clock.refresh(),
    assertCode("TRUSTED_CLOCK_SAMPLE_INCONSISTENT")
  );
  const after = clock.bounds();
  assert.equal(after.earliest.getTime(), before.earliest.getTime() + 100);
});

test("TTL이 지난 뒤에도 이전 샘플과 모순되는 재동기화는 허용하지 않는다", async () => {
  let monotonic = 0;
  let date = DATE_HEADER;
  const clock = new GitHubDateTrustedClock({
    sample: async () => response({ date }),
    monotonicNow: () => monotonic,
    ttlMs: 100
  });
  await clock.refresh();
  monotonic = 101;
  assert.throws(() => clock.bounds(), assertCode("TRUSTED_CLOCK_STALE"));

  date = "Wed, 22 Jul 2026 16:53:45 GMT";
  await assert.rejects(
    clock.refresh(),
    assertCode("TRUSTED_CLOCK_SAMPLE_INCONSISTENT")
  );
});

test("겹치는 연속 샘플은 교집합으로 bounds를 좁히고 now를 역행시키지 않는다", async () => {
  let monotonic = 0;
  let date = DATE_HEADER;
  const clock = new GitHubDateTrustedClock({
    sample: async () => response({ date }),
    monotonicNow: () => monotonic,
    maxRttMs: 500
  });
  await clock.refresh();
  monotonic = 900;
  const used = clock.now().getTime();

  monotonic = 1_050;
  date = "Wed, 22 Jul 2026 10:23:46 GMT";
  const refreshed = await clock.refresh();
  assert.ok(refreshed.uncertaintyMs < HTTP_DATE_RESOLUTION_MS);
  assert.ok(clock.now().getTime() >= used);
});

test("생성자 설정값과 monotonic 값도 fail-closed 검증한다", async (t) => {
  assert.throws(() => new GitHubDateTrustedClock(), /샘플 함수/);
  assert.throws(
    () => new GitHubDateTrustedClock({ sample: async () => response(), ttlMs: 0 }),
    /TTL/
  );
  assert.throws(
    () => new GitHubDateTrustedClock({ sample: async () => response(), maxRttMs: Infinity }),
    /RTT/
  );

  for (const invalid of [Number.NaN, -1, Infinity]) {
    await t.test(`monotonic=${String(invalid)}`, async () => {
      const clock = new GitHubDateTrustedClock({
        sample: async () => response(),
        monotonicNow: () => invalid
      });
      await assert.rejects(
        clock.refresh(),
        assertCode("TRUSTED_CLOCK_MONOTONIC_INVALID")
      );
    });
  }
});
