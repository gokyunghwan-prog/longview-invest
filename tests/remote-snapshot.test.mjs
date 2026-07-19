import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  prepareRuntimeSnapshot,
  refreshRemoteFullSnapshot,
  refreshRemoteUsSnapshot
} from "../lib/remote-snapshot.mjs";

const SMALL_FULL_VALIDATOR = { minimumCounts: { KR: 1, US: 1 } };

function fullSnapshot(updatedAt, { kr = 1, us = 1, prefix = "SNAPSHOT" } = {}) {
  const companies = [
    ...Array.from({ length: kr }, (_, index) => ({
      id: `${prefix}-KR-${index + 1}`,
      country: "KR",
      exchange: index % 2 ? "KOSDAQ" : "KOSPI",
      dataMode: "live"
    })),
    ...Array.from({ length: us }, (_, index) => ({
      id: `${prefix}-US-${index + 1}`,
      country: "US",
      exchange: index % 2 ? "NYSE" : "NASDAQ",
      dataMode: "live"
    }))
  ];
  return {
    meta: {
      schemaVersion: 2,
      dataMode: "live",
      updatedAt,
      coverage: { total: companies.length, kr, us }
    },
    companies
  };
}

function fullConfig(root) {
  return {
    remoteSnapshotUrl:
      "https://raw.githubusercontent.com/example/longview/main/data/companies.json",
    remoteSnapshotToken: "",
    dataFile: path.join(root, "tracked-companies.json"),
    runtimeDataFile: path.join(root, ".cache", "companies.json")
  };
}

async function writeRuntimeFixture(config, text) {
  await mkdir(path.dirname(config.runtimeDataFile), { recursive: true });
  await writeFile(config.runtimeDataFile, text, "utf8");
}

test("유효한 원격 전체 스냅샷은 런타임 캐시에만 저장한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "longview-runtime-refresh-"));
  try {
    const config = fullConfig(root);
    const tracked = fullSnapshot("2026-07-17T00:00:00.000Z", { prefix: "TRACKED" });
    const remote = fullSnapshot("2026-07-18T00:00:00.000Z", { prefix: "REMOTE" });
    const trackedText = JSON.stringify(tracked) + "\n";
    const remoteText = JSON.stringify(remote) + "\n";
    await writeFile(config.dataFile, trackedText, "utf8");

    const result = await refreshRemoteFullSnapshot(config, {
      fetchImpl: async () =>
        new Response(remoteText, {
          status: 200,
          headers: { etag: '"remote-v2"' }
        }),
      validatorOptions: SMALL_FULL_VALIDATOR
    });

    assert.deepEqual(result, {
      attempted: true,
      success: true,
      changed: true,
      etag: '"remote-v2"',
      status: 200,
      companyCount: 2,
      updatedAt: "2026-07-18T00:00:00.000Z"
    });
    assert.equal(await readFile(config.runtimeDataFile, "utf8"), remoteText);
    assert.equal(await readFile(config.dataFile, "utf8"), trackedText);
    const prepared = await prepareRuntimeSnapshot(config, {
      validatorOptions: SMALL_FULL_VALIDATOR
    });
    assert.equal(prepared.source, "cache");
    assert.equal(prepared.etag, '"remote-v2"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("잘리거나 오래된 원격 전체 스냅샷은 기존 캐시를 보존한다", async (t) => {
  for (const scenario of ["truncated", "older"]) {
    await t.test(scenario, async () => {
      const root = await mkdtemp(path.join(tmpdir(), `longview-runtime-${scenario}-`));
      try {
        const config = fullConfig(root);
        const current = fullSnapshot("2026-07-18T00:00:00.000Z", {
          kr: 2,
          us: 2,
          prefix: "CURRENT"
        });
        const candidate =
          scenario === "truncated"
            ? fullSnapshot("2026-07-19T00:00:00.000Z", {
                kr: 1,
                us: 1,
                prefix: "TRUNCATED"
              })
            : fullSnapshot("2026-07-17T00:00:00.000Z", {
                kr: 2,
                us: 2,
                prefix: "OLDER"
              });
        const currentText = JSON.stringify(current) + "\n";
        await writeRuntimeFixture(config, currentText);

        const result = await refreshRemoteFullSnapshot(config, {
          fetchImpl: async () => new Response(JSON.stringify(candidate), { status: 200 }),
          validatorOptions: SMALL_FULL_VALIDATOR
        });

        assert.equal(result.success, false);
        assert.equal(result.changed, false);
        assert.equal(await readFile(config.runtimeDataFile, "utf8"), currentText);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("304 응답은 If-None-Match를 보내고 런타임 캐시를 쓰지 않는다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "longview-runtime-etag-"));
  try {
    const config = fullConfig(root);
    const cachedText = JSON.stringify(
      fullSnapshot("2026-07-18T00:00:00.000Z", { prefix: "CACHED" })
    );
    await writeRuntimeFixture(config, cachedText);
    let requestHeaders;

    const result = await refreshRemoteFullSnapshot(config, {
      etag: '"cached-v1"',
      fetchImpl: async (_url, options) => {
        requestHeaders = options.headers;
        return new Response(null, {
          status: 304,
          headers: { etag: '"cached-v1"' }
        });
      },
      validatorOptions: SMALL_FULL_VALIDATOR
    });

    assert.equal(requestHeaders["If-None-Match"], '"cached-v1"');
    assert.equal(result.success, true);
    assert.equal(result.changed, false);
    assert.equal(result.notModified, true);
    assert.equal(result.status, 304);
    assert.equal(await readFile(config.runtimeDataFile, "utf8"), cachedText);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("런타임 준비는 캐시 부재·구버전·손상 시 추적 파일로 복구한다", async (t) => {
  for (const scenario of ["absent", "older", "corrupt"]) {
    await t.test(scenario, async () => {
      const root = await mkdtemp(path.join(tmpdir(), `longview-runtime-prepare-${scenario}-`));
      try {
        const config = fullConfig(root);
        const trackedText = JSON.stringify(
          fullSnapshot("2026-07-18T00:00:00.000Z", { prefix: "TRACKED" })
        );
        await writeFile(config.dataFile, trackedText, "utf8");
        if (scenario === "older") {
          await writeRuntimeFixture(
            config,
            JSON.stringify(
              fullSnapshot("2026-07-17T00:00:00.000Z", { prefix: "OLD-CACHE" })
            )
          );
        } else if (scenario === "corrupt") {
          await writeRuntimeFixture(config, "{not-json");
        }

        const result = await prepareRuntimeSnapshot(config, {
          validatorOptions: SMALL_FULL_VALIDATOR
        });

        assert.deepEqual(result, {
          dataFile: config.runtimeDataFile,
          source: "local",
          etag: null
        });
        assert.equal(await readFile(config.runtimeDataFile, "utf8"), trackedText);
        assert.equal(await readFile(config.dataFile, "utf8"), trackedText);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("추적 파일보다 새 런타임 캐시는 그대로 사용한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "longview-runtime-prepare-newer-"));
  try {
    const config = fullConfig(root);
    const trackedText = JSON.stringify(
      fullSnapshot("2026-07-17T00:00:00.000Z", { prefix: "TRACKED" })
    );
    const cachedText = JSON.stringify(
      fullSnapshot("2026-07-18T00:00:00.000Z", { prefix: "CACHED" })
    );
    await writeFile(config.dataFile, trackedText, "utf8");
    await writeRuntimeFixture(config, cachedText);

    const result = await prepareRuntimeSnapshot(config, {
      validatorOptions: SMALL_FULL_VALIDATOR
    });

    assert.equal(result.source, "cache");
    assert.equal(result.dataFile, config.runtimeDataFile);
    assert.equal(await readFile(config.runtimeDataFile, "utf8"), cachedText);
    assert.equal(await readFile(config.dataFile, "utf8"), trackedText);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("날짜만 새롭고 커버리지가 급감한 런타임 캐시는 추적 파일로 복구한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "longview-runtime-prepare-drop-"));
  try {
    const config = fullConfig(root);
    const trackedText = JSON.stringify(
      fullSnapshot("2026-07-17T00:00:00.000Z", { kr: 2, us: 2, prefix: "TRACKED" })
    );
    const droppedText = JSON.stringify(
      fullSnapshot("2026-07-18T00:00:00.000Z", { kr: 1, us: 1, prefix: "DROPPED" })
    );
    await writeFile(config.dataFile, trackedText, "utf8");
    await writeRuntimeFixture(config, droppedText);

    const result = await prepareRuntimeSnapshot(config, {
      validatorOptions: SMALL_FULL_VALIDATOR
    });

    assert.equal(result.source, "local");
    assert.equal(await readFile(config.runtimeDataFile, "utf8"), trackedText);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
