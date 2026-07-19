import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { mergeMarketDatasets } from "../lib/market-dataset.mjs";

function company(country, ticker) {
  return {
    id: country + "-" + ticker,
    name: ticker + " Company",
    ticker,
    country,
    exchange: country === "KR" ? "KOSPI" : "NYSE",
    sector: "테스트",
    dataMode: "live",
    metrics: {},
    history: [],
    disclosures: [],
    sourceUrl: "https://example.com/" + ticker,
    lineage: { provider: "test", filingId: ticker },
    stale: false,
    updatedAt: "2026-07-17T00:00:00.000Z"
  };
}

function companyWithFinancials(country, ticker, { netIncome = 100, equity = 500 } = {}) {
  return {
    ...company(country, ticker),
    currency: country === "KR" ? "KRW" : "USD",
    financials: {
      latest: {
        periodEnd: "2025-12-31",
        currency: country === "KR" ? "KRW" : "USD",
        revenue: 1000,
        netIncome,
        equity,
        freeCashFlow: 50
      }
    }
  };
}

function quote(country, asOf, price, { marketCap = 1000, fetchedAt, source = "fixture" } = {}) {
  return {
    usageMode: "public",
    status: "ok",
    freshness: "current",
    currency: country === "KR" ? "KRW" : "USD",
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
  const root = await mkdtemp(path.join(tmpdir(), "longview-merge-"));
  return {
    root,
    config: {
      dataFile: path.join(root, "companies.json"),
      krMarketDataFile: path.join(root, "dart-market", "companies.json"),
      usMarketDataFile: path.join(root, "us-companies.json"),
      remoteMarketDataFile: path.join(root, "remote-market-data.json"),
      syncDiagnosticsFile: path.join(root, "sync-diagnostics.json")
    }
  };
}

test("지역 스냅샷을 국가별로 병합하고 전체 커버리지를 기록한다", async () => {
  const { root, config } = await fixture();
  try {
    await writeJson(config.dataFile, { meta: {}, companies: [] });
    await writeJson(config.krMarketDataFile, {
      meta: { updatedAt: "2026-07-17T01:00:00.000Z" },
      companies: [company("KR", "005930")]
    });
    await writeJson(config.usMarketDataFile, {
      meta: { updatedAt: "2026-07-17T02:00:00.000Z" },
      companies: [company("US", "CIK0001"), company("US", "CIK0002")]
    });

    const merged = await mergeMarketDatasets(config, {
      now: new Date("2026-07-17T03:00:00.000Z")
    });
    assert.deepEqual(merged.meta.coverage, { total: 3, kr: 1, us: 2 });
    assert.equal(merged.meta.dataMode, "live");
    assert.equal(merged.meta.sourceUpdatedAt, "2026-07-17T02:00:00.000Z");
    assert.equal(merged.meta.updatedAt, "2026-07-17T02:00:00.000Z");
    assert.equal(merged.meta.mergedAt, "2026-07-17T03:00:00.000Z");
    const saved = JSON.parse(await readFile(config.dataFile, "utf8"));
    assert.equal(saved.companies.length, 3);
    assert.ok(saved.companies.every((item) => item.score));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("지역 갱신 실패나 깨진 지역 파일은 기존 회사를 지우지 않고 stale로 보존한다", async () => {
  const { root, config } = await fixture();
  try {
    await writeJson(config.dataFile, {
      meta: {},
      companies: [company("KR", "000001"), company("US", "CIK0003")]
    });
    await writeFile(config.krMarketDataFile, "{broken", "utf8").catch(async () => {
      await mkdir(path.dirname(config.krMarketDataFile), { recursive: true });
      await writeFile(config.krMarketDataFile, "{broken", "utf8");
    });

    const merged = await mergeMarketDatasets(config, {
      runs: {
        US: {
          provider: "SEC EDGAR bulk",
          attempted: true,
          success: false,
          error: "HTTP 403 test@example.com"
        }
      }
    });
    assert.equal(merged.companies.length, 2);
    assert.ok(merged.companies.every((item) => item.stale));
    assert.equal(merged.meta.sync.status, "partial");
    assert.ok(
      merged.meta.sync.errors.every((item) => !item.message.includes("test@example.com"))
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("공식 전체시장 병합에는 기존 데모 회사를 끼워 넣지 않는다", async () => {
  const { root, config } = await fixture();
  try {
    await writeJson(config.dataFile, {
      meta: {},
      companies: [company("US", "LIVE"), company("US", "DEMO")]
    });
    const current = JSON.parse(await readFile(config.dataFile, "utf8"));
    current.companies[1].dataMode = "demo";
    await writeJson(config.dataFile, current);
    await writeJson(config.krMarketDataFile, {
      meta: { updatedAt: "2026-07-17T01:00:00.000Z" },
      companies: [company("KR", "005930")]
    });

    const merged = await mergeMarketDatasets(config);
    assert.equal(merged.companies.some((item) => item.ticker === "DEMO"), false);
    assert.equal(merged.meta.coverage.us, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("지역·현재·원격 공개 시세 중 최신 asOf만 선택하고 valuation과 계보를 다시 만든다", async () => {
  const { root, config } = await fixture();
  try {
    const currentKr = companyWithFinancials("KR", "005930", { netIncome: 100 });
    currentKr.marketData = quote("KR", "2026-07-17", 110, {
      marketCap: 1000,
      source: "current-kr"
    });
    const currentUs = companyWithFinancials("US", "CIK0001", { netIncome: 100 });
    currentUs.marketData = quote("US", "2026-07-14", 40, {
      marketCap: 1000,
      source: "current-us"
    });
    await writeJson(config.dataFile, {
      meta: {
        sources: [{ name: "기존 시세", url: "https://prices.example.com/current" }],
        marketData: {
          updatedAt: "2026-07-17T23:00:00.000Z",
          providers: [{ id: "CURRENT", provider: "기존 시세", status: "ok", asOf: "2026-07-17" }]
        }
      },
      companies: [currentKr, currentUs]
    });

    const regionalKr = companyWithFinancials("KR", "005930", { netIncome: 200 });
    regionalKr.marketData = quote("KR", "2026-07-15", 80, {
      marketCap: 1000,
      source: "regional-kr"
    });
    const regionalUs = companyWithFinancials("US", "CIK0001", { netIncome: 50 });
    regionalUs.marketData = quote("US", "2026-07-15", 50, {
      marketCap: 1100,
      source: "regional-us"
    });
    await writeJson(config.krMarketDataFile, {
      meta: { updatedAt: "2026-07-18T01:00:00.000Z" },
      companies: [regionalKr]
    });
    await writeJson(config.usMarketDataFile, {
      meta: { updatedAt: "2026-07-18T02:00:00.000Z" },
      companies: [regionalUs]
    });

    await writeJson(config.remoteMarketDataFile, {
      meta: {
        fetchedAt: "2026-07-18T02:30:00.000Z",
        sourceUpdatedAt: "2026-07-18T02:00:00.000Z",
        remoteRevision: '"remote-etag"',
        sourceUrl: "https://raw.githubusercontent.com/example/repo/main/data/companies.json",
        coverage: { total: 2, kr: 1, us: 1 },
        sources: [{ name: "원격 시세", url: "https://prices.example.com/remote" }],
        marketData: {
          updatedAt: "2026-07-18T02:30:00.000Z",
          providers: [{ id: "REMOTE", provider: "원격 시세", status: "ok", asOf: "2026-07-17" }]
        }
      },
      companies: [
        {
          id: currentKr.id,
          country: "KR",
          marketData: quote("KR", "2026-07-16", 90, {
            marketCap: 1000,
            source: "remote-older-kr"
          })
        },
        {
          id: currentUs.id,
          country: "US",
          marketData: quote("US", "2026-07-17", 60, {
            marketCap: 1200,
            source: "remote-newer-us"
          })
        }
      ]
    });

    const merged = await mergeMarketDatasets(config, {
      now: new Date("2026-07-18T03:00:00.000Z")
    });
    const kr = merged.companies.find((item) => item.id === currentKr.id);
    const us = merged.companies.find((item) => item.id === currentUs.id);
    assert.equal(kr.marketData.price, 110, "오래된 원격 KR 시세가 최신 로컬을 덮지 않는다");
    assert.equal(kr.marketData.source.name, "current-kr");
    assert.equal(kr.marketData.valuation.per, 5, "새 지역 재무로 valuation을 재계산한다");
    assert.equal(us.marketData.price, 60, "더 최신인 원격 US 시세를 선택한다");
    assert.equal(us.marketData.source.name, "remote-newer-us");
    assert.equal(us.marketData.valuation.per, 24);
    assert.deepEqual(merged.meta.marketData.coverage, { kr: 1, us: 1 });
    assert.deepEqual(merged.meta.marketData.available, { kr: 1, us: 1 });
    assert.deepEqual(merged.meta.marketData.preserved, { kr: 0, us: 0 });
    assert.deepEqual(merged.meta.marketData.stale, { kr: 0, us: 0 });
    assert.equal(merged.meta.marketData.remoteSnapshot.remoteRevision, '"remote-etag"');
    assert.ok(merged.meta.marketData.providers.some((provider) => provider.id === "REMOTE"));
    assert.ok(merged.meta.sources.some((source) => source.name === "원격 시세"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("병합 시 오래된 공개 시세를 stale로 표시하고 coverage를 최종 회사에서 재계산한다", async () => {
  const { root, config } = await fixture();
  try {
    const kr = companyWithFinancials("KR", "000001");
    kr.marketData = quote("KR", "2026-07-01", 100, { source: "old-kr" });
    const us = companyWithFinancials("US", "CIK0002");
    us.marketData = quote("US", "2026-07-17", 50, { source: "recent-us" });
    await writeJson(config.dataFile, {
      meta: { marketData: { coverage: { kr: 999, us: 999 } } },
      companies: [kr, us]
    });
    await writeJson(config.krMarketDataFile, {
      meta: { updatedAt: "2026-07-18T01:00:00.000Z" },
      companies: [companyWithFinancials("KR", "000001")]
    });
    await writeJson(config.usMarketDataFile, {
      meta: { updatedAt: "2026-07-18T02:00:00.000Z" },
      companies: [companyWithFinancials("US", "CIK0002")]
    });

    const merged = await mergeMarketDatasets(config, {
      now: new Date("2026-07-18T03:00:00.000Z")
    });
    const mergedKr = merged.companies.find((item) => item.country === "KR");
    const mergedUs = merged.companies.find((item) => item.country === "US");
    assert.equal(mergedKr.marketData.status, "stale");
    assert.equal(mergedKr.marketData.freshness, "stale");
    assert.equal(mergedUs.marketData.status, "ok");
    assert.deepEqual(merged.meta.marketData.coverage, { kr: 0, us: 1 });
    assert.deepEqual(merged.meta.marketData.available, { kr: 1, us: 1 });
    assert.deepEqual(merged.meta.marketData.preserved, { kr: 0, us: 0 });
    assert.deepEqual(merged.meta.marketData.stale, { kr: 1, us: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
