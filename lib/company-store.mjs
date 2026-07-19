import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { scoreAndRank } from "./scoring.mjs";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

const ALLOWED_COUNTRIES = new Set(["ALL", "KR", "US"]);
const ALLOWED_SORTS = new Set(["score", "confidence", "name"]);
const LIST_COMPONENTS = ["valuation", "longGrowth", "quality", "safety"];
const listCacheLimit = 200;
const collator = new Intl.Collator("ko", {
  numeric: true,
  sensitivity: "base"
});

export class CompanyQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = "CompanyQueryError";
  }
}

function positiveInteger(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new CompanyQueryError(label + "는 양의 정수여야 합니다.");
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1 || parsed > maximum) {
    throw new CompanyQueryError(label + "는 1 이상 " + maximum + " 이하여야 합니다.");
  }
  return parsed;
}

function booleanValue(value) {
  if (value === null || value === "" || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw new CompanyQueryError("candidateOnly은 true 또는 false여야 합니다.");
}

export function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCompanyQuery(searchParams) {
  const q = String(searchParams.get("q") || "").trim();
  if ([...q].length > 100) {
    throw new CompanyQueryError("검색어는 100자 이하여야 합니다.");
  }

  const country = String(searchParams.get("country") || "ALL").toUpperCase();
  if (!ALLOWED_COUNTRIES.has(country)) {
    throw new CompanyQueryError("country는 ALL, KR, US 중 하나여야 합니다.");
  }

  const sort = String(searchParams.get("sort") || "score").toLowerCase();
  if (!ALLOWED_SORTS.has(sort)) {
    throw new CompanyQueryError("sort는 score, confidence, name 중 하나여야 합니다.");
  }

  const sector = String(searchParams.get("sector") || "ALL").trim() || "ALL";
  if ([...sector].length > 100) {
    throw new CompanyQueryError("산업 필터는 100자 이하여야 합니다.");
  }

  return {
    q,
    normalizedQuery: normalizeSearch(q),
    country,
    sector,
    sort,
    candidateOnly: booleanValue(searchParams.get("candidateOnly")),
    page: positiveInteger(searchParams.get("page"), 1, "page"),
    pageSize: positiveInteger(
      searchParams.get("pageSize"),
      DEFAULT_PAGE_SIZE,
      "pageSize",
      MAX_PAGE_SIZE
    )
  };
}

function pickObject(source, keys) {
  return Object.fromEntries(keys.map((key) => [key, source?.[key] ?? null]));
}

function statusValue(value) {
  if (value && typeof value === "object") return value.status;
  return value;
}

function resolveEvaluationStatus(company) {
  const statuses = [
    company.analysisStatus,
    company.evaluationStatus,
    company.dataStatus,
    company.syncStatus,
    company.modelApplicability,
    company.providerStatus,
    company.dataMode
  ]
    .map(statusValue)
    .filter((status) => typeof status === "string" && status)
    .map((status) => status.toLowerCase());
  return (
    statuses.find((status) =>
      ["insufficient", "insufficient_data", "not_applicable"].includes(status)
    ) ||
    statuses[0] ||
    null
  );
}

function listProjection(company) {
  const components = {};
  for (const key of LIST_COMPONENTS) {
    const component = company.score?.components?.[key];
    if (!component) continue;
    components[key] = {
      label: component.label,
      score: component.score,
      weight: component.weight,
      confidence: component.confidence
    };
  }

  const valuation = company.marketData?.valuation || {};
  const projectedMetrics = pickObject(company.metrics, [
    "roe",
    "operatingMargin",
    "debtRatio",
    "per",
    "pbr",
    "psr",
    "fcfYield",
    "revenueCagr",
    "operatingMarginTrend"
  ]);
  return {
    id: company.id,
    rank: company.rank,
    name: company.name,
    nameEn: company.nameEn || null,
    ticker: company.ticker,
    country: company.country,
    exchange: company.exchange,
    sector: company.sector || "미분류",
    period: company.period || null,
    dataMode: company.dataMode,
    stale: Boolean(company.stale),
    analysisStatus: resolveEvaluationStatus(company),
    syncStatus: company.syncStatus ?? null,
    modelApplicability: company.modelApplicability ?? null,
    providerStatus: company.providerStatus ?? null,
    updatedAt: company.updatedAt || null,
    metrics: projectedMetrics,
    marketData: company.marketData
      ? {
          status: company.marketData.status || null,
          freshness: company.marketData.freshness || null,
          ageDays: company.marketData.ageDays ?? null,
          usageMode: company.marketData.usageMode || null,
          currency: company.marketData.currency || null,
          asOf: company.marketData.asOf || null,
          price: company.marketData.price ?? null,
          changePercent: company.marketData.changePercent ?? null,
          marketCap: company.marketData.marketCap ?? null,
          valuation: pickObject(valuation, ["per", "pbr", "psr", "fcfYield"])
        }
      : null,
    history: (company.history || []).slice(-4).map((point) => ({
      label: point.label,
      revenue: point.revenue ?? null,
      operatingIncome: point.operatingIncome ?? null
    })),
    historyUnit: company.historyUnit || null,
    reasons: company.reasons?.length ? [company.reasons[0]] : [],
    score: {
      modelVersion: company.score?.modelVersion || null,
      total: company.score?.total ?? 0,
      completeness: company.score?.completeness ?? 0,
      dataConfidence: company.score?.dataConfidence ?? 0,
      evaluationReady: Boolean(company.score?.evaluationReady),
      valuationConfidence: company.score?.valuationConfidence ?? 0,
      components,
      band: company.score?.band || { key: "held", label: "가치평가 보류" },
      candidate: {
        eligible: Boolean(company.score?.candidate?.eligible),
        label: company.score?.candidate?.label || "관찰 대상"
      }
    }
  };
}

function sanitizedMeta(meta = {}) {
  const sync = meta.sync
    ? {
        status: meta.sync.status,
        successful: meta.sync.successful,
        attempted: meta.sync.attempted,
        failed: meta.sync.failed
      }
    : null;
  return {
    schemaVersion: meta.schemaVersion,
    dataMode: meta.dataMode,
    updatedAt: meta.updatedAt,
    note: meta.note,
    sources: meta.sources || [],
    coverage: meta.coverage || null,
    providers: meta.providers || [],
    marketData: meta.marketData || null,
    ...(sync ? { sync } : {})
  };
}

function average(companies, getter) {
  if (companies.length === 0) return 0;
  return Math.round(companies.reduce((sum, company) => sum + getter(company), 0) / companies.length);
}

function buildFacets(companies) {
  const countries = new Map();
  const sectors = new Map();
  for (const company of companies) {
    countries.set(company.country, (countries.get(company.country) || 0) + 1);
    const sector = company.sector || "미분류";
    sectors.set(sector, (sectors.get(sector) || 0) + 1);
  }

  const countryLabels = { ALL: "전체", KR: "한국", US: "미국" };
  const countryItems = ["ALL", "KR", "US"].map((value) => ({
    value,
    label: countryLabels[value],
    count: value === "ALL" ? companies.length : countries.get(value) || 0
  }));
  const sectorItems = [...sectors.entries()]
    .sort(([left], [right]) => collator.compare(left, right))
    .map(([value, count]) => ({ value, label: value, count }));

  return {
    countries: countryItems,
    sectors: [{ value: "ALL", label: "전체 산업", count: companies.length }, ...sectorItems]
  };
}

function compareId(left, right) {
  return collator.compare(left.item.id, right.item.id);
}

function evaluationPriority(entry) {
  const company = entry.item;
  const status = String(company.analysisStatus || "").toLowerCase();
  if (company.modelApplicability === false || status === "not_applicable") return 4;
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

function buildSnapshot(raw, rawText, scoringDate = new Date()) {
  if (!raw || !Array.isArray(raw.companies)) {
    throw new Error("회사 데이터셋 형식이 올바르지 않습니다.");
  }

  const safeScoringDate = Number.isNaN(scoringDate.getTime()) ? new Date() : scoringDate;
  const companies = scoreAndRank(raw.companies, safeScoringDate);
  const evaluationReadyCompanies = companies.filter(
    (company) => company.score.evaluationReady
  );
  const detailsById = new Map();
  const entries = [];

  for (const company of companies) {
    if (!company.id || detailsById.has(company.id)) {
      throw new Error("회사 ID가 없거나 중복되었습니다: " + (company.id || "(없음)"));
    }
    detailsById.set(company.id, company);
    entries.push({
      item: listProjection(company),
      searchText: normalizeSearch(
        [company.name, company.nameEn, company.ticker, company.sector].filter(Boolean).join(" ")
      )
    });
  }

  const ordered = {
    score: [...entries].sort((left, right) => left.item.rank - right.item.rank),
    confidence: [...entries].sort(
      (left, right) =>
        evaluationPriority(left) - evaluationPriority(right) ||
        right.item.score.dataConfidence - left.item.score.dataConfidence ||
        right.item.score.total - left.item.score.total ||
        compareId(left, right)
    ),
    name: [...entries].sort(
      (left, right) =>
        collator.compare(left.item.name || "", right.item.name || "") || compareId(left, right)
    )
  };
  const revision = createHash("sha256").update(rawText).digest("hex").slice(0, 20);
  const meta = sanitizedMeta(raw.meta);
  return {
    revision,
    meta,
    companies,
    detailsById,
    ordered,
    overview: {
      revision,
      meta,
      summary: {
        companies: companies.length,
        evaluationReadyCompanies: evaluationReadyCompanies.length,
        candidates: companies.filter((company) => company.score.candidate.eligible).length,
        averageScore: average(evaluationReadyCompanies, (company) => company.score.total),
        averageConfidence: average(
          evaluationReadyCompanies,
          (company) => company.score.dataConfidence
        )
      },
      facets: buildFacets(companies),
      pageSizeDefault: DEFAULT_PAGE_SIZE,
      pageSizeMax: MAX_PAGE_SIZE
    }
  };
}

function fileSignature(fileStat) {
  return fileStat.size + ":" + fileStat.mtimeMs;
}

async function consistentRead(dataFile) {
  let rawText;
  let after;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await stat(dataFile);
    rawText = await readFile(dataFile, "utf8");
    after = await stat(dataFile);
    if (fileSignature(before) === fileSignature(after)) break;
  }
  return { rawText, fileStat: after };
}

export class CompanyStore {
  constructor(dataFile, { refreshIntervalMs = 5_000, now = () => Date.now() } = {}) {
    this.dataFile = dataFile;
    this.refreshIntervalMs = refreshIntervalMs;
    this.now = now;
    this.snapshot = null;
    this.signature = null;
    this.activeReload = null;
    this.lastStatCheck = 0;
    this.lastReloadError = null;
    this.lastScoringDay = null;
    this.listCache = new Map();
  }

  async initialize() {
    await this.reload();
    return this;
  }

  async reload() {
    if (this.activeReload) return this.activeReload;
    this.activeReload = this.performReload();
    try {
      return await this.activeReload;
    } finally {
      this.activeReload = null;
    }
  }

  async performReload() {
    try {
      const { rawText, fileStat } = await consistentRead(this.dataFile);
      const raw = JSON.parse(rawText);
      const scoringNow = new Date(this.now());
      const nextSnapshot = buildSnapshot(raw, rawText, scoringNow);
      this.snapshot = nextSnapshot;
      this.signature = fileSignature(fileStat);
      this.lastStatCheck = this.now();
      this.lastReloadError = null;
      this.lastScoringDay = scoringNow.toISOString().slice(0, 10);
      this.listCache.clear();
      return nextSnapshot;
    } catch (error) {
      this.lastReloadError = {
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString()
      };
      throw error;
    }
  }

  async refreshIfChanged({ force = false } = {}) {
    if (!this.snapshot) {
      await this.reload();
      return true;
    }
    const currentTime = this.now();
    const currentScoringDay = new Date(currentTime).toISOString().slice(0, 10);
    if (this.lastScoringDay && currentScoringDay !== this.lastScoringDay) {
      await this.reload();
      return true;
    }
    if (!force && currentTime - this.lastStatCheck < this.refreshIntervalMs) return false;
    this.lastStatCheck = currentTime;

    try {
      const fileStat = await stat(this.dataFile);
      if (!force && fileSignature(fileStat) === this.signature) return false;
      await this.reload();
      return true;
    } catch (error) {
      if (!this.lastReloadError) {
        this.lastReloadError = {
          message: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString()
        };
      }
      return false;
    }
  }

  getOverview() {
    this.assertReady();
    return this.snapshot.overview;
  }

  getCompany(id) {
    this.assertReady();
    return this.snapshot.detailsById.get(id) || null;
  }

  list(query) {
    this.assertReady();
    const cacheKey = JSON.stringify([
      query.normalizedQuery,
      query.country,
      query.sector,
      query.sort,
      query.candidateOnly,
      query.page,
      query.pageSize
    ]);
    const cached = this.listCache.get(cacheKey);
    if (cached) {
      this.listCache.delete(cacheKey);
      this.listCache.set(cacheKey, cached);
      return cached;
    }

    const offset = (query.page - 1) * query.pageSize;
    const items = [];
    let total = 0;
    for (const entry of this.snapshot.ordered[query.sort]) {
      const company = entry.item;
      if (query.normalizedQuery && !entry.searchText.includes(query.normalizedQuery)) continue;
      if (query.country !== "ALL" && company.country !== query.country) continue;
      if (query.sector !== "ALL" && company.sector !== query.sector) continue;
      if (query.candidateOnly && !company.score.candidate.eligible) continue;

      total += 1;
      if (total > offset && items.length < query.pageSize) {
        items.push({ ...company, position: total });
      }
    }

    const totalPages = Math.ceil(total / query.pageSize);
    const response = {
      revision: this.snapshot.revision,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages,
        hasPrevious: query.page > 1 && total > 0,
        hasNext: query.page < totalPages
      },
      items
    };
    this.listCache.set(cacheKey, response);
    if (this.listCache.size > listCacheLimit) {
      this.listCache.delete(this.listCache.keys().next().value);
    }
    return response;
  }

  getStatus() {
    return {
      revision: this.snapshot?.revision || null,
      companies: this.snapshot?.companies.length || 0,
      updatedAt: this.snapshot?.meta.updatedAt || null,
      dataLoadStatus: this.lastReloadError ? "stale" : "ok",
      lastReloadError: this.lastReloadError
    };
  }

  assertReady() {
    if (!this.snapshot) throw new Error("회사 데이터가 아직 준비되지 않았습니다.");
  }
}

export async function createCompanyStore(dataFile, options) {
  return new CompanyStore(dataFile, options).initialize();
}
