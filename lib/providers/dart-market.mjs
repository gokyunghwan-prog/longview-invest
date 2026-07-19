import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { fetchJson, sleep } from "../http.mjs";
import { fetchDartCorpCodes } from "./dart.mjs";

const DART_API_BASE = "https://opendart.fss.or.kr/api";
const MARKET_CLASSES = new Set(["Y", "K"]);
const INDEX_CATEGORIES = ["M210000", "M220000", "M230000", "M240000"];
const MAX_DART_COMPANIES_PER_REQUEST = 100;
const DEFAULT_DART_FINANCIAL_BATCH_SIZE = 50;
const DEFAULT_DART_FINANCIAL_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_INTERVAL_MS = 250;
const DEFAULT_REQUEST_BUDGET = 15_000;
const DAY_MS = 86_400_000;
const DEFAULT_DART_CASH_FLOW_REFRESH_MAX_AGE_MS = 7 * DAY_MS;
const DEFAULT_UNIVERSE_CACHE_MAX_AGE_MS = 3 * DAY_MS;

const ACCOUNT_DEFINITIONS = {
  revenue: {
    statement: "IS",
    names: ["매출액", "영업수익", "수익(매출액)", "수익", "영업수익(매출액)"]
  },
  operatingIncome: {
    statement: "IS",
    names: ["영업이익", "영업이익(손실)", "영업손익"]
  },
  netIncome: {
    statement: "IS",
    names: ["당기순이익(손실)", "당기순이익", "연결당기순이익", "분기순이익(손실)"]
  },
  assets: { statement: "BS", names: ["자산총계"] },
  liabilities: { statement: "BS", names: ["부채총계"] },
  equity: { statement: "BS", names: ["자본총계"] },
  currentAssets: { statement: "BS", names: ["유동자산"] },
  currentLiabilities: { statement: "BS", names: ["유동부채"] }
};

const CASH_FLOW_ACCOUNT_DEFINITIONS = {
  operatingCashFlow: {
    ids: [
      "ifrs-full_CashFlowsFromUsedInOperatingActivities",
      "ifrs_CashFlowsFromUsedInOperatingActivities",
      "dart_CashFlowsFromUsedInOperatingActivities"
    ],
    names: [
      "영업활동현금흐름",
      "영업활동으로인한현금흐름",
      "영업활동으로부터의현금흐름",
      "영업활동순현금흐름"
    ]
  },
  capex: {
    ids: [
      "ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
      "ifrs_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
      "ifrs-full_PurchaseOfPropertyPlantAndEquipment",
      "ifrs_PurchaseOfPropertyPlantAndEquipment",
      "dart_PurchaseOfPropertyPlantAndEquipment"
    ],
    names: [
      "유형자산의취득",
      "유형자산취득",
      "유형자산취득으로인한현금유출",
      "유형자산취득에따른현금유출"
    ]
  },
  intangibleCapex: {
    ids: [
      "ifrs-full_PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities",
      "ifrs_PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities"
    ],
    names: ["무형자산의취득", "무형자산취득"]
  }
};

const INDEX_TO_METRIC = {
  M211200: "netMargin",
  M211550: "roe",
  M221100: "debtRatio",
  M221200: "currentRatio",
  M231000: "revenueGrowth",
  M231400: "operatingIncomeGrowth"
};

const REPORT_LABELS = {
  "11011": "사업보고서",
  "11012": "반기보고서",
  "11013": "1분기보고서",
  "11014": "3분기보고서"
};

export class DartApiError extends Error {
  constructor(code, message, endpoint) {
    super(`Open DART ${code}: ${redactSecrets(message)}`);
    this.name = "DartApiError";
    this.code = String(code || "UNKNOWN");
    this.endpoint = endpoint;
  }
}

export class DartRequestLimitError extends DartApiError {
  constructor(code, message, endpoint) {
    super(code, message, endpoint);
    this.name = "DartRequestLimitError";
  }
}

function redactSecrets(value) {
  return String(value || "")
    .replace(/crtfc_key=[^&\s]+/gi, "crtfc_key=[REDACTED]")
    .replace(/\b[a-f0-9]{40}\b/gi, "[REDACTED]");
}

function safeErrorMessage(error) {
  return redactSecrets(error instanceof Error ? error.message : error);
}

function compactDate(date) {
  return (
    date.getUTCFullYear().toString() +
    String(date.getUTCMonth() + 1).padStart(2, "0") +
    String(date.getUTCDate()).padStart(2, "0")
  );
}

function isoDate(value) {
  const compact = String(value || "");
  if (/^\d{8}$/.test(compact)) {
    return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  }
  return compact || null;
}

function parseIsoDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function kstRunId(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function defaultDartAnnualBusinessYear(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit"
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const year = Number.parseInt(parts.year, 10);
  const month = Number.parseInt(parts.month, 10);
  return String(month >= 4 ? year - 1 : year - 2);
}

function kstCalendarParts(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return {
    year: Number.parseInt(parts.year, 10),
    month: Number.parseInt(parts.month, 10),
    day: Number.parseInt(parts.day, 10)
  };
}

/**
 * Choose only periods whose ordinary filing deadline has already passed in Korea.
 * The first day after each deadline is used deliberately so a daily run does not
 * treat a report as available while issuers can still be submitting it.
 */
export function defaultDartFinancialPeriods(now = new Date()) {
  const { year, month, day } = kstCalendarParts(now);
  const monthDay = month * 100 + day;
  const annualFallback = {
    businessYear: String(monthDay >= 401 ? year - 1 : year - 2),
    reportCode: "11011",
    role: "annual_fallback"
  };

  let latest;
  if (monthDay < 401) {
    latest = { businessYear: String(year - 1), reportCode: "11014", role: "latest" };
  } else if (monthDay < 516) {
    latest = { businessYear: String(year - 1), reportCode: "11011", role: "latest" };
  } else if (monthDay < 815) {
    latest = { businessYear: String(year), reportCode: "11013", role: "latest" };
  } else if (monthDay < 1115) {
    latest = { businessYear: String(year), reportCode: "11012", role: "latest" };
  } else {
    latest = { businessYear: String(year), reportCode: "11014", role: "latest" };
  }

  return { latest, annualFallback };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function hashRecords(records) {
  const canonical = records
    .map((record) => [record.corpCode, record.stockCode, record.modifiedAt].join(":"))
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function endpointUrl(endpoint, apiKey, parameters = {}) {
  const url = new URL(`${DART_API_BASE}/${endpoint}`);
  url.searchParams.set("crtfc_key", apiKey);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

class DartRequestController {
  constructor({
    apiKey,
    minIntervalMs = DEFAULT_REQUEST_INTERVAL_MS,
    maxRequests = DEFAULT_REQUEST_BUDGET,
    fetchJsonImpl = fetchJson,
    onProgress = () => {}
  }) {
    this.apiKey = apiKey;
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.maxRequests = Math.max(1, maxRequests);
    this.fetchJsonImpl = fetchJsonImpl;
    this.onProgress = onProgress;
    this.requestCount = 0;
    this.lastRequestAt = 0;
  }

  async beforeRequest(label) {
    if (this.requestCount >= this.maxRequests) {
      throw new DartRequestLimitError(
        "LOCAL_BUDGET",
        `설정한 1회 실행 요청 예산 ${this.maxRequests}건에 도달했습니다. 체크포인트에서 재개할 수 있습니다.`,
        label
      );
    }

    const remaining = this.minIntervalMs - (Date.now() - this.lastRequestAt);
    if (remaining > 0) await sleep(remaining);
    this.requestCount += 1;
    this.lastRequestAt = Date.now();
  }

  async external(label, operation) {
    await this.beforeRequest(label);
    return operation();
  }

  async json(
    endpoint,
    parameters,
    { allowNoData = false, retries = 2, timeoutMs } = {}
  ) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      await this.beforeRequest(endpoint);
      try {
        // This controller already retries the complete DART request. Disable the
        // lower HTTP helper retry loop so one logical request cannot expand to
        // nine network attempts during an upstream slowdown.
        const requestOptions = { retries: 0 };
        if (timeoutMs !== undefined) requestOptions.timeoutMs = timeoutMs;
        const payload = await this.fetchJsonImpl(
          endpointUrl(endpoint, this.apiKey, parameters),
          requestOptions
        );
        if (payload?.status === "000") return payload;
        if (allowNoData && payload?.status === "013") return null;
        if (payload?.status === "020") {
          throw new DartRequestLimitError(payload.status, payload.message, endpoint);
        }

        const error = new DartApiError(payload?.status, payload?.message, endpoint);
        if (["800", "900"].includes(error.code) && attempt < retries) {
          lastError = error;
          await sleep(800 * 2 ** attempt);
          continue;
        }
        throw error;
      } catch (error) {
        if (error instanceof DartRequestLimitError) throw error;
        lastError =
          error instanceof DartApiError
            ? error
            : new DartApiError("NETWORK", safeErrorMessage(error), endpoint);
        if (attempt >= retries || (lastError.code !== "NETWORK" && lastError.code !== "800" && lastError.code !== "900")) {
          throw lastError;
        }
        await sleep(800 * 2 ** attempt);
      }
    }
    throw lastError;
  }
}

export function chunkDartCompanies(companies, size = MAX_DART_COMPANIES_PER_REQUEST) {
  if (!Number.isInteger(size) || size < 1 || size > MAX_DART_COMPANIES_PER_REQUEST) {
    throw new RangeError(`Open DART 다중회사 묶음 크기는 1~${MAX_DART_COMPANIES_PER_REQUEST}이어야 합니다.`);
  }
  const chunks = [];
  for (let index = 0; index < companies.length; index += size) {
    chunks.push(companies.slice(index, index + size));
  }
  return chunks;
}

export function parseDartNumber(value) {
  if (value === null || value === undefined || value === "" || value === "-") return null;
  const normalized = String(value)
    .trim()
    .replaceAll(",", "")
    .replace(/^\((.+)\)$/, "-$1");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizedAccountName(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function accountValue(row, period) {
  const reportCode = String(row?.reprt_code || "");
  const flowStatement = row?.sj_div === "IS" || row?.sj_div === "CIS";
  const firstNumber = (...values) => {
    for (const value of values) {
      const parsed = parseDartNumber(value);
      if (parsed !== null) return parsed;
    }
    return null;
  };
  if (period === "current") {
    if (flowStatement && reportCode !== "11011") {
      return firstNumber(row?.thstrm_add_amount, row?.thstrm_amount);
    }
    return firstNumber(row?.thstrm_amount, row?.thstrm_add_amount);
  }
  if (period === "previous") {
    if (flowStatement && reportCode !== "11011") {
      return firstNumber(row?.frmtrm_add_amount, row?.frmtrm_q_amount, row?.frmtrm_amount);
    }
    return firstNumber(row?.frmtrm_amount, row?.frmtrm_add_amount);
  }
  return parseDartNumber(row?.bfefrmtrm_amount);
}

function findMainAccount(rows, definition) {
  const names = new Set(definition.names.map(normalizedAccountName));
  return (
    rows.find(
      (row) =>
        row.sj_div === definition.statement && names.has(normalizedAccountName(row.account_nm))
    ) || null
  );
}

function compactAccount(row) {
  if (!row) return null;
  return {
    accountName: row.account_nm || null,
    statement: row.sj_div || null,
    current: accountValue(row, "current"),
    previous: accountValue(row, "previous"),
    twoYearsAgo: accountValue(row, "twoYearsAgo"),
    currentLabel: row.thstrm_nm || null,
    previousLabel: row.frmtrm_nm || row.frmtrm_q_nm || null,
    twoYearsAgoLabel: row.bfefrmtrm_nm || null
  };
}

function normalizedCashFlowName(value) {
  return String(value || "")
    .replace(/[\s·ㆍ,()]/g, "")
    .trim();
}

function findCashFlowAccount(rows, definition) {
  const cashFlowRows = rows.filter((row) => row?.sj_div === "CF");
  for (const accountId of definition.ids) {
    const exact = cashFlowRows.find((row) => String(row?.account_id || "") === accountId);
    if (exact) return exact;
  }
  const names = new Set(definition.names.map(normalizedCashFlowName));
  return (
    cashFlowRows.find((row) => names.has(normalizedCashFlowName(row?.account_nm))) || null
  );
}

function compactCashFlowAccount(row) {
  if (!row) return null;
  return {
    accountId: row.account_id || null,
    accountName: row.account_nm || null,
    value: accountValue(row, "current")
  };
}

export function normalizeDartCashFlowStatement(
  rows = [],
  { corpCode = null, statementBasis = null, businessYear = null, reportCode = "11011" } = {}
) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const basis = statementBasis || rows[0]?.fs_div || null;
  const basisRows = basis ? rows.filter((row) => row?.fs_div === basis) : rows;
  const sourceRow = basisRows.find((row) => row?.sj_div === "CF") || basisRows[0] || null;
  if (!sourceRow) return null;
  return {
    corpCode: corpCode || sourceRow.corp_code || null,
    statementBasis: basis,
    businessYear: String(businessYear || sourceRow.bsns_year || "") || null,
    reportCode: String(reportCode || sourceRow.reprt_code || "") || null,
    filingId: sourceRow.rcept_no || null,
    currency: sourceRow.currency || "KRW",
    accounts: Object.fromEntries(
      Object.entries(CASH_FLOW_ACCOUNT_DEFINITIONS).map(([key, definition]) => [
        key,
        compactCashFlowAccount(findCashFlowAccount(basisRows, definition))
      ])
    )
  };
}

function normalizedCurrency(value) {
  return String(value || "").trim().toUpperCase();
}

export function evaluateDartCashFlowCompatibility(
  continuityAccounts,
  continuityPeriod,
  cashFlowStatement
) {
  const reasons = [];
  if (!cashFlowStatement) return { compatible: false, reasons };
  if (!continuityAccounts) reasons.push("missing_annual_accounts");
  if (!continuityPeriod) reasons.push("missing_annual_period");
  if (reasons.length > 0) return { compatible: false, reasons };

  const periodReportCode = String(continuityPeriod.reportCode || "");
  const accountsReportCode = String(continuityAccounts.reportCode || periodReportCode);
  const cashFlowReportCode = String(cashFlowStatement.reportCode || "");
  if (
    periodReportCode !== "11011" ||
    accountsReportCode !== "11011" ||
    cashFlowReportCode !== "11011"
  ) {
    reasons.push("not_same_annual_report");
  }

  const periodBusinessYear = String(continuityPeriod.businessYear || "");
  const accountsBusinessYear = String(
    continuityAccounts.businessYear || periodBusinessYear
  );
  const cashFlowBusinessYear = String(cashFlowStatement.businessYear || "");
  if (
    !periodBusinessYear ||
    !accountsBusinessYear ||
    !cashFlowBusinessYear ||
    periodBusinessYear !== accountsBusinessYear ||
    periodBusinessYear !== cashFlowBusinessYear
  ) {
    reasons.push("business_year_mismatch");
  }

  const accountsBasis = String(continuityAccounts.statementBasis || "");
  const cashFlowBasis = String(cashFlowStatement.statementBasis || "");
  if (!accountsBasis || !cashFlowBasis || accountsBasis !== cashFlowBasis) {
    reasons.push("statement_basis_mismatch");
  }

  const accountsCurrency = normalizedCurrency(continuityAccounts.currency);
  const cashFlowCurrency = normalizedCurrency(cashFlowStatement.currency);
  if (!accountsCurrency || !cashFlowCurrency || accountsCurrency !== cashFlowCurrency) {
    reasons.push("currency_mismatch");
  }

  const accountsFilingId = String(continuityAccounts.filingId || "");
  const cashFlowFilingId = String(cashFlowStatement.filingId || "");
  if (accountsFilingId && cashFlowFilingId && accountsFilingId !== cashFlowFilingId) {
    reasons.push("filing_mismatch");
  }

  return { compatible: reasons.length === 0, reasons };
}

export function normalizeDartMainAccounts(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const stockCode = String(row?.stock_code || "").trim();
    if (!stockCode) continue;
    if (!grouped.has(stockCode)) grouped.set(stockCode, []);
    grouped.get(stockCode).push(row);
  }

  const normalized = {};
  for (const [stockCode, companyRows] of grouped) {
    const hasConsolidated = companyRows.some((row) => row.fs_div === "CFS");
    const statementBasis = hasConsolidated ? "CFS" : "OFS";
    const basisRows = companyRows.filter((row) => row.fs_div === statementBasis);
    const accounts = Object.fromEntries(
      Object.entries(ACCOUNT_DEFINITIONS).map(([key, definition]) => [
        key,
        compactAccount(findMainAccount(basisRows, definition))
      ])
    );
    const sourceRow =
      findMainAccount(basisRows, ACCOUNT_DEFINITIONS.revenue) || basisRows[0] || null;

    normalized[stockCode] = {
      stockCode,
      statementBasis,
      filingId: sourceRow?.rcept_no || null,
      businessYear: sourceRow?.bsns_year || null,
      reportCode: sourceRow?.reprt_code || null,
      currency: sourceRow?.currency || "KRW",
      accounts
    };
  }
  return normalized;
}

export function normalizeDartFinancialIndices(rows = []) {
  const normalized = {};
  for (const row of rows) {
    const corpCode = String(row?.corp_code || "").trim();
    const stockCode = String(row?.stock_code || "").trim();
    const key = corpCode || (stockCode ? `stock:${stockCode}` : "");
    if (!key) continue;
    if (!normalized[key]) {
      normalized[key] = {
        corpCode: corpCode || null,
        stockCode: stockCode || null,
        settlementDate: row.stlm_dt || null,
        metrics: {},
        indices: {}
      };
    }
    const value = parseDartNumber(row.idx_val);
    normalized[key].indices[row.idx_code] = {
      code: row.idx_code,
      name: row.idx_nm || null,
      value
    };
    const metric = INDEX_TO_METRIC[row.idx_code];
    if (metric && value !== null) normalized[key].metrics[metric] = value;
  }
  return normalized;
}

export function mergeDartFinancialIndices(base = {}, incoming = {}) {
  const merged = structuredClone(base);
  for (const [key, record] of Object.entries(incoming)) {
    const previous = merged[key] || { metrics: {}, indices: {} };
    merged[key] = {
      ...previous,
      ...record,
      metrics: { ...(previous.metrics || {}), ...(record.metrics || {}) },
      indices: { ...(previous.indices || {}), ...(record.indices || {}) }
    };
  }
  return merged;
}

function percentage(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return (numerator / denominator) * 100;
}

function yearOverYear(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function revenueStability(values) {
  const chronological = values.filter(Number.isFinite);
  if (chronological.length < 2) return null;
  const changes = [];
  for (let index = 1; index < chronological.length; index += 1) {
    const change = yearOverYear(chronological[index], chronological[index - 1]);
    if (change !== null) changes.push(change);
  }
  if (changes.length < 2) return changes.length === 1 ? 65 : null;
  const average = changes.reduce((sum, value) => sum + value, 0) / changes.length;
  const variance =
    changes.reduce((sum, value) => sum + (value - average) ** 2, 0) / changes.length;
  return Math.max(0, Math.min(100, 100 - Math.sqrt(variance) * 3));
}

function accountAmount(mainAccounts, key, period = "current") {
  return mainAccounts?.accounts?.[key]?.[period] ?? null;
}

export function deriveDartMarketMetrics(
  mainAccounts,
  financialIndices = {},
  continuityAccounts = mainAccounts,
  cashFlowStatement = null,
  continuityPeriod = null
) {
  const revenue = accountAmount(mainAccounts, "revenue");
  const previousRevenue = accountAmount(mainAccounts, "revenue", "previous");
  const operatingIncome = accountAmount(mainAccounts, "operatingIncome");
  const previousOperatingIncome = accountAmount(
    mainAccounts,
    "operatingIncome",
    "previous"
  );
  const netIncome = accountAmount(mainAccounts, "netIncome");
  const equity = accountAmount(mainAccounts, "equity");
  const previousEquity = accountAmount(mainAccounts, "equity", "previous");
  const liabilities = accountAmount(mainAccounts, "liabilities");
  const currentAssets = accountAmount(mainAccounts, "currentAssets");
  const currentLiabilities = accountAmount(mainAccounts, "currentLiabilities");
  const indexMetrics = financialIndices?.metrics || {};
  const averageEquity =
    Number.isFinite(equity) && Number.isFinite(previousEquity)
      ? (equity + previousEquity) / 2
      : equity;

  const netIncomeSeries = [
    accountAmount(continuityAccounts, "netIncome", "twoYearsAgo"),
    accountAmount(continuityAccounts, "netIncome", "previous"),
    accountAmount(continuityAccounts, "netIncome")
  ].filter(Number.isFinite);
  const revenueSeries = [
    accountAmount(continuityAccounts, "revenue", "twoYearsAgo"),
    accountAmount(continuityAccounts, "revenue", "previous"),
    accountAmount(continuityAccounts, "revenue")
  ];
  const annualRevenue = accountAmount(continuityAccounts, "revenue");
  const annualNetIncome = accountAmount(continuityAccounts, "netIncome");
  const cashFlowCompatibility = evaluateDartCashFlowCompatibility(
    continuityAccounts,
    continuityPeriod,
    cashFlowStatement
  );
  const compatibleCashFlowStatement = cashFlowCompatibility.compatible
    ? cashFlowStatement
    : null;
  const operatingCashFlow =
    compatibleCashFlowStatement?.accounts?.operatingCashFlow?.value ?? null;
  const rawCapex = compatibleCashFlowStatement?.accounts?.capex?.value ?? null;
  const capex = Number.isFinite(rawCapex) ? Math.abs(rawCapex) : null;
  const freeCashFlow =
    Number.isFinite(operatingCashFlow) && Number.isFinite(capex)
      ? operatingCashFlow - capex
      : null;

  return {
    roe: indexMetrics.roe ?? percentage(netIncome, averageEquity),
    operatingMargin: percentage(operatingIncome, revenue),
    netMargin: indexMetrics.netMargin ?? percentage(netIncome, revenue),
    revenueGrowth: indexMetrics.revenueGrowth ?? yearOverYear(revenue, previousRevenue),
    operatingIncomeGrowth:
      indexMetrics.operatingIncomeGrowth ??
      yearOverYear(operatingIncome, previousOperatingIncome),
    debtRatio:
      indexMetrics.debtRatio ??
      (Number.isFinite(equity) && equity > 0 ? percentage(liabilities, equity) : null),
    currentRatio: indexMetrics.currentRatio ?? percentage(currentAssets, currentLiabilities),
    fcfMargin:
      Number.isFinite(annualRevenue) && annualRevenue > 0
        ? percentage(freeCashFlow, annualRevenue)
        : null,
    cashConversion:
      Number.isFinite(annualNetIncome) && annualNetIncome > 0
        ? percentage(operatingCashFlow, annualNetIncome)
        : null,
    positiveIncomeYears:
      netIncomeSeries.length > 0
        ? netIncomeSeries.filter((value) => value > 0).length
        : null,
    revenueStability: revenueStability(revenueSeries),
    per: null
  };
}

export function normalizeDartDisclosure(filing) {
  const receiptNumber = String(filing?.rcept_no || "").trim();
  return {
    id: receiptNumber,
    corpCode: String(filing?.corp_code || "").trim() || null,
    stockCode: String(filing?.stock_code || "").trim() || null,
    marketClass: filing?.corp_cls || null,
    title: filing?.report_nm || "공시",
    form: filing?.report_nm || "공시",
    date: isoDate(filing?.rcept_dt),
    url: receiptNumber
      ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${receiptNumber}`
      : "https://dart.fss.or.kr/",
    source: "Open DART",
    submitter: filing?.flr_nm || null,
    note: filing?.rm || ""
  };
}

export function mergeDartDisclosures(
  existing = [],
  incoming = [],
  { retentionDays = 400, maxItems = 100, now = new Date() } = {}
) {
  const oldest = now.getTime() - retentionDays * DAY_MS;
  const byReceipt = new Map();
  for (const disclosure of [...existing, ...incoming]) {
    if (!disclosure?.id) continue;
    const date = disclosure.date ? new Date(`${disclosure.date}T00:00:00.000Z`) : null;
    if (date && !Number.isNaN(date.getTime()) && date.getTime() < oldest) continue;
    byReceipt.set(disclosure.id, disclosure);
  }
  return [...byReceipt.values()]
    .sort((left, right) => {
      const dateOrder = String(right.date || "").localeCompare(String(left.date || ""));
      return dateOrder || String(right.id).localeCompare(String(left.id));
    })
    .slice(0, maxItems);
}

export function planDartUniverseRefresh(corpRecords = [], cachedEntries = []) {
  const listed = corpRecords
    .map((record) => ({
      corpCode: String(record.corpCode || "").trim(),
      name: record.name || null,
      englishName: record.englishName || null,
      stockCode: String(record.stockCode || "").trim(),
      modifiedAt: String(record.modifiedAt || "").trim() || null
    }))
    .filter((record) => record.corpCode && record.stockCode)
    .sort((left, right) => left.corpCode.localeCompare(right.corpCode));
  const listedByCode = new Map(listed.map((record) => [record.corpCode, record]));
  const cachedByCode = new Map(cachedEntries.map((entry) => [entry.corpCode, entry]));
  const refresh = [];
  const reuse = [];

  for (const record of listed) {
    const cached = cachedByCode.get(record.corpCode);
    if (
      cached?.overviewModifiedAt === record.modifiedAt &&
      cached?.stockCode === record.stockCode &&
      cached?.corpCls
    ) {
      reuse.push({
        ...cached,
        stockCode: record.stockCode,
        legalName: record.name || cached.legalName,
        englishName: cached.englishName || record.englishName || null,
        modifiedAt: record.modifiedAt
      });
    } else {
      refresh.push({ record, cached: cached || null });
    }
  }

  const inactive = cachedEntries
    .filter((entry) => !listedByCode.has(entry.corpCode))
    .map((entry) => ({
      ...entry,
      active: false,
      inactiveReason: "stock_code_removed",
      needsRefresh: false
    }));

  return { listed, refresh, reuse, inactive, snapshotHash: hashRecords(listed) };
}

function normalizeCompanyOverview(payload, source, now) {
  const corpCls = payload?.corp_cls || null;
  return {
    corpCode: source.corpCode,
    stockCode: String(payload?.stock_code || source.stockCode || "").trim(),
    name: payload?.stock_name || payload?.corp_name || source.name,
    legalName: payload?.corp_name || source.name,
    englishName: payload?.corp_name_eng || source.englishName || null,
    corpCls,
    exchange: corpCls === "Y" ? "KOSPI" : corpCls === "K" ? "KOSDAQ" : null,
    industryCode: payload?.induty_code || null,
    fiscalMonth: payload?.acc_mt || null,
    homepage: payload?.hm_url || null,
    modifiedAt: source.modifiedAt,
    overviewModifiedAt: source.modifiedAt,
    active: MARKET_CLASSES.has(corpCls),
    inactiveReason: MARKET_CLASSES.has(corpCls) ? null : "outside_target_market",
    needsRefresh: false,
    overviewError: null,
    lastSeenAt: now,
    overviewUpdatedAt: now
  };
}

async function syncUniverse({
  apiKey,
  cacheFile,
  controller,
  fetchCorpCodes = fetchDartCorpCodes,
  minimumCachedCorpCodeCount = 2_000,
  maximumCachedCorpCodeAgeMs = DEFAULT_UNIVERSE_CACHE_MAX_AGE_MS,
  checkpointEvery = 25,
  currentTime = new Date(),
  onProgress = () => {}
}) {
  const nowDate = new Date(currentTime);
  const now = nowDate.toISOString();
  const cached = await readJson(cacheFile, {
    schemaVersion: 1,
    source: "Open DART",
    entries: []
  });
  const cachedCorpRecords = (cached.entries || [])
    .map((entry) => ({
      corpCode: String(entry?.corpCode || "").trim(),
      stockCode: String(entry?.stockCode || "").trim(),
      name: entry?.legalName || entry?.name || null,
      englishName: entry?.englishName || null,
      modifiedAt: String(entry?.modifiedAt || "").trim() || null
    }))
    .filter((record) => record.corpCode && record.stockCode);
  const cachedCorpListFetchedAt = cached.corpListFetchedAt || cached.fetchedAt || null;
  const cachedCorpListTime = new Date(cachedCorpListFetchedAt || "").getTime();
  const cachedCorpListAgeMs = nowDate.getTime() - cachedCorpListTime;
  const canResumeFromCachedCorpList =
    cachedCorpRecords.length >= minimumCachedCorpCodeCount &&
    Number.isFinite(cachedCorpListTime) &&
    cachedCorpListAgeMs >= 0 &&
    cachedCorpListAgeMs <= maximumCachedCorpCodeAgeMs;

  onProgress("Open DART 전체 고유번호 목록 확인");
  let corpRecords;
  let corpListSource = "live";
  let corpListError = null;
  let corpListFetchedAt = now;
  try {
    corpRecords = await controller.external("corpCode.xml", () => fetchCorpCodes(apiKey));
    const listedCount = corpRecords.filter(
      (record) => String(record?.corpCode || "").trim() && String(record?.stockCode || "").trim()
    ).length;
    if (listedCount < minimumCachedCorpCodeCount) {
      throw new Error(
        `DART 전체 고유번호 목록이 안전 기준보다 적습니다: ${listedCount}개`
      );
    }
  } catch (error) {
    if (!canResumeFromCachedCorpList) throw error;
    corpRecords = cachedCorpRecords;
    corpListSource = "cached_fallback";
    corpListError = safeErrorMessage(error);
    corpListFetchedAt = cachedCorpListFetchedAt;
    onProgress(
      `DART 전체 고유번호 요청 지연 · 저장된 목록 ${cachedCorpRecords.length}개로 안전하게 재개`
    );
  }
  const plan = planDartUniverseRefresh(corpRecords, cached.entries || []);
  const entriesByCode = new Map();

  for (const entry of [...plan.reuse, ...plan.inactive]) {
    entriesByCode.set(entry.corpCode, {
      ...entry,
      lastSeenAt: plan.inactive.some((item) => item.corpCode === entry.corpCode)
        ? entry.lastSeenAt
        : now
    });
  }
  for (const { record, cached: previous } of plan.refresh) {
    entriesByCode.set(record.corpCode, {
      ...(previous || {}),
      ...record,
      corpCode: record.corpCode,
      stockCode: record.stockCode,
      active: previous?.active || false,
      needsRefresh: true,
      overviewModifiedAt: previous?.overviewModifiedAt || null,
      lastSeenAt: now
    });
  }

  let processed = 0;
  const persist = async (complete = false) => {
    const entries = [...entriesByCode.values()].sort((left, right) =>
      left.corpCode.localeCompare(right.corpCode)
    );
    const pendingOverviewCount = entries.filter((entry) => entry.needsRefresh).length;
    const actuallyComplete = complete && pendingOverviewCount === 0;
    await writeJsonAtomic(cacheFile, {
      schemaVersion: 1,
      source: "Open DART",
      fetchedAt: now,
      corpListFetchedAt,
      corpListSource,
      corpListError,
      completedAt: actuallyComplete ? new Date().toISOString() : cached.completedAt || null,
      complete: actuallyComplete,
      snapshotHash: plan.snapshotHash,
      pendingOverviewCount,
      entries
    });
  };

  try {
    for (const item of plan.refresh) {
      const { record, cached: previous } = item;
      try {
        const payload = await controller.json("company.json", { corp_code: record.corpCode });
        entriesByCode.set(record.corpCode, normalizeCompanyOverview(payload, record, now));
      } catch (error) {
        if (error instanceof DartRequestLimitError) throw error;
        entriesByCode.set(record.corpCode, {
          ...(previous || {}),
          ...record,
          corpCode: record.corpCode,
          stockCode: record.stockCode,
          active: previous?.active || false,
          needsRefresh: true,
          overviewError: safeErrorMessage(error),
          lastSeenAt: now,
          overviewModifiedAt: previous?.overviewModifiedAt || null
        });
      }
      processed += 1;
      if (processed % checkpointEvery === 0) {
        onProgress(`DART 기업개황 ${processed}/${plan.refresh.length} (체크포인트 저장)`);
        await persist(false);
      }
    }
  } catch (error) {
    await persist(false);
    throw error;
  }

  const pendingOverviewCount = [...entriesByCode.values()].filter(
    (entry) => entry.needsRefresh
  ).length;
  if (pendingOverviewCount > 0) {
    await persist(false);
    throw new Error(
      `DART 기업개황 ${pendingOverviewCount}개를 확인하지 못했습니다. 체크포인트에서 다시 실행하세요.`
    );
  }

  await persist(true);
  const finalCache = await readJson(cacheFile, {});
  return {
    ...finalCache,
    activeEntries: (finalCache.entries || []).filter(
      (entry) => entry.active && MARKET_CLASSES.has(entry.corpCls)
    )
  };
}

function splitDateRanges(start, end, maximumDays = 85) {
  const ranges = [];
  let cursor = new Date(start);
  const final = new Date(end);
  while (cursor <= final) {
    const rangeEnd = new Date(Math.min(final.getTime(), cursor.getTime() + maximumDays * DAY_MS));
    ranges.push({ start: new Date(cursor), end: rangeEnd });
    cursor = new Date(rangeEnd.getTime() + DAY_MS);
  }
  return ranges;
}

async function syncDisclosures({
  cacheFile,
  controller,
  runId,
  now,
  lookbackDays = 370,
  overlapDays = 3,
  checkpointEveryPages = 10,
  onProgress = () => {}
}) {
  const cache = await readJson(cacheFile, {
    schemaVersion: 1,
    source: "Open DART",
    filingsByCorpCode: {},
    completedQueries: {}
  });
  if (cache.runId !== runId) cache.completedQueries = {};
  cache.runId = runId;

  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const previousThrough = parseIsoDate(cache.through);
  const earliest = new Date(end.getTime() - lookbackDays * DAY_MS);
  const incremental = previousThrough
    ? new Date(previousThrough.getTime() - overlapDays * DAY_MS)
    : earliest;
  const start = incremental < earliest ? earliest : incremental;
  const ranges = splitDateRanges(start, end);

  for (const marketClass of ["Y", "K"]) {
    for (const range of ranges) {
      const baseKey = `${marketClass}:${compactDate(range.start)}:${compactDate(range.end)}`;
      const progress = cache.completedQueries[baseKey] || { nextPage: 1, complete: false };
      if (progress.complete) continue;
      let page = progress.nextPage || 1;
      let totalPages = page;

      do {
        const payload = await controller.json(
          "list.json",
          {
            bgn_de: compactDate(range.start),
            end_de: compactDate(range.end),
            last_reprt_at: "N",
            corp_cls: marketClass,
            sort: "date",
            sort_mth: "asc",
            page_no: page,
            page_count: 100
          },
          { allowNoData: true }
        );
        totalPages = Number.parseInt(payload?.total_page || "1", 10) || 1;
        const pageByCorp = new Map();
        for (const rawFiling of payload?.list || []) {
          const filing = normalizeDartDisclosure(rawFiling);
          if (!filing.corpCode) continue;
          if (!pageByCorp.has(filing.corpCode)) pageByCorp.set(filing.corpCode, []);
          pageByCorp.get(filing.corpCode).push(filing);
        }
        for (const [corpCode, filings] of pageByCorp) {
          cache.filingsByCorpCode[corpCode] = mergeDartDisclosures(
            cache.filingsByCorpCode[corpCode] || [],
            filings,
            { now }
          );
        }
        page += 1;
        cache.completedQueries[baseKey] = {
          nextPage: page,
          totalPages,
          complete: page > totalPages
        };
        cache.updatedAt = new Date().toISOString();
        const completedPage = page - 1;
        if (completedPage % checkpointEveryPages === 0 || page > totalPages) {
          await writeJsonAtomic(cacheFile, cache);
        }
        onProgress(`DART 공시 ${baseKey} ${Math.min(page - 1, totalPages)}/${totalPages}`);
      } while (page <= totalPages);
    }
  }

  cache.through = isoDate(compactDate(end));
  cache.completedAt = new Date().toISOString();
  await writeJsonAtomic(cacheFile, cache);
  return cache;
}

function batchHash(companies) {
  return createHash("sha1")
    .update(companies.map((company) => company.corpCode).join(","))
    .digest("hex")
    .slice(0, 12);
}

async function fetchBatchWithIsolation({
  controller,
  endpoint,
  companies,
  parameters,
  normalize,
  canSplit = true
}) {
  try {
    const payload = await controller.json(
      endpoint,
      {
        ...parameters,
        corp_code: companies.map((company) => company.corpCode).join(",")
      },
      { allowNoData: true, timeoutMs: DEFAULT_DART_FINANCIAL_TIMEOUT_MS }
    );
    return { normalized: normalize(payload?.list || []), errors: {} };
  } catch (error) {
    if (error instanceof DartRequestLimitError) throw error;
    const splittable =
      canSplit &&
      companies.length > 1 &&
      error instanceof DartApiError &&
      ["100", "101"].includes(error.code);
    if (splittable) {
      const midpoint = Math.ceil(companies.length / 2);
      const left = await fetchBatchWithIsolation({
        controller,
        endpoint,
        companies: companies.slice(0, midpoint),
        parameters,
        normalize,
        canSplit
      });
      const right = await fetchBatchWithIsolation({
        controller,
        endpoint,
        companies: companies.slice(midpoint),
        parameters,
        normalize,
        canSplit
      });
      return {
        normalized:
          endpoint === "fnlttCmpnyIndx.json"
            ? mergeDartFinancialIndices(left.normalized, right.normalized)
            : { ...left.normalized, ...right.normalized },
        errors: { ...left.errors, ...right.errors }
      };
    }
    const systemicCodes = new Set([
      "NETWORK",
      "010",
      "011",
      "012",
      "020",
      "800",
      "900",
      "901"
    ]);
    if (!(error instanceof DartApiError) || systemicCodes.has(error.code)) throw error;
    return {
      normalized: {},
      errors: Object.fromEntries(
        companies.map((company) => [company.corpCode, safeErrorMessage(error)])
      )
    };
  }
}

async function syncFinancialBatches({
  cacheFile,
  controller,
  universe,
  runId,
  businessYear,
  reportCode,
  batchSize = DEFAULT_DART_FINANCIAL_BATCH_SIZE,
  onProgress = () => {}
}) {
  const periodKey = `${businessYear}:${reportCode}`;
  const universeHash = hashRecords(universe);
  const cache = await readJson(cacheFile, {
    schemaVersion: 1,
    source: "Open DART",
    accountsByCorpCode: {},
    indicesByCorpCode: {},
    errorsByCorpCode: {},
    completedJobs: {}
  });

  if (cache.periodKey !== periodKey) {
    cache.accountsByCorpCode = {};
    cache.indicesByCorpCode = {};
    cache.errorsByCorpCode = {};
    cache.completedJobs = {};
  } else if (cache.runId !== runId || cache.universeHash !== universeHash) {
    cache.completedJobs = {};
    cache.errorsByCorpCode = {};
  }
  cache.periodKey = periodKey;
  cache.runId = runId;
  cache.universeHash = universeHash;
  cache.businessYear = String(businessYear);
  cache.reportCode = String(reportCode);

  const companies = [...universe].sort((left, right) =>
    left.corpCode.localeCompare(right.corpCode)
  );
  const batches = chunkDartCompanies(companies, batchSize);
  const stockToCorp = new Map(companies.map((company) => [company.stockCode, company.corpCode]));

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const hash = batchHash(batch);
    const accountJob = `accounts:${periodKey}:${batchIndex}:${hash}`;
    if (!cache.completedJobs[accountJob]) {
      const result = await fetchBatchWithIsolation({
        controller,
        endpoint: "fnlttMultiAcnt.json",
        companies: batch,
        parameters: { bsns_year: businessYear, reprt_code: reportCode },
        normalize: normalizeDartMainAccounts
      });
      for (const [stockCode, record] of Object.entries(result.normalized)) {
        const corpCode = stockToCorp.get(stockCode);
        if (corpCode) cache.accountsByCorpCode[corpCode] = record;
      }
      Object.assign(cache.errorsByCorpCode, result.errors);
      cache.completedJobs[accountJob] = true;
      cache.updatedAt = new Date().toISOString();
      await writeJsonAtomic(cacheFile, cache);
      onProgress(`DART 주요계정 배치 ${batchIndex + 1}/${batches.length}`);
    }

    for (const category of INDEX_CATEGORIES) {
      const indexJob = `indices:${category}:${periodKey}:${batchIndex}:${hash}`;
      if (cache.completedJobs[indexJob]) continue;
      const result = await fetchBatchWithIsolation({
        controller,
        endpoint: "fnlttCmpnyIndx.json",
        companies: batch,
        parameters: {
          bsns_year: businessYear,
          reprt_code: reportCode,
          idx_cl_code: category
        },
        normalize: normalizeDartFinancialIndices
      });
      for (const [key, record] of Object.entries(result.normalized)) {
        const corpCode = record.corpCode || stockToCorp.get(record.stockCode) || key;
        if (!corpCode) continue;
        cache.indicesByCorpCode[corpCode] = mergeDartFinancialIndices(
          { [corpCode]: cache.indicesByCorpCode[corpCode] || {} },
          { [corpCode]: record }
        )[corpCode];
      }
      Object.assign(cache.errorsByCorpCode, result.errors);
      cache.completedJobs[indexJob] = true;
      cache.updatedAt = new Date().toISOString();
      await writeJsonAtomic(cacheFile, cache);
      onProgress(
        `DART 재무지표 ${category} 배치 ${batchIndex + 1}/${batches.length}`
      );
    }
  }

  cache.completedAt = new Date().toISOString();
  await writeJsonAtomic(cacheFile, cache);
  return cache;
}

async function fetchDartCashFlowStatement({
  controller,
  company,
  businessYear,
  reportCode,
  statementBasis = null
}) {
  const parameters = {
    corp_code: company.corpCode,
    bsns_year: businessYear,
    reprt_code: reportCode
  };
  const requestedBases = ["CFS", "OFS"].includes(statementBasis)
    ? [statementBasis]
    : ["CFS", "OFS"];
  for (const basis of requestedBases) {
    const payload = await controller.json(
      "fnlttSinglAcntAll.json",
      { ...parameters, fs_div: basis },
      { allowNoData: true, timeoutMs: DEFAULT_DART_FINANCIAL_TIMEOUT_MS }
    );
    if (!Array.isArray(payload?.list) || payload.list.length === 0) continue;
    return normalizeDartCashFlowStatement(payload.list, {
      corpCode: company.corpCode,
      statementBasis: basis,
      businessYear,
      reportCode
    });
  }
  return null;
}

function hasUsefulDartCashFlowRecord(record) {
  return Object.values(record?.accounts || {}).some((account) =>
    Number.isFinite(account?.value)
  );
}

function dartCashFlowCacheIsFresh({
  cache,
  corpCode,
  annualAccounts,
  currentTime,
  refreshMaxAgeMs
}) {
  const record = cache.recordsByCorpCode?.[corpCode] || null;
  if (!cache.completedCorpCodes?.[corpCode] || !hasUsefulDartCashFlowRecord(record)) {
    return false;
  }
  if (
    String(record.businessYear || "") !== String(annualAccounts.businessYear || "") ||
    String(record.reportCode || "") !== "11011" ||
    String(record.statementBasis || "") !== String(annualAccounts.statementBasis || "") ||
    normalizedCurrency(record.currency) !== normalizedCurrency(annualAccounts.currency)
  ) {
    return false;
  }

  const expectedFilingId = String(annualAccounts.filingId || "");
  const cachedFilingId = String(
    cache.sourceFilingIdsByCorpCode?.[corpCode] || record.filingId || ""
  );
  if (expectedFilingId && cachedFilingId !== expectedFilingId) return false;

  const fetchedAt = new Date(cache.fetchedAtByCorpCode?.[corpCode] || "").getTime();
  const now = new Date(currentTime).getTime();
  const age = now - fetchedAt;
  return (
    Number.isFinite(fetchedAt) &&
    Number.isFinite(now) &&
    age >= 0 &&
    age <= refreshMaxAgeMs
  );
}

async function syncDartCashFlowStatements({
  cacheFile,
  controller,
  universe,
  annualAccountsByCorpCode = {},
  businessYear,
  reportCode = "11011",
  checkpointEvery = 10,
  currentTime = new Date(),
  refreshMaxAgeMs = DEFAULT_DART_CASH_FLOW_REFRESH_MAX_AGE_MS,
  onProgress = () => {}
}) {
  const periodKey = `${businessYear}:${reportCode}`;
  const cache = await readJson(cacheFile, {
    schemaVersion: 2,
    source: "Open DART fnlttSinglAcntAll",
    recordsByCorpCode: {},
    completedCorpCodes: {},
    errorsByCorpCode: {},
    fetchedAtByCorpCode: {},
    sourceFilingIdsByCorpCode: {}
  });
  if (cache.schemaVersion !== 2 || cache.periodKey !== periodKey) {
    cache.schemaVersion = 2;
    cache.recordsByCorpCode = {};
    cache.completedCorpCodes = {};
    cache.errorsByCorpCode = {};
    cache.fetchedAtByCorpCode = {};
    cache.sourceFilingIdsByCorpCode = {};
  }
  cache.fetchedAtByCorpCode ||= {};
  cache.sourceFilingIdsByCorpCode ||= {};
  cache.periodKey = periodKey;
  cache.businessYear = String(businessYear);
  cache.reportCode = String(reportCode);

  const companies = [...universe].sort((left, right) =>
    left.corpCode.localeCompare(right.corpCode)
  );
  let changedSinceCheckpoint = 0;
  let completedThisRun = 0;
  const systemicCodes = new Set([
    "NETWORK",
    "010",
    "011",
    "012",
    "020",
    "800",
    "900",
    "901"
  ]);

  for (const company of companies) {
    const annualAccounts = annualAccountsByCorpCode[company.corpCode] || null;
    const eligibleAnnualAccounts =
      annualAccounts &&
      String(annualAccounts.businessYear || "") === String(businessYear) &&
      String(annualAccounts.reportCode || "") === "11011" &&
      ["CFS", "OFS"].includes(String(annualAccounts.statementBasis || "")) &&
      Boolean(normalizedCurrency(annualAccounts.currency));
    if (!eligibleAnnualAccounts) continue;
    if (
      dartCashFlowCacheIsFresh({
        cache,
        corpCode: company.corpCode,
        annualAccounts,
        currentTime,
        refreshMaxAgeMs
      })
    ) {
      continue;
    }
    try {
      const record = await fetchDartCashFlowStatement({
        controller,
        company,
        businessYear,
        reportCode,
        statementBasis: annualAccounts.statementBasis
      });
      cache.recordsByCorpCode[company.corpCode] = record;
      cache.completedCorpCodes[company.corpCode] = true;
      cache.fetchedAtByCorpCode[company.corpCode] = new Date(currentTime).toISOString();
      cache.sourceFilingIdsByCorpCode[company.corpCode] =
        annualAccounts.filingId || record?.filingId || null;
      delete cache.errorsByCorpCode[company.corpCode];
    } catch (error) {
      if (error instanceof DartRequestLimitError) throw error;
      if (!(error instanceof DartApiError) || systemicCodes.has(error.code)) throw error;
      cache.errorsByCorpCode[company.corpCode] = safeErrorMessage(error);
      delete cache.completedCorpCodes[company.corpCode];
    }
    completedThisRun += 1;
    changedSinceCheckpoint += 1;
    if (changedSinceCheckpoint >= checkpointEvery) {
      cache.updatedAt = new Date().toISOString();
      await writeJsonAtomic(cacheFile, cache);
      changedSinceCheckpoint = 0;
      onProgress(
        `DART 연간 현금흐름 ${Object.keys(cache.completedCorpCodes).length}/${companies.length}`
      );
    }
  }

  cache.completedAt = new Date().toISOString();
  cache.completedThisRun = completedThisRun;
  await writeJsonAtomic(cacheFile, cache);
  return cache;
}

function requestedFinancialPeriods(now, options) {
  if (options.businessYear !== undefined || options.reportCode !== undefined) {
    return [
      {
        businessYear: String(options.businessYear || defaultDartAnnualBusinessYear(now)),
        reportCode: String(options.reportCode || "11011"),
        roles: ["latest"]
      }
    ];
  }

  const planned = defaultDartFinancialPeriods(now);
  const unique = new Map();
  for (const period of [planned.latest, planned.annualFallback]) {
    const key = `${period.businessYear}:${period.reportCode}`;
    const existing = unique.get(key);
    if (existing) {
      if (!existing.roles.includes(period.role)) existing.roles.push(period.role);
    } else {
      unique.set(key, {
        businessYear: String(period.businessYear),
        reportCode: String(period.reportCode),
        roles: [period.role]
      });
    }
  }
  return [...unique.values()];
}

function financialCacheFile(dataDir, period) {
  if (period.reportCode === "11011") return path.join(dataDir, "financials.json");
  return path.join(
    dataDir,
    `financials-${period.businessYear}-${period.reportCode}.json`
  );
}

function cashFlowCacheFile(dataDir, businessYear) {
  return path.join(dataDir, `cashflows-${businessYear}-11011.json`);
}

export function hasDartCoreFinancials(mainAccounts) {
  return (
    Number.isFinite(mainAccounts?.accounts?.revenue?.current) &&
    Number.isFinite(mainAccounts?.accounts?.netIncome?.current)
  );
}

/**
 * Pick one internally consistent period for a company. Never mix account or
 * index values from different periods. A partial latest report is retained only
 * when the annual fallback has no account data either.
 */
export function selectDartFinancialPeriod(periodResults, corpCode) {
  const latest =
    periodResults.find((result) => result.period.roles.includes("latest")) ||
    periodResults[0] ||
    null;
  const annual =
    periodResults.find((result) => result.period.roles.includes("annual_fallback")) ||
    null;
  const accountsFor = (result) => result?.cache?.accountsByCorpCode?.[corpCode] || null;

  let selected = latest || annual;
  let selection = "latest";
  if (!hasDartCoreFinancials(accountsFor(latest)) && annual && annual !== latest) {
    if (accountsFor(annual) || !accountsFor(latest)) {
      selected = annual;
      selection = "annual_fallback";
    }
  }

  return {
    period: selected?.period || null,
    mainAccounts: accountsFor(selected),
    continuityAccounts: accountsFor(annual) || accountsFor(selected),
    continuityPeriod: (accountsFor(annual) ? annual : selected)?.period || null,
    financialIndices:
      selected?.cache?.indicesByCorpCode?.[corpCode] || null,
    financialError: periodResults
      .map((result) => {
        const error = result.cache?.errorsByCorpCode?.[corpCode];
        return error
          ? `${result.period.businessYear}:${result.period.reportCode} ${error}`
          : null;
      })
      .filter(Boolean)
      .join(" | ") || null,
    selection
  };
}

function buildHistory(mainAccounts) {
  const revenue = mainAccounts?.accounts?.revenue;
  const operatingIncome = mainAccounts?.accounts?.operatingIncome;
  if (!revenue) return [];
  return [
    {
      label: revenue.twoYearsAgoLabel || "Y-2",
      revenue: revenue.twoYearsAgo,
      operatingIncome: operatingIncome?.twoYearsAgo ?? null
    },
    {
      label: revenue.previousLabel || "Y-1",
      revenue: revenue.previous,
      operatingIncome: operatingIncome?.previous ?? null
    },
    {
      label: revenue.currentLabel || "Y",
      revenue: revenue.current,
      operatingIncome: operatingIncome?.current ?? null
    }
  ].filter((point) => Number.isFinite(point.revenue));
}

function deriveRiskFlags(disclosures) {
  const material = disclosures.find((filing) =>
    /부도|회생절차|상장폐지|영업정지|해산사유|감사의견.*거절|의견거절/.test(filing.title)
  );
  return material
    ? [
        {
          level: "critical",
          code: "material_event",
          label: "중대 위험 관련 공시",
          sourceUrl: material.url
        }
      ]
    : [];
}

function dartModelApplicability(universeEntry) {
  const industryCode = String(universeEntry.industryCode || "").replace(/\D/g, "");
  const name = String(universeEntry.name || universeEntry.legalName || "");
  if (/^(64|65|66)/.test(industryCode)) {
    return {
      status: "not_applicable",
      reason: "금융·보험업에는 업종별 평가모델이 필요합니다."
    };
  }
  if (/리츠|부동산투자회사|기업인수목적|스팩/.test(name)) {
    return {
      status: "not_applicable",
      reason: "REIT·SPAC에는 일반 비금융회사 평가모델을 적용하지 않습니다."
    };
  }
  return { status: "applicable", reason: null };
}

function dartFiscalPeriodEnd(businessYear, fiscalMonth = "12") {
  const year = Number.parseInt(businessYear, 10);
  const month = Number.parseInt(fiscalMonth, 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return String(businessYear || "") || null;
  }
  const end = new Date(Date.UTC(year, month, 0));
  return `${year}-${String(month).padStart(2, "0")}-${String(end.getUTCDate()).padStart(2, "0")}`;
}

export function buildDartMarketCompany({
  universeEntry,
  mainAccounts,
  continuityAccounts = mainAccounts,
  continuityPeriod = null,
  cashFlowStatement = null,
  financialIndices,
  disclosures = [],
  financialError = null,
  cashFlowError = null,
  businessYear,
  reportCode,
  financialPeriodRole = "latest",
  now = new Date()
}) {
  const cashFlowCompatibility = evaluateDartCashFlowCompatibility(
    continuityAccounts,
    continuityPeriod,
    cashFlowStatement
  );
  const usableCashFlowStatement = cashFlowCompatibility.compatible
    ? cashFlowStatement
    : null;
  const metrics = deriveDartMarketMetrics(
    mainAccounts,
    financialIndices,
    continuityAccounts,
    cashFlowStatement,
    continuityPeriod
  );
  const historyRaw = buildHistory(continuityAccounts);
  const historyCurrency = continuityAccounts?.currency || mainAccounts?.currency;
  const divisor = historyCurrency === "KRW" || !historyCurrency ? 1_000_000_000 : 1;
  const history = historyRaw.map((point) => ({
    ...point,
    revenue: point.revenue / divisor,
    operatingIncome: Number.isFinite(point.operatingIncome)
      ? point.operatingIncome / divisor
      : null
  }));
  const filingId = mainAccounts?.filingId || null;
  const hasCoreFinancials = hasDartCoreFinancials(mainAccounts);
  const dataStatus = hasCoreFinancials ? "live" : "insufficient_data";
  const modelApplicability = dartModelApplicability(universeEntry);
  const evaluationStatus =
    modelApplicability.status === "not_applicable" ? "not_applicable" : dataStatus;
  const errors = [universeEntry.overviewError, financialError, cashFlowError].filter(Boolean);
  const annualContinuityAccounts =
    String(continuityPeriod?.reportCode || "") === "11011" &&
    String(continuityAccounts?.reportCode || "") === "11011" &&
    String(continuityAccounts?.businessYear || continuityPeriod?.businessYear || "") ===
      String(continuityPeriod?.businessYear || "")
      ? continuityAccounts
      : null;
  const annualOperatingCashFlow =
    usableCashFlowStatement?.accounts?.operatingCashFlow?.value ?? null;
  const annualRawCapex = usableCashFlowStatement?.accounts?.capex?.value ?? null;
  const annualCapex = Number.isFinite(annualRawCapex) ? Math.abs(annualRawCapex) : null;
  const annualFreeCashFlow =
    Number.isFinite(annualOperatingCashFlow) && Number.isFinite(annualCapex)
      ? annualOperatingCashFlow - annualCapex
      : null;
  const annualBusinessYear = annualContinuityAccounts
    ? continuityPeriod.businessYear
    : null;
  const financials = {
    latest: {
      periodEnd: annualBusinessYear
        ? dartFiscalPeriodEnd(annualBusinessYear, universeEntry.fiscalMonth)
        : null,
      currency: annualContinuityAccounts?.currency || mainAccounts?.currency || "KRW",
      revenue: accountAmount(annualContinuityAccounts, "revenue"),
      operatingIncome: accountAmount(annualContinuityAccounts, "operatingIncome"),
      netIncome: accountAmount(annualContinuityAccounts, "netIncome"),
      assets: accountAmount(annualContinuityAccounts, "assets"),
      liabilities: accountAmount(annualContinuityAccounts, "liabilities"),
      equity: accountAmount(annualContinuityAccounts, "equity"),
      currentAssets: accountAmount(annualContinuityAccounts, "currentAssets"),
      currentLiabilities: accountAmount(annualContinuityAccounts, "currentLiabilities"),
      operatingCashFlow: annualOperatingCashFlow,
      capex: annualCapex,
      intangibleCapex: usableCashFlowStatement?.accounts?.intangibleCapex?.value ?? null,
      freeCashFlow: annualFreeCashFlow,
      epsBasic: null,
      epsDiluted: null,
      sharesOutstanding: null,
      sharesDate: null
    }
  };

  return {
    id: `KR-${universeEntry.stockCode}`,
    providerId: universeEntry.corpCode,
    name: universeEntry.name || universeEntry.legalName,
    nameEn: universeEntry.englishName || null,
    ticker: universeEntry.stockCode,
    country: "KR",
    exchange: universeEntry.exchange,
    sector: universeEntry.industryCode ? `DART 업종 ${universeEntry.industryCode}` : "미분류",
    currency: mainAccounts?.currency || "KRW",
    fiscalMonth: universeEntry.fiscalMonth || null,
    period: `${businessYear} ${REPORT_LABELS[reportCode] || reportCode}`,
    statementBasis: mainAccounts
      ? `K-IFRS · ${mainAccounts.statementBasis === "CFS" ? "연결재무제표" : "별도재무제표"}`
      : "K-IFRS · 재무자료 대기",
    dataMode: evaluationStatus,
    dataStatus,
    evaluationStatus,
    analysisStatus: evaluationStatus,
    modelApplicability,
    cashFlowIssues: cashFlowCompatibility.reasons,
    metrics,
    financials,
    history,
    historyUnit: divisor === 1_000_000_000 ? "KRW billion" : historyCurrency || null,
    disclosures,
    latestDisclosure: disclosures[0] || null,
    riskFlags: deriveRiskFlags(disclosures),
    risks: modelApplicability.reason ? [modelApplicability.reason] : [],
    sourceUrl: filingId
      ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${filingId}`
      : "https://dart.fss.or.kr/",
    lineage: {
      provider: "Open DART",
      corpCode: universeEntry.corpCode,
      filingId,
      businessYear: String(businessYear),
      reportCode: String(reportCode),
      periodSelection: financialPeriodRole,
      continuityBusinessYear: continuityPeriod?.businessYear || String(businessYear),
      continuityReportCode: continuityPeriod?.reportCode || String(reportCode),
      taxonomy: "K-IFRS",
      statementBasis: mainAccounts?.statementBasis || null,
      accountNames: Object.fromEntries(
        Object.entries(mainAccounts?.accounts || {}).map(([key, account]) => [
          key,
          account?.accountName || null
        ])
      ),
      indexCodes: Object.keys(financialIndices?.indices || {}),
      cashFlow: cashFlowStatement
        ? {
            businessYear: cashFlowStatement.businessYear,
            reportCode: cashFlowStatement.reportCode,
            statementBasis: cashFlowStatement.statementBasis,
            filingId: cashFlowStatement.filingId,
            accounts: Object.fromEntries(
              Object.entries(cashFlowStatement.accounts || {}).map(([key, account]) => [
                key,
                account
                  ? { accountId: account.accountId, accountName: account.accountName }
                  : null
              ])
            ),
            freeCashFlowFormula: "operatingCashFlow - abs(PPE capex)",
            usedForMetrics: Boolean(usableCashFlowStatement),
            issues: cashFlowCompatibility.reasons
          }
        : null
    },
    validation: {
      score: mainAccounts && financialIndices ? 90 : mainAccounts ? 75 : 35,
      checkedAt: now.toISOString()
    },
    stale: false,
    syncStatus:
      evaluationStatus === "not_applicable"
        ? "not_applicable"
        : dataStatus === "insufficient_data"
          ? "insufficient_data"
          : errors.length
            ? "partial"
            : "ok",
    syncError: errors.join(" | ") || null,
    updatedAt: now.toISOString()
  };
}

export async function syncDartMarket(config, options = {}) {
  const apiKey = config?.dartApiKey?.trim() || options.apiKey?.trim() || "";
  if (!apiKey) throw new Error("DART_API_KEY가 설정되지 않았습니다.");
  const now = options.now || new Date();
  const runId = options.runId || kstRunId(now);
  const financialPeriods = requestedFinancialPeriods(now, options);
  const latestFinancialPeriod =
    financialPeriods.find((period) => period.roles.includes("latest")) ||
    financialPeriods[0];
  const businessYear = latestFinancialPeriod.businessYear;
  const reportCode = latestFinancialPeriod.reportCode;
  const dataDir =
    options.dataDir ||
    path.join(config?.rootDir || process.cwd(), "data", "dart-market");
  const paths = {
    universe: path.join(dataDir, "universe.json"),
    disclosures: path.join(dataDir, "disclosures.json"),
    financials: path.join(dataDir, "financials.json"),
    output: options.outputFile || path.join(dataDir, "companies.json")
  };
  const onProgress = options.onProgress || (() => {});
  const controller = new DartRequestController({
    apiKey,
    minIntervalMs: options.minIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS,
    maxRequests: options.maxRequests ?? DEFAULT_REQUEST_BUDGET,
    fetchJsonImpl: options.fetchJsonImpl || fetchJson,
    onProgress
  });

  await mkdir(dataDir, { recursive: true });
  const universeCache = await syncUniverse({
    apiKey,
    cacheFile: paths.universe,
    controller,
    fetchCorpCodes: options.fetchCorpCodes || fetchDartCorpCodes,
    minimumCachedCorpCodeCount: options.minimumUniverseCount ?? 2_000,
    maximumCachedCorpCodeAgeMs:
      options.maximumCachedCorpCodeAgeMs ?? DEFAULT_UNIVERSE_CACHE_MAX_AGE_MS,
    checkpointEvery: options.universeCheckpointEvery || 25,
    currentTime: now,
    onProgress
  });
  const activeUniverse = universeCache.activeEntries;
  const minimumUniverseCount = options.minimumUniverseCount ?? 2_000;
  const minimumKospiCount = options.minimumKospiCount ?? 500;
  const minimumKosdaqCount = options.minimumKosdaqCount ?? 1_000;
  const kospiUniverseCount = activeUniverse.filter((entry) => entry.corpCls === "Y").length;
  const kosdaqUniverseCount = activeUniverse.filter((entry) => entry.corpCls === "K").length;
  if (
    activeUniverse.length < minimumUniverseCount ||
    kospiUniverseCount < minimumKospiCount ||
    kosdaqUniverseCount < minimumKosdaqCount
  ) {
    throw new Error(
      `DART 전체시장 수가 안전 기준보다 적습니다: 전체 ${activeUniverse.length}, KOSPI ${kospiUniverseCount}, KOSDAQ ${kosdaqUniverseCount}`
    );
  }
  onProgress(`DART 대상시장 확정: ${activeUniverse.length}개사`);

  const disclosureCache = await syncDisclosures({
    cacheFile: paths.disclosures,
    controller,
    runId,
    now,
    lookbackDays: options.disclosureLookbackDays || 370,
    overlapDays: options.disclosureOverlapDays || 3,
    checkpointEveryPages: options.disclosureCheckpointEveryPages || 10,
    onProgress
  });

  const financialResults = [];
  for (const period of financialPeriods) {
    const cache = await syncFinancialBatches({
      cacheFile: financialCacheFile(dataDir, period),
      controller,
      universe: activeUniverse,
      runId,
      businessYear: period.businessYear,
      reportCode: period.reportCode,
      batchSize: options.batchSize || DEFAULT_DART_FINANCIAL_BATCH_SIZE,
      onProgress
    });
    financialResults.push({ period, cache });
  }

  const annualPeriod =
    financialPeriods.find((period) => period.roles.includes("annual_fallback")) ||
    financialPeriods.find((period) => period.reportCode === "11011") ||
    null;
  const annualFinancialResult = annualPeriod
    ? financialResults.find(
        (result) =>
          String(result.period.businessYear) === String(annualPeriod.businessYear) &&
          String(result.period.reportCode) === "11011"
      )
    : null;
  const annualAccountsByCorpCode =
    annualFinancialResult?.cache?.accountsByCorpCode || {};
  const cashFlowEnabled =
    options.enableCashFlowEnrichment ?? activeUniverse.length >= 2_000;
  let cashFlowSyncError = null;
  let cashFlowCache = {
    recordsByCorpCode: {},
    errorsByCorpCode: {},
    completedCorpCodes: {}
  };
  if (cashFlowEnabled && annualPeriod) {
    const cacheFile = cashFlowCacheFile(dataDir, annualPeriod.businessYear);
    try {
      cashFlowCache = await syncDartCashFlowStatements({
        cacheFile,
        controller,
        universe: activeUniverse,
        annualAccountsByCorpCode,
        businessYear: annualPeriod.businessYear,
        reportCode: "11011",
        checkpointEvery: options.cashFlowCheckpointEvery || 10,
        currentTime: now,
        refreshMaxAgeMs:
          options.cashFlowRefreshMaxAgeMs ??
          DEFAULT_DART_CASH_FLOW_REFRESH_MAX_AGE_MS,
        onProgress
      });
    } catch (error) {
      cashFlowSyncError = safeErrorMessage(error);
      cashFlowCache = await readJson(cacheFile, cashFlowCache);
      onProgress("DART 현금흐름 일부 보존: " + cashFlowSyncError);
    }
  }

  const companies = activeUniverse.map((entry) => {
    const disclosures = mergeDartDisclosures(
      [],
      disclosureCache.filingsByCorpCode?.[entry.corpCode] || [],
      { maxItems: options.maxDisclosuresPerCompany || 20, now }
    );
    const financial = selectDartFinancialPeriod(financialResults, entry.corpCode);
    return buildDartMarketCompany({
      universeEntry: entry,
      mainAccounts: financial.mainAccounts,
      continuityAccounts: financial.continuityAccounts,
      continuityPeriod: financial.continuityPeriod,
      cashFlowStatement: cashFlowCache.recordsByCorpCode?.[entry.corpCode] || null,
      financialIndices: financial.financialIndices,
      disclosures,
      financialError: financial.financialError,
      cashFlowError: cashFlowCache.errorsByCorpCode?.[entry.corpCode] || null,
      businessYear: financial.period?.businessYear || businessYear,
      reportCode: financial.period?.reportCode || reportCode,
      financialPeriodRole: financial.selection,
      now
    });
  });
  const liveFinancialCount = companies.filter(
    (company) => company.dataMode === "live"
  ).length;
  const insufficientDataCount = companies.length - liveFinancialCount;
  const latestPeriodCount = companies.filter(
    (company) => company.lineage.periodSelection === "latest"
  ).length;
  const annualFallbackCount = companies.filter(
    (company) => company.lineage.periodSelection === "annual_fallback"
  ).length;
  const cashFlowCoverage = companies.filter((company) =>
    Number.isFinite(company.financials?.latest?.operatingCashFlow)
  ).length;
  const fcfCoverage = companies.filter((company) =>
    Number.isFinite(company.financials?.latest?.freeCashFlow)
  ).length;

  const dataset = {
    meta: {
      schemaVersion: 1,
      provider: "Open DART",
      dataMode:
        insufficientDataCount === 0
          ? "live"
          : liveFinancialCount > 0
            ? "mixed"
            : "insufficient_data",
      market: "KR",
      updatedAt: now.toISOString(),
      runId,
      businessYear,
      reportCode,
      financialPeriods: financialPeriods.map((period) => ({
        businessYear: period.businessYear,
        reportCode: period.reportCode,
        roles: period.roles
      })),
      latestPeriodCount,
      annualFallbackCount,
      cashFlowEnabled,
      cashFlowCoverage,
      fcfCoverage,
      cashFlowSyncError,
      universeCount: companies.length,
      kospiCount: kospiUniverseCount,
      kosdaqCount: kosdaqUniverseCount,
      liveFinancialCount,
      insufficientDataCount,
      requestCount: controller.requestCount,
      requestBudget: controller.maxRequests,
      requestIntervalMs: controller.minIntervalMs,
      universeSnapshotHash: universeCache.snapshotHash,
      universeComplete: (universeCache.pendingOverviewCount || 0) === 0,
      universePendingCount: universeCache.pendingOverviewCount || 0,
      universeListSource: universeCache.corpListSource || "live",
      universeListFetchedAt: universeCache.corpListFetchedAt || universeCache.fetchedAt,
      disclosuresThrough: disclosureCache.through,
      note:
        "Open DART 공식 공시 기반 전체 KOSPI·KOSDAQ 발행회사 데이터입니다. " +
        "연간 전체 재무제표에서 같은 기간의 영업현금흐름과 PPE 취득액이 확인될 때만 현금흐름 지표를 보강합니다."
    },
    companies
  };
  await writeJsonAtomic(paths.output, dataset);
  onProgress(`DART 전체시장 저장 완료: ${companies.length}개사, API ${controller.requestCount}회`);
  return dataset;
}

export function getDartMarketApiLimits() {
  return {
    maximumCompaniesPerBatch: MAX_DART_COMPANIES_PER_REQUEST,
    defaultFinancialBatchSize: DEFAULT_DART_FINANCIAL_BATCH_SIZE,
    defaultFinancialTimeoutMs: DEFAULT_DART_FINANCIAL_TIMEOUT_MS,
    indexCategories: [...INDEX_CATEGORIES],
    defaultRequestIntervalMs: DEFAULT_REQUEST_INTERVAL_MS,
    defaultRequestBudget: DEFAULT_REQUEST_BUDGET
  };
}
