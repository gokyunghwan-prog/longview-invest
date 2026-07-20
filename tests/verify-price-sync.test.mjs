import assert from "node:assert/strict";
import test from "node:test";

import { priceProviderFailures } from "../scripts/verify-price-sync.mjs";

test("게시 전 엄격 검증은 국내 공식 시세 공급자의 누락과 미실행을 거부한다", () => {
  assert.equal(priceProviderFailures({ providers: [] }).length, 0);
  assert.equal(
    priceProviderFailures({ providers: [] }, { requireKoreanProvider: true })[0].code,
    "KR_PUBLIC"
  );
  assert.equal(
    priceProviderFailures(
      { providers: [{ code: "KR_PUBLIC", attempted: false, status: "not_configured" }] },
      { requireKoreanProvider: true }
    )[0].status,
    "not_configured"
  );
});

test("게시 전 엄격 검증은 국내 공식 시세 성공만 통과시키고 실패를 중복하지 않는다", () => {
  assert.deepEqual(
    priceProviderFailures(
      { providers: [{ code: "KR_PUBLIC", attempted: true, status: "ok" }] },
      { requireKoreanProvider: true }
    ),
    []
  );
  const failed = { code: "KR_PUBLIC", attempted: true, status: "failed", error: "timeout" };
  assert.deepEqual(
    priceProviderFailures({ providers: [failed] }, { requireKoreanProvider: true }),
    [failed]
  );
});
