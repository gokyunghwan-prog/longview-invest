import test from "node:test";
import assert from "node:assert/strict";
import { scoreCompany, scoreAndRank } from "../lib/scoring.mjs";

const now = new Date("2026-07-17T00:00:00.000Z");

function strongCompany(overrides = {}) {
  return {
    id: "US-TEST",
    name: "Test Company",
    ticker: "TEST",
    country: "US",
    dataMode: "live",
    sourceUrl: "https://www.sec.gov/example",
    lineage: { filingId: "0000000000-26-000001" },
    history: [{ label: "2023" }, { label: "2024" }, { label: "2025" }],
    latestDisclosure: { date: "2026-07-01" },
    disclosures: [],
    metrics: {
      roe: 24,
      operatingMargin: 25,
      netMargin: 18,
      revenueGrowth: 18,
      operatingIncomeGrowth: 24,
      debtRatio: 35,
      currentRatio: 210,
      fcfMargin: 18,
      cashConversion: 130,
      positiveIncomeYears: 4,
      revenueStability: 94
    },
    ...overrides
  };
}

test("강한 live 데이터는 높은 점수와 후보 자격을 얻는다", () => {
  const result = scoreCompany(strongCompany(), now);
  assert.ok(result.score.total >= 75);
  assert.ok(result.score.dataConfidence >= 80);
  assert.equal(result.score.candidate.eligible, true);
});

test("DEMO 데이터는 점수와 무관하게 후보에서 제외된다", () => {
  const result = scoreCompany(strongCompany({ dataMode: "demo" }), now);
  assert.equal(result.score.dataConfidence, 0);
  assert.equal(result.score.candidate.eligible, false);
  assert.ok(result.score.candidate.reasons.includes("공식 공시 동기화 필요"));
});

test("공시 지표 부족과 모델 비적용 상태는 이유를 구분해 후보에서 제외한다", () => {
  const insufficient = scoreCompany(
    strongCompany({ dataMode: "insufficient_data" }),
    now
  );
  const notApplicable = scoreCompany(
    strongCompany({ dataMode: "not_applicable" }),
    now
  );

  assert.equal(insufficient.score.candidate.eligible, false);
  assert.ok(insufficient.score.candidate.reasons.includes("필수 공시 재무지표 부족"));
  assert.match(insufficient.reasons[0], /재무지표가 부족/);
  assert.equal(notApplicable.score.candidate.eligible, false);
  assert.ok(
    notApplicable.score.candidate.reasons.includes("일반회사 점수 모델 적용 대상 아님")
  );
  assert.match(notApplicable.reasons[0], /추천 판단을 보류/);
});

test("누락 지표는 완전성을 낮추고 최종점수를 50점으로 수렴시킨다", () => {
  const complete = scoreCompany(strongCompany(), now);
  const incomplete = scoreCompany(
    strongCompany({
      metrics: {
        roe: 24,
        operatingMargin: null,
        netMargin: null,
        revenueGrowth: null,
        operatingIncomeGrowth: null,
        debtRatio: null,
        currentRatio: null,
        fcfMargin: null,
        cashConversion: null,
        positiveIncomeYears: null,
        revenueStability: null
      }
    }),
    now
  );
  assert.ok(incomplete.score.completeness < complete.score.completeness);
  assert.ok(incomplete.score.total < complete.score.total);
  assert.equal(incomplete.score.candidate.eligible, false);
});

test("중대 위험 플래그는 높은 점수라도 후보에서 제외한다", () => {
  const result = scoreCompany(
    strongCompany({
      riskFlags: [{ level: "critical", code: "non_reliance", label: "재무 신뢰 철회" }]
    }),
    now
  );
  assert.ok(result.score.total >= 75);
  assert.equal(result.score.candidate.eligible, false);
  assert.ok(result.score.candidate.reasons.includes("중대 위험 플래그 존재"));
});

test("마지막 정상 스냅샷이 stale이면 신뢰도와 후보 자격이 제한된다", () => {
  const result = scoreCompany(strongCompany({ stale: true }), now);
  assert.ok(result.score.dataConfidence <= 65);
  assert.equal(result.score.candidate.eligible, false);
  assert.ok(result.score.candidate.reasons.includes("최근 동기화 실패"));
});

test("랭킹은 종합점수 내림차순이며 1부터 시작한다", () => {
  const ranked = scoreAndRank([
    strongCompany({ id: "A", ticker: "A" }),
    strongCompany({
      id: "B",
      ticker: "B",
      metrics: {
        roe: -5,
        operatingMargin: -2,
        netMargin: -4,
        revenueGrowth: -20,
        operatingIncomeGrowth: -30,
        debtRatio: 300,
        currentRatio: 50,
        fcfMargin: -10,
        cashConversion: 10,
        positiveIncomeYears: 1,
        revenueStability: 20
      }
    })
  ], now);
  assert.equal(ranked[0].id, "A");
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].rank, 2);
});
