import test from "node:test";
import assert from "node:assert/strict";

import { getTradingConfig, LIVE_ACKNOWLEDGEMENT } from "../autotrade/config.mjs";
import {
  assessOrders,
  assessSignal,
  buildCycleKey,
  redactSensitive
} from "../autotrade/risk.mjs";

function config(env = {}) {
  return getTradingConfig({ env, loadEnv: false });
}

test("실행 키는 데이터·모델·전략·기간을 모두 반영한다", () => {
  const base = {
    signalRevision: "raw-a",
    modelVersion: "2.0.0",
    strategyVersion: "longview-balanced-v1",
    period: "2026-07",
    accountId: "paper"
  };
  const first = buildCycleKey(base);
  assert.equal(first, buildCycleKey(base));
  assert.equal(first, buildCycleKey({ ...base, scope: "" }));
  assert.notEqual(first, buildCycleKey({ ...base, modelVersion: "2.1.0" }));
  assert.notEqual(first, buildCycleKey({ ...base, signalRevision: "raw-b" }));
  assert.notEqual(first, buildCycleKey({ ...base, scope: "manual-topup:123" }));
  assert.equal(
    buildCycleKey({ ...base, scope: "manual-topup:123" }),
    buildCycleKey({ ...base, scope: "manual-topup:123" })
  );
  assert.equal(
    buildCycleKey({ ...base, scope: "manual-topup:123" }),
    buildCycleKey({
      ...base,
      signalRevision: "raw-new",
      modelVersion: "9.9.9",
      strategyVersion: "new-strategy",
      period: "2027-01",
      scope: "manual-topup:123"
    }),
    "명시적 일회성 실행은 데이터나 날짜가 바뀐 뒤 재실행해도 같은 키여야 한다"
  );
  assert.notEqual(
    buildCycleKey({ ...base, scope: "manual-topup:123" }),
    buildCycleKey({ ...base, accountId: "another-account", scope: "manual-topup:123" })
  );
});

test("오래되거나 모델이 바뀐 신호는 주문 전에 차단한다", () => {
  const result = assessSignal(
    {
      revision: "r1",
      modelVersion: "3.0.0",
      sourceUpdatedAt: "2026-07-01T00:00:00.000Z",
      health: { dataLoadStatus: "ok" },
      companies: []
    },
    config(),
    { now: new Date("2026-07-19T00:00:00.000Z") }
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes("점수모델")));
  assert.ok(result.reasons.some((reason) => reason.includes("오래")));
});

test("후보 수 급변은 승인된 레거시 3→12 전환만 예외로 허용한다", () => {
  const tradingConfig = config();
  const current = {
    revision: "r1",
    modelVersion: tradingConfig.strategy.approvedModelVersion,
    sourceUpdatedAt: "2026-07-22T00:00:00.000Z",
    health: { dataLoadStatus: "ok" },
    companies: Array.from({ length: 12 }, (_, index) => ({ id: `KR-${index}` }))
  };
  const baseline = assessSignal(current, tradingConfig, {
    now: new Date("2026-07-22T01:00:00.000Z")
  });

  const sameScope = assessSignal(current, tradingConfig, {
    now: new Date("2026-07-22T01:00:00.000Z"),
    previous: { candidateCount: 3, candidateCountScope: baseline.candidateCountScope }
  });
  assert.equal(sameScope.ok, false);
  assert.ok(sameScope.reasons.some((reason) => reason.includes("후보 수")));

  const migratedScope = assessSignal(current, tradingConfig, {
    now: new Date("2026-07-22T01:00:00.000Z"),
    previous: { candidateCount: 3, candidateCountScope: null }
  });
  assert.equal(migratedScope.ok, true);

  const contaminated = assessSignal(
    {
      ...current,
      companies: Array.from({ length: 1_000 }, (_, index) => ({ id: `BAD-${index}` }))
    },
    tradingConfig,
    {
      now: new Date("2026-07-22T01:00:00.000Z"),
      previous: { candidateCount: 3, candidateCountScope: null }
    }
  );
  assert.equal(contaminated.ok, false);
  assert.ok(contaminated.reasons.some((reason) => reason.includes("후보 수")));

  const unapprovedStrategy = assessSignal(
    current,
    {
      ...tradingConfig,
      strategy: { ...tradingConfig.strategy, version: "unapproved-migration" }
    },
    {
      now: new Date("2026-07-22T01:00:00.000Z"),
      previous: { candidateCount: 3, candidateCountScope: null }
    }
  );
  assert.equal(unapprovedStrategy.ok, false);
  assert.ok(unapprovedStrategy.reasons.some((reason) => reason.includes("후보 수")));

  const enrichedManagedCompanies = assessSignal(
    {
      ...current,
      candidateSummaries: Array.from({ length: 8 }, (_, index) => ({ id: `RANK-${index}` })),
      companies: Array.from({ length: 11 }, (_, index) => ({ id: `WITH-MANAGED-${index}` }))
    },
    tradingConfig,
    {
      now: new Date("2026-07-22T01:00:00.000Z"),
      previous: { candidateCount: 12, candidateCountScope: baseline.candidateCountScope }
    }
  );
  assert.equal(enrichedManagedCompanies.candidateCount, 8);
  assert.equal(enrichedManagedCompanies.ok, false);
  assert.ok(enrichedManagedCompanies.reasons.some((reason) => reason.includes("후보 수")));
});

test("시장가·중복·과도한 회전율과 확인 없는 실전 주문을 차단한다", () => {
  const live = config({
    TRADING_MODE: "live",
    TRADING_BROKER: "kis",
    KIS_ENV: "prod",
    KIS_APP_KEY: "app",
    KIS_APP_SECRET: "secret",
    KIS_ACCOUNT_NUMBER: "12345678",
    TRADING_CAPITAL_LIMIT_KRW: "1000000",
    ENABLE_LIVE_TRADING: "true",
    LIVE_TRADING_ACK: LIVE_ACKNOWLEDGEMENT
  });
  const order = {
    id: "KR-1",
    ticker: "000001",
    country: "KR",
    side: "buy",
    quantity: 20,
    limitPrice: 10_000,
    orderType: "market"
  };
  const result = assessOrders([order, order], { totalEquityKrw: 1_000_000 }, live);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes("추가 확인")));
  assert.ok(result.reasons.some((reason) => reason.includes("지정가")));
  assert.ok(result.reasons.some((reason) => reason.includes("중복")));
  assert.ok(result.reasons.some((reason) => reason.includes("회전율")));
});

test("오류 메시지에서 키·토큰·계좌번호를 가린다", () => {
  const secret = "super-secret";
  const output = redactSensitive(
    `appsecret=${secret} authorization=Bearer abcdef 12345678-01`,
    [secret]
  );
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("12345678"), false);
  assert.match(output, /redacted/);
});
