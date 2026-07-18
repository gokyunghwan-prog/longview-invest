import test from "node:test";
import assert from "node:assert/strict";

import { fetchJson } from "../lib/http.mjs";
import {
  enrichKrCompaniesWithPrices,
  fetchLatestKrStockPrices,
  normalizeKrStockPriceItem
} from "../lib/providers/kr-stock-price.mjs";
import {
  enrichUsCompaniesWithLicensedPrices,
  fetchLicensedUsSnapshot,
  normalizeLicensedUsSnapshot
} from "../lib/providers/licensed-stock-price.mjs";

function krRow(overrides = {}) {
  return {
    basDt: "20260717",
    srtnCd: "000001",
    itmsNm: "테스트",
    mrktCtg: "KOSPI",
    clpr: "100",
    mkp: "98",
    hipr: "105",
    lopr: "95",
    vs: "5",
    fltRt: "5.2631579",
    trqu: "1000",
    trPrc: "100000",
    lstgStCnt: "1000000",
    mrktTotAmt: "100000000",
    ...overrides
  };
}

function manifest(overrides = {}) {
  return {
    usageMode: "public",
    redistributionAllowed: true,
    derivedPublicationAllowed: true,
    licenseReference: "https://license.example.com/terms",
    provider: "Licensed Guard Test",
    sourceUrl: "https://feed.example.com/source",
    licenseId: "test-contract-2026",
    rightsReviewedAt: "2026-07-01",
    marketCapScope: "issuer",
    ...overrides
  };
}

function licensedPayload(data, overrides = {}) {
  return {
    schemaVersion: 1,
    manifest: manifest(),
    asOf: "2026-07-17",
    data,
    ...overrides
  };
}

function usRow(ticker, exchange = "Nasdaq", overrides = {}) {
  return {
    ticker,
    exchange,
    currency: "USD",
    close: 100,
    marketCap: 1_000,
    ...overrides
  };
}

test("한국 시세는 잘못된 달력 날짜·OHLC·security 시가총액을 거부한다", () => {
  assert.equal(normalizeKrStockPriceItem(krRow({ basDt: "20260231" })), null);
  assert.equal(normalizeKrStockPriceItem(krRow({ hipr: "99" })), null);
  assert.equal(normalizeKrStockPriceItem(krRow({ mrktTotAmt: "70000000" })), null);
});

test("한국 시세 수집기는 totalCount 상한·중복 ticker·페이지 기준일 혼합을 거부한다", async () => {
  await assert.rejects(
    fetchLatestKrStockPrices({
      apiKey: "key",
      now: new Date("2026-07-17T12:00:00.000Z"),
      fetchJsonImpl: async () => ({
        response: {
          header: { resultCode: "00" },
          body: { totalCount: 20_001, items: { item: krRow() } }
        }
      })
    }),
    /상한/
  );

  await assert.rejects(
    fetchLatestKrStockPrices({
      apiKey: "key",
      now: new Date("2026-07-17T12:00:00.000Z"),
      fetchJsonImpl: async () => ({
        response: {
          header: { resultCode: "00" },
          body: { totalCount: 2, items: { item: [krRow(), krRow()] } }
        }
      })
    }),
    /중복/
  );

  await assert.rejects(
    fetchLatestKrStockPrices({
      apiKey: "key",
      now: new Date("2026-07-17T12:00:00.000Z"),
      fetchJsonImpl: async () => ({
        response: {
          header: { resultCode: "00" },
          body: {
            totalCount: 2,
            items: { item: [krRow(), krRow({ srtnCd: "000002", basDt: "20260716" })] }
          }
        }
      })
    }),
    /기준일/
  );
});

test("한국 시세 병합은 applied/preserved/freshness와 이전 대비 20% 하락 한도를 지킨다", () => {
  const companies = [
    {
      id: "KR-1",
      country: "KR",
      ticker: "1",
      currency: "KRW",
      marketData: {
        usageMode: "public",
        asOf: "2026-07-18",
        price: 101,
        currency: "KRW"
      }
    },
    { id: "KR-2", country: "KR", ticker: "2", currency: "KRW" }
  ];
  const snapshot = {
    asOf: "2026-07-17",
    records: [
      normalizeKrStockPriceItem(krRow()),
      normalizeKrStockPriceItem(krRow({ srtnCd: "000002" }))
    ]
  };
  const enriched = enrichKrCompaniesWithPrices(companies, snapshot, {
    minimumMatched: 2,
    minimumMatchRatio: 1,
    previousMatched: 2,
    now: new Date("2026-07-18T12:00:00.000Z")
  });
  assert.equal(enriched.applied, 1);
  assert.equal(enriched.preservedNewer, 1);
  assert.equal(enriched.freshness.status, "current");
  assert.equal(enriched.companies[0].marketData.status, "preserved");
  assert.equal(enriched.companies[1].marketData.status, "ok");
  assert.equal(enriched.companies[1].marketData.freshness, "current");
  assert.equal(enriched.companies[1].marketData.marketCapScope, "security");

  const tenCompanies = Array.from({ length: 10 }, (_, index) => ({
    id: `KR-${index + 1}`,
    country: "KR",
    ticker: String(index + 1).padStart(6, "0")
  }));
  const sevenRecords = Array.from({ length: 7 }, (_, index) =>
    normalizeKrStockPriceItem(krRow({ srtnCd: String(index + 1).padStart(6, "0") }))
  );
  assert.throws(
    () =>
      enrichKrCompaniesWithPrices(
        tenCompanies,
        { asOf: "2026-07-17", records: sevenRecords },
        {
          minimumMatched: 0,
          minimumMatchRatio: 0,
          previousMatched: 10,
          now: new Date("2026-07-18T12:00:00.000Z")
        }
      ),
    /하한 8개/
  );
});

test("licensed schema v1은 top asOf·동일 날짜·USD·ticker·OHLC·행 상한을 강제한다", () => {
  const options = { now: new Date("2026-07-18T00:00:00.000Z") };
  assert.throws(
    () => normalizeLicensedUsSnapshot(licensedPayload([usRow("AAA")], { asOf: "2026-02-30" }), options),
    /asOf/
  );
  assert.throws(
    () =>
      normalizeLicensedUsSnapshot(
        licensedPayload([usRow("AAA", "Nasdaq", { date: "2026-07-16" })]),
        options
      ),
    /기준일/
  );
  assert.throws(
    () => normalizeLicensedUsSnapshot(licensedPayload([usRow("AAA", "Nasdaq", { currency: "KRW" })]), options),
    /USD/
  );
  assert.throws(
    () => normalizeLicensedUsSnapshot(licensedPayload([usRow("BAD TICKER")]), options),
    /ticker/
  );
  assert.throws(
    () => normalizeLicensedUsSnapshot(licensedPayload([usRow("AAA", "Nasdaq", { high: 90 })]), options),
    /OHLC/
  );
  assert.throws(
    () =>
      normalizeLicensedUsSnapshot(
        licensedPayload(Array(20_001).fill(usRow("AAA"))),
        options
      ),
    /1~20000/
  );
});

test("licensed 시가총액은 issuer/security 범위가 명시되고 교차값도 검증된다", () => {
  const issuer = normalizeLicensedUsSnapshot(
    licensedPayload([usRow("AAA")]),
    { now: new Date("2026-07-18T00:00:00.000Z") }
  ).records[0];
  assert.equal(issuer.marketCapScope, "issuer");
  assert.equal(issuer.issuerTotalMarketCap, true);
  assert.equal(issuer.issuerMarketCap, 1_000);
  assert.equal(issuer.securityMarketCap, null);

  assert.throws(
    () =>
      normalizeLicensedUsSnapshot(
        licensedPayload(
          [usRow("AAA", "Nasdaq", { listedShares: 20 })],
          { manifest: manifest({ marketCapScope: "security" }) }
        ),
        { now: new Date("2026-07-18T00:00:00.000Z") }
      ),
    /price×listedShares/
  );
  assert.throws(
    () =>
      normalizeLicensedUsSnapshot(
        licensedPayload([usRow("AAA")], { manifest: manifest({ marketCapScope: undefined }) }),
        { now: new Date("2026-07-18T00:00:00.000Z") }
      ),
    /marketCapScope/
  );
});

test("licensed snapshot fetch는 공개 HTTPS exact allowlist·schema v1·크기 제한을 강제한다", async () => {
  const valid = licensedPayload([usRow("AAA")]);
  await assert.rejects(
    fetchLicensedUsSnapshot({
      url: "https://localhost/feed.json",
      allowedHosts: ["localhost"],
      fetchJsonImpl: async () => valid
    }),
    /공개 HTTPS/
  );
  await assert.rejects(
    fetchLicensedUsSnapshot({
      url: "https://feed.example.com/feed.json?token=secret",
      allowedHosts: ["feed.example.com", "license.example.com"],
      fetchJsonImpl: async () => valid
    }),
    /비밀값 없는/
  );
  await assert.rejects(
    fetchLicensedUsSnapshot({
      url: "https://feed.example.com/feed.json",
      allowedHosts: ["other.example.com"],
      fetchJsonImpl: async () => valid
    }),
    /allowlist/
  );

  let requestOptions;
  const withoutSchema = { ...valid };
  delete withoutSchema.schemaVersion;
  await assert.rejects(
    fetchLicensedUsSnapshot({
      url: "https://feed.example.com/feed.json",
      token: "header-only-secret",
      allowedHosts: "feed.example.com,license.example.com",
      now: new Date("2026-07-18T00:00:00.000Z"),
      fetchJsonImpl: async (_url, options) => {
        requestOptions = options;
        return withoutSchema;
      }
    }),
    /schemaVersion/
  );
  assert.equal(requestOptions.redirect, "error");
  assert.equal(requestOptions.maxBytes, 20 * 1024 * 1024);
  assert.equal(requestOptions.headers.Authorization, "Bearer header-only-secret");

  await assert.rejects(
    fetchJson(new URL("data:application/json,%7B%22long%22%3A%22123456789%22%7D"), {
      retries: 0,
      maxBytes: 5
    }),
    /size limit/
  );
});

test("미국 listings 매칭은 실제 ticker/exchange 쌍만 허용해 Cartesian 오매칭을 막는다", () => {
  const snapshot = normalizeLicensedUsSnapshot(
    licensedPayload([usRow("AAA", "NYSE")]),
    { now: new Date("2026-07-18T00:00:00.000Z") }
  );
  assert.throws(
    () =>
      enrichUsCompaniesWithLicensedPrices(
        [
          {
            id: "US-1",
            country: "US",
            ticker: "AAA",
            exchange: "Nasdaq",
            tickers: ["AAA", "BBB"],
            exchanges: ["Nasdaq", "NYSE"],
            listings: [
              { ticker: "AAA", exchange: "Nasdaq" },
              { ticker: "BBB", exchange: "NYSE" }
            ]
          }
        ],
        snapshot,
        {
          minimumMatched: 1,
          minimumMatchRatio: 1,
          now: new Date("2026-07-18T00:00:00.000Z")
        }
      ),
    /커버리지/
  );
});

test("미국 병합은 issuer 범위와 applied/preserved 값을 보존하고 이전 대비 급락을 막는다", () => {
  const snapshot = normalizeLicensedUsSnapshot(
    licensedPayload([usRow("AAA"), usRow("BBB")]),
    { now: new Date("2026-07-18T00:00:00.000Z") }
  );
  const enriched = enrichUsCompaniesWithLicensedPrices(
    [
      {
        id: "US-A",
        country: "US",
        ticker: "AAA",
        exchange: "Nasdaq",
        currency: "USD",
        marketData: { usageMode: "public", asOf: "2026-07-18", price: 101, currency: "USD" }
      },
      { id: "US-B", country: "US", ticker: "BBB", exchange: "Nasdaq", currency: "USD" }
    ],
    snapshot,
    {
      minimumMatched: 2,
      minimumMatchRatio: 1,
      previousMatched: 2,
      now: new Date("2026-07-18T00:00:00.000Z")
    }
  );
  assert.equal(enriched.applied, 1);
  assert.equal(enriched.preservedNewer, 1);
  assert.equal(enriched.companies[0].marketData.status, "preserved");
  assert.equal(enriched.companies[1].marketData.freshness, "current");
  assert.equal(enriched.companies[1].marketData.issuerTotalMarketCap, true);
  assert.equal(enriched.companies[1].marketData.marketCapScope, "issuer");

  const tenCompanies = Array.from({ length: 10 }, (_, index) => ({
    id: `US-${index}`,
    country: "US",
    ticker: `T${index}`,
    exchange: "Nasdaq"
  }));
  const sevenRows = Array.from({ length: 7 }, (_, index) => usRow(`T${index}`));
  const reducedSnapshot = normalizeLicensedUsSnapshot(licensedPayload(sevenRows), {
    now: new Date("2026-07-18T00:00:00.000Z")
  });
  assert.throws(
    () =>
      enrichUsCompaniesWithLicensedPrices(tenCompanies, reducedSnapshot, {
        minimumMatched: 0,
        minimumMatchRatio: 0,
        previousMatched: 10,
        now: new Date("2026-07-18T00:00:00.000Z")
      }),
    /하한 8개/
  );
});
