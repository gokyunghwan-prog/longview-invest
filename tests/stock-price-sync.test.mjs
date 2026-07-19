import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncStockPrices } from "../scripts/sync-stock-prices.mjs";

test("시세 키가 없어도 공시 snapshot을 보존하고 not_configured 상태를 기록한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "longview-price-sync-"));
  const dataFile = path.join(directory, "companies.json");
  const diagnostics = path.join(directory, "price-diagnostics.json");
  await writeFile(
    dataFile,
    JSON.stringify({
      meta: {
        schemaVersion: 2,
        dataMode: "live",
        updatedAt: "2026-07-17T00:00:00.000Z",
        coverage: { total: 1, kr: 1, us: 0 }
      },
      companies: [
        {
          id: "KR-005930",
          country: "KR",
          ticker: "005930",
          exchange: "KOSPI",
          dataMode: "live",
          metrics: {},
          history: []
        }
      ]
    }) + "\n",
    "utf8"
  );

  try {
    const result = await syncStockPrices(
      {
        dataFile,
        priceSyncDiagnosticsFile: diagnostics,
        dataGoKrApiKey: "",
        usLicensedPriceSnapshotUrl: "",
        usLicensedPriceSnapshotToken: ""
      },
      { now: new Date("2026-07-18T00:00:00.000Z") }
    );
    assert.equal(result.providers.every((provider) => provider.status === "not_configured"), true);
    const saved = JSON.parse(await readFile(dataFile, "utf8"));
    assert.equal(saved.meta.schemaVersion, 3);
    assert.deepEqual(saved.meta.marketData.coverage, { kr: 0, us: 0 });
    assert.equal(saved.companies[0].id, "KR-005930");
    await readFile(diagnostics, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("공급자가 미설정이면 기존 가격을 최신 성공으로 속이지 않고 오래된 가격을 stale로 분리한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "longview-price-stale-"));
  const dataFile = path.join(directory, "companies.json");
  const diagnostics = path.join(directory, "price-diagnostics.json");
  await writeFile(
    dataFile,
    JSON.stringify({
      meta: {
        schemaVersion: 3,
        marketData: {
          updatedAt: "2026-06-02T00:00:00.000Z",
          coverage: { kr: 1, us: 0 },
          providers: []
        }
      },
      companies: [
        {
          id: "KR-005930",
          country: "KR",
          ticker: "005930",
          marketData: {
            status: "ok",
            freshness: "current",
            usageMode: "public",
            asOf: "2026-06-01",
            price: 70_000,
            currency: "KRW",
            source: { name: "공식 테스트", url: "https://example.com/source" }
          }
        }
      ]
    }),
    "utf8"
  );

  try {
    const result = await syncStockPrices(
      {
        dataFile,
        priceSyncDiagnosticsFile: diagnostics,
        dataGoKrApiKey: "",
        usLicensedPriceSnapshotUrl: "",
        usLicensedPriceSnapshotToken: ""
      },
      { now: new Date("2026-07-18T00:00:00.000Z") }
    );
    const quote = result.dataset.companies[0].marketData;
    assert.equal(quote.status, "stale");
    assert.equal(quote.freshness, "stale");
    assert.deepEqual(result.dataset.meta.marketData.coverage, { kr: 0, us: 0 });
    assert.deepEqual(result.dataset.meta.marketData.available, { kr: 1, us: 0 });
    assert.deepEqual(result.dataset.meta.marketData.stale, { kr: 1, us: 0 });
    assert.equal(result.dataset.meta.marketData.updatedAt, "2026-06-02T00:00:00.000Z");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
