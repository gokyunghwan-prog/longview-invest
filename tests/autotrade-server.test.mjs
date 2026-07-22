import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getTradingConfig } from "../autotrade/config.mjs";
import { createTradingServer } from "../autotrade/server.mjs";

async function setup(t, { mode = "paper" } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "longview-trade-server-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const config = getTradingConfig({
    env: { TRADING_MODE: "paper" },
    rootDir,
    loadEnv: false
  });
  config.port = 0;
  config.mode = mode;
  let planCalls = 0;
  let executeCalls = 0;
  const plan = {
    ok: true,
    signal: {
      revision: "r1",
      modelVersion: "2.0.0",
      sourceUpdatedAt: "2026-07-20T00:00:00.000Z",
      candidateCount: 12
    },
    account: { cashKrw: 1_000_000, totalEquityKrw: 1_000_000, positions: [] },
    portfolio: { status: "ready", selected: [], targetWeights: {}, cashTargetWeight: 1 },
    planner: { diagnostics: {} },
    orders: [],
    risk: { orders: { ok: true, grossNotionalKrw: 0 } },
    blockedReasons: [],
    cycleKey: "cycle-1"
  };
  const engine = {
    broker: {
      name: "paper",
      getAccount: async () => plan.account
    },
    status: async () => ({
      state: {
        paper: { cashKrw: 1_000_000, positions: {} },
        strategy: {},
        runs: []
      },
      lastRun: null,
      killSwitchActive: false
    }),
    plan: async () => {
      planCalls += 1;
      return plan;
    },
    execute: async () => {
      executeCalls += 1;
      return { ...plan, executed: false, results: [], reason: "no_orders" };
    }
  };
  const app = await createTradingServer(config, { engine, csrfToken: "csrf-test" });
  await app.listen();
  t.after(() => app.close());
  const port = app.server.address().port;
  return {
    app,
    config,
    engine,
    url: `http://127.0.0.1:${port}`,
    calls: () => ({ planCalls, executeCalls })
  };
}

test("별도 대시보드가 no-store 보안 헤더와 비밀 없는 상태만 제공한다", async (t) => {
  const { url } = await setup(t);
  const page = await fetch(`${url}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(page.headers.get("cache-control"), /no-store/);
  assert.match(await page.text(), /LONGVIEW AUTO/);

  const response = await fetch(`${url}/api/status`);
  const status = await response.json();
  assert.equal(status.csrfToken, "csrf-test");
  assert.equal(status.config.mode, "paper");
  assert.equal("appSecret" in status.config.kis, false);
});

test("POST 계획과 모의실행은 같은 출처용 CSRF 헤더를 요구한다", async (t) => {
  const { url, calls } = await setup(t);
  const denied = await fetch(`${url}/api/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(denied.status, 403);
  assert.equal(calls().planCalls, 0);

  const headers = {
    "Content-Type": "application/json",
    "X-Longview-CSRF": "csrf-test"
  };
  const plan = await fetch(`${url}/api/plan`, { method: "POST", headers, body: "{}" });
  assert.equal(plan.status, 200);
  assert.equal(calls().planCalls, 1);

  const run = await fetch(`${url}/api/paper-run`, { method: "POST", headers, body: "{}" });
  assert.equal(run.status, 200);
  assert.equal(calls().executeCalls, 1);
});

test("대시보드는 live 모드의 실행 endpoint를 제공하지 않는다", async (t) => {
  const { url, calls } = await setup(t, { mode: "live" });
  const response = await fetch(`${url}/api/paper-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Longview-CSRF": "csrf-test"
    },
    body: "{}"
  });
  assert.equal(response.status, 409);
  assert.equal(calls().executeCalls, 0);
});
