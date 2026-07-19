function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

const DAY_MS = 86_400_000;
const MAX_FINANCIAL_GAP_DAYS = 550;

function rounded(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function listingCount(company) {
  const tickers = new Set(
    [company?.ticker, ...(company?.tickers || [])]
      .map((ticker) => String(ticker || "").trim().toUpperCase())
      .filter(Boolean)
  );
  return tickers.size;
}

function hasSecurityMappingRisk(company) {
  const flags = new Set([
    ...(company?.valuationIssues || []),
    ...(company?.qualityFlags || [])
  ]);
  return (
    listingCount(company) > 1 ||
    flags.has("ambiguous_share_classes") ||
    flags.has("adr_ratio_unknown")
  );
}

function strictIsoDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(text + "T00:00:00.000Z");
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    return null;
  }
  return date;
}

function dateContextIsCurrent(contextDate, priceDate, maxGapDays = MAX_FINANCIAL_GAP_DAYS) {
  if (!contextDate || !priceDate) return false;
  const gapDays = (priceDate.getTime() - contextDate.getTime()) / DAY_MS;
  return gapDays >= 0 && gapDays <= maxGapDays;
}

function unavailableValuation(latest, issues) {
  return {
    per: null,
    pbr: null,
    psr: null,
    fcfYield: null,
    marketCap: null,
    marketCapBasis: null,
    periodEnd: latest?.periodEnd || null,
    formula: {},
    issues: [...new Set(issues)]
  };
}

/**
 * Build verified valuation metrics for Longview score v2. Scoring may use
 * these values only when the price and annual financial contexts pass the
 * validation below; unavailable values remain null rather than becoming zero.
 */
export function deriveMarketValuation(company, marketData) {
  const latest = company?.financials?.latest || {};
  const marketCurrency = String(marketData?.currency || "").toUpperCase();
  const financialCurrency = String(latest.currency || company?.currency || "").toUpperCase();
  const issues = [];
  const securityMappingRisk = hasSecurityMappingRisk(company);
  const issuerTotalMarketCap = marketData?.issuerTotalMarketCap === true;
  const priceDate = strictIsoDate(marketData?.asOf);
  const financialPeriodEnd = strictIsoDate(latest.periodEnd);

  if (!marketCurrency || !financialCurrency || marketCurrency !== financialCurrency) {
    issues.push("currency_mismatch");
  }
  if (!priceDate || !financialPeriodEnd) {
    issues.push("financial_period_stale", "valuation_date_invalid");
  } else if (!dateContextIsCurrent(financialPeriodEnd, priceDate)) {
    issues.push("financial_period_stale");
  }
  if (securityMappingRisk && !issuerTotalMarketCap) {
    issues.push("security_mapping_required");
  }
  if (issues.length > 0) return unavailableValuation(latest, issues);

  let marketCap = positive(marketData?.marketCap) ? marketData.marketCap : null;
  let marketCapBasis = marketCap
    ? securityMappingRisk
      ? "provider_issuer_total"
      : "provider"
    : null;
  if (
    !marketCap &&
    !securityMappingRisk &&
    positive(marketData?.price) &&
    positive(latest.sharesOutstanding)
  ) {
    const sharesDate = strictIsoDate(latest.sharesDate);
    if (dateContextIsCurrent(sharesDate, priceDate)) {
      marketCap = marketData.price * latest.sharesOutstanding;
      marketCapBasis = "price_times_sec_shares";
    } else {
      issues.push("share_count_stale");
    }
  }

  let per = null;
  let perFormula = null;
  if (marketCap && positive(latest.netIncome)) {
    per = marketCap / latest.netIncome;
    perFormula = "marketCap / annualNetIncome";
  } else if (
    !securityMappingRisk &&
    positive(marketData?.price) &&
    positive(latest.epsDiluted)
  ) {
    const epsPeriodEnd = strictIsoDate(latest.epsPeriodEnd);
    if (dateContextIsCurrent(epsPeriodEnd, priceDate)) {
      per = marketData.price / latest.epsDiluted;
      perFormula = "price / annualDilutedEPS";
    } else {
      issues.push("eps_context_stale");
    }
  } else if (
    !securityMappingRisk &&
    positive(marketData?.price) &&
    positive(latest.epsBasic)
  ) {
    const epsPeriodEnd = strictIsoDate(latest.epsPeriodEnd);
    if (dateContextIsCurrent(epsPeriodEnd, priceDate)) {
      per = marketData.price / latest.epsBasic;
      perFormula = "price / annualBasicEPS";
    } else {
      issues.push("eps_context_stale");
    }
  }

  const pbr = marketCap && positive(latest.equity) ? marketCap / latest.equity : null;
  const psr = marketCap && positive(latest.revenue) ? marketCap / latest.revenue : null;
  const fcfYield =
    marketCap && finite(latest.freeCashFlow)
      ? (latest.freeCashFlow / marketCap) * 100
      : null;

  if (!marketCap) issues.push("market_cap_unavailable");
  if (!positive(latest.netIncome) && !positive(latest.epsDiluted) && !positive(latest.epsBasic)) {
    issues.push("positive_earnings_unavailable");
  }

  const formula = {};
  if (per !== null && perFormula) formula.per = perFormula;
  if (pbr !== null) formula.pbr = "marketCap / annualEquity";
  if (psr !== null) formula.psr = "marketCap / annualRevenue";
  if (fcfYield !== null) formula.fcfYield = "annualFreeCashFlow / marketCap * 100";

  return {
    per: rounded(per),
    pbr: rounded(pbr),
    psr: rounded(psr),
    fcfYield: rounded(fcfYield),
    marketCap: rounded(marketCap, 2),
    marketCapBasis,
    periodEnd: latest.periodEnd || null,
    formula,
    issues: [...new Set(issues)]
  };
}

export function attachMarketValuation(company, marketData) {
  const valuation = deriveMarketValuation(company, marketData);
  return {
    ...marketData,
    // Keep an official raw security/issuer market cap displayable even when
    // financial context is insufficient for issuer-level valuation ratios.
    marketCap: positive(marketData?.marketCap)
      ? marketData.marketCap
      : valuation.marketCap ?? null,
    valuation
  };
}
