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
