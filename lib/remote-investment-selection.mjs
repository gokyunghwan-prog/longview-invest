import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { validatePublicInvestmentSelection } from "./investment-selection.mjs";

const ALLOWED_HOST = "raw.githubusercontent.com";
const MAX_SELECTION_BYTES = 5 * 1024 * 1024;

function safeMessage(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      message = message.split(secret).join("[redacted]");
    }
  }
  return message
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 1_000);
}

function validateUrl(value) {
  const url = new URL(String(value || ""));
  if (
    url.protocol !== "https:" ||
    url.hostname !== ALLOWED_HOST ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "REMOTE_INVESTMENT_SELECTION_URL은 raw.githubusercontent.com의 HTTPS 주소여야 합니다."
    );
  }
  return url;
}

async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function normalize(text) {
  if (Buffer.byteLength(text, "utf8") > MAX_SELECTION_BYTES) {
    throw new Error("원격 투자선정 파일이 허용 크기를 초과했습니다.");
  }
  const artifact = validatePublicInvestmentSelection(JSON.parse(text));
  return { artifact, text: JSON.stringify(artifact) + "\n" };
}

async function readOptional(file) {
  try {
    return normalize(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function readResponseLimited(response) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_SELECTION_BYTES) {
    throw new Error("원격 투자선정 파일이 허용 크기를 초과했습니다.");
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_SELECTION_BYTES) {
      throw new Error("원격 투자선정 파일이 허용 크기를 초과했습니다.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > MAX_SELECTION_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("원격 투자선정 파일이 허용 크기를 초과했습니다.");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    reader.releaseLock?.();
  }
}

export function deriveRemoteInvestmentSelectionUrl(snapshotUrl) {
  if (!snapshotUrl) return "";
  const url = validateUrl(snapshotUrl);
  if (!url.pathname.endsWith("/companies.json")) {
    throw new Error("REMOTE_SNAPSHOT_URL은 data/companies.json으로 끝나야 합니다.");
  }
  url.pathname = url.pathname.slice(0, -"companies.json".length) +
    "trading-selection.json";
  return url.toString();
}

export async function prepareRuntimeInvestmentSelection(config) {
  const trackedFile = config?.investmentSelectionFile;
  const runtimeFile = config?.runtimeInvestmentSelectionFile;
  if (!trackedFile || !runtimeFile || path.resolve(trackedFile) === path.resolve(runtimeFile)) {
    throw new Error("투자선정 추적 파일과 runtime 파일 설정이 필요합니다.");
  }
  const tracked = await readOptional(trackedFile);
  if (!tracked) throw new Error("추적 투자선정 파일이 없거나 올바르지 않습니다.");
  const runtime = await readOptional(runtimeFile);
  const trackedTime = Date.parse(tracked.artifact.generatedAt);
  const runtimeTime = Date.parse(runtime?.artifact?.generatedAt || "");
  if (runtime && Number.isFinite(runtimeTime) && runtimeTime >= trackedTime) {
    return { file: runtimeFile, source: "cache", artifact: runtime.artifact };
  }
  await writeAtomic(runtimeFile, tracked.text);
  return { file: runtimeFile, source: "local", artifact: tracked.artifact };
}

export async function refreshRemoteInvestmentSelection(
  config,
  {
    fetchImpl = fetch,
    timeoutMs = 30_000,
    expectedRevision = null
  } = {}
) {
  const url = validateUrl(config?.remoteInvestmentSelectionUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Accept: "application/json",
      "User-Agent": "Longview-Investment-Selection-Sync"
    };
    if (config.remoteSnapshotToken) {
      headers.Authorization = "Bearer " + config.remoteSnapshotToken;
    }
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "error"
    });
    if (response.url) validateUrl(response.url);
    if (!response.ok) {
      throw new Error(`GitHub 투자선정 응답 실패(HTTP ${response.status})`);
    }
    const normalized = normalize(await readResponseLimited(response));
    if (
      expectedRevision &&
      normalized.artifact.sourceRevision !== expectedRevision
    ) {
      throw new Error("원격 투자선정 파일과 회사 스냅샷 revision이 일치하지 않습니다.");
    }
    await writeAtomic(config.runtimeInvestmentSelectionFile, normalized.text);
    return {
      attempted: true,
      success: true,
      file: config.runtimeInvestmentSelectionFile,
      sourceRevision: normalized.artifact.sourceRevision,
      generatedAt: normalized.artifact.generatedAt
    };
  } catch (error) {
    return {
      attempted: true,
      success: false,
      error: safeMessage(error, [config?.remoteSnapshotToken])
    };
  } finally {
    clearTimeout(timer);
  }
}
