import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_AWS_ARTIFACT_MAX_SELECTION_BYTES,
  DEFAULT_AWS_ARTIFACT_MAX_SNAPSHOT_BYTES,
  validateAwsArtifactManifest,
  validateAwsArtifactPair
} from "./aws-artifacts.mjs";
import { normalizeKoreanSnapshot } from "./korean-snapshot.mjs";

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function safeMessage(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter(Boolean)) {
    message = message.replaceAll(String(secret), "[REDACTED]");
  }
  return message
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 1_000);
}

function validateManifestUrl(value) {
  const url = new URL(String(value || ""));
  const allowedHost =
    url.hostname === "raw.githubusercontent.com" ||
    url.hostname.endsWith(".cloudfront.net");
  if (
    url.protocol !== "https:" ||
    !allowedHost ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith("/manifest.json")
  ) {
    throw new Error(
      "REMOTE_ARTIFACT_MANIFEST_URL은 GitHub raw 또는 AWS CloudFront의 HTTPS manifest 주소여야 합니다."
    );
  }
  return url;
}

function artifactUrl(manifestUrl, key) {
  const manifestSuffix = "latest/manifest.json";
  if (!manifestUrl.pathname.endsWith(manifestSuffix)) {
    throw new Error("원격 manifest 경로가 올바르지 않습니다.");
  }
  const basePath = manifestUrl.pathname.slice(
    0,
    -manifestSuffix.length
  );
  const url = new URL(`${basePath}${key}`, manifestUrl.origin);
  if (url.origin !== manifestUrl.origin) {
    throw new Error("원격 artifact origin이 manifest와 다릅니다.");
  }
  return url;
}

async function readResponseLimited(response, maximumBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error("원격 artifact가 허용 크기를 초과했습니다.");
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
      throw new Error("원격 artifact가 허용 크기를 초과했습니다.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("원격 artifact가 허용 크기를 초과했습니다.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock?.();
  }
}

async function requestText(
  url,
  { fetchImpl, timeoutMs, maximumBytes, token = "", cacheControl = "no-cache" }
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Cache-Control": cacheControl,
        "User-Agent": "Longview-AWS-Artifact-Sync",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal
    });
    if (response.url && new URL(response.url).origin !== url.origin) {
      throw new Error("원격 artifact가 다른 origin으로 이동했습니다.");
    }
    if (!response.ok) {
      throw new Error(`원격 artifact 응답 실패(HTTP ${response.status})`);
    }
    return await readResponseLimited(response, maximumBytes);
  } finally {
    clearTimeout(timer);
  }
}

async function readPreviousSnapshot(file) {
  try {
    return normalizeKoreanSnapshot(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readOptionalText(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function restorePreviousFile(
  file,
  previousText,
  suffix,
  { renameImpl, rmImpl, writeFileImpl }
) {
  if (previousText === null) {
    await rmImpl(file, { force: true });
    return;
  }
  const temporary = `${file}${suffix}.rollback`;
  try {
    await writeFileImpl(temporary, previousText, {
      encoding: "utf8",
      flag: "wx"
    });
    await renameImpl(temporary, file);
  } finally {
    await rmImpl(temporary, { force: true }).catch(() => {});
  }
}

export async function writePairAtomically(
  {
    companiesFile,
    selectionFile,
    companiesText,
    selectionText
  },
  {
    mkdirImpl = mkdir,
    readFileImpl = readOptionalText,
    renameImpl = rename,
    rmImpl = rm,
    writeFileImpl = writeFile
  } = {}
) {
  await mkdirImpl(path.dirname(companiesFile), { recursive: true });
  await mkdirImpl(path.dirname(selectionFile), { recursive: true });
  const [previousCompanies, previousSelection] = await Promise.all([
    readFileImpl(companiesFile),
    readFileImpl(selectionFile)
  ]);
  const suffix = `.remote-${process.pid}-${randomUUID()}`;
  const temporaryCompanies = `${companiesFile}${suffix}`;
  const temporarySelection = `${selectionFile}${suffix}`;
  let companiesCommitted = false;
  let selectionCommitted = false;
  try {
    await Promise.all([
      writeFileImpl(temporaryCompanies, companiesText, {
        encoding: "utf8",
        flag: "wx"
      }),
      writeFileImpl(temporarySelection, selectionText, {
        encoding: "utf8",
        flag: "wx"
      })
    ]);
    await renameImpl(temporarySelection, selectionFile);
    selectionCommitted = true;
    await renameImpl(temporaryCompanies, companiesFile);
    companiesCommitted = true;
  } catch (error) {
    const rollbackErrors = [];
    if (selectionCommitted && !companiesCommitted) {
      try {
        await restorePreviousFile(selectionFile, previousSelection, suffix, {
          renameImpl,
          rmImpl,
          writeFileImpl
        });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (companiesCommitted && !selectionCommitted) {
      try {
        await restorePreviousFile(companiesFile, previousCompanies, suffix, {
          renameImpl,
          rmImpl,
          writeFileImpl
        });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    await Promise.all([
      rmImpl(temporaryCompanies, { force: true }).catch(() => {}),
      rmImpl(temporarySelection, { force: true }).catch(() => {})
    ]);
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "원격 artifact 교체 실패 뒤 이전 정상본 복구에도 실패했습니다."
      );
    }
    throw error;
  }
}

export async function refreshRemoteArtifactBundle(
  config,
  {
    fetchImpl = fetch,
    timeoutMs = 120_000
  } = {}
) {
  const configuredToken = String(config?.remoteSnapshotToken || "");
  try {
    const manifestUrl = validateManifestUrl(config?.remoteArtifactManifestUrl);
    if (
      configuredToken &&
      manifestUrl.hostname !== "raw.githubusercontent.com"
    ) {
      throw new Error(
        "CloudFront manifest에서는 REMOTE_SNAPSHOT_TOKEN을 제거해야 합니다."
      );
    }
    const token =
      manifestUrl.hostname === "raw.githubusercontent.com"
        ? configuredToken
        : "";
    const manifestText = await requestText(manifestUrl, {
      fetchImpl,
      timeoutMs: Math.min(timeoutMs, 30_000),
      maximumBytes: MAX_MANIFEST_BYTES,
      token
    });
    const manifest = validateAwsArtifactManifest(JSON.parse(manifestText));
    const [companiesText, selectionText, previousSnapshot] = await Promise.all([
      requestText(artifactUrl(manifestUrl, manifest.artifacts.companies.key), {
        fetchImpl,
        timeoutMs,
        maximumBytes: DEFAULT_AWS_ARTIFACT_MAX_SNAPSHOT_BYTES,
        token,
        cacheControl: "public, max-age=31536000, immutable"
      }),
      requestText(artifactUrl(manifestUrl, manifest.artifacts.selection.key), {
        fetchImpl,
        timeoutMs: Math.min(timeoutMs, 30_000),
        maximumBytes: DEFAULT_AWS_ARTIFACT_MAX_SELECTION_BYTES,
        token,
        cacheControl: "public, max-age=31536000, immutable"
      }),
      readPreviousSnapshot(config.runtimeDataFile)
    ]);
    if (
      Buffer.byteLength(companiesText, "utf8") !== manifest.artifacts.companies.bytes ||
      Buffer.byteLength(selectionText, "utf8") !== manifest.artifacts.selection.bytes ||
      createHash("sha256").update(companiesText).digest("hex") !==
        manifest.artifacts.companies.sha256 ||
      createHash("sha256").update(selectionText).digest("hex") !==
        manifest.artifacts.selection.sha256
    ) {
      throw new Error("원격 artifact checksum 또는 크기가 manifest와 다릅니다.");
    }
    const validated = validateAwsArtifactPair({
      companiesText,
      selectionText,
      manifest,
      previousSnapshot
    });
    const currentRevision = previousSnapshot
      ? createHash("sha256")
          .update(JSON.stringify(previousSnapshot))
          .digest("hex")
          .slice(0, 20)
      : null;
    const changed = currentRevision !== manifest.revision;
    await writePairAtomically({
      companiesFile: config.runtimeDataFile,
      selectionFile: config.runtimeInvestmentSelectionFile,
      companiesText,
      selectionText
    });
    return {
      attempted: true,
      success: true,
      changed,
      source: "aws_manifest",
      revision: validated.revision,
      companyCount: validated.snapshot.companies.length,
      updatedAt: validated.snapshot.meta?.updatedAt || null,
      selectionGeneratedAt: validated.selection.generatedAt
    };
  } catch (error) {
    return {
      attempted: true,
      success: false,
      changed: false,
      error: safeMessage(error, [configuredToken])
    };
  }
}
