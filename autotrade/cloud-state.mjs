import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const CLOUD_STATE_ENVELOPE_VERSION = 1;
export const CLOUD_STATE_ALGORITHM = "AES-256-GCM";
export const CLOUD_STATE_BRANCH = "trade-state";
export const CLOUD_STATE_FILE_PATH = "state.enc";
export const DEFAULT_CLOUD_STATE_TIMEOUT_MS = 10_000;
export const DEFAULT_CLOUD_STATE_MAX_PLAINTEXT_BYTES = 512 * 1024;
export const DEFAULT_CLOUD_STATE_MAX_ENCRYPTED_BYTES = 1024 * 1024;
export const DEFAULT_CLOUD_STATE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const GITHUB_API_VERSION = "2022-11-28";
const ENVELOPE_KEYS = new Set(["version", "algorithm", "iv", "authTag", "ciphertext"]);

export class CloudStateError extends Error {
  constructor(message, { code = "CLOUD_STATE_ERROR", status = null } = {}) {
    super(message);
    this.name = "CloudStateError";
    this.code = code;
    if (Number.isInteger(status)) this.status = status;
  }
}

export class CloudStateConflictError extends CloudStateError {
  constructor(status) {
    super("Encrypted cloud state changed concurrently; refusing to overwrite it.", {
      code: "CLOUD_STATE_CONFLICT",
      status
    });
    this.name = "CloudStateConflictError";
  }
}

function validationError(message = "Cloud state configuration is invalid.") {
  return new CloudStateError(message, { code: "CLOUD_STATE_VALIDATION" });
}

function sizeError(message = "Cloud state exceeds the configured size limit.") {
  return new CloudStateError(message, { code: "CLOUD_STATE_TOO_LARGE" });
}

function integer(value, fallback, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw validationError();
  }
  return resolved;
}

function ensureStateObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError("Cloud state must be a JSON object.");
  }
  return value;
}

function strictBase64(value, expectedBytes, label) {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
    throw validationError(`${label} is invalid.`);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw validationError(`${label} is invalid.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || decoded.length !== expectedBytes) {
    throw validationError(`${label} is invalid.`);
  }
  return decoded;
}

function decodeFlexibleBase64(value, maximumBytes, label) {
  if (typeof value !== "string") throw validationError(`${label} is invalid.`);
  const normalized = value.replace(/\s/g, "");
  if (
    normalized.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)
  ) {
    throw validationError(`${label} is invalid.`);
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    throw validationError(`${label} is invalid.`);
  }
  if (decoded.length > maximumBytes) throw sizeError();
  return decoded;
}

export function parseCloudStateEncryptionKey(value) {
  return strictBase64(value, 32, "Cloud state encryption key");
}

export function redactCloudStateSecrets(value, secrets = []) {
  let safe = value instanceof Error ? value.message : String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      safe = safe.split(secret).join("[redacted]");
    } else if (Buffer.isBuffer(secret) && secret.length > 0) {
      safe = safe.split(secret.toString("base64")).join("[redacted]");
      safe = safe.split(secret.toString("hex")).join("[redacted]");
    }
  }
  return safe
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]")
    .replace(/\b\d{8}-?\d{2}\b/g, "[redacted-account]")
    .slice(0, 1_000);
}

function serializeState(state, maximumBytes) {
  ensureStateObject(state);
  let serialized;
  try {
    serialized = JSON.stringify(state);
  } catch {
    throw validationError("Cloud state must be JSON serializable.");
  }
  if (serialized === undefined) throw validationError("Cloud state must be JSON serializable.");
  const plaintext = Buffer.from(serialized, "utf8");
  if (plaintext.length > maximumBytes) throw sizeError();
  return plaintext;
}

function associatedDataBuffer(value) {
  if (typeof value !== "string") throw validationError();
  return Buffer.from(`longview-cloud-state-v1\0${value}`, "utf8");
}

function encryptWithKey(state, key, { associatedData = "", maximumPlaintextBytes, randomBytesImpl }) {
  const plaintext = serializeState(state, maximumPlaintextBytes);
  const iv = randomBytesImpl(12);
  if (!Buffer.isBuffer(iv) || iv.length !== 12) throw validationError();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associatedDataBuffer(associatedData));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return JSON.stringify({
    version: CLOUD_STATE_ENVELOPE_VERSION,
    algorithm: CLOUD_STATE_ALGORITHM,
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  });
}

export function encryptCloudState(
  state,
  encryptionKey,
  {
    associatedData = "",
    maximumPlaintextBytes = DEFAULT_CLOUD_STATE_MAX_PLAINTEXT_BYTES,
    maximumEncryptedBytes = DEFAULT_CLOUD_STATE_MAX_ENCRYPTED_BYTES,
    randomBytesImpl = randomBytes
  } = {}
) {
  const key = parseCloudStateEncryptionKey(encryptionKey);
  const plaintextLimit = integer(
    maximumPlaintextBytes,
    DEFAULT_CLOUD_STATE_MAX_PLAINTEXT_BYTES
  );
  const encryptedLimit = integer(
    maximumEncryptedBytes,
    DEFAULT_CLOUD_STATE_MAX_ENCRYPTED_BYTES
  );
  if (typeof randomBytesImpl !== "function") throw validationError();
  const envelope = encryptWithKey(state, key, {
    associatedData,
    maximumPlaintextBytes: plaintextLimit,
    randomBytesImpl
  });
  if (Buffer.byteLength(envelope, "utf8") > encryptedLimit) throw sizeError();
  return envelope;
}

function parseEnvelope(envelope, maximumEncryptedBytes) {
  if (typeof envelope !== "string") throw validationError("Encrypted cloud state is invalid.");
  if (Buffer.byteLength(envelope, "utf8") > maximumEncryptedBytes) throw sizeError();
  let parsed;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    throw validationError("Encrypted cloud state is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw validationError("Encrypted cloud state is invalid.");
  }
  const keys = Object.keys(parsed);
  if (
    keys.length !== ENVELOPE_KEYS.size ||
    keys.some((key) => !ENVELOPE_KEYS.has(key)) ||
    parsed.version !== CLOUD_STATE_ENVELOPE_VERSION ||
    parsed.algorithm !== CLOUD_STATE_ALGORITHM ||
    typeof parsed.ciphertext !== "string"
  ) {
    throw validationError("Encrypted cloud state is invalid.");
  }
  return {
    iv: strictBase64(parsed.iv, 12, "Cloud state IV"),
    authTag: strictBase64(parsed.authTag, 16, "Cloud state authentication tag"),
    ciphertext: decodeFlexibleBase64(
      parsed.ciphertext,
      maximumEncryptedBytes,
      "Cloud state ciphertext"
    )
  };
}

function decryptWithKey(envelope, key, { associatedData, maximumEncryptedBytes }) {
  const parsed = parseEnvelope(envelope, maximumEncryptedBytes);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, parsed.iv);
    decipher.setAAD(associatedDataBuffer(associatedData));
    decipher.setAuthTag(parsed.authTag);
    const plaintext = Buffer.concat([
      decipher.update(parsed.ciphertext),
      decipher.final()
    ]);
    let state;
    try {
      state = JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw validationError("Decrypted cloud state is invalid.");
    }
    return ensureStateObject(state);
  } catch (error) {
    if (error instanceof CloudStateError) throw error;
    throw new CloudStateError("Encrypted cloud state authentication failed.", {
      code: "CLOUD_STATE_AUTHENTICATION_FAILED"
    });
  }
}

export function decryptCloudState(
  envelope,
  encryptionKey,
  {
    associatedData = "",
    maximumEncryptedBytes = DEFAULT_CLOUD_STATE_MAX_ENCRYPTED_BYTES
  } = {}
) {
  const key = parseCloudStateEncryptionKey(encryptionKey);
  return decryptWithKey(envelope, key, {
    associatedData,
    maximumEncryptedBytes: integer(
      maximumEncryptedBytes,
      DEFAULT_CLOUD_STATE_MAX_ENCRYPTED_BYTES
    )
  });
}

function parseRepository(value) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(String(value || ""));
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
    throw validationError("GitHub repository must be owner/name.");
  }
  return { owner: match[1], name: match[2], fullName: `${match[1]}/${match[2]}` };
}

function parseBranch(value) {
  const branch = String(value || "");
  if (
    !branch ||
    branch.length > 255 ||
    !/^[A-Za-z0-9._/-]+$/.test(branch) ||
    branch.includes("..") ||
    branch.startsWith("/") ||
    branch.endsWith("/")
  ) {
    throw validationError("Cloud state branch is invalid.");
  }
  return branch;
}

function parseFilePath(value) {
  const filePath = String(value || "");
  const parts = filePath.split("/");
  if (
    !filePath ||
    filePath.length > 1_024 ||
    filePath.startsWith("/") ||
    filePath.endsWith("/") ||
    parts.some((part) => !part || part === "." || part === ".." || /[\0\r\n]/.test(part))
  ) {
    throw validationError("Cloud state file path is invalid.");
  }
  return { value: filePath, encoded: parts.map(encodeURIComponent).join("/") };
}

function parseApiBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || "https://api.github.com/"));
  } catch {
    throw validationError("GitHub API URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw validationError("GitHub API URL is invalid.");
  }
  url.pathname = url.pathname.replace(/\/*$/, "/");
  return url;
}

function cancelBody(response) {
  try {
    const result = response?.body?.cancel?.();
    if (result && typeof result.catch === "function") void result.catch(() => {});
  } catch {
    // Best effort only. No response content is included in errors.
  }
}

async function readResponseLimited(response, maximumBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    cancelBody(response);
    throw sizeError("GitHub state response exceeds the configured size limit.");
  }
  if (response.body?.getReader) {
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
          throw sizeError("GitHub state response exceeds the configured size limit.");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } finally {
      reader.releaseLock?.();
    }
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw sizeError("GitHub state response exceeds the configured size limit.");
  }
  return text;
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new CloudStateError("GitHub state response was not valid JSON.", {
      code: "CLOUD_STATE_RESPONSE_INVALID"
    });
  }
}

function validateGitSha(value, label = "Git object SHA") {
  const sha = String(value || "");
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(sha)) {
    throw new CloudStateError(`GitHub response did not contain a valid ${label}.`, {
      code: "CLOUD_STATE_RESPONSE_INVALID"
    });
  }
  return sha;
}

function validateBlobSha(value) {
  return validateGitSha(value, "blob SHA");
}

function validateBranchRef(payload, branch) {
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.ref !== `refs/heads/${branch}` ||
    !payload.object ||
    payload.object.type !== "commit"
  ) {
    throw new CloudStateError("GitHub branch response was invalid.", {
      code: "CLOUD_STATE_RESPONSE_INVALID"
    });
  }
  return {
    branch,
    ref: payload.ref,
    sha: validateGitSha(payload.object.sha, "commit SHA")
  };
}

export class GitHubEncryptedStateStore {
  #token;
  #key;

  constructor({
    repository,
    token,
    encryptionKey,
    fetchImpl = globalThis.fetch,
    apiBaseUrl = "https://api.github.com/",
    branch = CLOUD_STATE_BRANCH,
    filePath = CLOUD_STATE_FILE_PATH,
    timeoutMs = DEFAULT_CLOUD_STATE_TIMEOUT_MS,
    maximumPlaintextBytes = DEFAULT_CLOUD_STATE_MAX_PLAINTEXT_BYTES,
    maximumEncryptedBytes = DEFAULT_CLOUD_STATE_MAX_ENCRYPTED_BYTES,
    maximumResponseBytes = DEFAULT_CLOUD_STATE_MAX_RESPONSE_BYTES,
    randomBytesImpl = randomBytes
  } = {}) {
    if (typeof fetchImpl !== "function" || typeof randomBytesImpl !== "function") {
      throw validationError();
    }
    this.repository = parseRepository(repository);
    this.#token = String(token || "").trim();
    if (!this.#token) throw validationError("GitHub state token is required.");
    this.#key = parseCloudStateEncryptionKey(encryptionKey);
    this.apiBaseUrl = parseApiBaseUrl(apiBaseUrl);
    this.branch = parseBranch(branch);
    this.filePath = parseFilePath(filePath);
    this.timeoutMs = integer(timeoutMs, DEFAULT_CLOUD_STATE_TIMEOUT_MS, {
      minimum: 100,
      maximum: 120_000
    });
    this.maximumPlaintextBytes = integer(
      maximumPlaintextBytes,
      DEFAULT_CLOUD_STATE_MAX_PLAINTEXT_BYTES
    );
    this.maximumEncryptedBytes = integer(
      maximumEncryptedBytes,
      DEFAULT_CLOUD_STATE_MAX_ENCRYPTED_BYTES
    );
    this.maximumResponseBytes = integer(
      maximumResponseBytes,
      DEFAULT_CLOUD_STATE_MAX_RESPONSE_BYTES
    );
    this.fetchImpl = fetchImpl;
    this.randomBytesImpl = randomBytesImpl;
    this.associatedData = [
      this.repository.fullName,
      this.branch,
      this.filePath.value
    ].join("\0");
  }

  contentUrl({ includeRef = false } = {}) {
    const relative = [
      "repos",
      encodeURIComponent(this.repository.owner),
      encodeURIComponent(this.repository.name),
      "contents",
      this.filePath.encoded
    ].join("/");
    const url = new URL(relative, this.apiBaseUrl);
    if (includeRef) url.searchParams.set("ref", this.branch);
    return url;
  }

  repositoryUrl(...segments) {
    const relative = [
      "repos",
      encodeURIComponent(this.repository.owner),
      encodeURIComponent(this.repository.name),
      ...segments.map((segment) => encodeURIComponent(segment))
    ].join("/");
    return new URL(relative, this.apiBaseUrl);
  }

  branchRefUrl(branch) {
    return this.repositoryUrl("git", "ref", "heads", ...branch.split("/"));
  }

  headers() {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.#token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "longview-encrypted-cloud-state"
    };
  }

  async request(url, options) {
    const controller = new AbortController();
    let timeoutId;
    const timeout = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(
          new CloudStateError("GitHub state request timed out.", {
            code: "CLOUD_STATE_TIMEOUT"
          })
        );
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() =>
          this.fetchImpl(url, { ...options, signal: controller.signal })
        ),
        timeout
      ]);
    } catch (error) {
      if (error instanceof CloudStateError) throw error;
      const safe = redactCloudStateSecrets(error, [this.#token, this.#key]);
      throw new CloudStateError(`GitHub state request failed: ${safe || "network error"}.`, {
        code: "CLOUD_STATE_NETWORK_ERROR"
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  encrypt(state) {
    const envelope = encryptWithKey(state, this.#key, {
      associatedData: this.associatedData,
      maximumPlaintextBytes: this.maximumPlaintextBytes,
      randomBytesImpl: this.randomBytesImpl
    });
    if (Buffer.byteLength(envelope, "utf8") > this.maximumEncryptedBytes) throw sizeError();
    return envelope;
  }

  decrypt(envelope) {
    return decryptWithKey(envelope, this.#key, {
      associatedData: this.associatedData,
      maximumEncryptedBytes: this.maximumEncryptedBytes
    });
  }

  async getBranchRef(branch, { allowMissing = false } = {}) {
    const normalizedBranch = parseBranch(branch);
    const response = await this.request(this.branchRefUrl(normalizedBranch), {
      method: "GET",
      headers: this.headers(),
      redirect: "error"
    });
    if (!response || !Number.isInteger(response.status)) {
      throw new CloudStateError("GitHub branch response was invalid.", {
        code: "CLOUD_STATE_RESPONSE_INVALID"
      });
    }
    if (response.status === 404 && allowMissing) {
      cancelBody(response);
      return null;
    }
    if (response.status !== 200) {
      cancelBody(response);
      throw new CloudStateError("GitHub branch read failed.", {
        code: "CLOUD_STATE_HTTP_ERROR",
        status: response.status
      });
    }
    return validateBranchRef(
      parseJsonResponse(await readResponseLimited(response, this.maximumResponseBytes)),
      normalizedBranch
    );
  }

  async ensureBranch() {
    const existing = await this.getBranchRef(this.branch, { allowMissing: true });
    if (existing) return { ...existing, created: false, raced: false };

    const repositoryResponse = await this.request(this.repositoryUrl(), {
      method: "GET",
      headers: this.headers(),
      redirect: "error"
    });
    if (!repositoryResponse || !Number.isInteger(repositoryResponse.status)) {
      throw new CloudStateError("GitHub repository response was invalid.", {
        code: "CLOUD_STATE_RESPONSE_INVALID"
      });
    }
    if (repositoryResponse.status !== 200) {
      cancelBody(repositoryResponse);
      throw new CloudStateError("GitHub repository read failed.", {
        code: "CLOUD_STATE_HTTP_ERROR",
        status: repositoryResponse.status
      });
    }
    const repositoryPayload = parseJsonResponse(
      await readResponseLimited(repositoryResponse, this.maximumResponseBytes)
    );
    const defaultBranch = parseBranch(repositoryPayload?.default_branch);
    const baseRef = await this.getBranchRef(defaultBranch);

    const createResponse = await this.request(this.repositoryUrl("git", "refs"), {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: `refs/heads/${this.branch}`,
        sha: baseRef.sha
      }),
      redirect: "error"
    });
    if (!createResponse || !Number.isInteger(createResponse.status)) {
      throw new CloudStateError("GitHub branch creation response was invalid.", {
        code: "CLOUD_STATE_RESPONSE_INVALID"
      });
    }
    if (createResponse.status === 422) {
      cancelBody(createResponse);
      const raced = await this.getBranchRef(this.branch);
      return { ...raced, created: false, raced: true };
    }
    if (createResponse.status !== 201) {
      cancelBody(createResponse);
      throw new CloudStateError("GitHub branch creation failed.", {
        code: "CLOUD_STATE_HTTP_ERROR",
        status: createResponse.status
      });
    }
    const created = validateBranchRef(
      parseJsonResponse(await readResponseLimited(createResponse, this.maximumResponseBytes)),
      this.branch
    );
    if (created.sha !== baseRef.sha) {
      throw new CloudStateError("GitHub branch was created from an unexpected commit.", {
        code: "CLOUD_STATE_RESPONSE_INVALID"
      });
    }
    return { ...created, created: true, raced: false };
  }

  async getContentRecord() {
    const response = await this.request(this.contentUrl({ includeRef: true }), {
      method: "GET",
      headers: this.headers(),
      redirect: "error"
    });
    if (!response || !Number.isInteger(response.status)) {
      throw new CloudStateError("GitHub state response was invalid.", {
        code: "CLOUD_STATE_RESPONSE_INVALID"
      });
    }
    if (response.status === 404) {
      cancelBody(response);
      return null;
    }
    if (response.status < 200 || response.status >= 300) {
      cancelBody(response);
      throw new CloudStateError("GitHub state read failed.", {
        code: "CLOUD_STATE_HTTP_ERROR",
        status: response.status
      });
    }
    const payload = parseJsonResponse(
      await readResponseLimited(response, this.maximumResponseBytes)
    );
    if (
      !payload ||
      typeof payload !== "object" ||
      payload.type !== "file" ||
      payload.encoding !== "base64"
    ) {
      throw new CloudStateError("GitHub state response was invalid.", {
        code: "CLOUD_STATE_RESPONSE_INVALID"
      });
    }
    if (!Number.isSafeInteger(payload.size) || payload.size < 0) {
      throw new CloudStateError("GitHub state response was invalid.", {
        code: "CLOUD_STATE_RESPONSE_INVALID"
      });
    }
    if (payload.size > this.maximumEncryptedBytes) throw sizeError();
    const encryptedBytes = decodeFlexibleBase64(
      payload.content,
      this.maximumEncryptedBytes,
      "GitHub state content"
    );
    if (encryptedBytes.length !== payload.size) {
      throw new CloudStateError("GitHub state response size did not match its content.", {
        code: "CLOUD_STATE_RESPONSE_INVALID"
      });
    }
    return {
      encrypted: encryptedBytes.toString("utf8"),
      sha: validateBlobSha(payload.sha)
    };
  }

  async load() {
    const record = await this.getContentRecord();
    if (!record) return { exists: false, state: null, sha: null };
    return {
      exists: true,
      state: this.decrypt(record.encrypted),
      sha: record.sha
    };
  }

  async assertUnchanged(expectedBlobSha) {
    const expected = validateBlobSha(expectedBlobSha);
    const current = await this.getContentRecord();
    if (!current || current.sha !== expected) {
      throw new CloudStateConflictError(current ? 409 : 404);
    }
    return { unchanged: true, sha: current.sha };
  }

  async save(state, { sha = null, message = "trade-state: update encrypted state" } = {}) {
    if (sha !== null) validateBlobSha(sha);
    const normalizedMessage = String(message || "").trim();
    if (!normalizedMessage || normalizedMessage.length > 256 || /[\r\n]/.test(normalizedMessage)) {
      throw validationError("Cloud state commit message is invalid.");
    }
    const encrypted = this.encrypt(state);
    const body = {
      message: normalizedMessage,
      content: Buffer.from(encrypted, "utf8").toString("base64"),
      branch: this.branch,
      ...(sha ? { sha } : {})
    };
    const response = await this.request(this.contentUrl(), {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error"
    });
    if (!response || !Number.isInteger(response.status)) {
      throw new CloudStateError("GitHub state response was invalid.", {
        code: "CLOUD_STATE_RESPONSE_INVALID"
      });
    }
    if (response.status === 409 || response.status === 422) {
      cancelBody(response);
      throw new CloudStateConflictError(response.status);
    }
    if (response.status !== 200 && response.status !== 201) {
      cancelBody(response);
      throw new CloudStateError("GitHub state write failed.", {
        code: "CLOUD_STATE_HTTP_ERROR",
        status: response.status
      });
    }
    const payload = parseJsonResponse(
      await readResponseLimited(response, this.maximumResponseBytes)
    );
    return { sha: validateBlobSha(payload?.content?.sha) };
  }

  async loadOrInitialize(initialState, options = {}) {
    const loaded = await this.load();
    if (loaded.exists) return { ...loaded, initialized: false };
    ensureStateObject(initialState);
    const saved = await this.save(initialState, {
      sha: null,
      message: options.message || "trade-state: initialize encrypted state"
    });
    return {
      exists: true,
      initialized: true,
      state: structuredClone(initialState),
      sha: saved.sha
    };
  }

  async update(mutator, { initialState, message } = {}) {
    if (typeof mutator !== "function") throw validationError("Cloud state mutator is required.");
    const loaded = await this.load();
    if (!loaded.exists && initialState === undefined) {
      throw new CloudStateError("Encrypted cloud state does not exist.", {
        code: "CLOUD_STATE_NOT_FOUND",
        status: 404
      });
    }
    const draft = structuredClone(loaded.exists ? loaded.state : ensureStateObject(initialState));
    const returned = await mutator(draft);
    const next = returned === undefined ? draft : returned;
    ensureStateObject(next);
    const saved = await this.save(next, {
      sha: loaded.sha,
      message: message || (loaded.exists
        ? "trade-state: update encrypted state"
        : "trade-state: initialize encrypted state")
    });
    return {
      state: structuredClone(next),
      sha: saved.sha,
      previousSha: loaded.sha,
      initialized: !loaded.exists
    };
  }
}
