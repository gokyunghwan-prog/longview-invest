import { createHash } from "node:crypto";

export const INVESTMENT_SELECTION_SCHEMA_VERSION = 1;
export const INVESTMENT_SELECTION_STRATEGY_VERSION =
  "longview-domestic-capital-aware-v2";

const DAY_MS = 86_400_000;
const FORBIDDEN_PUBLIC_KEY =
  /(?:account|balance|quantity|credential|secret|token|app.?key|api.?key|order(?:id|number|no)|계좌|잔고|수량|주문(?:번호|id)|비밀|인증키)/i;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const DEFAULT_INVESTMENT_SELECTION_POLICY = deepFreeze({
  version: INVESTMENT_SELECTION_STRATEGY_VERSION,
  countries: ["KR"],
  referenceCapitalKrw: 1_000_000,
  minimumPositions: 3,
  preferredPositions: 3,
  maximumPositions: 5,
  targetCashWeight: 0,
  maximumPositionWeight: 0.35,
  maximumSectorWeight: 0.35,
  minimumPositionKrw: 20_000,
  minimumOrderKrw: 5_000,
  minimumScore: 78,
  minimumConfidence: 85,
  minimumCompleteness: 85,
  minimumValuationConfidence: 75,
  minimumMarketCapKrw: 100_000_000_000,
  minimumDailyTurnoverKrw: 500_000_000,
  maximumPriceAgeDays: 10
});

const POLICY_KEYS = Object.keys(DEFAULT_INVESTMENT_SELECTION_POLICY);
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "generatedAt",
  "sourceRevision",
  "sourceUpdatedAt",
  "modelVersion",
  "strategyVersion",
  "policy",
  "policyHash",
  "status",
  "blockedReasons",
  "summary",
  "ranked",
  "selected"
]);
const SUMMARY_KEYS = new Set([
  "evaluated",
  "strictEligible",
  "referenceAffordable",
  "selected",
  "targetCashWeight",
  "referenceInvestedKrw",
  "projectedReferenceCashKrw",
  "projectedReferenceCashWeight",
  "wholeShareResidual"
]);
const ENTRY_KEYS = new Set([
  "id",
  "ticker",
  "name",
  "country",
  "exchange",
  "sector",
  "investmentRank",
  "score",
  "dataConfidence",
  "completeness",
  "valuationConfidence",
  "valuationScore",
  "longGrowthScore",
  "currentPriceKrw",
  "quoteAsOf",
  "eligibleForReferenceCapital",
  "selectionStatus",
  "reasonCodes",
  "targetWeight",
  "referenceAllocationWeight",
  "referenceNotionalKrw"
]);

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value) {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function roundWeight(value) {
  return Math.round(Number(value) * 1_000_000_000_000) / 1_000_000_000_000;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function assertInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} 설정값이 올바르지 않습니다.`);
  }
}

function assertRatio(value, label, { includeZero = true } = {}) {
  if (
    !Number.isFinite(value) ||
    value > 1 ||
    (includeZero ? value < 0 : value <= 0)
  ) {
    throw new RangeError(`${label} 설정값이 올바르지 않습니다.`);
  }
}

export function normalizeInvestmentSelectionPolicy(overrides = {}) {
  const source = { ...DEFAULT_INVESTMENT_SELECTION_POLICY, ...overrides };
  const policy = Object.fromEntries(POLICY_KEYS.map((key) => [key, source[key]]));
  policy.countries = [...new Set((policy.countries || []).map((item) => String(item).toUpperCase()))]
    .filter(Boolean)
    .sort();

  if (!String(policy.version || "").trim()) throw new TypeError("정책 버전이 필요합니다.");
  if (policy.countries.length === 0) throw new RangeError("최소 한 국가가 필요합니다.");
  assertInteger(policy.referenceCapitalKrw, "참조 투자금", 1);
  assertInteger(policy.minimumPositions, "최소 종목 수", 1, 30);
  assertInteger(policy.preferredPositions, "기본 종목 수", policy.minimumPositions, 30);
  assertInteger(policy.maximumPositions, "최대 종목 수", policy.preferredPositions, 30);
  assertInteger(policy.minimumPositionKrw, "최소 포지션", 1);
  assertInteger(policy.minimumOrderKrw, "최소 주문금액", 1);
  assertInteger(policy.minimumMarketCapKrw, "최소 시가총액", 0);
  assertInteger(policy.minimumDailyTurnoverKrw, "최소 거래대금", 0);
  assertInteger(policy.maximumPriceAgeDays, "최대 시세 경과일", 0, 365);
  for (const key of [
    "minimumScore",
    "minimumConfidence",
    "minimumCompleteness",
    "minimumValuationConfidence"
  ]) {
    const value = finite(policy[key]);
    if (value === null || value < 0 || value > 100) {
      throw new RangeError(`${key} 설정값이 올바르지 않습니다.`);
    }
    policy[key] = value;
  }
  assertRatio(policy.targetCashWeight, "목표 현금비중");
  assertRatio(policy.maximumPositionWeight, "종목당 최대비중", { includeZero: false });
  assertRatio(policy.maximumSectorWeight, "업종당 최대비중", { includeZero: false });

  const investableWeight = 1 - policy.targetCashWeight;
  if (policy.minimumPositions * policy.maximumPositionWeight + 1e-12 < investableWeight) {
    throw new RangeError("최소 종목 수와 종목당 최대비중으로 목표 투자비중을 채울 수 없습니다.");
  }
  if (policy.minimumPositionKrw * policy.minimumPositions > policy.referenceCapitalKrw) {
    throw new RangeError("참조 투자금으로 최소 포지션 수를 구성할 수 없습니다.");
  }
  if (policy.minimumOrderKrw > policy.minimumPositionKrw) {
    throw new RangeError("최소 주문금액은 최소 포지션 금액보다 클 수 없습니다.");
  }
  return deepFreeze(policy);
}

export function investmentSelectionPolicyHash(policy = DEFAULT_INVESTMENT_SELECTION_POLICY) {
  const normalized = normalizeInvestmentSelectionPolicy(policy);
  return createHash("sha256")
    .update(JSON.stringify(stableValue(normalized)))
    .digest("hex");
}

function componentScore(company, key) {
  return finite(company?.score?.components?.[key]?.score) ?? -Infinity;
}

function marketAgeDays(asOf, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf || ""))) return null;
  const timestamp = Date.parse(`${asOf}T00:00:00.000Z`);
  const reference = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(timestamp) || !Number.isFinite(reference)) return null;
  return Math.floor((reference - timestamp) / DAY_MS);
}

function marketView(company, now, policy) {
  const market = company?.marketData || {};
  const currency = String(market.currency || "").toUpperCase();
  const price = currency === "KRW" ? positive(market.priceKrw) ?? positive(market.price) : null;
  const marketCap = positive(
    market.marketCapKrw ?? market.securityMarketCap ?? market.marketCap
  );
  const turnover = positive(
    market.averageDailyTurnoverKrw ??
      market.dailyTurnoverKrw ??
      market.averageDailyTurnover ??
      market.dailyTurnover ??
      market.turnover
  );
  const ageDays = marketAgeDays(market.asOf, now);
  const current =
    ["ok", "preserved"].includes(String(market.status || "").toLowerCase()) &&
    market.freshness === "current" &&
    ageDays !== null &&
    ageDays >= 0 &&
    ageDays <= policy.maximumPriceAgeDays;
  return {
    price,
    marketCap,
    turnover,
    currency,
    current,
    asOf: market.asOf || null
  };
}

export function evaluateInvestmentCandidate(
  company,
  {
    now = new Date(),
    policy: policyOverrides = DEFAULT_INVESTMENT_SELECTION_POLICY
  } = {}
) {
  const policy = normalizeInvestmentSelectionPolicy(policyOverrides);
  const reasons = [];
  const add = (code) => {
    if (!reasons.includes(code)) reasons.push(code);
  };
  const country = String(company?.country || "").toUpperCase();
  const score = finite(company?.score?.total) ?? -Infinity;
  const dataConfidence = finite(company?.score?.dataConfidence) ?? -Infinity;
  const completeness = finite(company?.score?.completeness) ?? -Infinity;
  const valuationConfidence = finite(company?.score?.valuationConfidence) ?? -Infinity;
  const market = marketView(company, now, policy);

  if (!policy.countries.includes(country)) add("country_not_enabled");
  if (String(company?.dataMode || "").toLowerCase() !== "live" || company?.stale === true)
    add("data_source_unhealthy");
  if (company?.score?.candidate?.eligible !== true) add("research_candidate_ineligible");
  if (company?.score?.evaluationReady !== true) add("evaluation_not_ready");
  if (score < policy.minimumScore) add("score_below_minimum");
  if (dataConfidence < policy.minimumConfidence) add("confidence_below_minimum");
  if (completeness < policy.minimumCompleteness) add("completeness_below_minimum");
  if (valuationConfidence < policy.minimumValuationConfidence)
    add("valuation_confidence_below_minimum");
  if (!market.price) add("current_price_missing");
  else if (!market.current) add("current_price_stale");
  if (market.currency !== "KRW") add("currency_not_krw");
  if (!market.marketCap) add("market_cap_missing");
  else if (market.marketCap < policy.minimumMarketCapKrw) add("market_cap_below_minimum");
  if (!market.turnover) add("turnover_missing");
  else if (market.turnover < policy.minimumDailyTurnoverKrw)
    add("turnover_below_minimum");

  return {
    company,
    id: String(company?.id || ""),
    country,
    sector: String(company?.sector || "미분류"),
    score,
    dataConfidence,
    completeness,
    valuationConfidence,
    valuationScore: componentScore(company, "valuation"),
    longGrowthScore: componentScore(company, "longGrowth"),
    market,
    eligible: reasons.length === 0,
    reasonCodes: reasons
  };
}

function compareEvaluations(left, right) {
  return (
    Number(right.eligible) - Number(left.eligible) ||
    right.score - left.score ||
    right.dataConfidence - left.dataConfidence ||
    right.completeness - left.completeness ||
    right.valuationScore - left.valuationScore ||
    right.longGrowthScore - left.longGrowthScore ||
    left.id.localeCompare(right.id)
  );
}

export function rankInvestmentCandidates(
  companies,
  {
    now = new Date(),
    policy: policyOverrides = DEFAULT_INVESTMENT_SELECTION_POLICY
  } = {}
) {
  if (!Array.isArray(companies)) throw new TypeError("회사 목록이 필요합니다.");
  const policy = normalizeInvestmentSelectionPolicy(policyOverrides);
  return companies
    .map((company) => evaluateInvestmentCandidate(company, { now, policy }))
    .sort(compareEvaluations);
}

function minimumFeasibleNotional(price, policy) {
  if (!price) return null;
  const minimum = Math.max(policy.minimumPositionKrw, policy.minimumOrderKrw);
  const units = Math.ceil(minimum / price);
  return units * price;
}

function publicEntry(evaluation, investmentRank, policy) {
  const maximumPositionKrw =
    policy.referenceCapitalKrw * policy.maximumPositionWeight;
  const minimumNotional = minimumFeasibleNotional(evaluation.market.price, policy);
  const eligibleForReferenceCapital =
    evaluation.eligible &&
    minimumNotional !== null &&
    minimumNotional <= maximumPositionKrw;
  return {
    id: evaluation.id,
    ticker: String(evaluation.company?.ticker || ""),
    name: String(evaluation.company?.name || evaluation.id),
    country: evaluation.country,
    exchange: String(evaluation.company?.exchange || ""),
    sector: evaluation.sector,
    investmentRank,
    score: evaluation.score,
    dataConfidence: evaluation.dataConfidence,
    completeness: evaluation.completeness,
    valuationConfidence: evaluation.valuationConfidence,
    valuationScore: Number.isFinite(evaluation.valuationScore)
      ? evaluation.valuationScore
      : null,
    longGrowthScore: Number.isFinite(evaluation.longGrowthScore)
      ? evaluation.longGrowthScore
      : null,
    currentPriceKrw: evaluation.market.price,
    quoteAsOf: evaluation.market.asOf,
    eligibleForReferenceCapital,
    selectionStatus: eligibleForReferenceCapital
      ? "reference_affordable"
      : "reference_price_above_position_limit",
    reasonCodes: eligibleForReferenceCapital
      ? []
      : ["reference_price_above_position_limit"],
    targetWeight: null,
    referenceAllocationWeight: null,
    referenceNotionalKrw: null
  };
}

function allocateWholeShares(selected, policy) {
  const targetInvestedKrw = Math.floor(
    policy.referenceCapitalKrw * (1 - policy.targetCashWeight)
  );
  const equalTargetKrw = targetInvestedKrw / selected.length;
  const maximumPositionKrw = Math.floor(
    policy.referenceCapitalKrw * policy.maximumPositionWeight
  );
  const maximumSectorKrw = Math.floor(
    policy.referenceCapitalKrw * policy.maximumSectorWeight
  );
  const allocations = selected.map((entry) => {
    const price = entry.currentPriceKrw;
    const minimumUnits = Math.ceil(
      Math.max(policy.minimumPositionKrw, policy.minimumOrderKrw) / price
    );
    const targetUnits = Math.max(minimumUnits, Math.floor(equalTargetKrw / price));
    const maximumUnits = Math.floor(maximumPositionKrw / price);
    const units = Math.min(targetUnits, maximumUnits);
    return { entry, price, units, notional: units * price };
  });
  let invested = allocations.reduce((sum, item) => sum + item.notional, 0);
  const sectorNotional = new Map();
  for (const item of allocations) {
    sectorNotional.set(
      item.entry.sector,
      (sectorNotional.get(item.entry.sector) || 0) + item.notional
    );
  }

  while (true) {
    const remaining = targetInvestedKrw - invested;
    const next = allocations
      .filter(
        (item) =>
          item.price <= remaining &&
          item.notional + item.price <= maximumPositionKrw &&
          (sectorNotional.get(item.entry.sector) || 0) + item.price <= maximumSectorKrw
      )
      .sort(
        (left, right) =>
          left.notional / equalTargetKrw - right.notional / equalTargetKrw ||
          left.entry.investmentRank - right.entry.investmentRank ||
          left.entry.id.localeCompare(right.entry.id)
      )[0];
    if (!next) break;
    next.units += 1;
    next.notional += next.price;
    invested += next.price;
    sectorNotional.set(
      next.entry.sector,
      (sectorNotional.get(next.entry.sector) || 0) + next.price
    );
  }

  return {
    invested,
    projectedCash: policy.referenceCapitalKrw - invested,
    allocations: allocations.map(({ entry, notional }) => ({ entry, notional }))
  };
}

function assertKnownKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} 형식이 올바르지 않습니다.`);
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_PUBLIC_KEY.test(key) || !allowed.has(key)) {
      throw new Error(`${label}에 공개할 수 없는 필드가 있습니다.`);
    }
  }
}

function assertNoSensitiveFields(value, label) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveFields(item, label);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PUBLIC_KEY.test(key)) {
      throw new Error(`${label}에 공개할 수 없는 필드가 있습니다.`);
    }
    assertNoSensitiveFields(child, label);
  }
}

export function validatePublicInvestmentSelection(artifact) {
  assertNoSensitiveFields(artifact, "투자선정 산출물");
  assertKnownKeys(artifact, TOP_LEVEL_KEYS, "투자선정 산출물");
  if (artifact.schemaVersion !== INVESTMENT_SELECTION_SCHEMA_VERSION)
    throw new Error("투자선정 schemaVersion이 일치하지 않습니다.");
  for (const key of [
    "generatedAt",
    "sourceRevision",
    "sourceUpdatedAt",
    "modelVersion",
    "strategyVersion",
    "policyHash"
  ]) {
    if (typeof artifact[key] !== "string" || !artifact[key]) {
      throw new Error(`투자선정 ${key} 값이 필요합니다.`);
    }
  }
  if (!Number.isFinite(Date.parse(artifact.generatedAt)))
    throw new Error("투자선정 생성시각이 올바르지 않습니다.");
  if (!Number.isFinite(Date.parse(artifact.sourceUpdatedAt)))
    throw new Error("투자선정 원본시각이 올바르지 않습니다.");
  if (!/^[a-f0-9]{64}$/.test(artifact.policyHash))
    throw new Error("투자선정 정책 해시가 올바르지 않습니다.");
  if (!new Set(["ready", "blocked"]).has(artifact.status))
    throw new Error("투자선정 상태가 올바르지 않습니다.");
  if (!Array.isArray(artifact.blockedReasons))
    throw new Error("투자선정 차단 사유가 올바르지 않습니다.");
  if (!artifact.blockedReasons.every((reason) => typeof reason === "string"))
    throw new Error("투자선정 차단 사유가 올바르지 않습니다.");

  assertKnownKeys(artifact.policy, new Set(POLICY_KEYS), "투자선정 정책");
  const policy = normalizeInvestmentSelectionPolicy(artifact.policy);
  if (artifact.strategyVersion !== policy.version)
    throw new Error("투자선정 전략 버전이 정책과 일치하지 않습니다.");
  if (artifact.policyHash !== investmentSelectionPolicyHash(policy))
    throw new Error("투자선정 정책 해시가 일치하지 않습니다.");
  assertKnownKeys(artifact.summary, SUMMARY_KEYS, "투자선정 요약");
  for (const key of [
    "evaluated",
    "strictEligible",
    "referenceAffordable",
    "selected",
    "referenceInvestedKrw",
    "projectedReferenceCashKrw"
  ]) {
    if (!Number.isSafeInteger(artifact.summary[key]) || artifact.summary[key] < 0)
      throw new Error(`투자선정 요약 ${key} 값이 올바르지 않습니다.`);
  }
  if (!Array.isArray(artifact.ranked) || !Array.isArray(artifact.selected))
    throw new Error("투자선정 기업 목록이 올바르지 않습니다.");
  const rankedIds = new Set();
  const rankedById = new Map();
  for (let index = 0; index < artifact.ranked.length; index += 1) {
    const entry = artifact.ranked[index];
    assertKnownKeys(entry, ENTRY_KEYS, "투자선정 순위 항목");
    if (!entry.id || rankedIds.has(entry.id)) throw new Error("투자선정 순위 ID가 중복되었습니다.");
    if (!Array.isArray(entry.reasonCodes) || !entry.reasonCodes.every((code) => typeof code === "string"))
      throw new Error("투자선정 순위 사유가 올바르지 않습니다.");
    if (entry.investmentRank !== index + 1)
      throw new Error("투자선정 순위가 연속적이지 않습니다.");
    rankedIds.add(entry.id);
    rankedById.set(entry.id, entry);
  }
  const selectedIds = new Set();
  for (const entry of artifact.selected) {
    assertKnownKeys(entry, ENTRY_KEYS, "투자선정 선택 항목");
    if (!rankedIds.has(entry.id) || selectedIds.has(entry.id))
      throw new Error("투자선정 선택 ID가 올바르지 않습니다.");
    if (!Array.isArray(entry.reasonCodes) || !entry.reasonCodes.every((code) => typeof code === "string"))
      throw new Error("투자선정 선택 사유가 올바르지 않습니다.");
    if (entry.selectionStatus !== "selected" || entry.eligibleForReferenceCapital !== true)
      throw new Error("투자선정 선택 상태가 올바르지 않습니다.");
    if (
      JSON.stringify(stableValue(entry)) !==
      JSON.stringify(stableValue(rankedById.get(entry.id)))
    ) {
      throw new Error("투자선정 선택 항목이 공통 순위와 일치하지 않습니다.");
    }
    selectedIds.add(entry.id);
  }
  if (artifact.summary.selected !== artifact.selected.length)
    throw new Error("투자선정 요약 종목 수가 일치하지 않습니다.");
  if (
    artifact.status === "ready" &&
    (artifact.selected.length < policy.minimumPositions ||
      artifact.selected.length > policy.maximumPositions)
  ) {
    throw new Error("투자선정 종목 수가 정책 범위를 벗어났습니다.");
  }
  if (artifact.status === "blocked" && artifact.selected.length !== 0)
    throw new Error("차단된 투자선정에는 선택 종목이 없어야 합니다.");
  if (artifact.summary.strictEligible !== artifact.ranked.length)
    throw new Error("투자선정 적격 종목 수가 일치하지 않습니다.");
  if (
    artifact.summary.referenceAffordable !==
    artifact.ranked.filter((entry) => entry.eligibleForReferenceCapital === true).length
  ) {
    throw new Error("투자선정 참조자금 가능 종목 수가 일치하지 않습니다.");
  }
  if (artifact.summary.evaluated < artifact.summary.strictEligible)
    throw new Error("투자선정 평가 종목 수가 올바르지 않습니다.");
  if (artifact.summary.targetCashWeight !== policy.targetCashWeight)
    throw new Error("투자선정 목표 현금비중이 정책과 일치하지 않습니다.");
  if (
    artifact.summary.referenceInvestedKrw +
      artifact.summary.projectedReferenceCashKrw !==
    policy.referenceCapitalKrw
  ) {
    throw new Error("투자선정 참조 투자금 합계가 일치하지 않습니다.");
  }
  const expectedCashWeight = roundWeight(
    artifact.summary.projectedReferenceCashKrw / policy.referenceCapitalKrw
  );
  if (artifact.summary.projectedReferenceCashWeight !== expectedCashWeight)
    throw new Error("투자선정 참조 현금비중이 일치하지 않습니다.");
  const intendedCashKrw = Math.floor(policy.referenceCapitalKrw * policy.targetCashWeight);
  if (artifact.summary.wholeShareResidual !== (artifact.summary.projectedReferenceCashKrw > intendedCashKrw))
    throw new Error("투자선정 정수주식 잔액 표시가 일치하지 않습니다.");

  if (artifact.status === "ready") {
    let targetWeight = 0;
    let referenceInvestedKrw = 0;
    const targetSectorWeights = new Map();
    const referenceSectorKrw = new Map();
    for (const entry of artifact.selected) {
      if (
        !Number.isFinite(entry.targetWeight) ||
        entry.targetWeight <= 0 ||
        entry.targetWeight > policy.maximumPositionWeight + 1e-12
      ) {
        throw new Error("투자선정 목표비중이 종목 한도를 벗어났습니다.");
      }
      if (
        !Number.isSafeInteger(entry.currentPriceKrw) ||
        entry.currentPriceKrw <= 0 ||
        !Number.isSafeInteger(entry.referenceNotionalKrw) ||
        entry.referenceNotionalKrw < policy.minimumPositionKrw ||
        entry.referenceNotionalKrw < policy.minimumOrderKrw ||
        entry.referenceNotionalKrw % entry.currentPriceKrw !== 0 ||
        entry.referenceNotionalKrw >
          Math.floor(policy.referenceCapitalKrw * policy.maximumPositionWeight)
      ) {
        throw new Error("투자선정 참조 주식단위 금액이 올바르지 않습니다.");
      }
      const expectedReferenceWeight = roundWeight(
        entry.referenceNotionalKrw / policy.referenceCapitalKrw
      );
      if (entry.referenceAllocationWeight !== expectedReferenceWeight)
        throw new Error("투자선정 참조 배분비중이 일치하지 않습니다.");
      targetWeight += entry.targetWeight;
      referenceInvestedKrw += entry.referenceNotionalKrw;
      targetSectorWeights.set(
        entry.sector,
        (targetSectorWeights.get(entry.sector) || 0) + entry.targetWeight
      );
      referenceSectorKrw.set(
        entry.sector,
        (referenceSectorKrw.get(entry.sector) || 0) + entry.referenceNotionalKrw
      );
    }
    if (Math.abs(targetWeight - (1 - policy.targetCashWeight)) > 1e-9)
      throw new Error("투자선정 목표비중 합계가 일치하지 않습니다.");
    if (referenceInvestedKrw !== artifact.summary.referenceInvestedKrw)
      throw new Error("투자선정 참조 투자금이 선택 항목과 일치하지 않습니다.");
    if ([...targetSectorWeights.values()].some((weight) => weight > policy.maximumSectorWeight + 1e-12))
      throw new Error("투자선정 목표 업종비중이 한도를 벗어났습니다.");
    const maximumSectorKrw = Math.floor(
      policy.referenceCapitalKrw * policy.maximumSectorWeight
    );
    if ([...referenceSectorKrw.values()].some((value) => value > maximumSectorKrw))
      throw new Error("투자선정 참조 업종금액이 한도를 벗어났습니다.");
  }
  return artifact;
}

export function buildInvestmentSelection({
  companies = [],
  sourceRevision,
  sourceUpdatedAt,
  modelVersion,
  generatedAt = new Date(),
  policy: policyOverrides = {}
} = {}) {
  if (!Array.isArray(companies)) throw new TypeError("회사 목록이 필요합니다.");
  const policy = normalizeInvestmentSelectionPolicy(policyOverrides);
  const now = generatedAt instanceof Date ? new Date(generatedAt) : new Date(generatedAt);
  if (Number.isNaN(now.getTime())) throw new RangeError("생성시각이 올바르지 않습니다.");
  if (!String(sourceRevision || "")) throw new TypeError("원본 revision이 필요합니다.");
  if (!Number.isFinite(Date.parse(sourceUpdatedAt))) throw new TypeError("원본 갱신시각이 필요합니다.");
  if (!String(modelVersion || "")) throw new TypeError("점수 모델 버전이 필요합니다.");

  const evaluations = rankInvestmentCandidates(companies, { now, policy });
  const eligible = evaluations.filter((item) => item.eligible);
  const ranked = eligible.map((item, index) => publicEntry(item, index + 1, policy));
  const affordable = ranked.filter((item) => item.eligibleForReferenceCapital);

  const selected = [];
  const sectors = new Set();
  for (const entry of affordable) {
    if (selected.length >= policy.preferredPositions) break;
    if (sectors.has(entry.sector)) continue;
    selected.push(entry);
    sectors.add(entry.sector);
  }
  const ready = selected.length >= policy.minimumPositions;
  const blockedReasons = ready ? [] : ["insufficient_reference_affordable_candidates"];
  const finalSelected = ready ? selected : [];
  const allocation = ready
    ? allocateWholeShares(finalSelected, policy)
    : { invested: 0, projectedCash: policy.referenceCapitalKrw, allocations: [] };
  const desiredTargetWeight = ready
    ? roundWeight((1 - policy.targetCashWeight) / finalSelected.length)
    : null;
  const allocatedById = new Map(
    allocation.allocations.map((item) => [item.entry.id, item.notional])
  );
  const selectedEntries = finalSelected.map((entry) => {
    const referenceNotionalKrw = allocatedById.get(entry.id) || 0;
    return {
      ...entry,
      selectionStatus: "selected",
      targetWeight: desiredTargetWeight,
      referenceAllocationWeight: roundWeight(
        referenceNotionalKrw / policy.referenceCapitalKrw
      ),
      referenceNotionalKrw
    };
  });
  const selectedIds = new Set(selectedEntries.map((item) => item.id));
  const rankedEntries = ranked.map((entry) =>
    selectedIds.has(entry.id)
      ? selectedEntries.find((selectedEntry) => selectedEntry.id === entry.id)
      : {
          ...entry,
          selectionStatus:
            !ready && entry.eligibleForReferenceCapital
              ? "selection_blocked"
              : entry.eligibleForReferenceCapital
                ? "not_selected_by_rank_or_sector"
                : entry.selectionStatus,
          reasonCodes:
            !ready && entry.eligibleForReferenceCapital
              ? ["insufficient_reference_affordable_candidates"]
              : entry.eligibleForReferenceCapital
                ? ["outside_reference_portfolio"]
                : entry.reasonCodes
        }
  );
  const projectedCashWeight = roundWeight(
    allocation.projectedCash / policy.referenceCapitalKrw
  );
  const artifact = {
    schemaVersion: INVESTMENT_SELECTION_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    sourceRevision: String(sourceRevision),
    sourceUpdatedAt: new Date(sourceUpdatedAt).toISOString(),
    modelVersion: String(modelVersion),
    strategyVersion: policy.version,
    policy,
    policyHash: investmentSelectionPolicyHash(policy),
    status: ready ? "ready" : "blocked",
    blockedReasons,
    summary: {
      evaluated: evaluations.length,
      strictEligible: eligible.length,
      referenceAffordable: affordable.length,
      selected: selectedEntries.length,
      targetCashWeight: policy.targetCashWeight,
      referenceInvestedKrw: allocation.invested,
      projectedReferenceCashKrw: allocation.projectedCash,
      projectedReferenceCashWeight: projectedCashWeight,
      wholeShareResidual:
        allocation.projectedCash >
        Math.floor(policy.referenceCapitalKrw * policy.targetCashWeight)
    },
    ranked: rankedEntries,
    selected: selectedEntries
  };
  return validatePublicInvestmentSelection(artifact);
}
