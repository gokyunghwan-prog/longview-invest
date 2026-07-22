import test from "node:test";
import assert from "node:assert/strict";

import {
  CLOUD_STATE_ALGORITHM,
  CLOUD_STATE_BRANCH,
  CloudStateConflictError,
  GitHubEncryptedStateStore,
  decryptCloudState,
  encryptCloudState,
  parseCloudStateEncryptionKey,
  redactCloudStateSecrets
} from "../autotrade/cloud-state.mjs";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 8).toString("base64");
const OLD_SHA = "1".repeat(40);
const NEW_SHA = "2".repeat(40);
const TOKEN = "github_pat_example_secret_value_1234567890";
const STATE = {
  schemaVersion: 1,
  strategy: { inFlight: null, completedCycleKeys: ["cycle-1"] }
};

function jsonResponse(status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function contentPayload(envelope, sha = OLD_SHA) {
  return {
    type: "file",
    encoding: "base64",
    size: Buffer.byteLength(envelope, "utf8"),
    sha,
    content: Buffer.from(envelope, "utf8").toString("base64")
  };
}

function refPayload(branch, sha = OLD_SHA) {
  return {
    ref: `refs/heads/${branch}`,
    object: { type: "commit", sha }
  };
}

function createStore(fetchImpl, options = {}) {
  return new GitHubEncryptedStateStore({
    repository: "owner/private-trade-state",
    token: TOKEN,
    encryptionKey: KEY,
    fetchImpl,
    apiBaseUrl: "https://api.github.test/",
    ...options
  });
}

test("32바이트 표준 base64 키만 허용한다", () => {
  assert.equal(parseCloudStateEncryptionKey(KEY).length, 32);
  for (const invalid of [
    "",
    "not-base64",
    Buffer.alloc(31).toString("base64"),
    Buffer.alloc(33).toString("base64"),
    KEY.slice(0, -1),
    KEY.replace(/=$/, "=="),
    ` ${KEY}`,
    `${KEY}\n`
  ]) {
    assert.throws(() => parseCloudStateEncryptionKey(invalid), (error) => {
      assert.equal(error.code, "CLOUD_STATE_VALIDATION");
      assert.doesNotMatch(error.message, /BwcHBw/);
      return true;
    });
  }
});

test("AES-256-GCM envelope은 평문을 숨기고 왕복 복호화된다", () => {
  const envelope = encryptCloudState(STATE, KEY, { associatedData: "repo\0branch\0path" });
  const parsed = JSON.parse(envelope);
  assert.equal(parsed.algorithm, CLOUD_STATE_ALGORITHM);
  assert.equal(parsed.version, 1);
  assert.doesNotMatch(envelope, /completedCycleKeys|cycle-1/);
  assert.deepEqual(
    decryptCloudState(envelope, KEY, { associatedData: "repo\0branch\0path" }),
    STATE
  );
});

test("같은 상태도 매번 새 IV를 사용해 다른 암호문을 만든다", () => {
  const first = encryptCloudState(STATE, KEY);
  const second = encryptCloudState(STATE, KEY);
  assert.notEqual(first, second);
  assert.notEqual(JSON.parse(first).iv, JSON.parse(second).iv);
});

test("키·AAD·인증태그·암호문 변조는 인증 실패로 닫힌다", () => {
  const envelope = encryptCloudState(STATE, KEY, { associatedData: "expected" });
  assert.throws(
    () => decryptCloudState(envelope, OTHER_KEY, { associatedData: "expected" }),
    (error) => error.code === "CLOUD_STATE_AUTHENTICATION_FAILED"
  );
  assert.throws(
    () => decryptCloudState(envelope, KEY, { associatedData: "different" }),
    (error) => error.code === "CLOUD_STATE_AUTHENTICATION_FAILED"
  );
  for (const field of ["authTag", "ciphertext"]) {
    const parsed = JSON.parse(envelope);
    const bytes = Buffer.from(parsed[field], "base64");
    bytes[0] ^= 1;
    parsed[field] = bytes.toString("base64");
    assert.throws(
      () => decryptCloudState(JSON.stringify(parsed), KEY, { associatedData: "expected" }),
      (error) => error.code === "CLOUD_STATE_AUTHENTICATION_FAILED"
    );
  }
});

test("평문과 envelope 최대크기를 각각 제한한다", () => {
  assert.throws(
    () => encryptCloudState({ payload: "x".repeat(100) }, KEY, { maximumPlaintextBytes: 20 }),
    (error) => error.code === "CLOUD_STATE_TOO_LARGE"
  );
  assert.throws(
    () => encryptCloudState(STATE, KEY, { maximumEncryptedBytes: 20 }),
    (error) => error.code === "CLOUD_STATE_TOO_LARGE"
  );
  const envelope = encryptCloudState(STATE, KEY);
  assert.throws(
    () => decryptCloudState(envelope, KEY, { maximumEncryptedBytes: 20 }),
    (error) => error.code === "CLOUD_STATE_TOO_LARGE"
  );
});

test("GET은 trade-state 브랜치의 state.enc를 읽고 SHA와 복호화 상태를 반환한다", async () => {
  let request;
  const store = createStore(async (url, options) => {
    request = { url: String(url), options };
    return jsonResponse(200, contentPayload(store.encrypt(STATE)));
  });
  const loaded = await store.load();
  assert.deepEqual(loaded, { exists: true, state: STATE, sha: OLD_SHA });
  const url = new URL(request.url);
  assert.equal(url.pathname, "/repos/owner/private-trade-state/contents/state.enc");
  assert.equal(url.searchParams.get("ref"), CLOUD_STATE_BRANCH);
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(store.token, undefined);
  assert.equal(store.key, undefined);
  assert.doesNotMatch(JSON.stringify(store), new RegExp(TOKEN));
  assert.doesNotMatch(JSON.stringify(store), new RegExp(KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("sampleServerTime은 고정 저장소 URL의 Date 메타데이터만 반환하고 본문을 취소한다", async () => {
  const dateHeader = "Wed, 22 Jul 2026 10:26:55 GMT";
  const hiddenHeader = `Bearer ${TOKEN}`;
  let request;
  let canceled = false;
  const store = createStore(async (url, options) => {
    request = { url: String(url), options };
    return {
      status: 200,
      redirected: false,
      headers: {
        get(name) {
          if (name === "date") return dateHeader;
          if (name === "age") return "0";
          assert.fail(`unexpected header: ${name}`);
        },
        authorization: hiddenHeader
      },
      body: {
        cancel() {
          canceled = true;
          return Promise.resolve();
        }
      },
      secretBody: `${TOKEN} ${KEY}`
    };
  });

  const sample = await store.sampleServerTime();

  assert.deepEqual(sample, {
    status: 200,
    dateHeader,
    ageHeader: "0",
    redirected: false
  });
  assert.deepEqual(Object.keys(sample), ["status", "dateHeader", "ageHeader", "redirected"]);
  assert.equal(canceled, true);
  const url = new URL(request.url);
  assert.equal(url.origin + url.pathname, "https://api.github.test/repos/owner/private-trade-state");
  assert.match(url.searchParams.get("_longview_clock") || "", /^[0-9a-f-]{36}$/i);
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(request.options.headers["Cache-Control"], "no-cache");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.cache, "no-store");
  assert.doesNotMatch(JSON.stringify(sample), new RegExp(TOKEN));
  assert.doesNotMatch(
    JSON.stringify(sample),
    new RegExp(KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});

test("sampleServerTime은 Date 누락과 HTTP 실패 상태도 본문 없이 제한된 메타데이터로 반환한다", async () => {
  let canceled = false;
  const store = createStore(async () => ({
    status: 503,
    redirected: true,
    headers: { get: () => null, secret: TOKEN },
    body: {
      cancel() {
        canceled = true;
      }
    },
    bodyText: `${TOKEN} must not be read`
  }));

  assert.deepEqual(await store.sampleServerTime(), {
    status: 503,
    dateHeader: null,
    ageHeader: null,
    redirected: true
  });
  assert.equal(canceled, true);
});

test("GET 404는 오류나 임의 초기화 대신 명시적인 미존재 상태를 반환한다", async () => {
  const store = createStore(async () => new Response("not found", { status: 404 }));
  assert.deepEqual(await store.load(), { exists: false, state: null, sha: null });
});

test("ensureBranch는 기존 trade-state ref를 검증하고 생성 요청을 보내지 않는다", async () => {
  const calls = [];
  const store = createStore(async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse(200, refPayload(CLOUD_STATE_BRANCH, OLD_SHA));
  });
  assert.deepEqual(await store.ensureBranch(), {
    branch: CLOUD_STATE_BRANCH,
    ref: `refs/heads/${CLOUD_STATE_BRANCH}`,
    sha: OLD_SHA,
    created: false,
    raced: false
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(
    new URL(calls[0].url).pathname,
    "/repos/owner/private-trade-state/git/ref/heads/trade-state"
  );
});

test("ensureBranch는 404일 때 default branch 현재 commit에서 trade-state를 만든다", async () => {
  const calls = [];
  const store = createStore(async (url, options) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, options });
    if (calls.length === 1) return new Response(null, { status: 404 });
    if (calls.length === 2) return jsonResponse(200, { default_branch: "main" });
    if (calls.length === 3) return jsonResponse(200, refPayload("main", OLD_SHA));
    return jsonResponse(201, refPayload(CLOUD_STATE_BRANCH, OLD_SHA));
  });
  const result = await store.ensureBranch();
  assert.equal(result.created, true);
  assert.equal(result.raced, false);
  assert.equal(result.sha, OLD_SHA);
  assert.deepEqual(calls.map((call) => call.pathname), [
    "/repos/owner/private-trade-state/git/ref/heads/trade-state",
    "/repos/owner/private-trade-state",
    "/repos/owner/private-trade-state/git/ref/heads/main",
    "/repos/owner/private-trade-state/git/refs"
  ]);
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    ref: "refs/heads/trade-state",
    sha: OLD_SHA
  });
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
});

test("브랜치 생성 422 race는 target ref 재조회 성공으로만 확인한다", async () => {
  const calls = [];
  const store = createStore(async (url, options) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, method: options.method });
    if (calls.length === 1) return new Response(null, { status: 404 });
    if (calls.length === 2) return jsonResponse(200, { default_branch: "main" });
    if (calls.length === 3) return jsonResponse(200, refPayload("main", OLD_SHA));
    if (calls.length === 4) {
      return jsonResponse(422, { message: `${TOKEN} is intentionally not inspected` });
    }
    return jsonResponse(200, refPayload(CLOUD_STATE_BRANCH, NEW_SHA));
  });
  const result = await store.ensureBranch();
  assert.equal(result.created, false);
  assert.equal(result.raced, true);
  assert.equal(result.sha, NEW_SHA);
  assert.equal(calls.length, 5);
  assert.equal(calls[3].method, "POST");
  assert.deepEqual(calls[4], {
    pathname: "/repos/owner/private-trade-state/git/ref/heads/trade-state",
    method: "GET"
  });
});

test("브랜치 생성 422 뒤 target ref가 없거나 잘못되면 fail-closed한다", async () => {
  for (const finalResponse of [
    new Response(null, { status: 404 }),
    jsonResponse(200, refPayload("other", NEW_SHA))
  ]) {
    let call = 0;
    const store = createStore(async () => {
      call += 1;
      if (call === 1) return new Response(null, { status: 404 });
      if (call === 2) return jsonResponse(200, { default_branch: "main" });
      if (call === 3) return jsonResponse(200, refPayload("main", OLD_SHA));
      if (call === 4) return jsonResponse(422, { message: "race or validation error" });
      return finalResponse.clone();
    });
    await assert.rejects(() => store.ensureBranch(), (error) => {
      assert.ok(["CLOUD_STATE_HTTP_ERROR", "CLOUD_STATE_RESPONSE_INVALID"].includes(error.code));
      return true;
    });
    assert.equal(call, 5);
  }
});

test("브랜치 생성의 422 외 오류는 target ref 재조회 없이 fail-closed한다", async () => {
  let call = 0;
  const store = createStore(async () => {
    call += 1;
    if (call === 1) return new Response(null, { status: 404 });
    if (call === 2) return jsonResponse(200, { default_branch: "main" });
    if (call === 3) return jsonResponse(200, refPayload("main", OLD_SHA));
    return jsonResponse(409, { message: `${TOKEN} must not be surfaced` });
  });
  await assert.rejects(() => store.ensureBranch(), (error) => {
    assert.equal(error.code, "CLOUD_STATE_HTTP_ERROR");
    assert.equal(error.status, 409);
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
    return true;
  });
  assert.equal(call, 4);
});

test("기존 ref·default ref·생성 응답의 형식과 commit SHA를 엄격히 검증한다", async () => {
  const malformedExisting = createStore(async () =>
    jsonResponse(200, { ref: "refs/heads/trade-state", object: { type: "tag", sha: OLD_SHA } })
  );
  await assert.rejects(
    () => malformedExisting.ensureBranch(),
    (error) => error.code === "CLOUD_STATE_RESPONSE_INVALID"
  );

  let call = 0;
  const unexpectedCreatedSha = createStore(async () => {
    call += 1;
    if (call === 1) return new Response(null, { status: 404 });
    if (call === 2) return jsonResponse(200, { default_branch: "main" });
    if (call === 3) return jsonResponse(200, refPayload("main", OLD_SHA));
    return jsonResponse(201, refPayload(CLOUD_STATE_BRANCH, NEW_SHA));
  });
  await assert.rejects(
    () => unexpectedCreatedSha.ensureBranch(),
    (error) => error.code === "CLOUD_STATE_RESPONSE_INVALID"
  );
});

test("브랜치 API 오류와 과대 응답은 본문을 노출하지 않고 차단한다", async () => {
  const denied = createStore(async () =>
    jsonResponse(403, { message: `${TOKEN} should stay hidden` })
  );
  await assert.rejects(() => denied.ensureBranch(), (error) => {
    assert.equal(error.code, "CLOUD_STATE_HTTP_ERROR");
    assert.equal(error.status, 403);
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
    return true;
  });

  let call = 0;
  const oversized = createStore(async () => {
    call += 1;
    if (call === 1) return new Response(null, { status: 404 });
    return new Response("x".repeat(200), {
      status: 200,
      headers: { "Content-Length": "200" }
    });
  }, { maximumResponseBytes: 100 });
  await assert.rejects(
    () => oversized.ensureBranch(),
    (error) => error.code === "CLOUD_STATE_TOO_LARGE"
  );
});

test("404 초기화는 SHA 없이 trade-state 브랜치에 암호화 파일을 생성한다", async () => {
  const calls = [];
  const store = createStore(async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === "GET") return new Response(null, { status: 404 });
    return jsonResponse(201, { content: { sha: NEW_SHA } });
  });
  const initialized = await store.loadOrInitialize(STATE);
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.sha, NEW_SHA);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.branch, CLOUD_STATE_BRANCH);
  assert.equal("sha" in body, false);
  assert.doesNotMatch(calls[1].options.body, new RegExp(TOKEN));
  assert.doesNotMatch(calls[1].options.body, new RegExp(KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const encrypted = Buffer.from(body.content, "base64").toString("utf8");
  assert.doesNotMatch(encrypted, /cycle-1|completedCycleKeys/);
  assert.deepEqual(store.decrypt(encrypted), STATE);
});

test("기존 상태 갱신은 GET blob SHA를 PUT CAS에 그대로 사용한다", async () => {
  const calls = [];
  const store = createStore(async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === "GET") {
      return jsonResponse(200, contentPayload(store.encrypt(STATE), OLD_SHA));
    }
    return jsonResponse(200, { content: { sha: NEW_SHA } });
  });
  const result = await store.update((draft) => {
    draft.strategy.inFlight = { cycleKey: "cycle-2" };
  });
  assert.equal(result.previousSha, OLD_SHA);
  assert.equal(result.sha, NEW_SHA);
  assert.equal(result.state.strategy.inFlight.cycleKey, "cycle-2");
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.sha, OLD_SHA);
  assert.equal(body.branch, CLOUD_STATE_BRANCH);
  assert.deepEqual(store.decrypt(Buffer.from(body.content, "base64").toString("utf8")), result.state);
});

test("assertUnchanged는 원격 state.enc blob SHA가 같을 때만 fencing을 통과한다", async () => {
  let calls = 0;
  const store = createStore(async (url, options) => {
    calls += 1;
    assert.equal(options.method, "GET");
    assert.equal(new URL(url).searchParams.get("ref"), CLOUD_STATE_BRANCH);
    return jsonResponse(200, contentPayload(store.encrypt(STATE), OLD_SHA));
  });
  assert.deepEqual(await store.assertUnchanged(OLD_SHA), {
    unchanged: true,
    sha: OLD_SHA
  });
  assert.equal(calls, 1);
});

test("assertUnchanged는 SHA 변경·파일 삭제·잘못된 예상 SHA를 fail-closed한다", async () => {
  const changed = createStore(async () =>
    jsonResponse(200, contentPayload(changed.encrypt(STATE), NEW_SHA))
  );
  await assert.rejects(() => changed.assertUnchanged(OLD_SHA), (error) => {
    assert.ok(error instanceof CloudStateConflictError);
    assert.equal(error.status, 409);
    return true;
  });

  const deleted = createStore(async () => new Response(null, { status: 404 }));
  await assert.rejects(() => deleted.assertUnchanged(OLD_SHA), (error) => {
    assert.ok(error instanceof CloudStateConflictError);
    assert.equal(error.status, 404);
    return true;
  });

  let called = false;
  const invalidExpected = createStore(async () => {
    called = true;
    return new Response(null, { status: 404 });
  });
  await assert.rejects(
    () => invalidExpected.assertUnchanged("not-a-sha"),
    (error) => error.code === "CLOUD_STATE_RESPONSE_INVALID"
  );
  assert.equal(called, false);
});

for (const status of [409, 422]) {
  test(`PUT ${status} 충돌은 덮어쓰기나 재시도 없이 fail-closed한다`, async () => {
    let putCount = 0;
    const store = createStore(async (url, options) => {
      if (options.method === "GET") {
        return jsonResponse(200, contentPayload(store.encrypt(STATE), OLD_SHA));
      }
      putCount += 1;
      return jsonResponse(status, { message: `${TOKEN} must never be surfaced` });
    });
    await assert.rejects(
      () => store.update((draft) => draft),
      (error) => {
        assert.ok(error instanceof CloudStateConflictError);
        assert.equal(error.code, "CLOUD_STATE_CONFLICT");
        assert.equal(error.status, status);
        assert.doesNotMatch(error.message, new RegExp(TOKEN));
        return true;
      }
    );
    assert.equal(putCount, 1);
  });
}

test("응답 본문과 GitHub content decoded 크기 제한을 적용한다", async () => {
  const oversizedResponse = createStore(async () =>
    new Response("x".repeat(200), {
      status: 200,
      headers: { "Content-Length": "200" }
    }), { maximumResponseBytes: 100 }
  );
  await assert.rejects(
    () => oversizedResponse.load(),
    (error) => error.code === "CLOUD_STATE_TOO_LARGE"
  );

  const oversizedContent = createStore(async () => jsonResponse(200, {
    type: "file",
    encoding: "base64",
    size: 200,
    sha: OLD_SHA,
    content: Buffer.alloc(200).toString("base64")
  }), { maximumEncryptedBytes: 100 });
  await assert.rejects(
    () => oversizedContent.load(),
    (error) => error.code === "CLOUD_STATE_TOO_LARGE"
  );
});

test("제한시간을 넘긴 GitHub 요청을 중단한다", async () => {
  let signal;
  const store = createStore(async (url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, { timeoutMs: 100 });
  await assert.rejects(
    () => store.load(),
    (error) => error.code === "CLOUD_STATE_TIMEOUT"
  );
  assert.equal(signal.aborted, true);
});

test("네트워크 오류와 마스킹 함수는 token·key·계좌번호를 노출하지 않는다", async () => {
  const account = "12345678-01";
  const store = createStore(async () => {
    throw new Error(`Authorization: Bearer ${TOKEN} key=${KEY} account=${account}`);
  });
  await assert.rejects(
    () => store.load(),
    (error) => {
      assert.equal(error.code, "CLOUD_STATE_NETWORK_ERROR");
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      assert.doesNotMatch(error.message, new RegExp(KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(error.message, /12345678/);
      return true;
    }
  );
  const redacted = redactCloudStateSecrets(
    `token=${TOKEN} key=${KEY} account=${account}`,
    [TOKEN, KEY]
  );
  assert.doesNotMatch(redacted, new RegExp(TOKEN));
  assert.doesNotMatch(redacted, /12345678/);
});

test("잘못된 GitHub 응답·SHA·envelope은 조용히 초기화하지 않는다", async () => {
  const cases = [
    jsonResponse(200, { type: "dir", encoding: "base64", sha: OLD_SHA, content: "e30=" }),
    jsonResponse(200, { ...contentPayload("{}"), size: 999 }),
    jsonResponse(200, { ...contentPayload("{}"), sha: "bad-sha" }),
    jsonResponse(200, contentPayload("not-json"))
  ];
  for (const response of cases) {
    const store = createStore(async () => response.clone());
    await assert.rejects(() => store.load(), (error) => {
      assert.notEqual(error.code, "CLOUD_STATE_NOT_FOUND");
      return true;
    });
  }
});
