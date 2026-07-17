import path from "node:path";

import { getRuntimeConfig } from "../lib/config.mjs";
import { syncDartMarket } from "../lib/providers/dart-market.mjs";

function argument(name) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}

function integerOption(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config = getRuntimeConfig();
const dataDir =
  argument("data-dir") ||
  process.env.DART_MARKET_DATA_DIR?.trim() ||
  path.join(config.rootDir, "data", "dart-market");
const businessYear =
  argument("year") ||
  process.env.DART_MARKET_YEAR?.trim() ||
  undefined;
const reportCode =
  argument("report") || process.env.DART_MARKET_REPORT_CODE?.trim() || "11011";

try {
  const dataset = await syncDartMarket(config, {
    dataDir,
    businessYear,
    reportCode,
    runId: argument("run-id") || undefined,
    minIntervalMs: integerOption(
      argument("interval-ms") || process.env.DART_MARKET_INTERVAL_MS,
      250
    ),
    maxRequests: integerOption(
      argument("max-requests") || process.env.DART_MARKET_MAX_REQUESTS,
      15_000
    ),
    onProgress: (message) => console.log(`[DART] ${message}`)
  });
  console.log(
    `[DART] 완료: KOSPI ${dataset.meta.kospiCount}개, KOSDAQ ${dataset.meta.kosdaqCount}개, API ${dataset.meta.requestCount}회`
  );
} catch (error) {
  const message = String(error instanceof Error ? error.message : error)
    .replace(/crtfc_key=[^&\s]+/gi, "crtfc_key=[REDACTED]")
    .replace(/\b[a-f0-9]{40}\b/gi, "[REDACTED]");
  console.error(`[DART] 중단: ${message}`);
  console.error("[DART] 저장된 체크포인트에서 같은 명령으로 재개할 수 있습니다.");
  process.exitCode = 1;
}
