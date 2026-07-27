import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream
} from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand
} from "@aws-sdk/client-s3";

import { validatePublicInvestmentSelection } from "./investment-selection.mjs";
import { normalizeKoreanSnapshot } from "./korean-snapshot.mjs";
import { assertValidSnapshot } from "./snapshot-validator.mjs";

export const AWS_ARTIFACT_MANIFEST_SCHEMA_VERSION = 1;
export const DEFAULT_AWS_ARTIFACT_MANIFEST_KEY = "latest/manifest.json";
export const DEFAULT_AWS_ARTIFACT_MAX_SNAPSHOT_BYTES = 120 * 1024 * 1024;
export const DEFAULT_AWS_ARTIFACT_MAX_SELECTION_BYTES = 5 * 1024 * 1024;
export const DEFAULT_AWS_CHECKPOINT_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_AWS_CHECKPOINT_MAX_OBJECTS = 100;

export class AwsArtifactError extends Error {
  constructor(message, { code = "AWS_ARTIFACT_ERROR", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AwsArtifactError";
    this.code = code;
  }
}

function requiredText(value, label, maximum = 2_048) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new TypeError(`${label}이(가) 없거나 너무 깁니다.`);
  }
  return normalized;
}

function safeObjectKey(value, label = "S3 object key") {
  const key = requiredText(value, label, 1_024).replaceAll("\\", "/");
  if (
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("\0") ||
    key.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError(`${label}이(가) 안전한 상대경로가 아닙니다.`);
  }
  return key;
}

function safeRelativeFile(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  safeObjectKey(normalized, "체크포인트 상대경로");
  return normalized;
}

function noSuchObject(error) {
  return (
    error?.name === "NoSuchKey" ||
    error?.name === "NotFound" ||
    error?.$metadata?.httpStatusCode === 404
  );
}

function preconditionFailed(error) {
  return (
    error?.name === "PreconditionFailed" ||
    error?.$metadata?.httpStatusCode === 412
  );
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function snapshotRevision(snapshot) {
  return createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex")
    .slice(0, 20);
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

async function writeS3Body(file, body, maximumBytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.download-${process.pid}-${randomUUID()}`;
  let bytes = 0;
  try {
    const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    async function* chunks() {
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        yield Buffer.from(body);
        return;
      }
      if (typeof body === "string") {
        yield Buffer.from(body, "utf8");
        return;
      }
      if (body && typeof body[Symbol.asyncIterator] === "function") {
        for await (const chunk of body) yield Buffer.from(chunk);
        return;
      }
      if (typeof body?.transformToByteArray === "function") {
        yield Buffer.from(await body.transformToByteArray());
        return;
      }
      throw new AwsArtifactError("S3 응답 body 형식을 읽을 수 없습니다.", {
        code: "AWS_ARTIFACT_BODY_INVALID"
      });
    }
    async function* limited() {
      for await (const chunk of chunks()) {
        bytes += chunk.byteLength;
        if (bytes > maximumBytes) {
          throw new AwsArtifactError("S3 object가 허용 크기를 초과했습니다.", {
            code: "AWS_ARTIFACT_TOO_LARGE"
          });
        }
        yield chunk;
      }
    }
    await pipeline(limited(), output);
    await rename(temporary, file);
    return bytes;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function listFiles(root, current = root) {
  const result = [];
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(root, file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}

function validateArtifactDescriptor(value, label, maximumBytes) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !/^[a-f0-9]{64}$/.test(String(value.sha256 || "")) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > maximumBytes
  ) {
    throw new AwsArtifactError(`${label} descriptor가 올바르지 않습니다.`, {
      code: "AWS_ARTIFACT_MANIFEST_INVALID"
    });
  }
  return {
    key: safeObjectKey(value.key, `${label} key`),
    sha256: value.sha256,
    bytes: value.bytes,
    contentType: String(value.contentType || "application/json")
  };
}

export function validateAwsArtifactManifest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== AWS_ARTIFACT_MANIFEST_SCHEMA_VERSION ||
    !/^[a-f0-9]{20}$/.test(String(value.revision || "")) ||
    !Number.isFinite(Date.parse(value.publishedAt || "")) ||
    !value.artifacts ||
    typeof value.artifacts !== "object"
  ) {
    throw new AwsArtifactError("AWS artifact manifest 형식이 올바르지 않습니다.", {
      code: "AWS_ARTIFACT_MANIFEST_INVALID"
    });
  }
  const companies = validateArtifactDescriptor(
    value.artifacts.companies,
    "companies",
    DEFAULT_AWS_ARTIFACT_MAX_SNAPSHOT_BYTES
  );
  const selection = validateArtifactDescriptor(
    value.artifacts.selection,
    "selection",
    DEFAULT_AWS_ARTIFACT_MAX_SELECTION_BYTES
  );
  const expectedBase = `revisions/${value.revision}`;
  const expectedSelectionKey =
    `${expectedBase}/trading-selection-${selection.sha256}.json`;
  if (
    companies.key !== `${expectedBase}/companies.json` ||
    selection.key !== expectedSelectionKey
  ) {
    throw new AwsArtifactError(
      "AWS artifact manifest가 immutable revision 경로를 가리키지 않습니다.",
      { code: "AWS_ARTIFACT_MANIFEST_INVALID" }
    );
  }
  if (
    value.sourceUpdatedAt !== null &&
    value.sourceUpdatedAt !== undefined &&
    !Number.isFinite(Date.parse(value.sourceUpdatedAt))
  ) {
    throw new AwsArtifactError("AWS artifact 원본 갱신시각이 올바르지 않습니다.", {
      code: "AWS_ARTIFACT_MANIFEST_INVALID"
    });
  }
  if (
    value.selectionGeneratedAt !== null &&
    value.selectionGeneratedAt !== undefined &&
    !Number.isFinite(Date.parse(value.selectionGeneratedAt))
  ) {
    throw new AwsArtifactError("AWS artifact 선정 생성시각이 올바르지 않습니다.", {
      code: "AWS_ARTIFACT_MANIFEST_INVALID"
    });
  }
  return {
    schemaVersion: AWS_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    revision: value.revision,
    sourceUpdatedAt:
      typeof value.sourceUpdatedAt === "string" ? value.sourceUpdatedAt : null,
    selectionGeneratedAt:
      typeof value.selectionGeneratedAt === "string"
        ? value.selectionGeneratedAt
        : null,
    publishedAt: value.publishedAt,
    artifacts: { companies, selection }
  };
}

export function validateAwsArtifactPair({
  companiesText,
  selectionText,
  manifest = null,
  previousSnapshot = null
}) {
  let snapshot;
  let selection;
  try {
    snapshot = normalizeKoreanSnapshot(JSON.parse(companiesText));
    selection = validatePublicInvestmentSelection(JSON.parse(selectionText));
  } catch (error) {
    throw new AwsArtifactError("AWS snapshot 또는 selection JSON 검증에 실패했습니다.", {
      code: "AWS_ARTIFACT_CONTENT_INVALID",
      cause: error
    });
  }
  assertValidSnapshot(snapshot, {
    label: "AWS Korean market snapshot",
    requiredCountries: ["KR"],
    allowAdditionalCountries: false,
    requireCoverage: true,
    previousSnapshot,
    snapshotBytes: Buffer.byteLength(companiesText, "utf8"),
    maxSnapshotBytes: DEFAULT_AWS_ARTIFACT_MAX_SNAPSHOT_BYTES
  });
  const revision = snapshotRevision(snapshot);
  if (
    selection.sourceRevision !== revision ||
    (manifest && manifest.revision !== revision)
  ) {
    throw new AwsArtifactError(
      "AWS snapshot과 selection의 source revision이 일치하지 않습니다.",
      { code: "AWS_ARTIFACT_REVISION_MISMATCH" }
    );
  }
  return { snapshot, selection, revision };
}

export class S3ArtifactStore {
  constructor({
    client,
    bucket,
    manifestKey = DEFAULT_AWS_ARTIFACT_MANIFEST_KEY,
    checkpointPrefix = "private/sync-checkpoints/dart/"
  } = {}) {
    if (!client || typeof client.send !== "function") {
      throw new TypeError("S3 client가 필요합니다.");
    }
    this.client = client;
    this.bucket = requiredText(bucket, "S3 bucket", 255);
    this.manifestKey = safeObjectKey(manifestKey, "S3 manifest key");
    this.checkpointPrefix =
      safeObjectKey(checkpointPrefix.replace(/\/$/, "") + "/placeholder")
        .replace(/placeholder$/, "");
  }

  async getObjectToFile(key, file, maximumBytes) {
    const objectKey = safeObjectKey(key);
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey })
      );
    } catch (error) {
      if (noSuchObject(error)) return { exists: false, bytes: 0 };
      throw new AwsArtifactError("S3 object를 내려받지 못했습니다.", {
        code: "AWS_ARTIFACT_DOWNLOAD_FAILED",
        cause: error
      });
    }
    const declared = Number(response?.ContentLength);
    if (Number.isFinite(declared) && declared > maximumBytes) {
      throw new AwsArtifactError("S3 object가 허용 크기를 초과했습니다.", {
        code: "AWS_ARTIFACT_TOO_LARGE"
      });
    }
    const bytes = await writeS3Body(file, response?.Body, maximumBytes);
    return {
      exists: true,
      bytes,
      etag: String(response?.ETag || "").replaceAll('"', "") || null,
      metadata: response?.Metadata || {}
    };
  }

  async getJson(key, maximumBytes = 2 * 1024 * 1024) {
    const temporary = path.join(
      tmpdir(),
      `longview-s3-${process.pid}-${randomUUID()}.json`
    );
    try {
      const downloaded = await this.getObjectToFile(key, temporary, maximumBytes);
      if (!downloaded.exists) return null;
      return JSON.parse(await readFile(temporary, "utf8"));
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async putFile(
    key,
    file,
    {
      immutable = false,
      cacheControl = immutable
        ? "public, max-age=31536000, immutable"
        : "no-cache, max-age=0",
      contentType = "application/json"
    } = {}
  ) {
    const objectKey = safeObjectKey(key);
    const details = await stat(file);
    const checksum = await sha256File(file);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: createReadStream(file),
          ContentLength: details.size,
          ContentType: contentType,
          CacheControl: cacheControl,
          Metadata: { sha256: checksum },
          ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"),
          ...(immutable ? { IfNoneMatch: "*" } : {})
        })
      );
    } catch (error) {
      if (!immutable || !preconditionFailed(error)) {
        throw new AwsArtifactError("S3 object를 게시하지 못했습니다.", {
          code: "AWS_ARTIFACT_UPLOAD_FAILED",
          cause: error
        });
      }
      const existing = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey })
      );
      if (
        Number(existing?.ContentLength) !== details.size ||
        existing?.Metadata?.sha256 !== checksum
      ) {
        throw new AwsArtifactError("같은 S3 immutable key에 다른 내용이 있습니다.", {
          code: "AWS_ARTIFACT_IMMUTABLE_CONFLICT"
        });
      }
    }
    return { key: objectKey, bytes: details.size, sha256: checksum, contentType };
  }

  async putJson(key, value, options = {}) {
    const temporary = path.join(
      tmpdir(),
      `longview-upload-${process.pid}-${randomUUID()}.json`
    );
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      return await this.putFile(key, temporary, options);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async loadManifest() {
    const raw = await this.getJson(this.manifestKey);
    return raw ? validateAwsArtifactManifest(raw) : null;
  }

  async materializeLatest({
    companiesFile,
    selectionFile,
    previousSnapshot = null
  }) {
    const manifest = await this.loadManifest();
    if (!manifest) return { exists: false, manifest: null };
    const directory = path.join(
      path.dirname(companiesFile),
      `.aws-bundle-${process.pid}-${randomUUID()}`
    );
    const temporaryCompanies = path.join(directory, "companies.json");
    const temporarySelection = path.join(directory, "trading-selection.json");
    await mkdir(directory, { recursive: true });
    try {
      const companies = await this.getObjectToFile(
        manifest.artifacts.companies.key,
        temporaryCompanies,
        DEFAULT_AWS_ARTIFACT_MAX_SNAPSHOT_BYTES
      );
      const selection = await this.getObjectToFile(
        manifest.artifacts.selection.key,
        temporarySelection,
        DEFAULT_AWS_ARTIFACT_MAX_SELECTION_BYTES
      );
      if (!companies.exists || !selection.exists) {
        throw new AwsArtifactError("AWS manifest가 가리키는 artifact가 없습니다.", {
          code: "AWS_ARTIFACT_MISSING"
        });
      }
      const [companiesHash, selectionHash, companiesText, selectionText] =
        await Promise.all([
          sha256File(temporaryCompanies),
          sha256File(temporarySelection),
          readFile(temporaryCompanies, "utf8"),
          readFile(temporarySelection, "utf8")
        ]);
      if (
        companiesHash !== manifest.artifacts.companies.sha256 ||
        selectionHash !== manifest.artifacts.selection.sha256 ||
        companies.bytes !== manifest.artifacts.companies.bytes ||
        selection.bytes !== manifest.artifacts.selection.bytes
      ) {
        throw new AwsArtifactError("AWS artifact checksum 또는 크기가 일치하지 않습니다.", {
          code: "AWS_ARTIFACT_CHECKSUM_MISMATCH"
        });
      }
      const validated = validateAwsArtifactPair({
        companiesText,
        selectionText,
        manifest,
        previousSnapshot
      });
      await mkdir(path.dirname(companiesFile), { recursive: true });
      await mkdir(path.dirname(selectionFile), { recursive: true });
      await copyFile(temporaryCompanies, `${companiesFile}.next`);
      await copyFile(temporarySelection, `${selectionFile}.next`);
      await rename(`${companiesFile}.next`, companiesFile);
      await rename(`${selectionFile}.next`, selectionFile);
      return { exists: true, manifest, ...validated };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      await rm(`${companiesFile}.next`, { force: true }).catch(() => {});
      await rm(`${selectionFile}.next`, { force: true }).catch(() => {});
    }
  }

  async publish({
    companiesFile,
    selectionFile,
    previousSnapshot = null,
    now = new Date()
  }) {
    const [sourceCompaniesText, sourceSelectionText] = await Promise.all([
      readFile(companiesFile, "utf8"),
      readFile(selectionFile, "utf8")
    ]);
    const preliminary = validateAwsArtifactPair({
      companiesText: sourceCompaniesText,
      selectionText: sourceSelectionText,
      previousSnapshot
    });
    const canonicalCompaniesText = `${JSON.stringify(preliminary.snapshot)}\n`;
    const canonicalSelectionText = `${JSON.stringify(preliminary.selection, null, 2)}\n`;
    const validated = validateAwsArtifactPair({
      companiesText: canonicalCompaniesText,
      selectionText: canonicalSelectionText,
      previousSnapshot
    });
    const publishedAt = now instanceof Date ? new Date(now) : new Date(now);
    if (Number.isNaN(publishedAt.getTime())) {
      throw new TypeError("AWS artifact 게시시각이 올바르지 않습니다.");
    }
    const directory = path.join(
      path.dirname(companiesFile),
      `.aws-publish-${process.pid}-${randomUUID()}`
    );
    const canonicalCompaniesFile = path.join(directory, "companies.json");
    const canonicalSelectionFile = path.join(directory, "trading-selection.json");
    await mkdir(directory, { recursive: true });
    try {
      await Promise.all([
        writeFile(canonicalCompaniesFile, canonicalCompaniesText, "utf8"),
        writeFile(canonicalSelectionFile, canonicalSelectionText, "utf8")
      ]);
      const base = `revisions/${validated.revision}`;
      const companies = await this.putFile(
        `${base}/companies.json`,
        canonicalCompaniesFile,
        { immutable: true }
      );
      const selectionChecksum = await sha256File(canonicalSelectionFile);
      const selection = await this.putFile(
        `${base}/trading-selection-${selectionChecksum}.json`,
        canonicalSelectionFile,
        { immutable: true }
      );
      const manifest = validateAwsArtifactManifest({
        schemaVersion: AWS_ARTIFACT_MANIFEST_SCHEMA_VERSION,
        revision: validated.revision,
        sourceUpdatedAt: validated.snapshot.meta?.updatedAt || null,
        selectionGeneratedAt: validated.selection.generatedAt,
        publishedAt: publishedAt.toISOString(),
        artifacts: { companies, selection }
      });

      // Backward-compatible aliases are written before the manifest. New
      // readers follow the immutable keys in latest/manifest.json, so they
      // can never combine files from two revisions.
      await this.putFile("latest/companies.json", canonicalCompaniesFile);
      await this.putFile("latest/trading-selection.json", canonicalSelectionFile);
      await this.putJson(this.manifestKey, manifest, {
        immutable: false,
        cacheControl: "no-cache, max-age=0, must-revalidate"
      });
      return { manifest, snapshot: validated.snapshot, selection: validated.selection };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async restoreDartCheckpoints({
    directory,
    maximumBytes = DEFAULT_AWS_CHECKPOINT_MAX_BYTES,
    maximumObjects = DEFAULT_AWS_CHECKPOINT_MAX_OBJECTS
  }) {
    const maxBytes = Number(maximumBytes);
    const maxObjects = Number(maximumObjects);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new TypeError("DART 체크포인트 최대크기가 올바르지 않습니다.");
    }
    if (!Number.isSafeInteger(maxObjects) || maxObjects < 1 || maxObjects > 1_000) {
      throw new TypeError("DART 체크포인트 최대 object 수가 올바르지 않습니다.");
    }
    let continuationToken;
    let objectCount = 0;
    let totalBytes = 0;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.checkpointPrefix,
          ContinuationToken: continuationToken
        })
      );
      for (const object of response?.Contents || []) {
        if (String(object?.Key || "").endsWith("/")) continue;
        const key = safeObjectKey(object.Key);
        const relative = safeRelativeFile(key.slice(this.checkpointPrefix.length));
        const size = Number(object.Size);
        objectCount += 1;
        totalBytes += size;
        if (
          objectCount > maxObjects ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          totalBytes > maxBytes
        ) {
          throw new AwsArtifactError("DART 체크포인트 복원 안전한도를 초과했습니다.", {
            code: "AWS_CHECKPOINT_LIMIT"
          });
        }
        const destination = path.resolve(directory, relative);
        const root = path.resolve(directory);
        if (!destination.startsWith(root + path.sep)) {
          throw new AwsArtifactError("DART 체크포인트 경로가 안전하지 않습니다.", {
            code: "AWS_CHECKPOINT_PATH_INVALID"
          });
        }
        await this.getObjectToFile(key, destination, maxBytes - (totalBytes - size));
      }
      continuationToken = response?.IsTruncated
        ? requiredText(response?.NextContinuationToken, "S3 continuation token")
        : null;
    } while (continuationToken);
    return { objectCount, totalBytes };
  }

  async uploadDartCheckpoints({ directory }) {
    const files = await listFiles(directory);
    const root = path.resolve(directory);
    let totalBytes = 0;
    for (const file of files) {
      const relative = safeRelativeFile(
        path.relative(root, path.resolve(file)).replaceAll("\\", "/")
      );
      const uploaded = await this.putFile(
        `${this.checkpointPrefix}${relative}`,
        file,
        {
          immutable: false,
          cacheControl: "no-store",
          contentType: "application/json"
        }
      );
      totalBytes += uploaded.bytes;
    }
    return { objectCount: files.length, totalBytes };
  }
}

export async function copyArtifactBaseline(file, destination) {
  try {
    await copyFile(file, destination);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function writeAwsArtifactManifestFile(file, manifest) {
  await writeAtomic(file, `${JSON.stringify(validateAwsArtifactManifest(manifest), null, 2)}\n`);
}

export function awsArtifactChecksums({ companiesText, selectionText }) {
  return {
    companies: sha256Text(companiesText),
    selection: sha256Text(selectionText)
  };
}
