import { getRuntimeConfig } from "../lib/config.mjs";
import { mergeMarketDatasets } from "../lib/market-dataset.mjs";
import { syncDartMarket } from "../lib/providers/dart-market.mjs";
import { syncStockPrices } from "./sync-stock-prices.mjs";

function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/crtfc_key=[^&\s]+/gi, "crtfc_key=[REDACTED]")
    .replace(/\b[a-f0-9]{40}\b/gi, "[REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
}

const config = getRuntimeConfig();
const runs = {
  KR: {
    provider: "Open DART",
    attempted: Boolean(config.dartApiKey),
    success: false,
    error: null
  }
};

if (runs.KR.attempted) {
  try {
    const result = await syncDartMarket(config, {
      dataDir: config.krMarketDataDir,
      onProgress: (message) => console.log("[DART] " + message)
    });
    runs.KR.success = true;
    runs.KR.companyCount = result.companies.length;
  } catch (error) {
    runs.KR.error = safeMessage(error);
    console.error("[DART] 실패: " + runs.KR.error);
  }
} else {
  runs.KR.error = "DART_API_KEY가 설정되지 않았습니다.";
}

let mergeSucceeded = false;
try {
  const dataset = await mergeMarketDatasets(config, { runs });
  mergeSucceeded = true;
  console.log(`[MERGE] 한국 ${dataset.meta.coverage.kr}개 · ${dataset.meta.sync.status}`);
} catch (error) {
  console.error("[MERGE] " + safeMessage(error));
  process.exitCode = 1;
}

if (mergeSucceeded) {
  try {
    const priceResult = await syncStockPrices(config, {
      failOnConfiguredProviderError:
        process.env.ALLOW_PRICE_PROVIDER_FAILURE !== "true",
      onProgress: (message) => console.log("[PRICE] " + message)
    });
    const ok = priceResult.providers.filter((provider) =>
      provider.status === "ok"
    ).length;
    console.log(`[PRICE] 시세 공급자 ${ok}/${priceResult.providers.length}개 갱신`);
    if (priceResult.failures.length > 0) {
      console.error(`[PRICE] 설정된 공급자 ${priceResult.failures.length}개 실패 · 진단 파일 확인`);
    }
  } catch (error) {
    console.error("[PRICE] " + safeMessage(error));
    process.exitCode = 1;
  }
}

if (!runs.KR.success) process.exitCode = 1;
