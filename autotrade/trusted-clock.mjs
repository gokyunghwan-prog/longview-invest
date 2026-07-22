import { performance } from "node:perf_hooks";

export const TRUSTED_CLOCK_SOURCE = "github-api-date";
export const DEFAULT_TRUSTED_CLOCK_TTL_MS = 120_000;
export const DEFAULT_TRUSTED_CLOCK_MAX_RTT_MS = 5_000;
export const HTTP_DATE_RESOLUTION_MS = 1_000;

const HTTP_DATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export class TrustedClockError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TrustedClockError";
    this.code = code;
  }
}

function clockError(code, message) {
  return new TrustedClockError(message, code);
}

function positiveFinite(value, fallback, label) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TypeError(`${label}은(는) 0보다 큰 유한수여야 합니다.`);
  }
  return resolved;
}

function readMonotonic(monotonicNow) {
  let value;
  try {
    value = Number(monotonicNow());
  } catch {
    throw clockError(
      "TRUSTED_CLOCK_MONOTONIC_INVALID",
      "신뢰 시각용 monotonic clock을 읽지 못했습니다."
    );
  }
  if (!Number.isFinite(value) || value < 0) {
    throw clockError(
      "TRUSTED_CLOCK_MONOTONIC_INVALID",
      "신뢰 시각용 monotonic clock 값이 올바르지 않습니다."
    );
  }
  return value;
}

function sampleHeader(sample, name) {
  if (sample?.headers && typeof sample.headers.get === "function") {
    try {
      return sample.headers.get(name);
    } catch {
      return null;
    }
  }
  if (name === "date") return sample?.dateHeader ?? null;
  if (name === "age") return sample?.ageHeader ?? null;
  return null;
}

function parseHttpDate(value) {
  if (typeof value !== "string" || !HTTP_DATE_PATTERN.test(value)) {
    throw clockError(
      value ? "TRUSTED_CLOCK_DATE_INVALID" : "TRUSTED_CLOCK_DATE_MISSING",
      value
        ? "GitHub API Date 헤더가 올바른 IMF-fixdate 형식이 아닙니다."
        : "GitHub API 응답에 Date 헤더가 없습니다."
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toUTCString() !== value) {
    throw clockError(
      "TRUSTED_CLOCK_DATE_INVALID",
      "GitHub API Date 헤더가 올바른 UTC 시각이 아닙니다."
    );
  }
  return parsed;
}

function validateSample(sample) {
  if (!sample || typeof sample !== "object" || !Number.isInteger(sample.status)) {
    throw clockError(
      "TRUSTED_CLOCK_SAMPLE_INVALID",
      "GitHub API 시각 응답 형식이 올바르지 않습니다."
    );
  }
  if (sample.redirected === true) {
    throw clockError(
      "TRUSTED_CLOCK_REDIRECTED",
      "GitHub API 시각 요청이 다른 주소로 이동되어 신뢰할 수 없습니다."
    );
  }
  if (sample.status < 200 || sample.status >= 300) {
    throw clockError(
      "TRUSTED_CLOCK_HTTP_ERROR",
      "GitHub API 시각 요청이 성공하지 않았습니다."
    );
  }

  const ageHeader = sampleHeader(sample, "age");
  if (ageHeader !== null && ageHeader !== "") {
    const age = Number(ageHeader);
    if (!Number.isFinite(age) || age < 0 || age > 0) {
      throw clockError(
        "TRUSTED_CLOCK_CACHED_RESPONSE",
        "캐시된 GitHub API 응답의 시각은 신뢰할 수 없습니다."
      );
    }
  }
  return parseHttpDate(sampleHeader(sample, "date"));
}

function publicBounds(sample, monotonicAt) {
  const elapsedMs = monotonicAt - sample.receivedMonotonicMs;
  const earliestMs = sample.earliestAtReceiptMs + elapsedMs;
  const latestMs = sample.latestAtReceiptMs + elapsedMs;
  return {
    earliest: new Date(earliestMs),
    latest: new Date(latestMs),
    uncertaintyMs: latestMs - earliestMs,
    ageMs: elapsedMs,
    rttMs: sample.rttMs,
    source: TRUSTED_CLOCK_SOURCE
  };
}

export class GitHubDateTrustedClock {
  constructor({
    sample,
    monotonicNow = () => performance.now(),
    ttlMs = DEFAULT_TRUSTED_CLOCK_TTL_MS,
    maxRttMs = DEFAULT_TRUSTED_CLOCK_MAX_RTT_MS
  } = {}) {
    if (typeof sample !== "function") {
      throw new TypeError("GitHub API Date 샘플 함수가 필요합니다.");
    }
    if (typeof monotonicNow !== "function") {
      throw new TypeError("monotonic clock 함수가 필요합니다.");
    }
    this.sampleGithubDate = sample;
    this.monotonicNow = monotonicNow;
    this.ttlMs = positiveFinite(ttlMs, DEFAULT_TRUSTED_CLOCK_TTL_MS, "신뢰 시각 TTL");
    this.maxRttMs = positiveFinite(
      maxRttMs,
      DEFAULT_TRUSTED_CLOCK_MAX_RTT_MS,
      "신뢰 시각 최대 RTT"
    );
    this.currentSample = null;
    this.lastReturnedNowMs = null;
    this.refreshPromise = null;
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    const pending = this.#refresh();
    this.refreshPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.refreshPromise === pending) this.refreshPromise = null;
    }
  }

  async #refresh() {
    const startedMonotonicMs = readMonotonic(this.monotonicNow);
    let response;
    try {
      response = await this.sampleGithubDate();
    } catch {
      throw clockError(
        "TRUSTED_CLOCK_SAMPLE_FAILED",
        "GitHub API에서 신뢰 시각을 가져오지 못했습니다."
      );
    }
    const receivedMonotonicMs = readMonotonic(this.monotonicNow);
    if (receivedMonotonicMs < startedMonotonicMs) {
      throw clockError(
        "TRUSTED_CLOCK_MONOTONIC_ROLLBACK",
        "신뢰 시각 동기화 중 monotonic clock이 뒤로 이동했습니다."
      );
    }
    const rttMs = receivedMonotonicMs - startedMonotonicMs;
    if (rttMs > this.maxRttMs) {
      throw clockError(
        "TRUSTED_CLOCK_RTT_EXCEEDED",
        "GitHub API 시각 응답 지연이 허용 범위를 초과했습니다."
      );
    }

    const serverSecondMs = validateSample(response);
    let earliestAtReceiptMs = serverSecondMs;
    let latestAtReceiptMs =
      serverSecondMs + HTTP_DATE_RESOLUTION_MS - 1 + Math.ceil(rttMs);

    if (this.currentSample) {
      const previousAgeMs = receivedMonotonicMs - this.currentSample.receivedMonotonicMs;
      if (previousAgeMs < 0) {
        throw clockError(
          "TRUSTED_CLOCK_MONOTONIC_ROLLBACK",
          "신뢰 시각 갱신 전 monotonic clock이 뒤로 이동했습니다."
        );
      }
      const previousEarliest = this.currentSample.earliestAtReceiptMs + previousAgeMs;
      const previousLatest = this.currentSample.latestAtReceiptMs + previousAgeMs;
      const intersectedEarliest = Math.max(earliestAtReceiptMs, previousEarliest);
      const intersectedLatest = Math.min(latestAtReceiptMs, previousLatest);
      if (intersectedEarliest > intersectedLatest) {
        throw clockError(
          "TRUSTED_CLOCK_SAMPLE_INCONSISTENT",
          "연속된 GitHub API 시각 샘플이 서로 일치하지 않습니다."
        );
      }
      earliestAtReceiptMs = intersectedEarliest;
      latestAtReceiptMs = intersectedLatest;
    }

    if (
      this.lastReturnedNowMs !== null &&
      latestAtReceiptMs < this.lastReturnedNowMs
    ) {
      throw clockError(
        "TRUSTED_CLOCK_NON_MONOTONIC",
        "갱신된 GitHub API 시각이 이미 사용한 시각보다 과거입니다."
      );
    }

    this.currentSample = {
      earliestAtReceiptMs,
      latestAtReceiptMs,
      receivedMonotonicMs,
      rttMs
    };
    return publicBounds(this.currentSample, receivedMonotonicMs);
  }

  bounds() {
    if (!this.currentSample) {
      throw clockError(
        "TRUSTED_CLOCK_NOT_READY",
        "GitHub API 신뢰 시각이 아직 동기화되지 않았습니다."
      );
    }
    const monotonicAt = readMonotonic(this.monotonicNow);
    const ageMs = monotonicAt - this.currentSample.receivedMonotonicMs;
    if (ageMs < 0) {
      throw clockError(
        "TRUSTED_CLOCK_MONOTONIC_ROLLBACK",
        "신뢰 시각 사용 중 monotonic clock이 뒤로 이동했습니다."
      );
    }
    if (ageMs > this.ttlMs) {
      throw clockError(
        "TRUSTED_CLOCK_STALE",
        "GitHub API 신뢰 시각 샘플이 만료되었습니다."
      );
    }
    return publicBounds(this.currentSample, monotonicAt);
  }

  now() {
    const bounds = this.bounds();
    const midpointMs = Math.floor(
      (bounds.earliest.getTime() + bounds.latest.getTime()) / 2
    );
    const resolvedMs =
      this.lastReturnedNowMs === null
        ? midpointMs
        : Math.max(midpointMs, this.lastReturnedNowMs);
    if (resolvedMs > bounds.latest.getTime()) {
      throw clockError(
        "TRUSTED_CLOCK_NON_MONOTONIC",
        "신뢰 시각을 단조 증가하도록 유지할 수 없습니다."
      );
    }
    this.lastReturnedNowMs = resolvedMs;
    return new Date(resolvedMs);
  }
}

export function createGitHubDateTrustedClock(options) {
  return new GitHubDateTrustedClock(options);
}
