import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLongviewApp } from "../server.mjs";

const UPDATED_AT = "2026-07-17T00:00:00.000Z";

function currentMarketData(valuation = {}) {
  return {
    status: "ok",
    freshness: "current",
    usageMode: "official_disclosure_derived",
    currency: "KRW",
    asOf: "2026-07-16",
    price: 10_000,
    marketCap: 1_000_000,
    valuation: {
      per: 8,
      pbr: 0.7,
      psr: 0.5,
      fcfYield: 10,
      issues: [],
      ...valuation
    }
  };
}

function company(index, overrides = {}) {
  const ticker = String(index).padStart(6, "0");
  return {
    id: "KR-" + ticker,
    name: "테스트 기업 " + ticker,
    nameEn: "Test Company " + ticker,
    ticker,
    country: "KR",
    exchange: "KOSPI",
    sector: index % 2 ? "정보기술" : "소재",
    period: "2025 사업연도",
    statementBasis: "K-IFRS · 연결재무제표",
    dataMode: "live",
    marketData: currentMarketData(),
    metrics: {
      roe: 25,
      operatingMargin: 25,
      netMargin: 20,
      revenueGrowth: 20,
      operatingIncomeGrowth: 25,
      debtRatio: 50,
      currentRatio: 200,
      fcfMargin: 20,
      cashConversion: 130,
      positiveIncomeYears: 3,
      revenueStability: 95,
      per: null
    },
    history: [
      { label: "2023", revenue: 100, operatingIncome: 20 },
      { label: "2024", revenue: 120, operatingIncome: 24 },
      { label: "2025", revenue: 150, operatingIncome: 32 }
    ],
    historyUnit: "KRW billion",
    disclosures: [
      {
        id: "filing-" + ticker,
        title: "사업보고서",
        form: "사업보고서",
        date: "2026-07-10",
        url: "https://example.com/filing/" + ticker
      }
    ],
    latestDisclosure: { date: "2026-07-10" },
    sourceUrl: "https://example.com/company/" + ticker,
    lineage: { provider: "Open DART", filingId: "filing-" + ticker },
    validation: { score: 100 },
    riskFlags: [],
    stale: false,
    updatedAt: UPDATED_AT,
    ...overrides
  };
}

function snapshot(companies, updatedAt = UPDATED_AT) {
  return {
    meta: {
      schemaVersion: 1,
      dataMode: "live",
      updatedAt,
      note: "API 테스트",
      sources: [],
      sync: {
        status: "partial",
        successful: companies.length,
        attempted: companies.length + 1,
        failed: 1,
        errors: [{ company: "숨김", message: "응답에서 제외" }]
      }
    },
    companies
  };
}

test("overview, paginated list, detail, ETag와 reload가 함께 동작한다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "longview-api-"));
  const dataFile = path.join(directory, "companies.json");
  const publicDir = path.join(directory, "public");
  await mkdir(publicDir);
  let companies = [company(1), company(2), company(3, { country: "US", id: "US-TEST" })];
  await writeFile(dataFile, JSON.stringify(snapshot(companies)), "utf8");

  const config = {
    dataFile,
    publicDir,
    host: "127.0.0.1",
    port: 0,
    schedulerEnabled: false,
    scheduleHourKst: 7,
    syncToken: "test-token"
  };
  const syncRunner = async () => {
    companies = [...companies, company(4), company(5)];
    await writeFile(
      dataFile,
      JSON.stringify(snapshot(companies, "2026-07-19T00:00:00.000Z")),
      "utf8"
    );
    throw new Error("의도한 동기화 실패");
  };
  const app = await createLongviewApp(config, {
    storeOptions: {
      refreshIntervalMs: 0,
      now: () => Date.parse("2026-07-19T00:00:00.000Z")
    },
    syncRunner
  });
  const address = await app.listen();
  const baseUrl = "http://127.0.0.1:" + address.port;
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const overviewResponse = await fetch(baseUrl + "/api/overview");
  assert.equal(overviewResponse.status, 200);
  assert.match(overviewResponse.headers.get("cache-control"), /max-age=60/);
  assert.equal(overviewResponse.headers.get("x-frame-options"), "DENY");
  const etag = overviewResponse.headers.get("etag");
  const overview = await overviewResponse.json();
  assert.equal(overview.summary.companies, 3);
  assert.equal("errors" in overview.meta.sync, false);

  const notModified = await fetch(baseUrl + "/api/overview", {
    headers: { "If-None-Match": etag }
  });
  assert.equal(notModified.status, 304);

  const methodologyResponse = await fetch(baseUrl + "/api/methodology");
  assert.equal(methodologyResponse.status, 200);
  const methodology = await methodologyResponse.json();
  assert.equal(methodology.modelVersion, "2.0.0");
  assert.equal(methodology.valuationIncluded, true);
  assert.equal(methodology.valuationDisplayed, true);
  assert.equal(methodology.candidateRules.minimumTotal, 75);
  assert.equal(methodology.candidateRules.componentMinimums.valuation, 60);
  assert.deepEqual(methodology.rankingOrder.slice(0, 2), [
    "candidateEligibility",
    "evaluationReadiness"
  ]);
  assert.deepEqual(
    methodology.groups.map(({ key, weight }) => ({ key, weight })),
    [
      { key: "valuation", weight: 30 },
      { key: "longGrowth", weight: 35 },
      { key: "quality", weight: 20 },
      { key: "safety", weight: 15 }
    ]
  );

  const listResponse = await fetch(
    baseUrl + "/api/companies?country=KR&sort=name&page=2&pageSize=1"
  );
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.pagination.total, 2);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].position, 2);
  assert.equal("disclosures" in list.items[0], false);

  const detailResponse = await fetch(baseUrl + "/api/companies/" + encodeURIComponent("US-TEST"));
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.id, "US-TEST");
  assert.equal(detail.disclosures.length, 1);
  assert.equal((await fetch(baseUrl + "/api/companies/US-MISSING")).status, 404);
  assert.equal((await fetch(baseUrl + "/api/companies?pageSize=101")).status, 400);

  companies = [...companies, company(6)];
  await writeFile(
    dataFile,
    JSON.stringify(snapshot(companies, "2026-07-18T00:00:00.000Z")),
    "utf8"
  );
  const refreshed = await (await fetch(baseUrl + "/api/overview")).json();
  assert.equal(refreshed.summary.companies, 4);
  assert.notEqual(refreshed.revision, overview.revision);

  const failedSync = await fetch(baseUrl + "/api/sync", {
    method: "POST",
    headers: { Authorization: "Bearer test-token" }
  });
  assert.equal(failedSync.status, 502);
  const afterFailedSync = await (await fetch(baseUrl + "/api/overview")).json();
  assert.equal(afterFailedSync.summary.companies, 6);

  const health = await (await fetch(baseUrl + "/api/health")).json();
  assert.equal(health.status, "ok");
  assert.equal(health.companies, 6);
  assert.equal(health.dataLoadStatus, "ok");
});

test("원격 모드는 추적 파일을 건드리지 않고 runtime snapshot으로 자동 전환한다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "longview-runtime-api-"));
  const dataFile = path.join(directory, "companies.json");
  const runtimeDataFile = path.join(directory, ".cache", "companies.json");
  const publicDir = path.join(directory, "public");
  await mkdir(path.dirname(runtimeDataFile), { recursive: true });
  await mkdir(publicDir);

  const localText = JSON.stringify(snapshot([company(1)]));
  const remoteText = JSON.stringify(
    snapshot([company(1), company(2)], "2026-07-19T00:00:00.000Z")
  );
  await writeFile(dataFile, localText, "utf8");
  await writeFile(runtimeDataFile, localText, "utf8");
  const trackedBefore = await readFile(dataFile, "utf8");

  let refreshCalls = 0;
  let localSyncCalls = 0;
  const config = {
    dataFile,
    runtimeDataFile,
    publicDir,
    remoteSnapshotUrl:
      "https://raw.githubusercontent.com/example/longview/main/data/companies.json",
    remoteSnapshotToken: "",
    remoteSnapshotRefreshMs: 60_000,
    host: "127.0.0.1",
    port: 0,
    schedulerEnabled: true,
    scheduleHourKst: 21,
    syncToken: ""
  };
  const app = await createLongviewApp(config, {
    storeOptions: {
      refreshIntervalMs: 0,
      now: () => Date.parse("2026-07-19T00:00:00.000Z")
    },
    runtimeSnapshotPreparer: async () => ({
      dataFile: runtimeDataFile,
      source: "local",
      etag: null
    }),
    remoteSnapshotRefresher: async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        await writeFile(runtimeDataFile, remoteText, "utf8");
        return {
          attempted: true,
          success: true,
          changed: true,
          etag: '"remote-v2"',
          companyCount: 2,
          updatedAt: "2026-07-19T00:00:00.000Z"
        };
      }
      return {
        attempted: true,
        success: true,
        changed: false,
        notModified: true,
        etag: '"remote-v2"',
        companyCount: 2,
        updatedAt: "2026-07-19T00:00:00.000Z"
      };
    },
    syncRunner: async () => {
      localSyncCalls += 1;
      throw new Error("원격 모드에서 로컬 전체 sync를 실행하면 안 됩니다.");
    }
  });
  await app.refreshRemoteSnapshot({ throwOnFailure: true });
  const address = await app.listen();
  const baseUrl = "http://127.0.0.1:" + address.port;
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const overview = await (await fetch(baseUrl + "/api/overview")).json();
  assert.equal(overview.summary.companies, 2);
  assert.equal(await readFile(dataFile, "utf8"), trackedBefore);

  await app.startSync();
  assert.equal(localSyncCalls, 0);
  assert.ok(refreshCalls >= 2);
  const health = await (await fetch(baseUrl + "/api/health")).json();
  assert.equal(health.schedulerMode, "remote_snapshot");
  assert.equal(health.remoteSnapshot.status, "ok");
  assert.equal(health.remoteSnapshot.source, "remote");
});
