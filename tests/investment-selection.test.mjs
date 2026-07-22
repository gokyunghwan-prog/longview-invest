import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_INVESTMENT_SELECTION_POLICY,
  buildInvestmentSelection,
  investmentSelectionPolicyHash,
  rankInvestmentCandidates,
  validatePublicInvestmentSelection
} from "../lib/investment-selection.mjs";

const NOW = new Date("2026-07-21T00:00:00.000Z");

function scoredCompany(
  id,
  {
    score = 90,
    price = 10_000,
    sector = `업종-${id}`,
    marketCap = 200_000_000_000,
    turnover = 1_000_000_000,
    confidence = 95,
    completeness = 95,
    valuationConfidence = 90
  } = {}
) {
  return {
    id,
    ticker: id.replace(/^KR-/, ""),
    name: `회사 ${id}`,
    country: "KR",
    exchange: "KOSPI",
    sector,
    dataMode: "live",
    stale: false,
    marketData: {
      status: "ok",
      freshness: "current",
      currency: "KRW",
      asOf: "2026-07-20",
      price,
      marketCap,
      turnover
    },
    score: {
      modelVersion: "2.0.0",
      total: score,
      dataConfidence: confidence,
      completeness,
      valuationConfidence,
      evaluationReady: true,
      candidate: { eligible: true },
      components: {
        valuation: { score: 80 },
        longGrowth: { score: 85 }
      }
    }
  };
}

function build(companies) {
  return buildInvestmentSelection({
    companies,
    sourceRevision: "revision-1",
    sourceUpdatedAt: "2026-07-20T10:00:00.000Z",
    modelVersion: "2.0.0",
    generatedAt: NOW
  });
}

test("공통 투자정책 해시는 속성 입력 순서와 무관하게 결정적이다", () => {
  const first = investmentSelectionPolicyHash({
    minimumScore: 78,
    referenceCapitalKrw: 100_000
  });
  const second = investmentSelectionPolicyHash({
    referenceCapitalKrw: 100_000,
    minimumScore: 78
  });
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("10만원 참조 선정은 엄격한 순위와 정수 주식 가능성을 함께 반영한다", () => {
  const companies = [
    scoredCompany("KR-HIGH", { score: 95, price: 40_000 }),
    scoredCompany("KR-A", { score: 92, price: 8_000 }),
    scoredCompany("KR-B", { score: 90, price: 23_000 }),
    scoredCompany("KR-C", { score: 88, price: 9_000 }),
    scoredCompany("KR-LOWCAP", { score: 99, price: 5_000, marketCap: 10_000_000_000 })
  ];

  const first = build(companies);
  const second = build([...companies].reverse());
  assert.equal(first.status, "ready");
  assert.deepEqual(
    first.selected.map((item) => item.id),
    ["KR-A", "KR-B", "KR-C"]
  );
  assert.deepEqual(
    second.selected.map((item) => item.id),
    first.selected.map((item) => item.id)
  );
  assert.equal(first.summary.selected, 3);
  assert.equal(first.summary.referenceInvestedKrw, 82_000);
  assert.equal(first.summary.projectedReferenceCashKrw, 18_000);
  assert.equal(first.summary.targetCashWeight, 0);
  assert.equal(first.summary.wholeShareResidual, true);
  assert.ok(first.selected.every((item) => item.targetWeight <= 0.35));
  assert.equal(new Set(first.selected.map((item) => item.sector)).size, 3);
  assert.equal(first.ranked.find((item) => item.id === "KR-HIGH").eligibleForReferenceCapital, false);
  assert.equal(first.ranked.some((item) => item.id === "KR-LOWCAP"), false);
});

test("공통 후보 순위는 자동투자 추가 기준 탈락 사유를 결정적으로 남긴다", () => {
  const evaluations = rankInvestmentCandidates(
    [
      scoredCompany("KR-OK", { score: 80 }),
      scoredCompany("KR-ILLIQUID", { score: 95, turnover: 10_000_000 })
    ],
    { now: NOW }
  );
  assert.equal(evaluations[0].id, "KR-OK");
  assert.equal(evaluations[0].eligible, true);
  assert.equal(evaluations[1].id, "KR-ILLIQUID");
  assert.equal(evaluations[1].eligible, false);
  assert.ok(evaluations[1].reasonCodes.includes("turnover_below_minimum"));
});

test("공개 산출물은 계좌·수량·주문번호·키 필드를 거부한다", () => {
  const artifact = build([
    scoredCompany("KR-A", { price: 8_000 }),
    scoredCompany("KR-B", { price: 23_000 }),
    scoredCompany("KR-C", { price: 9_000 })
  ]);
  assert.equal(validatePublicInvestmentSelection(artifact), artifact);
  const serialized = JSON.stringify(artifact);
  for (const forbidden of ["accountNumber", "quantity", "orderId", "appKey", "appSecret"]) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false);
  }

  const tampered = structuredClone(artifact);
  tampered.selected[0].quantity = 3;
  assert.throws(
    () => validatePublicInvestmentSelection(tampered),
    /공개할 수 없는 필드/
  );
});

test("참조자금으로 서로 다른 3개 업종을 만들 수 없으면 fail-closed 한다", () => {
  const artifact = build([
    scoredCompany("KR-A", { price: 8_000, sector: "동일업종" }),
    scoredCompany("KR-B", { price: 9_000, sector: "동일업종" }),
    scoredCompany("KR-C", { price: 10_000, sector: "동일업종" })
  ]);
  assert.equal(artifact.status, "blocked");
  assert.equal(artifact.selected.length, 0);
  assert.deepEqual(artifact.blockedReasons, ["insufficient_reference_affordable_candidates"]);
  assert.deepEqual(artifact.policy, DEFAULT_INVESTMENT_SELECTION_POLICY);
});
