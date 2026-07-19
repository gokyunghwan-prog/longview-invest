import test from "node:test";
import assert from "node:assert/strict";

import {
  attachMarketValuation,
  deriveMarketValuation
} from "../lib/market-valuation.mjs";
import {
  enrichKrCompaniesWithPrices,
  fetchLatestKrStockPrices,
  normalizeKrStockPriceItem
} from "../lib/providers/kr-stock-price.mjs";
import {
  enrichUsCompaniesWithLicensedPrices,
  MarketDataLicenseError,
  normalizeLicensedUsSnapshot
} from "../lib/providers/licensed-stock-price.mjs";

function krRow(overrides = {}) {
  return {
    basDt: "20260717",
    srtnCd: "005930",
    itmsNm: "삼성전자",
    mrktCtg: "KOSPI",
    clpr: "70,000",
    mkp: "69,000",
    hipr: "71,000",
    lopr: "68,500",
    vs: "1,000",
    fltRt: "1.449",
    trqu: "10,000,000",
    trPrc: "700,000,000,000",
    lstgStCnt: "100",
    mrktTotAmt: "1,000",
    ...overrides
  };
}

test("금융위원회 한국 시세는 앞자리 0 코드와 공식 OHLC·시총을 보존한다", () => {
  const normalized = normalizeKrStockPriceItem(krRow({ srtnCd: "5930" }));
  assert.equal(normalized.ticker, "005930");
  assert.equal(normalized.asOf, "2026-07-17");
  assert.equal(normalized.price, 70_000);
  assert.equal(normalized.previousClose, 69_000);
  assert.equal(normalized.changePercent, 1.449);
  assert.equal(normalized.marketCap, 1_000);
  assert.equal(normalizeKrStockPriceItem(krRow({ clpr: "0" })), null);
});

test("한국 시세 수집기는 비영업일을 역탐색하고 totalCount 페이지를 모두 읽는다", async () => {
  const calls = [];
  const result = await fetchLatestKrStockPrices({
    apiKey: "encoded%2Bkey",
    now: new Date("2026-07-18T10:00:00.000Z"),
    pageSize: 100,
    fetchJsonImpl: async (url) => {
      calls.push(url);
      const date = url.searchParams.get("basDt");
      if (date === "20260718") {
        return { response: { header: { resultCode: "00" }, body: { totalCount: 0, items: [] } } };
      }
      return {
        response: {
          header: { resultCode: "00" },
          body: { totalCount: 1, items: { item: krRow() } }
        }
      };
    }
  });
  assert.equal(result.asOf, "2026-07-17");
  assert.equal(result.records.length, 1);
  assert.deepEqual(calls.map((url) => url.searchParams.get("basDt")), ["20260718", "20260717"]);
  assert.equal(calls[0].searchParams.get("serviceKey"), "encoded+key");
});

test("한국 시세는 안전 커버리지를 통과한 최신값만 합치고 가치평가 계보를 만든다", () => {
  const company = {
    id: "KR-005930",
    country: "KR",
    ticker: "005930",
    exchange: "KOSPI",
    currency: "KRW",
    metrics: {},
    financials: {
      latest: {
        periodEnd: "2025-12-31",
        currency: "KRW",
        revenue: 1_000,
        netIncome: 100,
        equity: 500,
        freeCashFlow: 50
      }
    }
  };
  const result = enrichKrCompaniesWithPrices(
    [company],
    { asOf: "2026-07-17", records: [normalizeKrStockPriceItem(krRow())] },
    { minimumMatched: 1, minimumMatchRatio: 1, fetchedAt: "2026-07-18T00:00:00.000Z" }
  );
  assert.equal(result.companies[0].marketData.usageMode, "public");
  assert.equal(result.companies[0].marketData.valuation.per, 10);
  assert.equal(result.companies[0].marketData.valuation.pbr, 2);
  assert.equal(result.companies[0].marketData.valuation.psr, 1);
  assert.equal(result.companies[0].marketData.valuation.fcfYield, 5);

  assert.throws(
    () =>
      enrichKrCompaniesWithPrices([company, { ...company, id: "KR-000001", ticker: "000001" }],
        { records: [normalizeKrStockPriceItem(krRow())] },
        { minimumMatched: 1, minimumMatchRatio: 0.75 }),
    /커버리지/
  );
});

test("미국 공개 snapshot은 원자료와 파생값 재배포 권리를 모두 요구한다", () => {
  assert.throws(
    () =>
      normalizeLicensedUsSnapshot({
        manifest: {
          usageMode: "public",
          redistributionAllowed: true,
          derivedPublicationAllowed: false,
          licenseReference: "https://example.com/license"
        },
        data: []
      }),
    MarketDataLicenseError
  );

  const snapshot = normalizeLicensedUsSnapshot({
    manifest: {
      usageMode: "public",
      redistributionAllowed: true,
      derivedPublicationAllowed: true,
      licenseReference: "https://example.com/license",
      provider: "Licensed Test Feed",
      sourceUrl: "https://example.com/feed"
    },
    asOf: "2026-07-17",
    data: [
      {
        ticker: "BRK-B",
        exchange: "NYSE",
        close: 500,
        marketCap: 1_000,
        currency: "USD"
      }
    ]
  });
  const enriched = enrichUsCompaniesWithLicensedPrices(
    [
      {
        id: "US-BRK",
        country: "US",
        ticker: "BRK.B",
        tickers: ["BRK.B"],
        exchange: "NYSE",
        exchanges: ["NYSE"],
        currency: "USD",
        financials: {
          latest: { currency: "USD", periodEnd: "2025-12-31", netIncome: 100 }
        }
      }
    ],
    snapshot,
    { minimumMatched: 1, minimumMatchRatio: 1 }
  );
  assert.equal(enriched.companies[0].marketData.price, 500);
  assert.equal(enriched.companies[0].marketData.valuation.per, 10);
});

test("적자·통화 불일치·복수 주식종은 PER을 억지로 만들지 않는다", () => {
  const valuation = deriveMarketValuation(
    {
      ticker: "LOSS",
      tickers: ["LOSS", "LOSS.A"],
      currency: "USD",
      financials: {
        latest: {
          currency: "USD",
          netIncome: -10,
          epsDiluted: -1,
          sharesOutstanding: 100
        }
      }
    },
    { price: 10, currency: "USD" }
  );
  assert.equal(valuation.per, null);
  assert.equal(valuation.marketCap, null);
  assert.ok(valuation.issues.includes("security_mapping_required"));
});

test("복수 주식종은 issuer 전체 시가총액임이 명시된 경우에만 가치지표를 만든다", () => {
  const company = {
    ticker: "DUAL.A",
    tickers: ["DUAL.A", "DUAL.B"],
    currency: "USD",
    financials: {
      latest: {
        periodEnd: "2025-12-31",
        currency: "USD",
        revenue: 1_000,
        netIncome: 100,
        equity: 500,
        freeCashFlow: 50
      }
    }
  };
  const securityMarketData = {
    asOf: "2026-07-17",
    price: 10,
    marketCap: 1_000,
    currency: "USD"
  };
  const blocked = attachMarketValuation(company, securityMarketData);
  assert.equal(blocked.marketCap, 1_000);
  assert.equal(blocked.valuation.marketCap, null);
  assert.equal(blocked.valuation.per, null);
  assert.equal(blocked.valuation.pbr, null);
  assert.deepEqual(blocked.valuation.formula, {});
  assert.ok(blocked.valuation.issues.includes("security_mapping_required"));

  const issuerTotal = deriveMarketValuation(company, {
    ...securityMarketData,
    issuerTotalMarketCap: true
  });
  assert.equal(issuerTotal.marketCap, 1_000);
  assert.equal(issuerTotal.marketCapBasis, "provider_issuer_total");
  assert.equal(issuerTotal.per, 10);
  assert.equal(issuerTotal.pbr, 2);
  assert.equal(issuerTotal.psr, 1);
  assert.equal(issuerTotal.fcfYield, 5);
  assert.equal(issuerTotal.formula.per, "marketCap / annualNetIncome");
});

test("가치지표는 가격일보다 미래이거나 550일 넘게 오래된 재무기간을 거부한다", () => {
  const company = {
    ticker: "STALE",
    tickers: ["STALE"],
    currency: "USD",
    financials: {
      latest: {
        periodEnd: "2024-01-01",
        currency: "USD",
        revenue: 1_000,
        netIncome: 100,
        equity: 500,
        freeCashFlow: 50
      }
    }
  };
  for (const periodEnd of ["2024-01-01", "2026-07-18", "2025-02-30", null]) {
    const valuation = deriveMarketValuation(
      {
        ...company,
        financials: { latest: { ...company.financials.latest, periodEnd } }
      },
      {
        asOf: "2026-07-17",
        marketCap: 1_000,
        currency: "USD"
      }
    );
    assert.equal(valuation.marketCap, null);
    assert.equal(valuation.per, null);
    assert.deepEqual(valuation.formula, {});
    assert.ok(valuation.issues.includes("financial_period_stale"));
  }
});

test("price×shares와 price÷EPS는 각각의 공시 기준일이 있어야 한다", () => {
  const baseCompany = {
    ticker: "DATE",
    tickers: ["DATE"],
    currency: "USD",
    financials: {
      latest: {
        periodEnd: "2025-12-31",
        currency: "USD",
        netIncome: null,
        equity: 500,
        sharesOutstanding: 100,
        epsDiluted: 2
      }
    }
  };
  const marketData = { asOf: "2026-07-17", price: 10, currency: "USD" };
  const missingContexts = deriveMarketValuation(baseCompany, marketData);
  assert.equal(missingContexts.marketCap, null);
  assert.equal(missingContexts.per, null);
  assert.ok(missingContexts.issues.includes("share_count_stale"));
  assert.ok(missingContexts.issues.includes("eps_context_stale"));

  const currentContexts = deriveMarketValuation(
    {
      ...baseCompany,
      financials: {
        latest: {
          ...baseCompany.financials.latest,
          sharesDate: "2026-06-30",
          epsPeriodEnd: "2025-12-31"
        }
      }
    },
    marketData
  );
  assert.equal(currentContexts.marketCap, 1_000);
  assert.equal(currentContexts.per, 5);
  assert.equal(currentContexts.formula.per, "price / annualDilutedEPS");
});
