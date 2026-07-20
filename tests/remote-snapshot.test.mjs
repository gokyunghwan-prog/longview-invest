import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  prepareRuntimeSnapshot,
  refreshRemoteFullSnapshot
} from "../lib/remote-snapshot.mjs";

const VALIDATOR_OPTIONS = { minimumCounts: { KR: 1 } };

function koreanCompany(index, overrides = {}) {
  return {
    id: `KR-${index}`,
    country: "KR",
    ticker: String(index).padStart(6, "0"),
    exchange: index % 2 ? "KOSPI" : "KOSDAQ",
    dataMode: "live",
    ...overrides
  };
}

function foreignCompany(index) {
  return {
    id: `JP-${index}`,
    country: "JP",
    ticker: `J${index}`,
    exchange: "TSE",
    dataMode: "live"
  };
}

function snapshot(updatedAt, companies, meta = {}) {
  const kr = companies.filter((company) => company.country === "KR").length;
  const timestampedCompanies = companies.map((company) => ({
    ...company,
    updatedAt: company.updatedAt || updatedAt
  }));
  return {
    meta: {
      schemaVersion: 3,
      dataMode: "live",
      updatedAt,
      coverage: { total: companies.length, kr },
      sources: [
        { name: "Open DART", url: "https://opendart.fss.or.kr/" },
        { name: "foreign feed", url: "https://example.com/foreign" }
      ],
      providers: [
        { country: "KR", status: "ok", companyCount: kr, provider: "Open DART" },
        { country: "JP", status: "ok", companyCount: companies.length - kr }
      ],
      ...meta
    },
    companies: timestampedCompanies
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "longview-remote-kr-"));
  return {
    root,
    config: {
      dataFile: path.join(root, "tracked.json"),
      runtimeDataFile: path.join(root, "runtime.json"),
      remoteSnapshotUrl:
        "https://raw.githubusercontent.com/example/longview/main/data/companies.json",
      remoteSnapshotToken: "",
      remoteSnapshotRefreshMs: 60_000
    }
  };
}

function jsonResponse(payload, { status = 200, etag = '"revision"' } = {}) {
  return new Response(status === 304 ? null : JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", etag }
  });
}

test("원격 혼합 스냅샷은 읽자마자 한국 기업만 런타임 캐시에 저장한다", async () => {
  const { root, config } = await fixture();
  try {
    const tracked = snapshot("2026-07-17T00:00:00.000Z", [
      koreanCompany(1),
      foreignCompany(1)
    ]);
    const trackedText = JSON.stringify(tracked);
    await writeFile(config.dataFile, trackedText, "utf8");
    await prepareRuntimeSnapshot(config, { validatorOptions: VALIDATOR_OPTIONS });

    const remote = snapshot("2026-07-18T00:00:00.000Z", [
      koreanCompany(1),
      koreanCompany(2),
      foreignCompany(2)
    ]);
    const result = await refreshRemoteFullSnapshot(config, {
      validatorOptions: VALIDATOR_OPTIONS,
      fetchImpl: async () => jsonResponse(remote)
    });

    assert.equal(result.success, true);
    assert.equal(result.changed, true);
    assert.equal(result.companyCount, 2);
    const saved = JSON.parse(await readFile(config.runtimeDataFile, "utf8"));
    assert.deepEqual(saved.companies.map((company) => company.country), ["KR", "KR"]);
    assert.deepEqual(saved.meta.coverage, { total: 2, kr: 2 });
    assert.equal(saved.meta.sources.some((source) => source.name === "foreign feed"), false);
    assert.equal(await readFile(config.dataFile, "utf8"), trackedText);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("급감하거나 오래된 원격 한국 스냅샷은 기존 캐시를 보존한다", async (t) => {
  for (const scenario of ["truncated", "older"]) {
    await t.test(scenario, async () => {
      const { root, config } = await fixture();
      try {
        const current = snapshot(
          "2026-07-18T00:00:00.000Z",
          Array.from({ length: 10 }, (_, index) => koreanCompany(index + 1))
        );
        await writeFile(config.dataFile, JSON.stringify(current), "utf8");
        await prepareRuntimeSnapshot(config, { validatorOptions: VALIDATOR_OPTIONS });
        const before = await readFile(config.runtimeDataFile, "utf8");
        const remote =
          scenario === "truncated"
            ? snapshot(
                "2026-07-19T00:00:00.000Z",
                Array.from({ length: 7 }, (_, index) => koreanCompany(index + 1))
              )
            : snapshot(
                "2026-07-17T00:00:00.000Z",
                Array.from({ length: 10 }, (_, index) => koreanCompany(index + 1))
              );

        const result = await refreshRemoteFullSnapshot(config, {
          validatorOptions: VALIDATOR_OPTIONS,
          fetchImpl: async () => jsonResponse(remote)
        });
        assert.equal(result.success, false);
        assert.equal(await readFile(config.runtimeDataFile, "utf8"), before);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("304 응답은 If-None-Match를 보내고 런타임 캐시를 다시 쓰지 않는다", async () => {
  const { root, config } = await fixture();
  try {
    const current = snapshot("2026-07-18T00:00:00.000Z", [koreanCompany(1)]);
    await writeFile(config.dataFile, JSON.stringify(current), "utf8");
    await prepareRuntimeSnapshot(config, { validatorOptions: VALIDATOR_OPTIONS });
    const before = await readFile(config.runtimeDataFile, "utf8");
    let receivedHeader;
    const result = await refreshRemoteFullSnapshot(config, {
      validatorOptions: VALIDATOR_OPTIONS,
      previousEtag: '"previous"',
      fetchImpl: async (_url, options) => {
        receivedHeader = options.headers["If-None-Match"];
        return jsonResponse(null, { status: 304, etag: '"previous"' });
      }
    });
    assert.equal(receivedHeader, '"previous"');
    assert.equal(result.success, true);
    assert.equal(result.notModified, true);
    assert.equal(result.changed, false);
    assert.equal(await readFile(config.runtimeDataFile, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("런타임 준비는 혼합 추적 파일을 한국 전용 캐시로 정규화한다", async () => {
  const { root, config } = await fixture();
  try {
    const tracked = snapshot("2026-07-18T00:00:00.000Z", [
      koreanCompany(1),
      foreignCompany(1)
    ]);
    await writeFile(config.dataFile, JSON.stringify(tracked), "utf8");
    const result = await prepareRuntimeSnapshot(config, {
      validatorOptions: VALIDATOR_OPTIONS
    });
    assert.equal(result.source, "local");
    const cached = JSON.parse(await readFile(config.runtimeDataFile, "utf8"));
    assert.deepEqual(cached.companies.map((company) => company.country), ["KR"]);
    assert.deepEqual(cached.meta.coverage, { total: 1, kr: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("추적 파일보다 새 혼합 런타임 캐시는 한국 기업만 남기고 사용한다", async () => {
  const { root, config } = await fixture();
  try {
    await writeFile(
      config.dataFile,
      JSON.stringify(snapshot("2026-07-17T00:00:00.000Z", [koreanCompany(1)])),
      "utf8"
    );
    await writeFile(
      config.runtimeDataFile,
      JSON.stringify(
        snapshot("2026-07-18T00:00:00.000Z", [koreanCompany(1), foreignCompany(1)])
      ),
      "utf8"
    );

    const result = await prepareRuntimeSnapshot(config, {
      validatorOptions: VALIDATOR_OPTIONS
    });
    assert.equal(result.source, "cache");
    const cached = JSON.parse(await readFile(config.runtimeDataFile, "utf8"));
    assert.deepEqual(cached.companies.map((company) => company.country), ["KR"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("한국 커버리지가 급감한 새 런타임 캐시는 추적 파일로 복구한다", async () => {
  const { root, config } = await fixture();
  try {
    const tracked = snapshot(
      "2026-07-17T00:00:00.000Z",
      Array.from({ length: 10 }, (_, index) => koreanCompany(index + 1))
    );
    const cached = snapshot(
      "2026-07-18T00:00:00.000Z",
      Array.from({ length: 7 }, (_, index) => koreanCompany(index + 1))
    );
    await writeFile(config.dataFile, JSON.stringify(tracked), "utf8");
    await writeFile(config.runtimeDataFile, JSON.stringify(cached), "utf8");

    const result = await prepareRuntimeSnapshot(config, {
      validatorOptions: VALIDATOR_OPTIONS
    });
    assert.equal(result.source, "local");
    const restored = JSON.parse(await readFile(config.runtimeDataFile, "utf8"));
    assert.equal(restored.companies.length, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("원격 주소는 GitHub raw HTTPS로 제한한다", async () => {
  const { root, config } = await fixture();
  try {
    const current = snapshot("2026-07-18T00:00:00.000Z", [koreanCompany(1)]);
    await writeFile(config.dataFile, JSON.stringify(current), "utf8");
    await prepareRuntimeSnapshot(config, { validatorOptions: VALIDATOR_OPTIONS });
    const result = await refreshRemoteFullSnapshot(
      { ...config, remoteSnapshotUrl: "https://example.com/companies.json" },
      {
        validatorOptions: VALIDATOR_OPTIONS,
        fetchImpl: async () => {
          throw new Error("fetch must not run");
        }
      }
    );
    assert.equal(result.success, false);
    assert.match(result.error, /raw\.githubusercontent\.com/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
