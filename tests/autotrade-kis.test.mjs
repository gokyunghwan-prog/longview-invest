import assert from "node:assert/strict";
import test from "node:test";

import { KisApiError, KisBroker } from "../autotrade/brokers/kis.mjs";

const CONFIG = Object.freeze({
  environment: "vps",
  appKey: "test-app-key-1234",
  appSecret: "test-app-secret-5678",
  accountNumber: "12345678",
  productCode: "01",
  productionUrl: "https://openapi.koreainvestment.com:9443",
  virtualUrl: "https://openapivts.koreainvestment.com:29443"
});

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function tokenResponse(token = "mock-access-token", expiresIn = 86_400) {
  return jsonResponse({
    access_token: token,
    token_type: "Bearer",
    expires_in: expiresIn
  });
}

function successfulBalanceResponse() {
  return jsonResponse({ rt_cd: "0", msg_cd: "MCA00000", msg1: "정상", output1: [], output2: [{}] });
}

function successfulOrderResponse(orderNumber = "000001") {
  return jsonResponse({
    rt_cd: "0",
    msg_cd: "APBK0013",
    msg1: "주문 전송 완료",
    output: { ODNO: orderNumber, KRX_FWDG_ORD_ORGNO: "91252" }
  });
}

function requestBody(call) {
  return call.options.body ? JSON.parse(call.options.body) : null;
}

function dailyOrderRow(overrides = {}) {
  return {
    ord_dt: "20260721",
    ord_gno_brno: "91252",
    odno: "000001",
    orgn_odno: "",
    ord_dvsn_cd: "00",
    sll_buy_dvsn_cd: "02",
    pdno: "005930",
    prdt_name: "삼성전자",
    ord_qty: "2",
    ord_unpr: "70000",
    ord_tmd: "092001",
    tot_ccld_qty: "0",
    avg_prvs: "0",
    cncl_yn: "N",
    cnc_cfrm_qty: "0",
    rmn_qty: "2",
    rjct_qty: "0",
    tot_ccld_amt: "0",
    excg_id_dvsn_cd: "KRX",
    ...overrides
  };
}

function cancelableOrderRow(overrides = {}) {
  return {
    ord_gno_brno: "91252",
    odno: "000001",
    orgn_odno: "",
    ord_dvsn_cd: "00",
    sll_buy_dvsn_cd: "02",
    pdno: "005930",
    prdt_name: "삼성전자",
    ord_qty: "2",
    ord_unpr: "70000",
    ord_tmd: "092001",
    tot_ccld_qty: "0",
    psbl_qty: "2",
    excg_id_dvsn_cd: "KRX",
    ...overrides
  };
}

test("KisBroker는 생성 또는 import만으로 네트워크를 호출하지 않고 보수적 제한을 쓴다", async () => {
  let calls = 0;
  const broker = new KisBroker(CONFIG, {
    fetchImpl: async () => {
      calls += 1;
      throw new Error("호출되면 안 됨");
    }
  });

  await Promise.resolve();
  assert.equal(calls, 0);
  assert.equal(broker.minimumIntervalMs, 2_100);
  assert.equal(broker.requestTimeoutMs, 15_000);
  assert.equal(broker.maxResponseBytes, 2 * 1024 * 1024);
  assert.equal(broker.maximumBalancePages, 10);
  assert.equal(broker.maximumBalanceRows, 5_000);
  assert.equal(broker.environment, "vps");
});

test("동시 요청은 OAuth 토큰을 한 번만 발급하고 만료 전까지 재사용한다", async () => {
  let now = 0;
  let tokenCalls = 0;
  let balanceCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/tokenP")) {
      tokenCalls += 1;
      return tokenResponse(`token-${tokenCalls}`, 120);
    }
    balanceCalls += 1;
    return successfulBalanceResponse();
  };
  const broker = new KisBroker(CONFIG, {
    fetchImpl,
    now: () => now,
    minimumIntervalMs: 0
  });

  await Promise.all([broker.getDomesticBalance(), broker.getDomesticBalance()]);
  assert.equal(tokenCalls, 1);
  assert.equal(balanceCalls, 2);

  now = 30_000;
  await broker.getDomesticBalance();
  assert.equal(tokenCalls, 1);

  now = 61_000;
  await broker.getDomesticBalance();
  assert.equal(tokenCalls, 2, "만료 안전 여유시간에 들어오면 토큰을 갱신해야 한다");
});

test("영구 캐시의 유효한 KIS 토큰을 쓰고 OAuth 재발급을 생략한다", async () => {
  const calls = [];
  let saves = 0;
  const broker = new KisBroker(CONFIG, {
    now: () => 1_000,
    minimumIntervalMs: 0,
    tokenCache: {
      async load() {
        return { accessToken: "durable-token", expiresAt: 300_000 };
      },
      async save() {
        saves += 1;
      }
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.doesNotMatch(url, /oauth2\/tokenP$/);
      return successfulBalanceResponse();
    }
  });

  await broker.getDomesticBalance();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.authorization, "Bearer durable-token");
  assert.equal(saves, 0);
});

test("새 KIS 토큰의 영구 캐시 저장 실패는 후속 API 호출 전에 닫힌다", async () => {
  let tokenCalls = 0;
  let balanceCalls = 0;
  const broker = new KisBroker(CONFIG, {
    now: () => 1_000,
    minimumIntervalMs: 0,
    tokenCache: {
      async load() {
        return null;
      },
      async save() {
        throw new Error("durable cache unavailable");
      }
    },
    fetchImpl: async (url) => {
      if (url.endsWith("/oauth2/tokenP")) {
        tokenCalls += 1;
        return tokenResponse("must-not-remain-in-memory");
      }
      balanceCalls += 1;
      return successfulBalanceResponse();
    }
  });

  await assert.rejects(broker.getDomesticBalance(), {
    code: "KIS_TOKEN_CACHE_SAVE_FAILED"
  });
  assert.equal(tokenCalls, 1);
  assert.equal(balanceCalls, 0);
  assert.equal(broker.accessToken, "");
});

test("KIS 휴장일 조회는 요청일의 개장·거래 여부를 함께 확인한다", async () => {
  const calls = [];
  const broker = new KisBroker(CONFIG, {
    minimumIntervalMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/oauth2/tokenP")) return tokenResponse("holiday-token");
      return jsonResponse({
        rt_cd: "0",
        msg_cd: "MCA00000",
        msg1: "정상",
        output: [
          {
            bass_dt: "20260724",
            bzdy_yn: "Y",
            tr_day_yn: "Y",
            opnd_yn: "Y",
            sttl_day_yn: "Y"
          }
        ]
      });
    }
  });

  const status = await broker.getTradingDayStatus("20260724");

  assert.deepEqual(status, {
    businessDate: "20260724",
    businessDay: true,
    tradingDay: true,
    marketOpen: true,
    settlementDay: true,
    canPlaceOrders: true
  });
  const request = calls[1];
  const url = new URL(request.url);
  assert.equal(url.pathname, "/uapi/domestic-stock/v1/quotations/chk-holiday");
  assert.equal(url.searchParams.get("BASS_DT"), "20260724");
  assert.equal(request.options.headers.tr_id, "CTCA0903R");
});

test("KIS 휴장일 응답에 요청일 또는 Y/N 필드가 없으면 주문 가능으로 추정하지 않는다", async () => {
  for (const output of [
    [{ bass_dt: "20260723", bzdy_yn: "Y", tr_day_yn: "Y", opnd_yn: "Y" }],
    [{ bass_dt: "20260724", bzdy_yn: "Y", tr_day_yn: "Y", opnd_yn: "" }]
  ]) {
    const broker = new KisBroker(CONFIG, {
      minimumIntervalMs: 0,
      fetchImpl: async (url) =>
        url.endsWith("/oauth2/tokenP")
          ? tokenResponse("holiday-invalid-token")
          : jsonResponse({
              rt_cd: "0",
              msg_cd: "MCA00000",
              msg1: "정상",
              output
            })
    });
    await assert.rejects(broker.getTradingDayStatus("20260724"), {
      code: "KIS_TRADING_DAY_INVALID"
    });
  }
});

test("prod 국내 지정가 매수·매도는 올바른 URL, 헤더, TR ID와 대문자 Body를 쓴다", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("prod-token");
    return successfulOrderResponse(String(calls.length).padStart(6, "0"));
  };
  const broker = new KisBroker(
    { ...CONFIG, environment: "prod" },
    { fetchImpl, minimumIntervalMs: 0, now: () => 1_000 }
  );

  const results = await broker.placeOrders([
    {
      id: "KR:005930",
      ticker: "005930",
      name: "삼성전자",
      country: "KR",
      exchange: "KOSPI",
      sector: "반도체",
      side: "buy",
      quantity: 2,
      limitPrice: 70_000,
      currency: "KRW"
    },
    {
      id: "KR:005930",
      ticker: "005930",
      name: "삼성전자",
      country: "KR",
      exchange: "SOR",
      sector: "반도체",
      side: "sell",
      quantity: 1,
      limitPrice: 71_000,
      currency: "KRW"
    }
  ]);

  assert.deepEqual(results.map((result) => result.status), ["submitted", "submitted"]);
  assert.equal(calls[0].url, "https://openapi.koreainvestment.com:9443/oauth2/tokenP");
  const orderCalls = calls.slice(1);
  assert.deepEqual(orderCalls.map((call) => call.options.headers.tr_id), ["TTTC0012U", "TTTC0011U"]);
  assert.ok(orderCalls.every((call) => call.url.endsWith("/uapi/domestic-stock/v1/trading/order-cash")));
  assert.ok(orderCalls.every((call) => call.options.headers.authorization === "Bearer prod-token"));
  assert.ok(orderCalls.every((call) => call.options.headers.custtype === "P"));
  assert.deepEqual(requestBody(orderCalls[0]), {
    CANO: "12345678",
    ACNT_PRDT_CD: "01",
    PDNO: "005930",
    ORD_DVSN: "00",
    ORD_QTY: "2",
    ORD_UNPR: "70000",
    EXCG_ID_DVSN_CD: "KRX",
    SLL_TYPE: "",
    CNDT_PRIC: ""
  });
  assert.equal(requestBody(orderCalls[1]).EXCG_ID_DVSN_CD, "SOR");
  assert.equal(requestBody(orderCalls[1]).SLL_TYPE, "01");
  assert.ok(calls.every((call) => !call.url.includes("/uapi/hashkey")));
});

test("국내주식이 아닌 주문은 네트워크 호출 전에 거절한다", async () => {
  let calls = 0;
  const broker = new KisBroker(CONFIG, {
    fetchImpl: async () => {
      calls += 1;
      return tokenResponse();
    }
  });

  await assert.rejects(
    broker.placeOrder({
      ticker: "7203",
      country: "JP",
      side: "buy",
      quantity: 1,
      limitPrice: 20_000
    }),
    /국내주식/
  );
  assert.equal(calls, 0);
});

test("getQuotes는 공식 국내 현재가 API를 호출하고 주문용 최신 가격을 정규화한다", async () => {
  const calls = [];
  const now = Date.UTC(2026, 6, 19, 7, 30, 0);
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("quote-token");
    if (url.includes("/inquire-daily-price")) {
      return jsonResponse({
        rt_cd: "0",
        msg_cd: "MCA00000",
        msg1: "정상",
        output: [
          { stck_bsop_date: "20260718", stck_clpr: "69,500" },
          { stck_bsop_date: "20260719", stck_clpr: "70,100" }
        ]
      });
    }
    return jsonResponse({
      rt_cd: "0",
      msg_cd: "MCA00000",
      msg1: "정상",
      output: {
        stck_prpr: "70,100",
        stck_sdpr: "69,500",
        prdy_vrss: "600",
        prdy_ctrt: "0.86",
        acml_vol: "12,345,678"
      }
    });
  };
  const broker = new KisBroker(CONFIG, {
    fetchImpl,
    minimumIntervalMs: 0,
    now: () => now
  });

  const quotes = await broker.getQuotes([
    {
      id: "KR:005930",
      ticker: "005930",
      name: "삼성전자",
      country: "KR",
      exchange: "KOSPI"
    }
  ]);

  assert.deepEqual(
    quotes.map(({ id, price, currency, current, source }) => ({
      id,
      price,
      currency,
      current,
      source
    })),
    [{ id: "KR:005930", price: 70_100, currency: "KRW", current: true, source: "KIS" }]
  );
  assert.equal(quotes[0].asOf, "2026-07-19T07:30:00.000Z");
  assert.equal(quotes[0].marketDate, "20260719");

  const quoteCalls = calls.slice(1);
  assert.equal(quoteCalls.length, 2);
  assert.equal(quoteCalls[0].options.headers.tr_id, "FHKST01010100");
  assert.match(quoteCalls[0].url, /FID_COND_MRKT_DIV_CODE=J/);
  assert.match(quoteCalls[0].url, /FID_INPUT_ISCD=005930/);
  assert.equal(quoteCalls[1].options.headers.tr_id, "FHKST01010400");
  assert.match(quoteCalls[1].url, /inquire-daily-price/);
  assert.match(quoteCalls[1].url, /FID_PERIOD_DIV_CODE=D/);
  assert.match(quoteCalls[1].url, /FID_ORG_ADJ_PRC=1/);
});

test("getQuotes는 공식 일자별 시세에서 영업일을 확인하지 못하면 fail-closed한다", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("quote-token");
    if (url.includes("/inquire-daily-price")) {
      return jsonResponse({ rt_cd: "0", output: [] });
    }
    return jsonResponse({ rt_cd: "0", output: { stck_prpr: "70100" } });
  };
  const broker = new KisBroker(CONFIG, {
    fetchImpl,
    minimumIntervalMs: 0,
    now: () => Date.UTC(2026, 6, 19, 7, 30, 0)
  });

  await assert.rejects(
    broker.getQuotes([{ ticker: "005930", country: "KR", exchange: "KOSPI" }]),
    (error) => error?.code === "KIS_QUOTE_MARKET_DATE_MISSING"
  );
});

test("getQuotes는 같은 시장의 오늘 영업일 확인을 안전하게 재사용한다", async () => {
  let currentPriceCalls = 0;
  let dailyPriceCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("quote-cache-token");
    if (url.includes("/inquire-daily-price")) {
      dailyPriceCalls += 1;
      return jsonResponse({ rt_cd: "0", output: [{ stck_bsop_date: "20260719" }] });
    }
    currentPriceCalls += 1;
    return jsonResponse({
      rt_cd: "0",
      output: { stck_prpr: currentPriceCalls === 1 ? "70100" : "12000" }
    });
  };
  const broker = new KisBroker(CONFIG, {
    fetchImpl,
    minimumIntervalMs: 0,
    now: () => Date.UTC(2026, 6, 19, 7, 30, 0)
  });

  const quotes = await broker.getQuotes([
    { id: "KR:005930", ticker: "005930", country: "KR", exchange: "KOSPI" },
    { id: "KR:000660", ticker: "000660", country: "KR", exchange: "KOSPI" }
  ]);

  assert.equal(quotes.length, 2);
  assert.equal(currentPriceCalls, 2);
  assert.equal(dailyPriceCalls, 1);
  assert.ok(quotes.every((quote) => quote.marketDate === "20260719"));
});

test("읽기 전용 조회만 EGW00201을 지수 백오프로 제한 재시도한다", async () => {
  const waits = [];
  let readCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("rate-limit-token");
    readCalls += 1;
    if (readCalls < 3) {
      return jsonResponse({
        rt_cd: "1",
        msg_cd: readCalls === 1 ? "EGW00201" : "LEDGER_RATE_LIMIT",
        msg1:
          readCalls === 1
            ? "초당 거래건수를 초과하였습니다."
            : "원장에서 허용 가능한 초당 거래건수를 초과하였습니다."
      });
    }
    return jsonResponse({
      rt_cd: "0",
      output: { nrcvb_buy_amt: "100000", nrcvb_buy_qty: "1" }
    });
  };
  const broker = new KisBroker(CONFIG, {
    fetchImpl,
    minimumIntervalMs: 0,
    readRateLimitRetries: 2,
    readRateLimitBackoffMs: 10,
    sleep: async (milliseconds) => waits.push(milliseconds)
  });

  const result = await broker.getBuyableOrder({
    ticker: "005930",
    country: "KR",
    quantity: 1,
    limitPrice: 70_000
  });

  assert.equal(result.sufficient, true);
  assert.equal(readCalls, 3);
  assert.deepEqual(waits, [10, 20]);
});

test("실제 주문 요청은 EGW00201이어도 자동 재시도하지 않는다", async () => {
  let orderCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("order-rate-token");
    orderCalls += 1;
    return jsonResponse({
      rt_cd: "1",
      msg_cd: "EGW00201",
      msg1: "초당 거래건수를 초과하였습니다."
    });
  };
  const broker = new KisBroker(CONFIG, {
    fetchImpl,
    minimumIntervalMs: 0,
    readRateLimitRetries: 3,
    readRateLimitBackoffMs: 1
  });

  await assert.rejects(
    broker.placeOrder({
      ticker: "005930",
      country: "KR",
      exchange: "KOSPI",
      side: "buy",
      quantity: 1,
      limitPrice: 70_000
    }),
    (error) => error?.code === "EGW00201"
  );
  assert.equal(orderCalls, 1);
});

test("시장가 주문은 토큰이나 주문 API를 부르기 전에 거절한다", async () => {
  let calls = 0;
  const broker = new KisBroker(CONFIG, {
    minimumIntervalMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return tokenResponse();
    }
  });

  await assert.rejects(
    broker.placeOrder({
      ticker: "005930",
      country: "KR",
      exchange: "KOSPI",
      side: "buy",
      quantity: 1,
      limitPrice: 100,
      orderType: "market"
    }),
    /지정가/
  );
  assert.equal(calls, 0);
});

test("HTTP 200이어도 rt_cd가 0이 아니면 오류이며 비밀값은 노출하지 않는다", async () => {
  const leakedToken = "very-secret-access-token";
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse(leakedToken);
    return jsonResponse({
      rt_cd: "1",
      msg_cd: "APBK0918",
      msg1: `${CONFIG.appSecret} ${CONFIG.accountNumber} ${leakedToken} 주문 거절`
    });
  };
  const broker = new KisBroker(CONFIG, { fetchImpl, minimumIntervalMs: 0 });

  await assert.rejects(
    broker.placeOrder({
      ticker: "005930",
      country: "KR",
      exchange: "KOSPI",
      side: "buy",
      quantity: 1,
      limitPrice: 70_000
    }),
    (error) => {
      assert.ok(error instanceof KisApiError);
      assert.equal(error.code, "APBK0918");
      assert.equal(error.status, 200);
      assert.equal(error.ambiguous, false);
      assert.ok(!error.message.includes(CONFIG.appSecret));
      assert.ok(!error.message.includes(CONFIG.accountNumber));
      assert.ok(!error.message.includes(leakedToken));
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    }
  );
});

test("성공 응답에 증권사 주문번호가 없으면 unknown으로 두고 남은 묶음은 전송하지 않는다", async () => {
  let orderCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("missing-id-token");
    orderCalls += 1;
    return jsonResponse({
      rt_cd: "0",
      msg_cd: "APBK0013",
      msg1: "주문 전송 완료",
      output: {}
    });
  };
  const broker = new KisBroker(CONFIG, { fetchImpl, minimumIntervalMs: 0 });
  const orders = [
    {
      ticker: "005930",
      country: "KR",
      exchange: "KOSPI",
      side: "buy",
      quantity: 1,
      limitPrice: 70_000
    },
    {
      ticker: "000660",
      country: "KR",
      exchange: "KOSPI",
      side: "buy",
      quantity: 1,
      limitPrice: 200_000
    }
  ];

  const results = await broker.placeOrders(orders);

  assert.equal(orderCalls, 1);
  assert.deepEqual(results.map((result) => result.status), ["unknown", "blocked"]);
  assert.equal(results[0].errorCode, "KIS_ORDER_ID_MISSING");
  assert.equal(results[1].errorCode, "KIS_BATCH_HALTED");
  assert.equal(results[1].notSent, true);
});

test("beforeEach 안전 확인을 매 주문 직전에 기다리고 실패 시 현재·후속 주문을 모두 막는다", async () => {
  let orderCalls = 0;
  const checked = [];
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("before-each-token");
    orderCalls += 1;
    return successfulOrderResponse(`00000${orderCalls}`);
  };
  const broker = new KisBroker(CONFIG, { fetchImpl, minimumIntervalMs: 0 });
  const orders = [
    {
      ticker: "005930",
      country: "KR",
      exchange: "KOSPI",
      side: "buy",
      quantity: 1,
      limitPrice: 70_000
    },
    {
      ticker: "000660",
      country: "KR",
      exchange: "KOSPI",
      side: "buy",
      quantity: 1,
      limitPrice: 200_000
    },
    {
      ticker: "035420",
      country: "KR",
      exchange: "KOSPI",
      side: "buy",
      quantity: 1,
      limitPrice: 250_000
    }
  ];

  const results = await broker.placeOrders(orders, {
    beforeEach: async (order, index) => {
      checked.push(`${index}:${order.ticker}`);
      if (index === 1) {
        const error = new Error("kill switch enabled");
        error.code = "KILL_SWITCH_ACTIVE";
        throw error;
      }
    }
  });

  assert.deepEqual(checked, ["0:005930", "1:000660"]);
  assert.equal(orderCalls, 1);
  assert.deepEqual(results.map((result) => result.status), ["submitted", "blocked", "blocked"]);
  assert.equal(results[1].errorCode, "KILL_SWITCH_ACTIVE");
  assert.ok(results.slice(1).every((result) => result.notSent === true));
});

test("beforeSubmit 재확인은 실제 주문 API 호출 바로 전에 실패 폐쇄한다", async () => {
  let networkCalls = 0;
  const broker = new KisBroker(CONFIG, {
    fetchImpl: async () => {
      networkCalls += 1;
      return successfulOrderResponse("should-not-submit");
    },
    minimumIntervalMs: 0
  });
  const stages = [];
  const orders = [
    {
      ticker: "005930",
      country: "KR",
      exchange: "KOSPI",
      side: "buy",
      quantity: 1,
      limitPrice: 70_000
    },
    {
      ticker: "000660",
      country: "KR",
      exchange: "KOSPI",
      side: "buy",
      quantity: 1,
      limitPrice: 200_000
    }
  ];

  const results = await broker.placeOrders(orders, {
    beforeEach: async () => stages.push("preflight"),
    beforeSubmit: async () => {
      stages.push("submit-fence");
      const error = new Error("trusted clock closed");
      error.code = "LIVE_ORDER_WINDOW_CLOSED";
      throw error;
    }
  });

  assert.deepEqual(stages, ["preflight", "submit-fence"]);
  assert.equal(networkCalls, 0);
  assert.deepEqual(results.map((result) => result.status), ["blocked", "blocked"]);
  assert.ok(results.every((result) => result.notSent === true));
  assert.ok(results.every((result) => result.errorCode === "LIVE_ORDER_WINDOW_CLOSED"));
});

test("주문 전송 중 네트워크 오류는 재주문 위험이 있어 unknown으로 반환하고 비밀을 가린다", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("network-token");
    throw new Error(`socket closed ${CONFIG.appKey} ${CONFIG.appSecret}`);
  };
  const broker = new KisBroker(CONFIG, { fetchImpl, minimumIntervalMs: 0 });
  const [result] = await broker.placeOrders([
    {
      ticker: "005930",
      country: "KR",
      exchange: "KOSPI",
      side: "buy",
      quantity: 1,
      limitPrice: 70_000
    }
  ]);

  assert.equal(result.status, "unknown");
  assert.equal(result.errorCode, "KIS_NETWORK_ERROR");
  assert.ok(!result.reason.includes(CONFIG.appKey));
  assert.ok(!result.reason.includes(CONFIG.appSecret));
});

test("주문 요청 제한시간이 지나면 fetch를 중단하고 재시도 없이 unknown으로 남긴다", async () => {
  let orderCalls = 0;
  let orderSignal;
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("timeout-token");
    orderCalls += 1;
    orderSignal = options.signal;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => {
          const error = new Error("request aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true }
      );
    });
  };
  const broker = new KisBroker(CONFIG, {
    fetchImpl,
    minimumIntervalMs: 0,
    requestTimeoutMs: 10
  });

  const [result] = await broker.placeOrders([
    {
      ticker: "005930",
      country: "KR",
      exchange: "KOSPI",
      side: "buy",
      quantity: 1,
      limitPrice: 70_000
    }
  ]);

  assert.equal(orderCalls, 1, "모호한 주문을 자동 재시도하면 안 된다");
  assert.equal(orderSignal.aborted, true);
  assert.equal(result.status, "unknown");
  assert.equal(result.errorCode, "KIS_REQUEST_TIMEOUT");
});

test("KIS 응답 본문이 최대크기를 넘으면 전체 JSON을 처리하지 않고 거절한다", async () => {
  let balanceCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("size-token");
    balanceCalls += 1;
    return jsonResponse({
      rt_cd: "0",
      msg_cd: "MCA00000",
      msg1: "x".repeat(1_024),
      output1: [],
      output2: [{}]
    });
  };
  const broker = new KisBroker(CONFIG, {
    fetchImpl,
    minimumIntervalMs: 0,
    maxResponseBytes: 256
  });

  await assert.rejects(broker.getDomesticBalance(), (error) => {
    assert.ok(error instanceof KisApiError);
    assert.equal(error.code, "KIS_RESPONSE_TOO_LARGE");
    assert.equal(error.ambiguous, false);
    return true;
  });
  assert.equal(balanceCalls, 1);
});

test("국내 잔고는 tr_cont와 CTX_AREA 토큰으로 전 페이지를 읽고 경계 중복을 한 번만 센다", async () => {
  const calls = [];
  let balancePage = 0;
  const samsung = {
    pdno: "005930",
    prdt_name: "삼성전자",
    hldg_qty: "10",
    ord_psbl_qty: "8",
    pchs_avg_pric: "60,000",
    prpr: "70,000",
    evlu_amt: "700,000",
    evlu_pfls_amt: "100,000"
  };
  const summary = {
    dnca_tot_amt: "300,000",
    scts_evlu_amt: "1,700,000",
    tot_evlu_amt: "2,000,000"
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("domestic-pages-token");
    balancePage += 1;
    if (balancePage === 1) {
      return jsonResponse(
        {
          rt_cd: "0",
          msg_cd: "MCA00000",
          msg1: "정상",
          ctx_area_fk100: "FK100-PAGE-2",
          ctx_area_nk100: "NK100-PAGE-2",
          output1: [samsung],
          output2: [summary]
        },
        { headers: { tr_cont: "F" } }
      );
    }
    return jsonResponse({
      rt_cd: "0",
      msg_cd: "MCA00000",
      msg1: "정상",
      output1: [
        samsung,
        {
          pdno: "000660",
          prdt_name: "SK하이닉스",
          hldg_qty: "5",
          ord_psbl_qty: "5",
          pchs_avg_pric: "180,000",
          prpr: "200,000",
          evlu_amt: "1,000,000",
          evlu_pfls_amt: "100,000"
        }
      ],
      output2: [summary]
    });
  };
  const broker = new KisBroker(CONFIG, { fetchImpl, minimumIntervalMs: 0 });

  const balance = await broker.getDomesticBalance();

  assert.equal(balancePage, 2);
  assert.deepEqual(balance.positions.map((position) => position.ticker), ["005930", "000660"]);
  assert.equal(balance.positions.length, 2);
  const pageCalls = calls.slice(1);
  assert.equal(pageCalls[0].options.headers.tr_cont, "");
  assert.equal(pageCalls[1].options.headers.tr_cont, "N");
  const secondUrl = new URL(pageCalls[1].url);
  assert.equal(secondUrl.searchParams.get("CTX_AREA_FK100"), "FK100-PAGE-2");
  assert.equal(secondUrl.searchParams.get("CTX_AREA_NK100"), "NK100-PAGE-2");
});

test("잔고 연속조회는 페이지·행 상한과 반복 토큰을 만나면 불완전한 잔고를 반환하지 않는다", async (t) => {
  const continuingPage = (token) =>
    jsonResponse(
      {
        rt_cd: "0",
        msg_cd: "MCA00000",
        msg1: "정상",
        ctx_area_fk100: token,
        ctx_area_nk100: `${token}-NK`,
        output1: [{ pdno: "005930", hldg_qty: "1", ord_psbl_qty: "1", prpr: "70000" }],
        output2: []
      },
      { headers: { tr_cont: "F" } }
    );

  await t.test("페이지 상한", async () => {
    const fetchImpl = async (url) =>
      url.endsWith("/oauth2/tokenP") ? tokenResponse("page-limit-token") : continuingPage("NEXT");
    const broker = new KisBroker(CONFIG, {
      fetchImpl,
      minimumIntervalMs: 0,
      maximumBalancePages: 1
    });
    await assert.rejects(broker.getDomesticBalance(), { code: "KIS_BALANCE_PAGE_LIMIT" });
  });

  await t.test("행 상한", async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith("/oauth2/tokenP")) return tokenResponse("row-limit-token");
      return jsonResponse({
        rt_cd: "0",
        msg_cd: "MCA00000",
        msg1: "정상",
        output1: [
          { pdno: "005930", hldg_qty: "1", ord_psbl_qty: "1", prpr: "70000" },
          { pdno: "000660", hldg_qty: "1", ord_psbl_qty: "1", prpr: "200000" }
        ],
        output2: []
      });
    };
    const broker = new KisBroker(CONFIG, {
      fetchImpl,
      minimumIntervalMs: 0,
      maximumBalanceRows: 1
    });
    await assert.rejects(broker.getDomesticBalance(), { code: "KIS_BALANCE_SIZE_LIMIT" });
  });

  await t.test("반복 토큰", async () => {
    let page = 0;
    const fetchImpl = async (url) => {
      if (url.endsWith("/oauth2/tokenP")) return tokenResponse("loop-token");
      page += 1;
      return continuingPage("SAME");
    };
    const broker = new KisBroker(CONFIG, { fetchImpl, minimumIntervalMs: 0 });
    await assert.rejects(broker.getDomesticBalance(), {
      code: "KIS_BALANCE_CONTINUATION_LOOP"
    });
    assert.equal(page, 2);
  });
});

test("국내 잔고를 숫자로 정규화하고 계좌번호 원문은 반환하지 않는다", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse();
    return jsonResponse({
      rt_cd: "0",
      msg_cd: "MCA00000",
      msg1: "정상",
      output1: [
        {
          pdno: "005930",
          prdt_name: "삼성전자",
          hldg_qty: "10",
          ord_psbl_qty: "8",
          pchs_avg_pric: "60,000",
          prpr: "70,000",
          evlu_amt: "700,000",
          evlu_pfls_amt: "100,000"
        }
      ],
      output2: [
        {
          dnca_tot_amt: "300,000",
          scts_evlu_amt: "700,000",
          tot_evlu_amt: "1,000,000"
        }
      ]
    });
  };
  const broker = new KisBroker(CONFIG, {
    fetchImpl,
    minimumIntervalMs: 0
  });
  const account = await broker.getAccount();

  assert.equal(account.cashKrw, 300_000);
  assert.equal(account.totalEquityKrw, 1_000_000);
  assert.equal(account.positions[0].ticker, "005930");
  assert.equal(account.positions[0].quantity, 10);
  assert.equal(account.positions[0].averagePrice, 60_000);
  assert.equal(account.positions[0].marketValueKrw, 700_000);
  assert.ok(!JSON.stringify(account).includes(CONFIG.accountNumber));
});

test("매수가능조회는 시장가 계산으로 미수 없는 금액·수량만 정규화한다", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("buyable-token");
    return jsonResponse({
      rt_cd: "0",
      msg_cd: "MCA00000",
      msg1: "정상",
      output: {
        ord_psbl_cash: "101,000",
        nrcvb_buy_amt: "99,500",
        nrcvb_buy_qty: "1",
        max_buy_amt: "500,000",
        max_buy_qty: "7"
      }
    });
  };
  const broker = new KisBroker(CONFIG, { fetchImpl, minimumIntervalMs: 0 });

  const buyable = await broker.getBuyableOrder({
    ticker: "005930",
    country: "KR",
    quantity: 2,
    limitPrice: 70_000
  });

  assert.deepEqual(buyable, {
    ticker: "005930",
    country: "KR",
    currency: "KRW",
    limitPrice: 70_000,
    noReceivableAmountKrw: 99_500,
    noReceivableQuantity: 1,
    requestedQuantity: 2,
    sufficient: false,
    calculationOrderDivision: "01"
  });
  const call = calls[1];
  assert.ok(call.url.includes("/uapi/domestic-stock/v1/trading/inquire-psbl-order"));
  assert.equal(call.options.headers.tr_id, "VTTC8908R");
  const query = new URL(call.url).searchParams;
  assert.equal(query.get("PDNO"), "005930");
  assert.equal(query.get("ORD_UNPR"), "70000");
  assert.equal(query.get("ORD_DVSN"), "01");
  assert.equal(query.get("CMA_EVLU_AMT_ICLD_YN"), "N");
  assert.equal(query.get("OVRS_ICLD_YN"), "N");
});

test("매수가능조회에 미수 없는 필드가 없거나 잘못되면 0으로 추정하지 않는다", async (t) => {
  for (const [name, output] of [
    ["누락", { nrcvb_buy_qty: "1" }],
    ["음수", { nrcvb_buy_amt: "-1", nrcvb_buy_qty: "1" }],
    ["비정수", { nrcvb_buy_amt: "100000", nrcvb_buy_qty: "1.5" }]
  ]) {
    await t.test(name, async () => {
      const fetchImpl = async (url) =>
        url.endsWith("/oauth2/tokenP")
          ? tokenResponse(`invalid-buyable-${name}`)
          : jsonResponse({ rt_cd: "0", output });
      const broker = new KisBroker(CONFIG, { fetchImpl, minimumIntervalMs: 0 });
      await assert.rejects(
        broker.getBuyableOrder({ ticker: "005930", limitPrice: 70_000 }),
        { code: "KIS_BUYABLE_INVALID" }
      );
    });
  }
});

test("당일 주문체결조회는 KST 당일·현금주문만 전 페이지 조회하고 경계 중복을 제거한다", async () => {
  const calls = [];
  let page = 0;
  const first = dailyOrderRow();
  const second = dailyOrderRow({
    ord_gno_brno: "91253",
    odno: "000002",
    pdno: "000660",
    prdt_name: "SK하이닉스",
    ord_qty: "2",
    ord_unpr: "200000",
    tot_ccld_qty: "1",
    avg_prvs: "199500",
    rmn_qty: "1",
    tot_ccld_amt: "199500"
  });
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("daily-orders-token");
    page += 1;
    if (page === 1) {
      return jsonResponse(
        {
          rt_cd: "0",
          ctx_area_fk100: "DAILY-FK-2",
          ctx_area_nk100: "DAILY-NK-2",
          output1: [first],
          output2: { tot_ord_qty: "2" }
        },
        { headers: { tr_cont: "F" } }
      );
    }
    return jsonResponse({ rt_cd: "0", output1: [first, second], output2: {} });
  };
  const broker = new KisBroker(CONFIG, {
    fetchImpl,
    minimumIntervalMs: 0,
    now: () => Date.UTC(2026, 6, 21, 0, 30)
  });

  const result = await broker.getDailyOrders({ side: "buy", fill: "all", route: "ALL" });

  assert.equal(result.pages, 2);
  assert.equal(result.orders.length, 2);
  assert.deepEqual(Object.keys(result).sort(), ["orders", "pages"]);
  assert.deepEqual(Object.keys(result.orders[0]), [
    "brokerOrderId",
    "branchNumber",
    "ticker",
    "side",
    "quantity",
    "filledQuantity",
    "remainingQuantity",
    "canceledQuantity",
    "limitPrice",
    "averageFillPrice",
    "orderDate",
    "orderTime",
    "status"
  ]);
  assert.equal(result.orders[0].orderDate, "20260721");
  assert.deepEqual(
    result.orders.map(({ brokerOrderId, ticker, status, filledQuantity, remainingQuantity }) => ({
      brokerOrderId,
      ticker,
      status,
      filledQuantity,
      remainingQuantity
    })),
    [
      {
        brokerOrderId: "000001",
        ticker: "005930",
        status: "open",
        filledQuantity: 0,
        remainingQuantity: 2
      },
      {
        brokerOrderId: "000002",
        ticker: "000660",
        status: "partial",
        filledQuantity: 1,
        remainingQuantity: 1
      }
    ]
  );
  const pageCalls = calls.slice(1);
  assert.ok(pageCalls.every((call) => call.options.headers.tr_id === "VTTC0081R"));
  const firstQuery = new URL(pageCalls[0].url).searchParams;
  assert.equal(firstQuery.get("INQR_STRT_DT"), "20260721");
  assert.equal(firstQuery.get("INQR_END_DT"), "20260721");
  assert.equal(firstQuery.get("SLL_BUY_DVSN_CD"), "02");
  assert.equal(firstQuery.get("CCLD_DVSN"), "00");
  assert.equal(firstQuery.get("INQR_DVSN_3"), "01");
  assert.equal(firstQuery.get("EXCG_ID_DVSN_CD"), "ALL");
  const secondQuery = new URL(pageCalls[1].url).searchParams;
  assert.equal(secondQuery.get("CTX_AREA_FK100"), "DAILY-FK-2");
  assert.equal(secondQuery.get("CTX_AREA_NK100"), "DAILY-NK-2");
  assert.equal(pageCalls[1].options.headers.tr_cont, "N");
  assert.ok(!JSON.stringify(result).includes(CONFIG.accountNumber));
});

test("getDailyOrders는 조정용 고정 상태 집합으로 체결·취소 조합을 분류한다", async () => {
  const rows = [
    dailyOrderRow({ odno: "000011" }),
    dailyOrderRow({ odno: "000012", tot_ccld_qty: "1", rmn_qty: "1" }),
    dailyOrderRow({ odno: "000013", tot_ccld_qty: "2", rmn_qty: "0" }),
    dailyOrderRow({
      odno: "000014",
      cncl_yn: "Y",
      cnc_cfrm_qty: "2",
      rmn_qty: "0"
    }),
    dailyOrderRow({
      odno: "000015",
      tot_ccld_qty: "1",
      avg_prvs: "70000",
      cncl_yn: "Y",
      cnc_cfrm_qty: "1",
      rmn_qty: "0"
    }),
    dailyOrderRow({ odno: "000016", rjct_qty: "2", rmn_qty: "0" }),
    dailyOrderRow({ odno: "000017", rmn_qty: "0" }),
    dailyOrderRow({ odno: "000018", ord_qty: "0", rmn_qty: "0" })
  ];
  const fetchImpl = async (url) =>
    url.endsWith("/oauth2/tokenP")
      ? tokenResponse("daily-status-token")
      : jsonResponse({ rt_cd: "0", output1: rows, output2: {} });
  const broker = new KisBroker(CONFIG, { fetchImpl, minimumIntervalMs: 0 });

  const result = await broker.getDailyOrders();

  assert.deepEqual(
    result.orders.map((order) => order.status),
    [
      "open",
      "partial",
      "filled",
      "canceled",
      "partial_canceled",
      "rejected",
      "submitted",
      "unknown"
    ]
  );
});

test("getDailyOrders는 최대 7일의 명시적 주문조회 날짜 범위를 전달한다", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith("/oauth2/tokenP")
      ? tokenResponse("daily-date-range-token")
      : jsonResponse({ rt_cd: "0", output1: [], output2: {} });
  };
  const broker = new KisBroker(CONFIG, { fetchImpl, minimumIntervalMs: 0 });

  await broker.getDailyOrders({ startDate: "20260715", endDate: "20260721" });

  const query = new URL(calls[1].url).searchParams;
  assert.equal(query.get("INQR_STRT_DT"), "20260715");
  assert.equal(query.get("INQR_END_DT"), "20260721");
});

test("getDailyOrders는 잘못되거나 7일을 넘는 날짜 범위를 네트워크 전에 차단한다", async (t) => {
  for (const [name, options] of [
    ["형식 오류", { startDate: "2026-07-20", endDate: "20260721" }],
    ["존재하지 않는 날짜", { startDate: "20260230", endDate: "20260301" }],
    ["역전된 범위", { startDate: "20260721", endDate: "20260720" }],
    ["8일 범위", { startDate: "20260714", endDate: "20260721" }]
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      const broker = new KisBroker(CONFIG, {
        fetchImpl: async () => {
          calls += 1;
          return tokenResponse();
        },
        minimumIntervalMs: 0
      });
      await assert.rejects(broker.getDailyOrders(options), TypeError);
      assert.equal(calls, 0);
    });
  }
});

test("당일 주문 연속조회는 충돌 중복과 페이지 상한을 안전 오류로 처리한다", async (t) => {
  await t.test("충돌 중복", async () => {
    let page = 0;
    const fetchImpl = async (url) => {
      if (url.endsWith("/oauth2/tokenP")) return tokenResponse("daily-conflict-token");
      page += 1;
      if (page === 1) {
        return jsonResponse(
          {
            rt_cd: "0",
            ctx_area_fk100: "NEXT",
            ctx_area_nk100: "NEXT-NK",
            output1: [dailyOrderRow()],
            output2: {}
          },
          { headers: { tr_cont: "F" } }
        );
      }
      return jsonResponse({
        rt_cd: "0",
        output1: [dailyOrderRow({ rmn_qty: "1" })],
        output2: {}
      });
    };
    const broker = new KisBroker(CONFIG, { fetchImpl, minimumIntervalMs: 0 });
    await assert.rejects(broker.getTodayOrders(), {
      code: "KIS_DAILY_ORDER_DUPLICATE_CONFLICT"
    });
  });

  await t.test("페이지 상한", async () => {
    const fetchImpl = async (url) =>
      url.endsWith("/oauth2/tokenP")
        ? tokenResponse("daily-page-limit-token")
        : jsonResponse(
            {
              rt_cd: "0",
              ctx_area_fk100: "NEXT",
              ctx_area_nk100: "NEXT-NK",
              output1: [dailyOrderRow()],
              output2: {}
            },
            { headers: { tr_cont: "F" } }
          );
    const broker = new KisBroker(CONFIG, {
      fetchImpl,
      minimumIntervalMs: 0,
      maximumBalancePages: 1
    });
    await assert.rejects(broker.getTodayOrders(), { code: "KIS_DAILY_ORDERS_PAGE_LIMIT" });
  });
});

test("정정취소 가능 주문조회는 실전 공식 TR ID로 전 페이지의 가능수량을 반환한다", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("cancelable-token");
    return jsonResponse({ rt_cd: "0", output: [cancelableOrderRow()] });
  };
  const broker = new KisBroker(
    { ...CONFIG, environment: "prod" },
    { fetchImpl, minimumIntervalMs: 0 }
  );

  const result = await broker.getCancelableOrders({ side: "buy" });

  assert.equal(result.pages, 1);
  assert.deepEqual(
    result.orders.map(({ brokerOrderId, ticker, cancelableQuantity, filledQuantity }) => ({
      brokerOrderId,
      ticker,
      cancelableQuantity,
      filledQuantity
    })),
    [{ brokerOrderId: "000001", ticker: "005930", cancelableQuantity: 2, filledQuantity: 0 }]
  );
  const call = calls[1];
  assert.ok(call.url.includes("/uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl"));
  assert.equal(call.options.headers.tr_id, "TTTC0084R");
  const query = new URL(call.url).searchParams;
  assert.equal(query.get("INQR_DVSN_1"), "0");
  assert.equal(query.get("INQR_DVSN_2"), "2");
});

test("정정취소 가능 주문조회는 공식 지원이 없는 모의환경에서 네트워크 전에 차단한다", async () => {
  let calls = 0;
  const broker = new KisBroker(CONFIG, {
    fetchImpl: async () => {
      calls += 1;
      return tokenResponse();
    }
  });
  await assert.rejects(broker.getCancelableOrders(), { code: "KIS_CANCELABLE_PROD_ONLY" });
  assert.equal(calls, 0);
});

test("cancelOrder는 당일 전량 미체결과 공식 취소가능수량을 모두 확인한 뒤에만 전량 취소한다", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("cancel-token");
    if (url.includes("/inquire-daily-ccld")) {
      return jsonResponse({ rt_cd: "0", output1: [dailyOrderRow()], output2: {} });
    }
    if (url.includes("/inquire-psbl-rvsecncl")) {
      return jsonResponse({ rt_cd: "0", output: [cancelableOrderRow()] });
    }
    return successfulOrderResponse("000099");
  };
  const now = Date.UTC(2026, 6, 21, 0, 30);
  const broker = new KisBroker(
    { ...CONFIG, environment: "prod" },
    { fetchImpl, minimumIntervalMs: 0, now: () => now }
  );

  const result = await broker.cancelOrder({
    ticker: "005930",
    country: "KR",
    side: "buy",
    exchange: "KOSPI",
    brokerOrderId: "000001",
    branchNumber: "91252"
  });

  assert.equal(result.status, "cancel_submitted");
  assert.equal(result.originalOrderId, "000001");
  assert.equal(result.cancelOrderId, "000099");
  assert.equal(result.canceledQuantity, 2);
  assert.equal(calls.length, 4);
  const cancelCall = calls[3];
  assert.ok(cancelCall.url.endsWith("/uapi/domestic-stock/v1/trading/order-rvsecncl"));
  assert.equal(cancelCall.options.headers.tr_id, "TTTC0013U");
  assert.deepEqual(requestBody(cancelCall), {
    CANO: "12345678",
    ACNT_PRDT_CD: "01",
    KRX_FWDG_ORD_ORGNO: "91252",
    ORGN_ODNO: "000001",
    ORD_DVSN: "00",
    RVSE_CNCL_DVSN_CD: "02",
    ORD_QTY: "2",
    ORD_UNPR: "70000",
    QTY_ALL_ORD_YN: "Y",
    EXCG_ID_DVSN_CD: "KRX"
  });
});

test("cancelOrder는 부분체결 또는 취소가능수량 불일치 시 POST하지 않는다", async (t) => {
  await t.test("부분체결", async () => {
    let nonTokenCalls = 0;
    const fetchImpl = async (url) => {
      if (url.endsWith("/oauth2/tokenP")) return tokenResponse("partial-cancel-token");
      nonTokenCalls += 1;
      return jsonResponse({
        rt_cd: "0",
        output1: [dailyOrderRow({ tot_ccld_qty: "1", rmn_qty: "1" })],
        output2: {}
      });
    };
    const broker = new KisBroker(
      { ...CONFIG, environment: "prod" },
      { fetchImpl, minimumIntervalMs: 0 }
    );
    await assert.rejects(
      broker.cancelOrder({
        ticker: "005930",
        side: "buy",
        brokerOrderId: "000001",
        branchNumber: "91252"
      }),
      { code: "KIS_CANCEL_NOT_FULLY_UNFILLED" }
    );
    assert.equal(nonTokenCalls, 1, "부분체결이면 취소가능조회와 POST를 모두 생략해야 한다");
  });

  await t.test("취소가능수량 불일치", async () => {
    let cancelPosts = 0;
    const fetchImpl = async (url, options) => {
      if (url.endsWith("/oauth2/tokenP")) return tokenResponse("mismatch-cancel-token");
      if (url.includes("/inquire-daily-ccld")) {
        return jsonResponse({ rt_cd: "0", output1: [dailyOrderRow()], output2: {} });
      }
      if (url.includes("/inquire-psbl-rvsecncl")) {
        return jsonResponse({
          rt_cd: "0",
          output: [cancelableOrderRow({ psbl_qty: "1" })]
        });
      }
      if (options.method === "POST") cancelPosts += 1;
      return successfulOrderResponse();
    };
    const broker = new KisBroker(
      { ...CONFIG, environment: "prod" },
      { fetchImpl, minimumIntervalMs: 0 }
    );
    await assert.rejects(
      broker.cancelOrder({
        ticker: "005930",
        side: "buy",
        brokerOrderId: "000001",
        branchNumber: "91252"
      }),
      { code: "KIS_CANCELABLE_QUANTITY_MISMATCH" }
    );
    assert.equal(cancelPosts, 0);
  });
});

test("취소 POST 네트워크 오류는 모호함으로 표시하고 자동 재시도하지 않는다", async () => {
  let cancelPosts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("ambiguous-cancel-token");
    if (url.includes("/inquire-daily-ccld")) {
      return jsonResponse({ rt_cd: "0", output1: [dailyOrderRow()], output2: {} });
    }
    if (url.includes("/inquire-psbl-rvsecncl")) {
      return jsonResponse({ rt_cd: "0", output: [cancelableOrderRow()] });
    }
    cancelPosts += 1;
    throw new Error(`${CONFIG.appSecret} socket closed`);
  };
  const broker = new KisBroker(
    { ...CONFIG, environment: "prod" },
    { fetchImpl, minimumIntervalMs: 0 }
  );

  await assert.rejects(
    broker.cancelOrder({
      ticker: "005930",
      side: "buy",
      brokerOrderId: "000001",
      branchNumber: "91252"
    }),
    (error) => {
      assert.ok(error instanceof KisApiError);
      assert.equal(error.code, "KIS_NETWORK_ERROR");
      assert.equal(error.ambiguous, true);
      assert.ok(!error.message.includes(CONFIG.appSecret));
      return true;
    }
  );
  assert.equal(cancelPosts, 1);
});

test("afterEach는 각 주문결과 뒤에 await되고 실패하면 비밀을 가린 채 후속 주문을 막는다", async () => {
  const events = [];
  let orderCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("after-each-token");
    orderCalls += 1;
    events.push(`order:${orderCalls}`);
    return successfulOrderResponse(`00000${orderCalls}`);
  };
  const broker = new KisBroker(CONFIG, { fetchImpl, minimumIntervalMs: 0 });
  const orders = ["005930", "000660", "035420"].map((ticker, index) => ({
    ticker,
    country: "KR",
    exchange: "KOSPI",
    side: "buy",
    quantity: 1,
    limitPrice: 70_000 + index * 1_000
  }));

  const results = await broker.placeOrders(orders, {
    afterEach: async (result, index, completed) => {
      events.push(`checkpoint-start:${index}:${result.status}:${completed.length}`);
      await Promise.resolve();
      events.push(`checkpoint-end:${index}`);
      if (index === 0) {
        result.status = "mutated-by-callback";
        delete result.brokerOrderId;
      }
      if (index === 1) {
        const error = new Error(`checkpoint failed ${CONFIG.appSecret}`);
        error.code = "STATE_CHECKPOINT_FAILED";
        throw error;
      }
    }
  });

  assert.deepEqual(events, [
    "order:1",
    "checkpoint-start:0:submitted:1",
    "checkpoint-end:0",
    "order:2",
    "checkpoint-start:1:submitted:2",
    "checkpoint-end:1"
  ]);
  assert.equal(orderCalls, 2);
  assert.deepEqual(results.map((result) => result.status), ["submitted", "submitted", "blocked"]);
  assert.equal(results[0].brokerOrderId, "000001");
  assert.equal(results[1].checkpointStatus, "failed");
  assert.equal(results[1].checkpointErrorCode, "STATE_CHECKPOINT_FAILED");
  assert.ok(!results[1].checkpointReason.includes(CONFIG.appSecret));
  assert.equal(results[2].notSent, true);
  assert.equal(results[2].errorCode, "STATE_CHECKPOINT_FAILED");
});

test("afterEach는 unknown 결과도 먼저 체크포인트한 뒤 묶음을 중단한다", async () => {
  const checked = [];
  let orderCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/tokenP")) return tokenResponse("unknown-checkpoint-token");
    orderCalls += 1;
    throw new Error("socket closed");
  };
  const broker = new KisBroker(CONFIG, { fetchImpl, minimumIntervalMs: 0 });
  const results = await broker.placeOrders(
    [
      { ticker: "005930", country: "KR", side: "buy", quantity: 1, limitPrice: 70_000 },
      { ticker: "000660", country: "KR", side: "buy", quantity: 1, limitPrice: 200_000 }
    ],
    {
      afterEach: async (result, index) => checked.push(`${index}:${result.status}`)
    }
  );
  assert.equal(orderCalls, 1);
  assert.deepEqual(checked, ["0:unknown"]);
  assert.deepEqual(results.map((result) => result.status), ["unknown", "blocked"]);
});
