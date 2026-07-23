import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LIVE_ACKNOWLEDGEMENT,
  USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACKNOWLEDGEMENT,
  getTradingConfig
} from "../autotrade/config.mjs";
import { createTradingEngine } from "../autotrade/engine.mjs";
import { PaperBroker } from "../autotrade/brokers/paper.mjs";
import { createTradingStateStore } from "../autotrade/state-store.mjs";

const NOW = new Date("2026-07-20T01:00:00.000Z");

function company(index) {
  const ticker = String(index).padStart(6, "0");
  return {
    id: `KR-${ticker}`,
    ticker,
    name: `기업 ${ticker}`,
    country: "KR",
    exchange: "KOSPI",
    sector: `업종 ${index % 6}`,
    dataMode: "live",
    stale: false,
    syncStatus: "ok",
    marketData: {
      status: "ok",
      freshness: "current",
      asOf: "2026-07-20",
      price: 10_000 + index * 10,
      currency: "KRW",
      marketCap: 500_000_000_000,
      turnover: 5_000_000_000
    },
    score: {
      modelVersion: "2.0.0",
      total: 90 - index / 100,
      dataConfidence: 95,
      completeness: 95,
      valuationConfidence: 100,
      evaluationReady: true,
      candidate: { eligible: true },
      components: {
        valuation: { score: 80 },
        longGrowth: { score: 85 },
        quality: { score: 80 },
        safety: { score: 80 }
      }
    }
  };
}

function signal(companies = Array.from({ length: 20 }, (_, index) => company(index + 1))) {
  return {
    revision: "signal-r1",
    signalRevision: "signal-r1",
    rawRevision: "raw-r1",
    modelVersion: "2.0.0",
    sourceUpdatedAt: "2026-07-20T00:00:00.000Z",
    fetchedAt: NOW.toISOString(),
    health: { dataLoadStatus: "ok", updatedAt: "2026-07-20T00:00:00.000Z" },
    methodology: { modelVersion: "2.0.0" },
    candidateSummaries: companies.map(({ id }) => ({ id })),
    candidates: companies,
    companies,
    quotes: Object.fromEntries(companies.map((item) => [item.id, item.marketData]))
  };
}

async function setup(t, env = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "longview-engine-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const config = getTradingConfig({
    env: {
      TRADING_MODE: "paper",
      TRADING_REQUIRE_PUBLISHED_SELECTION: "false",
      ...env
    },
    rootDir,
    loadEnv: false
  });
  const stateStore = await createTradingStateStore(config.stateDir, {
    startingCashKrw: 10_000_000,
    now: () => NOW
  });
  const broker = new PaperBroker(stateStore, { feeRate: 0 });
  const client = { getSignal: async () => structuredClone(signal()) };
  const engine = await createTradingEngine(config, {
    stateStore,
    broker,
    client,
    now: () => NOW
  });
  return { config, stateStore, broker, client, engine };
}

test("별도 엔진은 신호·분산전략·월간 계획·위험한도를 연결한다", async (t) => {
  const { config, engine } = await setup(t);
  const plan = await engine.plan();
  assert.equal(plan.ok, true);
  assert.equal(plan.signal.modelVersion, "2.0.0");
  assert.ok(plan.portfolio.selected.length >= 3);
  assert.ok(plan.orders.length > 0);
  const turnoverCap =
    plan.planner.diagnostics.deploymentPhase === "initial"
      ? plan.account.totalEquityKrw * config.risk.initialDeploymentTurnoverWeight
      : plan.account.totalEquityKrw * config.risk.maximumTurnoverWeight;
  assert.ok(plan.risk.orders.grossNotionalKrw <= turnoverCap + 1);
  assert.ok(plan.orders.every((order) => order.orderType === "limit"));
});

test("계획기 회전한도 경계의 매수는 지정가 버퍼를 복원해도 side-risk에 오인 차단되지 않는다", async (t) => {
  const { engine, stateStore, config } = await setup(t, {
    TRADING_MAX_TURNOVER_PERCENT: "20",
    TRADING_LIMIT_BUFFER_PERCENT: "5",
    TRADING_AUTODEPLOY_CASH: "false"
  });
  await stateStore.update((state) => {
    state.strategy.initialDeploymentCompleted = true;
  });

  const plan = await engine.plan();

  const rawBuyCap =
    plan.account.totalEquityKrw *
    plan.planner.diagnostics.buyTurnoverCapWeight;
  const bufferedBuyCap =
    rawBuyCap * (1 + config.risk.limitPriceBuffer);
  const configuredSharedGrossCap =
    plan.account.totalEquityKrw * config.risk.maximumTurnoverWeight;
  assert.equal(plan.planner.diagnostics.deploymentPhase, "routine");
  assert.equal(plan.risk.orders.ok, true);
  assert.ok(plan.risk.orders.grossBuyNotionalKrw > rawBuyCap + 1);
  assert.ok(plan.risk.orders.grossBuyNotionalKrw <= bufferedBuyCap + 1);
  assert.ok(
    plan.risk.orders.grossNotionalKrw <= configuredSharedGrossCap + 1
  );
  assert.ok(Math.abs(bufferedBuyCap - configuredSharedGrossCap) <= 1);
  assert.equal(
    plan.blockedReasons.some((reason) => reason.includes("매수 회전율")),
    false
  );
});

test("모의 실행은 체결·관리종목·실행키를 기록하고 같은 주기 중복을 막는다", async (t) => {
  const { engine, stateStore } = await setup(t);
  const first = await engine.execute();
  assert.equal(first.executed, true);
  assert.ok(first.results.every((result) => result.status === "filled"));
  const state = stateStore.snapshot();
  assert.ok(state.strategy.completedCycleKeys.includes(first.cycleKey));
  assert.equal(state.strategy.lastSnapshotRevision, first.signal.revision);
  assert.equal(state.strategy.candidateCountScope, first.signal.candidateCountScope);
  const filledBuyKeys = new Set(
    first.results
      .filter((result) => result.status === "filled" && result.side === "buy")
      .map((result) => `${result.country}:${result.ticker}`)
  );
  assert.ok(filledBuyKeys.size > 0);
  assert.equal(Object.keys(state.strategy.managedSecurities).length, filledBuyKeys.size);
  assert.ok(
    Object.values(state.strategy.managedSecurities).every(
      (managed) => typeof managed.sector === "string" && managed.sector.length > 0
    )
  );
  assert.ok(Object.keys(state.paper.positions).length > 0);

  const second = await engine.execute();
  assert.equal(second.executed, false);
  assert.ok(
    second.blockedReasons.some((reason) => reason.includes("이미 처리")) ||
      second.reason === "no_orders"
  );
});

test("일회성 추가입금 사이클은 매수만 실행하고 같은 식별자 재실행을 차단한다", async (t) => {
  const { engine, client } = await setup(t);
  const regular = await engine.execute();
  assert.equal(regular.executed, true);

  const options = {
    force: true,
    cashDeploymentOnly: true,
    cycleScope: "manual-topup:test-001"
  };
  const topup = await engine.execute(options);
  assert.equal(topup.executed, true);
  assert.ok(topup.orders.length > 0);
  assert.ok(topup.orders.every((order) => order.side === "buy"));

  const refreshedSignal = signal();
  refreshedSignal.revision = "revision-after-manual-topup";
  client.getSignal = async () => structuredClone(refreshedSignal);
  const duplicate = await engine.execute(options);
  assert.equal(duplicate.executed, false);
  assert.equal(duplicate.alreadyCompleted, true);
  assert.equal(duplicate.reason, "already_completed");
  assert.deepEqual(duplicate.blockedReasons, []);
});

test("현금 자동배치가 활성이어도 동일 revision이면 당일 fresh 검증이 없어 차단한다", async (t) => {
  const { config, stateStore, broker, client, engine } = await setup(t, {
    TRADING_REBALANCE_FREQUENCY: "daily",
    TRADING_AUTODEPLOY_CASH: "true"
  });
  const first = await engine.execute();
  assert.equal(first.executed, true);
  await stateStore.update((state) => {
    state.paper.cashKrw += 5_000_000;
    state.strategy.initialDeploymentCompleted = true;
  });
  const nextEngine = await createTradingEngine(config, {
    stateStore,
    broker,
    client,
    now: () => new Date("2026-07-21T01:00:00.000Z")
  });

  const plan = await nextEngine.plan({
    liveConfirmation: true,
    scheduledRetry: true,
    cycleScope: "scheduled-trade:2026-07-21"
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.planner.diagnostics.cashDeploymentActive, true);
  assert.ok(plan.blockedReasons.some((reason) => reason.includes("새로 게시")));
});

test("동일 revision이어도 현금 자동배치가 비활성이면 기존 stale 차단을 유지한다", async (t) => {
  const { config, stateStore, broker, client, engine } = await setup(t, {
    TRADING_REBALANCE_FREQUENCY: "daily",
    TRADING_AUTODEPLOY_CASH: "false"
  });
  const first = await engine.execute();
  assert.equal(first.executed, true);
  await stateStore.update((state) => {
    state.paper.cashKrw += 5_000_000;
  });
  const nextEngine = await createTradingEngine(config, {
    stateStore,
    broker,
    client,
    now: () => new Date("2026-07-21T01:00:00.000Z")
  });

  const plan = await nextEngine.plan({
    liveConfirmation: true,
    scheduledRetry: true,
    cycleScope: "scheduled-trade:2026-07-21"
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.planner.diagnostics.cashDeploymentActive, false);
  assert.ok(plan.blockedReasons.some((reason) => reason.includes("새로 게시")));
});

test("게시 후보 급감은 관리종목 보강이나 반복 실행으로 기준선을 오염시키지 않는다", async (t) => {
  const { config, engine, stateStore, client } = await setup(t);
  const published = Array.from({ length: 8 }, (_, index) => company(index + 1));
  const managed = Array.from({ length: 3 }, (_, index) => company(index + 101));
  const reducedSignal = signal(published);
  client.getSignal = async () => structuredClone(reducedSignal);
  client.getCompany = async (id) => {
    const found = managed.find((item) => item.id === id);
    if (!found) throw new Error("managed fixture missing");
    return structuredClone(found);
  };
  const baselineScope = ["2.0.0", config.strategy.version].join("\u0000");
  await stateStore.update((state) => {
    state.strategy.candidateCount = 12;
    state.strategy.candidateCountScope = baselineScope;
    state.strategy.managedSecurities = Object.fromEntries(
      managed.map((item) => [
        `${item.country}:${item.ticker}`,
        {
          id: item.id,
          ticker: item.ticker,
          name: item.name,
          country: item.country,
          exchange: item.exchange,
          sector: item.sector
        }
      ])
    );
  });

  for (const scope of ["manual-topup:decline-001", "manual-topup:decline-002"]) {
    const result = await engine.execute({
      force: true,
      cashDeploymentOnly: true,
      cycleScope: scope
    });
    assert.equal(result.executed, false);
    assert.equal(result.signal.candidateCount, 8);
    assert.equal(result.signal.candidateCountScope, baselineScope);
    assert.ok(result.blockedReasons.some((reason) => reason.includes("후보 수")));
  }

  const state = stateStore.snapshot();
  assert.equal(state.strategy.candidateCount, 12);
  assert.equal(state.strategy.candidateCountScope, baselineScope);
  assert.equal(state.paper.orders.length, 0);
});

test("KIS형 현재가 배열을 회사 ID로 매핑하고 큰 가격 괴리는 후보에서 제외한다", async (t) => {
  const { config, stateStore, client } = await setup(t);
  const baseSignal = signal();
  client.getSignal = async () => structuredClone(baseSignal);
  const fakeKis = {
    name: "kis",
    getQuotes: async (companies) =>
      companies.map((item, index) => ({
        id: item.id,
        ticker: item.ticker,
        country: "KR",
        exchange: "KRX",
        currency: "KRW",
        price: index === 0 ? item.marketData.price * 2 : item.marketData.price,
        current: true,
        asOf: NOW.toISOString()
      })),
    getAccount: async () => ({
      broker: "kis",
      cashKrw: 10_000_000,
      positionsValueKrw: 0,
      totalEquityKrw: 10_000_000,
      positions: []
    }),
    placeOrders: async () => []
  };
  const engine = await createTradingEngine(config, {
    stateStore,
    client,
    broker: fakeKis,
    now: () => NOW
  });
  const plan = await engine.plan();
  assert.ok(plan.risk.quoteIssues.some((issue) => issue.id === baseSignal.companies[0].id));
  assert.equal(
    plan.portfolio.selected.some((item) => item.id === baseSignal.companies[0].id),
    false
  );
});

test("자동매매가 관리하지 않는 기존 보유종목이 있으면 전 주문을 차단한다", async (t) => {
  const { config, stateStore, client } = await setup(t);
  const broker = {
    name: "paper",
    getAccount: async () => ({
      broker: "paper",
      cashKrw: 9_000_000,
      positionsValueKrw: 1_000_000,
      totalEquityKrw: 10_000_000,
      positions: [
        {
          id: "KR:999999",
          ticker: "999999",
          country: "KR",
          quantity: 10,
          price: 100_000,
          marketValueKrw: 1_000_000
        }
      ]
    }),
    placeOrders: async () => {
      throw new Error("호출되면 안 됨");
    }
  };
  const engine = await createTradingEngine(config, {
    stateStore,
    client,
    broker,
    now: () => NOW
  });
  const result = await engine.execute();
  assert.equal(result.executed, false);
  assert.ok(result.blockedReasons.some((reason) => reason.includes("관리 밖")));
});

test("장기 실행 대시보드는 다른 프로세스가 기록한 최신 상태를 다시 읽는다", async (t) => {
  const { config, engine } = await setup(t);
  const externalStore = await createTradingStateStore(config.stateDir, {
    startingCashKrw: 10_000_000,
    now: () => NOW
  });
  await externalStore.update((state) => {
    state.strategy.candidateCount = 321;
  });
  const status = await engine.status();
  assert.equal(status.state.strategy.candidateCount, 321);
});

test("상태 폴더 실행 잠금은 서로 다른 엔진의 동시 주문을 차단한다", async (t) => {
  const { config, stateStore, client, engine } = await setup(t);
  const secondStore = await createTradingStateStore(config.stateDir, {
    startingCashKrw: 10_000_000,
    now: () => NOW
  });
  let releaseFirst;
  let firstEntered;
  const entered = new Promise((resolve) => {
    firstEntered = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let submissions = 0;
  const sharedBroker = {
    name: "paper",
    getAccount: async () => ({
      broker: "paper",
      cashKrw: 10_000_000,
      positionsValueKrw: 0,
      totalEquityKrw: 10_000_000,
      positions: []
    }),
    placeOrders: async (orders) => {
      submissions += 1;
      firstEntered();
      await gate;
      return orders.map((order) => ({ ...order, status: "filled" }));
    }
  };
  engine.broker = sharedBroker;
  const secondEngine = await createTradingEngine(config, {
    stateStore: secondStore,
    client,
    broker: sharedBroker,
    now: () => NOW
  });

  const first = engine.execute();
  await entered;
  await assert.rejects(() => secondEngine.execute(), /이미 진행 중/);
  releaseFirst();
  await first;
  assert.equal(submissions, 1);
  assert.equal(stateStore.snapshot().strategy.inFlight, null);
});

test("예약 계획이 주문 전에 차단되면 revision을 소비하지 않고 같은 scope를 다시 계획한다", async (t) => {
  const { engine, stateStore, client } = await setup(t, {
    TRADING_REBALANCE_FREQUENCY: "daily"
  });
  const originalGetSignal = client.getSignal;
  const originalGetAccount = engine.broker.getAccount.bind(engine.broker);
  let signalCalls = 0;
  let accountCalls = 0;
  client.getSignal = async () => {
    signalCalls += 1;
    return originalGetSignal();
  };
  engine.broker.getAccount = async (...args) => {
    accountCalls += 1;
    return originalGetAccount(...args);
  };
  const options = {
    scheduledRetry: true,
    cycleScope: "scheduled-trade:2026-07-20"
  };
  await writeFile(engine.killSwitchFile, "stop\n", "utf8");

  const first = await engine.execute(options);
  const afterFirst = stateStore.snapshot();

  assert.equal(first.ok, false);
  assert.equal(first.executed, false);
  assert.equal(first.reason, "blocked");
  assert.equal(afterFirst.strategy.lastSnapshotRevision, null);
  assert.equal(afterFirst.strategy.lastPlanAt, null);
  assert.equal(afterFirst.strategy.completedCycleKeys.includes(first.cycleKey), false);

  await rm(engine.killSwitchFile, { force: true });
  const second = await engine.execute(options);

  assert.equal(second.cycleKey, first.cycleKey);
  assert.equal(second.executed, true);
  assert.equal(signalCalls, 2);
  assert.equal(accountCalls, 2);
  assert.equal(
    stateStore.snapshot().strategy.lastSnapshotRevision,
    second.signal.revision
  );
  assert.ok(stateStore.snapshot().strategy.completedCycleKeys.includes(second.cycleKey));
});

test("전 주문이 외부 전송 전에 차단되면 완료 상태를 적용하지 않고 같은 scope를 재계획한다", async (t) => {
  const { engine, stateStore, client } = await setup(t, {
    TRADING_REBALANCE_FREQUENCY: "daily"
  });
  const originalGetSignal = client.getSignal;
  let signalCalls = 0;
  let accountCalls = 0;
  let orderAttempts = 0;
  client.getSignal = async () => {
    signalCalls += 1;
    return originalGetSignal();
  };
  engine.broker = {
    name: "paper",
    getAccount: async () => {
      accountCalls += 1;
      return {
        broker: "paper",
        cashKrw: 10_000_000,
        positionsValueKrw: 0,
        totalEquityKrw: 10_000_000,
        positions: []
      };
    },
    placeOrders: async (orders) => {
      orderAttempts += 1;
      return orders.map((order) => ({
        ...order,
        ...(orderAttempts === 1
          ? { status: "blocked", notSent: true, errorCode: "TEST_NOT_SENT" }
          : { status: "filled" })
      }));
    }
  };
  const options = {
    scheduledRetry: true,
    cycleScope: "scheduled-trade:2026-07-20"
  };

  const first = await engine.execute(options);
  const afterFirst = stateStore.snapshot();

  assert.equal(first.executed, false);
  assert.equal(first.reason, "orders_not_sent");
  assert.ok(first.results.every((item) => item.status === "blocked" && item.notSent));
  assert.equal(afterFirst.strategy.inFlight, null);
  assert.equal(afterFirst.strategy.lastSnapshotRevision, null);
  assert.equal(afterFirst.strategy.lastPlanAt, null);
  assert.deepEqual(afterFirst.strategy.removalStreaks, {});
  assert.equal(afterFirst.strategy.completedCycleKeys.includes(first.cycleKey), false);

  const second = await engine.execute(options);

  assert.equal(second.cycleKey, first.cycleKey);
  assert.equal(second.executed, true);
  assert.ok(second.results.every((item) => item.status === "filled"));
  assert.equal(signalCalls, 2);
  assert.equal(accountCalls, 2);
  assert.equal(orderAttempts, 2);
  assert.ok(stateStore.snapshot().strategy.completedCycleKeys.includes(first.cycleKey));
});

test("주문 호출 뒤 오류가 나면 미결 상태를 남겨 재시도를 차단한다", async (t) => {
  const { config, stateStore, client, engine } = await setup(t);
  engine.broker = {
    name: "paper",
    getAccount: async () => ({
      broker: "paper",
      cashKrw: 10_000_000,
      positionsValueKrw: 0,
      totalEquityKrw: 10_000_000,
      positions: []
    }),
    placeOrders: async () => {
      throw new Error("simulated broker interruption");
    }
  };

  await assert.rejects(() => engine.execute(), /simulated broker interruption/);
  const inFlight = stateStore.snapshot().strategy.inFlight;
  assert.ok(inFlight?.cycleKey);

  const reloadedStore = await createTradingStateStore(config.stateDir, {
    startingCashKrw: 10_000_000,
    now: () => NOW
  });
  let retried = 0;
  const secondEngine = await createTradingEngine(config, {
    stateStore: reloadedStore,
    client,
    broker: {
      name: "paper",
      getAccount: engine.broker.getAccount,
      placeOrders: async () => {
        retried += 1;
        return [];
      }
    },
    now: () => NOW
  });
  const blocked = await secondEngine.execute();
  assert.equal(blocked.executed, false);
  assert.ok(blocked.blockedReasons.some((reason) => reason.includes("확인이 끝나지 않은")));
  assert.equal(retried, 0);
  assert.equal(reloadedStore.snapshot().strategy.inFlight.cycleKey, inFlight.cycleKey);
});

test("unknown 주문 결과는 미결 상태를 유지하고 관리종목으로 등록하지 않는다", async (t) => {
  const { stateStore, engine } = await setup(t);
  engine.broker = {
    name: "paper",
    getAccount: async () => ({
      broker: "paper",
      cashKrw: 10_000_000,
      positionsValueKrw: 0,
      totalEquityKrw: 10_000_000,
      positions: []
    }),
    placeOrders: async (orders) =>
      orders.map((order, index) => ({
        ...order,
        status: index === 0 ? "unknown" : "blocked",
        ...(index === 0 ? {} : { notSent: true })
      }))
  };
  const result = await engine.execute();
  assert.equal(result.results[0].status, "unknown");
  const state = stateStore.snapshot();
  assert.ok(state.strategy.inFlight?.cycleKey);
  assert.deepEqual(state.strategy.managedSecurities, {});
  assert.deepEqual(state.strategy.pendingManagedSecurities, {});
});

test("긴급 정지는 주문 묶음 도중 남은 주문을 보내지 않는다", async (t) => {
  const { stateStore, engine } = await setup(t);
  let sent = 0;
  engine.broker = {
    name: "paper",
    getAccount: async () => ({
      broker: "paper",
      cashKrw: 10_000_000,
      positionsValueKrw: 0,
      totalEquityKrw: 10_000_000,
      positions: []
    }),
    placeOrders: async (orders, { beforeEach }) => {
      const results = [];
      for (let index = 0; index < orders.length; index += 1) {
        try {
          await beforeEach(orders[index], index);
        } catch (error) {
          for (const remaining of orders.slice(index)) {
            results.push({
              ...remaining,
              status: "blocked",
              notSent: true,
              reason: error.message
            });
          }
          break;
        }
        sent += 1;
        results.push({
          ...orders[index],
          status: "submitted",
          brokerOrderId: `order-${index}`,
          submittedAt: NOW.toISOString()
        });
        if (index === 0) await writeFile(engine.killSwitchFile, "stop\n", "utf8");
      }
      return results;
    }
  };
  const result = await engine.execute();
  assert.equal(sent, 1);
  assert.ok(result.results.slice(1).every((item) => item.status === "blocked"));
  assert.equal(
    stateStore.snapshot().strategy.inFlight?.cycleKey,
    result.cycleKey,
    "접수된 첫 주문의 체결 대조가 끝날 때까지 미결 실행을 유지해야 한다"
  );
});

test("거절·unknown·단순 선정 종목은 관리종목으로 등록하지 않는다", async (t) => {
  const { stateStore, engine } = await setup(t);
  engine.broker = {
    name: "paper",
    getAccount: async () => ({
      broker: "paper",
      cashKrw: 10_000_000,
      positionsValueKrw: 0,
      totalEquityKrw: 10_000_000,
      positions: []
    }),
    placeOrders: async (orders) =>
      orders.map((order) => ({ ...order, status: "rejected", reason: "test" }))
  };
  const result = await engine.execute();
  assert.ok(result.portfolio.selected.length >= 3);
  assert.deepEqual(stateStore.snapshot().strategy.managedSecurities, {});
});

test("주문번호가 있는 매수 대기종목은 전용계좌 잔고 증가가 확인된 뒤에만 승격한다", async (t) => {
  const { stateStore, engine } = await setup(t);
  const target = company(1);
  const key = `KR:${target.ticker}`;
  await stateStore.update((state) => {
    state.strategy.pendingManagedSecurities[key] = {
      id: target.id,
      ticker: target.ticker,
      name: target.name,
      country: target.country,
      exchange: target.exchange,
      side: "buy",
      brokerOrderId: "broker-verified-order",
      baselineQuantity: 0,
      expectedQuantity: 2,
      submittedAt: NOW.toISOString(),
      cycleKey: "previous-cycle"
    };
  });
  engine.broker = {
    name: "paper",
    getAccount: async () => ({
      broker: "paper",
      cashKrw: 9_979_980,
      positionsValueKrw: 20_020,
      totalEquityKrw: 10_000_000,
      positions: [
        {
          id: key,
          ticker: target.ticker,
          name: target.name,
          country: "KR",
          exchange: "KRX",
          quantity: 2,
          price: 10_010,
          marketValueKrw: 20_020
        }
      ]
    }),
    placeOrders: async (orders) =>
      orders.map((order) => ({ ...order, status: "rejected", reason: "test" }))
  };
  const result = await engine.execute();
  assert.equal(result.blockedReasons.some((reason) => reason.includes("관리 밖")), false);
  const state = stateStore.snapshot();
  assert.equal(state.strategy.managedSecurities[key].id, target.id);
  assert.equal(key in state.strategy.pendingManagedSecurities, false);
});

test("KIS 제출 매수가 잔고에서 확인되지 않으면 다음 주문을 보내지 않는다", async (t) => {
  const { config, stateStore, client } = await setup(t);
  const target = company(1);
  const key = `KR:${target.ticker}`;
  await stateStore.update((state) => {
    state.strategy.pendingManagedSecurities[key] = {
      id: target.id,
      ticker: target.ticker,
      name: target.name,
      country: target.country,
      exchange: target.exchange,
      side: "buy",
      brokerOrderId: "broker-pending-order",
      baselineQuantity: 0,
      expectedQuantity: 2,
      submittedAt: NOW.toISOString(),
      cycleKey: "previous-cycle"
    };
  });
  let submissions = 0;
  const broker = {
    name: "kis",
    getQuotes: async (companies) =>
      companies.map((item) => ({
        id: item.id,
        ticker: item.ticker,
        country: "KR",
        exchange: "KRX",
        currency: "KRW",
        price: item.marketData.price,
        current: true,
        asOf: NOW.toISOString()
      })),
    getAccount: async () => ({
      broker: "kis",
      cashKrw: 10_000_000,
      positionsValueKrw: 0,
      totalEquityKrw: 10_000_000,
      positions: []
    }),
    placeOrders: async () => {
      submissions += 1;
      return [];
    }
  };
  const engine = await createTradingEngine(config, {
    stateStore,
    client,
    broker,
    now: () => NOW
  });

  const result = await engine.execute();

  assert.equal(result.executed, false);
  assert.equal(result.reason, "blocked");
  assert.ok(result.blockedReasons.some((reason) => reason.includes("잔고에 반영")));
  assert.equal(submissions, 0);
  assert.equal("brokerOrderId" in result.management.unresolvedPending[key], false);
  assert.ok(stateStore.snapshot().strategy.pendingManagedSecurities[key]);
});

test("resolve-pending은 증권사에서 미체결을 확인한 실행키만 해제한다", async (t) => {
  const { engine, stateStore } = await setup(t);
  const firstCycle = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const secondCycle = "bbbbbbbbbbbbbbbbbbbbbbbb";
  await stateStore.update((state) => {
    state.strategy.pendingManagedSecurities = {
      "KR:000001": {
        id: "KR-000001",
        ticker: "000001",
        country: "KR",
        cycleKey: firstCycle,
        brokerOrderId: "secret-broker-order-1"
      },
      "KR:000002": {
        id: "KR-000002",
        ticker: "000002",
        country: "KR",
        cycleKey: secondCycle,
        brokerOrderId: "secret-broker-order-2"
      }
    };
  });

  await assert.rejects(
    () => engine.resolvePendingNoFill("cccccccccccccccccccccccc"),
    /대기 주문이 없습니다/
  );
  const resolved = await engine.resolvePendingNoFill(firstCycle);

  assert.deepEqual(resolved, {
    cycleKey: firstCycle,
    resolvedCount: 1,
    ids: ["KR-000001"]
  });
  const state = stateStore.snapshot();
  assert.equal(state.strategy.pendingManagedSecurities["KR:000001"], undefined);
  assert.ok(state.strategy.pendingManagedSecurities["KR:000002"]);
  assert.ok(state.strategy.completedCycleKeys.includes(firstCycle));
  assert.deepEqual(state.strategy.managedSecurities, {});
});

async function seedInFlight(stateStore, {
  cycleKey = "dddddddddddddddddddddddd",
  createdAt = NOW.toISOString(),
  orders
} = {}) {
  const seededOrders = orders || [
    {
      index: 0,
      checkpointId: "checkpoint-filled-buy",
      id: "KR-000001",
      ticker: "000001",
      name: "기업 000001",
      country: "KR",
      exchange: "KOSPI",
      side: "buy",
      quantity: 2,
      limitPrice: 10_100,
      currency: "KRW",
      baselineQuantity: 0,
      status: "submitted",
      brokerOrderId: "1234567890",
      branchNumber: "12345",
      submittedAt: createdAt,
      checkedAt: null
    }
  ];
  await stateStore.update((state) => {
    state.strategy.inFlight = {
      cycleKey,
      trigger: "test",
      createdAt,
      signalRevision: "signal-r1",
      orders: seededOrders
    };
    state.strategy.pendingManagedSecurities = Object.fromEntries(
      seededOrders
        .filter((order) => order.side === "buy")
        .map((order) => [
          `${order.country}:${order.ticker}`,
          {
            id: order.id,
            ticker: order.ticker,
            name: order.name,
            country: order.country,
            exchange: order.exchange,
            side: order.side,
            cycleKey,
            brokerOrderId: order.brokerOrderId,
            baselineQuantity: order.baselineQuantity,
            expectedQuantity: order.quantity,
            submittedAt: createdAt
          }
        ])
    );
  });
  return { cycleKey, orders: seededOrders };
}

test("KIS 체결 대조가 모두 종료되면 실제 잔고로 관리종목을 보수적으로 재구축한다", async (t) => {
  const { config, stateStore, client } = await setup(t);
  const { cycleKey } = await seedInFlight(stateStore);
  let accountReads = 0;
  const broker = {
    name: "kis",
    getDailyOrders: async () => ({
      orders: [
        {
          brokerOrderId: "1234567890",
          branchNumber: "12345",
          ticker: "000001",
          side: "buy",
          quantity: 2,
          filledQuantity: 2,
          remainingQuantity: 0,
          canceledQuantity: 0,
          limitPrice: 10_100,
          averageFillPrice: 10_050,
          orderDate: "20260720",
          orderTime: "100001",
          status: "filled"
        }
      ]
    }),
    getAccount: async () => {
      accountReads += 1;
      return {
        broker: "kis",
        cashKrw: 79_900,
        positionsValueKrw: 20_100,
        totalEquityKrw: 100_000,
        positions: [
          {
            id: "KR:000001",
            ticker: "000001",
            name: "기업 000001",
            country: "KR",
            exchange: "KRX",
            quantity: 2,
            price: 10_050,
            marketValueKrw: 20_100
          },
          {
            id: "KR:999999",
            ticker: "999999",
            name: "관리 밖 종목",
            country: "KR",
            exchange: "KRX",
            quantity: 1,
            price: 1,
            marketValueKrw: 1
          }
        ]
      };
    }
  };
  const engine = await createTradingEngine(config, {
    stateStore,
    client,
    broker,
    now: () => NOW
  });

  const result = await engine.reconcileInFlight({ trigger: "test" });

  assert.equal(result.status, "cleared");
  assert.equal(result.cleared, true);
  assert.equal(accountReads, 1);
  const state = stateStore.snapshot();
  assert.equal(state.strategy.inFlight, null);
  assert.equal(state.strategy.managedSecurities["KR:000001"].id, "KR-000001");
  assert.equal(state.strategy.managedSecurities["KR:999999"], undefined);
  assert.equal(state.strategy.pendingManagedSecurities["KR:000001"], undefined);
  assert.ok(state.strategy.completedCycleKeys.includes(cycleKey));
});

test("주문내역 대조가 모호하면 unknown으로 남기고 잔고 조회나 재주문을 하지 않는다", async (t) => {
  const { config, stateStore, client } = await setup(t);
  await seedInFlight(stateStore, {
    orders: [
      {
        index: 0,
        checkpointId: "checkpoint-ambiguous",
        id: "KR-000002",
        ticker: "000002",
        name: "기업 000002",
        country: "KR",
        exchange: "KOSPI",
        side: "buy",
        quantity: 1,
        limitPrice: 10_200,
        currency: "KRW",
        baselineQuantity: 0,
        status: "unknown",
        brokerOrderId: null,
        branchNumber: null,
        submittedAt: NOW.toISOString(),
        checkedAt: null
      }
    ]
  });
  let accountReads = 0;
  let submissions = 0;
  const duplicate = {
    brokerOrderId: "2222222222",
    branchNumber: "12345",
    ticker: "000002",
    side: "buy",
    quantity: 1,
    filledQuantity: 0,
    remainingQuantity: 1,
    canceledQuantity: 0,
    limitPrice: 10_200,
    orderDate: "20260720",
    orderTime: "100001",
    status: "open"
  };
  const broker = {
    name: "kis",
    getDailyOrders: async () => ({
      orders: [duplicate, { ...duplicate, brokerOrderId: "3333333333" }]
    }),
    getAccount: async () => {
      accountReads += 1;
      return { positions: [] };
    },
    placeOrders: async () => {
      submissions += 1;
      return [];
    }
  };
  const engine = await createTradingEngine(config, {
    stateStore,
    client,
    broker,
    now: () => NOW
  });

  const result = await engine.reconcileInFlight({ trigger: "test" });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.ambiguous, true);
  assert.equal(accountReads, 0);
  assert.equal(submissions, 0);
  assert.equal(stateStore.snapshot().strategy.inFlight.orders[0].status, "unknown");
});

test("조회에서 사라진 주문은 장 마감 뒤 서로 다른 두 번의 확인 후에만 not_found로 종료한다", async (t) => {
  const { config, stateStore, client } = await setup(t);
  await seedInFlight(stateStore);
  let current = new Date("2026-07-20T07:00:00.000Z");
  let accountReads = 0;
  const broker = {
    name: "kis",
    getDailyOrders: async () => ({ orders: [] }),
    getAccount: async () => {
      accountReads += 1;
      return {
        broker: "kis",
        cashKrw: 100_000,
        positionsValueKrw: 0,
        totalEquityKrw: 100_000,
        positions: []
      };
    }
  };
  const engine = await createTradingEngine(config, {
    stateStore,
    client,
    broker,
    now: () => current
  });

  const first = await engine.reconcileInFlight({ trigger: "first-check" });
  assert.equal(first.status, "pending");
  assert.equal(accountReads, 0);
  assert.equal(stateStore.snapshot().strategy.inFlight.orders[0].missingChecks, 1);

  current = new Date("2026-07-20T07:01:00.000Z");
  const second = await engine.reconcileInFlight({ trigger: "second-check" });
  assert.equal(second.status, "cleared");
  assert.equal(second.statusCounts.not_found, 1);
  assert.equal(accountReads, 1);
  assert.equal(stateStore.snapshot().strategy.inFlight, null);
});

test("전량 미체결 주문만 안전 취소하고 취소 접수를 즉시 체크포인트해 중복 취소하지 않는다", async (t) => {
  const { config, stateStore, client } = await setup(t);
  await seedInFlight(stateStore);
  let cancelCalls = 0;
  let safetyChecks = 0;
  const openOrder = {
    brokerOrderId: "1234567890",
    branchNumber: "12345",
    ticker: "000001",
    side: "buy",
    quantity: 2,
    filledQuantity: 0,
    remainingQuantity: 2,
    canceledQuantity: 0,
    limitPrice: 10_100,
    orderDate: "20260720",
    orderTime: "100001",
    status: "open"
  };
  const broker = {
    name: "kis",
    getDailyOrders: async () => ({ orders: [openOrder] }),
    getCancelableOrders: async () => ({
      orders: [
        {
          ...openOrder,
          orderQuantity: 2,
          cancelableQuantity: 2
        }
      ]
    }),
    cancelOrder: async () => {
      cancelCalls += 1;
      return {
        status: "cancel_submitted",
        cancelOrderId: "9876543210",
        submittedAt: NOW.toISOString()
      };
    },
    getAccount: async () => {
      throw new Error("종료 전에는 잔고를 읽으면 안 됨");
    }
  };
  const engine = await createTradingEngine(config, {
    stateStore,
    client,
    broker,
    now: () => NOW,
    beforeOrder: async (_order, _index, context) => {
      assert.equal(context.type, "cancel");
      safetyChecks += 1;
    }
  });

  const first = await engine.reconcileInFlight({
    trigger: "afternoon",
    cancelOpenOrders: true
  });
  assert.equal(first.status, "pending");
  assert.equal(cancelCalls, 1);
  assert.equal(safetyChecks, 1);
  assert.equal(
    stateStore.snapshot().strategy.inFlight.orders[0].cancel.status,
    "cancel_submitted"
  );

  await engine.reconcileInFlight({ trigger: "afternoon-retry", cancelOpenOrders: true });
  assert.equal(cancelCalls, 1);
  assert.equal(safetyChecks, 1);
});

async function setupLiveKisEngine(
  t,
  {
    marketDate = "20260720",
    sufficient = true,
    capitalLimitKrw = 100_000,
    accountCashKrw = 100_000,
    accountTotalEquityKrw = accountCashKrw,
    accountPositions = [],
    quoteObservedAt = NOW.toISOString(),
    engineNow = () => NOW,
    timeBounds = null,
    beforePersist = null,
    beforeOrder = null
  } = {}
) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "longview-live-safety-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const config = getTradingConfig({
    env: {
      TRADING_MODE: "live",
      TRADING_BROKER: "kis",
      KIS_ENV: "prod",
      KIS_APP_KEY: "test-app",
      KIS_APP_SECRET: "test-secret",
      KIS_ACCOUNT_NUMBER: "12345678",
      TRADING_CAPITAL_LIMIT_KRW: String(capitalLimitKrw),
      ...(capitalLimitKrw === 0
        ? {
            TRADING_USE_ALL_DEDICATED_ACCOUNT_ASSETS: "true",
            USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACK:
              USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACKNOWLEDGEMENT
          }
        : {}),
      ENABLE_LIVE_TRADING: "true",
      LIVE_TRADING_ACK: LIVE_ACKNOWLEDGEMENT
    },
    rootDir,
    loadEnv: false
  });
  const stateStore = await createTradingStateStore(config.stateDir, {
    startingCashKrw: accountCashKrw,
    now: () => NOW
  });
  if (accountPositions.length > 0) {
    await stateStore.update((state) => {
      state.strategy.managedSecurities = Object.fromEntries(
        accountPositions.map((position) => [
          `${String(position.country || "KR").toUpperCase()}:${position.ticker}`,
          {
            id: position.id,
            ticker: position.ticker,
            country: position.country || "KR",
            exchange: position.exchange || "KOSPI",
            name: position.name || position.id
          }
        ])
      );
    });
  }
  const sourceSignal = signal();
  const chosen = sourceSignal.companies.slice(0, 3);
  sourceSignal.selection = {
    status: "ready",
    strategyVersion: config.strategy.version,
    policy: { preferredPositions: 3 },
    ranked: chosen.map((item, index) => ({
      id: item.id,
      ticker: item.ticker,
      country: item.country,
      exchange: item.exchange,
      investmentRank: index + 1
    })),
    selected: chosen.map((item, index) => ({
      id: item.id,
      investmentRank: index + 1,
      targetWeight: 0.333333333333
    }))
  };
  let signalCalls = 0;
  let quoteCalls = 0;
  let accountCalls = 0;
  let buyableCalls = 0;
  let submitted = 0;
  const broker = {
    name: "kis",
    getQuotes: async (companies) => {
      quoteCalls += 1;
      return companies.map((item) => ({
        id: item.id,
        ticker: item.ticker,
        country: "KR",
        exchange: "KRX",
        currency: "KRW",
        price: item.marketData.price,
        current: true,
        asOf: quoteObservedAt,
        marketDate
      }));
    },
    getAccount: async () => {
      accountCalls += 1;
      return {
        broker: "kis",
        cashKrw: accountCashKrw,
        positionsValueKrw: accountPositions.reduce(
          (sum, position) => sum + Number(position.marketValueKrw || 0),
          0
        ),
        totalEquityKrw: accountTotalEquityKrw,
        positions: structuredClone(accountPositions)
      };
    },
    getBuyableOrder: async () => {
      buyableCalls += 1;
      return { sufficient };
    },
    placeOrders: async (orders, { beforeEach, beforeSubmit, afterEach }) => {
      const results = [];
      for (let index = 0; index < orders.length; index += 1) {
        try {
          await beforeEach(orders[index], index);
          await beforeSubmit(orders[index], index);
        } catch (error) {
          for (const remaining of orders.slice(index)) {
            results.push({
              ...remaining,
              status: "blocked",
              notSent: true,
              errorCode: error.code
            });
          }
          break;
        }
        submitted += 1;
        const result = {
          ...orders[index],
          status: "submitted",
          brokerOrderId: String(1000 + index),
          branchNumber: "01",
          submittedAt: NOW.toISOString()
        };
        results.push(result);
        await afterEach(result, index);
      }
      return results;
    }
  };
  const engine = await createTradingEngine(config, {
    stateStore,
    broker,
    client: {
      getSignal: async () => {
        signalCalls += 1;
        return structuredClone(sourceSignal);
      }
    },
    now: engineNow,
    timeBounds,
    beforePersist,
    beforeOrder
  });
  return {
    engine,
    stateStore,
    counters: {
      get signalCalls() { return signalCalls; },
      get quoteCalls() { return quoteCalls; },
      get accountCalls() { return accountCalls; },
      get buyableCalls() { return buyableCalls; },
      get submitted() { return submitted; }
    }
  };
}

test("예약 재시도 식별자는 명시적 옵션과 함께만 일반 거래에 사용할 수 있다", async (t) => {
  const { engine } = await setup(t);
  await assert.rejects(
    engine.plan({ cycleScope: "scheduled-trade:2026-07-20" }),
    /명시적인 예약 재시도/
  );
  await assert.rejects(
    engine.plan({ scheduledRetry: true }),
    /일일 실행 식별자/
  );
  await assert.rejects(
    engine.plan({
      scheduledRetry: true,
      cashDeploymentOnly: true,
      cycleScope: "scheduled-trade:2026-07-20"
    }),
    /함께 사용할 수 없습니다/
  );
});

test("완료된 예약 일일 사이클은 신호·KIS 조회 전에 상태 변경 없이 멱등 성공한다", async (t) => {
  const { engine, stateStore, counters } = await setupLiveKisEngine(t);
  const options = {
    liveConfirmation: true,
    scheduledRetry: true,
    cycleScope: "scheduled-trade:2026-07-20"
  };
  const initialPlan = await engine.plan(options);
  assert.ok(initialPlan.cycleKey);
  assert.equal(counters.signalCalls, 1);
  assert.equal(counters.quoteCalls, 1);
  assert.equal(counters.accountCalls, 1);

  await stateStore.update((state) => {
    state.strategy.completedCycleKeys = [initialPlan.cycleKey];
    state.strategy.managedSecurities = {
      "KR:999999": {
        id: "KR-999999",
        ticker: "999999",
        country: "KR",
        name: "보존 대상"
      }
    };
  });
  const before = stateStore.snapshot();
  const beforeCalls = {
    signal: counters.signalCalls,
    quote: counters.quoteCalls,
    account: counters.accountCalls
  };

  const duplicate = await engine.execute(options);

  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.executed, false);
  assert.equal(duplicate.alreadyCompleted, true);
  assert.equal(duplicate.reason, "already_completed");
  assert.deepEqual(duplicate.orders, []);
  assert.deepEqual(duplicate.blockedReasons, []);
  assert.equal(counters.signalCalls, beforeCalls.signal);
  assert.equal(counters.quoteCalls, beforeCalls.quote);
  assert.equal(counters.accountCalls, beforeCalls.account);
  assert.deepEqual(stateStore.snapshot(), before);
});

test("createTradingEngine은 KIS 브로커에도 엔진과 같은 신뢰 시각을 주입한다", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "longview-kis-clock-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const config = getTradingConfig({
    env: {
      TRADING_MODE: "live",
      TRADING_BROKER: "kis",
      KIS_ENV: "prod",
      KIS_APP_KEY: "test-app",
      KIS_APP_SECRET: "test-secret",
      KIS_ACCOUNT_NUMBER: "12345678",
      TRADING_CAPITAL_LIMIT_KRW: "100000",
      ENABLE_LIVE_TRADING: "true",
      LIVE_TRADING_ACK: LIVE_ACKNOWLEDGEMENT
    },
    rootDir,
    loadEnv: false
  });
  const trustedNow = new Date("2026-07-20T01:23:45.678Z");
  const stateStore = await createTradingStateStore(config.stateDir, {
    startingCashKrw: 100_000,
    now: () => trustedNow
  });
  const engine = await createTradingEngine(config, {
    stateStore,
    client: { getSignal: async () => structuredClone(signal()) },
    now: () => new Date(trustedNow)
  });

  assert.equal(engine.broker._now(), trustedNow.getTime());
});

test("실전 전체자산 모드는 10만원 초과 현금도 관리 순자산과 재배분 대상으로 사용한다", async (t) => {
  const { engine } = await setupLiveKisEngine(t, {
    capitalLimitKrw: 0,
    accountCashKrw: 135_000
  });
  const plan = await engine.plan({ liveConfirmation: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.account.actualTotalEquityKrw, 135_000);
  assert.equal(plan.account.managedEquityKrw, 135_000);
  assert.equal(plan.account.totalEquityKrw, 135_000);
  assert.equal(plan.account.cashKrw, 135_000);
  assert.ok(plan.orders.length > 0);
});

test("KIS 포지션 sector 누락은 동일 신호 종목의 검증 sector로 보강해 거짓 한도 차단을 막는다", async (t) => {
  const positions = [company(1), company(2), company(3)].map((item) => ({
    id: item.id,
    ticker: item.ticker,
    name: item.name,
    country: item.country,
    exchange: item.exchange,
    quantity: 2,
    price: item.marketData.price,
    marketValueKrw: item.marketData.price * 2
  }));
  const positionsValueKrw = positions.reduce(
    (sum, position) => sum + position.marketValueKrw,
    0
  );
  const { engine } = await setupLiveKisEngine(t, {
    capitalLimitKrw: 100_000,
    accountCashKrw: 100_000 - positionsValueKrw,
    accountTotalEquityKrw: 100_000,
    accountPositions: positions
  });

  const plan = await engine.plan({ liveConfirmation: true });

  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.account.positions.map((position) => position.sector),
    ["업종 1", "업종 2", "업종 3"]
  );
  assert.ok(plan.orders.some((order) => order.side === "buy"));
  assert.equal(
    plan.planner.diagnostics.skipped.some(
      (item) => item.reason === "position_weight_limit"
    ),
    false
  );
});

test("runner 시각이 장중이어도 신뢰 시각 범위가 장외이면 실전 계획을 차단한다", async (t) => {
  const afterHours = new Date("2026-07-20T10:23:00.000Z");
  const { engine } = await setupLiveKisEngine(t, {
    engineNow: () => NOW,
    timeBounds: () => ({ earliest: afterHours, latest: afterHours })
  });

  const plan = await engine.plan({ liveConfirmation: true });
  assert.equal(plan.ok, false);
  assert.ok(
    plan.blockedReasons.includes("실전 주문 허용시간(평일 09:05~14:50 KST)이 아닙니다.")
  );
});

test("각 주문 직전 갱신된 신뢰 시각이 장외이면 매수가능 조회와 주문을 모두 중단한다", async (t) => {
  const open = new Date(NOW);
  const closed = new Date("2026-07-20T10:23:00.000Z");
  let current = open;
  let persistChecks = 0;
  let orderChecks = 0;
  const { engine, counters } = await setupLiveKisEngine(t, {
    timeBounds: () => ({ earliest: current, latest: current }),
    beforePersist: async () => {
      persistChecks += 1;
      current = open;
    },
    beforeOrder: async () => {
      orderChecks += 1;
      current = closed;
    }
  });

  const result = await engine.execute({ liveConfirmation: true });
  assert.equal(persistChecks, 1);
  assert.equal(orderChecks, 1);
  assert.equal(counters.buyableCalls, 0);
  assert.equal(counters.submitted, 0);
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every((item) => item.status === "blocked" && item.notSent === true));
  assert.ok(result.results.every((item) => item.errorCode === "LIVE_ORDER_WINDOW_CLOSED"));
});

test("매수가능 조회 뒤 POST 직전 시각이 장외로 바뀌어도 주문을 보내지 않는다", async (t) => {
  const open = new Date(NOW);
  const closed = new Date("2026-07-20T10:23:00.000Z");
  let current = open;
  let orderChecks = 0;
  const { engine, counters } = await setupLiveKisEngine(t, {
    timeBounds: () => ({ earliest: current, latest: current }),
    beforeOrder: async () => {
      orderChecks += 1;
      if (orderChecks === 2) current = closed;
    }
  });

  const result = await engine.execute({ liveConfirmation: true });
  assert.equal(orderChecks, 2);
  assert.equal(counters.buyableCalls, 1);
  assert.equal(counters.submitted, 0);
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every((item) => item.status === "blocked" && item.notSent === true));
  assert.ok(result.results.every((item) => item.errorCode === "LIVE_ORDER_WINDOW_CLOSED"));
});

test("실전 KIS는 오늘 영업일이 아닌 현재가로 주문 계획을 만들지 않는다", async (t) => {
  const { engine } = await setupLiveKisEngine(t, { marketDate: "20260717" });
  const plan = await engine.plan({ liveConfirmation: true });
  assert.equal(plan.ok, false);
  assert.ok(
    plan.risk.quoteIssues.some((issue) => issue.code === "broker_market_date_stale")
  );
});

test("실전 KIS는 계획 시작 뒤 도착한 현재가를 미래 시세로 오판하지 않는다", async (t) => {
  let clockCalls = 0;
  const { engine } = await setupLiveKisEngine(t, {
    quoteObservedAt: new Date(NOW.getTime() + 5_000).toISOString(),
    engineNow: () => {
      const value = new Date(NOW.getTime() + (clockCalls === 0 ? 0 : 10_000));
      clockCalls += 1;
      return value;
    }
  });

  const plan = await engine.plan({ liveConfirmation: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.portfolio.status, "ready");
  assert.ok(plan.orders.length > 0);
});

test("KIS 당일 체결분이 예수금에도 남아 있어도 계좌 순자산을 이중 계산하지 않는다", async (t) => {
  const held = company(1);
  const marketValueKrw = held.marketData.price * 8;
  const { engine } = await setupLiveKisEngine(t, {
    capitalLimitKrw: 0,
    accountCashKrw: 1_000_000,
    accountTotalEquityKrw: 1_000_000,
    accountPositions: [
      {
        id: held.id,
        ticker: held.ticker,
        name: held.name,
        country: held.country,
        exchange: held.exchange,
        sector: held.sector,
        quantity: 8,
        price: held.marketData.price,
        priceKrw: held.marketData.price,
        marketValueKrw
      }
    ]
  });
  const plan = await engine.plan({ liveConfirmation: true });

  assert.equal(plan.account.reportedCashKrw, 1_000_000);
  assert.equal(plan.account.totalEquityKrw, 1_000_000);
  assert.equal(plan.account.cashKrw, 1_000_000 - marketValueKrw);
});

test("실전 매수는 미수 없는 매수가능수량 확인을 통과해야만 전송된다", async (t) => {
  const { engine, counters, stateStore } = await setupLiveKisEngine(t, {
    sufficient: false
  });
  const result = await engine.execute({ liveConfirmation: true });
  assert.equal(result.executed, false);
  assert.equal(result.reason, "orders_not_sent");
  assert.equal(counters.buyableCalls, 1);
  assert.equal(counters.submitted, 0);
  assert.equal(stateStore.snapshot().strategy.inFlight, null);
  assert.equal(
    stateStore.snapshot().strategy.completedCycleKeys.includes(result.cycleKey),
    false
  );
  assert.ok(result.results.every((item) => item.status === "blocked"));
  assert.ok(
    result.results.every(
      (item) => item.errorCode === "KIS_BUYABLE_QUANTITY_EXCEEDED"
    )
  );
});
