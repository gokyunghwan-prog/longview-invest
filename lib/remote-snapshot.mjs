import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertValidSnapshot } from "./snapshot-validator.mjs";

const ALLOWED_HOSTS = new Set(["raw.githubusercontent.com"]);
const MAX_SNAPSHOT_BYTES = 120 * 1024 * 1024;

function safeMessage(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      message = message.split(secret).join("[redacted]");
    }
  }
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[redacted]")
    .replace(/([?&](?:access_?token|api_?key|key|token)=)[^&#\s]+/gi, "$1[redacted]")
    .slice(0, 1_000);
}

function validateRemoteUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error("REMOTE_SNAPSHOT_URL은 raw.githubusercontent.com의 HTTPS 주소여야 합니다.");
  }
  return url;
}

function temporaryName(file) {
  return file + ".tmp-" + process.pid + "-" + randomUUID();
}

async function writeTextAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = temporaryName(file);
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeJsonAtomic(file, payload) {
  await writeTextAtomic(file, JSON.stringify(payload) + "\n");
}

async function readJsonOptional(file) {
  if (!file) return null;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function updatedAtTime(snapshot) {
  const value = Date.parse(snapshot?.meta?.updatedAt || "");
  return Number.isFinite(value) ? value : null;
}

function fullSnapshotValidatorOptions(snapshotBytes, previousSnapshot, validatorOptions = {}) {
  const requestedLimit = validatorOptions.maxSnapshotBytes;
  const validationLimit =
    Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_SNAPSHOT_BYTES)
      : MAX_SNAPSHOT_BYTES;
  return {
    ...validatorOptions,
    label: validatorOptions.label || "full KR+US snapshot",
    requiredCountries: ["KR", "US"],
    requireCoverage: true,
    previousSnapshot,
    snapshotBytes,
    maxSnapshotBytes: validationLimit
  };
}

async function readSnapshotFileOptional(file, validatorOptions = {}) {
  if (!file) return null;
  try {
    const [text, details] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    const snapshot = JSON.parse(text);
    assertValidSnapshot(
      snapshot,
      fullSnapshotValidatorOptions(Buffer.byteLength(text, "utf8"), null, validatorOptions)
    );
    return { text, snapshot, mtimeMs: details.mtimeMs, hash: sha256(text) };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    if (error?.name === "SnapshotValidationError") return null;
    throw error;
  }
}

function runtimeMetadataFile(config) {
  return config.runtimeDataMetaFile || config.runtimeDataFile + ".meta.json";
}

async function readRuntimeEtag(config, runtime) {
  if (!runtime) return null;
  let metadata;
  try {
    metadata = await readJsonOptional(runtimeMetadataFile(config));
  } catch {
    return null;
  }
  if (
    !metadata ||
    typeof metadata.etag !== "string" ||
    !metadata.etag ||
    metadata.sha256 !== runtime.hash
  ) return null;
  return metadata.etag;
}

async function writeRuntimeMetadataBestEffort(config, { etag, text, snapshot }) {
  try {
    await writeJsonAtomic(runtimeMetadataFile(config), {
      schemaVersion: 1,
      etag: etag || null,
      sha256: sha256(text),
      updatedAt: snapshot?.meta?.updatedAt || null
    });
  } catch {
    // The sidecar only improves conditional requests after a restart. The
    // validated runtime snapshot remains authoritative when this optional
    // metadata cannot be persisted.
  }
}

async function readResponseTextLimited(response) {
  const declaredSize = Number.parseInt(response.headers.get("content-length") || "0", 10);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_SNAPSHOT_BYTES) {
    throw new Error("GitHub 스냅샷 크기 제한을 넘었습니다.");
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new Error("GitHub 스냅샷 크기 제한을 넘었습니다.");
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > MAX_SNAPSHOT_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("GitHub 스냅샷 크기 제한을 넘었습니다.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/**
 * Select a validated runtime snapshot without ever writing the tracked data
 * file. A newer/equal cache is retained; all other cases receive an atomic,
 * byte-for-byte copy of the tracked snapshot.
 */
export async function prepareRuntimeSnapshot(
  config,
  { validatorOptions = {} } = {}
) {
  if (!config?.dataFile || !config?.runtimeDataFile) {
    throw new Error("dataFile과 runtimeDataFile 설정이 필요합니다.");
  }
  if (path.resolve(config.dataFile) === path.resolve(config.runtimeDataFile)) {
    throw new Error("runtimeDataFile은 추적 데이터 파일과 달라야 합니다.");
  }

  const tracked = await readSnapshotFileOptional(config.dataFile, validatorOptions);
  if (!tracked) throw new Error("추적된 전체시장 스냅샷이 없거나 올바르지 않습니다.");

  let cached = await readSnapshotFileOptional(config.runtimeDataFile, validatorOptions);
  if (cached) {
    try {
      assertValidSnapshot(
        cached.snapshot,
        fullSnapshotValidatorOptions(
          Buffer.byteLength(cached.text, "utf8"),
          tracked.snapshot,
          validatorOptions
        )
      );
    } catch {
      cached = null;
    }
  }
  const trackedTime = updatedAtTime(tracked.snapshot) ?? tracked.mtimeMs;
  const cachedTime = cached
    ? updatedAtTime(cached.snapshot) ?? cached.mtimeMs
    : Number.NEGATIVE_INFINITY;

  if (cached && cachedTime >= trackedTime) {
    return {
      dataFile: config.runtimeDataFile,
      source: "cache",
      etag: await readRuntimeEtag(config, cached)
    };
  }

  await writeTextAtomic(config.runtimeDataFile, tracked.text);
  return { dataFile: config.runtimeDataFile, source: "local", etag: null };
}

/**
 * Refresh the full KR+US runtime cache from the published GitHub snapshot.
 * The tracked data file is intentionally read-only throughout this flow.
 */
export async function refreshRemoteFullSnapshot(
  config,
  {
    fetchImpl = fetch,
    timeoutMs = 120_000,
    onProgress = () => {},
    validatorOptions = {},
    etag: suppliedEtag = null,
    previousEtag = null
  } = {}
) {
  let status = null;
  let current = null;
  let currentEtag = suppliedEtag || previousEtag || null;

  try {
    current = await readSnapshotFileOptional(config.runtimeDataFile, validatorOptions);
    if (!currentEtag) currentEtag = await readRuntimeEtag(config, current);
  } catch (error) {
    return {
      attempted: false,
      success: false,
      changed: false,
      etag: currentEtag,
      status,
      companyCount: 0,
      updatedAt: null,
      error: safeMessage(error, [config?.remoteSnapshotToken])
    };
  }

  const currentSummary = {
    companyCount: current?.snapshot?.companies?.length || 0,
    updatedAt: current?.snapshot?.meta?.updatedAt || null
  };
  if (!config.remoteSnapshotUrl) {
    return {
      attempted: false,
      success: false,
      changed: false,
      etag: currentEtag,
      status,
      ...currentSummary
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  onProgress("GitHub 최신 전체시장 스냅샷 확인");

  try {
    const url = validateRemoteUrl(config.remoteSnapshotUrl);
    const headers = {
      Accept: "application/json",
      "User-Agent": "Longview-Snapshot-Sync"
    };
    if (config.remoteSnapshotToken) {
      headers.Authorization = "Bearer " + config.remoteSnapshotToken;
    }
    if (currentEtag) headers["If-None-Match"] = currentEtag;

    const response = await fetchImpl(url, {
      headers,
      signal: controller.signal,
      redirect: "error"
    });
    status = response.status;
    if (response.url) validateRemoteUrl(response.url);

    const responseEtag = response.headers.get("etag") || null;
    if (status === 304) {
      if (!current) throw new Error("304 응답을 사용할 정상 런타임 캐시가 없습니다.");
      return {
        attempted: true,
        success: true,
        changed: false,
        notModified: true,
        etag: responseEtag || currentEtag,
        status,
        ...currentSummary
      };
    }
    if (!response.ok) {
      throw new Error("GitHub 스냅샷 응답 실패(HTTP " + status + ")");
    }

    const text = await readResponseTextLimited(response);
    const snapshotBytes = Buffer.byteLength(text, "utf8");
    const remote = JSON.parse(text);
    assertValidSnapshot(
      remote,
      fullSnapshotValidatorOptions(
        snapshotBytes,
        current?.snapshot || null,
        validatorOptions
      )
    );

    const remoteTime = updatedAtTime(remote);
    const currentTime = updatedAtTime(current?.snapshot);
    if (currentTime !== null && remoteTime === null) {
      throw new Error("원격 스냅샷의 updatedAt이 없거나 올바르지 않습니다.");
    }
    if (currentTime !== null && remoteTime < currentTime) {
      throw new Error("원격 스냅샷이 현재 런타임 캐시보다 오래되었습니다.");
    }

    const nextEtag = responseEtag;
    if (current?.hash === sha256(text)) {
      await writeRuntimeMetadataBestEffort(config, { etag: nextEtag, text, snapshot: remote });
      return {
        attempted: true,
        success: true,
        changed: false,
        etag: nextEtag,
        status,
        companyCount: remote.companies.length,
        updatedAt: remote.meta?.updatedAt || null
      };
    }

    await writeTextAtomic(config.runtimeDataFile, text);
    await writeRuntimeMetadataBestEffort(config, { etag: nextEtag, text, snapshot: remote });
    onProgress("GitHub 전체시장 스냅샷 반영: " + remote.companies.length + "개사");
    return {
      attempted: true,
      success: true,
      changed: true,
      etag: nextEtag,
      status,
      companyCount: remote.companies.length,
      updatedAt: remote.meta?.updatedAt || null
    };
  } catch (error) {
    return {
      attempted: true,
      success: false,
      changed: false,
      etag: currentEtag,
      status,
      ...currentSummary,
      error: safeMessage(error, [config?.remoteSnapshotToken])
    };
  } finally {
    clearTimeout(timer);
  }
}

function remoteMarketDataFile(config) {
  return (
    config.remoteMarketDataFile ||
    path.join(path.dirname(config.usMarketDataFile), "remote-market-data.json")
  );
}

function publicMarketDataSnapshot(remote, { fetchedAt, remoteRevision, sourceUrl }) {
  const companies = remote.companies
    .filter(
      (company) =>
        ["KR", "US"].includes(company?.country) &&
        company?.marketData?.usageMode === "public"
    )
    .map((company) => ({
      id: company.id,
      country: company.country,
      ticker: company.ticker || null,
      exchange: company.exchange || null,
      marketData: company.marketData
    }));
  const kr = companies.filter((company) => company.country === "KR").length;
  const us = companies.filter((company) => company.country === "US").length;

  return {
    meta: {
      schemaVersion: 1,
      fetchedAt,
      remoteRevision,
      sourceUrl,
      sourceUpdatedAt:
        remote.meta?.sourceUpdatedAt || remote.meta?.updatedAt || null,
      remoteSchemaVersion: remote.meta?.schemaVersion || null,
      marketData: remote.meta?.marketData || null,
      sources: Array.isArray(remote.meta?.sources) ? remote.meta.sources : [],
      coverage: { total: companies.length, kr, us }
    },
    companies
  };
}

function regionalUsMarketDataMeta(remoteMeta, companies) {
  const quotes = companies
    .map((company) => company.marketData)
    .filter((marketData) => marketData?.usageMode === "public");
  const count = (predicate) => quotes.filter(predicate).length;
  return {
    ...(remoteMeta || {}),
    coverage: {
      kr: 0,
      us: count(
        (quote) => quote.status === "ok" && quote.freshness === "current"
      )
    },
    available: { kr: 0, us: quotes.length },
    preserved: { kr: 0, us: count((quote) => quote.status === "preserved") },
    stale: {
      kr: 0,
      us: count((quote) => quote.status === "stale" || quote.freshness === "stale")
    }
  };
}

export async function refreshRemoteUsSnapshot(
  config,
  {
    fetchImpl = fetch,
    timeoutMs = 120_000,
    onProgress = () => {},
    validatorOptions = {},
    now = new Date()
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
    const fetchedAt = new Date(now).toISOString();
    const previousFullSnapshot = await readJsonOptional(config.dataFile);
    const previousUsSnapshot = await readJsonOptional(config.usMarketDataFile);
    assertValidSnapshot(remote, {
      label: "GitHub public snapshot",
      requiredCountries: ["KR", "US"],
      requireCoverage: true,
      previousSnapshot: previousFullSnapshot,
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
        updatedAt: remote.meta?.updatedAt || fetchedAt,
        sourceUpdatedAt: remote.meta?.sourceUpdatedAt || remote.meta?.updatedAt || null,
        remoteRevision: response.headers.get("etag") || null,
        marketData: regionalUsMarketDataMeta(remote.meta?.marketData, companies),
        sources: Array.isArray(remote.meta?.sources) ? remote.meta.sources : [],
        coverage: { total: companies.length, kr: 0, us: companies.length }
      },
      companies
    };
    assertValidSnapshot(regionalSnapshot, {
      label: "GitHub US regional snapshot",
      requiredCountries: ["US"],
      allowAdditionalCountries: false,
      requireCoverage: true,
      previousSnapshot: previousUsSnapshot,
      ...validatorOptions
    });
    const marketSnapshot = publicMarketDataSnapshot(remote, {
      fetchedAt,
      remoteRevision: response.headers.get("etag") || null,
      sourceUrl: url.href
    });
    await Promise.all([
      writeJsonAtomic(config.usMarketDataFile, regionalSnapshot),
      writeJsonAtomic(remoteMarketDataFile(config), marketSnapshot)
    ]);
    onProgress(
      "GitHub 미국 스냅샷 반영: " + companies.length +
        "개사 · 공개 시세 " + marketSnapshot.companies.length + "개"
    );
    return {
      attempted: true,
      success: true,
      companyCount: companies.length,
      marketDataCount: marketSnapshot.companies.length
    };
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
