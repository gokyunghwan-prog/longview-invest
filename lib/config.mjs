import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));

export function loadLocalEnv(file = path.join(ROOT_DIR, ".env")) {
  if (!existsSync(file)) return;

  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

export function getRuntimeConfig() {
  loadLocalEnv();

  return {
    rootDir: ROOT_DIR,
    dataFile: path.join(ROOT_DIR, "data", "companies.json"),
    krMarketDataDir: path.join(ROOT_DIR, "data", "dart-market"),
    krMarketDataFile: path.join(ROOT_DIR, "data", "dart-market", "companies.json"),
    usMarketDataFile: path.join(ROOT_DIR, "data", "us-companies.json"),
    remoteMarketDataFile: path.join(ROOT_DIR, "data", "remote-market-data.json"),
    syncDiagnosticsFile: path.join(ROOT_DIR, "data", "sync-diagnostics.json"),
    priceSyncDiagnosticsFile: path.join(ROOT_DIR, "data", "price-sync-diagnostics.json"),
    universeFile: path.join(ROOT_DIR, "config", "universe.json"),
    publicDir: path.join(ROOT_DIR, "public"),
    dartApiKey: process.env.DART_API_KEY?.trim() || "",
    secUserAgent: process.env.SEC_USER_AGENT?.trim() || "",
    dataGoKrApiKey: process.env.DATA_GO_KR_API_KEY?.trim() || "",
    usLicensedPriceSnapshotUrl:
      process.env.US_LICENSED_PRICE_SNAPSHOT_URL?.trim() || "",
    usLicensedPriceSnapshotToken:
      process.env.US_LICENSED_PRICE_SNAPSHOT_TOKEN?.trim() || "",
    usLicensedPriceAllowedHosts: (process.env.US_LICENSED_PRICE_ALLOWED_HOSTS || "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
    remoteSnapshotUrl: process.env.REMOTE_SNAPSHOT_URL?.trim() || "",
    remoteSnapshotToken: process.env.REMOTE_SNAPSHOT_TOKEN?.trim() || "",
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: Number.parseInt(process.env.PORT || "4173", 10),
    schedulerEnabled: process.env.ENABLE_SCHEDULER === "true",
    scheduleHourKst: Number.parseInt(process.env.SCHEDULE_HOUR_KST || "21", 10),
    syncToken: process.env.SYNC_TOKEN?.trim() || ""
  };
}

export function readUniverse(config = getRuntimeConfig()) {
  const parsed = JSON.parse(readFileSync(config.universeFile, "utf8"));
  return parsed.companies.filter((company) => company.enabled !== false);
}
