import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

import { acquireSyncLock, writeDataset } from "./store.mjs";
import { attachMarketValuation } from "./market-valuation.mjs";

const DAY_MS = 86_400_000;
export const MARKET_DATA_STALE_AFTER_DAYS = 10;

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function redact(value) {
  return String(value || "")
    .replace(/crtfc_key=[^&\s]+/gi, "crtfc_key=[REDACTED]")
    .replace(/\b[a-f0-9]{40}\b/gi, "[REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 2_000);
}

async function readJson(file, { optional = false } = {}) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readRegional(file) {
  try {
    return { dataset: await readJson(file, { optional: true }), error: null };
  } catch (error) {
    return { dataset: null, error: messageOf(error) };
  }
}

async function readRemoteMarketData(file) {
  if (!file) return { dataset: null, error: null };
  const result = await readRegional(file);
  if (result.error || !result.dataset) return result;
  if (!Array.isArray(result.dataset.companies)) {
    return { dataset: null, error: "원격 공개 시세 파일의 companies 배열이 없습니다." };
  }
  return result;
}

function validRegionalDataset(dataset, country) {
  return Boolean(
    dataset &&
      Array.isArray(dataset.companies) &&
      dataset.companies.length > 0 &&
      dataset.companies.every(
        (company) => company.country === country && company.dataMode !== "demo"
      )
  );
}

function preservedOfficialCompanies(companies, country) {
  return companies.filter(
    (company) => company.country === country && company.dataMode !== "demo"
  );
}

function markStale(companies, error) {
  const reason = redact(error);
  return companies.map((company) => ({
    ...company,
    stale: true,
    syncStatus: "error",
    syncError: reason
  }));
}

function strictDateMs(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return timestamp;
}

function timestampMs(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function usablePublicMarketData(marketData, nowMs) {
  if (
    !marketData ||
    typeof marketData !== "object" ||
    marketData.usageMode !== "public" ||
    !Number.isFinite(marketData.price) ||
    marketData.price <= 0
  ) {
    return false;
  }
  const asOfMs = strictDateMs(marketData.asOf);
  return asOfMs !== null && asOfMs <= nowMs + DAY_MS;
}

function isStaleMarketData(marketData, nowMs) {
  if (marketData?.status === "stale" || marketData?.freshness === "stale") return true;
  const asOfMs = strictDateMs(marketData?.asOf);
  if (asOfMs === null) return true;
  const ageDays = Math.floor((nowMs - asOfMs) / DAY_MS);
  return ageDays < 0 || ageDays > MARKET_DATA_STALE_AFTER_DAYS;
}

function chooseLatestPublicMarketData(candidates, nowMs) {
  return candidates
    .map((marketData, index) => ({
      marketData,
      index,
      asOfMs: strictDateMs(marketData?.asOf),
      fetchedAtMs: timestampMs(marketData?.fetchedAt) || 0,
      statusRank:
        marketData?.status === "ok" && marketData?.freshness !== "stale"
          ? 2
          : marketData?.status === "preserved" && marketData?.freshness !== "stale"
            ? 1
            : 0
    }))
    .filter((candidate) => usablePublicMarketData(candidate.marketData, nowMs))
    .sort(
      (left, right) =>
        right.asOfMs - left.asOfMs ||
        right.statusRank - left.statusRank ||
        right.fetchedAtMs - left.fetchedAtMs ||
        left.index - right.index
    )[0]?.marketData || null;
}

function carryPublicMarketData(companies, previousCompanies, remoteCompanies, nowMs) {
  const previousById = new Map(previousCompanies.map((company) => [company.id, company]));
  const remoteById = new Map(remoteCompanies.map((company) => [company.id, company]));
  return companies.map((company) => {
    const previous = previousById.get(company.id);
    const remote = remoteById.get(company.id);
    const marketData = chooseLatestPublicMarketData(
      [company.marketData, previous?.marketData, remote?.marketData],
      nowMs
    );
    const { marketData: _discardedMarketData, ...companyWithoutMarketData } = company;
    if (!marketData) return companyWithoutMarketData;
    const stale = isStaleMarketData(marketData, nowMs);
    const status = stale
      ? "stale"
      : marketData.status === "preserved"
        ? "preserved"
        : "ok";
    return {
      ...companyWithoutMarketData,
      marketData: attachMarketValuation(companyWithoutMarketData, {
        ...marketData,
        status,
        freshness: stale ? "stale" : "current"
      })
    };
  });
}

function emptyCountryCounts() {
  return { kr: 0, us: 0 };
}

function incrementCountry(counts, country) {
  if (country === "KR") counts.kr += 1;
  if (country === "US") counts.us += 1;
}

function marketDataCoverage(companies, nowMs) {
  const coverage = emptyCountryCounts();
  const available = emptyCountryCounts();
  const preserved = emptyCountryCounts();
  const stale = emptyCountryCounts();
  for (const company of companies) {
    if (!usablePublicMarketData(company.marketData, nowMs)) continue;
    incrementCountry(available, company.country);
    if (isStaleMarketData(company.marketData, nowMs)) incrementCountry(stale, company.country);
    else if (company.marketData.status === "preserved") {
      incrementCountry(preserved, company.country);
    } else {
      incrementCountry(coverage, company.country);
    }
  }
  return { coverage, available, preserved, stale };
}

function latestTimestamp(values) {
  return values
    .filter(Boolean)
    .map((value) => ({ value, timestamp: timestampMs(value) }))
    .filter((entry) => entry.timestamp !== null)
    .sort((left, right) => right.timestamp - left.timestamp)[0]?.value || null;
}

function providerIdentity(provider) {
  return String(
    provider?.code ||
      provider?.id ||
      [provider?.country, provider?.provider || provider?.name].filter(Boolean).join(":") ||
      JSON.stringify(provider)
  );
}

function providerTimestamp(provider) {
  return Math.max(
    0,
    ...[
      provider?.lastSuccessAt,
      provider?.updatedAt,
      provider?.asOf ? provider.asOf + "T23:59:59.999Z" : null
    ].map((value) => timestampMs(value) || 0)
  );
}

function providerStatusRank(provider) {
  return ["ok", "current"].includes(provider?.status)
    ? 3
    : provider?.status === "stale"
      ? 2
      : provider?.status === "not_configured"
        ? 0
        : 1;
}

function mergeMarketProviders(...providerLists) {
  const providers = new Map();
  for (const provider of providerLists.flat().filter(Boolean)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    const key = providerIdentity(provider);
    const existing = providers.get(key);
    if (
      !existing ||
      providerTimestamp(provider) > providerTimestamp(existing) ||
      (providerTimestamp(provider) === providerTimestamp(existing) &&
        providerStatusRank(provider) > providerStatusRank(existing))
    ) {
      providers.set(key, provider);
    }
  }
  return [...providers.values()];
}

function mergeSources(...sourceLists) {
  const sources = new Map();
  for (const source of sourceLists.flat().filter(Boolean)) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const key = String(source.url || source.name || "");
    if (key) sources.set(key, source);
  }
  return [...sources.values()];
}

function providerState({ country, dataset, companies, run, fallbackSourceUpdatedAt = null }) {
  return {
    country,
    status: run?.attempted ? (run.success ? "ok" : "failed") : "preserved",
    companyCount: companies.length,
    sourceUpdatedAt:
      dataset?.meta?.sourceUpdatedAt || dataset?.meta?.updatedAt || fallbackSourceUpdatedAt,
    error: run?.error ? redact(run.error) : null
  };
}

function overallDataMode(companies) {
  if (companies.length === 0) return "demo";
  const demoCount = companies.filter((company) => company.dataMode === "demo").length;
  const staleCount = companies.filter((company) => company.stale).length;
  const officialCount = companies.length - demoCount;
  if (demoCount === companies.length) return "demo";
  if (demoCount > 0 || staleCount > 0 || officialCount === 0) return "mixed";
  return "live";
}

function syncSummary(runs, providers) {
  const attemptedRuns = Object.values(runs).filter((run) => run?.attempted);
  const successfulRuns = attemptedRuns.filter((run) => run.success);
  const errors = attemptedRuns
    .filter((run) => !run.success)
    .map((run) => ({
      provider: run.provider,
      company: null,
      message: redact(run.error)
    }));
  const missingCountries = providers.filter((provider) => provider.companyCount === 0);
  for (const provider of missingCountries) {
    errors.push({
      provider: provider.country,
      company: null,
      message: "저장된 지역 스냅샷이 없습니다."
    });
  }

  return {
    status:
      errors.length === 0
        ? "ok"
        : successfulRuns.length > 0 || providers.some((provider) => provider.companyCount > 0)
          ? "partial"
          : "failed",
    successful: successfulRuns.length,
    attempted: attemptedRuns.length,
    failed: attemptedRuns.length - successfulRuns.length,
    errors: errors.slice(0, 20)
  };
}

function marketMetaTimestamp(meta) {
  return Math.max(
    0,
    ...[meta?.updatedAt, meta?.lastAttemptAt, meta?.sourceUpdatedAt].map(
      (value) => timestampMs(value) || 0
    )
  );
}

function buildMarketDataMeta({ current, krRegional, usRegional, remote, companies, nowMs }) {
  const metas = [
    current?.meta?.marketData,
    krRegional?.meta?.marketData,
    usRegional?.meta?.marketData,
    remote?.meta?.marketData
  ].filter((meta) => meta && typeof meta === "object" && !Array.isArray(meta));
  const preferred = [...metas].sort(
    (left, right) => marketMetaTimestamp(right) - marketMetaTimestamp(left)
  )[0] || {};
  const counts = marketDataCoverage(companies, nowMs);
  const selectedMarketData = companies
    .map((company) => company.marketData)
    .filter((marketData) => usablePublicMarketData(marketData, nowMs));
  const updatedAt = latestTimestamp([
    ...metas.map((meta) => meta.updatedAt),
    ...selectedMarketData.map(
      (marketData) => marketData.fetchedAt || marketData.asOf + "T23:59:59.999Z"
    )
  ]);
  const lastAttemptAt = latestTimestamp(metas.map((meta) => meta.lastAttemptAt));
  const providers = mergeMarketProviders(...metas.map((meta) => meta.providers || []));
  const previousRemoteLineage = current?.meta?.marketData?.remoteSnapshot || null;
  const remoteLineage = remote?.meta
    ? {
        fetchedAt: remote.meta.fetchedAt || null,
        sourceUpdatedAt: remote.meta.sourceUpdatedAt || null,
        remoteRevision: remote.meta.remoteRevision || null,
        sourceUrl: remote.meta.sourceUrl || null,
        coverage: remote.meta.coverage || null
      }
    : previousRemoteLineage;

  return {
    ...preferred,
    updatedAt,
    ...(lastAttemptAt ? { lastAttemptAt } : {}),
    coverage: counts.coverage,
    available: counts.available,
    preserved: counts.preserved,
    stale: counts.stale,
    providers,
    ...(remoteLineage ? { remoteSnapshot: remoteLineage } : {})
  };
}

async function writeDiagnostics(file, payload) {
  if (!file) return;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp";
  await writeFile(temporary, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await rename(temporary, file);
}

export async function mergeMarketDatasets(
  config,
  { runs = {}, acquireLock = true, now = new Date() } = {}
) {
  const release = acquireLock ? await acquireSyncLock(config.dataFile) : async () => {};

  try {
    const mergeDate = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(mergeDate.getTime())) throw new Error("병합 기준시각이 올바르지 않습니다.");
    const nowMs = mergeDate.getTime();
    const current = await readJson(config.dataFile, { optional: true });
    const [krRead, usRead, remoteRead] = await Promise.all([
      readRegional(config.krMarketDataFile),
      readRegional(config.usMarketDataFile),
      readRemoteMarketData(config.remoteMarketDataFile)
    ]);
    const krRegional = krRead.dataset;
    const usRegional = usRead.dataset;
    const remoteMarketData = remoteRead.dataset;
    const effectiveRuns = {
      ...runs,
      ...(krRead.error
        ? {
            KR: {
              provider: "Open DART",
              attempted: true,
              success: false,
              error: "한국 지역 스냅샷을 읽지 못했습니다: " + krRead.error
            }
          }
        : {}),
      ...(usRead.error
        ? {
            US: {
              provider: "SEC EDGAR bulk",
              attempted: true,
              success: false,
              error: "미국 지역 스냅샷을 읽지 못했습니다: " + usRead.error
            }
          }
        : {}),
      ...(remoteRead.error
        ? {
            REMOTE_MARKET_DATA: {
              provider: "GitHub public market data",
              attempted: true,
              success: false,
              error: "원격 공개 시세 파일을 읽지 못했습니다: " + remoteRead.error
            }
          }
        : {})
    };
    const currentCompanies = Array.isArray(current?.companies) ? current.companies : [];
    const remoteCompanies = Array.isArray(remoteMarketData?.companies)
      ? remoteMarketData.companies
      : [];

    let krCompanies = validRegionalDataset(krRegional, "KR")
      ? krRegional.companies
      : preservedOfficialCompanies(currentCompanies, "KR");
    let usCompanies = validRegionalDataset(usRegional, "US")
      ? usRegional.companies
      : preservedOfficialCompanies(currentCompanies, "US");

    krCompanies = carryPublicMarketData(
      krCompanies,
      currentCompanies,
      remoteCompanies,
      nowMs
    );
    usCompanies = carryPublicMarketData(
      usCompanies,
      currentCompanies,
      remoteCompanies,
      nowMs
    );

    if (effectiveRuns.KR?.attempted && !effectiveRuns.KR.success)
      krCompanies = markStale(krCompanies, effectiveRuns.KR.error);
    if (effectiveRuns.US?.attempted && !effectiveRuns.US.success)
      usCompanies = markStale(usCompanies, effectiveRuns.US.error);

    const previousProviders = new Map(
      (current?.meta?.providers || []).map((provider) => [provider.country, provider])
    );
    const providers = [
      providerState({
        country: "KR",
        dataset: krRegional,
        companies: krCompanies,
        run: effectiveRuns.KR,
        fallbackSourceUpdatedAt: previousProviders.get("KR")?.sourceUpdatedAt || null
      }),
      providerState({
        country: "US",
        dataset: usRegional,
        companies: usCompanies,
        run: effectiveRuns.US,
        fallbackSourceUpdatedAt: previousProviders.get("US")?.sourceUpdatedAt || null
      })
    ];
    const companies = [...krCompanies, ...usCompanies];
    const sync = syncSummary(effectiveRuns, providers);
    const dataMode = overallDataMode(companies);
    const mergedAt = mergeDate.toISOString();
    const sourceUpdatedAt = providers
      .map((provider) => provider.sourceUpdatedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || current?.meta?.sourceUpdatedAt || current?.meta?.updatedAt || mergedAt;
    const dataset = {
      meta: {
        schemaVersion: 3,
        dataMode,
        // updatedAt은 기존 클라이언트 호환을 위해 실제 원천 기준시각을 유지한다.
        updatedAt: sourceUpdatedAt,
        sourceUpdatedAt,
        mergedAt,
        note:
          sync.status === "ok"
            ? "한국·미국 공식 공시 전체시장 스냅샷입니다. 평가 보류와 결측치는 그대로 표시합니다."
            : providers.some((provider) => provider.status === "failed")
              ? "일부 공급원 갱신이 실패해 마지막 정상 스냅샷을 보존했습니다. 회사별 stale·완전성을 확인하세요."
              : "아직 정상 스냅샷이 없는 국가는 제외하고 확보된 공식 시장만 표시합니다.",
        sources: mergeSources(
          [
            { name: "Open DART", url: "https://opendart.fss.or.kr/" },
            {
              name: "SEC EDGAR",
              url: "https://www.sec.gov/search-filings/edgar-application-programming-interfaces"
            }
          ],
          current?.meta?.sources || [],
          krRegional?.meta?.sources || [],
          usRegional?.meta?.sources || [],
          remoteMarketData?.meta?.sources || []
        ),
        coverage: {
          total: companies.length,
          kr: krCompanies.length,
          us: usCompanies.length
        },
        marketData: buildMarketDataMeta({
          current,
          krRegional,
          usRegional,
          remote: remoteMarketData,
          companies,
          nowMs
        }),
        providers,
        sync
      },
      companies
    };

    await writeDataset(config.dataFile, dataset);
    await writeDiagnostics(config.syncDiagnosticsFile, {
      updatedAt: sourceUpdatedAt,
      mergedAt,
      dataMode,
      coverage: dataset.meta.coverage,
      providers,
      sync
    });
    return dataset;
  } catch (error) {
    throw new Error("전체시장 스냅샷 병합 실패: " + redact(messageOf(error)));
  } finally {
    await release();
  }
}
