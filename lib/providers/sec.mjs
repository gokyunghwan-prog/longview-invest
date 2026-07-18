import { fetchJson, sleep } from "../http.mjs";
import { buildSecRequestHeaders } from "./sec-identity.mjs";

const SEC_DATA_BASE = "https://data.sec.gov";
const SEC_ARCHIVE_BASE = "https://www.sec.gov/Archives/edgar/data";
const ANNUAL_FORMS = new Set([
  "10-K",
  "10-K/A",
  "20-F",
  "20-F/A",
  "40-F",
  "40-F/A"
]);
const PERIODIC_FORMS = new Set([...ANNUAL_FORMS, "10-Q", "10-Q/A"]);

export const SEC_LISTED_EXCHANGES = Object.freeze(["Nasdaq", "NYSE", "CBOE"]);
const SEC_LISTED_EXCHANGE_SET = new Set(SEC_LISTED_EXCHANGES);

const TAGS = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "SalesRevenueNet",
    "Revenues"
  ],
  operatingIncome: ["OperatingIncomeLoss"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  equity: [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"
  ],
  currentAssets: ["AssetsCurrent"],
  currentLiabilities: ["LiabilitiesCurrent"],
  operatingCashFlow: [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"
  ],
  capex: [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsForAdditionsToPropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets"
  ],
  epsBasic: ["EarningsPerShareBasic"],
  epsDiluted: ["EarningsPerShareDiluted"],
  weightedAverageSharesBasic: ["WeightedAverageNumberOfSharesOutstandingBasic"],
  weightedAverageSharesDiluted: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
  sharesOutstanding: ["CommonStockSharesOutstanding"]
};

const IFRS_TAGS = {
  revenue: ["Revenue", "RevenueFromContractsWithCustomers"],
  operatingIncome: ["OperatingProfitLoss", "ProfitLossFromOperatingActivities"],
  netIncome: ["ProfitLoss"],
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  equity: ["Equity"],
  currentAssets: ["CurrentAssets"],
  currentLiabilities: ["CurrentLiabilities"],
  operatingCashFlow: [
    "CashFlowsFromUsedInOperatingActivities",
    "CashFlowsFromUsedInOperatingActivitiesContinuingOperations"
  ],
  capex: [
    "PurchaseOfPropertyPlantAndEquipment",
    "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
    "PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets"
  ],
  epsBasic: ["BasicEarningsLossPerShare"],
  epsDiluted: ["DilutedEarningsLossPerShare"],
  weightedAverageSharesBasic: ["WeightedAverageShares"],
  weightedAverageSharesDiluted: ["AdjustedWeightedAverageShares"],
  sharesOutstanding: []
};

const DEI_TAGS = {
  sharesOutstanding: ["EntityCommonStockSharesOutstanding"]
};

const TAGS_BY_TAXONOMY = {
  "us-gaap": TAGS,
  "ifrs-full": IFRS_TAGS
};

function padCik(cik) {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

function validCik(cik) {
  const digits = String(cik ?? "").replace(/\D/g, "");
  return digits && digits.length <= 10 ? digits.padStart(10, "0") : null;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function tickerPenalty(ticker) {
  if (/-(WT|UN|RI)$/.test(ticker)) return 4;
  if (ticker.length >= 5 && /[WUR]$/.test(ticker)) return 3;
  return 0;
}

function choosePrimaryTicker(tickers) {
  return [...tickers].sort(
    (a, b) =>
      tickerPenalty(a) - tickerPenalty(b) ||
      a.length - b.length ||
      a.localeCompare(b)
  )[0];
}

function exchangeRank(exchange) {
  const index = SEC_LISTED_EXCHANGES.indexOf(exchange);
  return index === -1 ? SEC_LISTED_EXCHANGES.length : index;
}

/**
 * SEC의 columnar ticker 파일을 회사(CIK) 단위로 정규화한다.
 * 네트워크나 시계에 의존하지 않아 동일 입력은 항상 동일 출력을 만든다.
 */
export function normalizeSecTickerUniverse(payload) {
  const fields = Array.isArray(payload?.fields) ? payload.fields : [];
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const indexes = {
    cik: fields.indexOf("cik"),
    name: fields.indexOf("name"),
    ticker: fields.indexOf("ticker"),
    exchange: fields.indexOf("exchange")
  };

  if (Object.values(indexes).some((index) => index < 0)) {
    throw new Error("SEC ticker 파일의 필수 필드가 없습니다.");
  }

  const byCik = new Map();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const exchange = row[indexes.exchange];
    if (!SEC_LISTED_EXCHANGE_SET.has(exchange)) continue;

    const cik = validCik(row[indexes.cik]);
    const ticker = String(row[indexes.ticker] ?? "").trim().toUpperCase();
    const name = String(row[indexes.name] ?? "").trim();
    if (!cik || !ticker) continue;

    const current = byCik.get(cik) || {
      cik,
      names: [],
      listings: []
    };
    if (name) current.names.push(name);
    current.listings.push({ ticker, exchange });
    byCik.set(cik, current);
  }

  return [...byCik.values()]
    .map((group) => {
      const tickers = uniqueSorted(group.listings.map((listing) => listing.ticker));
      const exchanges = uniqueSorted(group.listings.map((listing) => listing.exchange)).sort(
        (a, b) => exchangeRank(a) - exchangeRank(b) || a.localeCompare(b)
      );
      const ticker = choosePrimaryTicker(tickers);
      const listings = group.listings
        .filter(
          (listing, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.ticker === listing.ticker &&
                candidate.exchange === listing.exchange
            ) === index
        )
        .sort(
          (a, b) =>
            exchangeRank(a.exchange) - exchangeRank(b.exchange) ||
            a.ticker.localeCompare(b.ticker)
        );

      return {
        id: "US-CIK" + group.cik,
        providerId: group.cik,
        cik: group.cik,
        name: uniqueSorted(group.names)[0] || ticker,
        ticker,
        tickers,
        country: "US",
        exchange: exchanges[0],
        exchanges,
        listings
      };
    })
    .sort((a, b) => a.cik.localeCompare(b.cik));
}

function percentage(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0)
    return null;
  return (numerator / denominator) * 100;
}

function yearOverYear(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function revenueStability(series) {
  const changes = [];
  for (let index = 1; index < series.length; index += 1) {
    const growth = yearOverYear(series[index].val, series[index - 1].val);
    if (growth !== null) changes.push(growth);
  }
  const deviation = standardDeviation(changes);
  if (deviation === null) return series.length >= 2 ? 65 : null;
  return Math.max(0, Math.min(100, 100 - deviation * 3));
}

function chooseUnit(units, requestedUnit) {
  if (units?.[requestedUnit]) return units[requestedUnit];
  return null;
}

function normalizeAnnualFacts(entries, duration, { forms = ANNUAL_FORMS } = {}) {
  const candidates = (entries || []).filter((fact) => {
    if (!forms.has(fact.form)) return false;
    if (forms === ANNUAL_FORMS && fact.fp && fact.fp !== "FY") return false;
    if (!Number.isFinite(fact.val) || !fact.end) return false;
    if (!duration) return true;
    if (!fact.start) return false;
    const days = (new Date(fact.end).getTime() - new Date(fact.start).getTime()) / 86_400_000;
    return days >= 300 && days <= 430;
  });

  const byPeriod = new Map();
  for (const fact of candidates) {
    const previous = byPeriod.get(fact.end);
    if (!previous || String(fact.filed) > String(previous.filed)) {
      byPeriod.set(fact.end, fact);
    }
  }

  return [...byPeriod.values()]
    .sort((a, b) => String(a.end).localeCompare(String(b.end)))
    .slice(-4);
}

function latestEnd(series) {
  return String(series.at(-1)?.end || "");
}

function seriesIsBetter(candidate, current, aliasIndex, currentAliasIndex) {
  const dateCompare = latestEnd(candidate).localeCompare(latestEnd(current));
  if (dateCompare !== 0) return dateCompare > 0;
  if (aliasIndex !== currentAliasIndex) return aliasIndex < currentAliasIndex;
  return candidate.length > current.length;
}

function extractSeries(
  companyFacts,
  taxonomyName,
  aliases,
  { unit = "USD", duration = true, forms = ANNUAL_FORMS } = {}
) {
  const taxonomy = companyFacts?.facts?.[taxonomyName] || {};
  let best = { tag: null, series: [], aliasIndex: Number.MAX_SAFE_INTEGER };

  aliases.forEach((tag, aliasIndex) => {
    const concept = taxonomy[tag];
    const entries = chooseUnit(concept?.units, unit);
    const series = normalizeAnnualFacts(entries, duration, { forms });
    if (
      series.length > 0 &&
      seriesIsBetter(series, best.series, aliasIndex, best.aliasIndex)
    ) {
      best = { tag, series, aliasIndex };
    }
  });

  return { tag: best.tag, series: best.series };
}

function chooseTaxonomyAndCurrency(companyFacts) {
  const candidates = [];
  for (const taxonomy of ["us-gaap", "ifrs-full"]) {
    const tags = TAGS_BY_TAXONOMY[taxonomy];
    const concepts = companyFacts?.facts?.[taxonomy] || {};
    tags.revenue.forEach((tag, aliasIndex) => {
      const units = concepts[tag]?.units || {};
      for (const currency of Object.keys(units).filter((unit) => /^[A-Z]{3}$/.test(unit))) {
        const series = normalizeAnnualFacts(units[currency], true);
        if (series.length === 0) continue;
        candidates.push({
          taxonomy,
          currency,
          latestEnd: latestEnd(series),
          length: series.length,
          aliasIndex
        });
      }
    });
  }

  candidates.sort(
    (left, right) =>
      right.latestEnd.localeCompare(left.latestEnd) ||
      right.length - left.length ||
      left.aliasIndex - right.aliasIndex ||
      Number(right.currency === "USD") - Number(left.currency === "USD") ||
      left.taxonomy.localeCompare(right.taxonomy)
  );
  if (candidates.length > 0) {
    return { taxonomy: candidates[0].taxonomy, currency: candidates[0].currency };
  }

  const taxonomy = ["us-gaap", "ifrs-full"].find(
    (candidate) => companyFacts?.facts?.[candidate]
  );
  return { taxonomy: taxonomy || null, currency: null };
}

function valueAt(series, offset = 0) {
  return series.at(-1 - offset)?.val ?? null;
}

function pointAtEnd(series, end) {
  if (!end) return null;
  return series.find((point) => point.end === end) || null;
}

function valueAtEnd(series, end) {
  return pointAtEnd(series, end)?.val ?? null;
}

const SEC_DURATION_CONTEXT_FIELDS = ["start", "end", "fy", "fp", "form", "accn"];

function secFactContextsMatch(...facts) {
  if (facts.length < 2 || facts.some((fact) => !fact)) return false;
  return SEC_DURATION_CONTEXT_FIELDS.every((field) => {
    const values = facts.map((fact) => String(fact?.[field] ?? ""));
    return values[0] !== "" && values.every((value) => value === values[0]);
  });
}

function secFactContext(fact) {
  if (!fact) return null;
  return Object.fromEntries(
    SEC_DURATION_CONTEXT_FIELDS.map((field) => [field, fact[field] ?? null])
  );
}

function extractLatestShares(companyFacts, taxonomy, taxonomyTags) {
  const candidates = [
    {
      taxonomy: "dei",
      ...extractSeries(companyFacts, "dei", DEI_TAGS.sharesOutstanding, {
        unit: "shares",
        duration: false,
        forms: PERIODIC_FORMS
      })
    },
    {
      taxonomy,
      ...extractSeries(companyFacts, taxonomy, taxonomyTags.sharesOutstanding || [], {
        unit: "shares",
        duration: false,
        forms: PERIODIC_FORMS
      })
    }
  ].filter((candidate) => candidate.series.length > 0);
  candidates.sort(
    (left, right) =>
      latestEnd(right.series).localeCompare(latestEnd(left.series)) ||
      right.series.length - left.series.length
  );
  return candidates[0] || { tag: null, series: [] };
}

function hasAmbiguousLatestShares(companyFacts, extracted) {
  const latest = extracted?.series?.at(-1);
  if (!latest || !extracted.taxonomy || !extracted.tag) return false;
  const facts =
    companyFacts?.facts?.[extracted.taxonomy]?.[extracted.tag]?.units?.shares || [];
  const sameEnd = facts.filter(
    (fact) =>
      PERIODIC_FORMS.has(fact?.form) &&
      fact?.end === latest.end &&
      Number.isFinite(fact?.val)
  );
  const latestFiled = sameEnd.map((fact) => String(fact.filed || "")).sort().at(-1);
  const latestValues = new Set(
    sameEnd
      .filter((fact) => String(fact.filed || "") === latestFiled)
      .map((fact) => fact.val)
  );
  return latestValues.size > 1;
}

function filingAt(series) {
  const fact = series.at(-1);
  if (!fact) return null;
  return {
    accessionNumber: fact.accn,
    filed: fact.filed,
    periodEnd: fact.end,
    form: fact.form
  };
}

function zipRecentFilings(submissions) {
  const recent = submissions?.filings?.recent || {};
  const count = recent.accessionNumber?.length || 0;
  const filings = [];

  for (let index = 0; index < count; index += 1) {
    filings.push({
      accessionNumber: recent.accessionNumber[index],
      date: recent.filingDate[index],
      acceptedAt: recent.acceptanceDateTime?.[index] || null,
      reportDate: recent.reportDate?.[index] || null,
      form: recent.form[index],
      primaryDocument: recent.primaryDocument?.[index] || "",
      items: recent.items?.[index] || ""
    });
  }

  return filings;
}

function filingUrl(cik, filing) {
  const cikWithoutZeros = String(Number.parseInt(cik, 10));
  const accession = filing.accessionNumber.replaceAll("-", "");
  const document = filing.primaryDocument || filing.accessionNumber + "-index.html";
  return (
    SEC_ARCHIVE_BASE +
    "/" +
    cikWithoutZeros +
    "/" +
    accession +
    "/" +
    document
  );
}

function relevantDisclosures(cik, submissions) {
  const relevantForms = /^(10-K|10-Q|8-K|20-F|40-F|6-K|DEF 14A|10-K\/A|10-Q\/A|20-F\/A|40-F\/A|NT 10-K|NT 20-F)$/;
  return zipRecentFilings(submissions)
    .filter((filing) => relevantForms.test(filing.form))
    .slice(0, 8)
    .map((filing) => ({
      id: filing.accessionNumber,
      title: filing.form + (filing.reportDate ? " · " + filing.reportDate : ""),
      form: filing.form,
      date: filing.date,
      acceptedAt: filing.acceptedAt,
      url: filingUrl(cik, filing),
      source: "SEC EDGAR",
      items: filing.items
    }));
}

function deriveRiskFlags(disclosures) {
  const flags = [];
  const late = disclosures.find((filing) => filing.form === "NT 10-K");
  const restatement = disclosures.find(
    (filing) => filing.form === "8-K" && String(filing.items).split(",").includes("4.02")
  );

  if (late) {
    flags.push({
      level: "critical",
      code: "late_annual_filing",
      label: "연차보고서 지연 신고",
      sourceUrl: late.url
    });
  }
  if (restatement) {
    flags.push({
      level: "critical",
      code: "non_reliance",
      label: "재무제표 신뢰 철회 가능성(Item 4.02)",
      sourceUrl: restatement.url
    });
  }

  return flags;
}

function applicability(submissions) {
  const entityType = String(submissions?.entityType || "").toLowerCase();
  const sic = Number.parseInt(submissions?.sic || "", 10);
  const sicDescription = String(submissions?.sicDescription || "");

  if (entityType.includes("investment")) {
    return { status: "not_applicable", reason: "투자회사·펀드는 일반회사 평가모델 대상이 아닙니다." };
  }
  if (sic === 6770 || /blank checks?/i.test(sicDescription)) {
    return { status: "not_applicable", reason: "SPAC·백지수표회사는 일반회사 평가모델 대상이 아닙니다." };
  }
  if (Number.isFinite(sic) && sic >= 6000 && sic <= 6799) {
    return { status: "not_applicable", reason: "금융·보험·REIT에는 업종별 평가모델이 필요합니다." };
  }
  return { status: "applicable", reason: null };
}

export function normalizeSecCompany(
  company,
  facts,
  submissions,
  { updatedAt = null } = {}
) {
  const cik = validCik(company.cik || company.providerId);
  if (!cik) throw new Error("유효한 SEC CIK가 필요합니다.");
  const { taxonomy, currency } = chooseTaxonomyAndCurrency(facts);
  const taxonomyTags = TAGS_BY_TAXONOMY[taxonomy] || TAGS;
  const seriesOptions = { unit: currency || "USD" };
  const instantOptions = { ...seriesOptions, duration: false };

  const revenue = extractSeries(facts, taxonomy, taxonomyTags.revenue, seriesOptions);
  const operatingIncome = extractSeries(
    facts,
    taxonomy,
    taxonomyTags.operatingIncome,
    seriesOptions
  );
  const netIncome = extractSeries(facts, taxonomy, taxonomyTags.netIncome, seriesOptions);
  const assets = extractSeries(facts, taxonomy, taxonomyTags.assets, instantOptions);
  const liabilities = extractSeries(
    facts,
    taxonomy,
    taxonomyTags.liabilities,
    instantOptions
  );
  const equity = extractSeries(facts, taxonomy, taxonomyTags.equity, instantOptions);
  const currentAssets = extractSeries(
    facts,
    taxonomy,
    taxonomyTags.currentAssets,
    instantOptions
  );
  const currentLiabilities = extractSeries(
    facts,
    taxonomy,
    taxonomyTags.currentLiabilities,
    instantOptions
  );
  const operatingCashFlow = extractSeries(
    facts,
    taxonomy,
    taxonomyTags.operatingCashFlow,
    seriesOptions
  );
  const capex = extractSeries(facts, taxonomy, taxonomyTags.capex, seriesOptions);
  const perShareUnit = currency ? currency + "/shares" : "USD/shares";
  const epsBasic = extractSeries(facts, taxonomy, taxonomyTags.epsBasic || [], {
    unit: perShareUnit
  });
  const epsDiluted = extractSeries(facts, taxonomy, taxonomyTags.epsDiluted || [], {
    unit: perShareUnit
  });
  const weightedAverageSharesBasic = extractSeries(
    facts,
    taxonomy,
    taxonomyTags.weightedAverageSharesBasic || [],
    { unit: "shares" }
  );
  const weightedAverageSharesDiluted = extractSeries(
    facts,
    taxonomy,
    taxonomyTags.weightedAverageSharesDiluted || [],
    { unit: "shares" }
  );
  const sharesOutstanding = extractLatestShares(facts, taxonomy, taxonomyTags);

  const periodEnd = revenue.series.at(-1)?.end || netIncome.series.at(-1)?.end || null;
  const previousPeriodEnd = revenue.series.at(-2)?.end || null;
  const revenueNow = valueAtEnd(revenue.series, periodEnd);
  const revenuePrevious = valueAtEnd(revenue.series, previousPeriodEnd);
  const operatingIncomeNow = valueAtEnd(operatingIncome.series, periodEnd);
  const operatingIncomePrevious = valueAtEnd(operatingIncome.series, previousPeriodEnd);
  const netIncomeNow = valueAtEnd(netIncome.series, periodEnd);
  const equityNow = valueAtEnd(equity.series, periodEnd);
  const equityPrevious = valueAtEnd(equity.series, previousPeriodEnd);
  const assetsNow = valueAtEnd(assets.series, periodEnd);
  const liabilitiesNow = valueAtEnd(liabilities.series, periodEnd);
  const currentAssetsNow = valueAtEnd(currentAssets.series, periodEnd);
  const currentLiabilitiesNow = valueAtEnd(currentLiabilities.series, periodEnd);
  const revenuePoint = pointAtEnd(revenue.series, periodEnd);
  const netIncomePoint = pointAtEnd(netIncome.series, periodEnd);
  const cashFlowPoint = pointAtEnd(operatingCashFlow.series, periodEnd);
  const capexPoint = pointAtEnd(capex.series, periodEnd);
  const cashFlowNow = cashFlowPoint?.val ?? null;
  const rawCapexNow = capexPoint?.val ?? null;
  const capexNow = Number.isFinite(rawCapexNow) ? Math.abs(rawCapexNow) : null;
  const freeCashFlowContextCompatible = secFactContextsMatch(
    cashFlowPoint,
    capexPoint
  );
  const freeCashFlow =
    freeCashFlowContextCompatible &&
    Number.isFinite(cashFlowNow) &&
    Number.isFinite(capexNow)
      ? cashFlowNow - capexNow
      : null;
  const fcfMarginContextCompatible = secFactContextsMatch(
    cashFlowPoint,
    capexPoint,
    revenuePoint
  );
  const cashConversionContextCompatible = secFactContextsMatch(
    cashFlowPoint,
    netIncomePoint
  );
  const averageEquity =
    Number.isFinite(equityNow) && Number.isFinite(equityPrevious)
      ? (equityNow + equityPrevious) / 2
      : equityNow;

  const disclosures = relevantDisclosures(cik, submissions);
  const latestDisclosure = disclosures[0] || null;
  const history = revenue.series.slice(-4).map((point) => {
    const matchingOperatingIncome = operatingIncome.series.find(
      (incomePoint) => incomePoint.end === point.end
    );
    return {
      label: point.end.slice(0, 4),
      revenue: point.val / 1_000_000_000,
      operatingIncome: matchingOperatingIncome
        ? matchingOperatingIncome.val / 1_000_000_000
        : null
    };
  });

  const metrics = {
    roe: percentage(netIncomeNow, averageEquity),
    operatingMargin: percentage(operatingIncomeNow, revenueNow),
    netMargin: percentage(netIncomeNow, revenueNow),
    revenueGrowth: yearOverYear(revenueNow, revenuePrevious),
    operatingIncomeGrowth: yearOverYear(operatingIncomeNow, operatingIncomePrevious),
    debtRatio:
      Number.isFinite(equityNow) && equityNow > 0
        ? percentage(liabilitiesNow, equityNow)
        : null,
    currentRatio: percentage(currentAssetsNow, currentLiabilitiesNow),
    fcfMargin: fcfMarginContextCompatible
      ? percentage(freeCashFlow, revenueNow)
      : null,
    cashConversion:
      cashConversionContextCompatible &&
      Number.isFinite(netIncomeNow) &&
      netIncomeNow > 0
        ? percentage(cashFlowNow, netIncomeNow)
        : null,
    positiveIncomeYears:
      netIncome.series.length > 0
        ? netIncome.series.filter((point) => point.val > 0).length
        : null,
    revenueStability: revenueStability(revenue.series),
    per: null
  };
  const latestSharesPoint = sharesOutstanding.series.at(-1) || null;
  const ambiguousShares = hasAmbiguousLatestShares(facts, sharesOutstanding);
  const epsBasicPoint = pointAtEnd(epsBasic.series, periodEnd);
  const epsDilutedPoint = pointAtEnd(epsDiluted.series, periodEnd);
  const financials = {
    latest: {
      periodEnd,
      currency,
      revenue: revenueNow,
      operatingIncome: operatingIncomeNow,
      netIncome: netIncomeNow,
      assets: assetsNow,
      liabilities: liabilitiesNow,
      equity: equityNow,
      currentAssets: currentAssetsNow,
      currentLiabilities: currentLiabilitiesNow,
      operatingCashFlow: cashFlowNow,
      capex: capexNow,
      freeCashFlow,
      epsBasic: epsBasicPoint?.val ?? null,
      epsDiluted: epsDilutedPoint?.val ?? null,
      epsPeriodEnd: epsDilutedPoint?.end || epsBasicPoint?.end || null,
      weightedAverageSharesBasic: valueAtEnd(
        weightedAverageSharesBasic.series,
        periodEnd
      ),
      weightedAverageSharesDiluted: valueAtEnd(
        weightedAverageSharesDiluted.series,
        periodEnd
      ),
      sharesOutstanding:
        !ambiguousShares &&
        Number.isFinite(latestSharesPoint?.val) && latestSharesPoint.val > 0
          ? latestSharesPoint.val
          : null,
      sharesDate: latestSharesPoint?.end || null
    }
  };

  const sourceFiling =
    filingAt(revenue.series) ||
    filingAt(netIncome.series) ||
    filingAt(assets.series) ||
    filingAt(equity.series);
  const modelApplicability = applicability(submissions);
  const dataIssues = [];
  const valuationIssues = [];
  if (/^(20-F|40-F)/.test(sourceFiling?.form || "")) {
    valuationIssues.push("adr_ratio_unknown");
  }
  if (!submissions || submissions.__missing) dataIssues.push("missing_submissions");
  if (!facts) dataIssues.push("missing_companyfacts");
  if (!taxonomy) dataIssues.push("unsupported_taxonomy");
  if (!currency) dataIssues.push("missing_monetary_unit");
  if (revenue.series.length < 2) dataIssues.push("insufficient_revenue_history");
  if (netIncome.series.length === 0) dataIssues.push("missing_net_income");
  if (!Number.isFinite(financials.latest.epsBasic) && !Number.isFinite(financials.latest.epsDiluted)) {
    valuationIssues.push("missing_annual_eps");
  }
  if (!Number.isFinite(financials.latest.sharesOutstanding)) {
    valuationIssues.push("missing_shares_outstanding");
  }
  if (ambiguousShares) valuationIssues.push("ambiguous_share_classes");

  const evaluationStatus =
    modelApplicability.status === "not_applicable"
      ? "not_applicable"
      : dataIssues.length > 0
        ? "insufficient_data"
        : "live";
  const tickers = uniqueSorted([
    ...(company.tickers || []),
    ...(submissions?.tickers || []),
    company.ticker
  ].map((ticker) => String(ticker || "").toUpperCase()));
  if (tickers.length > 1) valuationIssues.push("ambiguous_share_classes");
  const exchanges = uniqueSorted([
    ...(company.exchanges || []),
    ...(submissions?.exchanges || []),
    company.exchange
  ]).sort((a, b) => exchangeRank(a) - exchangeRank(b) || a.localeCompare(b));
  const primaryTicker = company.ticker
    ? String(company.ticker).toUpperCase()
    : choosePrimaryTicker(tickers);
  const risks = modelApplicability.reason ? [modelApplicability.reason] : [];

  return {
    id: company.id || "US-" + primaryTicker,
    providerId: cik,
    name: submissions?.name || company.name || primaryTicker,
    ticker: primaryTicker,
    tickers,
    country: "US",
    exchange: exchanges[0] || "US",
    exchanges,
    sector: company.sector || submissions?.sicDescription || "미분류",
    industry: submissions?.sicDescription || null,
    currency,
    period: periodEnd ? "FY " + periodEnd : "최근 연차보고서",
    statementBasis:
      taxonomy === "ifrs-full"
        ? "IFRS · 공시 원문 기준"
        : taxonomy === "us-gaap"
          ? "US GAAP · 공시 원문 기준"
          : "지원 가능한 표준 taxonomy 없음",
    dataMode: evaluationStatus,
    evaluationStatus,
    analysisStatus: evaluationStatus,
    modelApplicability,
    dataIssues,
    valuationIssues: [...new Set(valuationIssues)],
    metrics,
    financials,
    history,
    historyUnit: currency ? currency + " billion" : null,
    disclosures,
    latestDisclosure,
    riskFlags: deriveRiskFlags(disclosures),
    risks,
    sourceUrl: "https://www.sec.gov/edgar/browse/?CIK=" + Number.parseInt(cik, 10),
    lineage: {
      provider: "SEC EDGAR",
      filingId: sourceFiling?.accessionNumber || null,
      filedAt: sourceFiling?.filed || null,
      periodEnd: sourceFiling?.periodEnd || periodEnd,
      taxonomy,
      tags: {
        revenue: revenue.tag,
        operatingIncome: operatingIncome.tag,
        netIncome: netIncome.tag,
        equity: equity.tag,
        operatingCashFlow: operatingCashFlow.tag,
        capex: capex.tag,
        epsBasic: epsBasic.tag,
        epsDiluted: epsDiluted.tag,
        weightedAverageSharesBasic: weightedAverageSharesBasic.tag,
        weightedAverageSharesDiluted: weightedAverageSharesDiluted.tag,
        sharesOutstanding: sharesOutstanding.tag
      },
      derived: {
        freeCashFlow: {
          formula: "operatingCashFlow - abs(capex)",
          periodEnd,
          samePeriod: freeCashFlowContextCompatible,
          contextCompatible: freeCashFlowContextCompatible,
          operatingCashFlowContext: secFactContext(cashFlowPoint),
          capexContext: secFactContext(capexPoint)
        },
        fcfMargin: {
          contextCompatible: fcfMarginContextCompatible,
          revenueContext: secFactContext(revenuePoint)
        },
        cashConversion: {
          contextCompatible: cashConversionContextCompatible,
          netIncomeContext: secFactContext(netIncomePoint)
        }
      }
    },
    validation: {
      score:
        evaluationStatus === "live"
          ? 85
          : evaluationStatus === "not_applicable"
            ? 60
            : 30
    },
    stale: false,
    syncStatus: evaluationStatus === "live" ? "ok" : evaluationStatus,
    updatedAt: updatedAt || sourceFiling?.filed || latestDisclosure?.date || null
  };
}

export async function syncSecCompany(company, config) {
  if (!config.secUserAgent) {
    throw new Error("SEC_USER_AGENT가 설정되지 않았습니다.");
  }

  const cik = padCik(company.cik || company.providerId);
  const headers = buildSecRequestHeaders(config.secUserAgent);
  const [facts, submissions] = await Promise.all([
    fetchJson(SEC_DATA_BASE + "/api/xbrl/companyfacts/CIK" + cik + ".json", { headers }),
    fetchJson(SEC_DATA_BASE + "/submissions/CIK" + cik + ".json", { headers })
  ]);

  return normalizeSecCompany(company, facts, submissions, {
    updatedAt: new Date().toISOString()
  });
}

export async function syncSecCompanies(companies, config, onProgress = () => {}) {
  const results = [];
  for (const company of companies) {
    onProgress("SEC " + company.ticker + " 수집 중");
    results.push(await syncSecCompany(company, config));
    await sleep(220);
  }
  return results;
}
