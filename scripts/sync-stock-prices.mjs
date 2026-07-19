import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { getRuntimeConfig } from "../lib/config.mjs";
import {
  enrichKrCompaniesWithPrices,
  fetchLatestKrStockPrices,
  KR_STOCK_PRICE_SOURCE
} from "../lib/providers/kr-stock-price.mjs";
import {
  enrichUsCompaniesWithLicensedPrices,
  fetchLicensedUsSnapshot
} from "../lib/providers/licensed-stock-price.mjs";
import { acquireSyncLock, writeDataset } from "../lib/store.mjs";

const DEFAULT_MAX_QUOTE_AGE_DAYS = 10;

function safeMessage(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter(Boolean)) {
    message = message.replaceAll(secret, "[REDACTED]");
    try {
      message = message.replaceAll(encodeURIComponent(secret), "[REDACTED]");
      message = message.replaceAll(decodeURIComponent(secret), "[REDACTED]");
    } catch {
      // Keep redaction best-effort when a value is not valid percent encoding.
    }
  }
  return message
    .replace(/([?&](?:serviceKey|apiKey|api_key|token|key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,}]+/gi, "$1[REDACTED]")
    .slice(0, 1_000);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJsonAtomic(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp-" + process.pid;
  await writeFile(temporary, JSON.stringify(payload) + "\n", "utf8");
  await rename(temporary, file);
}

function previousProvider(meta, code) {
  return (meta?.marketData?.providers || []).find((provider) => provider.code === code) || null;
}

function providerState(code, provider, configured, previous = null) {
  return {
    code,
    provider,
    status: configured ? "pending" : "not_configured",
    attempted: configured,
    asOf: previous?.asOf || null,
    matched: 0,
    applied: 0,
    total: 0,
    lastSuccessAt: previous?.lastSuccessAt || null,
    lastSuccessAsOf: previous?.lastSuccessAsOf || previous?.asOf || null,
    error: configured ? null : "필요한 환경변수가 설정되지 않았습니다."
  };
}

function strictIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return date;
}

function quoteAgeDays(asOf, now) {
  const date = strictIsoDate(asOf);
  if (!date) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - date.getTime()) / 86_400_000);
}

function preserveExistingQuotes(companies, country, now, maxAgeDays) {
  return companies.map((company) => {
    if (company.country !== country || company.marketData?.usageMode !== "public") return company;
    const ageDays = quoteAgeDays(company.marketData.asOf, now);
    const freshness = ageDays >= 0 && ageDays <= maxAgeDays ? "current" : "stale";
    return {
      ...company,
      marketData: {
        ...company.marketData,
        status: freshness === "stale" ? "stale" : "preserved",
        freshness,
        ageDays: Number.isFinite(ageDays) ? ageDays : null
      }
    };
  });
}

function marketDataCounts(companies) {
  const result = {
    coverage: { kr: 0, us: 0 },
    available: { kr: 0, us: 0 },
    preserved: { kr: 0, us: 0 },
    stale: { kr: 0, us: 0 }
  };
  for (const company of companies) {
    const key = company.country === "KR" ? "kr" : company.country === "US" ? "us" : null;
    const quote = company.marketData;
    if (!key || quote?.usageMode !== "public" || !Number.isFinite(quote.price)) continue;
    result.available[key] += 1;
    if (quote.status === "ok" && quote.freshness === "current") result.coverage[key] += 1;
    if (quote.status === "preserved") result.preserved[key] += 1;
    if (quote.status === "stale" || quote.freshness === "stale") result.stale[key] += 1;
  }
  return result;
}

function previousMatched(dataset, code, country) {
  const provider = previousProvider(dataset.meta, code);
  if (Number.isInteger(provider?.matched) && provider.matched > 0) return provider.matched;
  return (dataset.companies || []).filter(
    (company) => company.country === country && company.marketData?.usageMode === "public"
  ).length;
}

function mergeSources(existing, additions) {
  const byUrl = new Map();
  for (const source of [...(existing || []), ...additions].filter(Boolean)) {
    const key = source.url || source.name;
    if (!key) continue;
    byUrl.set(key, source);
  }
  return [...byUrl.values()];
}

function configuredFailures(providers) {
  return providers.filter(
    (provider) => provider.attempted && provider.status !== "ok"
  );
}

export async function syncStockPrices(config = getRuntimeConfig(), options = {}) {
  const now = options.now || new Date();
  const generatedAt = now.toISOString();
  const progress = options.onProgress || (() => {});
  const maxAgeDays = options.maxQuoteAgeDays || DEFAULT_MAX_QUOTE_AGE_DAYS;
  const release = options.acquireLock === false
    ? async () => {}
    : await acquireSyncLock(config.dataFile);
  const secrets = [
    config.dataGoKrApiKey,
    config.usLicensedPriceSnapshotToken,
    config.usLicensedPriceSnapshotUrl
  ];

  try {
    const dataset = await readJson(config.dataFile);
    let companies = dataset.companies || [];
    companies = preserveExistingQuotes(companies, "KR", now, maxAgeDays);
    companies = preserveExistingQuotes(companies, "US", now, maxAgeDays);
    const providers = {
      KR: providerState(
        "KR_PUBLIC",
        "금융위원회 주식시세정보",
        Boolean(config.dataGoKrApiKey),
        previousProvider(dataset.meta, "KR_PUBLIC")
      ),
      US: providerState(
        "US_LICENSED_PUBLIC",
        "사용자 라이선스 미국 시세 snapshot",
        Boolean(config.usLicensedPriceSnapshotUrl),
        previousProvider(dataset.meta, "US_LICENSED_PUBLIC")
      )
    };
    const addedSources = [];

    if (config.dataGoKrApiKey) {
      try {
        progress("금융위원회 한국 전 종목 시세 수집");
        const snapshot = await fetchLatestKrStockPrices({
          apiKey: config.dataGoKrApiKey,
          now,
          fetchJsonImpl: options.fetchKrJsonImpl
        });
        const enriched = enrichKrCompaniesWithPrices(companies, snapshot, {
          fetchedAt: generatedAt,
          now,
          maxAgeDays,
          previousMatched: previousMatched(dataset, "KR_PUBLIC", "KR"),
          ...(options.krCoverageOptions || {})
        });
        if (enriched.applied < 1) throw new Error("한국 시세가 실제 회사에 한 건도 반영되지 않았습니다.");
        companies = enriched.companies;
        Object.assign(providers.KR, {
          status: "ok",
          asOf: enriched.asOf,
          matched: enriched.coverage.matched,
          applied: enriched.applied,
          preservedNewer: enriched.preservedNewer,
          total: enriched.coverage.total,
          lastSuccessAt: generatedAt,
          lastSuccessAsOf: enriched.asOf,
          error: null
        });
        addedSources.push(KR_STOCK_PRICE_SOURCE);
      } catch (error) {
        providers.KR.status = "failed_preserved";
        providers.KR.error = safeMessage(error, secrets);
        progress("한국 시세 보존: " + providers.KR.error);
      }
    }

    if (config.usLicensedPriceSnapshotUrl) {
      try {
        progress("재배포 라이선스 보유 미국 시세 snapshot 수집");
        const snapshot = await fetchLicensedUsSnapshot({
          url: config.usLicensedPriceSnapshotUrl,
          token: config.usLicensedPriceSnapshotToken,
          allowedHosts: config.usLicensedPriceAllowedHosts,
          now,
          maxAgeDays,
          fetchJsonImpl: options.fetchLicensedJsonImpl
        });
        const enriched = enrichUsCompaniesWithLicensedPrices(companies, snapshot, {
          fetchedAt: generatedAt,
          now,
          maxAgeDays,
          previousMatched: previousMatched(dataset, "US_LICENSED_PUBLIC", "US"),
          ...(options.usCoverageOptions || {})
        });
        if (enriched.applied < 1) throw new Error("미국 시세가 실제 회사에 한 건도 반영되지 않았습니다.");
        companies = enriched.companies;
        Object.assign(providers.US, {
          provider: snapshot.manifest.provider,
          status: "ok",
          asOf: enriched.asOf,
          matched: enriched.coverage.matched,
          applied: enriched.applied,
          preservedNewer: enriched.preservedNewer,
          total: enriched.coverage.total,
          lastSuccessAt: generatedAt,
          lastSuccessAsOf: enriched.asOf,
          error: null,
          licenseReference: snapshot.manifest.licenseReference,
          licenseId: snapshot.manifest.licenseId,
          rightsReviewedAt: snapshot.manifest.rightsReviewedAt
        });
        addedSources.push({
          name: snapshot.manifest.provider,
          url: snapshot.manifest.sourceUrl,
          licenseReference: snapshot.manifest.licenseReference,
          licenseId: snapshot.manifest.licenseId,
          rightsReviewedAt: snapshot.manifest.rightsReviewedAt
        });
      } catch (error) {
        providers.US.status = "failed_preserved";
        providers.US.error = safeMessage(error, secrets);
        progress("미국 공개 시세 보존: " + providers.US.error);
      }
    }

    const providerList = Object.values(providers);
    const counts = marketDataCounts(companies);
    const anyApplied = providerList.some((provider) => provider.status === "ok" && provider.applied > 0);
    const marketData = {
      updatedAt: anyApplied ? generatedAt : dataset.meta?.marketData?.updatedAt || null,
      lastAttemptAt: generatedAt,
      maxQuoteAgeDays: maxAgeDays,
      coverage: counts.coverage,
      available: counts.available,
      preserved: counts.preserved,
      stale: counts.stale,
      providers: providerList
    };
    const nextDataset = {
      ...dataset,
      meta: {
        ...(dataset.meta || {}),
        schemaVersion: Math.max(3, Number(dataset.meta?.schemaVersion) || 0),
        sources: mergeSources(dataset.meta?.sources, addedSources),
        marketData
      },
      companies
    };
    await writeDataset(config.dataFile, nextDataset);
    const failures = configuredFailures(providerList);
    await writeJsonAtomic(config.priceSyncDiagnosticsFile, {
      generatedAt,
      ...counts,
      providers: providerList,
      configuredFailureCount: failures.length
    });
    const result = { dataset: nextDataset, providers: providerList, failures };
    if (failures.length > 0 && options.failOnConfiguredProviderError !== false) {
      const error = new Error(
        "설정된 시세 공급자 갱신 실패: " +
          failures.map((provider) => `${provider.code} (${provider.error})`).join(" · ")
      );
      error.result = result;
      throw error;
    }
    return result;
  } finally {
    await release();
  }
}

async function main() {
  try {
    await syncStockPrices(getRuntimeConfig(), {
      onProgress: (message) => console.log("[PRICE] " + message)
    });
  } catch (error) {
    console.error("주식시세 동기화 실패:", safeMessage(error));
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
