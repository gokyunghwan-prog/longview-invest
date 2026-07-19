import { fetchJson } from "../http.mjs";
import { attachMarketValuation } from "../market-valuation.mjs";

export const KR_STOCK_PRICE_SOURCE = Object.freeze({
  name: "금융위원회 주식시세정보",
  url: "https://www.data.go.kr/data/15094808/openapi.do",
  originalSource: "한국거래소",
  cadence: "T+1 영업일 오후 1시 이후"
});

const ENDPOINT =
  "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";
const ALLOWED_MARKETS = new Set(["KOSPI", "KOSDAQ"]);
const MAX_TOTAL_COUNT = 20_000;
const DEFAULT_MAX_AGE_DAYS = 10;
const DEFAULT_MAX_PREVIOUS_DROP_FRACTION = 0.2;
const DAY_MS = 86_400_000;

function parseNumber(value, { allowZero = true } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).trim().replaceAll(",", "");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0)) return null;
  return number;
}

function parseSignedNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).trim().replaceAll(",", "");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function isoDate(compact) {
  const value = String(compact || "");
  if (!/^\d{8}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function strictIsoDate(value) {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && isoDate(text.replaceAll("-", "")) === text
    ? text
    : null;
}

function compactDate(date) {
  return (
    date.getUTCFullYear() +
    String(date.getUTCMonth() + 1).padStart(2, "0") +
    String(date.getUTCDate()).padStart(2, "0")
  );
}

function kstDate(now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
}

function decodedServiceKey(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  if (!key.includes("%")) return key;
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

function itemsFrom(payload) {
  const response = payload?.response || payload;
  const header = response?.header || {};
  const resultCode = String(header.resultCode ?? header.resultCd ?? "00");
  if (!["00", "0", "000"].includes(resultCode)) {
    throw new Error(
      "금융위원회 주식시세 응답 오류 " + resultCode + ": " +
        String(header.resultMsg || header.resultMessage || "원인을 확인할 수 없습니다.")
    );
  }
  const body = response?.body || {};
  const rawItems = body?.items?.item ?? body?.items ?? [];
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  const totalText = String(body.totalCount ?? (items.length === 0 ? 0 : ""));
  if (!/^\d+$/.test(totalText)) {
    throw new Error("금융위원회 주식시세 totalCount가 올바르지 않습니다.");
  }
  const totalCount = Number(totalText);
  if (!Number.isSafeInteger(totalCount) || totalCount < 0 || totalCount > MAX_TOTAL_COUNT) {
    throw new Error(`금융위원회 주식시세 totalCount 안전 상한을 벗어났습니다: ${totalText}`);
  }
  if ((totalCount === 0) !== (items.length === 0)) {
    throw new Error("금융위원회 주식시세 totalCount와 items가 일치하지 않습니다.");
  }
  const responsePageNo = body.pageNo === undefined ? null : Number.parseInt(body.pageNo, 10);
  if (responsePageNo !== null && (!Number.isInteger(responsePageNo) || responsePageNo < 1)) {
    throw new Error("금융위원회 주식시세 pageNo가 올바르지 않습니다.");
  }
  return {
    items,
    totalCount,
    pageNo: responsePageNo
  };
}

function quoteOhlcIsSane({ price, open, high, low }) {
  const observed = [price, open].filter(Number.isFinite);
  if (Number.isFinite(high) && Number.isFinite(low) && high < low) return false;
  if (Number.isFinite(high) && observed.some((value) => value > high)) return false;
  if (Number.isFinite(low) && observed.some((value) => value < low)) return false;
  return true;
}

function marketCapIsSane({ price, listedShares, marketCap }) {
  if (![price, listedShares, marketCap].every((value) => Number.isFinite(value) && value > 0)) {
    return true;
  }
  const expected = price * listedShares;
  if (!Number.isSafeInteger(Math.round(expected))) return false;
  // The production universe is far above these values. Keeping tiny fixtures
  // out of the cross-field assertion preserves deterministic unit examples.
  if (listedShares < 1_000 || expected < 1_000_000 || marketCap < 1_000_000) return true;
  return Math.abs(marketCap - expected) / expected <= 0.02;
}

export function normalizeKrStockPriceItem(item) {
  const ticker = String(item?.srtnCd || "").trim().padStart(6, "0");
  const exchange = String(item?.mrktCtg || "").trim().toUpperCase();
  const asOf = isoDate(item?.basDt);
  const price = parseNumber(item?.clpr, { allowZero: false });
  if (!/^\d{6}$/.test(ticker) || !ALLOWED_MARKETS.has(exchange) || !asOf || !price) {
    return null;
  }

  const change = parseSignedNumber(item?.vs);
  const suppliedChangePercent = parseSignedNumber(item?.fltRt);
  const previousClose = Number.isFinite(change) && price - change > 0 ? price - change : null;
  const changePercent = Number.isFinite(suppliedChangePercent)
    ? suppliedChangePercent
    : previousClose
      ? (change / previousClose) * 100
      : null;

  const record = {
    ticker,
    name: String(item?.itmsNm || "").trim() || null,
    exchange,
    currency: "KRW",
    asOf,
    price,
    open: parseNumber(item?.mkp, { allowZero: false }),
    high: parseNumber(item?.hipr, { allowZero: false }),
    low: parseNumber(item?.lopr, { allowZero: false }),
    previousClose,
    change,
    changePercent,
    volume: parseNumber(item?.trqu),
    turnover: parseNumber(item?.trPrc),
    listedShares: parseNumber(item?.lstgStCnt, { allowZero: false }),
    marketCap: parseNumber(item?.mrktTotAmt, { allowZero: false })
  };
  if (!quoteOhlcIsSane(record) || !marketCapIsSane(record)) return null;
  return record;
}

function buildUrl(apiKey, basDt, pageNo, numOfRows) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("serviceKey", decodedServiceKey(apiKey));
  url.searchParams.set("resultType", "json");
  url.searchParams.set("basDt", basDt);
  url.searchParams.set("pageNo", String(pageNo));
  url.searchParams.set("numOfRows", String(numOfRows));
  return url;
}

async function fetchPage({ apiKey, basDt, pageNo, numOfRows, fetchJsonImpl }) {
  const payload = await fetchJsonImpl(buildUrl(apiKey, basDt, pageNo, numOfRows), {
    timeoutMs: 45_000,
    retries: 3
  });
  const page = itemsFrom(payload);
  if (page.pageNo !== null && page.pageNo !== pageNo) {
    throw new Error(`금융위원회 주식시세 페이지 번호가 바뀌었습니다: ${page.pageNo}/${pageNo}`);
  }
  return page;
}

export async function fetchLatestKrStockPrices({
  apiKey,
  now = new Date(),
  lookbackDays = 10,
  pageSize = 1_000,
  fetchJsonImpl = fetchJson
} = {}) {
  if (!String(apiKey || "").trim()) {
    throw new Error("DATA_GO_KR_API_KEY가 설정되지 않았습니다.");
  }
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 31) {
    throw new RangeError("한국 시세 역탐색 일수는 1~31이어야 합니다.");
  }
  if (!Number.isInteger(pageSize) || pageSize < 100 || pageSize > 10_000) {
    throw new RangeError("한국 시세 페이지 크기는 100~10000이어야 합니다.");
  }

  const start = kstDate(now);
  for (let offset = 0; offset < lookbackDays; offset += 1) {
    const date = new Date(start.getTime() - offset * 86_400_000);
    const basDt = compactDate(date);
    const first = await fetchPage({
      apiKey,
      basDt,
      pageNo: 1,
      numOfRows: pageSize,
      fetchJsonImpl
    });
    if (first.totalCount === 0) continue;

    const pageCount = Math.ceil(first.totalCount / pageSize);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 200) {
      throw new Error(`금융위원회 주식시세 페이지 수 안전 상한을 벗어났습니다: ${pageCount}`);
    }
    const pages = [first.items];
    for (let pageNo = 2; pageNo <= pageCount; pageNo += 1) {
      const page = await fetchPage({ apiKey, basDt, pageNo, numOfRows: pageSize, fetchJsonImpl });
      if (page.totalCount !== first.totalCount) {
        throw new Error("금융위원회 주식시세 페이지 사이 totalCount가 바뀌었습니다.");
      }
      pages.push(page.items);
    }

    const rawItems = pages.flat();
    if (rawItems.length !== first.totalCount) {
      throw new Error(
        `금융위원회 주식시세 페이지가 완전하지 않습니다: ${rawItems.length}/${first.totalCount}`
      );
    }

    const byTicker = new Map();
    const expectedDate = isoDate(basDt);
    for (const item of rawItems) {
      if (isoDate(item?.basDt) !== expectedDate) {
        throw new Error("금융위원회 주식시세 페이지에 다른 기준일 데이터가 섞였습니다.");
      }
      const record = normalizeKrStockPriceItem(item);
      if (!record) continue;
      if (byTicker.has(record.ticker)) {
        throw new Error(`금융위원회 주식시세 종목 코드가 중복되었습니다: ${record.ticker}`);
      }
      byTicker.set(record.ticker, record);
    }
    if (byTicker.size === 0) continue;
    return { asOf: expectedDate, records: [...byTicker.values()] };
  }

  throw new Error(`최근 ${lookbackDays}일 안에 금융위원회 주식시세 데이터가 없습니다.`);
}

function normalizedKrTicker(value) {
  const ticker = String(value ?? "").trim();
  return /^\d{1,6}$/.test(ticker) ? ticker.padStart(6, "0") : null;
}

function referenceDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("시세 freshness 기준시각이 올바르지 않습니다.");
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

function assertCoverageOptions({
  minimumMatched,
  minimumMatchRatio,
  previousMatched,
  maxAgeDays,
  maxPreviousDropFraction
}) {
  if (!Number.isInteger(minimumMatched) || minimumMatched < 0) {
    throw new RangeError("한국 시세 minimumMatched가 올바르지 않습니다.");
  }
  if (!Number.isFinite(minimumMatchRatio) || minimumMatchRatio < 0 || minimumMatchRatio > 1) {
    throw new RangeError("한국 시세 minimumMatchRatio가 올바르지 않습니다.");
  }
  if (previousMatched !== null && (!Number.isInteger(previousMatched) || previousMatched < 0)) {
    throw new RangeError("한국 시세 previousMatched가 올바르지 않습니다.");
  }
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 31) {
    throw new RangeError("시세 freshness 허용일은 1~31이어야 합니다.");
  }
  if (
    !Number.isFinite(maxPreviousDropFraction) ||
    maxPreviousDropFraction < 0 ||
    maxPreviousDropFraction >= 1
  ) {
    throw new RangeError("이전 시세 커버리지 허용 하락률은 0 이상 1 미만이어야 합니다.");
  }
}

export function enrichKrCompaniesWithPrices(
  companies,
  snapshot,
  {
    fetchedAt = new Date().toISOString(),
    minimumMatched = 2_000,
    minimumMatchRatio = 0.75,
    previousMatched = null,
    maxPreviousDropFraction = DEFAULT_MAX_PREVIOUS_DROP_FRACTION,
    maxAgeDays = DEFAULT_MAX_AGE_DAYS,
    now = new Date()
  } = {}
) {
  if (!Array.isArray(companies)) throw new TypeError("companies는 배열이어야 합니다.");
  assertCoverageOptions({
    minimumMatched,
    minimumMatchRatio,
    previousMatched,
    maxAgeDays,
    maxPreviousDropFraction
  });
  const currentTime = referenceDate(now);
  const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
  const recordDates = new Set(records.map((record) => strictIsoDate(record?.asOf)).filter(Boolean));
  const snapshotDate = strictIsoDate(snapshot?.asOf) ||
    (snapshot?.asOf === undefined && recordDates.size === 1 ? [...recordDates][0] : null);
  const snapshotFreshness = freshnessFor(snapshotDate, currentTime, maxAgeDays);
  if (!snapshotDate || snapshotFreshness.status !== "current") {
    throw new Error(`한국 시세 기준일이 미래이거나 오래되었습니다: ${snapshot?.asOf || "없음"}`);
  }
  const byTicker = new Map();
  for (const record of records) {
    const ticker = normalizedKrTicker(record?.ticker);
    if (!ticker || record?.asOf !== snapshotDate || !quoteOhlcIsSane(record) || !marketCapIsSane(record)) {
      throw new Error("한국 시세 snapshot 레코드가 표준 스키마와 일치하지 않습니다.");
    }
    if (byTicker.has(ticker)) throw new Error(`한국 시세 snapshot ticker 중복: ${ticker}`);
    byTicker.set(ticker, record);
  }
  const krCompanies = companies.filter((company) => company.country === "KR");
  const matches = krCompanies.filter((company) => byTicker.has(normalizedKrTicker(company.ticker))).length;
  const ratio = krCompanies.length ? matches / krCompanies.length : 0;
  const baseline = previousMatched ?? previousPublicPriceCount(krCompanies);
  const previousFloor = Math.ceil(baseline * (1 - maxPreviousDropFraction));

  if (matches < minimumMatched || ratio < minimumMatchRatio || matches < previousFloor) {
    throw new Error(
      `한국 시세 매칭 커버리지가 안전 기준보다 낮습니다: ${matches}/${krCompanies.length}` +
        (baseline ? ` · 이전 ${baseline}개 기준 하한 ${previousFloor}개` : "")
    );
  }

  let applied = 0;
  let preservedNewer = 0;
  const nextCompanies = companies.map((company) => {
    if (company.country !== "KR") return company;
    const record = byTicker.get(normalizedKrTicker(company.ticker));
    if (!record) return withExistingFreshness(company, currentTime, maxAgeDays);
    const existingDate = strictIsoDate(company.marketData?.asOf);
    if (existingDate && existingDate > record.asOf) {
      preservedNewer += 1;
      return withExistingFreshness(company, currentTime, maxAgeDays);
    }

    const marketData = attachMarketValuation(company, {
      status: "ok",
      usageMode: "public",
      ticker: record.ticker,
      exchange: record.exchange,
      currency: record.currency,
      asOf: record.asOf,
      fetchedAt,
      price: record.price,
      open: record.open,
      high: record.high,
      low: record.low,
      previousClose: record.previousClose,
      change: record.change,
      changePercent: record.changePercent,
      volume: record.volume,
      turnover: record.turnover,
      listedShares: record.listedShares,
      marketCap: record.marketCap,
      securityMarketCap: record.marketCap,
      marketCapScope: "security",
      freshness: "current",
      ageDays: snapshotFreshness.ageDays,
      source: KR_STOCK_PRICE_SOURCE
    });
    applied += 1;
    return { ...company, marketData };
  });

  return {
    companies: nextCompanies,
    coverage: {
      matched: matches,
      applied,
      preservedNewer,
      previousMatched: baseline,
      previousFloor,
      ratio,
      total: krCompanies.length
    },
    matched: matches,
    applied,
    preservedNewer,
    freshness: snapshotFreshness,
    asOf: snapshotDate
  };
}
