import assert from "node:assert/strict";
import test from "node:test";

import {
  assertValidSnapshot,
  validateSnapshot
} from "../lib/snapshot-validator.mjs";

function company(index, overrides = {}) {
  return {
    id: `KR-${index}`,
    country: "KR",
    exchange: "KOSPI",
    dataMode: "live",
    ...overrides
  };
}

function snapshot(companies, meta = {}) {
  const kr = companies.filter((item) => item.country === "KR").length;
  return {
    meta: {
      dataMode: "live",
      coverage: { total: companies.length, kr },
      ...meta
    },
    companies
  };
}

test("게시 가능한 한국 스냅샷은 작은 fixture 기준으로 검증된다", () => {
  const report = assertValidSnapshot(snapshot([company(1)]), {
    minimumCounts: { KR: 1 }
  });
  assert.equal(report.valid, true);
  assert.deepEqual(report.counts, { total: 1, KR: 1 });
});

test("중복 ID·데모·잘못된 거래소·커버리지 불일치를 거부한다", () => {
  const report = validateSnapshot(
    snapshot(
      [
        company(1, { id: "DUPLICATE", dataMode: "demo" }),
        company(2, { id: "DUPLICATE", exchange: "OTC" })
      ],
      { coverage: { total: 99, kr: 0 } }
    ),
    { minimumCounts: { KR: 1 } }
  );

  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) => error.includes("Duplicate company id")));
  assert.ok(report.errors.some((error) => error.includes("demo data")));
  assert.ok(report.errors.some((error) => error.includes("exchange is invalid")));
  assert.ok(report.errors.some((error) => error.includes("coverage.total")));
});

test("한국 외 국가가 현재 스냅샷에 남으면 거부한다", () => {
  const report = validateSnapshot(
    snapshot([
      company(1),
      { ...company(2), id: "JP-2", country: "JP", exchange: "TSE" }
    ]),
    { minimumCounts: { KR: 1 } }
  );
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) => error.includes("country must be KR")));
});

test("절대 최소치와 신뢰 가능한 이전 한국 기준 대비 급락을 거부한다", () => {
  const tooSmall = validateSnapshot(snapshot([company(1)]), {
    minimumCounts: { KR: 3 }
  });
  assert.equal(tooSmall.valid, false);
  assert.ok(tooSmall.errors.some((error) => error.includes("safe minimum")));

  const previous = snapshot(Array.from({ length: 10 }, (_, index) => company(index + 1)));
  const current = snapshot(Array.from({ length: 7 }, (_, index) => company(index + 1)));
  const dropped = validateSnapshot(current, {
    minimumCounts: { KR: 1 },
    previousSnapshot: previous,
    maxDropFraction: 0.2
  });
  assert.equal(dropped.valid, false);
  assert.ok(dropped.errors.some((error) => error.includes("dropped from 10 to 7")));
});

test("직전 혼합 스냅샷의 타국 제거는 한국 급락으로 계산하지 않는다", () => {
  const korean = Array.from({ length: 10 }, (_, index) => company(index + 1));
  const previous = snapshot([
    ...korean,
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `JP-${index + 1}`,
      country: "JP",
      exchange: "TSE",
      dataMode: "live"
    }))
  ]);
  const report = validateSnapshot(snapshot(korean), {
    minimumCounts: { KR: 1 },
    previousSnapshot: previous,
    maxDropFraction: 0.2
  });
  assert.equal(report.valid, true, report.errors.join("\n"));
});

test("직렬화된 출력 크기 제한을 강제한다", () => {
  const report = validateSnapshot(snapshot([company(1)]), {
    minimumCounts: { KR: 1 },
    maxSnapshotBytes: 10
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) => error.includes("safe limit")));
});

test("시세 스키마는 날짜·상태·통화·OHLC·국내 커버리지를 엄격히 검증한다", () => {
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
      [company(1, { marketData: validQuote })],
      {
        marketData: {
          coverage: { kr: 1 },
          available: { kr: 1 },
          preserved: { kr: 0 },
          stale: { kr: 0 }
        }
      }
    ),
    { minimumCounts: { KR: 1 } }
  );
  assert.equal(valid.valid, true, valid.errors.join("\n"));

  const invalid = validateSnapshot(
    snapshot(
      [
        company(1, {
          marketData: {
            ...validQuote,
            asOf: "2026-02-30",
            high: 60_000,
            source: { name: "unsafe", url: "https://user:secret@example.com/feed" }
          }
        })
      ],
      { marketData: { coverage: { kr: 1 } } }
    ),
    { minimumCounts: { KR: 1 } }
  );
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes("ISO date")));
  assert.ok(invalid.errors.some((error) => error.includes("high is below")));
  assert.ok(invalid.errors.some((error) => error.includes("public HTTPS URL")));
});

test("기존 국내 공개 시세 가용성이 20% 넘게 사라지는 수동 스냅샷을 거부한다", () => {
  const quote = {
    status: "ok",
    freshness: "current",
    usageMode: "public",
    asOf: "2026-07-17",
    currency: "KRW",
    price: 100,
    source: {
      name: "금융위원회 주식시세정보",
      url: "https://www.data.go.kr/data/15094808/openapi.do"
    }
  };
  const previousCompanies = Array.from({ length: 10 }, (_, index) =>
    company(index + 1, { marketData: quote })
  );
  const currentCompanies = previousCompanies.map((entry, index) =>
    index < 7 ? entry : { ...entry, marketData: undefined }
  );
  const report = validateSnapshot(
    snapshot(currentCompanies, {
      marketData: {
        coverage: { kr: 7 },
        available: { kr: 7 },
        preserved: { kr: 0 },
        stale: { kr: 0 }
      }
    }),
    {
      minimumCounts: { KR: 1 },
      previousSnapshot: snapshot(previousCompanies)
    }
  );
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) => error.includes("market-data availability dropped")));
});
