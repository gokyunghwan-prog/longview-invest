import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

import { acquireSyncLock, writeDataset } from "./store.mjs";

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
    const current = await readJson(config.dataFile, { optional: true });
    const [krRead, usRead] = await Promise.all([
      readRegional(config.krMarketDataFile),
      readRegional(config.usMarketDataFile)
    ]);
    const krRegional = krRead.dataset;
    const usRegional = usRead.dataset;
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
        : {})
    };
    const currentCompanies = Array.isArray(current?.companies) ? current.companies : [];

    let krCompanies = validRegionalDataset(krRegional, "KR")
      ? krRegional.companies
      : preservedOfficialCompanies(currentCompanies, "KR");
    let usCompanies = validRegionalDataset(usRegional, "US")
      ? usRegional.companies
      : preservedOfficialCompanies(currentCompanies, "US");

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
    const mergedAt = now.toISOString();
    const sourceUpdatedAt = providers
      .map((provider) => provider.sourceUpdatedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || current?.meta?.sourceUpdatedAt || current?.meta?.updatedAt || mergedAt;
    const dataset = {
      meta: {
        schemaVersion: 2,
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
        sources: [
          { name: "Open DART", url: "https://opendart.fss.or.kr/" },
          {
            name: "SEC EDGAR",
            url: "https://www.sec.gov/search-filings/edgar-application-programming-interfaces"
          }
        ],
        coverage: {
          total: companies.length,
          kr: krCompanies.length,
          us: usCompanies.length
        },
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
