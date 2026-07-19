import test from "node:test";
import assert from "node:assert/strict";
import {
  SCORING_MODEL_VERSION,
  getScoringModel,
  scoreCompany,
  scoreAndRank
} from "../lib/scoring.mjs";

const now = new Date("2026-07-17T00:00:00.000Z");

function currentMarketData(valuation = {}) {
  return {
    status: "ok",
    freshness: "current",
    currency: "KRW",
    asOf: "2026-07-16",
    price: 10_000,
    marketCap: 1_000_000,
    valuation: {
      per: 8,
      pbr: 0.7,
      psr: 0.5,
      fcfYield: 10,
      issues: [],
      ...valuation
    }
  };
}

function strongCompany(overrides = {}) {
  return {
    id: "KR-TEST",
    name: "Test Company",
    ticker: "TEST",
    country: "KR",
    exchange: "KOSPI",
    sector: "정보기술",
    dataMode: "live",
    sourceUrl: "https://opendart.fss.or.kr/example",
    lineage: { filingId: "20260701000001" },
    history: [
      { label: "2023", revenue: 100, operatingIncome: 18 },
      { label: "2024", revenue: 120, operatingIncome: 23 },
      { label: "2025", revenue: 150, operatingIncome: 29 }
    ],
    latestDisclosure: { date: "2026-07-01" },
    disclosures: [],
    marketData: currentMarketData(),
    validation: { score: 100 },
    riskFlags: [],
    stale: false,
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

test("v2 모델은 저평가·장기성장·기업품질·재무안전에 정확한 비중을 둔다", () => {
  assert.equal(SCORING_MODEL_VERSION, "2.0.0");
  assert.deepEqual(
    getScoringModel().map(({ key, weight }) => ({ key, weight })),
    [
      { key: "valuation", weight: 30 },
      { key: "longGrowth", weight: 35 },
      { key: "quality", weight: 20 },
      { key: "safety", weight: 15 }
    ]
  );

  const result = scoreCompany(strongCompany(), now);
  assert.equal(result.score.modelVersion, "2.0.0");
  assert.deepEqual(Object.keys(result.score.components), [
    "valuation",
    "longGrowth",
    "quality",
    "safety"
  ]);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(result.score.components).map(([key, component]) => [key, component.weight])
    ),
    { valuation: 30, longGrowth: 35, quality: 20, safety: 15 }
  );
});

test("현재 가격이 싼 강한 live 데이터는 높은 점수와 가치·장기 후보 자격을 얻는다", () => {
  const result = scoreCompany(strongCompany(), now);
  assert.ok(result.score.total >= 75);
  assert.ok(result.score.dataConfidence >= 80);
  assert.equal(result.score.evaluationReady, true);
  assert.equal(result.score.candidate.eligible, true);
  assert.equal(result.score.candidate.label, "가치·장기 검토 후보");
});

test("성장성과 품질이 같아도 비싼 동종기업은 싼 기업보다 낮게 평가한다", () => {
  const peers = Array.from({ length: 10 }, (_, index) =>
    strongCompany({
      id: "KR-PEER-" + index,
      ticker: "P" + index,
      marketData: currentMarketData({ per: 18, pbr: 1.5, psr: 2, fcfYield: 5 })
    })
  );
  const ranked = scoreAndRank([
    strongCompany({ id: "KR-CHEAP", ticker: "CHEAP" }),
    strongCompany({
      id: "KR-EXPENSIVE",
      ticker: "EXPENSIVE",
      marketData: currentMarketData({ per: 50, pbr: 6, psr: 9, fcfYield: 0 })
    }),
    ...peers
  ], now);
  const cheap = ranked.find((company) => company.id === "KR-CHEAP");
  const expensive = ranked.find((company) => company.id === "KR-EXPENSIVE");

  assert.ok(cheap.score.components.valuation.score > expensive.score.components.valuation.score);
  assert.ok(cheap.score.total > expensive.score.total);
  assert.equal(cheap.score.valuationPeer.per.scope, "sector");
});

test("최신 가치지표가 없으면 점수가 높아도 평가 보류와 후보 제외가 적용된다", () => {
  const result = scoreCompany(strongCompany({ marketData: null }), now);
  assert.equal(result.score.evaluationReady, false);
  assert.equal(result.score.candidate.eligible, false);
  assert.equal(result.score.band.key, "held");
  assert.ok(result.score.candidate.reasons.includes("검증된 가치평가 시세 부족"));
  assert.match(result.reasons[0], /판단을 보류/);
});

test("10일 이내 보존 시세는 허용하고 오래되거나 stale인 시세는 보류한다", () => {
  const preserved = scoreCompany(
    strongCompany({ marketData: { ...currentMarketData(), status: "preserved" } }),
    now
  );
  const old = scoreCompany(
    strongCompany({ marketData: { ...currentMarketData(), asOf: "2026-06-01" } }),
    now
  );
  const stale = scoreCompany(
    strongCompany({ marketData: { ...currentMarketData(), freshness: "stale" } }),
    now
  );

  assert.equal(preserved.score.evaluationReady, true);
  assert.equal(old.score.evaluationReady, false);
  assert.equal(stale.score.evaluationReady, false);
});

test("품질·안전 지표는 최신 분기 metrics보다 같은 기간의 연차 재무를 우선한다", () => {
  const result = scoreCompany(
    strongCompany({
      financials: {
        latest: {
          periodEnd: "2025-12-31",
          revenue: 100,
          operatingIncome: 10,
          netIncome: 8,
          equity: 50,
          liabilities: 25,
          currentAssets: 40,
          currentLiabilities: 20,
          operatingCashFlow: 12,
          freeCashFlow: 5
        }
      }
    }),
    now
  );

  assert.equal(result.metrics.roe, 16);
  assert.equal(result.metrics.operatingMargin, 10);
  assert.equal(result.metrics.netMargin, 8);
  assert.equal(result.metrics.debtRatio, 50);
  assert.equal(result.metrics.currentRatio, 200);
  assert.equal(result.metrics.fcfMargin, 5);
  assert.equal(result.metrics.cashConversion, 150);
  assert.equal(result.metrics.revenueGrowth, 25);
});

test("비연속 연차 이력은 마지막 변화를 1년 성장률로 과장하지 않는다", () => {
  const result = scoreCompany(
    strongCompany({
      history: [
        { label: "2019", revenue: 100, operatingIncome: 10 },
        { label: "2021", revenue: 130, operatingIncome: 13 },
        { label: "2025", revenue: 180, operatingIncome: 20 }
      ]
    }),
    now
  );

  assert.ok(result.metrics.revenueCagr > 0);
  assert.equal(result.metrics.revenueGrowth, null);
  assert.equal(result.metrics.operatingIncomeGrowth, null);
});

test("싼 주식이어도 실적 하락·적자 신호가 있으면 가치함정으로 후보에서 제외한다", () => {
  const result = scoreCompany(
    strongCompany({
      history: [
        { label: "2023", revenue: 150, operatingIncome: 15 },
        { label: "2024", revenue: 120, operatingIncome: 3 },
        { label: "2025", revenue: 90, operatingIncome: -5 }
      ],
      metrics: {
        ...strongCompany().metrics,
        netMargin: -4,
        revenueGrowth: -20,
        operatingIncomeGrowth: -30,
        fcfMargin: -8,
        positiveIncomeYears: 1
      }
    }),
    now
  );

  assert.equal(result.score.evaluationReady, true);
  assert.equal(result.score.candidate.eligible, false);
  assert.ok(result.score.candidate.reasons.includes("가치함정 위험 신호"));
  assert.ok(result.risks.some((risk) => risk.includes("가치함정 주의")));
});

test("영업이익보다 순이익이 과도하게 큰 저PER 기업은 비경상 이익 위험으로 제외한다", () => {
  const result = scoreCompany(
    strongCompany({
      financials: {
        latest: {
          periodEnd: "2025-12-31",
          revenue: 100,
          operatingIncome: 2,
          netIncome: 8,
          equity: 40,
          liabilities: 10,
          currentAssets: 30,
          currentLiabilities: 10,
          operatingCashFlow: null,
          freeCashFlow: null
        }
      }
    }),
    now
  );

  assert.equal(result.score.candidate.eligible, false);
  assert.ok(result.score.candidate.reasons.includes("가치함정 위험 신호"));
  assert.ok(result.risks.some((risk) => risk.includes("과도한 순이익")));
});

test("후보 기업은 종합점수가 더 높은 비후보보다 랭킹에서 앞선다", () => {
  const eligible = strongCompany({
    id: "KR-ELIGIBLE",
    ticker: "ELIGIBLE",
    marketData: currentMarketData({ per: 17, pbr: 1.5, psr: 2, fcfYield: 5 })
  });
  const blocked = strongCompany({
    id: "KR-BLOCKED",
    ticker: "BLOCKED",
    riskFlags: [{ level: "critical", code: "non_reliance", label: "재무 신뢰 철회" }]
  });
  const scoredEligible = scoreCompany(eligible, now);
  const scoredBlocked = scoreCompany(blocked, now);
  assert.equal(scoredEligible.score.candidate.eligible, true);
  assert.equal(scoredBlocked.score.candidate.eligible, false);
  assert.ok(scoredBlocked.score.total > scoredEligible.score.total);

  const ranked = scoreAndRank([blocked, eligible], now);
  assert.equal(ranked[0].id, "KR-ELIGIBLE");
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].rank, 2);
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
  assert.match(notApplicable.reasons[0], /가치평가를 보류/);

  const objectApplicability = scoreCompany(
    strongCompany({ modelApplicability: { status: "not_applicable" } }),
    now
  );
  assert.equal(objectApplicability.score.evaluationReady, false);
  assert.ok(
    objectApplicability.score.candidate.reasons.includes("일반회사 점수 모델 적용 대상 아님")
  );
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
