import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PaperBroker } from "../autotrade/brokers/paper.mjs";
import { getTradingConfig } from "../autotrade/config.mjs";
import { createTradingEngine } from "../autotrade/engine.mjs";
import { createTradingStateStore } from "../autotrade/state-store.mjs";

const MONDAY = new Date("2026-07-20T01:00:00.000Z");
const TUESDAY = new Date("2026-07-21T01:00:00.000Z");
const WEDNESDAY = new Date("2026-07-22T01:00:00.000Z");
const THURSDAY = new Date("2026-07-23T01:00:00.000Z");

function company(index, { score = 95 - index / 2 } = {}) {
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
      price: 10_000,
      currency: "KRW",
      marketCap: 500_000_000_000,
      turnover: 5_000_000_000
    },
    score: {
      modelVersion: "2.0.0",
      total: score,
      dataConfidence: 95,
      completeness: 95,
      valuationConfidence: 95,
      evaluationReady: true,
      candidate: { eligible: score >= 78 },
      components: {
        valuation: { score: 85 },
        longGrowth: { score: 85 },
        quality: { score: 85 },
        safety: { score: 85 }
      }
    }
  };
}

function dailySignal(now, revision, { rotate = false } = {}) {
  const companies = Array.from({ length: 20 }, (_, offset) => {
    const index = offset + 1;
    if (rotate && index === 1) return company(index, { score: 70 });
    if (rotate && index === 13) return company(index, { score: 99 });
    return company(index);
  });
  const updatedAt = now.toISOString();
  const date = updatedAt.slice(0, 10);
  for (const item of companies) item.marketData.asOf = date;
  return {
    revision,
    signalRevision: revision,
    rawRevision: `raw-${revision}`,
    modelVersion: "2.0.0",
    sourceUpdatedAt: updatedAt,
    fetchedAt: updatedAt,
    health: { dataLoadStatus: "ok", updatedAt },
    methodology: { modelVersion: "2.0.0" },
    candidateSummaries: companies.map(({ id }) => ({ id })),
    candidates: companies,
    companies,
    quotes: Object.fromEntries(companies.map((item) => [item.id, item.marketData]))
  };
}

async function setup(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "longview-daily-paper-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let now = new Date(MONDAY);
  let currentSignal = dailySignal(now, "day-1");
  let signalReads = 0;
  const config = getTradingConfig({
    env: {
      TRADING_MODE: "paper",
      TRADING_REQUIRE_PUBLISHED_SELECTION: "false",
      PAPER_STARTING_CASH_KRW: "1000000",
      PAPER_FEE_PERCENT: "0",
      TRADING_MIN_POSITIONS: "8",
      TRADING_MAX_POSITIONS: "12",
      TRADING_MIN_POSITION_KRW: "50000",
      TRADING_MIN_ORDER_KRW: "10000",
      TRADING_REBALANCE_DRIFT_PERCENT: "1",
      TRADING_REBALANCE_FREQUENCY: "daily",
      TRADING_REMOVAL_CONFIRMATIONS: "2",
      TRADING_MAX_TURNOVER_PERCENT: "20",
      TRADING_INITIAL_DEPLOYMENT_TURNOVER_PERCENT: "100",
      TRADING_LIMIT_BUFFER_PERCENT: "0"
    },
    rootDir,
    loadEnv: false
  });
  const stateStore = await createTradingStateStore(config.stateDir, {
    startingCashKrw: config.paper.startingCashKrw,
    now: () => new Date(now)
  });
  const broker = new PaperBroker(stateStore, { feeRate: 0 });
  const client = {
    getSignal: async () => {
      signalReads += 1;
      return structuredClone(currentSignal);
    },
    getCompany: async (id) => {
      const found = currentSignal.companies.find((item) => item.id === id);
      if (!found) throw new Error(`mock company not found: ${id}`);
      return structuredClone(found);
    }
  };
  const engine = await createTradingEngine(config, {
    stateStore,
    broker,
    client,
    now: () => new Date(now)
  });
  return {
    config,
    stateStore,
    broker,
    engine,
    setDay(value, revision, options) {
      now = new Date(value);
      currentSignal = dailySignal(now, revision, options);
    },
    signalReadCount: () => signalReads
  };
}

async function seedBalancedMillionWon(stateStore) {
  const holdings = Array.from({ length: 12 }, (_, offset) => company(offset + 1));
  await stateStore.update((state) => {
    state.paper.cashKrw = 0;
    state.paper.positions = Object.fromEntries(
      holdings.map((item, index) => [
        item.id,
        {
          id: item.id,
          ticker: item.ticker,
          name: item.name,
          country: item.country,
          exchange: item.exchange,
          sector: item.sector,
          currency: "KRW",
          quantity: index < 4 ? 9 : 8,
          averagePrice: 10_000,
          lastPrice: 10_000,
          updatedAt: "2026-07-17T01:00:00.000Z"
        }
      ])
    );
    state.strategy.lastPlanAt = "2026-07-17T01:00:00.000Z";
    state.strategy.candidateCount = 20;
    state.strategy.initialDeploymentCompleted = true;
    state.strategy.managedSecurities = Object.fromEntries(
      holdings.map((item) => [
        `KR:${item.ticker}`,
        {
          id: item.id,
          ticker: item.ticker,
          name: item.name,
          country: item.country,
          exchange: item.exchange
        }
      ])
    );
  });
}

test("100만원 모의계좌는 외부 주문 없이 가치·장기 후보에 자동 분산투자한다", async (t) => {
  const { engine, stateStore, signalReadCount } = await setup(t);

  const result = await engine.execute({ trigger: "test-daily" });

  assert.equal(result.executed, true);
  assert.equal(result.account.totalEquityKrw, 1_000_000);
  assert.equal(result.portfolio.selected.length, 12);
  assert.ok(result.orders.every((order) => order.side === "buy"));
  assert.ok(result.results.every((order) => order.status === "filled"));
  const paper = stateStore.snapshot().paper;
  const invested = Object.values(paper.positions).reduce(
    (sum, position) => sum + position.quantity * position.lastPrice,
    0
  );
  assert.equal(paper.cashKrw + invested, 1_000_000);
  assert.equal(paper.cashKrw, 0, "1주 단위로 정확히 배분 가능한 경우 목표 현금은 0원이다");
  assert.equal(Object.keys(paper.positions).length, 12);
  assert.equal(signalReadCount(), 1, "신호는 주입한 로컬 mock에서만 읽는다");
});

test("새 스냅샷의 무변화는 유지하고, 악화 종목은 서로 다른 2회 확인 뒤 교체한다", async (t) => {
  const { engine, stateStore, setDay } = await setup(t);
  await seedBalancedMillionWon(stateStore);
  const before = stateStore.snapshot().paper;

  setDay(MONDAY, "unchanged-day-1");
  const unchanged = await engine.execute({ trigger: "test-daily" });
  assert.equal(unchanged.executed, false);
  assert.equal(unchanged.reason, "no_orders");
  assert.deepEqual(unchanged.orders, []);
  assert.deepEqual(stateStore.snapshot().paper, before, "값이 같으면 보유수량과 현금을 유지한다");

  const duplicate = await engine.execute({ trigger: "test-daily" });
  assert.equal(duplicate.executed, false);
  assert.equal(duplicate.reason, "blocked");
  assert.ok(duplicate.blockedReasons.some((reason) => reason.includes("이미 처리")));
  assert.deepEqual(stateStore.snapshot().paper, before, "같은 날 재실행해도 중복 주문하지 않는다");

  setDay(TUESDAY, "rotation-observation-1", { rotate: true });
  const firstObservation = await engine.execute({ trigger: "test-daily" });
  assert.equal(firstObservation.executed, false);
  assert.equal(firstObservation.reason, "no_orders");
  assert.equal(
    stateStore.snapshot().strategy.removalStreaks["KR:000001"],
    1,
    "일시적 점수 악화만으로 즉시 매도하지 않는다"
  );
  assert.ok(firstObservation.portfolio.selected.some((item) => item.id === "KR-000013"));
  assert.ok(firstObservation.portfolio.selected.every((item) => item.id !== "KR-000001"));

  setDay(WEDNESDAY, "rotation-observation-1", { rotate: true });
  const staleObservation = await engine.execute({ trigger: "test-daily" });
  assert.equal(staleObservation.executed, false);
  assert.equal(staleObservation.reason, "blocked");
  assert.ok(staleObservation.blockedReasons.some((reason) => reason.includes("새로 게시된")));
  assert.equal(
    stateStore.snapshot().strategy.removalStreaks["KR:000001"],
    1,
    "날짜만 바뀐 같은 스냅샷은 두 번째 악화 확인으로 세지 않는다"
  );

  setDay(THURSDAY, "rotation-observation-2", { rotate: true });
  const confirmed = await engine.execute({ trigger: "test-daily" });
  assert.equal(confirmed.executed, true);
  assert.deepEqual(
    confirmed.orders.map((order) => [order.side, order.id, order.reason]),
    [
      ["sell", "KR-000001", "confirmed_removal"],
      ["buy", "KR-000013", "rebalance_underweight"]
    ]
  );
  assert.ok(confirmed.results.every((order) => order.status === "filled"));
  const after = stateStore.snapshot().paper;
  assert.equal(after.positions["KR-000001"], undefined);
  assert.equal(after.positions["KR-000013"].quantity, 9);
  assert.equal(after.cashKrw, 0);
  assert.equal(after.orders.length, 2, "실제 증권 주문이 아니라 모의 체결 기록만 남긴다");
});
