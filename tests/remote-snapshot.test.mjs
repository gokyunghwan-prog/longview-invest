import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { refreshRemoteUsSnapshot } from "../lib/remote-snapshot.mjs";

test("GitHub 공개 스냅샷에서 미국 회사만 원자적으로 저장한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "longview-remote-"));
  try {
    const config = {
      remoteSnapshotUrl:
        "https://raw.githubusercontent.com/example/longview/main/data/companies.json",
      remoteSnapshotToken: "",
      dataFile: path.join(root, "companies.json"),
      usMarketDataFile: path.join(root, "us-companies.json"),
      remoteMarketDataFile: path.join(root, "remote-market-data.json")
    };
    const result = await refreshRemoteUsSnapshot(config, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            meta: {
              schemaVersion: 2,
              dataMode: "live",
              updatedAt: "2026-07-17T00:00:00.000Z",
              coverage: { total: 2, kr: 1, us: 1 },
              sources: [{ name: "공개 시세", url: "https://prices.example.com" }],
              marketData: {
                updatedAt: "2026-07-17T03:00:00.000Z",
                coverage: { kr: 1, us: 1 },
                providers: [{ id: "PUBLIC", provider: "공개 시세", status: "ok" }]
              }
            },
            companies: [
              {
                id: "KR-1",
                country: "KR",
                ticker: "000001",
                exchange: "KOSPI",
                dataMode: "live",
                marketData: {
                  usageMode: "public",
                  status: "ok",
                  freshness: "current",
                  currency: "KRW",
                  asOf: "2026-07-16",
                  price: 1000,
                  source: { name: "공개 시세", url: "https://prices.example.com/kr" }
                }
              },
              {
                id: "US-CIK1",
                country: "US",
                ticker: "TEST",
                exchange: "Nasdaq",
                dataMode: "live",
                marketData: {
                  usageMode: "public",
                  status: "ok",
                  freshness: "current",
                  currency: "USD",
                  asOf: "2026-07-16",
                  price: 20,
                  source: { name: "공개 시세", url: "https://prices.example.com/us" }
                }
              }
            ]
          }),
          { status: 200, headers: { etag: '"revision"' } }
        ),
      validatorOptions: { minimumCounts: { KR: 1, US: 1 } },
      now: new Date("2026-07-18T00:00:00.000Z")
    });
    assert.equal(result.success, true, result.error);
    assert.equal(result.companyCount, 1);
    const saved = JSON.parse(await readFile(config.usMarketDataFile, "utf8"));
    assert.deepEqual(saved.companies.map((company) => company.id), ["US-CIK1"]);
    assert.equal(saved.meta.marketData.providers[0].id, "PUBLIC");
    const remoteMarketData = JSON.parse(
      await readFile(config.remoteMarketDataFile, "utf8")
    );
    assert.deepEqual(
      remoteMarketData.companies.map((company) => company.id),
      ["KR-1", "US-CIK1"]
    );
    assert.deepEqual(remoteMarketData.meta.coverage, { total: 2, kr: 1, us: 1 });
    assert.equal(remoteMarketData.meta.remoteRevision, '"revision"');
    assert.equal(remoteMarketData.meta.marketData.providers[0].id, "PUBLIC");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("잘린 원격 미국 스냅샷은 기존 정상 파일을 덮어쓰지 않는다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "longview-remote-guard-"));
  const usMarketDataFile = path.join(root, "us-companies.json");
  const remoteMarketDataFile = path.join(root, "remote-market-data.json");
  const previous = {
    meta: { dataMode: "live", coverage: { total: 3, kr: 0, us: 3 } },
    companies: [1, 2, 3].map((index) => ({
      id: "US-PREV-" + index,
      country: "US",
      exchange: "NYSE",
      dataMode: "live"
    }))
  };
  await writeFile(usMarketDataFile, JSON.stringify(previous), "utf8");
  const previousRemoteMarketData = {
    meta: { schemaVersion: 1, coverage: { total: 1, kr: 0, us: 1 } },
    companies: [{ id: "US-PREV-1", country: "US", marketData: { usageMode: "public" } }]
  };
  await writeFile(remoteMarketDataFile, JSON.stringify(previousRemoteMarketData), "utf8");

  try {
    const result = await refreshRemoteUsSnapshot(
      {
        remoteSnapshotUrl:
          "https://raw.githubusercontent.com/example/longview/main/data/companies.json",
        remoteSnapshotToken: "",
        usMarketDataFile,
        remoteMarketDataFile
      },
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              meta: { dataMode: "live", coverage: { total: 1, kr: 0, us: 1 } },
              companies: [
                { id: "US-TRUNCATED", country: "US", exchange: "NYSE", dataMode: "live" }
              ]
            }),
            { status: 200 }
          ),
        validatorOptions: { requiredCountries: ["US"], minimumCounts: { US: 3 } }
      }
    );

    assert.equal(result.success, false);
    const preserved = JSON.parse(await readFile(usMarketDataFile, "utf8"));
    assert.deepEqual(
      preserved.companies.map((company) => company.id),
      previous.companies.map((company) => company.id)
    );
    assert.deepEqual(
      JSON.parse(await readFile(remoteMarketDataFile, "utf8")),
      previousRemoteMarketData
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("원격 주소는 GitHub raw HTTPS로 제한한다", async () => {
  await assert.rejects(
    refreshRemoteUsSnapshot({
      remoteSnapshotUrl: "https://example.com/companies.json",
      usMarketDataFile: "unused.json"
    }),
    /raw\.githubusercontent\.com/
  );
});
