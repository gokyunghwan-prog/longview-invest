import { acquireSyncLock } from "./store.mjs";
import { mergeMarketDatasets } from "./market-dataset.mjs";
import { syncDartMarket } from "./providers/dart-market.mjs";
import { refreshRemoteUsSnapshot } from "./remote-snapshot.mjs";
import { syncStockPrices } from "../scripts/sync-stock-prices.mjs";

function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/crtfc_key=[^&\s]+/gi, "crtfc_key=[REDACTED]")
    .replace(/\b[a-f0-9]{40}\b/gi, "[REDACTED]");
}

/**
 * 로컬/상시 서버용 전체시장 동기화.
 * 한국은 DART 전체시장을 갱신하고, 미국은 GitHub Actions가 만든 마지막 bulk
 * 스냅샷을 보존한다. SEC bulk ZIP은 로컬 서버 요청에서 내려받지 않는다.
 */
export async function syncAll(config, { onProgress = () => {} } = {}) {
  const releaseLock = await acquireSyncLock(config.dataFile);
  const runs = {
    KR: {
      provider: "Open DART",
      attempted: Boolean(config.dartApiKey),
      success: false,
      error: null
    },
    US: {
      provider: "SEC EDGAR bulk",
      attempted: false,
      success: false,
      error: null
    }
  };

  try {
    const remoteResult = await refreshRemoteUsSnapshot(config, { onProgress });
    if (remoteResult.attempted) {
      Object.assign(runs.US, remoteResult);
      if (!remoteResult.success) {
        onProgress("GitHub 미국 스냅샷 갱신 실패 · 마지막 정상 데이터 보존");
      }
    }

    if (!config.dartApiKey) {
      runs.KR.error = "DART_API_KEY가 설정되지 않았습니다.";
      onProgress("DART 키가 없어 한국 전체시장 갱신을 건너뜁니다.");
    } else {
      try {
        onProgress("Open DART KOSPI·KOSDAQ 전체시장 갱신 시작");
        const result = await syncDartMarket(config, { onProgress });
        runs.KR.success = true;
        runs.KR.companyCount = result.companies.length;
        runs.KR.requestCount = result.meta.requestCount;
      } catch (error) {
        runs.KR.error = errorMessage(error);
        onProgress("Open DART 갱신 실패 · 마지막 정상 스냅샷 보존");
      }
    }

    let dataset = await mergeMarketDatasets(config, {
      runs,
      acquireLock: false
    });
    onProgress(
      `전체시장 병합 완료: 한국 ${dataset.meta.coverage.kr}개 · 미국 ${dataset.meta.coverage.us}개`
    );

    let priceError = null;
    try {
      const priceResult = await syncStockPrices(config, {
        acquireLock: false,
        onProgress
      });
      dataset = priceResult.dataset;
    } catch (error) {
      priceError = errorMessage(error);
      onProgress("일일 시세 보강 실패 · 마지막 정상 시세 보존");
    }

    const failedRegions = [
      !runs.KR.success ? `한국: ${runs.KR.error || "갱신 실패"}` : null,
      runs.US.attempted && !runs.US.success
        ? `미국: ${runs.US.error || "원격 스냅샷 갱신 실패"}`
        : null,
      priceError ? `시세: ${priceError}` : null
    ].filter(Boolean);
    if (failedRegions.length > 0) {
      const error = new Error(failedRegions.join(" · "));
      error.dataset = dataset;
      throw error;
    }
    return dataset;
  } finally {
    await releaseLock();
  }
}
