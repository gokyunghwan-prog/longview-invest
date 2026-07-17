import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSecCompany,
  normalizeSecTickerUniverse
} from "../lib/providers/sec.mjs";

function durationFacts(values, form = "10-K") {
  return values.map(({ year, value, filed = `${year + 1}-02-01` }) => ({
    start: `${year}-01-01`,
    end: `${year}-12-31`,
    val: value,
    accn: `0000000123-${String(year + 1).slice(-2)}-000001`,
    fy: year,
    fp: "FY",
    form,
    filed
  }));
}

function instantFacts(values, form = "10-K") {
  return values.map(({ year, value }) => ({
    end: `${year}-12-31`,
    val: value,
    accn: `0000000123-${String(year + 1).slice(-2)}-000001`,
    fy: year,
    fp: "FY",
    form,
    filed: `${year + 1}-02-01`
  }));
}

function concept(entries, unit = "USD") {
  return { label: "test", description: "test", units: { [unit]: entries } };
}

function healthyFacts() {
  const years = [
    { year: 2023, value: 100 },
    { year: 2024, value: 120 },
    { year: 2025, value: 150 }
  ];
  return {
    cik: 123,
    entityName: "Example Corp",
    facts: {
      "us-gaap": {
        Revenues: concept(durationFacts(years)),
        OperatingIncomeLoss: concept(
          durationFacts([
            { year: 2023, value: 15 },
            { year: 2024, value: 20 },
            { year: 2025, value: 30 }
          ])
        ),
        NetIncomeLoss: concept(
          durationFacts([
            { year: 2023, value: 10 },
            { year: 2024, value: 14 },
            { year: 2025, value: 21 }
          ])
        ),
        Assets: concept(instantFacts(years.map((point) => ({ ...point, value: point.value * 3 })))),
        Liabilities: concept(
          instantFacts(years.map((point) => ({ ...point, value: point.value })))
        ),
        StockholdersEquity: concept(
          instantFacts(years.map((point) => ({ ...point, value: point.value * 2 })))
        ),
        AssetsCurrent: concept(
          instantFacts(years.map((point) => ({ ...point, value: point.value })))
        ),
        LiabilitiesCurrent: concept(
          instantFacts(years.map((point) => ({ ...point, value: point.value / 2 })))
        ),
        NetCashProvidedByUsedInOperatingActivities: concept(
          durationFacts(years.map((point) => ({ ...point, value: point.value / 5 })))
        ),
        PaymentsToAcquirePropertyPlantAndEquipment: concept(
          durationFacts(years.map((point) => ({ ...point, value: point.value / 30 })))
        )
      }
    }
  };
}

function operatingSubmission() {
  return {
    cik: "0000000123",
    entityType: "operating",
    sic: "3571",
    sicDescription: "Electronic Computers",
    name: "Example Corp",
    tickers: ["EXM", "EXM.A"],
    exchanges: ["Nasdaq", "NYSE"],
    filings: {
      recent: {
        accessionNumber: ["0000000123-26-000001"],
        filingDate: ["2026-02-01"],
        acceptanceDateTime: ["2026-02-01T12:00:00.000Z"],
        reportDate: ["2025-12-31"],
        form: ["10-K"],
        primaryDocument: ["example-2025.htm"],
        items: [""]
      }
    }
  };
}

test("SEC ticker 기준 목록은 대상 거래소만 남기고 같은 CIK를 하나로 통합한다", () => {
  const universe = normalizeSecTickerUniverse({
    fields: ["cik", "name", "ticker", "exchange"],
    data: [
      [1652044, "Alphabet Inc.", "GOOGL", "Nasdaq"],
      [1652044, "Alphabet Inc.", "GOOG", "Nasdaq"],
      [320193, "Apple Inc.", "AAPL", "Nasdaq"],
      [123, "Example Corp", "EXMW", "Nasdaq"],
      [123, "Example Corp", "EXM", "NYSE"],
      [999, "OTC Corp", "OTCX", "OTC"],
      [1000, "No Exchange", "NONE", null]
    ]
  });

  assert.equal(universe.length, 3);
  const alphabet = universe.find((company) => company.cik === "0001652044");
  assert.equal(alphabet.id, "US-CIK0001652044");
  assert.equal(alphabet.ticker, "GOOG");
  assert.deepEqual(alphabet.tickers, ["GOOG", "GOOGL"]);

  const example = universe.find((company) => company.cik === "0000000123");
  assert.equal(example.ticker, "EXM");
  assert.deepEqual(example.exchanges, ["Nasdaq", "NYSE"]);
  assert.deepEqual(
    universe.map((company) => company.cik),
    ["0000000123", "0000320193", "0001652044"]
  );
});

test("순수 SEC 정규화 함수는 공시 facts에서 재무지표와 계보를 만든다", () => {
  const company = {
    id: "US-CIK0000000123",
    cik: "0000000123",
    name: "Example",
    ticker: "EXM",
    tickers: ["EXM"],
    exchange: "Nasdaq",
    exchanges: ["Nasdaq"]
  };
  const normalized = normalizeSecCompany(company, healthyFacts(), operatingSubmission(), {
    updatedAt: "2026-07-17T00:00:00.000Z"
  });

  assert.equal(normalized.dataMode, "live");
  assert.equal(normalized.updatedAt, "2026-07-17T00:00:00.000Z");
  assert.equal(normalized.metrics.revenueGrowth, 25);
  assert.equal(normalized.metrics.operatingMargin, 20);
  assert.ok(Math.abs(normalized.metrics.fcfMargin - 16.6666666667) < 0.001);
  assert.equal(normalized.lineage.taxonomy, "us-gaap");
  assert.equal(normalized.lineage.tags.revenue, "Revenues");
  assert.deepEqual(normalized.tickers, ["EXM", "EXM.A"]);
  assert.equal(normalized.disclosures.length, 1);
});

test("필수 facts가 없는 상장사도 예외 대신 insufficient_data 레코드로 보존한다", () => {
  const normalized = normalizeSecCompany(
    {
      id: "US-CIK0000000123",
      cik: "0000000123",
      name: "Sparse Corp",
      ticker: "SPRS",
      tickers: ["SPRS"],
      exchange: "NYSE",
      exchanges: ["NYSE"]
    },
    { cik: 123, entityName: "Sparse Corp", facts: {} },
    operatingSubmission(),
    { updatedAt: "2026-07-17T00:00:00.000Z" }
  );

  assert.equal(normalized.dataMode, "insufficient_data");
  assert.equal(normalized.syncStatus, "insufficient_data");
  assert.ok(normalized.dataIssues.includes("unsupported_taxonomy"));
  assert.ok(normalized.dataIssues.includes("insufficient_revenue_history"));
  assert.equal(normalized.metrics.revenueGrowth, null);
});

test("투자회사도 목록에서 삭제하지 않고 not_applicable로 표시한다", () => {
  const submission = {
    ...operatingSubmission(),
    entityType: "investment",
    name: "Example ETF"
  };
  const normalized = normalizeSecCompany(
    {
      id: "US-CIK0000000123",
      cik: "0000000123",
      name: "Example ETF",
      ticker: "ETF",
      tickers: ["ETF"],
      exchange: "NYSE",
      exchanges: ["NYSE"]
    },
    healthyFacts(),
    submission,
    { updatedAt: "2026-07-17T00:00:00.000Z" }
  );

  assert.equal(normalized.dataMode, "not_applicable");
  assert.match(normalized.risks[0], /일반회사 평가모델/);
});
