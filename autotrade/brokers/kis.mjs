const DEFAULT_PRODUCTION_URL = "https://openapi.koreainvestment.com:9443";
const DEFAULT_VIRTUAL_URL = "https://openapivts.koreainvestment.com:29443";
const DEFAULT_MINIMUM_INTERVAL_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_BALANCE_PAGES = 10;
const DEFAULT_MAX_BALANCE_ROWS = 5_000;
const MAX_DAILY_ORDER_QUERY_CALENDAR_DAYS = 7;
const TOKEN_EXPIRY_SKEW_MS = 60_000;

const DOMESTIC_BALANCE_PATH = "/uapi/domestic-stock/v1/trading/inquire-balance";
const DOMESTIC_ORDER_PATH = "/uapi/domestic-stock/v1/trading/order-cash";
const DOMESTIC_QUOTE_PATH = "/uapi/domestic-stock/v1/quotations/inquire-price";
const DOMESTIC_BUYABLE_PATH = "/uapi/domestic-stock/v1/trading/inquire-psbl-order";
const DOMESTIC_DAILY_ORDERS_PATH = "/uapi/domestic-stock/v1/trading/inquire-daily-ccld";
const DOMESTIC_CANCELABLE_ORDERS_PATH =
  "/uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl";
const DOMESTIC_CANCEL_PATH = "/uapi/domestic-stock/v1/trading/order-rvsecncl";

function sleepFor(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function finiteNumber(value, fallback = 0) {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const normalized = cleanText(value).replaceAll(",", "").replace(/%$/, "");
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstNumber(source, keys, fallback = 0) {
  for (const key of keys) {
    if (source?.[key] !== undefined && cleanText(source[key]) !== "") {
      return finiteNumber(source[key], fallback);
    }
  }
  return fallback;
}

function asRows(value) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
  return value && typeof value === "object" ? [value] : [];
}

function toTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(timestamp)) throw new Error("현재 시각 함수가 올바른 값을 반환하지 않았습니다.");
  return timestamp;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label}은(는) 1 이상의 정수여야 합니다.`);
  }
  return String(parsed);
}

function requiredNonNegativeInteger(source, keys, label, code) {
  for (const key of keys) {
    if (source?.[key] === undefined || cleanText(source[key]) === "") continue;
    const normalized = cleanText(source[key]).replaceAll(",", "");
    if (!/^\d+$/.test(normalized)) break;
    const parsed = Number(normalized);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    break;
  }
  throw new KisApiError(`KIS ${label} 응답이 올바르지 않습니다.`, { code });
}

function optionalNonNegativeInteger(source, keys, fallback = 0) {
  for (const key of keys) {
    if (source?.[key] === undefined || cleanText(source[key]) === "") continue;
    const normalized = cleanText(source[key]).replaceAll(",", "");
    if (!/^\d+$/.test(normalized)) return fallback;
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
  }
  return fallback;
}

function positivePrice(value, { integer = false } = {}) {
  const normalized = cleanText(value);
  if (!/^\d+(?:\.\d+)?$/.test(normalized) || finiteNumber(normalized) <= 0) {
    throw new TypeError("지정가는 0보다 큰 숫자여야 합니다.");
  }
  if (integer && !/^\d+$/.test(normalized)) {
    throw new TypeError("국내주식 지정가는 원 단위 정수여야 합니다.");
  }
  return normalized.replace(/^0+(?=\d)/, "");
}

function normalizeSide(value) {
  const side = cleanText(value).toLowerCase();
  if (side !== "buy" && side !== "sell") {
    throw new TypeError("주문 방향은 buy 또는 sell이어야 합니다.");
  }
  return side;
}

function ensureLimitOrder(order) {
  const orderType = cleanText(order?.orderType || order?.type || "limit").toLowerCase();
  if (orderType !== "limit") throw new TypeError("KIS 자동주문은 지정가 주문만 허용합니다.");
}

function domesticRoute(order) {
  const route = cleanText(order?.route || order?.exchangeCode || order?.exchange).toUpperCase();
  return route === "NXT" || route === "SOR" ? route : "KRX";
}

function domesticQuoteMarket(order) {
  const route = domesticRoute(order);
  if (route === "NXT") return "NX";
  if (route === "SOR") return "UN";
  return "J";
}

function dailyOrderRoute(value) {
  const route = cleanText(value || "ALL").toUpperCase();
  if (!["KRX", "NXT", "SOR", "ALL"].includes(route)) {
    throw new TypeError("거래소 조회 구분은 KRX, NXT, SOR 또는 ALL이어야 합니다.");
  }
  return route;
}

function queryCode(value, mapping, label, fallback) {
  const normalized = cleanText(value || fallback).toLowerCase();
  const code = mapping[normalized];
  if (!code) throw new TypeError(`${label} 조회 구분이 올바르지 않습니다.`);
  return code;
}

function kstBusinessDate(timestamp) {
  return new Date(timestamp + 9 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
}

function dailyOrderQueryDate(value, label) {
  const normalized = cleanText(value);
  if (!/^\d{8}$/.test(normalized)) {
    throw new TypeError(`${label}은(는) YYYYMMDD 형식이어야 합니다.`);
  }
  const year = Number(normalized.slice(0, 4));
  const month = Number(normalized.slice(4, 6));
  const day = Number(normalized.slice(6, 8));
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new TypeError(`${label}이(가) 올바른 달력 날짜가 아닙니다.`);
  }
  return { value: normalized, timestamp };
}

function dailyOrderQueryRange({ startDate, endDate, today }) {
  const start = dailyOrderQueryDate(startDate || today, "주문조회 시작일");
  const end = dailyOrderQueryDate(endDate || today, "주문조회 종료일");
  if (start.timestamp > end.timestamp) {
    throw new TypeError("주문조회 시작일은 종료일보다 늦을 수 없습니다.");
  }
  const calendarDays = Math.floor((end.timestamp - start.timestamp) / 86_400_000) + 1;
  if (calendarDays > MAX_DAILY_ORDER_QUERY_CALENDAR_DAYS) {
    throw new TypeError(
      `주문조회 기간은 ${MAX_DAILY_ORDER_QUERY_CALENDAR_DAYS}일을 초과할 수 없습니다.`
    );
  }
  return { startDate: start.value, endDate: end.value };
}

function validateTicker(order) {
  const ticker = cleanText(order?.ticker).toUpperCase();
  if (!/^\d{6,7}$/.test(ticker)) throw new TypeError("국내주식 종목코드가 올바르지 않습니다.");
  return ticker;
}

function deduplicatePositions(positions) {
  const byId = new Map();
  for (const position of positions) {
    const key = cleanText(position?.id);
    if (!key) continue;
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, position);
      continue;
    }
    if (
      existing.country !== position.country ||
      existing.currency !== position.currency ||
      existing.quantity !== position.quantity
    ) {
      throw new KisApiError("KIS 잔고 연속조회에서 서로 다른 중복 보유종목이 발견되었습니다.", {
        code: "KIS_BALANCE_DUPLICATE_CONFLICT"
      });
    }
    byId.set(key, {
      ...existing,
      ...position,
      name: position.name || existing.name,
      availableQuantity: Math.min(existing.availableQuantity, position.availableQuantity)
    });
  }
  return [...byId.values()];
}

function normalizeDailyOrder(row) {
  const brokerOrderId = cleanText(row?.odno);
  const branchNumber = cleanText(row?.ord_gno_brno || row?.ord_orgno);
  const ticker = cleanText(row?.pdno);
  const orderDate = cleanText(row?.ord_dt);
  if (
    !/^\d{1,20}$/.test(brokerOrderId) ||
    !/^\d{1,10}$/.test(branchNumber) ||
    !/^\d{6,7}$/.test(ticker) ||
    !/^\d{8}$/.test(orderDate)
  ) {
    throw new KisApiError("KIS 당일 주문 응답의 식별자가 올바르지 않습니다.", {
      code: "KIS_DAILY_ORDER_INVALID"
    });
  }
  const sideCode = cleanText(row.sll_buy_dvsn_cd);
  const side = sideCode === "01" ? "sell" : sideCode === "02" ? "buy" : null;
  if (!side) {
    throw new KisApiError("KIS 당일 주문 응답의 매매 구분이 올바르지 않습니다.", {
      code: "KIS_DAILY_ORDER_INVALID"
    });
  }
  const orderQuantity = requiredNonNegativeInteger(
    row,
    ["ord_qty", "tot_ord_qty"],
    "당일 주문수량",
    "KIS_DAILY_ORDER_INVALID"
  );
  const filledQuantity = requiredNonNegativeInteger(
    row,
    ["tot_ccld_qty"],
    "당일 체결수량",
    "KIS_DAILY_ORDER_INVALID"
  );
  const canceledQuantity = optionalNonNegativeInteger(row, ["cnc_cfrm_qty"]);
  const rejectedQuantity = optionalNonNegativeInteger(row, ["rjct_qty"]);
  const explicitRemaining = optionalNonNegativeInteger(row, ["rmn_qty"], -1);
  const remainingQuantity =
    explicitRemaining >= 0
      ? explicitRemaining
      : Math.max(0, orderQuantity - filledQuantity - canceledQuantity - rejectedQuantity);
  if (
    filledQuantity > orderQuantity ||
    canceledQuantity > orderQuantity ||
    rejectedQuantity > orderQuantity ||
    remainingQuantity > orderQuantity ||
    filledQuantity + canceledQuantity + rejectedQuantity + remainingQuantity > orderQuantity
  ) {
    throw new KisApiError("KIS 당일 주문 응답의 수량 관계가 올바르지 않습니다.", {
      code: "KIS_DAILY_ORDER_INVALID"
    });
  }
  const canceled = cleanText(row.cncl_yn).toUpperCase() === "Y" || canceledQuantity > 0;
  const status = canceled
    ? filledQuantity > 0
      ? "partial_canceled"
      : "canceled"
    : rejectedQuantity >= orderQuantity && orderQuantity > 0
      ? "rejected"
      : remainingQuantity === 0 && filledQuantity === orderQuantity && orderQuantity > 0
        ? "filled"
        : filledQuantity > 0
          ? "partial"
          : remainingQuantity > 0
            ? "open"
            : orderQuantity > 0
              ? "submitted"
              : "unknown";
  return {
    orderDate,
    orderTime: cleanText(row.ord_tmd),
    brokerOrderId,
    branchNumber,
    originalOrderId: cleanText(row.orgn_odno),
    ticker,
    name: cleanText(row.prdt_name),
    country: "KR",
    currency: "KRW",
    side,
    orderType: "limit",
    orderDivisionCode: cleanText(row.ord_dvsn_cd || "00"),
    route: dailyOrderRoute(row.excg_id_dvsn_cd || row.excg_id_dvsn_Cd || "KRX"),
    orderQuantity,
    limitPrice: optionalNonNegativeInteger(row, ["ord_unpr"]),
    filledQuantity,
    remainingQuantity,
    canceledQuantity,
    rejectedQuantity,
    averageFilledPrice: optionalNonNegativeInteger(row, ["avg_prvs"]),
    filledAmountKrw: optionalNonNegativeInteger(row, ["tot_ccld_amt"]),
    canceled,
    status
  };
}

function dailyOrderView(order) {
  return {
    brokerOrderId: order.brokerOrderId,
    branchNumber: order.branchNumber,
    ticker: order.ticker,
    side: order.side,
    quantity: order.orderQuantity,
    filledQuantity: order.filledQuantity,
    remainingQuantity: order.remainingQuantity,
    canceledQuantity: order.canceledQuantity,
    limitPrice: order.limitPrice,
    averageFillPrice: order.averageFilledPrice,
    orderDate: order.orderDate,
    orderTime: order.orderTime,
    status: order.status
  };
}

function deduplicateDailyOrders(rows) {
  const orders = new Map();
  for (const row of rows) {
    if (!row || Object.keys(row).length === 0) continue;
    const normalized = normalizeDailyOrder(row);
    const key = [
      normalized.orderDate,
      normalized.branchNumber,
      normalized.brokerOrderId,
      normalized.ticker,
      normalized.side
    ].join("\u0000");
    const previous = orders.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
      throw new KisApiError("KIS 당일 주문 연속조회에 충돌하는 중복 주문이 있습니다.", {
        code: "KIS_DAILY_ORDER_DUPLICATE_CONFLICT"
      });
    }
    orders.set(key, normalized);
  }
  return [...orders.values()];
}

function normalizeCancelableOrder(row) {
  const brokerOrderId = cleanText(row?.odno);
  const branchNumber = cleanText(row?.ord_gno_brno || row?.ord_orgno);
  const ticker = cleanText(row?.pdno);
  if (
    !/^\d{1,20}$/.test(brokerOrderId) ||
    !/^\d{1,10}$/.test(branchNumber) ||
    !/^\d{6,7}$/.test(ticker)
  ) {
    throw new KisApiError("KIS 정정취소 가능 주문 응답의 식별자가 올바르지 않습니다.", {
      code: "KIS_CANCELABLE_ORDER_INVALID"
    });
  }
  const sideCode = cleanText(row.sll_buy_dvsn_cd);
  const side = sideCode === "01" ? "sell" : sideCode === "02" ? "buy" : null;
  if (!side) {
    throw new KisApiError("KIS 정정취소 가능 주문 응답의 매매 구분이 올바르지 않습니다.", {
      code: "KIS_CANCELABLE_ORDER_INVALID"
    });
  }
  const orderQuantity = requiredNonNegativeInteger(
    row,
    ["ord_qty"],
    "정정취소 원주문수량",
    "KIS_CANCELABLE_ORDER_INVALID"
  );
  const filledQuantity = requiredNonNegativeInteger(
    row,
    ["tot_ccld_qty"],
    "정정취소 체결수량",
    "KIS_CANCELABLE_ORDER_INVALID"
  );
  const cancelableQuantity = requiredNonNegativeInteger(
    row,
    ["psbl_qty"],
    "정정취소 가능수량",
    "KIS_CANCELABLE_ORDER_INVALID"
  );
  if (
    filledQuantity > orderQuantity ||
    cancelableQuantity > orderQuantity ||
    filledQuantity + cancelableQuantity > orderQuantity
  ) {
    throw new KisApiError("KIS 정정취소 가능 주문 응답의 수량 관계가 올바르지 않습니다.", {
      code: "KIS_CANCELABLE_ORDER_INVALID"
    });
  }
  return {
    brokerOrderId,
    branchNumber,
    originalOrderId: cleanText(row.orgn_odno),
    ticker,
    name: cleanText(row.prdt_name),
    country: "KR",
    currency: "KRW",
    side,
    orderType: "limit",
    orderDivisionCode: cleanText(row.ord_dvsn_cd || "00"),
    route: dailyOrderRoute(row.excg_id_dvsn_cd || "KRX"),
    orderQuantity,
    limitPrice: requiredNonNegativeInteger(
      row,
      ["ord_unpr"],
      "정정취소 주문단가",
      "KIS_CANCELABLE_ORDER_INVALID"
    ),
    filledQuantity,
    cancelableQuantity,
    orderTime: cleanText(row.ord_tmd)
  };
}

function deduplicateCancelableOrders(rows) {
  const orders = new Map();
  for (const row of rows) {
    if (!row || Object.keys(row).length === 0) continue;
    const normalized = normalizeCancelableOrder(row);
    const key = [normalized.branchNumber, normalized.brokerOrderId, normalized.ticker].join(
      "\u0000"
    );
    const previous = orders.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
      throw new KisApiError("KIS 정정취소 가능 주문 연속조회에 충돌하는 중복 주문이 있습니다.", {
        code: "KIS_CANCELABLE_ORDER_DUPLICATE_CONFLICT"
      });
    }
    orders.set(key, normalized);
  }
  return [...orders.values()];
}

function redact(value, secrets) {
  let safe = cleanText(value) || "KIS API 요청에 실패했습니다.";
  for (const secret of secrets) {
    if (secret && secret.length >= 4) safe = safe.split(secret).join("[REDACTED]");
  }
  safe = safe.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]");
  return safe;
}

export class KisApiError extends Error {
  constructor(message, { code = "KIS_API_ERROR", status = null, ambiguous = false } = {}) {
    super(message);
    this.name = "KisApiError";
    this.code = code;
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

export class KisBroker {
  constructor(
    config,
    {
      fetchImpl = globalThis.fetch,
      now = Date.now,
      sleep = sleepFor,
      minimumIntervalMs = DEFAULT_MINIMUM_INTERVAL_MS,
      requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
      maximumBalancePages = DEFAULT_MAX_BALANCE_PAGES,
      maximumBalanceRows = DEFAULT_MAX_BALANCE_ROWS,
      tokenExpirySkewMs = TOKEN_EXPIRY_SKEW_MS
    } = {}
  ) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetch 구현이 필요합니다.");
    if (!config || !cleanText(config.appKey) || !cleanText(config.appSecret)) {
      throw new Error("KIS App Key와 App Secret 설정이 필요합니다.");
    }
    if (!/^\d{8}$/.test(cleanText(config.accountNumber))) {
      throw new Error("KIS 계좌번호 앞 8자리가 필요합니다.");
    }
    if (!/^\d{2}$/.test(cleanText(config.productCode || "01"))) {
      throw new Error("KIS 계좌 상품코드 2자리가 필요합니다.");
    }
    const environment = cleanText(config.environment || "vps").toLowerCase();
    if (environment !== "vps" && environment !== "prod") {
      throw new Error("KIS 환경은 vps 또는 prod여야 합니다.");
    }
    if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0) {
      throw new TypeError("KIS 호출 간격은 0 이상의 숫자여야 합니다.");
    }
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new TypeError("KIS 요청 제한시간은 0보다 큰 숫자여야 합니다.");
    }
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
      throw new TypeError("KIS 응답 최대크기는 1 이상의 정수여야 합니다.");
    }
    if (!Number.isSafeInteger(maximumBalancePages) || maximumBalancePages <= 0) {
      throw new TypeError("KIS 잔고 최대 페이지 수는 1 이상의 정수여야 합니다.");
    }
    if (!Number.isSafeInteger(maximumBalanceRows) || maximumBalanceRows <= 0) {
      throw new TypeError("KIS 잔고 최대 행 수는 1 이상의 정수여야 합니다.");
    }
    if (typeof AbortController !== "function") {
      throw new Error("KIS 요청 제한시간을 적용하려면 AbortController가 필요합니다.");
    }

    this.name = "kis";
    this.environment = environment;
    this.appKey = cleanText(config.appKey);
    this.appSecret = cleanText(config.appSecret);
    this.accountNumber = cleanText(config.accountNumber);
    this.productCode = cleanText(config.productCode || "01");
    this.baseUrl = cleanText(
      environment === "prod"
        ? config.productionUrl || DEFAULT_PRODUCTION_URL
        : config.virtualUrl || DEFAULT_VIRTUAL_URL
    ).replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.minimumIntervalMs = minimumIntervalMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.maximumBalancePages = maximumBalancePages;
    this.maximumBalanceRows = maximumBalanceRows;
    this.tokenExpirySkewMs = Math.max(0, finiteNumber(tokenExpirySkewMs));

    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    this.tokenPromise = null;
    this.networkChain = Promise.resolve();
    this.lastRequestStartedAt = Number.NEGATIVE_INFINITY;
  }

  _now() {
    return toTimestamp(this.now());
  }

  _secrets(extra = []) {
    return [this.appKey, this.appSecret, this.accountNumber, this.accessToken, ...extra]
      .map(cleanText)
      .filter(Boolean);
  }

  _safeMessage(value, extra = []) {
    return redact(value, this._secrets(extra));
  }

  _scheduleNetwork(work) {
    const run = async () => {
      const earliest = this.lastRequestStartedAt + this.minimumIntervalMs;
      const waitMilliseconds = Math.max(0, earliest - this._now());
      if (waitMilliseconds > 0) await this.sleep(waitMilliseconds);
      this.lastRequestStartedAt = Math.max(this._now(), earliest);
      return work();
    };
    const result = this.networkChain.then(run, run);
    this.networkChain = result.catch(() => {});
    return result;
  }

  _responseTooLarge(status, ambiguous) {
    return new KisApiError("KIS API 응답이 허용된 최대크기를 초과했습니다.", {
      code: "KIS_RESPONSE_TOO_LARGE",
      status,
      ambiguous
    });
  }

  async _readResponseText(response, { ambiguous = false } = {}) {
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
      throw this._responseTooLarge(response.status, ambiguous);
    }

    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let totalBytes = 0;
      let raw = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
          totalBytes += bytes.byteLength;
          if (totalBytes > this.maxResponseBytes) {
            try {
              await reader.cancel();
            } catch {
              // 응답 크기 오류를 유지하고 스트림 취소 오류는 무시한다.
            }
            throw this._responseTooLarge(response.status, ambiguous);
          }
          raw += decoder.decode(bytes, { stream: true });
        }
        raw += decoder.decode();
        return raw;
      } finally {
        reader.releaseLock?.();
      }
    }

    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > this.maxResponseBytes) {
      throw this._responseTooLarge(response.status, ambiguous);
    }
    return raw;
  }

  async _fetchJson(url, options, { ambiguous = false } = {}) {
    const controller = new AbortController();
    let timedOut = false;
    let timeoutId;
    const timeoutError = () =>
      new KisApiError("KIS API 요청 시간이 초과되었습니다.", {
        code: "KIS_REQUEST_TIMEOUT",
        ambiguous
      });

    const request = async () => {
      let response;
      try {
        response = await this.fetchImpl(url, { ...options, signal: controller.signal });
      } catch (error) {
        if (timedOut || error?.name === "AbortError") throw timeoutError();
        throw new KisApiError(this._safeMessage(error?.message || "KIS API 연결 실패"), {
          code: "KIS_NETWORK_ERROR",
          ambiguous
        });
      }

      let raw;
      try {
        raw = await this._readResponseText(response, { ambiguous });
      } catch (error) {
        if (error instanceof KisApiError) throw error;
        if (timedOut || error?.name === "AbortError") throw timeoutError();
        throw new KisApiError("KIS API 응답을 읽지 못했습니다.", {
          code: "KIS_INVALID_RESPONSE",
          status: response.status,
          ambiguous
        });
      }

      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        throw new KisApiError("KIS API가 올바른 JSON을 반환하지 않았습니다.", {
          code: "KIS_INVALID_RESPONSE",
          status: response.status,
          ambiguous
        });
      }

      if (!response.ok) {
        const message = this._safeMessage(body?.msg1 || body?.message || `KIS HTTP ${response.status}`);
        throw new KisApiError(message, {
          code: cleanText(body?.msg_cd) || "KIS_HTTP_ERROR",
          status: response.status,
          ambiguous
        });
      }
      return { body, response };
    };

    const timeout = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError());
      }, this.requestTimeoutMs);
    });

    try {
      return await Promise.race([request(), timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async _issueAccessToken() {
    const issuedAt = this._now();
    const { body } = await this._scheduleNetwork(() =>
      this._fetchJson(`${this.baseUrl}/oauth2/tokenP`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          appkey: this.appKey,
          appsecret: this.appSecret
        })
      })
    );
    const token = cleanText(body?.access_token);
    if (!token) {
      throw new KisApiError("KIS 접근토큰 응답에 토큰이 없습니다.", {
        code: "KIS_TOKEN_MISSING"
      });
    }
    const expiresInSeconds = Math.max(1, finiteNumber(body?.expires_in, 86_400));
    this.accessToken = token;
    this.accessTokenExpiresAt = issuedAt + expiresInSeconds * 1_000;
    return token;
  }

  async _getAccessToken() {
    if (
      this.accessToken &&
      this._now() < this.accessTokenExpiresAt - this.tokenExpirySkewMs
    ) {
      return this.accessToken;
    }
    if (this.tokenPromise) return this.tokenPromise;

    const pending = this._issueAccessToken();
    this.tokenPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.tokenPromise === pending) this.tokenPromise = null;
    }
  }

  clearToken() {
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
  }

  async _request(
    path,
    {
      trId,
      method = "GET",
      query = null,
      body = null,
      order = false,
      trCont = "",
      includeMeta = false
    }
  ) {
    const token = await this._getAccessToken();
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, cleanText(value));
    }
    const headers = {
      "Content-Type": "application/json; charset=UTF-8",
      authorization: `Bearer ${token}`,
      appkey: this.appKey,
      appsecret: this.appSecret,
      tr_id: trId,
      custtype: "P",
      tr_cont: trCont
    };
    const { body: responseBody, response } = await this._scheduleNetwork(() =>
      this._fetchJson(
        url.toString(),
        {
          method,
          headers,
          ...(body ? { body: JSON.stringify(body) } : {})
        },
        { ambiguous: order }
      )
    );
    if (cleanText(responseBody?.rt_cd) !== "0") {
      throw new KisApiError(
        this._safeMessage(responseBody?.msg1 || "KIS 거래가 거절되었습니다.", [token]),
        {
          code: cleanText(responseBody?.msg_cd) || "KIS_TRANSACTION_ERROR",
          status: 200,
          ambiguous: false
        }
      );
    }
    if (!includeMeta) return responseBody;
    return {
      body: responseBody,
      trCont: cleanText(response.headers?.get?.("tr_cont")).toUpperCase()
    };
  }

  async _getPagedRows({
    path,
    trId,
    query,
    fkName,
    nkName,
    fkBodyName,
    nkBodyName,
    rowsBodyName = "output1",
    secondaryBodyName = "output2",
    resourceLabel = "잔고",
    errorCodePrefix = "KIS_BALANCE"
  }) {
    const rows = [];
    const secondary = [];
    const seenCursors = new Set(["\u0000"]);
    let fk = "";
    let nk = "";

    for (let page = 1; page <= this.maximumBalancePages; page += 1) {
      const { body, trCont } = await this._request(path, {
        trId,
        query: { ...query, [fkName]: fk, [nkName]: nk },
        trCont: page === 1 ? "" : "N",
        includeMeta: true
      });
      rows.push(...asRows(body[rowsBodyName]));
      secondary.push(...asRows(body[secondaryBodyName]));
      if (rows.length + secondary.length > this.maximumBalanceRows) {
        throw new KisApiError(`KIS ${resourceLabel} 응답이 허용된 최대 행 수를 초과했습니다.`, {
          code: `${errorCodePrefix}_SIZE_LIMIT`
        });
      }

      if (trCont !== "M" && trCont !== "F") {
        return { rows, secondary, pages: page };
      }
      const nextFk = cleanText(body[fkBodyName] ?? body[fkName]);
      const nextNk = cleanText(body[nkBodyName] ?? body[nkName]);
      if (!nextFk && !nextNk) {
        throw new KisApiError(`KIS ${resourceLabel} 연속조회 토큰이 누락되었습니다.`, {
          code: `${errorCodePrefix}_CONTINUATION_INVALID`
        });
      }
      const cursor = `${nextFk}\u0000${nextNk}`;
      if (seenCursors.has(cursor)) {
        throw new KisApiError(`KIS ${resourceLabel} 연속조회 토큰이 반복되었습니다.`, {
          code: `${errorCodePrefix}_CONTINUATION_LOOP`
        });
      }
      seenCursors.add(cursor);
      fk = nextFk;
      nk = nextNk;
    }

    throw new KisApiError(`KIS ${resourceLabel} 연속조회가 허용된 최대 페이지 수를 초과했습니다.`, {
      code: `${errorCodePrefix}_PAGE_LIMIT`
    });
  }

  async _getBalancePages(options) {
    const result = await this._getPagedRows(options);
    return { output1: result.rows, output2: result.secondary, pages: result.pages };
  }

  async getQuote(instrument) {
    if (!instrument || typeof instrument !== "object") {
      throw new TypeError("현재가를 조회할 종목 객체가 필요합니다.");
    }
    const country = cleanText(instrument.country).toUpperCase();
    if (country !== "KR") {
      throw new TypeError("KIS 현재가는 국내주식만 조회할 수 있습니다.");
    }
    const ticker = validateTicker(instrument);
    const marketCode = domesticQuoteMarket(instrument);
    const payload = await this._request(DOMESTIC_QUOTE_PATH, {
      trId: "FHKST01010100",
      query: {
        FID_COND_MRKT_DIV_CODE: marketCode,
        FID_INPUT_ISCD: ticker
      }
    });
    const output = asRows(payload.output)[0] || {};
    const price = firstNumber(output, ["stck_prpr"]);
    if (price <= 0) {
      throw new KisApiError("KIS 국내주식 현재가 응답에 유효한 가격이 없습니다.", {
        code: "KIS_QUOTE_MISSING"
      });
    }
    const observedAt = new Date(this._now()).toISOString();
    return {
      id: cleanText(instrument.id) || `KR:${ticker}`,
      ticker,
      name: cleanText(instrument.name),
      country: "KR",
      exchange: domesticRoute(instrument),
      quoteExchangeCode: marketCode,
      price,
      currency: "KRW",
      asOf: observedAt,
      quotedAt: observedAt,
      current: true,
      source: "KIS",
      previousClose: firstNumber(output, ["stck_sdpr"]),
      change: firstNumber(output, ["prdy_vrss"]),
      changeRate: firstNumber(output, ["prdy_ctrt"]),
      volume: firstNumber(output, ["acml_vol"]),
      marketDate: cleanText(output.stck_bsop_date),
      marketTime: cleanText(output.stck_cntg_hour)
    };
  }

  async getQuotes(companies) {
    if (!Array.isArray(companies)) throw new TypeError("현재가 조회 종목 목록은 배열이어야 합니다.");
    const quotes = [];
    for (const company of companies) quotes.push(await this.getQuote(company));
    return quotes;
  }

  async getBuyableOrder(order) {
    if (!order || typeof order !== "object") {
      throw new TypeError("매수가능 조회 주문 객체가 필요합니다.");
    }
    const country = cleanText(order.country || "KR").toUpperCase();
    if (country !== "KR") throw new TypeError("KIS 매수가능 조회는 국내주식만 허용됩니다.");
    const ticker = validateTicker({ ...order, country });
    const limitPrice = positivePrice(order.limitPrice, { integer: true });
    const requestedQuantity =
      order.quantity === undefined || order.quantity === null
        ? null
        : Number(positiveInteger(order.quantity, "조회 주문수량"));
    const payload = await this._request(DOMESTIC_BUYABLE_PATH, {
      trId: this.environment === "prod" ? "TTTC8908R" : "VTTC8908R",
      query: {
        CANO: this.accountNumber,
        ACNT_PRDT_CD: this.productCode,
        PDNO: ticker,
        ORD_UNPR: limitPrice,
        // The official sample requires market-order calculation here so the
        // security margin rate is reflected in the no-receivable quantity.
        // The actual order remains a limit order in placeOrder().
        ORD_DVSN: "01",
        CMA_EVLU_AMT_ICLD_YN: "N",
        OVRS_ICLD_YN: "N"
      }
    });
    const output = payload.output || {};
    const noReceivableAmountKrw = requiredNonNegativeInteger(
      output,
      ["nrcvb_buy_amt"],
      "미수 없는 매수가능금액",
      "KIS_BUYABLE_INVALID"
    );
    const noReceivableQuantity = requiredNonNegativeInteger(
      output,
      ["nrcvb_buy_qty"],
      "미수 없는 매수가능수량",
      "KIS_BUYABLE_INVALID"
    );
    return {
      ticker,
      country: "KR",
      currency: "KRW",
      limitPrice: Number(limitPrice),
      noReceivableAmountKrw,
      noReceivableQuantity,
      requestedQuantity,
      sufficient:
        requestedQuantity === null ? null : requestedQuantity <= noReceivableQuantity,
      calculationOrderDivision: "01"
    };
  }

  async getDailyOrders({
    startDate = "",
    endDate = "",
    ticker = "",
    brokerOrderId = "",
    branchNumber = "",
    side = "all",
    fill = "all",
    route = "ALL"
  } = {}) {
    const dateRange = dailyOrderQueryRange({
      startDate,
      endDate,
      today: kstBusinessDate(this._now())
    });
    const normalizedTicker = cleanText(ticker);
    if (normalizedTicker) validateTicker({ ticker: normalizedTicker });
    const normalizedOrderId = cleanText(brokerOrderId);
    const normalizedBranch = cleanText(branchNumber);
    if (normalizedOrderId && !/^\d{1,20}$/.test(normalizedOrderId)) {
      throw new TypeError("KIS 주문번호가 올바르지 않습니다.");
    }
    if (normalizedBranch && !/^\d{1,10}$/.test(normalizedBranch)) {
      throw new TypeError("KIS 주문채번지점번호가 올바르지 않습니다.");
    }
    const sideCode = queryCode(
      side,
      { all: "00", sell: "01", buy: "02" },
      "매도매수",
      "all"
    );
    const fillCode = queryCode(
      fill,
      { all: "00", filled: "01", unfilled: "02" },
      "체결",
      "all"
    );
    const result = await this._getPagedRows({
      path: DOMESTIC_DAILY_ORDERS_PATH,
      trId: this.environment === "prod" ? "TTTC0081R" : "VTTC0081R",
      query: {
        CANO: this.accountNumber,
        ACNT_PRDT_CD: this.productCode,
        INQR_STRT_DT: dateRange.startDate,
        INQR_END_DT: dateRange.endDate,
        SLL_BUY_DVSN_CD: sideCode,
        PDNO: normalizedTicker,
        CCLD_DVSN: fillCode,
        INQR_DVSN: "00",
        INQR_DVSN_3: "01",
        ORD_GNO_BRNO: normalizedBranch,
        ODNO: normalizedOrderId,
        INQR_DVSN_1: "",
        EXCG_ID_DVSN_CD: dailyOrderRoute(route)
      },
      fkName: "CTX_AREA_FK100",
      nkName: "CTX_AREA_NK100",
      fkBodyName: "ctx_area_fk100",
      nkBodyName: "ctx_area_nk100",
      resourceLabel: "당일 주문체결",
      errorCodePrefix: "KIS_DAILY_ORDERS"
    });
    return {
      orders: deduplicateDailyOrders(result.rows).map(dailyOrderView),
      pages: result.pages
    };
  }

  async getTodayOrders(options = {}) {
    return this.getDailyOrders(options);
  }

  async getCancelableOrders({ side = "all" } = {}) {
    if (this.environment !== "prod") {
      throw new KisApiError("KIS 정정취소 가능 주문 조회는 실전계좌에서만 지원됩니다.", {
        code: "KIS_CANCELABLE_PROD_ONLY"
      });
    }
    const sideCode = queryCode(
      side,
      { all: "0", sell: "1", buy: "2" },
      "정정취소 매도매수",
      "all"
    );
    const result = await this._getPagedRows({
      path: DOMESTIC_CANCELABLE_ORDERS_PATH,
      trId: "TTTC0084R",
      query: {
        CANO: this.accountNumber,
        ACNT_PRDT_CD: this.productCode,
        INQR_DVSN_1: "0",
        INQR_DVSN_2: sideCode
      },
      fkName: "CTX_AREA_FK100",
      nkName: "CTX_AREA_NK100",
      fkBodyName: "ctx_area_fk100",
      nkBodyName: "ctx_area_nk100",
      rowsBodyName: "output",
      secondaryBodyName: "__none__",
      resourceLabel: "정정취소 가능 주문",
      errorCodePrefix: "KIS_CANCELABLE_ORDERS"
    });
    return {
      orders: deduplicateCancelableOrders(result.rows),
      pages: result.pages
    };
  }

  async cancelOrder(order) {
    if (!order || typeof order !== "object") throw new TypeError("취소할 주문 객체가 필요합니다.");
    if (this.environment !== "prod") {
      throw new KisApiError("안전한 자동취소는 실전계좌에서만 지원됩니다.", {
        code: "KIS_CANCEL_PROD_ONLY"
      });
    }
    const country = cleanText(order.country || "KR").toUpperCase();
    if (country !== "KR") throw new TypeError("KIS 자동취소는 국내주식만 허용됩니다.");
    const brokerOrderId = cleanText(order.brokerOrderId);
    const branchNumber = cleanText(order.branchNumber);
    const ticker = validateTicker({ ticker: order.ticker });
    if (!/^\d{1,20}$/.test(brokerOrderId) || !/^\d{1,10}$/.test(branchNumber)) {
      throw new TypeError("취소에는 유효한 KIS 주문번호와 주문채번지점번호가 필요합니다.");
    }
    const route = domesticRoute(order);
    const history = await this.getDailyOrders({
      ticker,
      brokerOrderId,
      branchNumber,
      side: cleanText(order.side || "all"),
      fill: "all",
      route
    });
    const matchingHistory = history.orders.filter(
      (item) =>
        item.brokerOrderId === brokerOrderId &&
        item.branchNumber === branchNumber &&
        item.ticker === ticker
    );
    if (matchingHistory.length !== 1) {
      throw new KisApiError("취소할 원주문을 당일 주문체결 내역에서 하나로 확인하지 못했습니다.", {
        code: "KIS_CANCEL_HISTORY_NOT_UNIQUE"
      });
    }
    const current = matchingHistory[0];
    if (
      current.status !== "open" ||
      current.quantity <= 0 ||
      current.filledQuantity !== 0 ||
      current.canceledQuantity !== 0 ||
      current.remainingQuantity !== current.quantity ||
      current.limitPrice <= 0
    ) {
      throw new KisApiError("전량 미체결로 확인된 주문만 자동취소할 수 있습니다.", {
        code: "KIS_CANCEL_NOT_FULLY_UNFILLED"
      });
    }

    const cancelable = await this.getCancelableOrders({ side: current.side });
    const matchingCancelable = cancelable.orders.filter(
      (item) =>
        item.brokerOrderId === brokerOrderId &&
        item.branchNumber === branchNumber &&
        item.ticker === ticker
    );
    if (matchingCancelable.length !== 1) {
      throw new KisApiError("원주문의 정정취소 가능수량을 하나로 확인하지 못했습니다.", {
        code: "KIS_CANCELABLE_NOT_UNIQUE"
      });
    }
    const available = matchingCancelable[0];
    if (
      available.filledQuantity !== 0 ||
      available.cancelableQuantity !== current.remainingQuantity ||
      available.orderQuantity !== current.quantity ||
      available.side !== current.side
    ) {
      throw new KisApiError("정정취소 가능수량이 전량 미체결 원주문과 일치하지 않습니다.", {
        code: "KIS_CANCELABLE_QUANTITY_MISMATCH"
      });
    }

    const payload = await this._request(DOMESTIC_CANCEL_PATH, {
      trId: "TTTC0013U",
      method: "POST",
      body: {
        CANO: this.accountNumber,
        ACNT_PRDT_CD: this.productCode,
        KRX_FWDG_ORD_ORGNO: branchNumber,
        ORGN_ODNO: brokerOrderId,
        ORD_DVSN: "00",
        RVSE_CNCL_DVSN_CD: "02",
        ORD_QTY: String(current.remainingQuantity),
        ORD_UNPR: String(current.limitPrice),
        QTY_ALL_ORD_YN: "Y",
        EXCG_ID_DVSN_CD: route
      },
      order: true
    });
    const output = payload.output || {};
    const cancelOrderId = cleanText(output.ODNO || output.odno);
    if (!cancelOrderId) {
      throw new KisApiError("KIS 취소 성공 응답에 증권사 주문번호가 없습니다.", {
        code: "KIS_CANCEL_ID_MISSING",
        ambiguous: true
      });
    }
    return {
      status: "cancel_submitted",
      broker: this.name,
      country: "KR",
      ticker,
      side: current.side,
      originalOrderId: brokerOrderId,
      cancelOrderId,
      branchNumber: cleanText(
        output.KRX_FWDG_ORD_ORGNO || output.ORD_GNO_BRNO || output.ord_gno_brno
      ) || branchNumber,
      canceledQuantity: current.remainingQuantity,
      submittedAt: new Date(this._now()).toISOString()
    };
  }

  async cancelFullyUnfilledOrder(order) {
    return this.cancelOrder(order);
  }

  async getDomesticBalance() {
    const pages = await this._getBalancePages({
      path: DOMESTIC_BALANCE_PATH,
      trId: this.environment === "prod" ? "TTTC8434R" : "VTTC8434R",
      query: {
        CANO: this.accountNumber,
        ACNT_PRDT_CD: this.productCode,
        AFHR_FLPR_YN: "N",
        OFL_YN: "",
        INQR_DVSN: "02",
        UNPR_DVSN: "01",
        FUND_STTL_ICLD_YN: "N",
        FNCG_AMT_AUTO_RDPT_YN: "N",
        PRCS_DVSN: "00"
      },
      fkName: "CTX_AREA_FK100",
      nkName: "CTX_AREA_NK100",
      fkBodyName: "ctx_area_fk100",
      nkBodyName: "ctx_area_nk100"
    });
    const rows = pages.output1;
    const summary = pages.output2[0] || {};
    const positions = deduplicatePositions(rows
      .map((row) => {
        const ticker = cleanText(row.pdno || row.mksc_shrn_iscd);
        const quantity = firstNumber(row, ["hldg_qty", "ord_psbl_qty"]);
        if (!ticker || quantity <= 0) return null;
        const price = firstNumber(row, ["prpr", "stck_prpr"]);
        const averagePrice = firstNumber(row, ["pchs_avg_pric"]);
        const marketValueKrw = firstNumber(row, ["evlu_amt"], quantity * price);
        return {
          id: `KR:${ticker}`,
          ticker,
          name: cleanText(row.prdt_name || row.hts_kor_isnm),
          country: "KR",
          exchange: "KRX",
          currency: "KRW",
          quantity,
          availableQuantity: firstNumber(row, ["ord_psbl_qty"], quantity),
          averagePrice,
          price,
          marketValueKrw,
          unrealizedProfitKrw: firstNumber(
            row,
            ["evlu_pfls_amt"],
            marketValueKrw - quantity * averagePrice
          )
        };
      })
      .filter(Boolean));
    const positionsValueKrw = firstNumber(
      summary,
      ["scts_evlu_amt"],
      positions.reduce((sum, position) => sum + position.marketValueKrw, 0)
    );
    const cashKrw = firstNumber(summary, ["dnca_tot_amt", "prvs_rcdl_excc_amt", "nxdy_excc_amt"]);
    return {
      country: "KR",
      currency: "KRW",
      cashKrw,
      positionsValueKrw,
      totalEquityKrw: firstNumber(summary, ["tot_evlu_amt"], cashKrw + positionsValueKrw),
      positions
    };
  }

  async getAccount() {
    const domestic = await this.getDomesticBalance();
    return {
      broker: this.name,
      environment: this.environment,
      currency: "KRW",
      cashKrw: domestic.cashKrw,
      positionsValueKrw: domestic.positionsValueKrw,
      totalEquityKrw: domestic.totalEquityKrw,
      positions: domestic.positions,
      domestic
    };
  }

  async placeOrder(order) {
    if (!order || typeof order !== "object") throw new TypeError("주문 객체가 필요합니다.");
    ensureLimitOrder(order);
    const country = cleanText(order.country).toUpperCase();
    if (country !== "KR") throw new TypeError("KIS 주문은 국내주식만 허용됩니다.");
    const side = normalizeSide(order.side);
    const ticker = validateTicker(order);
    const quantity = positiveInteger(order.quantity, "주문수량");
    const limitPrice = positivePrice(order.limitPrice, { integer: true });
    const trId =
      this.environment === "prod"
        ? side === "buy"
          ? "TTTC0012U"
          : "TTTC0011U"
        : side === "buy"
          ? "VTTC0012U"
          : "VTTC0011U";
    const requestBody = {
      CANO: this.accountNumber,
      ACNT_PRDT_CD: this.productCode,
      PDNO: ticker,
      ORD_DVSN: "00",
      ORD_QTY: quantity,
      ORD_UNPR: limitPrice,
      EXCG_ID_DVSN_CD: domesticRoute(order),
      SLL_TYPE: side === "sell" ? "01" : "",
      CNDT_PRIC: ""
    };

    const payload = await this._request(DOMESTIC_ORDER_PATH, {
      trId,
      method: "POST",
      body: requestBody,
      order: true
    });
    const output = payload.output || {};
    const brokerOrderId = cleanText(output.ODNO || output.odno);
    if (!brokerOrderId) {
      throw new KisApiError("KIS가 주문 성공 응답에 증권사 주문번호를 반환하지 않았습니다.", {
        code: "KIS_ORDER_ID_MISSING",
        ambiguous: true
      });
    }
    return {
      ...order,
      ticker,
      country,
      side,
      quantity: Number(quantity),
      limitPrice: finiteNumber(limitPrice),
      status: "submitted",
      broker: this.name,
      brokerOrderId,
      branchNumber: cleanText(
        output.KRX_FWDG_ORD_ORGNO || output.ORD_GNO_BRNO || output.ord_gno_brno
      ),
      submittedAt: new Date(this._now()).toISOString()
    };
  }

  async placeOrders(orders, { beforeEach = null, afterEach = null } = {}) {
    if (!Array.isArray(orders)) throw new TypeError("주문 목록은 배열이어야 합니다.");
    if (beforeEach !== null && typeof beforeEach !== "function") {
      throw new TypeError("KIS 주문 직전 안전 확인 함수가 올바르지 않습니다.");
    }
    if (afterEach !== null && typeof afterEach !== "function") {
      throw new TypeError("KIS 주문 직후 체크포인트 함수가 올바르지 않습니다.");
    }
    const results = [];
    for (let index = 0; index < orders.length; index += 1) {
      const order = orders[index];
      if (beforeEach) {
        try {
          await beforeEach(order, index);
        } catch (error) {
          const reason = this._safeMessage(error?.message || "KIS 주문 직전 안전 확인 실패");
          for (const remaining of orders.slice(index)) {
            results.push({
              ...remaining,
              status: "blocked",
              reason,
              errorCode: cleanText(error?.code) || "KIS_PRE_ORDER_CHECK_FAILED",
              notSent: true
            });
          }
          break;
        }
      }
      let result;
      try {
        result = await this.placeOrder(order);
      } catch (error) {
        const safeReason = this._safeMessage(error?.message || "KIS 주문 실패");
        const ambiguous = error instanceof KisApiError && error.ambiguous;
        result = {
          ...order,
          status: ambiguous ? "unknown" : "rejected",
          reason: safeReason,
          errorCode: cleanText(error?.code) || "KIS_ORDER_ERROR"
        };
      }
      results.push(result);

      if (afterEach) {
        try {
          await afterEach({ ...result }, index, results.map((item) => ({ ...item })));
        } catch (error) {
          const safeReason = this._safeMessage(
            error?.message || "KIS 주문 직후 체크포인트 저장 실패"
          );
          const rawCode = cleanText(error?.code);
          const safeCode = /^[A-Z0-9_:-]{1,100}$/.test(rawCode)
            ? rawCode
            : "KIS_AFTER_EACH_CHECKPOINT_FAILED";
          result.checkpointStatus = "failed";
          result.checkpointErrorCode = safeCode;
          result.checkpointReason = safeReason;
          for (const remaining of orders.slice(index + 1)) {
            results.push({
              ...remaining,
              status: "blocked",
              reason: safeReason,
              errorCode: safeCode,
              notSent: true
            });
          }
          break;
        }
      }

      if (result.status === "unknown") {
        for (const remaining of orders.slice(index + 1)) {
          results.push({
            ...remaining,
            status: "blocked",
            reason: "앞선 KIS 주문 결과가 불명확해 후속 주문을 전송하지 않았습니다.",
            errorCode: "KIS_BATCH_HALTED",
            notSent: true
          });
        }
        break;
      }
    }
    return results;
  }
}

export function createKisBroker(config, options) {
  return new KisBroker(config, options);
}
