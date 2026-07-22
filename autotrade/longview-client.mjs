import { createHash } from "node:crypto";

import {
  investmentSelectionPolicyHash,
  validatePublicInvestmentSelection
} from "../lib/investment-selection.mjs";

export const DEFAULT_LONGVIEW_TIMEOUT_MS = 10_000;
export const DEFAULT_LONGVIEW_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_LONGVIEW_DETAIL_CONCURRENCY = 4;
export const DEFAULT_LONGVIEW_MAX_CANDIDATE_PAGES = 100;
export const LONGVIEW_CANDIDATE_PAGE_SIZE = 100;
export const MAX_LONGVIEW_DETAIL_CONCURRENCY = 16;

export class LongviewClientError extends Error {
  constructor(message, { code, endpoint = null, status = null } = {}) {
    super(message);
    this.name = "LongviewClientError";
    this.code = code || "LONGVIEW_CLIENT_ERROR";
    if (endpoint) this.endpoint = endpoint;
    if (Number.isInteger(status)) this.status = status;
  }
}

function clientError(code, endpoint = null, status = null) {
  const labels = {
    CONFIG_INVALID: "Longview client configuration is invalid.",
    NETWORK_ERROR: "Longview request could not be completed.",
    REQUEST_TIMEOUT: "Longview request timed out.",
    HTTP_ERROR: "Longview request returned an unsuccessful status.",
    RESPONSE_TOO_LARGE: "Longview response exceeded the configured size limit.",
    RESPONSE_TYPE_INVALID: "Longview response was not JSON.",
    RESPONSE_JSON_INVALID: "Longview response contained invalid JSON.",
    RESPONSE_INVALID: "Longview response failed validation.",
    HEALTH_UNSAFE: "Longview health state is not safe for signal generation.",
    MODEL_MISMATCH: "Longview scoring model version does not match.",
    SELECTION_BLOCKED: "Longview published investment selection is not ready.",
    SELECTION_POLICY_MISMATCH: "Longview investment selection policy does not match.",
    REVISION_CHANGED: "Longview data revision changed while signals were loading."
  };
  return new LongviewClientError(labels[code] || labels.RESPONSE_INVALID, {
    code,
    endpoint,
    status
  });
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw clientError("CONFIG_INVALID");
  }
  return resolved;
}

function parseBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw clientError("CONFIG_INVALID");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw clientError("CONFIG_INVALID");
  }
  url.pathname = url.pathname.replace(/\/*$/, "/");
  return url;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function endpointLabel(url) {
  return url.pathname;
}

function cancelBody(response) {
  try {
    const cancellation = response?.body?.cancel?.();
    if (cancellation && typeof cancellation.catch === "function") {
      void cancellation.catch(() => {});
    }
  } catch {
    // Best-effort cancellation only; the sanitized primary error is retained.
  }
}

async function readBodyLimited(response, maximumBytes, endpoint) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw clientError("RESPONSE_TOO_LARGE", endpoint, response.status);
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let byteLength = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > maximumBytes) {
          await reader.cancel().catch(() => {});
          throw clientError("RESPONSE_TOO_LARGE", endpoint, response.status);
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } finally {
      reader.releaseLock?.();
    }
  }

  if (typeof response.text !== "function") {
    throw clientError("RESPONSE_INVALID", endpoint, response.status);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw clientError("RESPONSE_TOO_LARGE", endpoint, response.status);
  }
  return text;
}

function validateHealth(payload, endpoint) {
  if (
    !isRecord(payload) ||
    payload.status !== "ok" ||
    payload.dataLoadStatus !== "ok" ||
    payload.syncing !== false ||
    !nonEmptyString(payload.revision) ||
    !nonEmptyString(payload.updatedAt) ||
    !Number.isFinite(Date.parse(payload.updatedAt)) ||
    !Number.isSafeInteger(payload.companies) ||
    payload.companies < 1
  ) {
    throw clientError("HEALTH_UNSAFE", endpoint);
  }
  if (
    payload.remoteSnapshot?.enabled === true &&
    payload.remoteSnapshot.status !== "ok"
  ) {
    throw clientError("HEALTH_UNSAFE", endpoint);
  }
  return payload;
}

function validateMethodology(payload, endpoint, expectedModelVersion) {
  if (
    !isRecord(payload) ||
    !nonEmptyString(payload.modelVersion) ||
    !Array.isArray(payload.groups) ||
    !isRecord(payload.candidateRules)
  ) {
    throw clientError("RESPONSE_INVALID", endpoint);
  }
  if (expectedModelVersion && payload.modelVersion !== expectedModelVersion) {
    throw clientError("MODEL_MISMATCH", endpoint);
  }
  return payload;
}

function validateCandidate(item, modelVersion, endpoint, expectedId = null) {
  if (
    !isRecord(item) ||
    !nonEmptyString(item.id) ||
    (expectedId !== null && item.id !== expectedId) ||
    String(item.country || "").toUpperCase() !== "KR" ||
    !isRecord(item.score) ||
    item.score.modelVersion !== modelVersion ||
    item.score.evaluationReady !== true ||
    item.score.candidate?.eligible !== true ||
    item.stale === true
  ) {
    const code = isRecord(item?.score) &&
      nonEmptyString(item.score.modelVersion) &&
      item.score.modelVersion !== modelVersion
      ? "MODEL_MISMATCH"
      : "RESPONSE_INVALID";
    throw clientError(code, endpoint);
  }
  return item;
}

function validateCompanyDetail(item, modelVersion, endpoint, expectedId) {
  if (
    !isRecord(item) ||
    !nonEmptyString(item.id) ||
    item.id !== expectedId ||
    String(item.country || "").toUpperCase() !== "KR" ||
    !isRecord(item.score) ||
    item.score.modelVersion !== modelVersion
  ) {
    throw clientError(
      isRecord(item?.score) &&
        nonEmptyString(item.score.modelVersion) &&
        item.score.modelVersion !== modelVersion
        ? "MODEL_MISMATCH"
        : "RESPONSE_INVALID",
      endpoint
    );
  }
  return item;
}

function validateCandidatePage(payload, { page, revision, modelVersion, endpoint }) {
  const pagination = payload?.pagination;
  if (
    !isRecord(payload) ||
    payload.revision !== revision ||
    !isRecord(pagination) ||
    pagination.page !== page ||
    pagination.pageSize !== LONGVIEW_CANDIDATE_PAGE_SIZE ||
    !Number.isSafeInteger(pagination.total) ||
    pagination.total < 0 ||
    !Number.isSafeInteger(pagination.totalPages) ||
    pagination.totalPages < 0 ||
    !Array.isArray(payload.items) ||
    payload.items.length > LONGVIEW_CANDIDATE_PAGE_SIZE
  ) {
    throw clientError(
      payload?.revision && payload.revision !== revision
        ? "REVISION_CHANGED"
        : "RESPONSE_INVALID",
      endpoint
    );
  }
  for (const item of payload.items) validateCandidate(item, modelVersion, endpoint);
  return payload;
}

async function mapLimited(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

export function buildLongviewSignalRevision(rawRevision, modelVersion) {
  if (!nonEmptyString(rawRevision) || !nonEmptyString(modelVersion)) {
    throw clientError("CONFIG_INVALID");
  }
  const digest = createHash("sha256")
    .update("longview-signal-v1\0" + rawRevision + "\0" + modelVersion)
    .digest("hex");
  return "longview-v1-" + digest;
}

export function buildPublishedSelectionSignalRevision(
  rawRevision,
  modelVersion,
  selection
) {
  if (
    !nonEmptyString(rawRevision) ||
    !nonEmptyString(modelVersion) ||
    !isRecord(selection) ||
    !nonEmptyString(selection.generatedAt) ||
    !nonEmptyString(selection.policyHash) ||
    !Array.isArray(selection.ranked)
  ) {
    throw clientError("CONFIG_INVALID");
  }
  const ranked = selection.ranked.map((item) => [
    item.id,
    item.investmentRank,
    item.score,
    item.currentPriceKrw,
    item.quoteAsOf
  ]);
  const digest = createHash("sha256")
    .update(
      "longview-published-selection-v1\0" +
        rawRevision +
        "\0" +
        modelVersion +
        "\0" +
        selection.generatedAt +
        "\0" +
        selection.policyHash +
        "\0" +
        JSON.stringify(ranked)
    )
    .digest("hex");
  return "longview-selection-v1-" + digest;
}

export class LongviewClient {
  constructor({
    baseUrl = "http://127.0.0.1:4173/",
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_LONGVIEW_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_LONGVIEW_MAX_RESPONSE_BYTES,
    detailConcurrency = DEFAULT_LONGVIEW_DETAIL_CONCURRENCY,
    maxCandidatePages = DEFAULT_LONGVIEW_MAX_CANDIDATE_PAGES,
    expectedModelVersion = null,
    requirePublishedSelection = false,
    expectedSelectionPolicy = null,
    now = () => new Date()
  } = {}) {
    if (typeof fetchImpl !== "function" || typeof now !== "function") {
      throw clientError("CONFIG_INVALID");
    }
    this.baseUrl = parseBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = positiveInteger(timeoutMs, DEFAULT_LONGVIEW_TIMEOUT_MS);
    this.maxResponseBytes = positiveInteger(
      maxResponseBytes,
      DEFAULT_LONGVIEW_MAX_RESPONSE_BYTES
    );
    this.detailConcurrency = positiveInteger(
      detailConcurrency,
      DEFAULT_LONGVIEW_DETAIL_CONCURRENCY,
      MAX_LONGVIEW_DETAIL_CONCURRENCY
    );
    this.maxCandidatePages = positiveInteger(
      maxCandidatePages,
      DEFAULT_LONGVIEW_MAX_CANDIDATE_PAGES,
      DEFAULT_LONGVIEW_MAX_CANDIDATE_PAGES
    );
    if (expectedModelVersion !== null && !nonEmptyString(expectedModelVersion)) {
      throw clientError("CONFIG_INVALID");
    }
    this.expectedModelVersion = expectedModelVersion;
    if (typeof requirePublishedSelection !== "boolean") {
      throw clientError("CONFIG_INVALID");
    }
    this.requirePublishedSelection = requirePublishedSelection;
    try {
      this.expectedSelectionPolicyHash = expectedSelectionPolicy
        ? investmentSelectionPolicyHash(expectedSelectionPolicy)
        : null;
    } catch {
      throw clientError("CONFIG_INVALID");
    }
    this.now = now;
  }

  async requestJson(pathname) {
    const url = new URL(pathname, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) throw clientError("CONFIG_INVALID");
    const endpoint = endpointLabel(url);
    const controller = new AbortController();
    let timeoutId;
    const timeout = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(clientError("REQUEST_TIMEOUT", endpoint));
      }, this.timeoutMs);
    });

    let response;
    try {
      response = await Promise.race([
        Promise.resolve().then(() =>
          this.fetchImpl(url, {
            method: "GET",
            headers: { Accept: "application/json", "Cache-Control": "no-cache" },
            cache: "no-store",
            redirect: "error",
            signal: controller.signal
          })
        ),
        timeout
      ]);
    } catch (error) {
      if (error instanceof LongviewClientError) throw error;
      throw clientError("NETWORK_ERROR", endpoint);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response || !Number.isInteger(response.status)) {
      throw clientError("RESPONSE_INVALID", endpoint);
    }
    if (response.status < 200 || response.status >= 300) {
      cancelBody(response);
      throw clientError("HTTP_ERROR", endpoint, response.status);
    }
    const contentType = response.headers?.get?.("content-type") || "";
    if (!/^application\/json\b/i.test(contentType.trim())) {
      cancelBody(response);
      throw clientError("RESPONSE_TYPE_INVALID", endpoint, response.status);
    }

    const text = await readBodyLimited(response, this.maxResponseBytes, endpoint);
    try {
      return JSON.parse(text);
    } catch {
      throw clientError("RESPONSE_JSON_INVALID", endpoint, response.status);
    }
  }

  async getHealth() {
    const endpoint = "/api/health";
    return validateHealth(await this.requestJson(endpoint), endpoint);
  }

  async getMethodology() {
    const endpoint = "/api/methodology";
    return validateMethodology(
      await this.requestJson(endpoint),
      endpoint,
      this.expectedModelVersion
    );
  }

  async getInvestmentSelection({ revision, modelVersion }) {
    const endpoint = "/api/investment-selection";
    let selection;
    try {
      selection = validatePublicInvestmentSelection(
        await this.requestJson(endpoint)
      );
    } catch (error) {
      if (error instanceof LongviewClientError) throw error;
      throw clientError("RESPONSE_INVALID", endpoint);
    }
    if (selection.sourceRevision !== revision) {
      throw clientError("REVISION_CHANGED", endpoint);
    }
    if (selection.modelVersion !== modelVersion) {
      throw clientError("MODEL_MISMATCH", endpoint);
    }
    if (
      this.expectedSelectionPolicyHash &&
      selection.policyHash !== this.expectedSelectionPolicyHash
    ) {
      throw clientError("SELECTION_POLICY_MISMATCH", endpoint);
    }
    if (selection.status !== "ready") {
      throw clientError("SELECTION_BLOCKED", endpoint);
    }
    return selection;
  }

  async getAllCandidateSummaries({ revision, modelVersion }) {
    if (!nonEmptyString(revision) || !nonEmptyString(modelVersion)) {
      throw clientError("CONFIG_INVALID");
    }
    const candidates = [];
    const ids = new Set();
    let expectedTotal = null;
    let expectedTotalPages = null;

    for (let page = 1; ; page += 1) {
      if (page > this.maxCandidatePages) {
        throw clientError("RESPONSE_INVALID", "/api/companies");
      }
      const query = new URLSearchParams({
        candidateOnly: "true",
        country: "KR",
        sort: "score",
        page: String(page),
        pageSize: String(LONGVIEW_CANDIDATE_PAGE_SIZE)
      });
      const endpoint = "/api/companies?" + query;
      const payload = validateCandidatePage(await this.requestJson(endpoint), {
        page,
        revision,
        modelVersion,
        endpoint: "/api/companies"
      });

      if (expectedTotal === null) {
        expectedTotal = payload.pagination.total;
        expectedTotalPages = payload.pagination.totalPages;
        if (expectedTotalPages > this.maxCandidatePages) {
          throw clientError("RESPONSE_INVALID", "/api/companies");
        }
        if ((expectedTotal === 0) !== (expectedTotalPages === 0)) {
          throw clientError("RESPONSE_INVALID", "/api/companies");
        }
        if (
          expectedTotalPages !==
          Math.ceil(expectedTotal / LONGVIEW_CANDIDATE_PAGE_SIZE)
        ) {
          throw clientError("RESPONSE_INVALID", "/api/companies");
        }
      } else if (
        payload.pagination.total !== expectedTotal ||
        payload.pagination.totalPages !== expectedTotalPages
      ) {
        throw clientError("REVISION_CHANGED", "/api/companies");
      }

      for (const candidate of payload.items) {
        if (ids.has(candidate.id)) {
          throw clientError("RESPONSE_INVALID", "/api/companies");
        }
        ids.add(candidate.id);
        candidates.push(candidate);
      }

      if (expectedTotalPages === 0 || page >= expectedTotalPages) break;
    }

    if (candidates.length !== expectedTotal) {
      throw clientError("RESPONSE_INVALID", "/api/companies");
    }
    return candidates;
  }

  async getCandidateDetails(candidateSummaries, { modelVersion }) {
    if (!Array.isArray(candidateSummaries) || !nonEmptyString(modelVersion)) {
      throw clientError("CONFIG_INVALID");
    }
    return mapLimited(candidateSummaries, this.detailConcurrency, async (summary) => {
      const endpoint = "/api/companies/" + encodeURIComponent(summary.id);
      const detail = await this.requestJson(endpoint);
      validateCandidate(detail, modelVersion, "/api/companies/:id", summary.id);
      for (const key of ["ticker", "country", "exchange"]) {
        if (detail[key] !== summary[key]) {
          throw clientError("REVISION_CHANGED", "/api/companies/:id");
        }
      }
      return detail;
    });
  }

  async getCompany(id, { modelVersion = this.expectedModelVersion } = {}) {
    if (!nonEmptyString(id) || !nonEmptyString(modelVersion)) {
      throw clientError("CONFIG_INVALID");
    }
    const endpoint = "/api/companies/" + encodeURIComponent(id);
    return validateCompanyDetail(
      await this.requestJson(endpoint),
      modelVersion,
      "/api/companies/:id",
      id
    );
  }

  async getSignal() {
    const healthBefore = await this.getHealth();
    const methodology = await this.getMethodology();
    const modelVersion = methodology.modelVersion;
    const rawRevision = healthBefore.revision;
    let selection = null;
    let candidateSummaries;
    let candidates;
    if (this.requirePublishedSelection) {
      selection = await this.getInvestmentSelection({
        revision: rawRevision,
        modelVersion
      });
      candidateSummaries = selection.ranked;
      candidates = await mapLimited(
        selection.ranked,
        this.detailConcurrency,
        async (summary) => {
          const detail = await this.getCompany(summary.id, { modelVersion });
          validateCandidate(detail, modelVersion, "/api/companies/:id", summary.id);
          for (const key of ["ticker", "country", "exchange"]) {
            if (detail[key] !== summary[key]) {
              throw clientError("REVISION_CHANGED", "/api/companies/:id");
            }
          }
          return detail;
        }
      );
    } else {
      candidateSummaries = await this.getAllCandidateSummaries({
        revision: rawRevision,
        modelVersion
      });
      candidates = await this.getCandidateDetails(candidateSummaries, { modelVersion });
    }
    const healthAfter = await this.getHealth();
    if (healthAfter.revision !== rawRevision) {
      throw clientError("REVISION_CHANGED", "/api/health");
    }

    const fetchedAtValue = this.now();
    const fetchedAtDate = fetchedAtValue instanceof Date
      ? fetchedAtValue
      : new Date(fetchedAtValue);
    if (Number.isNaN(fetchedAtDate.getTime())) throw clientError("CONFIG_INVALID");
    const fetchedAt = fetchedAtDate.toISOString();
    const revision = selection
      ? buildPublishedSelectionSignalRevision(rawRevision, modelVersion, selection)
      : buildLongviewSignalRevision(rawRevision, modelVersion);
    const quotes = Object.fromEntries(
      candidates.map((company) => [company.id, company.marketData || null])
    );
    return {
      revision,
      signalRevision: revision,
      rawRevision,
      modelVersion,
      sourceUpdatedAt: healthAfter.updatedAt,
      fetchedAt,
      health: healthAfter,
      methodology,
      selection,
      candidateSummaries,
      companies: candidates,
      candidates,
      quotes
    };
  }

  async loadSignals() {
    return this.getSignal();
  }
}

export function createLongviewClient(options) {
  return new LongviewClient(options);
}
