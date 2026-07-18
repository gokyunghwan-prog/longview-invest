import test from "node:test";
import assert from "node:assert/strict";

import {
  assertValidSnapshot,
  validateSnapshot
} from "../lib/snapshot-validator.mjs";

function company(country, index, overrides = {}) {
  return {
    id: `${country}-${index}`,
    country,
    exchange: country === "KR" ? "KOSPI" : "Nasdaq",
    dataMode: "live",
    ...overrides
  };
}

function snapshot(companies, meta = {}) {
  const kr = companies.filter((item) => item.country === "KR").length;
  const us = companies.filter((item) => item.country === "US").length;
  return {
    meta: {
      dataMode: "live",
      coverage: { total: companies.length, kr, us },
      ...meta
    },
    companies
  };
}

test("publishable snapshot validates with explicit small-fixture thresholds", () => {
  const report = assertValidSnapshot(
    snapshot([company("KR", 1), company("US", 1)]),
    { minimumCounts: { KR: 1, US: 1 } }
  );
  assert.equal(report.valid, true);
  assert.deepEqual(report.counts, { total: 2, KR: 1, US: 1 });
});

test("snapshot guard rejects duplicate IDs, demo data, invalid exchanges and coverage drift", () => {
  const report = validateSnapshot(
    snapshot(
      [
        company("KR", 1, { id: "DUPLICATE", dataMode: "demo" }),
        company("US", 1, { id: "DUPLICATE", exchange: "OTC" })
      ],
      { coverage: { total: 99, kr: 0, us: 0 } }
    ),
    { minimumCounts: { KR: 1, US: 1 } }
  );

  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) => error.includes("Duplicate company id")));
  assert.ok(report.errors.some((error) => error.includes("demo data")));
  assert.ok(report.errors.some((error) => error.includes("exchange is invalid")));
  assert.ok(report.errors.some((error) => error.includes("coverage.total")));
});

test("snapshot guard rejects absolute truncation and a sudden drop from a trusted baseline", () => {
  const tooSmall = validateSnapshot(snapshot([company("US", 1)]), {
    requiredCountries: ["US"],
    minimumCounts: { US: 3 }
  });
  assert.equal(tooSmall.valid, false);
  assert.ok(tooSmall.errors.some((error) => error.includes("safe minimum")));

  const previous = snapshot(
    Array.from({ length: 10 }, (_, index) => company("US", index + 1))
  );
  const current = snapshot(
    Array.from({ length: 7 }, (_, index) => company("US", index + 1))
  );
  const dropped = validateSnapshot(current, {
    requiredCountries: ["US"],
    minimumCounts: { US: 1 },
    previousSnapshot: previous,
    maxDropFraction: 0.2
  });
  assert.equal(dropped.valid, false);
  assert.ok(dropped.errors.some((error) => error.includes("dropped from 10 to 7")));
});

test("snapshot guard enforces the serialized output size limit", () => {
  const report = validateSnapshot(snapshot([company("US", 1)]), {
    requiredCountries: ["US"],
    minimumCounts: { US: 1 },
    maxSnapshotBytes: 10
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) => error.includes("safe limit")));
});

test("시세 스키마는 달력 날짜·상태·통화·OHLC·메타 커버리지를 엄격히 검증한다", () => {
  const validQuote = {
    status: "ok",
    freshness: "current",
    usageMode: "public",
    asOf: "2026-07-17",
    currency: "KRW",
    price: 70_000,
    open: 69_000,
    high: 71_000,
    low: 68_000,
    volume: 10,
    marketCap: 7_000_000,
    source: { name: "공식 시세", url: "https://example.com/official" },
    valuation: {}
  };
  const valid = validateSnapshot(
    snapshot(
      [company("KR", 1, { marketData: validQuote })],
      {
        marketData: {
          coverage: { kr: 1, us: 0 },
          available: { kr: 1, us: 0 },
          preserved: { kr: 0, us: 0 },
          stale: { kr: 0, us: 0 }
        }
      }
    ),
    { requiredCountries: ["KR"], minimumCounts: { KR: 1 } }
  );
  assert.equal(valid.valid, true, valid.errors.join("\n"));

  const invalid = validateSnapshot(
    snapshot(
      [
        company("KR", 1, {
          marketData: {
            ...validQuote,
            asOf: "2026-02-30",
            high: 60_000,
            source: { name: "unsafe", url: "https://user:secret@example.com/feed" }
          }
        })
      ],
      { marketData: { coverage: { kr: 1, us: 0 } } }
    ),
    { requiredCountries: ["KR"], minimumCounts: { KR: 1 } }
  );
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes("ISO date")));
  assert.ok(invalid.errors.some((error) => error.includes("high is below")));
  assert.ok(invalid.errors.some((error) => error.includes("public HTTPS URL")));
});

test("snapshot guard는 기존 공개 시세 가용성이 20% 넘게 사라지는 수동 snapshot을 거부한다", () => {
  const quote = {
    status: "ok",
    freshness: "current",
    usageMode: "public",
    asOf: "2026-07-17",
    currency: "USD",
    price: 100,
    source: {
      name: "Licensed feed",
      url: "https://feed.example.com/source",
      licenseReference: "https://legal.example.com/license"
    }
  };
  const previousCompanies = Array.from({ length: 10 }, (_, index) =>
    company("US", index + 1, { marketData: quote })
  );
  const currentCompanies = previousCompanies.map((entry, index) =>
    index < 7 ? entry : { ...entry, marketData: undefined }
  );
  const report = validateSnapshot(
    snapshot(currentCompanies, {
      marketData: {
        coverage: { kr: 0, us: 7 },
        available: { kr: 0, us: 7 },
        preserved: { kr: 0, us: 0 },
        stale: { kr: 0, us: 0 }
      }
    }),
    {
      requiredCountries: ["US"],
      minimumCounts: { US: 1 },
      previousSnapshot: snapshot(previousCompanies)
    }
  );
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) => error.includes("market-data availability dropped")));
});
