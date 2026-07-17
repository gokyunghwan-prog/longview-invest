import { getRuntimeConfig } from "../lib/config.mjs";
import { mergeMarketDatasets } from "../lib/market-dataset.mjs";
import { syncDartMarket } from "../lib/providers/dart-market.mjs";
import { syncUsBulk } from "./sync-us-bulk.mjs";

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
  },
  US: {
    provider: "SEC EDGAR bulk",
    attempted: Boolean(config.secUserAgent),
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

if (runs.US.attempted) {
  try {
    const result = await syncUsBulk({
      output: config.usMarketDataFile,
      onProgress: (message) => console.log("[SEC] " + message)
    });
    runs.US.success = true;
    runs.US.companyCount = result.companies.length;
  } catch (error) {
    runs.US.error = safeMessage(error);
    console.error("[SEC] 실패: " + runs.US.error);
  }
} else {
  runs.US.error = "SEC_USER_AGENT가 설정되지 않았습니다.";
}

try {
  const dataset = await mergeMarketDatasets(config, { runs });
  console.log(
    `[MERGE] 한국 ${dataset.meta.coverage.kr}개 · 미국 ${dataset.meta.coverage.us}개 · ${dataset.meta.sync.status}`
  );
} catch (error) {
  console.error("[MERGE] " + safeMessage(error));
  process.exitCode = 1;
}

if (!runs.KR.success || !runs.US.success) process.exitCode = 1;
