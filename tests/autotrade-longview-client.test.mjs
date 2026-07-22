import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  LongviewClient,
  LongviewClientError,
  buildPublishedSelectionSignalRevision,
  buildLongviewSignalRevision
} from "../autotrade/longview-client.mjs";
import {
  DEFAULT_INVESTMENT_SELECTION_POLICY,
  buildInvestmentSelection
} from "../lib/investment-selection.mjs";

const MODEL_VERSION = "2.0.0";
const RAW_REVISION = "raw-revision-001";

function health(overrides = {}) {
  return {
    status: "ok",
    syncing: false,
    revision: RAW_REVISION,
    updatedAt: "2026-07-19T10:35:00.000Z",
    companies: 8_719,
    dataLoadStatus: "ok",
    remoteSnapshot: { enabled: false, status: "disabled" },
    ...overrides
  };
}

function methodology(overrides = {}) {
  return {
    modelVersion: MODEL_VERSION,
    groups: [{ key: "valuation", weight: 30 }],
    candidateRules: { minimumTotal: 75 },
    ...overrides
  };
}

function candidate(index, overrides = {}) {
  const id = "KR-" + String(index).padStart(6, "0");
  return {
    id,
    name: "Candidate " + index,
    ticker: String(index).padStart(6, "0"),
    country: "KR",
    exchange: "KOSPI",
    sector: "테스트",
    stale: false,
    score: {
      modelVersion: MODEL_VERSION,
      total: 80,
      evaluationReady: true,
      candidate: { eligible: true, label: "후보" }
    },
    ...overrides
  };
}

function sendJson(response, status, payload) {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  response.end(text);
}

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: "http://127.0.0.1:" + address.port,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    )
  };
}

test("후보가 100개를 넘어도 전 페이지와 상세를 제한 동시성으로 읽는다", async (t) => {
  const allCandidates = Array.from({ length: 101 }, (_, index) => candidate(index + 1));
  const requestedPages = [];
  let activeDetails = 0;
  let peakDetails = 0;
  const fixture = await startServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/api/health") return sendJson(response, 200, health());
    if (url.pathname === "/api/methodology") {
      return sendJson(response, 200, methodology());
    }
    if (url.pathname === "/api/companies") {
      const page = Number(url.searchParams.get("page"));
      assert.equal(url.searchParams.get("candidateOnly"), "true");
      assert.equal(url.searchParams.get("pageSize"), "100");
      requestedPages.push(page);
      const start = (page - 1) * 100;
      return sendJson(response, 200, {
        revision: RAW_REVISION,
        pagination: {
          page,
          pageSize: 100,
          total: allCandidates.length,
          totalPages: 2
        },
        items: allCandidates.slice(start, start + 100)
      });
    }
    if (url.pathname.startsWith("/api/companies/")) {
      activeDetails += 1;
      peakDetails = Math.max(peakDetails, activeDetails);
      const id = decodeURIComponent(url.pathname.slice("/api/companies/".length));
      const item = allCandidates.find((entry) => entry.id === id);
      return setTimeout(() => {
        activeDetails -= 1;
        sendJson(response, 200, { ...item, disclosures: [], riskFlags: [] });
      }, 2);
    }
    sendJson(response, 404, { error: "not found" });
  });
  t.after(fixture.close);

  const client = new LongviewClient({
    baseUrl: fixture.baseUrl,
    detailConcurrency: 3,
    expectedModelVersion: MODEL_VERSION,
    now: () => new Date("2026-07-19T12:00:00.000Z")
  });
  const result = await client.getSignal();

  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(result.candidateSummaries.length, 101);
  assert.equal(result.companies.length, 101);
  assert.equal(result.candidates.length, 101);
  assert.ok(peakDetails >= 2);
  assert.ok(peakDetails <= 3);
  assert.equal(result.rawRevision, RAW_REVISION);
  assert.equal(result.modelVersion, MODEL_VERSION);
  assert.equal(
    result.revision,
    buildLongviewSignalRevision(RAW_REVISION, MODEL_VERSION)
  );
  assert.equal(result.signalRevision, result.revision);
  assert.equal(result.sourceUpdatedAt, "2026-07-19T10:35:00.000Z");
  assert.equal(Object.keys(result.quotes).length, 101);
  assert.equal(result.fetchedAt, "2026-07-19T12:00:00.000Z");
});

test("timeout이 지나면 요청을 중단하고 fail-closed 오류를 반환한다", async (t) => {
  const fixture = await startServer((request, response) => {
    setTimeout(() => sendJson(response, 200, health()), 100);
  });
  t.after(fixture.close);
  const client = new LongviewClient({ baseUrl: fixture.baseUrl, timeoutMs: 20 });

  await assert.rejects(
    client.getHealth(),
    (error) => error instanceof LongviewClientError && error.code === "REQUEST_TIMEOUT"
  );
});

test("Content-Length가 없어도 응답 크기 제한을 넘으면 거부한다", async (t) => {
  const fixture = await startServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"status":"ok","padding":"');
    response.end("x".repeat(512) + '"}');
  });
  t.after(fixture.close);
  const client = new LongviewClient({
    baseUrl: fixture.baseUrl,
    maxResponseBytes: 128
  });

  await assert.rejects(
    client.getHealth(),
    (error) => error instanceof LongviewClientError && error.code === "RESPONSE_TOO_LARGE"
  );
});

test("동기화 중이거나 원격 snapshot이 stale이면 신호 생성을 시작하지 않는다", async (t) => {
  let methodologyCalls = 0;
  const fixture = await startServer((request, response) => {
    if (request.url === "/api/health") {
      return sendJson(response, 200, health({ syncing: true }));
    }
    methodologyCalls += 1;
    sendJson(response, 200, methodology());
  });
  t.after(fixture.close);
  const client = new LongviewClient({ baseUrl: fixture.baseUrl });

  await assert.rejects(
    client.getSignal(),
    (error) => error instanceof LongviewClientError && error.code === "HEALTH_UNSAFE"
  );
  assert.equal(methodologyCalls, 0);
});

test("목록의 모델 버전이 방법론과 다르면 fail-closed 한다", async (t) => {
  const fixture = await startServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/api/health") return sendJson(response, 200, health());
    if (url.pathname === "/api/methodology") {
      return sendJson(response, 200, methodology());
    }
    if (url.pathname === "/api/companies") {
      return sendJson(response, 200, {
        revision: RAW_REVISION,
        pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
        items: [candidate(1, {
          score: {
            modelVersion: "1.0.0",
            evaluationReady: true,
            candidate: { eligible: true }
          }
        })]
      });
    }
    sendJson(response, 404, {});
  });
  t.after(fixture.close);
  const client = new LongviewClient({ baseUrl: fixture.baseUrl });

  await assert.rejects(
    client.getSignal(),
    (error) => error instanceof LongviewClientError && error.code === "MODEL_MISMATCH"
  );
});

test("수집 도중 raw revision이 바뀌면 복합 신호를 만들지 않는다", async (t) => {
  let healthCalls = 0;
  const fixture = await startServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/api/health") {
      healthCalls += 1;
      return sendJson(response, 200, health({
        revision: healthCalls === 1 ? RAW_REVISION : "raw-revision-002"
      }));
    }
    if (url.pathname === "/api/methodology") {
      return sendJson(response, 200, methodology());
    }
    if (url.pathname === "/api/companies") {
      return sendJson(response, 200, {
        revision: RAW_REVISION,
        pagination: { page: 1, pageSize: 100, total: 0, totalPages: 0 },
        items: []
      });
    }
    sendJson(response, 404, {});
  });
  t.after(fixture.close);
  const client = new LongviewClient({ baseUrl: fixture.baseUrl });

  await assert.rejects(
    client.getSignal(),
    (error) => error instanceof LongviewClientError && error.code === "REVISION_CHANGED"
  );
});

test("HTTP 오류 응답 본문의 secret을 오류 메시지나 속성에 노출하지 않는다", async (t) => {
  const secret = "broker-app-secret-never-log";
  const fixture = await startServer((request, response) => {
    sendJson(response, 500, { error: "failed", detail: secret });
  });
  t.after(fixture.close);
  const client = new LongviewClient({ baseUrl: fixture.baseUrl });

  await assert.rejects(client.getHealth(), (error) => {
    assert.ok(error instanceof LongviewClientError);
    assert.equal(error.code, "HTTP_ERROR");
    assert.equal(error.status, 500);
    assert.equal(String(error).includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
});

test("복합 signal revision은 raw revision과 modelVersion 중 하나만 바뀌어도 달라진다", () => {
  const baseline = buildLongviewSignalRevision("raw-a", "2.0.0");
  assert.notEqual(baseline, buildLongviewSignalRevision("raw-b", "2.0.0"));
  assert.notEqual(baseline, buildLongviewSignalRevision("raw-a", "2.0.1"));
});

test("공개 자동투자 선정 모드는 검증된 웹 순위 전체를 같은 순서로 읽는다", async (t) => {
  const selectedCompanies = Array.from({ length: 4 }, (_, index) => ({
    ...candidate(index + 1),
    sector: `sector-${index + 1}`,
    dataMode: "live",
    score: {
      modelVersion: MODEL_VERSION,
      total: 94 - index,
      dataConfidence: 96,
      completeness: 96,
      valuationConfidence: 90,
      evaluationReady: true,
      candidate: { eligible: true },
      components: {
        valuation: { score: 90 - index },
        longGrowth: { score: 88 - index }
      }
    },
    marketData: {
      price: 10_000 + index * 1_000,
      priceKrw: 10_000 + index * 1_000,
      currency: "KRW",
      marketCapKrw: 300_000_000_000,
      averageDailyTurnoverKrw: 2_000_000_000,
      asOf: "2026-07-19",
      status: "ok",
      freshness: "current"
    }
  }));
  const selection = buildInvestmentSelection({
    companies: selectedCompanies,
    sourceRevision: RAW_REVISION,
    sourceUpdatedAt: "2026-07-19T10:35:00.000Z",
    modelVersion: MODEL_VERSION,
    generatedAt: new Date("2026-07-19T12:00:00.000Z")
  });
  let listCalls = 0;
  const detailIds = [];
  const fixture = await startServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/api/health") return sendJson(response, 200, health());
    if (url.pathname === "/api/methodology") return sendJson(response, 200, methodology());
    if (url.pathname === "/api/investment-selection") {
      return sendJson(response, 200, selection);
    }
    if (url.pathname === "/api/companies") {
      listCalls += 1;
      return sendJson(response, 500, {});
    }
    if (url.pathname.startsWith("/api/companies/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/companies/".length));
      detailIds.push(id);
      return sendJson(
        response,
        200,
        selectedCompanies.find((item) => item.id === id)
      );
    }
    return sendJson(response, 404, {});
  });
  t.after(fixture.close);

  const client = new LongviewClient({
    baseUrl: fixture.baseUrl,
    expectedModelVersion: MODEL_VERSION,
    requirePublishedSelection: true,
    expectedSelectionPolicy: DEFAULT_INVESTMENT_SELECTION_POLICY,
    now: () => new Date("2026-07-19T12:00:00.000Z")
  });
  const signal = await client.getSignal();

  assert.equal(listCalls, 0);
  assert.deepEqual(
    signal.companies.map((item) => item.id),
    selection.ranked.map((item) => item.id)
  );
  assert.deepEqual(detailIds.sort(), selection.ranked.map((item) => item.id).sort());
  assert.equal(signal.selection.policyHash, selection.policyHash);
  assert.equal(
    signal.revision,
    buildPublishedSelectionSignalRevision(RAW_REVISION, MODEL_VERSION, selection)
  );
});
