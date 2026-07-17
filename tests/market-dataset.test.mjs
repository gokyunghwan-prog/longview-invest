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
