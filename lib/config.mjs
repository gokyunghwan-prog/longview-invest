import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { deriveRemoteInvestmentSelectionUrl } from "./remote-investment-selection.mjs";

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

  const remoteSnapshotUrl = process.env.REMOTE_SNAPSHOT_URL?.trim() || "";
  const remoteArtifactManifestUrl =
    process.env.REMOTE_ARTIFACT_MANIFEST_URL?.trim() || "";
  const remoteInvestmentSelectionUrl =
    process.env.REMOTE_INVESTMENT_SELECTION_URL?.trim() ||
    (remoteSnapshotUrl ? deriveRemoteInvestmentSelectionUrl(remoteSnapshotUrl) : "");

  return {
    rootDir: ROOT_DIR,
    dataFile: path.join(ROOT_DIR, "data", "companies.json"),
    runtimeDataFile: path.join(ROOT_DIR, ".cache", "companies.json"),
    investmentSelectionFile: path.join(ROOT_DIR, "data", "trading-selection.json"),
    runtimeInvestmentSelectionFile: path.join(
      ROOT_DIR,
      ".cache",
      "trading-selection.json"
    ),
    krMarketDataDir: path.join(ROOT_DIR, "data", "dart-market"),
    krMarketDataFile: path.join(ROOT_DIR, "data", "dart-market", "companies.json"),
    syncDiagnosticsFile: path.join(ROOT_DIR, "data", "sync-diagnostics.json"),
    priceSyncDiagnosticsFile: path.join(ROOT_DIR, "data", "price-sync-diagnostics.json"),
    publicDir: path.join(ROOT_DIR, "public"),
    dartApiKey: process.env.DART_API_KEY?.trim() || "",
    dataGoKrApiKey: process.env.DATA_GO_KR_API_KEY?.trim() || "",
    remoteSnapshotUrl,
    remoteArtifactManifestUrl,
    remoteInvestmentSelectionUrl,
    remoteSnapshotToken: process.env.REMOTE_SNAPSHOT_TOKEN?.trim() || "",
    remoteSnapshotRefreshMs: 30 * 60 * 1000,
    remoteStartupRefreshRequired:
      process.env.REMOTE_STARTUP_REFRESH_REQUIRED === "true" ||
      Boolean(remoteArtifactManifestUrl),
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: Number.parseInt(process.env.PORT || "4173", 10),
    schedulerEnabled: process.env.ENABLE_SCHEDULER === "true",
    scheduleHourKst: Number.parseInt(process.env.SCHEDULE_HOUR_KST || "21", 10),
    syncToken: process.env.SYNC_TOKEN?.trim() || ""
  };
}
