export const SCORING_MODEL_VERSION = "2.0.0";

const MIN_SECTOR_PEERS = 10;
const MIN_COUNTRY_PEERS = 20;
const MAX_MARKET_AGE_DAYS = 10;
const FATAL_VALUATION_ISSUES = new Set([
  "currency_mismatch",
  "financial_period_stale",
  "valuation_date_invalid",
  "security_mapping_required"
]);

const SCORE_GROUPS = [
  {
    key: "valuation",
    label: "저평가",
    weight: 30,
    metrics: [
      { key: "per", weight: 12, direction: "lower", weak: 35, strong: 8, peerAdjusted: true },
      { key: "pbr", weight: 8, direction: "lower", weak: 4, strong: 0.7, peerAdjusted: true },
      { key: "psr", weight: 6, direction: "lower", weak: 6, strong: 0.5, peerAdjusted: true },
      { key: "fcfYield", weight: 4, direction: "higher", weak: 0, strong: 10, peerAdjusted: true }
    ]
  },
  {
    key: "longGrowth",
    label: "장기성장",
    weight: 35,
    metrics: [
      { key: "revenueCagr", weight: 10, direction: "higher", weak: -3, strong: 12 },
      { key: "revenueGrowth", weight: 5, direction: "higher", weak: -5, strong: 15 },
      { key: "operatingIncomeGrowth", weight: 5, direction: "higher", weak: -10, strong: 25 },
      { key: "operatingMarginTrend", weight: 5, direction: "higher", weak: -5, strong: 5 },
      { key: "revenueStability", weight: 5, direction: "higher", weak: 40, strong: 90 },
      { key: "positiveIncomeYears", weight: 5, direction: "higher", weak: 1, strong: 3 }
    ]
  },
  {
    key: "quality",
    label: "기업품질",
    weight: 20,
    metrics: [
      { key: "roe", weight: 7, direction: "higher", weak: 0, strong: 20 },
      { key: "operatingMargin", weight: 5, direction: "higher", weak: 3, strong: 20 },
      { key: "netMargin", weight: 3, direction: "higher", weak: 2, strong: 15 },
      { key: "fcfMargin", weight: 3, direction: "higher", weak: 0, strong: 15 },
      { key: "cashConversion", weight: 2, direction: "higher", weak: 50, strong: 120 }
    ]
  },
  {
    key: "safety",
    label: "재무안전",
    weight: 15,
    metrics: [
      { key: "debtRatio", weight: 9, direction: "lower", weak: 250, strong: 50 },
      { key: "currentRatio", weight: 6, direction: "higher", weak: 80, strong: 180 }
    ]
  }
];

const VALUATION_GROUP = SCORE_GROUPS[0];

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return isNumber(value) && value > 0;
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

function scoreGroup(metrics, group, scoreOverrides = {}) {
  let earned = 0;
  let availableWeight = 0;

  for (const definition of group.metrics) {
    const override = scoreOverrides[definition.key];
    const score = isNumber(override) ? override : metricScore(metrics[definition.key], definition);
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

function recommendationBand(score, evaluationReady) {
  if (!evaluationReady) return { key: "held", label: "가치평가 보류" };
  if (score >= 85) return { key: "s", label: "S 티어" };
  if (score >= 75) return { key: "a", label: "A 티어" };
  if (score >= 65) return { key: "b", label: "B 티어" };
  return { key: "c", label: "C 티어" };
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

function historicalMetrics(history = []) {
  const pointYear = (point) => {
    const match = String(point?.periodEnd || point?.label || "").match(/(?:19|20)\d{2}/);
    return match ? Number(match[0]) : null;
  };
  const chronological = (points) => {
    const withYears = points.map((point) => ({ point, year: pointYear(point) }));
    return withYears.every(({ year }) => Number.isInteger(year))
      ? withYears.sort((left, right) => left.year - right.year).map(({ point }) => point)
      : points;
  };
  const revenuePoints = chronological(history.filter((point) => positive(point?.revenue)));
  const marginPoints = chronological(history.filter(
    (point) => positive(point?.revenue) && isNumber(point?.operatingIncome)
  ));
  const firstRevenueYear = pointYear(revenuePoints[0]);
  const latestRevenueYear = pointYear(revenuePoints.at(-1));
  const revenuePeriods =
    Number.isInteger(firstRevenueYear) &&
    Number.isInteger(latestRevenueYear) &&
    latestRevenueYear > firstRevenueYear
      ? latestRevenueYear - firstRevenueYear
      : revenuePoints.length - 1;
  const revenueCagr =
    revenuePoints.length >= 3 && revenuePeriods >= 2
      ? (Math.pow(
          revenuePoints.at(-1).revenue / revenuePoints[0].revenue,
          1 / revenuePeriods
        ) -
          1) *
        100
      : null;
  const previousRevenue = revenuePoints.at(-2)?.revenue;
  const latestRevenue = revenuePoints.at(-1)?.revenue;
  const previousRevenueYear = pointYear(revenuePoints.at(-2));
  const latestRevenuePointYear = pointYear(revenuePoints.at(-1));
  const consecutiveRevenuePeriods =
    !Number.isInteger(previousRevenueYear) ||
    !Number.isInteger(latestRevenuePointYear) ||
    latestRevenuePointYear - previousRevenueYear === 1;
  const revenueGrowth =
    consecutiveRevenuePeriods && positive(previousRevenue) && positive(latestRevenue)
      ? ((latestRevenue / previousRevenue) - 1) * 100
      : null;
  const previousOperatingIncome = marginPoints.at(-2)?.operatingIncome;
  const latestOperatingIncome = marginPoints.at(-1)?.operatingIncome;
  const previousMarginYear = pointYear(marginPoints.at(-2));
  const latestMarginYear = pointYear(marginPoints.at(-1));
  const consecutiveMarginPeriods =
    !Number.isInteger(previousMarginYear) ||
    !Number.isInteger(latestMarginYear) ||
    latestMarginYear - previousMarginYear === 1;
  const operatingIncomeGrowth =
    consecutiveMarginPeriods && positive(previousOperatingIncome) && isNumber(latestOperatingIncome)
      ? ((latestOperatingIncome / previousOperatingIncome) - 1) * 100
      : null;
  const firstMargin =
    marginPoints.length >= 2
      ? (marginPoints[0].operatingIncome / marginPoints[0].revenue) * 100
      : null;
  const latestMargin =
    marginPoints.length >= 2
      ? (marginPoints.at(-1).operatingIncome / marginPoints.at(-1).revenue) * 100
      : null;
  return {
    revenueCagr: isNumber(revenueCagr) ? revenueCagr : null,
    hasRevenueComparison: revenuePoints.length >= 2,
    hasOperatingIncomeComparison: marginPoints.length >= 2,
    revenueGrowth: isNumber(revenueGrowth) ? revenueGrowth : null,
    operatingIncomeGrowth: isNumber(operatingIncomeGrowth) ? operatingIncomeGrowth : null,
    operatingMarginTrend:
      isNumber(firstMargin) && isNumber(latestMargin) ? latestMargin - firstMargin : null
  };
}

function annualFinancialMetrics(company) {
  const latest = company.financials?.latest;
  if (!latest || !latest.periodEnd) return null;
  const ratio = (numerator, denominator) =>
    isNumber(numerator) && positive(denominator) ? (numerator / denominator) * 100 : null;
  return {
    roe: ratio(latest.netIncome, latest.equity),
    operatingMargin: ratio(latest.operatingIncome, latest.revenue),
    netMargin: ratio(latest.netIncome, latest.revenue),
    debtRatio: ratio(latest.liabilities, latest.equity),
    currentRatio: ratio(latest.currentAssets, latest.currentLiabilities),
    fcfMargin: ratio(latest.freeCashFlow, latest.revenue),
    cashConversion:
      isNumber(latest.operatingCashFlow) && positive(latest.netIncome)
        ? (latest.operatingCashFlow / latest.netIncome) * 100
        : null
  };
}

function marketDateIsCurrent(asOf, now) {
  const text = String(asOf || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const priceDate = new Date(text + "T00:00:00.000Z");
  if (Number.isNaN(priceDate.getTime()) || priceDate.toISOString().slice(0, 10) !== text)
    return false;
  const ageDays = Math.floor((now.getTime() - priceDate.getTime()) / 86_400_000);
  return ageDays >= 0 && ageDays <= MAX_MARKET_AGE_DAYS;
}

function modelIsNotApplicable(company) {
  const applicability = company.modelApplicability;
  if (applicability === false) return true;
  const status =
    applicability && typeof applicability === "object"
      ? applicability.status
      : applicability;
  return String(status || "").toLowerCase() === "not_applicable";
}

function valuationState(company, now = new Date()) {
  const marketData = company.marketData || {};
  const valuation = marketData.valuation || {};
  const issues = Array.isArray(valuation.issues) ? valuation.issues : [];
  const fatalIssues = issues.filter((issue) => FATAL_VALUATION_ISSUES.has(issue));
  const current =
    ["ok", "preserved"].includes(marketData.status) &&
    marketData.freshness === "current" &&
    marketDateIsCurrent(marketData.asOf, now) &&
    !company.stale &&
    fatalIssues.length === 0;

  return {
    current,
    issues,
    fatalIssues,
    values: {
      per: current && positive(valuation.per) ? valuation.per : null,
      pbr: current && positive(valuation.pbr) ? valuation.pbr : null,
      psr: current && positive(valuation.psr) ? valuation.psr : null,
      fcfYield: current && isNumber(valuation.fcfYield) ? valuation.fcfYield : null
    }
  };
}

function peerKey(company) {
  return String(company.country || "UNKNOWN") + "\u0000" + String(company.sector || "미분류");
}

function addPeerValue(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

export function buildScoringContext(companies, now = new Date()) {
  const peers = Object.fromEntries(
    VALUATION_GROUP.metrics.map((definition) => [
      definition.key,
      { country: new Map(), sector: new Map() }
    ])
  );

  for (const company of companies) {
    if (company.dataMode !== "live") continue;
    const state = valuationState(company, now);
    if (!state.current) continue;
    for (const definition of VALUATION_GROUP.metrics) {
      const value = state.values[definition.key];
      if (!isNumber(value) || (definition.key !== "fcfYield" && value <= 0)) continue;
      addPeerValue(peers[definition.key].country, String(company.country || "UNKNOWN"), value);
      addPeerValue(peers[definition.key].sector, peerKey(company), value);
    }
  }

  for (const metricPeers of Object.values(peers)) {
    for (const groups of [metricPeers.country, metricPeers.sector]) {
      for (const values of groups.values()) values.sort((left, right) => left - right);
    }
  }
  return { peers };
}

function lowerBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function peerAdjustment(company, definition, value, context) {
  const metricPeers = context?.peers?.[definition.key];
  if (!metricPeers) return null;
  const sectorValues = metricPeers.sector.get(peerKey(company)) || [];
  const countryValues = metricPeers.country.get(String(company.country || "UNKNOWN")) || [];
  const values =
    sectorValues.length >= MIN_SECTOR_PEERS
      ? sectorValues
      : countryValues.length >= MIN_COUNTRY_PEERS
        ? countryValues
        : null;
  if (!values) return null;

  const first = lowerBound(values, value);
  const after = upperBound(values, value);
  const percentile = (first + after) / (2 * values.length);
  const peerScore = clamp(
    definition.direction === "lower" ? (1 - percentile) * 100 : percentile * 100,
    5,
    95
  );
  return {
    score: peerScore,
    percentile,
    sampleSize: values.length,
    scope: values === sectorValues ? "sector" : "country"
  };
}

function valuationScores(company, metrics, context) {
  const overrides = {};
  const peer = {};
  for (const definition of VALUATION_GROUP.metrics) {
    const value = metrics[definition.key];
    const absolute = metricScore(value, definition);
    if (absolute === null) continue;
    const adjustment = peerAdjustment(company, definition, value, context);
    overrides[definition.key] = adjustment
      ? Math.round((absolute + adjustment.score) / 2)
      : absolute;
    if (adjustment) peer[definition.key] = adjustment;
  }
  return { overrides, peer };
}

function valueTrapSignals(metrics) {
  const signals = [];
  if (isNumber(metrics.netMargin) && metrics.netMargin <= 0) signals.push("순이익 적자");
  if (isNumber(metrics.operatingMargin) && metrics.operatingMargin <= 0)
    signals.push("영업이익 적자");
  if (
    isNumber(metrics.netMargin) &&
    isNumber(metrics.operatingMargin) &&
    metrics.operatingMargin > 0 &&
    metrics.netMargin > metrics.operatingMargin * 2 &&
    metrics.netMargin - metrics.operatingMargin >= 3
  )
    signals.push("영업이익 대비 과도한 순이익");
  if (isNumber(metrics.positiveIncomeYears) && metrics.positiveIncomeYears < 2)
    signals.push("최근 흑자 지속성 부족");
  if (
    (isNumber(metrics.revenueCagr) && metrics.revenueCagr < 0 &&
      isNumber(metrics.revenueGrowth) && metrics.revenueGrowth < 0) ||
    (isNumber(metrics.revenueGrowth) && metrics.revenueGrowth < 0 &&
      isNumber(metrics.operatingIncomeGrowth) && metrics.operatingIncomeGrowth < 0)
  )
    signals.push("매출·이익 감소 추세");
  if (isNumber(metrics.fcfMargin) && metrics.fcfMargin < 0) signals.push("잉여현금흐름 적자");
  if (isNumber(metrics.debtRatio) && metrics.debtRatio > 250) signals.push("과도한 부채");
  if (isNumber(metrics.currentRatio) && metrics.currentRatio < 80) signals.push("낮은 단기 지급여력");
  return signals;
}

function buildReasons(metrics, components, peer, total, evaluationReady) {
  if (!evaluationReady) {
    return ["검증된 최신 시세와 가치지표가 부족해 저평가 순위 판단을 보류합니다."];
  }

  const valuationReasons = [];
  const growthReasons = [];
  const supportingReasons = [];
  const perPeer = peer.per;
  const pbrPeer = peer.pbr;
  if (perPeer && perPeer.percentile <= 0.5)
    valuationReasons.push({
      strength: 35 - perPeer.percentile * 20,
      text:
        perPeer.scope === "sector"
          ? "PER이 같은 국가·업종 비교군에서 낮은 편입니다."
          : "PER이 같은 국가 비교군에서 낮은 편입니다."
    });
  if (pbrPeer && pbrPeer.percentile <= 0.5)
    valuationReasons.push({
      strength: 32 - pbrPeer.percentile * 20,
      text:
        pbrPeer.scope === "sector"
          ? "PBR이 같은 국가·업종 비교군에서 낮은 편입니다."
          : "PBR이 같은 국가 비교군에서 낮은 편입니다."
    });
  if (!perPeer && positive(metrics.per) && metrics.per <= 15)
    valuationReasons.push({ strength: 28, text: "절대 PER 구간상 이익 대비 가격 부담이 낮습니다." });
  if (!pbrPeer && positive(metrics.pbr) && metrics.pbr <= 1.2)
    valuationReasons.push({ strength: 26, text: "절대 PBR 구간상 장부가치 대비 가격 부담이 낮습니다." });
  if (valuationReasons.length === 0 && components.valuation.score >= 60)
    valuationReasons.push({ strength: components.valuation.score / 3, text: "검증된 가격배수의 절대·비교군 점수가 저평가 기준을 통과했습니다." });
  if (metrics.revenueCagr >= 8)
    growthReasons.push({ strength: metrics.revenueCagr + 20, text: "확인 가능한 연차 매출이 장기 성장 흐름을 보입니다." });
  if (metrics.operatingMarginTrend >= 2)
    growthReasons.push({ strength: metrics.operatingMarginTrend + 20, text: "연차 영업이익률이 개선돼 성장의 질이 좋아지고 있습니다." });
  if (metrics.revenueGrowth >= 10)
    growthReasons.push({ strength: metrics.revenueGrowth / 2 + 16, text: "최근 매출 성장도 장기 추세를 뒷받침합니다." });
  if (
    growthReasons.length === 0 &&
    metrics.positiveIncomeYears >= 3 &&
    metrics.revenueStability >= 80
  )
    growthReasons.push({ strength: 20, text: "최근 연차의 흑자 지속성과 매출 안정성이 확인됩니다." });
  if (metrics.roe >= 15)
    supportingReasons.push({ strength: metrics.roe, text: "자기자본이익률이 양호해 자본 효율성이 돋보입니다." });
  if (isNumber(metrics.debtRatio) && metrics.debtRatio <= 70)
    supportingReasons.push({ strength: 21, text: "부채 부담이 비교적 낮아 장기 성장의 재무 완충력이 있습니다." });

  const strongest = (items) => [...items].sort((left, right) => right.strength - left.strength)[0];
  const selected = [strongest(valuationReasons), strongest(growthReasons)].filter(Boolean);
  const remaining = [...valuationReasons, ...growthReasons, ...supportingReasons]
    .filter((item) => !selected.includes(item))
    .sort((left, right) => right.strength - left.strength);
  while (selected.length < 2 && remaining.length > 0) selected.push(remaining.shift());
  if (selected.length === 0) {
    selected.push({
      strength: total,
      text: "현재 수치만으로 저평가와 장기 성장을 함께 확인하기 어려워 추가 관찰이 필요합니다."
    });
  }

  return selected.slice(0, 2).map((item) => item.text);
}

function buildRisks(metrics, company, valuation, trapSignals) {
  const risks = [];
  if (!valuation.current) risks.push("검증된 최신 시세가 없어 현재 가격의 저평가 여부를 판단할 수 없습니다.");
  else if (![metrics.per, metrics.pbr, metrics.psr].filter(positive).length)
    risks.push("PER·PBR·PSR을 계산할 재무·시세 조합이 부족합니다.");
  if (metrics.per > 35) risks.push("PER이 높아 현재 이익 대비 가격 부담이 큽니다.");
  if (metrics.pbr > 4) risks.push("PBR이 높아 장부가치 대비 가격 부담을 확인해야 합니다.");
  for (const signal of trapSignals) risks.push("가치함정 주의: " + signal + " 신호가 있습니다.");
  if (metrics.amendmentCount >= 2) risks.push("최근 정정 공시가 반복되어 원문과 변경 내용을 함께 확인해야 합니다.");
  if (company.dataMode === "demo") risks.push("현재 화면은 UI 예시 수치이며 공식 공시 동기화 전입니다.");
  if (company.dataMode === "insufficient_data")
    risks.push("공식 공시는 확인했지만 일반회사 점수에 필요한 재무지표가 부족합니다.");
  if (company.dataMode === "not_applicable")
    risks.push("이 기업 유형에는 현재 일반 비금융회사 점수 모델을 적용하지 않습니다.");
  return [...new Set(risks)].slice(0, 3);
}

export function scoreCompany(company, now = new Date(), context = null) {
  const latestDisclosureDate =
    company.latestDisclosure?.date || company.disclosures?.[0]?.date || null;
  const amendmentCount = (company.disclosures || []).filter((filing) =>
    /\/A$|정정|amend/i.test(filing.form || filing.title || "")
  ).length;
  const historyMetrics = historicalMetrics(company.history);
  const annualMetrics = annualFinancialMetrics(company);
  const valuation = valuationState(company, now);
  const metrics = {
    ...company.metrics,
    ...(annualMetrics || {}),
    revenueCagr: historyMetrics.revenueCagr,
    revenueGrowth: historyMetrics.hasRevenueComparison
      ? historyMetrics.revenueGrowth
      : company.metrics?.revenueGrowth ?? null,
    operatingIncomeGrowth:
      historyMetrics.hasOperatingIncomeComparison
        ? historyMetrics.operatingIncomeGrowth
        : company.metrics?.operatingIncomeGrowth ?? null,
    operatingMarginTrend: historyMetrics.operatingMarginTrend,
    ...valuation.values,
    disclosureRecencyDays:
      company.metrics?.disclosureRecencyDays ?? daysSince(latestDisclosureDate, now),
    amendmentCount: company.metrics?.amendmentCount ?? amendmentCount
  };
  const valueScoring = valuationScores(company, metrics, context);

  const components = {};
  let weightedScore = 0;
  let availableWeight = 0;
  for (const group of SCORE_GROUPS) {
    const result = scoreGroup(
      metrics,
      group,
      group.key === "valuation" ? valueScoring.overrides : undefined
    );
    components[group.key] = {
      label: group.label,
      score: result.score,
      weight: group.weight,
      confidence: Math.round(result.confidence * 100)
    };
    weightedScore += result.score * group.weight;
    availableWeight += result.availableWeight;
  }

  const total = Math.round(weightedScore / 100);
  const completeness = availableWeight / 100;
  const dataConfidence = calculateDataConfidence(company, metrics, Math.round(completeness * 100));
  const criticalFlags = (company.riskFlags || []).filter((flag) => flag.level === "critical");
  const valuationConfidence = components.valuation.confidence;
  const hasEarningsValue = positive(metrics.per) || positive(metrics.fcfYield);
  const modelExcluded = modelIsNotApplicable(company);
  const evaluationReady =
    company.dataMode === "live" &&
    !modelExcluded &&
    valuation.current &&
    valuationConfidence >= 60 &&
    hasEarningsValue;
  const trapSignals = valueTrapSignals(metrics);
  const eligibilityReasons = [];

  if (company.dataMode === "demo") eligibilityReasons.push("공식 공시 동기화 필요");
  else if (company.dataMode === "insufficient_data") eligibilityReasons.push("필수 공시 재무지표 부족");
  else if (company.dataMode === "not_applicable") eligibilityReasons.push("일반회사 점수 모델 적용 대상 아님");
  else if (company.dataMode !== "live") eligibilityReasons.push("공식 공시 상태 확인 필요");
  if (modelExcluded && !eligibilityReasons.includes("일반회사 점수 모델 적용 대상 아님"))
    eligibilityReasons.push("일반회사 점수 모델 적용 대상 아님");
  if (company.stale) eligibilityReasons.push("최근 동기화 실패");
  if (!valuation.current || valuationConfidence < 60 || !hasEarningsValue)
    eligibilityReasons.push("검증된 가치평가 시세 부족");
  if (valuation.fatalIssues.length > 0) eligibilityReasons.push("가치지표 검증 오류");
  if (dataConfidence < 80) eligibilityReasons.push("데이터 신뢰도 80 미만");
  if (completeness < 0.8) eligibilityReasons.push("유효 지표 80% 미만");
  if ((company.history || []).length < 3) eligibilityReasons.push("연차 이력 3개 미만");
  if (criticalFlags.length > 0) eligibilityReasons.push("중대 위험 플래그 존재");
  if (components.valuation.score < 60) eligibilityReasons.push("저평가 점수 60 미만");
  if (components.longGrowth.score < 55) eligibilityReasons.push("장기성장 점수 55 미만");
  if (components.quality.score < 55) eligibilityReasons.push("기업품질 점수 55 미만");
  if (components.safety.score < 45) eligibilityReasons.push("재무안전 점수 45 미만");
  if (isNumber(metrics.roe) && metrics.roe < 5) eligibilityReasons.push("연간 ROE 5 미만");
  if (isNumber(metrics.revenueStability) && metrics.revenueStability < 40)
    eligibilityReasons.push("장기 매출 안정성 40 미만");
  if (trapSignals.length > 0) eligibilityReasons.push("가치함정 위험 신호");
  if (total < 75) eligibilityReasons.push("가치·장기 점수 75 미만");
  const eligible = eligibilityReasons.length === 0;

  const statusReasons =
    company.dataMode === "not_applicable" || modelExcluded
      ? ["현재 일반회사 모델 대신 업종·기업유형별 평가기준이 필요해 가치평가를 보류합니다."]
      : company.dataMode === "insufficient_data"
        ? ["공식 공시는 확인했지만 비교에 필요한 재무지표가 부족해 가치평가를 보류합니다."]
        : null;

  return {
    ...company,
    metrics,
    score: {
      modelVersion: SCORING_MODEL_VERSION,
      total,
      completeness: Math.round(completeness * 100),
      dataConfidence,
      evaluationReady,
      valuationConfidence,
      valuationPeer: valueScoring.peer,
      components,
      band: recommendationBand(total, evaluationReady),
      candidate: {
        eligible,
        label: eligible ? "가치·장기 검토 후보" : evaluationReady ? "관찰 대상" : "가치평가 보류",
        reasons: [...new Set(eligibilityReasons)]
      }
    },
    reasons: statusReasons || buildReasons(metrics, components, valueScoring.peer, total, evaluationReady),
    risks: buildRisks(metrics, company, valuation, trapSignals)
  };
}

function rankingPriority(company) {
  const status = String(company.analysisStatus || company.dataMode || "").toLowerCase();
  if (modelIsNotApplicable(company) || status === "not_applicable") return 4;
  if (
    company.dataMode === "demo" ||
    status === "insufficient" ||
    status === "insufficient_data"
  )
    return 3;
  if (company.score.candidate.eligible) return 0;
  if (company.score.evaluationReady) return 1;
  return 2;
}

export function scoreAndRank(companies, now = new Date()) {
  const context = buildScoringContext(companies, now);
  return companies
    .map((company) => scoreCompany(company, now, context))
    .sort(
      (left, right) =>
        rankingPriority(left) - rankingPriority(right) ||
        right.score.total - left.score.total ||
        right.score.dataConfidence - left.score.dataConfidence ||
        String(left.id || "").localeCompare(String(right.id || ""))
    )
    .map((company, index) => ({ ...company, rank: index + 1 }));
}

export function getScoringModel() {
  return SCORE_GROUPS.map(({ key, label, weight, metrics }) => ({
    key,
    label,
    weight,
    metrics: metrics.map(
      ({ key: metricKey, weight: metricWeight, direction, weak, strong, peerAdjusted }) => ({
        key: metricKey,
        weight: metricWeight,
        direction,
        weak,
        strong,
        ...(peerAdjusted ? { peerAdjusted: true } : {})
      })
    )
  }));
}
