import test from "node:test";
import assert from "node:assert/strict";

import {
  isDailyRebalanceDue,
  isMonthlyRebalanceDue,
  planMonthlyRebalance,
  planRebalance
} from "../autotrade/planner.mjs";

function target(id, overrides = {}) {
  return {
    id,
    ticker: id,
    name: `회사 ${id}`,
    country: "KR",
    exchange: "KOSPI",
    sector: "산업재",
    score: 90,
    targetWeight: 0.5,
    currentPrice: 10_000,
    currentPriceKrw: 10_000,
    currency: "KRW",
    ...overrides
  };
}

function portfolio(selected, overrides = {}) {
  return {
    status: "ready",
    deployable: true,
    selected,
    cashTargetWeight: Math.max(0.1, 1 - selected.reduce((sum, item) => sum + item.targetWeight, 0)),
    evaluations: [],
    ...overrides
  };
}

const permissiveConfig = {
  strategy: {
    reserveWeight: 0.1,
    rebalanceDrift: 0.01,
    removalConfirmations: 2,
    minimumOrderKrw: 10_000
  },
  risk: {
    maximumTurnoverWeight: 1,
    initialDeploymentTurnoverWeight: 1,
    maximumOrdersPerRun: 20
  }
};

test("월 1회만 리밸런싱하며 입력 상태를 변경하지 않는다", () => {
  assert.equal(
    isMonthlyRebalanceDue({
      now: "2026-08-01T00:00:00.000Z",
      lastPlanAt: "2026-07-31T15:00:00.000Z"
    }),
    false,
    "두 시각은 모두 KST 8월이다"
  );
  const state = {
    strategy: { lastPlanAt: "2026-08-03T00:00:00.000Z", removalStreaks: {} }
  };
  const before = structuredClone(state);
  const result = planMonthlyRebalance({
    portfolio: portfolio([target("A")]),
    account: { totalEquityKrw: 1_000_000, cashKrw: 1_000_000, positions: [] },
    state,
    config: permissiveConfig,
    now: "2026-08-20T00:00:00.000Z"
  });
  assert.equal(result.status, "not_due");
  assert.deepEqual(result.orders, []);
  assert.deepEqual(state, before);
});

test("daily 설정은 KST 날짜마다 한 번만 계획한다", () => {
  assert.equal(
    isDailyRebalanceDue({
      now: "2026-08-01T14:59:00.000Z",
      lastPlanAt: "2026-08-01T00:00:00.000Z"
    }),
    false
  );
  assert.equal(
    isDailyRebalanceDue({
      now: "2026-08-01T15:00:00.000Z",
      lastPlanAt: "2026-08-01T14:59:00.000Z"
    }),
    true,
    "UTC 15시는 KST 다음 날이다"
  );

  const dailyConfig = {
    ...permissiveConfig,
    strategy: {
      ...permissiveConfig.strategy,
      rebalanceFrequency: "daily"
    }
  };
  const first = planRebalance({
    portfolio: portfolio([target("A")]),
    account: { totalEquityKrw: 1_000_000, cashKrw: 1_000_000, positions: [] },
    state: { strategy: { lastPlanAt: "2026-08-20T00:00:00.000Z" } },
    config: dailyConfig,
    now: "2026-08-20T10:00:00.000Z"
  });
  assert.equal(first.status, "not_due");
  assert.equal(first.diagnostics.reason, "already_planned_today");

  const nextDay = planRebalance({
    portfolio: portfolio([target("A")]),
    account: { totalEquityKrw: 1_000_000, cashKrw: 1_000_000, positions: [] },
    state: first.nextState,
    config: dailyConfig,
    now: "2026-08-20T15:00:00.000Z"
  });
  assert.equal(nextDay.status, "planned");
  assert.equal(nextDay.diagnostics.rebalanceFrequency, "daily");
});

test("목표비중보다 부족하면 공통 주문 필드로 매수 계획을 만든다", () => {
  const result = planMonthlyRebalance({
    portfolio: portfolio([target("A")]),
    account: { totalEquityKrw: 1_000_000, cashKrw: 1_000_000, positions: [] },
    state: { strategy: { lastPlanAt: null, removalStreaks: {} } },
    config: permissiveConfig,
    now: "2026-08-20T00:00:00.000Z"
  });
  assert.equal(result.status, "planned");
  assert.equal(result.orders.length, 1);
  assert.deepEqual(
    result.orders[0],
    {
      id: "A",
      ticker: "A",
      name: "회사 A",
      country: "KR",
      exchange: "KOSPI",
      sector: "산업재",
      side: "buy",
      quantity: 50,
      limitPrice: 10_000,
      currency: "KRW",
      reason: "rebalance_underweight",
      estimatedNotionalKrw: 500_000
    }
  );
});

test("목표 현금이 0이면 정수 주식과 위험 한도 안에서 현금을 최대한 배치한다", () => {
  const selected = ["A", "B", "C"].map((id) =>
    target(id, {
      targetWeight: 1 / 3,
      currentPrice: 110_000,
      currentPriceKrw: 110_000
    })
  );
  const result = planRebalance({
    portfolio: portfolio(selected, {
      investedTargetWeight: 1,
      cashTargetWeight: 0
    }),
    account: {
      totalEquityKrw: 1_000_000,
      cashKrw: 1_000_000,
      positionsValueKrw: 0,
      positions: []
    },
    state: { strategy: { lastPlanAt: null, removalStreaks: {} } },
    config: {
      strategy: {
        reserveWeight: 0,
        rebalanceDrift: 0,
        removalConfirmations: 2,
        minimumOrderKrw: 1,
        maximumPositionWeight: 0.4,
        maximumSectorWeight: 1
      },
      risk: {
        maximumTurnoverWeight: 1,
        initialDeploymentTurnoverWeight: 1,
        maximumOrdersPerRun: 20
      }
    },
    now: "2026-08-20T00:00:00.000Z"
  });

  assert.equal(result.status, "planned");
  assert.deepEqual(result.orders.map((order) => order.quantity), [3, 3, 3]);
  assert.equal(result.diagnostics.reserveKrw, 0);
  assert.equal(result.diagnostics.estimatedCashAfterKrw, 10_000);
  assert.ok(result.diagnostics.estimatedCashAfterKrw < 110_000);
});

test("잔여 현금 스윕은 1주씩 결정적으로 추가하고 기존 주문에 합친다", () => {
  const selected = ["A", "B"].map((id) =>
    target(id, {
      targetWeight: 0.5,
      currentPrice: 300_000,
      currentPriceKrw: 300_000
    })
  );
  const result = planRebalance({
    portfolio: portfolio(selected, {
      investedTargetWeight: 1,
      cashTargetWeight: 0
    }),
    account: {
      totalEquityKrw: 1_000_000,
      cashKrw: 1_000_000,
      positionsValueKrw: 0,
      positions: []
    },
    state: { strategy: { lastPlanAt: null, removalStreaks: {} } },
    config: {
      strategy: {
        reserveWeight: 0,
        rebalanceDrift: 0,
        removalConfirmations: 2,
        minimumOrderKrw: 1,
        maximumPositionWeight: 0.6,
        maximumSectorWeight: 1
      },
      risk: {
        maximumTurnoverWeight: 1,
        initialDeploymentTurnoverWeight: 1,
        maximumOrdersPerRun: 20
      }
    },
    now: "2026-08-20T00:00:00.000Z"
  });

  assert.deepEqual(
    result.orders.map((order) => [order.id, order.quantity]),
    [["A", 2], ["B", 1]]
  );
  assert.equal(result.orders.length, 2, "스윕 수량은 같은 종목 주문에 합쳐진다");
  assert.equal(result.diagnostics.estimatedCashAfterKrw, 100_000);
  assert.ok(result.diagnostics.estimatedCashAfterKrw < 300_000);
});

test("현금 스윕은 지정가 버퍼와 예상 수수료까지 낼 수 있는 수량만 잡는다", () => {
  const selected = [target("A", { targetWeight: 1 })];
  const result = planRebalance({
    portfolio: portfolio(selected, {
      investedTargetWeight: 1,
      cashTargetWeight: 0
    }),
    account: {
      totalEquityKrw: 1_000_000,
      cashKrw: 1_000_000,
      positionsValueKrw: 0,
      positions: []
    },
    state: { strategy: { lastPlanAt: null, removalStreaks: {} } },
    config: {
      strategy: {
        reserveWeight: 0,
        rebalanceDrift: 0,
        removalConfirmations: 2,
        minimumOrderKrw: 1,
        maximumPositionWeight: 1,
        maximumSectorWeight: 1
      },
      risk: {
        maximumTurnoverWeight: 1,
        initialDeploymentTurnoverWeight: 1,
        maximumOrdersPerRun: 20,
        limitPriceBuffer: 0.005
      },
      paper: { feeRate: 0.0002 }
    },
    now: "2026-08-20T00:00:00.000Z"
  });

  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].quantity, 99);
  assert.equal(result.diagnostics.estimatedCashAfterKrw, 4_851);
  assert.ok(result.diagnostics.estimatedCashAfterKrw < 10_050);
});

test("현금 스윕은 지정가 버퍼를 포함해 종목 최대비중을 넘지 않는다", () => {
  const selected = ["A", "B", "C"].map((id, index) =>
    target(id, {
      sector: `업종-${index}`,
      targetWeight: 1 / 3,
      currentPrice: 11_650,
      currentPriceKrw: 11_650
    })
  );
  const result = planRebalance({
    portfolio: portfolio(selected, {
      investedTargetWeight: 1,
      cashTargetWeight: 0
    }),
    account: {
      totalEquityKrw: 100_000,
      cashKrw: 100_000,
      positionsValueKrw: 0,
      positions: []
    },
    state: { strategy: { lastPlanAt: null, removalStreaks: {} } },
    config: {
      strategy: {
        reserveWeight: 0,
        rebalanceDrift: 0,
        removalConfirmations: 2,
        minimumOrderKrw: 1,
        maximumPositionWeight: 0.35,
        maximumSectorWeight: 0.35
      },
      risk: {
        maximumTurnoverWeight: 1,
        initialDeploymentTurnoverWeight: 1,
        maximumOrdersPerRun: 20,
        limitPriceBuffer: 0.005
      }
    },
    now: "2026-08-20T00:00:00.000Z"
  });

  assert.deepEqual(result.orders.map((order) => order.quantity), [2, 2, 2]);
  assert.ok(
    result.orders.every((order) => order.quantity * 11_710 <= 35_000),
    "버퍼 적용 지정가 기준으로도 종목당 35%를 넘지 않아야 한다"
  );
});

test("목표에서 빠진 보유종목은 두 번 연속 확인된 뒤에만 제거한다", () => {
  const removedEvaluation = {
    id: "OLD",
    eligible: false,
    reasonCodes: ["score_below_minimum"],
    quote: { price: 10_000, priceKrw: 10_000, currency: "KRW" },
    company: target("OLD")
  };
  const selectedPortfolio = portfolio([], {
    cashTargetWeight: 1,
    evaluations: [removedEvaluation]
  });
  const account = {
    totalEquityKrw: 100_000,
    cashKrw: 0,
    positions: [
      {
        ...target("OLD"),
        quantity: 10,
        price: 10_000,
        priceKrw: 10_000,
        marketValueKrw: 100_000
      }
    ]
  };
  const first = planMonthlyRebalance({
    portfolio: selectedPortfolio,
    account,
    state: { strategy: { lastPlanAt: null, removalStreaks: {} } },
    config: permissiveConfig,
    now: "2026-08-20T00:00:00.000Z"
  });
  assert.equal(first.orders.length, 0);
  assert.equal(first.nextState.strategy.removalStreaks["KR:OLD"], 1);

  const second = planMonthlyRebalance({
    portfolio: selectedPortfolio,
    account,
    state: first.nextState,
    config: permissiveConfig,
    now: "2026-09-20T00:00:00.000Z"
  });
  assert.equal(second.orders.length, 1);
  assert.equal(second.orders[0].side, "sell");
  assert.equal(second.orders[0].quantity, 10);
  assert.equal(second.orders[0].reason, "confirmed_removal");
});

test("제거 확인 전에는 교체 후보를 먼저 사지 않는다", () => {
  const old = target("OLD", { score: 80, targetWeight: 0.5 });
  const challenger = target("NEW", { score: 90, targetWeight: 0.5 });
  const selectedPortfolio = portfolio([challenger], {
    evaluations: [
      {
        id: "OLD",
        securityKey: "KR:OLD",
        eligible: false,
        reasonCodes: ["score_below_minimum"],
        quote: { price: 10_000, priceKrw: 10_000, currency: "KRW" },
        company: old
      }
    ]
  });
  const account = {
    totalEquityKrw: 1_000_000,
    cashKrw: 500_000,
    positions: [{ ...old, quantity: 50, marketValueKrw: 500_000 }]
  };
  const result = planRebalance({
    portfolio: selectedPortfolio,
    account,
    state: { strategy: { lastPlanAt: null, removalStreaks: {} } },
    config: permissiveConfig,
    now: "2026-08-20T00:00:00.000Z"
  });

  assert.deepEqual(result.orders, []);
  assert.ok(
    result.diagnostics.skipped.some(
      (item) => item.reason === "replacement_waiting_for_removal_confirmation"
    )
  );
});

test("데이터 누락만으로 목표에서 빠진 종목은 자동 매도하지 않는다", () => {
  const result = planMonthlyRebalance({
    portfolio: portfolio([], {
      cashTargetWeight: 1,
      evaluations: [
        {
          id: "WAIT",
          eligible: false,
          dataFailure: true,
          reasonCodes: ["longview_candidate_ineligible", "current_price_missing"],
          quote: {},
          company: target("WAIT")
        }
      ]
    }),
    account: {
      totalEquityKrw: 100_000,
      cashKrw: 0,
      positions: [{ ...target("WAIT"), quantity: 10, price: 10_000, marketValueKrw: 100_000 }]
    },
    state: { strategy: { lastPlanAt: null, removalStreaks: {} } },
    config: permissiveConfig,
    now: "2026-08-20T00:00:00.000Z"
  });
  assert.equal(result.orders.length, 0);
  assert.equal(result.nextState.strategy.removalStreaks["KR:WAIT"], undefined);
  assert.ok(
    result.diagnostics.skipped.some((item) => item.reason === "data_failure_is_not_sell_signal")
  );
});

test("드리프트와 최소 주문 기준 미만의 작은 차이는 거래하지 않는다", () => {
  const result = planMonthlyRebalance({
    portfolio: portfolio([target("A", { targetWeight: 0.2 })]),
    account: {
      totalEquityKrw: 1_000_000,
      cashKrw: 840_000,
      positions: [
        {
          ...target("A"),
          quantity: 16,
          price: 10_000,
          marketValueKrw: 155_000
        }
      ]
    },
    state: { strategy: { lastPlanAt: null, removalStreaks: {} } },
    config: {
      ...permissiveConfig,
      strategy: { ...permissiveConfig.strategy, minimumOrderKrw: 50_000 }
    },
    now: "2026-08-20T00:00:00.000Z"
  });
  assert.equal(result.orders.length, 0);
  assert.ok(result.diagnostics.skipped.some((item) => item.reason === "minimum_order"));
});

test("한 번의 계획에서 설정된 회전율을 넘지 않는다", () => {
  const selected = ["A", "B", "C"].map((id) => target(id, { targetWeight: 0.3 }));
  const result = planMonthlyRebalance({
    portfolio: portfolio(selected),
    account: { totalEquityKrw: 1_000_000, cashKrw: 1_000_000, positions: [] },
    state: {
      strategy: {
        lastPlanAt: null,
        removalStreaks: {},
        initialDeploymentCompleted: true
      }
    },
    config: {
      ...permissiveConfig,
      risk: { maximumTurnoverWeight: 0.1, maximumOrdersPerRun: 20 }
    },
    now: "2026-08-20T00:00:00.000Z"
  });
  const turnover = result.orders.reduce((sum, order) => sum + order.estimatedNotionalKrw, 0);
  assert.ok(turnover <= 100_000);
  assert.equal(result.diagnostics.turnoverWeight, turnover / 1_000_000);
  assert.equal(result.diagnostics.deploymentPhase, "routine");
});

test("초기 배치는 월 30%씩 진행하고 목표 도달 후 10%로 영구 전환한다", () => {
  const selected = ["A", "B", "C"].map((id) => target(id, { targetWeight: 0.3 }));
  const targetPortfolio = portfolio(selected, { investedTargetWeight: 0.9 });
  const config = {
    ...permissiveConfig,
    risk: {
      maximumTurnoverWeight: 0.1,
      initialDeploymentTurnoverWeight: 0.3,
      maximumOrdersPerRun: 20
    }
  };
  const emptyAccount = {
    totalEquityKrw: 1_000_000,
    cashKrw: 1_000_000,
    positionsValueKrw: 0,
    positions: []
  };
  const first = planMonthlyRebalance({
    portfolio: targetPortfolio,
    account: emptyAccount,
    state: { strategy: { lastPlanAt: null, removalStreaks: {} } },
    config,
    now: "2026-08-20T00:00:00.000Z"
  });
  assert.equal(first.diagnostics.deploymentPhase, "initial");
  assert.equal(first.diagnostics.turnoverCapWeight, 0.3);
  assert.equal(first.diagnostics.turnoverKrw, 300_000);
  assert.equal(first.nextState.strategy.initialDeploymentCompleted, false);

  const fullyInvested = {
    totalEquityKrw: 1_000_000,
    cashKrw: 100_000,
    positionsValueKrw: 900_000,
    positions: selected.map((item) => ({
      ...item,
      quantity: 30,
      price: 10_000,
      priceKrw: 10_000,
      marketValueKrw: 300_000
    }))
  };
  const completed = planMonthlyRebalance({
    portfolio: targetPortfolio,
    account: fullyInvested,
    state: first.nextState,
    config,
    now: "2026-09-20T00:00:00.000Z"
  });
  assert.equal(completed.diagnostics.deploymentPhase, "routine");
  assert.equal(completed.nextState.strategy.initialDeploymentCompleted, true);
  assert.equal(completed.orders.length, 0);

  const afterLiquidation = planMonthlyRebalance({
    portfolio: targetPortfolio,
    account: emptyAccount,
    state: completed.nextState,
    config,
    now: "2026-10-20T00:00:00.000Z"
  });
  assert.equal(afterLiquidation.diagnostics.deploymentPhase, "routine");
  assert.equal(afterLiquidation.diagnostics.turnoverCapWeight, 0.1);
  assert.equal(afterLiquidation.diagnostics.turnoverKrw, 100_000);
  assert.equal(afterLiquidation.nextState.strategy.initialDeploymentCompleted, true);
});

test("Longview 회사 ID와 증권사 position ID가 달라도 국가·ticker로 같은 종목을 맞춘다", () => {
  const samsung = target("KR-CORP-SAMSUNG", {
    ticker: "005930",
    targetWeight: 0.5
  });
  const result = planMonthlyRebalance({
    portfolio: portfolio([samsung]),
    account: {
      totalEquityKrw: 1_000_000,
      cashKrw: 500_000,
      positions: [
        {
          id: "KR:005930",
          ticker: "005930",
          name: "삼성전자",
          country: "KR",
          exchange: "KOSPI",
          sector: "정보기술",
          quantity: 50,
          price: 10_000,
          priceKrw: 10_000,
          marketValueKrw: 500_000
        }
      ]
    },
    state: { strategy: { lastPlanAt: null, removalStreaks: {} } },
    config: permissiveConfig,
    now: "2026-08-20T00:00:00.000Z"
  });

  assert.equal(result.orders.length, 0);
  assert.equal(result.nextState.strategy.removalStreaks["KR:005930"], undefined);
});

test("KIS-style planning does not spend unconfirmed sell proceeds", () => {
  const oldPosition = target("OLD", { targetWeight: 1 });
  const newTarget = target("NEW", { targetWeight: 1 });
  const result = planRebalance({
    portfolio: portfolio([newTarget], {
      investedTargetWeight: 1,
      cashTargetWeight: 0,
      evaluations: [
        {
          id: "OLD",
          securityKey: "KR:OLD",
          eligible: false,
          reasonCodes: ["score_below_minimum"],
          quote: { price: 10_000, priceKrw: 10_000, currency: "KRW" },
          company: oldPosition
        }
      ]
    }),
    account: {
      totalEquityKrw: 500_000,
      cashKrw: 0,
      positions: [
        { ...oldPosition, quantity: 50, price: 10_000, marketValueKrw: 500_000 }
      ]
    },
    state: {
      strategy: {
        lastPlanAt: null,
        removalStreaks: { "KR:OLD": 1 }
      }
    },
    config: {
      strategy: {
        reserveWeight: 0,
        rebalanceDrift: 0,
        removalConfirmations: 2,
        minimumOrderKrw: 1,
        maximumPositionWeight: 1,
        maximumSectorWeight: 1
      },
      risk: {
        maximumTurnoverWeight: 2,
        initialDeploymentTurnoverWeight: 2,
        maximumOrdersPerRun: 20,
        reuseProjectedSellProceeds: false
      }
    },
    now: "2026-08-20T00:00:00.000Z"
  });

  assert.deepEqual(result.orders.map((order) => order.side), ["sell"]);
  assert.equal(result.diagnostics.reuseProjectedSellProceeds, false);
});
