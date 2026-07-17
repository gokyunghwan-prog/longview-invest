const SCORE_GROUPS = [
  {
    key: "profitability",
    label: "수익성",
    weight: 25,
    metrics: [
      { key: "roe", weight: 10, direction: "higher", weak: 0, strong: 20 },
      {
        key: "operatingMargin",
        weight: 8,
        direction: "higher",
        weak: 3,
        strong: 20
      },
      { key: "netMargin", weight: 7, direction: "higher", weak: 2, strong: 15 }
    ]
  },
  {
    key: "growth",
    label: "성장성",
    weight: 20,
    metrics: [
      {
        key: "revenueGrowth",
        weight: 10,
        direction: "higher",
        weak: -5,
        strong: 15
      },
      {
        key: "operatingIncomeGrowth",
        weight: 10,
        direction: "higher",
        weak: -10,
        strong: 20
      }
    ]
  },
  {
    key: "safety",
    label: "안정성",
    weight: 20,
    metrics: [
      {
        key: "debtRatio",
        weight: 12,
        direction: "lower",
        weak: 250,
        strong: 50
      },
      {
        key: "currentRatio",
        weight: 8,
        direction: "higher",
        weak: 80,
        strong: 180
      }
    ]
  },
  {
    key: "cashflow",
    label: "현금흐름",
    weight: 20,
    metrics: [
      {
        key: "fcfMargin",
        weight: 12,
        direction: "higher",
        weak: 0,
        strong: 15
      },
      {
        key: "cashConversion",
        weight: 8,
        direction: "higher",
        weak: 50,
        strong: 120
      }
    ]
  },
  {
    key: "consistency",
    label: "지속성",
    weight: 10,
    metrics: [
      {
        key: "positiveIncomeYears",
        weight: 6,
        direction: "higher",
        weak: 1,
        strong: 3
      },
      {
        key: "revenueStability",
        weight: 4,
        direction: "higher",
        weak: 40,
        strong: 90
      }
    ]
  },
  {
    key: "disclosure",
    label: "공시신뢰",
    weight: 5,
    metrics: [
      {
        key: "disclosureRecencyDays",
        weight: 3,
        direction: "lower",
        weak: 365,
        strong: 30
      },
      {
        key: "amendmentCount",
        weight: 2,
        direction: "lower",
        weak: 3,
        strong: 0
      }
    ]
  }
];

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function metricScore(value, definition) {
  if (!isNumber(value)) return null;
  const range = definition.strong - definition.weak;
  if (range === 0) return 50;

  const normalized =
    definition.direction === "lower"
      ? (definition.weak - value) / (definition.weak - definition.strong)
      : (value - definition.weak) / range;

  return clamp(normalized * 100);
}

function scoreGroup(metrics, group) {
  let earned = 0;
  let availableWeight = 0;

  for (const definition of group.metrics) {
    const score = metricScore(metrics[definition.key], definition);
    if (score === null) continue;
    earned += score * definition.weight;
    availableWeight += definition.weight;
  }

  if (availableWeight === 0) {
    return { score: 50, confidence: 0, availableWeight: 0 };
  }

  const raw = earned / availableWeight;
  const confidence = availableWeight / group.weight;
  return {
    score: Math.round(50 + (raw - 50) * confidence),
    confidence,
    availableWeight
  };
}

function daysSince(dateValue, now = new Date()) {
  if (!dateValue) return null;
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000));
}

function recommendationBand(score) {
  if (score >= 80) return { key: "high", label: "분석 상위" };
  if (score >= 70) return { key: "positive", label: "양호" };
  if (score >= 60) return { key: "neutral", label: "중립" };
  return { key: "cautious", label: "주의" };
}

function calculateDataConfidence(company, metrics, completeness) {
  if (company.dataMode === "demo") return 0;

  const recency = metrics.disclosureRecencyDays;
  const freshness =
    recency === null
      ? 20
      : clamp(((365 - Math.min(365, recency)) / 335) * 100);
  const validation = Number.isFinite(company.validation?.score)
    ? company.validation.score
    : 50;
  const traceability =
    company.sourceUrl && company.lineage?.filingId
      ? 100
      : company.sourceUrl
        ? 50
        : 0;

  const confidence = Math.round(
    completeness * 0.5 + freshness * 0.2 + validation * 0.2 + traceability * 0.1
  );
  return company.stale ? Math.min(65, confidence) : confidence;
}

function buildReasons(metrics, total) {
  const candidates = [];

  if (metrics.roe >= 15)
    candidates.push({ strength: metrics.roe, text: "자기자본이익률이 양호해 자본 효율성이 돋보입니다." });
  if (metrics.fcfMargin >= 10)
    candidates.push({ strength: metrics.fcfMargin + 8, text: "잉여현금흐름 마진이 탄탄해 이익의 현금 전환력이 좋습니다." });
  if (metrics.revenueGrowth >= 10)
    candidates.push({ strength: metrics.revenueGrowth + 5, text: "최근 연간 매출 성장 흐름이 두 자릿수입니다." });
  if (metrics.debtRatio <= 70)
    candidates.push({ strength: 22, text: "부채 부담이 비교적 낮아 재무 완충력이 있습니다." });
  if (metrics.positiveIncomeYears >= 3)
    candidates.push({ strength: 18, text: "확인 가능한 최근 연도에 순이익 흑자를 꾸준히 유지했습니다." });
  if (metrics.operatingMargin >= 20)
    candidates.push({ strength: metrics.operatingMargin, text: "높은 영업이익률이 사업의 수익 구조를 뒷받침합니다." });

  if (candidates.length === 0) {
    candidates.push({
      strength: total,
      text:
        total >= 60
          ? "여러 재무 항목이 한쪽에 치우치지 않고 균형을 보입니다."
          : "현재 수치만으로 강한 장기 우위를 확인하기 어려워 추가 관찰이 필요합니다."
    });
  }

  return candidates
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 2)
    .map((item) => item.text);
}

function buildRisks(metrics, company) {
  const risks = [];

  if (metrics.debtRatio > 180) risks.push("부채비율이 높아 금리와 경기 변화에 민감할 수 있습니다.");
  if (metrics.currentRatio < 100) risks.push("유동비율이 100% 아래여서 단기 지급여력을 확인해야 합니다.");
  if (metrics.fcfMargin < 0) risks.push("최근 잉여현금흐름이 음수여서 투자지출과 현금 소진 원인을 봐야 합니다.");
  if (metrics.revenueGrowth < 0) risks.push("최근 연간 매출이 감소해 성장 회복 여부를 확인해야 합니다.");
  if (metrics.amendmentCount >= 2) risks.push("최근 정정 공시가 반복되어 원문과 변경 내용을 함께 확인해야 합니다.");
  if (company.dataMode === "demo") risks.push("현재 화면은 UI 예시 수치이며 공식 공시 동기화 전입니다.");
  if (company.dataMode === "insufficient_data")
    risks.push("공식 공시는 확인했지만 일반회사 점수에 필요한 재무지표가 부족합니다.");
  if (company.dataMode === "not_applicable")
    risks.push("이 기업 유형에는 현재 일반 비금융회사 점수 모델을 적용하지 않습니다.");

  return risks.slice(0, 2);
}

export function scoreCompany(company, now = new Date()) {
  const latestDisclosureDate =
    company.latestDisclosure?.date || company.disclosures?.[0]?.date || null;
  const amendmentCount = (company.disclosures || []).filter((filing) =>
    /\/A$|정정|amend/i.test(filing.form || filing.title || "")
  ).length;

  const metrics = {
    ...company.metrics,
    disclosureRecencyDays:
      company.metrics?.disclosureRecencyDays ?? daysSince(latestDisclosureDate, now),
    amendmentCount: company.metrics?.amendmentCount ?? amendmentCount
  };

  const components = {};
  let weightedScore = 0;
  let availableWeight = 0;

  for (const group of SCORE_GROUPS) {
    const result = scoreGroup(metrics, group);
    components[group.key] = {
      label: group.label,
      score: result.score,
      weight: group.weight,
      confidence: Math.round(result.confidence * 100)
    };
    weightedScore += result.score * result.availableWeight;
    availableWeight += result.availableWeight;
  }

  const raw = availableWeight > 0 ? weightedScore / availableWeight : 50;
  const completeness = availableWeight / 100;
  const total = Math.round(50 + (raw - 50) * completeness);
  const dataConfidence = calculateDataConfidence(
    company,
    metrics,
    Math.round(completeness * 100)
  );
  const criticalFlags = (company.riskFlags || []).filter(
    (flag) => flag.level === "critical"
  );
  const eligibilityReasons = [];
  if (company.dataMode === "demo") eligibilityReasons.push("공식 공시 동기화 필요");
  else if (company.dataMode === "insufficient_data")
    eligibilityReasons.push("필수 공시 재무지표 부족");
  else if (company.dataMode === "not_applicable")
    eligibilityReasons.push("일반회사 점수 모델 적용 대상 아님");
  else if (company.dataMode !== "live") eligibilityReasons.push("공식 공시 상태 확인 필요");
  if (company.stale) eligibilityReasons.push("최근 동기화 실패");
  if (dataConfidence < 80) eligibilityReasons.push("데이터 신뢰도 80 미만");
  if (completeness < 0.8) eligibilityReasons.push("유효 지표 80% 미만");
  if ((company.history || []).length < 3) eligibilityReasons.push("연차 이력 3개 미만");
  if (criticalFlags.length > 0) eligibilityReasons.push("중대 위험 플래그 존재");
  if (total < 75) eligibilityReasons.push("분석점수 75 미만");
  const eligible = eligibilityReasons.length === 0;
  const statusReasons =
    company.dataMode === "not_applicable"
      ? ["현재 일반회사 모델 대신 업종·기업유형별 평가기준이 필요해 추천 판단을 보류합니다."]
      : company.dataMode === "insufficient_data"
        ? ["공식 공시는 확인했지만 비교에 필요한 재무지표가 부족해 임시 중립점수로 표시합니다."]
        : null;

  return {
    ...company,
    metrics,
    score: {
      modelVersion: "1.0.0",
      total,
      completeness: Math.round(completeness * 100),
      dataConfidence,
      components,
      band: recommendationBand(total),
      candidate: {
        eligible,
        label: eligible ? "장기 검토 후보" : "관찰 대상",
        reasons: eligibilityReasons
      }
    },
    reasons: company.reasons?.length
      ? company.reasons
      : statusReasons || buildReasons(metrics, total),
    risks: company.risks?.length ? company.risks : buildRisks(metrics, company)
  };
}

export function scoreAndRank(companies, now = new Date()) {
  return companies
    .map((company) => scoreCompany(company, now))
    .sort((a, b) => b.score.total - a.score.total)
    .map((company, index) => ({ ...company, rank: index + 1 }));
}

export function getScoringModel() {
  return SCORE_GROUPS.map(({ key, label, weight, metrics }) => ({
    key,
    label,
    weight,
    metrics: metrics.map(({ key: metricKey, weight: metricWeight, direction, weak, strong }) => ({
      key: metricKey,
      weight: metricWeight,
      direction,
      weak,
      strong
    }))
  }));
}
