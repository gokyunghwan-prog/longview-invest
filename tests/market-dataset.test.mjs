import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { mergeMarketDatasets } from "../lib/market-dataset.mjs";

function company(ticker) {
  return {
    id: "KR-" + ticker,
    name: ticker + " 기업",
    ticker,
    country: "KR",
    exchange: "KOSPI",
    sector: "테스트",
    dataMode: "live",
    metrics: {},
    history: [],
    disclosures: [],
    sourceUrl: "https://example.com/" + ticker,
    lineage: { provider: "Open DART", filingId: ticker },
    stale: false,
    updatedAt: "2026-07-17T00:00:00.000Z"
  };
}

function companyWithFinancials(ticker, { netIncome = 100, equity = 500 } = {}) {
  return {
    ...company(ticker),
    currency: "KRW",
    financials: {
      latest: {
        periodEnd: "2025-12-31",
        currency: "KRW",
        revenue: 1_000,
        netIncome,
        equity,
        freeCashFlow: 50
      }
    }
  };
}

function quote(asOf, price, { marketCap = 1_000, fetchedAt, source = "fixture" } = {}) {
  return {
    usageMode: "public",
    status: "ok",
    freshness: "current",
    currency: "KRW",
    asOf,
    fetchedAt: fetchedAt || asOf + "T23:00:00.000Z",
    price,
    marketCap,
    source: { name: source, url: "https://prices.example.com/" + source },
    valuation: { per: 999 }
  };
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), "utf8");
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "longview-kr-merge-"));
  return {
    root,
    config: {
      dataFile: path.join(root, "companies.json"),
      krMarketDataFile: path.join(root, "dart-market", "companies.json"),
      syncDiagnosticsFile: path.join(root, "sync-diagnostics.json")
    }
  };
}

test("한국 지역 스냅샷만 게시하고 국내 커버리지를 기록한다", async () => {
  const { root, config } = await fixture();
  try {
    await writeJson(config.dataFile, {
      meta: { updatedAt: "2026-07-16T00:00:00.000Z" },
      companies: [
        company("000001"),
        {
          ...company("FOREIGN"),
          id: "FOREIGN-1",
          country: "JP",
          exchange: "TSE"
        }
      ]
    });
    await writeJson(config.krMarketDataFile, {
      meta: { updatedAt: "2026-07-17T01:00:00.000Z" },
      companies: [company("005930")]
    });

    const merged = await mergeMarketDatasets(config, {
      now: new Date("2026-07-17T03:00:00.000Z")
    });
    assert.deepEqual(merged.meta.coverage, { total: 1, kr: 1 });
    assert.equal(merged.meta.dataMode, "live");
    assert.equal(merged.meta.sourceUpdatedAt, "2026-07-17T01:00:00.000Z");
    assert.equal(merged.meta.mergedAt, "2026-07-17T03:00:00.000Z");
    assert.deepEqual(merged.companies.map((item) => item.country), ["KR"]);
    const saved = JSON.parse(await readFile(config.dataFile, "utf8"));
    assert.equal(saved.companies.length, 1);
    assert.ok(saved.companies[0].score);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("한국 지역 파일이 깨지면 기존 국내 회사만 stale로 보존한다", async () => {
  const { root, config } = await fixture();
  try {
    await writeJson(config.dataFile, {
      meta: {},
      companies: [company("000001")]
    });
    await mkdir(path.dirname(config.krMarketDataFile), { recursive: true });
    await writeFile(config.krMarketDataFile, "{broken", "utf8");

    const merged = await mergeMarketDatasets(config);
    assert.equal(merged.companies.length, 1);
    assert.equal(merged.companies[0].stale, true);
    assert.equal(merged.meta.providers[0].country, "KR");
    assert.equal(merged.meta.providers[0].status, "failed");
    assert.equal(merged.meta.sync.status, "partial");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("새 한국 공식시장 병합에는 기존 데모 회사를 끼워 넣지 않는다", async () => {
  const { root, config } = await fixture();
  try {
    await writeJson(config.dataFile, {
      meta: {},
      companies: [{ ...company("DEMO"), dataMode: "demo" }]
    });
    await writeJson(config.krMarketDataFile, {
      meta: { updatedAt: "2026-07-17T01:00:00.000Z" },
      companies: [company("005930")]
    });

    const merged = await mergeMarketDatasets(config);
    assert.equal(merged.companies.some((item) => item.ticker === "DEMO"), false);
    assert.deepEqual(merged.meta.coverage, { total: 1, kr: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("지역·현재 국내 시세 중 최신 기준일을 선택하고 가치평가를 다시 만든다", async () => {
  const { root, config } = await fixture();
  try {
    const current = companyWithFinancials("005930", { netIncome: 100 });
    current.marketData = quote("2026-07-17", 110, {
      marketCap: 1_000,
      source: "current-kr"
    });
    await writeJson(config.dataFile, {
      meta: {
        sources: [
          {
            name: "금융위원회 주식시세정보",
            url: "https://www.data.go.kr/data/15094808/openapi.do"
          }
        ],
        marketData: {
          updatedAt: "2026-07-17T23:00:00.000Z",
          providers: [
            {
              code: "KR_PUBLIC",
              provider: "금융위원회 주식시세정보",
              status: "ok",
              asOf: "2026-07-17"
            }
          ]
        }
      },
      companies: [current]
    });

    const regional = companyWithFinancials("005930", { netIncome: 200 });
    regional.marketData = quote("2026-07-15", 80, {
      marketCap: 1_000,
      source: "regional-kr"
    });
    await writeJson(config.krMarketDataFile, {
      meta: { updatedAt: "2026-07-18T01:00:00.000Z" },
      companies: [regional]
    });

    const merged = await mergeMarketDatasets(config, {
      now: new Date("2026-07-18T03:00:00.000Z")
    });
    const result = merged.companies[0];
    assert.equal(result.marketData.price, 110);
    assert.equal(result.marketData.source.name, "current-kr");
    assert.equal(result.marketData.valuation.per, 5);
    assert.deepEqual(merged.meta.marketData.coverage, { kr: 1 });
    assert.deepEqual(merged.meta.marketData.available, { kr: 1 });
    assert.deepEqual(merged.meta.marketData.preserved, { kr: 0 });
    assert.deepEqual(merged.meta.marketData.stale, { kr: 0 });
    assert.equal(
      merged.meta.marketData.providers.some((provider) => provider.code === "KR_PUBLIC"),
      true
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("병합 시 오래된 국내 공개 시세를 stale로 표시하고 커버리지를 재계산한다", async () => {
  const { root, config } = await fixture();
  try {
    const current = companyWithFinancials("000001");
    current.marketData = quote("2026-07-01", 100, { source: "old-kr" });
    await writeJson(config.dataFile, {
      meta: { marketData: { coverage: { kr: 999 } } },
      companies: [current]
    });
    await writeJson(config.krMarketDataFile, {
      meta: { updatedAt: "2026-07-18T01:00:00.000Z" },
      companies: [companyWithFinancials("000001")]
    });

    const merged = await mergeMarketDatasets(config, {
      now: new Date("2026-07-18T03:00:00.000Z")
    });
    assert.equal(merged.companies[0].marketData.status, "stale");
    assert.equal(merged.companies[0].marketData.freshness, "stale");
    assert.deepEqual(merged.meta.marketData.coverage, { kr: 0 });
    assert.deepEqual(merged.meta.marketData.available, { kr: 1 });
    assert.deepEqual(merged.meta.marketData.preserved, { kr: 0 });
    assert.deepEqual(merged.meta.marketData.stale, { kr: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
