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

test("현금 자동배치는 매수 현금 한도와 별도로 매도 회전율을 검사한다", () => {
  const tradingConfig = {
    mode: "paper",
    strategy: {
      reserveWeight: 0
    },
    risk: {
      maximumOrdersPerRun: 20,
      maximumTurnoverWeight: 0.2,
      deployAvailableCash: true
    }
  };
  const buy = {
    id: "KR-BUY",
    ticker: "000001",
    country: "KR",
    side: "buy",
    quantity: 60,
    limitPrice: 10_000
  };
  const sell = {
    id: "KR-SELL",
    ticker: "000002",
    country: "KR",
    side: "sell",
    quantity: 20,
    limitPrice: 10_000
  };
  const account = {
    totalEquityKrw: 1_000_000,
    cashKrw: 600_000
  };

  const allowed = assessOrders([sell, buy], account, tradingConfig);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.grossBuyNotionalKrw, 600_000);
  assert.equal(allowed.grossSellNotionalKrw, 200_000);

  const excessiveBuy = assessOrders(
    [{ ...buy, quantity: 61 }],
    account,
    tradingConfig
  );
  assert.equal(excessiveBuy.ok, false);
  assert.ok(excessiveBuy.reasons.some((reason) => reason.includes("매수 회전율")));

  const excessiveSell = assessOrders(
    [{ ...sell, quantity: 21 }],
    account,
    tradingConfig
  );
  assert.equal(excessiveSell.ok, false);
  assert.ok(excessiveSell.reasons.some((reason) => reason.includes("매도 회전율")));
});

test("매도 주문은 최대 보유 종목 수 슬롯을 미리 비우지 않는다", () => {
  const tradingConfig = {
    mode: "paper",
    strategy: {
      maximumPositions: 1,
      reserveWeight: 0,
      maximumPositionWeight: 1,
      maximumSectorWeight: 1
    },
    risk: {
      maximumOrdersPerRun: 20,
      maximumTurnoverWeight: 1,
      maximumGrossTurnoverWeight: 2,
      reuseProjectedSellProceeds: false
    },
    paper: { feeRate: 0 }
  };
  const account = {
    totalEquityKrw: 200_000,
    cashKrw: 100_000,
    positions: [
      {
        id: "OLD",
        ticker: "000001",
        country: "KR",
        sector: "기존업종",
        quantity: 10,
        marketValueKrw: 100_000
      }
    ]
  };
  const orders = [
    {
      id: "OLD",
      ticker: "000001",
      country: "KR",
      sector: "기존업종",
      side: "sell",
      quantity: 10,
      limitPrice: 10_000
    },
    {
      id: "NEW",
      ticker: "000002",
      country: "KR",
      sector: "신규업종",
      side: "buy",
      quantity: 10,
      limitPrice: 10_000
    }
  ];

  const result = assessOrders(orders, account, tradingConfig);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes("최대 보유 종목 수")));
});

test("최종 리스크도 동기 전량매도만 슬롯을 열고 부분매도·KIS는 열지 않는다", () => {
  const tradingConfig = {
    mode: "paper",
    broker: "paper",
    strategy: {
      minimumOrderKrw: 1,
      maximumPositions: 1,
      reserveWeight: 0,
      maximumPositionWeight: 1,
      maximumSectorWeight: 1
    },
    risk: {
      maximumOrdersPerRun: 20,
      maximumTurnoverWeight: 1,
      reuseProjectedSellProceeds: true
    },
    paper: { feeRate: 0 }
  };
  const account = {
    totalEquityKrw: 200_000,
    cashKrw: 100_000,
    positions: [
      {
        id: "OLD",
        ticker: "000001",
        country: "KR",
        sector: "기존업종",
        quantity: 10,
        marketValueKrw: 100_000
      }
    ]
  };
  const sell = {
    id: "OLD",
    ticker: "000001",
    country: "KR",
    sector: "기존업종",
    side: "sell",
    quantity: 10,
    limitPrice: 10_000,
    reason: "confirmed_removal"
  };
  const buy = {
    id: "NEW",
    ticker: "000002",
    country: "KR",
    sector: "신규업종",
    side: "buy",
    quantity: 10,
    limitPrice: 10_000
  };

  const completeRemoval = assessOrders([sell, buy], account, tradingConfig);
  assert.equal(completeRemoval.ok, true);

  const partialRemoval = assessOrders(
    [{ ...sell, quantity: 5 }, buy],
    account,
    tradingConfig
  );
  assert.equal(partialRemoval.ok, false);
  assert.ok(
    partialRemoval.reasons.some((reason) => reason.includes("최대 보유 종목 수"))
  );

  const kis = assessOrders(
    [sell, buy],
    account,
    { ...tradingConfig, mode: "live", broker: "kis" },
    { liveConfirmation: true }
  );
  assert.equal(kis.ok, false);
  assert.ok(kis.reasons.some((reason) => reason.includes("최대 보유 종목 수")));
});

test("최종 리스크는 예정 매도를 무시한 worst-case 종목·섹터 매수 노출을 검사한다", () => {
  const tradingConfig = {
    mode: "paper",
    strategy: {
      maximumPositions: 5,
      reserveWeight: 0,
      maximumPositionWeight: 0.35,
      maximumSectorWeight: 0.35
    },
    risk: {
      maximumOrdersPerRun: 20,
      maximumTurnoverWeight: 1,
      maximumGrossTurnoverWeight: 2,
      reuseProjectedSellProceeds: false
    },
    paper: { feeRate: 0 }
  };
  const account = {
    totalEquityKrw: 1_000_000,
    cashKrw: 650_000,
    positions: [
      {
        id: "OLD",
        ticker: "000001",
        country: "KR",
        sector: "동일업종",
        quantity: 35,
        marketValueKrw: 350_000
      }
    ]
  };
  const orders = [
    {
      id: "OLD",
      ticker: "000001",
      country: "KR",
      sector: "동일업종",
      side: "sell",
      quantity: 35,
      limitPrice: 10_000
    },
    {
      id: "NEW",
      ticker: "000002",
      country: "KR",
      sector: "동일업종",
      side: "buy",
      quantity: 1,
      limitPrice: 10_000
    }
  ];

  const result = assessOrders(orders, account, tradingConfig);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes("섹터 최대비중")));

  const positionLimit = assessOrders(
    [
      {
        id: "OLD",
        ticker: "000001",
        country: "KR",
        sector: "동일업종",
        side: "buy",
        quantity: 1,
        limitPrice: 10_000
      }
    ],
    {
      ...account,
      cashKrw: 10_000,
      positions: [
        {
          ...account.positions[0],
          marketValueKrw: 350_000
        }
      ]
    },
    tradingConfig
  );
  assert.equal(positionLimit.ok, false);
  assert.ok(positionLimit.reasons.some((reason) => reason.includes("종목 최대비중")));
});

test("현금 자동배치가 꺼져 있으면 매수·매도 합계가 공유 gross 회전 한도를 지킨다", () => {
  const base = {
    mode: "paper",
    strategy: {
      maximumPositions: 5,
      reserveWeight: 0,
      maximumPositionWeight: 1,
      maximumSectorWeight: 1
    },
    risk: {
      maximumOrdersPerRun: 20,
      maximumTurnoverWeight: 0.2,
      deployAvailableCash: false
    },
    paper: { feeRate: 0 }
  };
  const account = {
    totalEquityKrw: 1_000_000,
    cashKrw: 200_000,
    positions: [
      {
        id: "SELL",
        ticker: "000001",
        country: "KR",
        sector: "업종-A",
        quantity: 20,
        marketValueKrw: 200_000
      }
    ]
  };
  const orders = [
    {
      id: "SELL",
      ticker: "000001",
      country: "KR",
      sector: "업종-A",
      side: "sell",
      quantity: 20,
      limitPrice: 10_000
    },
    {
      id: "BUY",
      ticker: "000002",
      country: "KR",
      sector: "업종-B",
      side: "buy",
      quantity: 20,
      limitPrice: 10_000
    }
  ];

  const shared = assessOrders(orders, account, base);
  assert.equal(shared.ok, false);
  assert.ok(shared.reasons.some((reason) => reason === "1회 허용 회전율을 초과했습니다."));

  const explicit = assessOrders(
    orders,
    account,
    {
      ...base,
      risk: {
        ...base.risk,
        maximumTurnoverWeight: 0.5,
        maximumBuyTurnoverWeight: 0.5,
        maximumSellTurnoverWeight: 0.5,
        maximumGrossTurnoverWeight: 0.3
      }
    }
  );
  assert.equal(explicit.ok, false);
  assert.ok(explicit.reasons.some((reason) => reason === "1회 허용 회전율을 초과했습니다."));
});

test("KIS 최종 리스크는 수수료를 포함한 시작 현금만 매수 재원으로 인정한다", () => {
  const tradingConfig = {
    mode: "live",
    broker: "kis",
    strategy: {
      maximumPositions: 5,
      reserveWeight: 0,
      maximumPositionWeight: 1,
      maximumSectorWeight: 1
    },
    risk: {
      maximumOrdersPerRun: 20,
      maximumTurnoverWeight: 1,
      maximumGrossTurnoverWeight: 2,
      reuseProjectedSellProceeds: false
    },
    paper: { feeRate: 0.001 }
  };
  const buy = {
    id: "BUY",
    ticker: "000002",
    country: "KR",
    sector: "업종-B",
    side: "buy",
    quantity: 20,
    limitPrice: 10_000
  };
  const sell = {
    id: "SELL",
    ticker: "000001",
    country: "KR",
    sector: "업종-A",
    side: "sell",
    quantity: 20,
    limitPrice: 10_000
  };

  const feeShortfall = assessOrders(
    [buy],
    {
      totalEquityKrw: 1_000_000,
      cashKrw: 200_000,
      positions: []
    },
    tradingConfig,
    { liveConfirmation: true }
  );
  assert.equal(feeShortfall.ok, false);
  assert.ok(feeShortfall.reasons.some((reason) => reason.includes("시작 가용현금")));

  const projectedSellOnly = assessOrders(
    [sell, { ...buy, quantity: 10 }],
    {
      totalEquityKrw: 1_000_000,
      cashKrw: 0,
      positions: [
        {
          id: "SELL",
          ticker: "000001",
          country: "KR",
          sector: "업종-A",
          quantity: 20,
          marketValueKrw: 200_000
        }
      ]
    },
    tradingConfig,
    { liveConfirmation: true }
  );
  assert.equal(projectedSellOnly.ok, false);
  assert.ok(projectedSellOnly.reasons.some((reason) => reason.includes("시작 가용현금")));

  const affordable = assessOrders(
    [{ ...buy, quantity: 19 }],
    {
      totalEquityKrw: 1_000_000,
      cashKrw: 200_000,
      positions: []
    },
    tradingConfig,
    { liveConfirmation: true }
  );
  assert.equal(affordable.ok, true);
});

test("KIS 최종 리스크는 수수료 포함 정확한 현금은 허용하고 1원 부족은 차단한다", () => {
  const tradingConfig = {
    mode: "live",
    broker: "kis",
    strategy: {
      maximumPositions: 5,
      reserveWeight: 0,
      maximumPositionWeight: 1,
      maximumSectorWeight: 1
    },
    risk: {
      maximumOrdersPerRun: 20,
      maximumTurnoverWeight: 1,
      maximumGrossTurnoverWeight: 1,
      reuseProjectedSellProceeds: false
    },
    paper: { feeRate: 0.0002 }
  };
  const order = {
    id: "BUY",
    ticker: "000002",
    country: "KR",
    sector: "업종-B",
    side: "buy",
    quantity: 1,
    limitPrice: 10_000
  };

  const exact = assessOrders(
    [order],
    {
      totalEquityKrw: 100_000,
      cashKrw: 10_002,
      positions: []
    },
    tradingConfig,
    { liveConfirmation: true }
  );
  assert.equal(exact.estimatedBuyCashKrw, 10_002);
  assert.equal(exact.ok, true);

  const oneWonShort = assessOrders(
    [order],
    {
      totalEquityKrw: 100_000,
      cashKrw: 10_001,
      positions: []
    },
    tradingConfig,
    { liveConfirmation: true }
  );
  assert.equal(oneWonShort.estimatedBuyCashKrw, 10_002);
  assert.equal(oneWonShort.ok, false);
  assert.ok(
    oneWonShort.reasons.some((reason) => reason.includes("시작 가용현금"))
  );
});

test("최종 리스크는 소액 매수를 거부하되 소액 전량매도는 허용한다", () => {
  const tradingConfig = {
    mode: "paper",
    broker: "paper",
    strategy: {
      minimumOrderKrw: 5_000,
      maximumPositions: 5,
      reserveWeight: 0,
      maximumPositionWeight: 1,
      maximumSectorWeight: 1
    },
    risk: {
      maximumOrdersPerRun: 20,
      maximumTurnoverWeight: 1,
      reuseProjectedSellProceeds: true
    },
    paper: { feeRate: 0 }
  };
  const smallOrder = {
    id: "SMALL",
    ticker: "000001",
    country: "KR",
    sector: "업종-A",
    quantity: 1,
    limitPrice: 1_000
  };

  const buy = assessOrders(
    [{ ...smallOrder, side: "buy" }],
    {
      totalEquityKrw: 100_000,
      cashKrw: 100_000,
      positions: []
    },
    tradingConfig
  );
  assert.equal(buy.ok, false);
  assert.ok(buy.reasons.some((reason) => reason.includes("최소 주문금액")));

  const completeRemoval = assessOrders(
    [{ ...smallOrder, side: "sell", reason: "confirmed_removal" }],
    {
      totalEquityKrw: 100_000,
      cashKrw: 99_000,
      positions: [
        {
          ...smallOrder,
          marketValueKrw: 1_000
        }
      ]
    },
    tradingConfig
  );
  assert.equal(completeRemoval.ok, true);
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
