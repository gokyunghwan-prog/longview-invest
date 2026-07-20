import test from "node:test";
import assert from "node:assert/strict";

import {
  BALANCED_V1_DEFAULTS,
  evaluateCandidate,
  selectBalancedPortfolio,
  selectPublishedPortfolio
} from "../autotrade/strategy.mjs";
import { INVESTMENT_SELECTION_STRATEGY_VERSION } from "../lib/investment-selection.mjs";

const now = "2026-07-19T12:00:00.000Z";

function company(id, { country = "KR", sector = "산업재", score = 90 } = {}) {
  return {
    id,
    ticker: id.replace(/[^A-Z0-9]/gi, "").slice(-6),
    name: `회사 ${id}`,
    country,
    exchange: "KOSPI",
    sector,
    dataMode: "live",
    stale: false,
    score: {
      total: score,
      dataConfidence: 95,
      completeness: 95,
      valuationConfidence: 90,
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

function quoteFor(item) {
  return {
    price: 10_000,
    currency: "KRW",
    current: true,
    asOf: "2026-07-19",
    marketCapKrw: 200_000_000_000,
    averageDailyTurnoverKrw: 2_000_000_000
  };
}

function quotesFor(companies) {
  return Object.fromEntries(companies.map((item) => [item.id, quoteFor(item)]));
}

test("Balanced v1 후보 게이트는 78/85/85/75와 현재 시세를 모두 요구한다", () => {
  const base = company("KR-GATE", { score: 78 });
  base.score.dataConfidence = 85;
  base.score.completeness = 85;
  base.score.valuationConfidence = 75;
  const quote = quoteFor(base);
  assert.equal(evaluateCandidate({ company: base, quote, now }).eligible, true);

  for (const [field, reason] of [
    ["total", "score_below_minimum"],
    ["dataConfidence", "confidence_below_minimum"],
    ["completeness", "completeness_below_minimum"],
    ["valuationConfidence", "valuation_confidence_below_minimum"]
  ]) {
    const failing = structuredClone(base);
    failing.score[field] -= 1;
    const result = evaluateCandidate({ company: failing, quote, now });
    assert.equal(result.eligible, false);
    assert.ok(result.reasonCodes.includes(reason));
  }

  const stale = evaluateCandidate({
    company: base,
    quote: { ...quote, current: false },
    now
  });
  assert.equal(stale.eligible, false);
  assert.equal(stale.dataFailure, true);
  assert.ok(stale.reasonCodes.includes("current_price_stale"));

  const minimumLiquidity = evaluateCandidate({
    company: base,
    quote: { ...quote, averageDailyTurnoverKrw: 500_000_000 },
    now
  });
  assert.equal(minimumLiquidity.eligible, true);
  const belowLiquidity = evaluateCandidate({
    company: base,
    quote: { ...quote, averageDailyTurnoverKrw: 499_999_999 },
    now
  });
  assert.ok(belowLiquidity.reasonCodes.includes("turnover_below_minimum"));
});

test("후보와 자금이 충분하면 업종을 순환해 최대 18종목에 목표 현금 없이 배분한다", () => {
  const sectors = ["산업재", "정보기술", "헬스케어", "소비재", "소재", "금융"];
  const companies = Array.from({ length: 30 }, (_, index) =>
    company(`KR-${String(index).padStart(2, "0")}`, {
      sector: sectors[index % sectors.length],
      score: 99 - index / 10
    })
  );
  const result = selectBalancedPortfolio({
    companies,
    quotes: quotesFor(companies),
    totalEquityKrw: 100_000_000,
    now
  });

  assert.equal(result.status, "ready");
  assert.equal(result.desiredPositions, 5);
  assert.equal(result.selected.length, 5);
  assert.ok(result.selected.every((item) => item.targetWeight === 0.2));
  assert.equal(result.investedTargetWeight, 1);
  assert.equal(result.cashTargetWeight, 0);
  assert.ok(Object.values(result.sectorWeights).every((weight) => weight <= 0.35));
});

test("국내 후보만으로 업종 한도 안에서 투자 가능 비중을 채운다", () => {
  const companies = Array.from({ length: 20 }, (_, index) =>
    company(`KR-ONLY-${index}`, {
      sector: `업종-${index % 5}`,
      score: 100 - index
    })
  );
  const result = selectBalancedPortfolio({
    companies,
    quotes: quotesFor(companies),
    totalEquityKrw: 100_000_000,
    now
  });

  assert.equal(result.status, "ready");
  assert.equal(result.selected.length, 5);
  assert.ok(result.selected.every((item) => item.targetWeight === 0.2));
  assert.equal(result.investedTargetWeight, 1);
  assert.equal(result.cashTargetWeight, 0);
});

test("8개 후보만 있어도 동일비중으로 전액 배치하고 그보다 적으면 차단한다", () => {
  const eight = Array.from({ length: 3 }, (_, index) =>
    company(`KR-THREE-${index}`, { sector: `업종-${index}` })
  );
  const ready = selectBalancedPortfolio({
    companies: eight,
    quotes: quotesFor(eight),
    totalEquityKrw: 100_000_000,
    now
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.selected.length, 3);
  assert.ok(ready.selected.every((item) => item.targetWeight === 0.333333333333));
  assert.equal(ready.investedTargetWeight, 1);
  assert.equal(ready.cashTargetWeight, 0);

  const seven = eight.slice(0, 2);
  const blocked = selectBalancedPortfolio({
    companies: seven,
    quotes: quotesFor(seven),
    totalEquityKrw: 100_000_000,
    now
  });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.blockedReasons.includes("insufficient_eligible_candidates"));
});

test("100만원 계좌는 10개 종목에 10%씩 목표 현금 없이 배분한다", () => {
  const companies = Array.from({ length: 20 }, (_, index) =>
    company(`KR-SMALL-${index}`, { sector: `업종-${index % 5}` })
  );
  const result = selectBalancedPortfolio({
    companies,
    quotes: quotesFor(companies),
    totalEquityKrw: 1_000_000,
    now
  });

  assert.equal(BALANCED_V1_DEFAULTS.minimumPositions, 3);
  assert.equal(result.status, "ready");
  assert.equal(result.deployable, true);
  assert.equal(result.selected.length, 5);
  assert.ok(result.selected.every((item) => item.targetWeight === 0.2));
  assert.equal(result.investedTargetWeight, 1);
  assert.equal(result.cashTargetWeight, 0);
});

test("고가 주식 때문에 10종목이 불가능하면 안전 최소 8종목으로 재배분한다", () => {
  const companies = Array.from({ length: 10 }, (_, index) =>
    company(`KR-HIGH-${index}`, { sector: `업종-${index}` })
  );
  const quotes = Object.fromEntries(
    companies.map((item) => [item.id, { ...quoteFor(item), price: 115_000 }])
  );
  const result = selectBalancedPortfolio({
    companies,
    quotes,
    totalEquityKrw: 1_000_000,
    now
  });

  assert.equal(result.status, "ready");
  assert.equal(result.desiredPositions, 5);
  assert.equal(result.selected.length, 5);
  assert.ok(result.selected.every((item) => item.targetWeight === 0.2));
  assert.equal(result.investedTargetWeight, 1);
  assert.equal(result.cashTargetWeight, 0);
});

test("동점 후보는 고유 ID까지 사용해 항상 같은 결과를 낸다", () => {
  const companies = Array.from({ length: 12 }, (_, index) =>
    company(`KR-TIE-${String(11 - index).padStart(2, "0")}`, {
      sector: `업종-${index % 4}`,
      score: 90
    })
  );
  const options = {
    quotes: quotesFor(companies),
    totalEquityKrw: 100_000_000,
    now
  };
  const first = selectBalancedPortfolio({ companies, ...options });
  const second = selectBalancedPortfolio({ companies: [...companies].reverse(), ...options });
  assert.deepEqual(
    first.selected.map((item) => item.id),
    second.selected.map((item) => item.id)
  );
});

test("기존 보유종목은 신규 후보가 3점 이상 앞설 때만 교체 대상으로 밀린다", () => {
  const incumbent = company("KR-INCUMBENT", { score: 90 });
  const leader = company("KR-LEADER", { score: 95 });
  const marginal = company("KR-MARGINAL", { score: 92 });
  const policy = {
    strategy: {
      minimumPositions: 2,
      maximumPositions: 2,
      minimumPositionKrw: 100_000,
      maximumPositionWeight: 0.4,
      reserveWeight: 0.2,
      maximumSectorWeight: 1,
      replacementScoreLead: 3
    }
  };
  const base = {
    companies: [incumbent, leader, marginal],
    quotes: quotesFor([incumbent, leader, marginal]),
    totalEquityKrw: 1_000_000,
    config: policy,
    now
  };

  const stable = selectBalancedPortfolio({
    ...base,
    incumbents: [incumbent]
  });
  assert.deepEqual(
    stable.selected.map((item) => item.id),
    ["KR-LEADER", "KR-INCUMBENT"]
  );
  assert.equal(stable.selected.find((item) => item.id === incumbent.id).incumbent, true);

  const meaningful = company("KR-MEANINGFUL", { score: 93 });
  const replaced = selectBalancedPortfolio({
    ...base,
    companies: [incumbent, leader, meaningful],
    quotes: quotesFor([incumbent, leader, meaningful]),
    incumbents: [incumbent]
  });
  assert.deepEqual(
    replaced.selected.map((item) => item.id),
    ["KR-LEADER", "KR-MEANINGFUL"]
  );
  assert.ok(Object.values(replaced.sectorWeights).every((weight) => weight <= 1));
});

test("공개 투자선정이 있으면 점수가 더 높은 다른 회사가 있어도 같은 종목만 목표로 삼는다", () => {
  const companies = Array.from({ length: 6 }, (_, index) =>
    company(`KR-PUBLISHED-${index}`, {
      sector: `sector-${index}`,
      score: 99 - index
    })
  );
  const chosen = [companies[1], companies[3], companies[5]];
  const selection = {
    status: "ready",
    strategyVersion: INVESTMENT_SELECTION_STRATEGY_VERSION,
    selected: chosen.map((item, index) => ({
      id: item.id,
      investmentRank: index + 1,
      targetWeight: 0.333333333333
    }))
  };
  const result = selectPublishedPortfolio({
    companies,
    quotes: quotesFor(companies),
    totalEquityKrw: 1_000_000,
    selection,
    config: { strategy: { version: INVESTMENT_SELECTION_STRATEGY_VERSION } },
    now
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(
    result.selected.map((item) => item.id),
    chosen.map((item) => item.id)
  );
  assert.equal(result.cashTargetWeight, 0);
  assert.equal(result.targetWeights[companies[0].id], undefined);
});
