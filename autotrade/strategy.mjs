import { INVESTMENT_SELECTION_STRATEGY_VERSION } from "../lib/investment-selection.mjs";

export const BALANCED_V1_DEFAULTS = Object.freeze({
  minimumScore: 78,
  minimumConfidence: 85,
  minimumCompleteness: 85,
  minimumValuationConfidence: 75,
  minimumPositions: 3,
  maximumPositions: 5,
  reserveWeight: 0,
  maximumPositionWeight: 0.35,
  maximumSectorWeight: 0.35,
  minimumPositionKrw: 20_000,
  minimumMarketCapKrw: 100_000_000_000,
  minimumDailyTurnoverKrw: 500_000_000,
  maximumPriceAgeDays: 10,
  replacementScoreLead: 3
});

const REASON_MESSAGES = Object.freeze({
  longview_candidate_ineligible: "Longview 가치·장기 후보 안전선을 통과하지 못했습니다.",
  evaluation_not_ready: "가치평가가 완료된 기업이 아닙니다.",
  score_below_minimum: "자동투자 신규 편입 점수가 기준보다 낮습니다.",
  confidence_below_minimum: "데이터 신뢰도가 자동투자 기준보다 낮습니다.",
  completeness_below_minimum: "데이터 완전성이 자동투자 기준보다 낮습니다.",
  valuation_confidence_below_minimum: "가치평가 신뢰도가 자동투자 기준보다 낮습니다.",
  data_source_unhealthy: "공시·동기화 데이터 상태가 자동투자에 안전하지 않습니다.",
  current_price_missing: "현재 주문가격을 확인할 수 없습니다.",
  current_price_stale: "시세가 자동주문에 사용하기에는 오래되었습니다.",
  currency_not_krw: "국내주식 시세 통화가 원화가 아닙니다.",
  market_cap_missing: "시가총액을 확인할 수 없습니다.",
  market_cap_below_minimum: "시가총액이 자동투자 유동성 기준보다 작습니다.",
  turnover_missing: "거래대금을 확인할 수 없습니다.",
  turnover_below_minimum: "거래대금이 자동투자 유동성 기준보다 작습니다.",
  country_not_enabled: "자동투자 대상 국가가 아닙니다."
});

const DATA_FAILURE_REASON_CODES = new Set([
  "current_price_missing",
  "current_price_stale",
  "currency_not_krw",
  "market_cap_missing",
  "turnover_missing",
  "data_source_unhealthy"
]);

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value) {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundWeight(value) {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function strategyConfig(config = {}) {
  const source = config?.strategy || config || {};
  const risk = config?.risk || {};
  return {
    ...BALANCED_V1_DEFAULTS,
    ...source,
    maximumPriceAgeDays:
      finite(risk.maximumPriceAgeDays) ??
      finite(source.maximumPriceAgeDays) ??
      BALANCED_V1_DEFAULTS.maximumPriceAgeDays
  };
}

function lookupQuote(quotes, company) {
  if (!quotes) return null;
  const keys = [
    company.id,
    `${String(company.country || "").toUpperCase()}:${company.ticker}`,
    company.ticker
  ].filter(Boolean);
  for (const key of keys) {
    const quote = quotes instanceof Map ? quotes.get(key) : quotes[key];
    if (quote) return quote;
  }
  return null;
}

function ageDays(value, now) {
  if (!value || !now) return null;
  const timestamp = new Date(value).getTime();
  const reference = new Date(now).getTime();
  if (!Number.isFinite(timestamp) || !Number.isFinite(reference)) return null;
  return Math.floor((reference - timestamp) / 86_400_000);
}

function quoteIsCurrent(source, now, maximumPriceAgeDays) {
  if (source.current === false) return false;
  const age = ageDays(source.asOf ?? source.timestamp ?? source.quotedAt, now);
  if (age !== null) return age >= 0 && age <= maximumPriceAgeDays;
  if (source.current === true) return true;
  return (
    source.freshness === "current" &&
    [undefined, null, "", "ok", "preserved"].includes(source.status)
  );
}

function normalizedQuote({ company, quote, now, maximumPriceAgeDays }) {
  const marketData = company.marketData || {};
  const source = { ...marketData, ...(quote || {}) };
  const currencyIsKrw = String(source.currency || "KRW").toUpperCase() === "KRW";
  const price = positive(source.price ?? source.close ?? source.lastPrice);
  const priceKrw = currencyIsKrw ? positive(source.priceKrw) ?? price : null;
  const marketCap = positive(source.marketCapKrw ?? source.marketCap);
  const turnover =
    positive(
      source.averageDailyTurnoverKrw ??
        source.dailyTurnoverKrw ??
        source.averageDailyTurnover ??
        source.dailyTurnover ??
        source.turnover
    ) ?? (price && positive(source.volume) ? price * positive(source.volume) : null);

  return {
    price,
    priceKrw,
    currency: "KRW",
    currencyIsKrw,
    marketCap,
    turnover,
    asOf: source.asOf ?? source.timestamp ?? source.quotedAt ?? null,
    current: Boolean(price) && quoteIsCurrent(source, now, maximumPriceAgeDays),
    source: source.source || source.provider || null
  };
}

function scoreValue(company, key, fallback = null) {
  return finite(company?.score?.[key]) ?? fallback;
}

export function portfolioSecurityKey(source = {}) {
  const country = String(source.country || "").trim().toUpperCase();
  const ticker = String(source.ticker || "").trim().toUpperCase();
  if (country && ticker) return `${country}:${ticker}`;
  return String(source.id || "").trim();
}

function componentScore(company, key) {
  return finite(company?.score?.components?.[key]?.score) ?? -Infinity;
}

export function evaluateCandidate({
  company,
  quote = null,
  quotes = null,
  config = {},
  now = null
} = {}) {
  if (!company || typeof company !== "object") {
    throw new TypeError("company 객체가 필요합니다.");
  }
  const policy = strategyConfig(config);
  const country = String(company.country || "").toUpperCase();
  const resolvedQuote = normalizedQuote({
    company,
    quote: quote || lookupQuote(quotes, company),
    now,
    maximumPriceAgeDays: policy.maximumPriceAgeDays
  });
  const reasons = [];
  const add = (code) => {
    if (!reasons.includes(code)) reasons.push(code);
  };

  if (country !== "KR") add("country_not_enabled");
  const syncStatus = String(
    company.syncStatus ?? company.sync?.status ?? company.marketData?.syncStatus ?? ""
  ).toLowerCase();
  const sourceDataFailure =
    company.stale === true ||
    String(company.dataMode || "").toLowerCase() !== "live" ||
    Boolean(company.syncError || company.sync?.error) ||
    ["error", "failed", "stale"].includes(syncStatus);
  if (sourceDataFailure) add("data_source_unhealthy");
  if (company.score?.candidate?.eligible !== true) add("longview_candidate_ineligible");
  if (company.score?.evaluationReady !== true) add("evaluation_not_ready");
  if ((scoreValue(company, "total", -Infinity)) < policy.minimumScore)
    add("score_below_minimum");
  if ((scoreValue(company, "dataConfidence", -Infinity)) < policy.minimumConfidence)
    add("confidence_below_minimum");
  if ((scoreValue(company, "completeness", -Infinity)) < policy.minimumCompleteness)
    add("completeness_below_minimum");
  if ((scoreValue(company, "valuationConfidence", -Infinity)) < policy.minimumValuationConfidence)
    add("valuation_confidence_below_minimum");
  if (!resolvedQuote.price) add("current_price_missing");
  else if (!resolvedQuote.current) add("current_price_stale");
  if (!resolvedQuote.currencyIsKrw) add("currency_not_krw");

  if (!resolvedQuote.marketCap) add("market_cap_missing");
  else if (resolvedQuote.marketCap < policy.minimumMarketCapKrw) add("market_cap_below_minimum");
  if (!resolvedQuote.turnover) add("turnover_missing");
  else if (resolvedQuote.turnover < policy.minimumDailyTurnoverKrw) add("turnover_below_minimum");

  const dataFailure =
    sourceDataFailure ||
    reasons.some((code) => DATA_FAILURE_REASON_CODES.has(code));

  return {
    id: String(company.id || `${country}:${company.ticker || ""}`),
    securityKey: portfolioSecurityKey(company),
    company,
    country,
    sector: String(company.sector || "미분류"),
    score: scoreValue(company, "total", -Infinity),
    dataConfidence: scoreValue(company, "dataConfidence", -Infinity),
    completeness: scoreValue(company, "completeness", -Infinity),
    valuationConfidence: scoreValue(company, "valuationConfidence", -Infinity),
    valuationScore: componentScore(company, "valuation"),
    longGrowthScore: componentScore(company, "longGrowth"),
    quote: resolvedQuote,
    dataFailure,
    eligible: reasons.length === 0,
    reasonCodes: reasons,
    reasons: reasons.map((code) => REASON_MESSAGES[code])
  };
}

function compareCandidates(left, right) {
  return (
    (right.selectionScore ?? right.score) - (left.selectionScore ?? left.score) ||
    right.score - left.score ||
    right.dataConfidence - left.dataConfidence ||
    right.completeness - left.completeness ||
    right.valuationScore - left.valuationScore ||
    right.longGrowthScore - left.longGrowthScore ||
    left.id.localeCompare(right.id)
  );
}

function sectorRoundRobin(candidates) {
  const groups = new Map();
  for (const candidate of [...candidates].sort(compareCandidates)) {
    if (!groups.has(candidate.sector)) groups.set(candidate.sector, []);
    groups.get(candidate.sector).push(candidate);
  }
  const sectors = [...groups.keys()].sort((left, right) => {
    const ranked = compareCandidates(groups.get(left)[0], groups.get(right)[0]);
    return ranked || left.localeCompare(right);
  });
  const result = [];
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const sector of sectors) {
      const next = groups.get(sector).shift();
      if (!next) continue;
      remaining = true;
      result.push(next);
    }
  }
  return result;
}

function selectionView(candidate, targetWeight) {
  const company = candidate.company;
  return {
    id: candidate.id,
    securityKey: candidate.securityKey,
    ticker: company.ticker,
    name: company.name,
    country: candidate.country,
    exchange: company.exchange,
    sector: candidate.sector,
    score: candidate.score,
    dataConfidence: candidate.dataConfidence,
    completeness: candidate.completeness,
    valuationConfidence: candidate.valuationConfidence,
    valuationScore: candidate.valuationScore,
    longGrowthScore: candidate.longGrowthScore,
    incumbent: candidate.incumbent === true,
    targetWeight,
    currentPrice: candidate.quote.price,
    currentPriceKrw: candidate.quote.priceKrw,
    currency: candidate.quote.currency,
    quoteAsOf: candidate.quote.asOf
  };
}

export function selectBalancedPortfolio({
  companies = [],
  quotes = null,
  totalEquityKrw,
  config = {},
  now = null,
  incumbents = []
} = {}) {
  const policy = strategyConfig(config);
  const equity = positive(totalEquityKrw);
  if (!equity) throw new RangeError("totalEquityKrw는 0보다 커야 합니다.");
  const incumbentKeys = new Set(
    incumbents
      .map((item) =>
        typeof item === "string" ? item.trim().toUpperCase() : portfolioSecurityKey(item)
      )
      .filter(Boolean)
  );
  const evaluations = companies.map((company) => {
    const evaluation = evaluateCandidate({
      company,
      quotes,
      config,
      now
    });
    const incumbent = incumbentKeys.has(evaluation.securityKey.toUpperCase());
    return {
      ...evaluation,
      incumbent,
      // Eligible incumbents receive a small ranking buffer. A challenger
      // whose actual score reaches that lead wins the tie on the next key.
      selectionScore:
        evaluation.score + (incumbent ? policy.replacementScoreLead : 0)
    };
  });
  const eligible = evaluations.filter((candidate) => candidate.eligible);
  const investableWeight = 1 - policy.reserveWeight;
  const capitalCapacity = Math.floor(
    (equity * investableWeight) / policy.minimumPositionKrw
  );
  const desiredPositions = clamp(
    Math.min(eligible.length, capitalCapacity, policy.maximumPositions),
    policy.minimumPositions,
    policy.maximumPositions
  );
  let targetWeight = 0;
  let targetNotionalKrw = 0;
  let affordable = [];
  let selected = [];
  let sectorCounts = {};

  // Prefer the broadest feasible portfolio. If whole-share prices make that
  // impossible, retry with fewer (but never fewer than the safety minimum)
  // positions and redistribute the zero-reserve budget equally.
  for (
    let positionCount = desiredPositions;
    positionCount >= policy.minimumPositions;
    positionCount -= 1
  ) {
    const proposedWeight = roundWeight(
      Math.min(policy.maximumPositionWeight, investableWeight / positionCount)
    );
    const proposedNotionalKrw = equity * proposedWeight;
    const proposedAffordable = eligible.filter(
      (candidate) =>
        proposedNotionalKrw >= policy.minimumPositionKrw &&
        candidate.quote.priceKrw <= proposedNotionalKrw
    );
    const queue = sectorRoundRobin(proposedAffordable);
    const maximumSectorCount = Math.floor(
      (policy.maximumSectorWeight + 1e-9) / proposedWeight
    );
    const proposedSelected = [];
    const proposedSectorCounts = {};

    while (proposedSelected.length < positionCount && queue.length > 0) {
      const candidate = queue.shift();
      if ((proposedSectorCounts[candidate.sector] || 0) >= maximumSectorCount) continue;
      proposedSelected.push(candidate);
      proposedSectorCounts[candidate.sector] =
        (proposedSectorCounts[candidate.sector] || 0) + 1;
    }

    targetWeight = proposedWeight;
    targetNotionalKrw = proposedNotionalKrw;
    affordable = proposedAffordable;
    selected = proposedSelected;
    sectorCounts = proposedSectorCounts;
    if (selected.length === positionCount) break;
  }

  selected.sort(compareCandidates);
  const ready = selected.length >= policy.minimumPositions;
  const blockedReasons = [];
  if (!ready) {
    if (eligible.length < policy.minimumPositions) blockedReasons.push("insufficient_eligible_candidates");
    else if (targetNotionalKrw < policy.minimumPositionKrw)
      blockedReasons.push("insufficient_capital");
    else blockedReasons.push("insufficient_feasible_positions");
  }
  const selectedViews = selected.map((candidate) => selectionView(candidate, targetWeight));
  const roundedInvestedTargetWeight = roundWeight(
    Math.min(investableWeight, selectedViews.length * targetWeight)
  );
  const investedTargetWeight =
    Math.abs(roundedInvestedTargetWeight - investableWeight) <= 1e-9
      ? investableWeight
      : roundedInvestedTargetWeight;

  return {
    strategy: INVESTMENT_SELECTION_STRATEGY_VERSION,
    status: ready ? "ready" : "blocked",
    deployable: ready,
    blockedReasons,
    totalEquityKrw: equity,
    desiredPositions,
    minimumPositions: policy.minimumPositions,
    maximumPositions: policy.maximumPositions,
    targetPositionWeight: targetWeight,
    investedTargetWeight,
    cashTargetWeight: roundWeight(Math.max(policy.reserveWeight, 1 - investedTargetWeight)),
    selected: selectedViews,
    targetWeights: Object.fromEntries(selectedViews.map((item) => [item.id, item.targetWeight])),
    sectorWeights: Object.fromEntries(
      Object.entries(sectorCounts).map(([sector, count]) => [
        sector,
        roundWeight(count * targetWeight)
      ])
    ),
    evaluations,
    diagnostics: {
      evaluated: evaluations.length,
      eligible: eligible.length,
      affordable: affordable.length,
      selected: selectedViews.length,
      targetNotionalKrw,
      capitalCapacity
    }
  };
}

export function selectPublishedPortfolio({
  companies = [],
  quotes = null,
  totalEquityKrw,
  selection,
  config = {},
  now = null
} = {}) {
  const policy = strategyConfig(config);
  const equity = positive(totalEquityKrw);
  if (!equity) throw new RangeError("totalEquityKrw는 0보다 커야 합니다.");
  const evaluations = companies.map((company) =>
    evaluateCandidate({ company, quotes, config, now })
  );
  const evaluationsById = new Map(evaluations.map((item) => [item.id, item]));
  const published = Array.isArray(selection?.selected) ? selection.selected : [];
  const blockedReasons = [];
  if (!selection || selection.status !== "ready") {
    blockedReasons.push("published_selection_not_ready");
  }
  if (selection?.strategyVersion !== config?.strategy?.version) {
    blockedReasons.push("published_selection_strategy_mismatch");
  }
  if (
    published.length < policy.minimumPositions ||
    published.length > policy.maximumPositions
  ) {
    blockedReasons.push("published_selection_position_count_invalid");
  }

  const selected = [];
  const sectorWeights = {};
  const seen = new Set();
  for (const entry of published) {
    if (!entry?.id || seen.has(entry.id)) {
      blockedReasons.push("published_selection_duplicate_or_missing_id");
      continue;
    }
    seen.add(entry.id);
    const candidate = evaluationsById.get(entry.id);
    if (!candidate) {
      blockedReasons.push(`published_selection_company_missing:${entry.id}`);
      continue;
    }
    if (!candidate.eligible) {
      blockedReasons.push(`published_selection_company_ineligible:${entry.id}`);
      continue;
    }
    const targetWeight = finite(entry.targetWeight);
    if (
      targetWeight === null ||
      targetWeight <= 0 ||
      targetWeight > policy.maximumPositionWeight + 1e-12
    ) {
      blockedReasons.push(`published_selection_weight_invalid:${entry.id}`);
      continue;
    }
    const targetNotionalKrw = equity * targetWeight;
    if (
      targetNotionalKrw < policy.minimumPositionKrw ||
      candidate.quote.priceKrw > targetNotionalKrw
    ) {
      blockedReasons.push(`published_selection_not_affordable:${entry.id}`);
      continue;
    }
    sectorWeights[candidate.sector] = roundWeight(
      (sectorWeights[candidate.sector] || 0) + targetWeight
    );
    selected.push({
      ...selectionView(candidate, targetWeight),
      investmentRank: entry.investmentRank
    });
  }

  const publishedWeight = roundWeight(
    published.reduce((sum, entry) => sum + (finite(entry?.targetWeight) || 0), 0)
  );
  const investableWeight = roundWeight(1 - policy.reserveWeight);
  if (Math.abs(publishedWeight - investableWeight) > 1e-9) {
    blockedReasons.push("published_selection_weight_sum_invalid");
  }
  if (
    Object.values(sectorWeights).some(
      (weight) => weight > policy.maximumSectorWeight + 1e-12
    )
  ) {
    blockedReasons.push("published_selection_sector_limit_exceeded");
  }
  if (selected.length !== published.length) {
    blockedReasons.push("published_selection_not_fully_executable");
  }
  const ready = blockedReasons.length === 0;
  const investedTargetWeight =
    Math.abs(publishedWeight - investableWeight) <= 1e-9
      ? investableWeight
      : publishedWeight;

  return {
    strategy: selection?.strategyVersion || INVESTMENT_SELECTION_STRATEGY_VERSION,
    status: ready ? "ready" : "blocked",
    deployable: ready,
    blockedReasons: [...new Set(blockedReasons)],
    totalEquityKrw: equity,
    desiredPositions: published.length,
    minimumPositions: policy.minimumPositions,
    maximumPositions: policy.maximumPositions,
    targetPositionWeight: published[0]?.targetWeight || 0,
    investedTargetWeight,
    cashTargetWeight: roundWeight(Math.max(policy.reserveWeight, 1 - investedTargetWeight)),
    selected,
    targetWeights: Object.fromEntries(selected.map((item) => [item.id, item.targetWeight])),
    sectorWeights,
    evaluations,
    diagnostics: {
      evaluated: evaluations.length,
      eligible: evaluations.filter((item) => item.eligible).length,
      affordable: selected.length,
      selected: selected.length,
      targetNotionalKrw:
        published.length > 0 ? equity * (finite(published[0]?.targetWeight) || 0) : 0,
      capitalCapacity: Math.floor(equity / policy.minimumPositionKrw),
      source: "published_investment_selection"
    }
  };
}

export function balancedStrategyConfig(config = {}) {
  return strategyConfig(config);
}
