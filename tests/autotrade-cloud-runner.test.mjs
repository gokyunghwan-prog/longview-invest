import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLOUD_LIVE_ACKNOWLEDGEMENT,
  CloudAutotradeOutcomeError,
  acquireCloudLease,
  assertCloudLeaseOwned,
  assertCloudLiveAuthorization,
  publicCloudRunnerFailure,
  redactCloudRunnerError,
  runCloudAutotrade
} from "../scripts/cloud-autotrade.mjs";
import {
  LIVE_ACKNOWLEDGEMENT,
  UNATTENDED_LIVE_ACKNOWLEDGEMENT
} from "../autotrade/config.mjs";
import { createTradingStateStore } from "../autotrade/state-store.mjs";

const FIXED_NOW = new Date("2026-07-21T00:23:00.000Z");

function sha(index) {
  return index.toString(16).padStart(40, "0");
}

class FakeCloudStore {
  constructor(state = null) {
    this.state = state ? structuredClone(state) : null;
    this.currentSha = state ? sha(1) : null;
    this.saveCount = 0;
    this.ensureCount = 0;
    this.loadCount = 0;
    this.assertCount = 0;
    this.timeSampleCount = 0;
    this.dateHeader = "Wed, 22 Jul 2026 10:23:45 GMT";
    this.savedStates = [];
    this.forceAssertConflict = false;
  }

  async ensureBranch() {
    this.ensureCount += 1;
    return { branch: "trade-state", created: false };
  }

  async load() {
    this.loadCount += 1;
    return {
      exists: Boolean(this.state),
      state: this.state ? structuredClone(this.state) : null,
      sha: this.currentSha
    };
  }

  async save(state, { sha: expectedSha }) {
    if (expectedSha !== this.currentSha) {
      const error = new Error("CAS conflict");
      error.code = "CLOUD_STATE_CONFLICT";
      throw error;
    }
    this.saveCount += 1;
    this.state = structuredClone(state);
    this.savedStates.push(structuredClone(state));
    this.currentSha = sha(this.saveCount + 1);
    return { sha: this.currentSha };
  }

  async assertUnchanged(expectedSha) {
    this.assertCount += 1;
    if (this.forceAssertConflict || expectedSha !== this.currentSha) {
      const error = new Error("CAS conflict");
      error.code = "CLOUD_STATE_CONFLICT";
      throw error;
    }
    return { unchanged: true, sha: expectedSha };
  }

  async sampleServerTime() {
    this.timeSampleCount += 1;
    return {
      status: 200,
      dateHeader: this.dateHeader,
      redirected: false
    };
  }
}

function liveConfig(stateDir) {
  return {
    mode: "live",
    broker: "kis",
    stateDir,
    paper: { startingCashKrw: 100_000 },
    kis: {
      environment: "prod",
      appKey: "sensitive-app-key",
      appSecret: "sensitive-app-secret",
      accountNumber: "12345678",
      htsId: "sensitive-hts"
    },
    live: {
      enabled: true,
      acknowledgement: LIVE_ACKNOWLEDGEMENT
    },
    scheduler: {
      enabled: true,
      unattendedLiveEnabled: true,
      unattendedAcknowledgement: UNATTENDED_LIVE_ACKNOWLEDGEMENT
    }
  };
}

function actionEnv(overrides = {}) {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "owner/repository",
    GITHUB_RUN_ID: "456",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_TOKEN: "github_pat_sensitive_value_1234567890",
    AUTOTRADE_STATE_KEY: "state-key-sensitive-value",
    CLOUD_MANUAL_LIVE_CONFIRM: "true",
    CLOUD_LIVE_TRADING_ACK: CLOUD_LIVE_ACKNOWLEDGEMENT,
    TRADING_REQUIRE_PUBLISHED_SELECTION: "true",
    ...overrides
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "longview-cloud-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("plan은 원격 상태를 초기화하고 lease를 안전하게 획득·해제한다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();
  const logs = [];
  let dependencies;
  let planOptions;
  const summary = await runCloudAutotrade({
    command: "plan",
    env: actionEnv(),
    config: liveConfig(stateDir),
    cloudStore: cloud,
    now: () => new Date(FIXED_NOW),
    output: (value) => logs.push(value),
    engineFactory: async (_config, received) => {
      dependencies = received;
      return {
        async plan(options) {
          planOptions = options;
          return {
            ok: true,
            account: { totalEquityKrw: 98_765, positions: [{ ticker: "005930" }] },
            orders: [{ ticker: "005930" }],
            blockedReasons: []
          };
        }
      };
    }
  });

  assert.equal(summary.command, "plan");
  assert.equal(summary.orderCount, 1);
  assert.deepEqual(planOptions, { liveConfirmation: true });
  assert.equal(cloud.ensureCount, 1);
  assert.equal(cloud.state.cloud.fence, 1);
  assert.equal(cloud.state.cloud.lease, null);
  assert.ok(cloud.savedStates.some((state) => state.cloud.lease?.fence === 1));
  assert.equal(typeof dependencies.beforeOrder, "function");
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /98,?765|005930|sensitive/i);
});

test("topup-plan은 주문 없이 가용현금 매수전용 계획 옵션을 사용한다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();
  let planOptions;
  const summary = await runCloudAutotrade({
    command: "topup-plan",
    env: actionEnv({ CLOUD_MANUAL_LIVE_CONFIRM: "false" }),
    config: liveConfig(stateDir),
    cloudStore: cloud,
    now: () => new Date(FIXED_NOW),
    output: () => {},
    engineFactory: async () => ({
      async plan(options) {
        planOptions = options;
        return {
          ok: true,
          orders: [{ ticker: "000001" }],
          blockedReasons: []
        };
      }
    })
  });

  assert.deepEqual(planOptions, {
    liveConfirmation: true,
    force: true,
    cashDeploymentOnly: true,
    cycleScope: "manual-topup-plan:456"
  });
  assert.equal(summary.command, "topup-plan");
  assert.equal(summary.executed, false);
  assert.equal(summary.orderCount, 1);
});

test("시각을 주입하지 않은 클라우드 실행은 GitHub Date 신뢰 시계만 엔진에 전달한다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();
  let dependencies;

  const summary = await runCloudAutotrade({
    command: "topup-plan",
    env: actionEnv({ CLOUD_MANUAL_LIVE_CONFIRM: "false" }),
    config: liveConfig(stateDir),
    cloudStore: cloud,
    output: () => {},
    engineFactory: async (_config, received) => {
      dependencies = received;
      return {
        async plan() {
          const bounds = received.timeBounds();
          const now = received.now();
          assert.ok(now.getTime() >= bounds.earliest.getTime());
          assert.ok(now.getTime() <= bounds.latest.getTime());
          assert.equal(bounds.source, "github-api-date");
          return { ok: true, orders: [], blockedReasons: [] };
        }
      };
    }
  });

  assert.equal(summary.ok, true);
  assert.ok(cloud.timeSampleCount >= 3);
  assert.equal(typeof dependencies.beforePersist, "function");
  assert.equal(typeof dependencies.beforeOrder, "function");
  assert.equal(typeof dependencies.timeBounds, "function");
});

test("장외 auto heartbeat는 GitHub Date만 확인하고 원격 상태·엔진·KIS에 접근하지 않는다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();
  const logs = [];
  let engineCreated = false;

  const summary = await runCloudAutotrade({
    command: "auto",
    env: actionEnv({
      GITHUB_EVENT_NAME: "schedule",
      CLOUD_EVENT_SCHEDULE: "17,47 * * * 1-5",
      CLOUD_MANUAL_LIVE_CONFIRM: "false"
    }),
    config: liveConfig(stateDir),
    cloudStore: cloud,
    output: (value) => logs.push(value),
    engineFactory: async () => {
      engineCreated = true;
      throw new Error("장외 auto에서 엔진을 만들면 안 됩니다.");
    }
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.executed, false);
  assert.equal(summary.skipped, true);
  assert.equal(summary.skipCode, "OUTSIDE_ORDER_WINDOW");
  assert.deepEqual(summary.blockedCodes, ["OUTSIDE_ORDER_WINDOW"]);
  assert.equal(summary.blockedCount, 0);
  assert.equal(engineCreated, false);
  assert.equal(cloud.ensureCount, 0);
  assert.equal(cloud.loadCount, 0);
  assert.equal(cloud.saveCount, 0);
  assert.ok(cloud.timeSampleCount > 0);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /12345678|sensitive|state-key/i);
});

test("장중 auto heartbeat는 조정 후 KST 일자 고정 scope로 일반 거래를 재시도한다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();
  cloud.dateHeader = "Tue, 21 Jul 2026 00:23:45 GMT";
  const calls = [];
  const logs = [];

  const summary = await runCloudAutotrade({
    command: "auto",
    env: actionEnv({
      GITHUB_EVENT_NAME: "schedule",
      CLOUD_EVENT_SCHEDULE: "17,47 * * * 1-5",
      CLOUD_MANUAL_LIVE_CONFIRM: "false"
    }),
    config: liveConfig(stateDir),
    cloudStore: cloud,
    output: (value) => logs.push(value),
    engineFactory: async () => ({
      async reconcileInFlight(options) {
        calls.push(["reconcile", options]);
        return { status: "none", pendingCount: 0, canceledCount: 0 };
      },
      async execute(options) {
        calls.push(["execute", options]);
        return {
          ok: true,
          executed: true,
          orders: [
            { side: "sell", ticker: "000001" },
            { side: "buy", ticker: "000002" }
          ],
          results: [{ status: "submitted" }, { status: "filled" }],
          blockedReasons: [],
          planner: {
            diagnostics: {
              deploymentPhase: "routine",
              cashDeploymentActive: true,
              cashDeploymentResidualCode: "BELOW_MIN_ORDER",
              skipped: [
                { id: "secret-security-id", reason: "minimum_order" },
                {
                  id: "another-secret-id",
                  reason: "replacement_waiting_for_removal_confirmation"
                }
              ]
            }
          }
        };
      }
    })
  });

  assert.deepEqual(calls, [
    ["reconcile", { trigger: "github-actions-pretrade", cancelOpenOrders: false }],
    [
      "execute",
      {
        trigger: "github-actions-scheduled-auto",
        liveConfirmation: true,
        scheduledRetry: true,
        cycleScope: "scheduled-trade:2026-07-21"
      }
    ]
  ]);
  assert.equal(summary.ok, true);
  assert.equal(summary.orderSubmissionAttempted, true);
  assert.equal(summary.plannedBuyCount, 1);
  assert.equal(summary.plannedSellCount, 1);
  assert.equal(summary.deploymentPhase, "routine");
  assert.equal(summary.cashDeploymentActive, true);
  assert.equal(summary.idempotentDuplicate, false);
  assert.deepEqual(summary.blockedCodes, []);
  assert.deepEqual(summary.residualCodes, [
    "BELOW_MIN_ORDER",
    "REPLACEMENT_WAITING"
  ]);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(
    logs[0],
    /000001|000002|12345678|sensitive|secret-security-id|another-secret-id/i
  );
  assert.doesNotMatch(logs[0], /"minimum_order"|replacement_waiting/);
});

test("GitHub Date 조회 기능이 없으면 원격 상태나 엔진에 접근하기 전에 실패 폐쇄한다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();
  cloud.sampleServerTime = null;
  let engineCreated = false;

  await assert.rejects(
    runCloudAutotrade({
      command: "topup-plan",
      env: actionEnv({ CLOUD_MANUAL_LIVE_CONFIRM: "false" }),
      config: liveConfig(stateDir),
      cloudStore: cloud,
      output: () => {},
      engineFactory: async () => {
        engineCreated = true;
        return { plan: async () => ({ ok: true, orders: [], blockedReasons: [] }) };
      }
    }),
    (error) => error?.code === "TRUSTED_CLOCK_SAMPLE_FAILED"
  );

  assert.equal(cloud.ensureCount, 0);
  assert.equal(engineCreated, false);
});

test("blocked plan emits a safe summary and fails the cloud run", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();
  const logs = [];

  await assert.rejects(
    runCloudAutotrade({
      command: "plan",
      env: actionEnv(),
      config: liveConfig(stateDir),
      cloudStore: cloud,
      now: () => new Date(FIXED_NOW),
      output: (value) => logs.push(value),
      engineFactory: async () => ({
        async plan() {
          return {
            ok: false,
            account: { accountNumber: "12345678" },
            orders: [],
            blockedReasons: ["unsafe-secret-block-reason"]
          };
        }
      })
    }),
    (error) => error?.code === "CLOUD_AUTOTRADE_OUTCOME_UNSAFE"
  );

  assert.equal(logs.length, 1);
  const summary = JSON.parse(logs[0]);
  assert.equal(summary.command, "plan");
  assert.equal(summary.ok, false);
  assert.equal(summary.blockedCount, 1);
  assert.equal(cloud.state.cloud.lease, null);
  assert.doesNotMatch(logs[0], /12345678|unsafe-secret-block-reason|sensitive/i);
});

test("유효한 다른 실행 lease가 있으면 새 실행을 차단한다", async (t) => {
  const sourceDirectory = await temporaryDirectory(t);
  const sourceStore = await createTradingStateStore(sourceDirectory, {
    startingCashKrw: 100_000,
    now: () => new Date(FIXED_NOW)
  });
  await sourceStore.update((state) => {
    state.cloud = {
      fence: 7,
      lease: {
        owner: "another-run",
        fence: 7,
        acquiredAt: FIXED_NOW.toISOString(),
        expiresAt: new Date(FIXED_NOW.getTime() + 60_000).toISOString()
      }
    };
  });
  const cloud = new FakeCloudStore(sourceStore.snapshot());
  const stateDir = await temporaryDirectory(t);

  await assert.rejects(
    runCloudAutotrade({
      command: "plan",
      env: actionEnv(),
      config: liveConfig(stateDir),
      cloudStore: cloud,
      now: () => new Date(FIXED_NOW),
      output: () => {},
      engineFactory: async () => ({ plan: async () => ({}) })
    }),
    (error) => error?.code === "CLOUD_LEASE_BUSY"
  );
});

test("trade는 엄격한 수동 승인 전에 원격 저장소에 접근하지 않는다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();

  await assert.rejects(
    runCloudAutotrade({
      command: "trade",
      env: actionEnv({ CLOUD_MANUAL_LIVE_CONFIRM: "false" }),
      config: liveConfig(stateDir),
      cloudStore: cloud,
      output: () => {}
    }),
    /수동 실전 실행/
  );
  assert.equal(cloud.ensureCount, 0);
});

test("trade는 이전 미결을 먼저 조회하고 주문 직전 원격 SHA를 확인한다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();
  const calls = [];

  const summary = await runCloudAutotrade({
    command: "trade",
    env: actionEnv(),
    config: liveConfig(stateDir),
    cloudStore: cloud,
    now: () => new Date(FIXED_NOW),
    output: () => {},
    engineFactory: async (_config, dependencies) => ({
      async reconcileInFlight(options) {
        calls.push(["reconcile", options]);
        return { status: "none", pendingCount: 0, canceledCount: 0 };
      },
      async execute(options) {
        calls.push(["execute", options]);
        await dependencies.beforeOrder();
        return {
          ok: true,
          executed: true,
          orders: [{ ticker: "000001" }],
          results: [{ status: "submitted" }],
          blockedReasons: []
        };
      }
    })
  });

  assert.deepEqual(calls[0], [
    "reconcile",
    { trigger: "github-actions-pretrade", cancelOpenOrders: false }
  ]);
  assert.deepEqual(calls[1], [
    "execute",
    { trigger: "github-actions-scheduled", liveConfirmation: true }
  ]);
  assert.equal(cloud.assertCount, 1);
  assert.equal(summary.resultStatuses.submitted, 1);
  assert.equal(summary.reconciliation.status, "none");
});

test("상태 저장 직전과 각 주문 직전에는 원격 fence 뒤 신뢰 시각을 다시 갱신한다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();
  const calls = [];
  const originalAssertUnchanged = cloud.assertUnchanged.bind(cloud);
  cloud.assertUnchanged = async (expectedSha) => {
    calls.push("remote-fence");
    return originalAssertUnchanged(expectedSha);
  };
  const trustedClock = {
    async refresh() {
      calls.push("clock-refresh");
      return this.bounds();
    },
    now: () => new Date(FIXED_NOW),
    bounds: () => ({
      earliest: new Date(FIXED_NOW),
      latest: new Date(FIXED_NOW),
      source: "github-api-date"
    })
  };
  let mutationCalls;

  const summary = await runCloudAutotrade({
    command: "trade",
    env: actionEnv(),
    config: liveConfig(stateDir),
    cloudStore: cloud,
    trustedClock,
    output: () => {},
    engineFactory: async (_config, dependencies) => ({
      reconcileInFlight: async () => ({ status: "none", pendingCount: 0 }),
      async execute() {
        calls.length = 0;
        await dependencies.beforePersist();
        await dependencies.beforeOrder();
        mutationCalls = [...calls];
        return {
          ok: true,
          executed: true,
          orders: [{ ticker: "000001" }],
          results: [{ status: "submitted" }],
          blockedReasons: []
        };
      }
    })
  });

  assert.equal(summary.ok, true);
  assert.deepEqual(mutationCalls, [
    "clock-refresh",
    "remote-fence",
    "clock-refresh",
    "remote-fence"
  ]);
  assert.equal(cloud.assertCount, 2);
});

test("topup은 GitHub run ID가 일치하지 않으면 원격 상태 접근 전에 차단한다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();

  await assert.rejects(
    runCloudAutotrade({
      command: "topup",
      env: actionEnv({ CLOUD_MANUAL_TOPUP_ID: "different-run" }),
      config: liveConfig(stateDir),
      cloudStore: cloud,
      output: () => {}
    }),
    /추가입금 실행 식별자/
  );
  assert.equal(cloud.ensureCount, 0);
});

test("topup은 이전 미결을 대조한 뒤 일회성 매수전용 옵션으로 실행한다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();
  const calls = [];

  const summary = await runCloudAutotrade({
    command: "topup",
    env: actionEnv({ CLOUD_MANUAL_TOPUP_ID: "456" }),
    config: liveConfig(stateDir),
    cloudStore: cloud,
    now: () => new Date(FIXED_NOW),
    output: () => {},
    engineFactory: async () => ({
      async reconcileInFlight(options) {
        calls.push(["reconcile", options]);
        return { status: "none", pendingCount: 0, canceledCount: 0 };
      },
      async execute(options) {
        calls.push(["execute", options]);
        return {
          ok: true,
          executed: true,
          orders: [{ ticker: "000001" }],
          results: [{ status: "submitted" }],
          blockedReasons: []
        };
      }
    })
  });

  assert.deepEqual(calls, [
    ["reconcile", { trigger: "github-actions-pretrade", cancelOpenOrders: false }],
    [
      "execute",
      {
        trigger: "github-actions-manual-topup",
        liveConfirmation: true,
        force: true,
        cashDeploymentOnly: true,
        cycleScope: "manual-topup:456"
      }
    ]
  ]);
  assert.equal(summary.command, "topup");
  assert.equal(summary.resultStatuses.submitted, 1);
});

test("blocked trade emits a safe summary and fails the cloud run", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();
  const logs = [];

  await assert.rejects(
    runCloudAutotrade({
      command: "trade",
      env: actionEnv(),
      config: liveConfig(stateDir),
      cloudStore: cloud,
      now: () => new Date(FIXED_NOW),
      output: (value) => logs.push(value),
      engineFactory: async () => ({
        reconcileInFlight: async () => ({ status: "none" }),
        execute: async () => ({
          ok: false,
          executed: false,
          orders: [],
          results: [],
          blockedReasons: ["unsafe-secret-trade-reason"]
        })
      })
    }),
    (error) => error?.code === "CLOUD_AUTOTRADE_OUTCOME_UNSAFE"
  );

  assert.equal(logs.length, 1);
  const summary = JSON.parse(logs[0]);
  assert.equal(summary.command, "trade");
  assert.equal(summary.ok, false);
  assert.equal(summary.blockedCount, 1);
  assert.equal(summary.reconciliation.status, "none");
  assert.doesNotMatch(logs[0], /unsafe-secret-trade-reason|sensitive/i);
});

test("주문 결과가 제출·체결 외 상태이거나 불완전하면 비민감 코드로 job을 실패시킨다", async (t) => {
  const cases = [
    {
      name: "not-sent",
      orders: [{ side: "buy" }],
      results: [{ status: "blocked", notSent: true }],
      expected: ["ORDER_BLOCKED_NOT_SENT"]
    },
    {
      name: "rejected",
      orders: [{ side: "buy" }],
      results: [{ status: "rejected" }],
      expected: ["ORDER_REJECTED"]
    },
    {
      name: "unknown",
      orders: [{ side: "buy" }],
      results: [{ status: "unknown" }],
      expected: ["ORDER_UNKNOWN"]
    },
    {
      name: "other",
      orders: [{ side: "buy" }],
      results: [{ status: "ticker=005930 price=71234 qty=9 cash=987654" }],
      expected: ["UNEXPECTED_RESULT_STATUS"]
    },
    {
      name: "mixed",
      orders: [{ side: "buy" }, { side: "buy" }],
      results: [
        { status: "submitted" },
        { status: "blocked", notSent: true }
      ],
      expected: ["ORDER_BLOCKED_NOT_SENT", "MIXED_RESULT"]
    },
    {
      name: "incomplete",
      orders: [{ side: "buy" }, { side: "buy" }],
      results: [{ status: "submitted" }],
      expected: ["INCOMPLETE_RESULT_SET"]
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async (subtest) => {
      const stateDir = await temporaryDirectory(subtest);
      const cloud = new FakeCloudStore();
      const logs = [];
      await assert.rejects(
        runCloudAutotrade({
          command: "trade",
          env: actionEnv(),
          config: liveConfig(stateDir),
          cloudStore: cloud,
          now: () => new Date(FIXED_NOW),
          output: (value) => logs.push(value),
          engineFactory: async () => ({
            reconcileInFlight: async () => ({ status: "none" }),
            execute: async () => ({
              ok: true,
              executed: true,
              orders: fixture.orders,
              results: fixture.results,
              blockedReasons: []
            })
          })
        }),
        (error) => error?.code === "CLOUD_AUTOTRADE_OUTCOME_UNSAFE"
      );
      assert.equal(logs.length, 1);
      const summary = JSON.parse(logs[0]);
      assert.equal(summary.ok, false);
      assert.deepEqual(summary.resultBlockedCodes, fixture.expected);
      assert.doesNotMatch(
        logs[0],
        /005930|71234|987654|ticker=|price=|qty=|cash=/i
      );
    });
  }
});

test("pending pretrade reconciliation fails before execute", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();
  const logs = [];
  let executed = false;

  await assert.rejects(
    runCloudAutotrade({
      command: "trade",
      env: actionEnv(),
      config: liveConfig(stateDir),
      cloudStore: cloud,
      now: () => new Date(FIXED_NOW),
      output: (value) => logs.push(value),
      engineFactory: async () => ({
        reconcileInFlight: async () => ({
          status: "pending",
          pendingCount: 1,
          canceledCount: 0
        }),
        async execute() {
          executed = true;
          return { ok: true, orders: [], results: [], blockedReasons: [] };
        }
      })
    }),
    (error) => error?.code === "CLOUD_AUTOTRADE_OUTCOME_UNSAFE"
  );

  assert.equal(executed, false);
  assert.equal(logs.length, 1);
  const summary = JSON.parse(logs[0]);
  assert.equal(summary.ok, false);
  assert.equal(summary.blockedCount, 1);
  assert.equal(summary.reconciliation.status, "pending");
});

test("reconcile은 취소 가능한 미체결 주문 정리를 요청한다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();
  const logs = [];
  let received;

  await assert.rejects(
    runCloudAutotrade({
      command: "reconcile",
      env: actionEnv(),
      config: liveConfig(stateDir),
      cloudStore: cloud,
      now: () => new Date(FIXED_NOW),
      output: (value) => logs.push(value),
      engineFactory: async () => ({
        async reconcileInFlight(options) {
          received = options;
          return { status: "pending", pendingCount: 1, canceledCount: 1 };
        }
      })
    }),
    (error) => error?.code === "CLOUD_AUTOTRADE_OUTCOME_UNSAFE"
  );

  assert.deepEqual(received, {
    trigger: "github-actions-reconcile",
    cancelOpenOrders: true
  });
  assert.equal(logs.length, 1);
  const summary = JSON.parse(logs[0]);
  assert.equal(summary.ok, false);
  assert.equal(summary.blockedCount, 1);
  assert.equal(summary.reconciliation.pendingCount, 1);
  assert.equal(summary.reconciliation.canceledCount, 1);
});

test("ambiguous reconciliation emits a safe summary and fails", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();
  const logs = [];

  await assert.rejects(
    runCloudAutotrade({
      command: "reconcile",
      env: actionEnv(),
      config: liveConfig(stateDir),
      cloudStore: cloud,
      now: () => new Date(FIXED_NOW),
      output: (value) => logs.push(value),
      engineFactory: async () => ({
        reconcileInFlight: async () => ({
          status: "ambiguous",
          pendingCount: 1,
          canceledCount: 0
        })
      })
    }),
    (error) => error?.code === "CLOUD_AUTOTRADE_OUTCOME_UNSAFE"
  );

  assert.equal(logs.length, 1);
  const summary = JSON.parse(logs[0]);
  assert.equal(summary.ok, false);
  assert.equal(summary.blockedCount, 1);
  assert.equal(summary.reconciliation.status, "ambiguous");
  assert.doesNotMatch(logs[0], /12345678|sensitive/i);
});

test("예약 실행은 cron과 명령이 다르면 실전 실행을 거부한다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const config = liveConfig(stateDir);
  assert.doesNotThrow(() =>
    assertCloudLiveAuthorization(
      "auto",
      config,
      actionEnv({
        GITHUB_EVENT_NAME: "schedule",
        CLOUD_EVENT_SCHEDULE: "17,47 * * * 1-5"
      })
    )
  );
  assert.throws(
    () =>
      assertCloudLiveAuthorization(
        "trade",
        config,
        actionEnv({
          GITHUB_EVENT_NAME: "schedule",
          CLOUD_EVENT_SCHEDULE: "13 6 * * 1-5"
        })
      ),
    /예약 실행 시간/
  );
  assert.throws(
    () =>
      assertCloudLiveAuthorization(
        "auto",
        config,
        actionEnv({
          GITHUB_EVENT_NAME: "schedule",
          CLOUD_EVENT_SCHEDULE: "23 0 * * 1-5"
        })
      ),
    /예약 실행 시간/
  );
  assert.throws(
    () =>
      assertCloudLiveAuthorization(
        "trade",
        config,
        actionEnv({
          GITHUB_EVENT_NAME: "schedule",
          CLOUD_EVENT_SCHEDULE: "23 0 * * 1-5"
        })
      ),
    /예약 실행 시간/
  );
  assert.throws(
    () =>
      assertCloudLiveAuthorization(
        "topup",
        config,
        actionEnv({
          GITHUB_EVENT_NAME: "schedule",
          CLOUD_EVENT_SCHEDULE: "23 0 * * 1-5",
          CLOUD_MANUAL_TOPUP_ID: "456"
        })
      ),
    /예약 실행 시간/
  );
});

test("주문 직전 SHA 충돌은 주문 흐름을 실패 폐쇄한다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const cloud = new FakeCloudStore();
  cloud.forceAssertConflict = true;
  let reachedAfterFence = false;

  await assert.rejects(
    runCloudAutotrade({
      command: "trade",
      env: actionEnv(),
      config: liveConfig(stateDir),
      cloudStore: cloud,
      now: () => new Date(FIXED_NOW),
      output: () => {},
      engineFactory: async (_config, dependencies) => ({
        reconcileInFlight: async () => ({ status: "none" }),
        async execute() {
          await dependencies.beforeOrder();
          reachedAfterFence = true;
          return { ok: true, orders: [], results: [] };
        }
      })
    }),
    (error) => error?.code === "CLOUD_STATE_CONFLICT"
  );
  assert.equal(reachedAfterFence, false);
});

test("만료되거나 바뀐 lease는 로컬에서도 주문 직전에 차단한다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const store = await createTradingStateStore(stateDir, {
    startingCashKrw: 100_000,
    now: () => new Date(FIXED_NOW)
  });
  const lease = await acquireCloudLease(store, {
    owner: "runner",
    now: () => new Date(FIXED_NOW),
    leaseMs: 1_000
  });
  assert.throws(
    () =>
      assertCloudLeaseOwned(
        store,
        lease,
        () => new Date(FIXED_NOW.getTime() + 1_001)
      ),
    (error) => error?.code === "CLOUD_LEASE_LOST"
  );
});

test("기존 lease는 신뢰 시각 범위 전체에서 만료가 확실할 때만 인수한다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const store = await createTradingStateStore(stateDir, {
    startingCashKrw: 100_000,
    now: () => new Date(FIXED_NOW)
  });
  await store.update((state) => {
    state.cloud = {
      fence: 7,
      lease: {
        owner: "other-runner",
        fence: 7,
        acquiredAt: FIXED_NOW.toISOString(),
        expiresAt: new Date(FIXED_NOW.getTime() + 1_000).toISOString()
      }
    };
  });

  await assert.rejects(
    acquireCloudLease(store, {
      owner: "new-runner",
      now: () => new Date(FIXED_NOW.getTime() + 1_500),
      timeBounds: () => ({
        earliest: new Date(FIXED_NOW.getTime() + 999),
        latest: new Date(FIXED_NOW.getTime() + 2_000)
      }),
      leaseMs: 10_000
    }),
    (error) => error?.code === "CLOUD_LEASE_BUSY"
  );
});

test("외부 주문 전에는 신뢰 시각 상한 뒤에도 lease 잔여 여유가 충분해야 한다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const store = await createTradingStateStore(stateDir, {
    startingCashKrw: 100_000,
    now: () => new Date(FIXED_NOW)
  });
  const lease = await acquireCloudLease(store, {
    owner: "runner",
    now: () => new Date(FIXED_NOW),
    timeBounds: () => ({
      earliest: new Date(FIXED_NOW),
      latest: new Date(FIXED_NOW.getTime() + 999)
    }),
    leaseMs: 61_000
  });
  assert.equal(
    lease.expiresAt,
    new Date(FIXED_NOW.getTime() + 61_999).toISOString()
  );
  assert.throws(
    () =>
      assertCloudLeaseOwned(store, lease, () => new Date(FIXED_NOW), {
        timeBounds: () => ({
          earliest: new Date(FIXED_NOW.getTime() + 1_000),
          latest: new Date(FIXED_NOW.getTime() + 2_000)
        }),
        minimumRemainingMs: 60_000
      }),
    (error) => error?.code === "CLOUD_LEASE_LOST"
  );
});

test("오류 출력은 GitHub·암호화·KIS 비밀값을 모두 가린다", async (t) => {
  const stateDir = await temporaryDirectory(t);
  const config = liveConfig(stateDir);
  const env = actionEnv();
  const raw = [
    env.GITHUB_TOKEN,
    env.AUTOTRADE_STATE_KEY,
    config.kis.appKey,
    config.kis.appSecret,
    config.kis.accountNumber
  ].join(" ");
  const safe = redactCloudRunnerError(new Error(raw), env, config);
  assert.doesNotMatch(safe, /github_pat_sensitive|state-key-sensitive|sensitive-app|12345678/);
  assert.match(safe, /redacted/i);
});

test("공개 최상위 실패 출력은 원문 대신 allowlisted category만 반환한다", () => {
  const error = new Error(
    "KIS_PRODUCT_CODE=01 account=12345678 cash=987654 price=71234 qty=9 ticker=005930"
  );
  error.code = "SOME_UNEXPECTED_KIS_FAILURE";
  const payload = JSON.stringify(publicCloudRunnerFailure(error));

  assert.deepEqual(JSON.parse(payload), {
    ok: false,
    errorCode: "INTERNAL_ERROR"
  });
  assert.doesNotMatch(
    payload,
    /PRODUCT_CODE|01|12345678|987654|71234|qty|005930|KIS_FAILURE/i
  );

  const unsafe = new CloudAutotradeOutcomeError();
  assert.deepEqual(publicCloudRunnerFailure(unsafe), {
    ok: false,
    errorCode: "UNSAFE_OUTCOME"
  });
});

test("GitHub 실거래 workflow는 AWS 이전을 위해 주문 불가능한 stub으로 고정된다", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/live-autotrade.yml", import.meta.url),
    "utf8"
  );
  assert.match(workflow, /Retired GitHub live autotrade/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /schedule:|cloud-autotrade|secrets\.|KIS_/);
});
