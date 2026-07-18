import { isIP } from "node:net";

import { fetchJson } from "../http.mjs";
import { attachMarketValuation } from "../market-valuation.mjs";

const LICENSED_SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_RECORDS = 20_000;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_AGE_DAYS = 10;
const DEFAULT_MAX_PREVIOUS_DROP_FRACTION = 0.2;
const DAY_MS = 86_400_000;
const TICKER_PATTERN = /^[A-Z0-9][A-Z0-9.-]{0,31}$/;
const ALLOWED_EXCHANGES = new Map([
  ["NASDAQ", "Nasdaq"],
  ["NYSE", "NYSE"],
  ["CBOE", "CBOE"]
]);

function parseNumber(value, { allowZero = true, signed = false } = {}) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (!signed && (value < 0 || (!allowZero && value === 0))) return null;
    return value;
  }
  const text = String(value).trim();
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text.replaceAll(",", ""));
  if (!Number.isFinite(number)) return null;
  if (!signed && (number < 0 || (!allowZero && number === 0))) return null;
  return number;
}

function optionalNumber(row, names, options, label) {
  const name = names.find((candidate) => row?.[candidate] !== undefined && row[candidate] !== null);
  if (!name || row[name] === "") return null;
  const number = parseNumber(row[name], options);
  if (number === null) throw new Error(`미국 공개 시세 ${label} 값이 올바르지 않습니다.`);
  return number;
}

function normalizedTicker(value) {
  const ticker = String(value || "").trim().toUpperCase();
  return TICKER_PATTERN.test(ticker) ? ticker : null;
}

function normalizedExchange(value) {
  return ALLOWED_EXCHANGES.get(String(value || "").trim().toUpperCase()) || null;
}

function strictIsoDate(value) {
  const text = String(value || "");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return text;
}

function referenceDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("미국 시세 freshness 기준시각이 올바르지 않습니다.");
  return date;
}

function freshnessFor(asOf, now, maxAgeDays) {
  const date = strictIsoDate(asOf);
  if (!date) return { status: "stale", ageDays: null };
  const currentDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const marketDay = Date.parse(date + "T00:00:00.000Z");
  const ageDays = Math.floor((currentDay - marketDay) / DAY_MS);
  return {
    status: ageDays >= 0 && ageDays <= maxAgeDays ? "current" : "stale",
    ageDays
  };
}

function assertFreshDate(asOf, now, maxAgeDays) {
  const freshness = freshnessFor(asOf, now, maxAgeDays);
  if (!strictIsoDate(asOf) || freshness.status !== "current") {
    throw new Error(`미국 공개 시세 기준일이 미래이거나 오래되었습니다: ${asOf || "없음"}`);
  }
  return freshness;
}

function ohlcIsSane(record) {
  const observed = [record.price, record.open].filter(Number.isFinite);
  if (Number.isFinite(record.high) && Number.isFinite(record.low) && record.high < record.low) {
    return false;
  }
  if (Number.isFinite(record.high) && observed.some((value) => value > record.high)) return false;
  if (Number.isFinite(record.low) && observed.some((value) => value < record.low)) return false;
  return true;
}

function approximatelyEqual(left, right, absoluteTolerance, relativeTolerance = 0.001) {
  return Math.abs(left - right) <= Math.max(absoluteTolerance, Math.abs(right) * relativeTolerance);
}

function assertPublicHttpsUrl(value, label, { forbidSecretMaterial = true } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new MarketDataLicenseError(`${label}는 유효한 HTTPS 주소여야 합니다.`);
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.href.length > 2_048) {
    throw new MarketDataLicenseError(`${label}는 유효한 HTTPS 주소여야 합니다.`);
  }
  if (parsed.username || parsed.password) {
    throw new MarketDataLicenseError(`${label}에 사용자명이나 비밀번호를 넣을 수 없습니다.`);
  }
  if (forbidSecretMaterial && (parsed.search || parsed.hash)) {
    throw new MarketDataLicenseError(`${label}에 query 또는 fragment 비밀값을 넣을 수 없습니다.`);
  }
  return parsed;
}

function manifestScope(value) {
  const scope = String(value || "").trim().toLowerCase();
  return scope === "issuer" || scope === "security" ? scope : null;
}

export class MarketDataLicenseError extends Error {
  constructor(message) {
    super(message);
    this.name = "MarketDataLicenseError";
  }
}

export function assertPublishableLicense(manifest, { requireReviewMetadata = false } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new MarketDataLicenseError("미국 공개 시세 manifest가 없습니다.");
  }
  if (manifest.usageMode !== "public") {
    throw new MarketDataLicenseError("미국 공개 시세 usageMode는 public이어야 합니다.");
  }
  if (manifest.redistributionAllowed !== true) {
    throw new MarketDataLicenseError("미국 시세 원자료의 공개 재배포 허용 확인이 필요합니다.");
  }
  if (manifest.derivedPublicationAllowed !== true) {
    throw new MarketDataLicenseError("미국 시세 기반 파생값의 공개 허용 확인이 필요합니다.");
  }

  const licenseUrl = assertPublicHttpsUrl(manifest.licenseReference, "미국 시세 licenseReference");
  const sourceUrl = assertPublicHttpsUrl(
    manifest.sourceUrl || licenseUrl.href,
    "미국 시세 sourceUrl"
  );
  const provider = String(manifest.provider || "Licensed market-data snapshot").trim();
  if (!provider || provider.length > 120 || /[\r\n\0]/.test(provider)) {
    throw new MarketDataLicenseError("미국 시세 provider 이름이 올바르지 않습니다.");
  }
  const scope = manifest.marketCapScope === undefined
    ? null
    : manifestScope(manifest.marketCapScope);
  if (manifest.marketCapScope !== undefined && !scope) {
    throw new MarketDataLicenseError("미국 시세 marketCapScope는 issuer 또는 security여야 합니다.");
  }
  const licenseId = String(manifest.licenseId || "").trim();
  const rightsReviewedAt = strictIsoDate(manifest.rightsReviewedAt);
  const licenseExpiresAt = manifest.licenseExpiresAt
    ? strictIsoDate(manifest.licenseExpiresAt)
    : null;
  if (
    requireReviewMetadata &&
    (!licenseId || licenseId.length > 120 || /[^A-Za-z0-9._:@/-]/.test(licenseId))
  ) {
    throw new MarketDataLicenseError("미국 시세 licenseId가 필요하거나 형식이 올바르지 않습니다.");
  }
  if (requireReviewMetadata && !rightsReviewedAt) {
    throw new MarketDataLicenseError("미국 시세 rightsReviewedAt은 올바른 날짜여야 합니다.");
  }
  if (manifest.licenseExpiresAt && !licenseExpiresAt) {
    throw new MarketDataLicenseError("미국 시세 licenseExpiresAt이 올바르지 않습니다.");
  }

  return {
    usageMode: "public",
    redistributionAllowed: true,
    derivedPublicationAllowed: true,
    licenseReference: licenseUrl.href,
    provider,
    sourceUrl: sourceUrl.href,
    marketCapScope: scope,
    licenseId: licenseId || null,
    rightsReviewedAt: rightsReviewedAt || null,
    licenseExpiresAt
  };
}

function normalizeMarketCap(row, manifest, explicitSchema, price, listedShares) {
  const numericIssuerCap =
    typeof row?.issuerTotalMarketCap === "number" || typeof row?.issuerTotalMarketCap === "string"
      ? row.issuerTotalMarketCap
      : row?.issuerMarketCap;
  const marketCap = optionalNumber(
    { value: row?.marketCap ?? numericIssuerCap },
    ["value"],
    { allowZero: false },
    "marketCap"
  );
  const explicitIssuerFlag = row?.issuerTotalMarketCap === true;
  const rawScope = row?.marketCapScope ?? manifest.marketCapScope;
  const scope = rawScope === undefined || rawScope === null || rawScope === ""
    ? explicitIssuerFlag
      ? "issuer"
      : explicitSchema && marketCap
        ? null
        : marketCap
          ? "issuer"
          : null
    : manifestScope(rawScope);
  if (rawScope !== undefined && rawScope !== null && rawScope !== "" && !scope) {
    throw new Error("미국 공개 시세 marketCapScope는 issuer 또는 security여야 합니다.");
  }
  if (marketCap && !scope) {
    throw new Error("schemaVersion 1 미국 시세의 marketCapScope가 없습니다.");
  }
  if (scope === "security" && marketCap && listedShares) {
    const expected = price * listedShares;
    if (!Number.isFinite(expected) || !approximatelyEqual(marketCap, expected, 1, 0.02)) {
      throw new Error("미국 공개 시세 security marketCap이 price×listedShares와 일치하지 않습니다.");
    }
  }
  return {
    marketCap,
    marketCapScope: scope,
    issuerTotalMarketCap: scope === "issuer",
    issuerMarketCap: scope === "issuer" ? marketCap : null,
    securityMarketCap: scope === "security" ? marketCap : null
  };
}

function normalizeLicensedRow(row, { manifest, asOf, explicitSchema }) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("미국 공개 시세 레코드는 객체여야 합니다.");
  }
  const ticker = normalizedTicker(row.ticker);
  const exchange = normalizedExchange(row.exchange);
  if (!ticker || !exchange) {
    throw new Error("미국 공개 시세 ticker 또는 exchange가 올바르지 않습니다.");
  }
  const rowDateValue = row.date ?? row.asOf;
  const rowAsOf = rowDateValue === undefined ? asOf : strictIsoDate(rowDateValue);
  if (!rowAsOf || rowAsOf !== asOf) {
    throw new Error("미국 공개 시세 레코드 기준일이 snapshot asOf와 일치하지 않습니다.");
  }
  const currency = String(row.currency ?? (explicitSchema ? "" : "USD")).trim().toUpperCase();
  if (currency !== "USD") throw new Error("미국 공개 시세 통화는 USD여야 합니다.");

  const price = optionalNumber(row, ["close", "price"], { allowZero: false }, "close");
  if (!price) throw new Error("미국 공개 시세 close가 없습니다.");
  const open = optionalNumber(row, ["open"], { allowZero: false }, "open");
  const high = optionalNumber(row, ["high"], { allowZero: false }, "high");
  const low = optionalNumber(row, ["low"], { allowZero: false }, "low");
  let previousClose = optionalNumber(
    row,
    ["previousClose"],
    { allowZero: false },
    "previousClose"
  );
  let change = optionalNumber(row, ["change"], { signed: true }, "change");
  const suppliedChangePercent = optionalNumber(
    row,
    ["changePercent"],
    { signed: true },
    "changePercent"
  );
  if (!previousClose && Number.isFinite(change) && price - change > 0) previousClose = price - change;
  if (previousClose && change === null) change = price - previousClose;
  if (previousClose && Number.isFinite(change)) {
    const expectedChange = price - previousClose;
    if (!approximatelyEqual(change, expectedChange, 0.01)) {
      throw new Error("미국 공개 시세 change가 close와 previousClose에 일치하지 않습니다.");
    }
  }
  const computedChangePercent = previousClose ? ((price - previousClose) / previousClose) * 100 : null;
  if (
    Number.isFinite(suppliedChangePercent) &&
    Number.isFinite(computedChangePercent) &&
    !approximatelyEqual(suppliedChangePercent, computedChangePercent, 0.02, 0.002)
  ) {
    throw new Error("미국 공개 시세 changePercent가 종가 변동률과 일치하지 않습니다.");
  }

  const volume = optionalNumber(row, ["volume"], { allowZero: true }, "volume");
  const turnover = optionalNumber(row, ["turnover"], { allowZero: true }, "turnover");
  const listedShares = optionalNumber(
    row,
    ["listedShares", "shares"],
    { allowZero: false },
    "listedShares"
  );
  const record = {
    ticker,
    exchange,
    currency,
    asOf: rowAsOf,
    price,
    open,
    high,
    low,
    previousClose,
    change,
    changePercent: suppliedChangePercent ?? computedChangePercent,
    volume,
    turnover,
    listedShares
  };
  if (!ohlcIsSane(record)) throw new Error("미국 공개 시세 OHLC 범위가 올바르지 않습니다.");
  return {
    ...record,
    ...normalizeMarketCap(row, manifest, explicitSchema, price, listedShares)
  };
}

export function normalizeLicensedUsSnapshot(
  payload,
  { now = null, maxAgeDays = DEFAULT_MAX_AGE_DAYS, requireSchemaVersion = false } = {}
) {
  const explicitSchema = payload?.schemaVersion !== undefined;
  if (
    (requireSchemaVersion && payload?.schemaVersion !== LICENSED_SNAPSHOT_SCHEMA_VERSION) ||
    (explicitSchema && payload.schemaVersion !== LICENSED_SNAPSHOT_SCHEMA_VERSION)
  ) {
    throw new Error(`미국 공개 시세 schemaVersion은 ${LICENSED_SNAPSHOT_SCHEMA_VERSION}이어야 합니다.`);
  }
  const manifest = assertPublishableLicense(payload?.manifest, {
    requireReviewMetadata: explicitSchema
  });
  const sourceAsOf = strictIsoDate(payload?.asOf);
  if (!sourceAsOf) throw new Error("미국 공개 시세 snapshot asOf가 올바르지 않습니다.");
  if (manifest.rightsReviewedAt && manifest.rightsReviewedAt > sourceAsOf) {
    throw new MarketDataLicenseError("미국 시세 권리 검토일이 snapshot 기준일보다 미래입니다.");
  }
  if (manifest.licenseExpiresAt && manifest.licenseExpiresAt < sourceAsOf) {
    throw new MarketDataLicenseError("미국 시세 라이선스가 snapshot 기준일 전에 만료되었습니다.");
  }
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 31) {
    throw new RangeError("미국 시세 freshness 허용일은 1~31이어야 합니다.");
  }
  if (now !== null) assertFreshDate(sourceAsOf, referenceDate(now), maxAgeDays);
  if (!Array.isArray(payload?.data)) throw new Error("미국 공개 시세 data는 배열이어야 합니다.");
  if (payload.data.length < 1 || payload.data.length > MAX_RECORDS) {
    throw new Error(`미국 공개 시세 레코드 수는 1~${MAX_RECORDS}개여야 합니다.`);
  }

  const records = [];
  const keys = new Set();
  for (const row of payload.data) {
    const record = normalizeLicensedRow(row, { manifest, asOf: sourceAsOf, explicitSchema });
    const key = record.exchange.toUpperCase() + ":" + record.ticker;
    if (keys.has(key)) throw new Error("미국 공개 시세 ticker가 중복되었습니다: " + key);
    keys.add(key);
    records.push(record);
  }

  return {
    schemaVersion: LICENSED_SNAPSHOT_SCHEMA_VERSION,
    manifest,
    asOf: sourceAsOf,
    records
  };
}

function blockedHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host || isIP(host) > 0) return true;
  if (!host.includes(".")) return true;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home")
  );
}

function allowedHostSet(allowedHosts) {
  const values = Array.isArray(allowedHosts)
    ? allowedHosts
    : String(allowedHosts || "").split(",");
  const hosts = new Set();
  for (const value of values) {
    const host = String(value || "").trim().toLowerCase().replace(/\.$/, "");
    if (!host) continue;
    if (host.includes("://") || /[/?#*]/.test(host) || blockedHostname(host)) {
      throw new Error("US_LICENSED_PRICE_ALLOWED_HOSTS에는 공개 DNS host만 넣을 수 있습니다.");
    }
    hosts.add(host);
  }
  if (hosts.size === 0) {
    throw new Error("US_LICENSED_PRICE_ALLOWED_HOSTS에 snapshot host를 명시해야 합니다.");
  }
  return hosts;
}

export async function fetchLicensedUsSnapshot({
  url,
  token = "",
  allowedHosts = [],
  now = new Date(),
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchJsonImpl = fetchJson
} = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("US_LICENSED_PRICE_SNAPSHOT_URL은 유효한 HTTPS 주소여야 합니다.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    blockedHostname(parsed.hostname)
  ) {
    throw new Error("US_LICENSED_PRICE_SNAPSHOT_URL은 비밀값 없는 공개 HTTPS 주소여야 합니다.");
  }
  const allowed = allowedHostSet(allowedHosts);
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!allowed.has(hostname)) {
    throw new Error(`미국 시세 snapshot host가 allowlist에 없습니다: ${hostname}`);
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BYTES) {
    throw new RangeError(`미국 시세 snapshot 최대 크기는 1~${MAX_RESPONSE_BYTES} bytes여야 합니다.`);
  }

  const payload = await fetchJsonImpl(parsed, {
    headers: token ? { Authorization: "Bearer " + token } : {},
    timeoutMs: 60_000,
    retries: 3,
    redirect: "error",
    maxBytes
  });
  const normalized = normalizeLicensedUsSnapshot(payload, {
    now,
    maxAgeDays,
    requireSchemaVersion: true
  });
  for (const publicUrl of [
    normalized.manifest.sourceUrl,
    normalized.manifest.licenseReference
  ]) {
    const publicHost = new URL(publicUrl).hostname.toLowerCase().replace(/\.$/, "");
    if (!allowed.has(publicHost) || blockedHostname(publicHost)) {
      throw new Error(`미국 시세 manifest host가 allowlist에 없습니다: ${publicHost}`);
    }
  }
  return normalized;
}

function aliases(ticker) {
  const value = normalizedTicker(ticker);
  return value ? new Set([value, value.replaceAll(".", "-"), value.replaceAll("-", ".")]) : new Set();
}

function recordKey(exchange, ticker) {
  return String(exchange || "").toUpperCase() + ":" + ticker;
}

function companyListingPairs(company) {
  const supplied = Array.isArray(company?.listings) && company.listings.length > 0
    ? company.listings
    : [{ ticker: company?.ticker, exchange: company?.exchange }];
  const byKey = new Map();
  for (const listing of supplied) {
    const ticker = normalizedTicker(listing?.ticker);
    const exchange = normalizedExchange(listing?.exchange);
    if (!ticker || !exchange) continue;
    byKey.set(recordKey(exchange, ticker), { ticker, exchange });
  }
  return [...byKey.values()];
}

function recordIndexes(records) {
  const exact = new Map();
  const alias = new Map();
  for (const record of records) {
    exact.set(recordKey(record.exchange, record.ticker), record);
    for (const ticker of aliases(record.ticker)) {
      const key = recordKey(record.exchange, ticker);
      const matches = alias.get(key) || [];
      if (!matches.includes(record)) matches.push(record);
      alias.set(key, matches);
    }
  }
  return { exact, alias };
}

function uniqueRecords(records) {
  return [...new Set(records)];
}

function matchRecord(company, indexes) {
  const pairs = companyListingPairs(company);
  const exactMatches = uniqueRecords(
    pairs.map((pair) => indexes.exact.get(recordKey(pair.exchange, pair.ticker))).filter(Boolean)
  );
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    const primaryTicker = normalizedTicker(company?.ticker);
    const primaryExchange = normalizedExchange(company?.exchange);
    const primary = primaryTicker && primaryExchange
      ? indexes.exact.get(recordKey(primaryExchange, primaryTicker))
      : null;
    return primary && exactMatches.includes(primary) ? primary : null;
  }

  const aliasMatches = uniqueRecords(
    pairs.flatMap((pair) =>
      [...aliases(pair.ticker)].flatMap(
        (ticker) => indexes.alias.get(recordKey(pair.exchange, ticker)) || []
      )
    )
  );
  return aliasMatches.length === 1 ? aliasMatches[0] : null;
}

function withExistingFreshness(company, now, maxAgeDays) {
  const marketData = company?.marketData;
  if (!marketData || marketData.usageMode !== "public") return company;
  const freshness = freshnessFor(marketData.asOf, now, maxAgeDays);
  return {
    ...company,
    marketData: {
      ...marketData,
      status: freshness.status === "current" ? "preserved" : "stale",
      freshness: freshness.status,
      ageDays: freshness.ageDays
    }
  };
}

function previousPublicPriceCount(companies) {
  return companies.filter(
    (company) =>
      company.marketData?.usageMode === "public" &&
      Number.isFinite(company.marketData?.price) &&
      company.marketData.price > 0 &&
      strictIsoDate(company.marketData?.asOf)
  ).length;
}

function coverageOptions({
  minimumMatched,
  minimumMatchRatio,
  previousMatched,
  maxPreviousDropFraction,
  maxAgeDays
}) {
  if (!Number.isInteger(minimumMatched) || minimumMatched < 0) {
    throw new RangeError("미국 시세 minimumMatched가 올바르지 않습니다.");
  }
  if (!Number.isFinite(minimumMatchRatio) || minimumMatchRatio < 0 || minimumMatchRatio > 1) {
    throw new RangeError("미국 시세 minimumMatchRatio가 올바르지 않습니다.");
  }
  if (previousMatched !== null && (!Number.isInteger(previousMatched) || previousMatched < 0)) {
    throw new RangeError("미국 시세 previousMatched가 올바르지 않습니다.");
  }
  if (
    !Number.isFinite(maxPreviousDropFraction) ||
    maxPreviousDropFraction < 0 ||
    maxPreviousDropFraction >= 1
  ) {
    throw new RangeError("미국 시세 이전 커버리지 허용 하락률이 올바르지 않습니다.");
  }
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 31) {
    throw new RangeError("미국 시세 freshness 허용일은 1~31이어야 합니다.");
  }
}

export function enrichUsCompaniesWithLicensedPrices(
  companies,
  snapshot,
  {
    fetchedAt = new Date().toISOString(),
    minimumMatched = 3_000,
    minimumMatchRatio = 0.75,
    previousMatched = null,
    maxPreviousDropFraction = DEFAULT_MAX_PREVIOUS_DROP_FRACTION,
    maxAgeDays = DEFAULT_MAX_AGE_DAYS,
    now = new Date()
  } = {}
) {
  if (!Array.isArray(companies)) throw new TypeError("companies는 배열이어야 합니다.");
  coverageOptions({
    minimumMatched,
    minimumMatchRatio,
    previousMatched,
    maxPreviousDropFraction,
    maxAgeDays
  });
  const currentTime = referenceDate(now);
  const snapshotDate = strictIsoDate(snapshot?.asOf);
  const snapshotFreshness = assertFreshDate(snapshotDate, currentTime, maxAgeDays);
  const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
  if (records.length < 1 || records.length > MAX_RECORDS) {
    throw new Error(`미국 공개 시세 레코드 수는 1~${MAX_RECORDS}개여야 합니다.`);
  }

  const checkedKeys = new Set();
  for (const record of records) {
    const ticker = normalizedTicker(record?.ticker);
    const exchange = normalizedExchange(record?.exchange);
    const key = ticker && exchange ? recordKey(exchange, ticker) : null;
    if (
      !key ||
      record.asOf !== snapshotDate ||
      record.currency !== "USD" ||
      !Number.isFinite(record.price) ||
      record.price <= 0 ||
      !ohlcIsSane(record)
    ) {
      throw new Error("미국 공개 시세 snapshot 레코드가 표준 스키마와 일치하지 않습니다.");
    }
    if (checkedKeys.has(key)) throw new Error("미국 공개 시세 snapshot ticker 중복: " + key);
    checkedKeys.add(key);
  }

  const indexes = recordIndexes(records);
  const usCompanies = companies.filter((company) => company.country === "US");
  const matched = new Map();
  for (const company of usCompanies) {
    const record = matchRecord(company, indexes);
    if (record) matched.set(company.id, record);
  }
  const matchedCount = matched.size;
  const ratio = usCompanies.length ? matchedCount / usCompanies.length : 0;
  const baseline = previousMatched ?? previousPublicPriceCount(usCompanies);
  const previousFloor = Math.ceil(baseline * (1 - maxPreviousDropFraction));
  if (matchedCount < minimumMatched || ratio < minimumMatchRatio || matchedCount < previousFloor) {
    throw new Error(
      `미국 공개 시세 매칭 커버리지가 안전 기준보다 낮습니다: ${matchedCount}/${usCompanies.length}` +
        (baseline ? ` · 이전 ${baseline}개 기준 하한 ${previousFloor}개` : "")
    );
  }

  const source = {
    name: snapshot.manifest.provider,
    url: snapshot.manifest.sourceUrl,
    licenseReference: snapshot.manifest.licenseReference,
    licenseId: snapshot.manifest.licenseId || null,
    rightsReviewedAt: snapshot.manifest.rightsReviewedAt || null
  };
  let applied = 0;
  let preservedNewer = 0;
  const nextCompanies = companies.map((company) => {
    if (company.country !== "US") return company;
    const record = matched.get(company.id);
    if (!record) return withExistingFreshness(company, currentTime, maxAgeDays);
    const existingDate = strictIsoDate(company.marketData?.asOf);
    if (existingDate && existingDate > record.asOf) {
      preservedNewer += 1;
      return withExistingFreshness(company, currentTime, maxAgeDays);
    }
    applied += 1;
    return {
      ...company,
      marketData: attachMarketValuation(company, {
        status: "ok",
        freshness: "current",
        ageDays: snapshotFreshness.ageDays,
        usageMode: "public",
        ...record,
        fetchedAt,
        source
      })
    };
  });

  return {
    companies: nextCompanies,
    coverage: {
      matched: matchedCount,
      applied,
      preservedNewer,
      previousMatched: baseline,
      previousFloor,
      ratio,
      total: usCompanies.length
    },
    matched: matchedCount,
    applied,
    preservedNewer,
    freshness: snapshotFreshness,
    asOf: snapshotDate
  };
}
