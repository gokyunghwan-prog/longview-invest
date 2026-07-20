import assert from "node:assert/strict";
import test from "node:test";

import {
  enrichKrCompaniesWithPrices,
  fetchLatestKrStockPrices,
  normalizeKrStockPriceItem
} from "../lib/providers/kr-stock-price.mjs";

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

test("한국 시세는 잘못된 달력 날짜·OHLC·종목 시가총액을 거부한다", () => {
  assert.equal(normalizeKrStockPriceItem(krRow({ basDt: "20260231" })), null);
  assert.equal(normalizeKrStockPriceItem(krRow({ hipr: "99" })), null);
  assert.equal(normalizeKrStockPriceItem(krRow({ mrktTotAmt: "70000000" })), null);
});

test("한국 시세 수집기는 건수 상한·중복 종목·페이지 기준일 혼합을 거부한다", async () => {
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

test("한국 시세 병합은 적용·보존·신선도와 이전 대비 급락 한도를 지킨다", () => {
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
