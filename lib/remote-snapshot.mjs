import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertValidSnapshot } from "./snapshot-validator.mjs";

const ALLOWED_HOSTS = new Set(["raw.githubusercontent.com"]);
const MAX_SNAPSHOT_BYTES = 120 * 1024 * 1024;

function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 1_000);
}

function validateRemoteUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error("REMOTE_SNAPSHOT_URL은 raw.githubusercontent.com의 HTTPS 주소여야 합니다.");
  }
  return url;
}

async function writeJsonAtomic(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp-remote";
  await writeFile(temporary, JSON.stringify(payload) + "\n", "utf8");
  await rename(temporary, file);
}

async function readJsonOptional(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function refreshRemoteUsSnapshot(
  config,
  {
    fetchImpl = fetch,
    timeoutMs = 120_000,
    onProgress = () => {},
    validatorOptions = {}
  } = {}
) {
  if (!config.remoteSnapshotUrl) {
    return { attempted: false, success: false, companyCount: 0 };
  }

  const url = validateRemoteUrl(config.remoteSnapshotUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  onProgress("GitHub 최신 전체시장 스냅샷 확인");

  try {
    const headers = { Accept: "application/json", "User-Agent": "Longview-Snapshot-Sync" };
    if (config.remoteSnapshotToken) headers.Authorization = "Bearer " + config.remoteSnapshotToken;
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error("GitHub 스냅샷 응답 실패(HTTP " + response.status + ")");
    const declaredSize = Number.parseInt(response.headers.get("content-length") || "0", 10);
    if (declaredSize > MAX_SNAPSHOT_BYTES) throw new Error("GitHub 스냅샷 크기 제한을 넘었습니다.");
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new Error("GitHub 스냅샷 크기 제한을 넘었습니다.");
    }
    const remote = JSON.parse(text);
    const previousSnapshot = await readJsonOptional(config.usMarketDataFile);
    assertValidSnapshot(remote, {
      label: "GitHub public snapshot",
      requiredCountries: ["US"],
      requireCoverage: true,
      previousSnapshot,
      snapshotBytes: Buffer.byteLength(text, "utf8"),
      ...validatorOptions
    });
    if (!Array.isArray(remote.companies)) throw new Error("GitHub 스냅샷 형식이 올바르지 않습니다.");
    const companies = remote.companies.filter((company) => company.country === "US");
    if (companies.length === 0) throw new Error("GitHub 스냅샷에 미국 회사가 없습니다.");

    const regionalSnapshot = {
      meta: {
        schemaVersion: remote.meta?.schemaVersion || 2,
        provider: "GitHub Actions · SEC EDGAR bulk",
        dataMode: remote.meta?.dataMode || "mixed",
        updatedAt: remote.meta?.updatedAt || new Date().toISOString(),
        remoteRevision: response.headers.get("etag") || null,
        coverage: { total: companies.length, kr: 0, us: companies.length }
      },
      companies
    };
    assertValidSnapshot(regionalSnapshot, {
      label: "GitHub US regional snapshot",
      requiredCountries: ["US"],
      allowAdditionalCountries: false,
      requireCoverage: true,
      previousSnapshot,
      ...validatorOptions
    });
    await writeJsonAtomic(config.usMarketDataFile, regionalSnapshot);
    onProgress("GitHub 미국 스냅샷 반영: " + companies.length + "개사");
    return { attempted: true, success: true, companyCount: companies.length };
  } catch (error) {
    return {
      attempted: true,
      success: false,
      companyCount: 0,
      error: safeMessage(error)
    };
  } finally {
    clearTimeout(timer);
  }
}
