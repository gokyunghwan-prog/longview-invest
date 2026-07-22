import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeKoreanSnapshot } from "./korean-snapshot.mjs";
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

function koreanSnapshotValidatorOptions(snapshotBytes, previousSnapshot, validatorOptions = {}) {
  const requestedLimit = validatorOptions.maxSnapshotBytes;
  const validationLimit =
    Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_SNAPSHOT_BYTES)
      : MAX_SNAPSHOT_BYTES;
  return {
    ...validatorOptions,
    label: validatorOptions.label || "Korean market snapshot",
    requiredCountries: ["KR"],
    allowAdditionalCountries: false,
    requireCoverage: true,
    previousSnapshot,
    snapshotBytes,
    maxSnapshotBytes: validationLimit
  };
}

function normalizeSnapshotText(text) {
  const snapshot = normalizeKoreanSnapshot(JSON.parse(text));
  const normalizedText = JSON.stringify(snapshot) + "\n";
  return { snapshot, text: normalizedText };
}

async function readSnapshotFileOptional(file, validatorOptions = {}) {
  if (!file) return null;
  try {
    const [sourceText, details] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    const normalized = normalizeSnapshotText(sourceText);
    assertValidSnapshot(
      normalized.snapshot,
      koreanSnapshotValidatorOptions(
        Buffer.byteLength(normalized.text, "utf8"),
        null,
        validatorOptions
      )
    );
    return {
      ...normalized,
      mtimeMs: details.mtimeMs,
      hash: sha256(normalized.text),
      normalizedChanged: sha256(sourceText) !== sha256(normalized.text)
    };
  } catch (error) {
    if (
      error?.code === "ENOENT" ||
      error instanceof SyntaxError ||
      error?.name === "SnapshotValidationError" ||
      /한국 (?:상장기업 데이터|시장 스냅샷)/.test(error?.message || "")
    ) {
      return null;
    }
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
    // The validated runtime snapshot remains authoritative when this optional
    // conditional-request metadata cannot be persisted.
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
 * 추적 파일과 런타임 캐시를 읽는 즉시 한국 기업만 정규화한다.
 * 추적 파일은 수정하지 않고 런타임 캐시에만 정규화 결과를 원자적으로 쓴다.
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
  if (!tracked) throw new Error("추적된 한국 시장 스냅샷이 없거나 올바르지 않습니다.");

  let cached = await readSnapshotFileOptional(config.runtimeDataFile, validatorOptions);
  if (cached) {
    try {
      assertValidSnapshot(
        cached.snapshot,
        koreanSnapshotValidatorOptions(
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
    const etag = await readRuntimeEtag(config, cached);
    if (cached.normalizedChanged) await writeTextAtomic(config.runtimeDataFile, cached.text);
    return { dataFile: config.runtimeDataFile, source: "cache", etag };
  }

  await writeTextAtomic(config.runtimeDataFile, tracked.text);
  return { dataFile: config.runtimeDataFile, source: "local", etag: null };
}

/** 원격 파일이 혼합 시장이어도 한국 기업만 검증해 런타임 캐시에 저장한다. */
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
    if (current?.normalizedChanged) {
      await writeTextAtomic(config.runtimeDataFile, current.text);
    }
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
  onProgress("GitHub 최신 한국 시장 스냅샷 확인");

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

    const sourceText = await readResponseTextLimited(response);
    const remote = normalizeSnapshotText(sourceText);
    const snapshotBytes = Buffer.byteLength(remote.text, "utf8");
    assertValidSnapshot(
      remote.snapshot,
      koreanSnapshotValidatorOptions(
        snapshotBytes,
        current?.snapshot || null,
        validatorOptions
      )
    );

    const remoteTime = updatedAtTime(remote.snapshot);
    const currentTime = updatedAtTime(current?.snapshot);
    if (currentTime !== null && remoteTime === null) {
      throw new Error("원격 스냅샷의 updatedAt이 없거나 올바르지 않습니다.");
    }
    if (currentTime !== null && remoteTime < currentTime) {
      throw new Error("원격 스냅샷이 현재 런타임 캐시보다 오래되었습니다.");
    }

    const nextEtag = responseEtag;
    if (current?.hash === sha256(remote.text)) {
      await writeRuntimeMetadataBestEffort(config, {
        etag: nextEtag,
        text: remote.text,
        snapshot: remote.snapshot
      });
      return {
        attempted: true,
        success: true,
        changed: false,
        etag: nextEtag,
        status,
        companyCount: remote.snapshot.companies.length,
        updatedAt: remote.snapshot.meta?.updatedAt || null
      };
    }

    await writeTextAtomic(config.runtimeDataFile, remote.text);
    await writeRuntimeMetadataBestEffort(config, {
      etag: nextEtag,
      text: remote.text,
      snapshot: remote.snapshot
    });
    onProgress("GitHub 한국 시장 스냅샷 반영: " + remote.snapshot.companies.length + "개사");
    return {
      attempted: true,
      success: true,
      changed: true,
      etag: nextEtag,
      status,
      companyCount: remote.snapshot.companies.length,
      updatedAt: remote.snapshot.meta?.updatedAt || null
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
