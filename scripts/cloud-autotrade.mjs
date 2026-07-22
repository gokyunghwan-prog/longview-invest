import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  LIVE_ACKNOWLEDGEMENT,
  UNATTENDED_LIVE_ACKNOWLEDGEMENT,
  getTradingConfig
} from "../autotrade/config.mjs";
import {
  GitHubEncryptedStateStore,
  redactCloudStateSecrets
} from "../autotrade/cloud-state.mjs";
import { createTradingEngine } from "../autotrade/engine.mjs";
import { redactSensitive } from "../autotrade/risk.mjs";
import { createTradingStateStore } from "../autotrade/state-store.mjs";

export const CLOUD_LIVE_ACKNOWLEDGEMENT =
  "I_ACCEPT_GITHUB_ACTIONS_LIVE_TRADING";
export const DEFAULT_CLOUD_LEASE_MS = 20 * 60 * 1_000;

const CLOUD_COMMANDS = new Set(["plan", "trade", "reconcile", "topup-plan", "topup"]);
const MUTATING_COMMANDS = new Set(["trade", "reconcile", "topup"]);
const SCHEDULED_COMMANDS = new Map([
  ["23 0 * * 1-5", "trade"],
  ["13 6 * * 1-5", "reconcile"]
]);
const RESOLVED_RECONCILIATION_STATUSES = new Set(["none", "cleared"]);

export class CloudAutotradeOutcomeError extends Error {
  constructor(message = "Cloud autotrade finished with a blocked or unresolved outcome.") {
    super(message);
    this.name = "CloudAutotradeOutcomeError";
    this.code = "CLOUD_AUTOTRADE_OUTCOME_UNSAFE";
  }
}

function exact(value, expected, label) {
  if (String(value ?? "") !== expected) {
    const error = new Error(`${label} 확인값이 일치하지 않습니다.`);
    error.code = "CLOUD_LIVE_NOT_AUTHORIZED";
    throw error;
  }
}

function parsePositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label}은(는) 양의 정수여야 합니다.`);
  }
  return parsed;
}

function normalizeCommand(value) {
  const command = String(value || "plan").trim().toLowerCase();
  if (!CLOUD_COMMANDS.has(command)) {
    throw new Error(
      "클라우드 자동투자 명령은 plan, trade, reconcile, topup-plan, topup 중 하나여야 합니다."
    );
  }
  return command;
}

function makeLeaseOwner(env) {
  const repository = String(env.GITHUB_REPOSITORY || "").trim();
  const runId = String(env.GITHUB_RUN_ID || "").trim();
  const attempt = String(env.GITHUB_RUN_ATTEMPT || "1").trim();
  if (!repository || !runId) {
    throw new Error("GitHub Actions 실행 식별정보가 없습니다.");
  }
  return `${repository}:${runId}:${attempt}:${randomUUID()}`;
}

export function assertCloudLiveAuthorization(command, config, env = process.env) {
  if (!MUTATING_COMMANDS.has(normalizeCommand(command))) return;

  exact(env.GITHUB_ACTIONS, "true", "GitHub Actions 환경");
  if (!new Set(["schedule", "workflow_dispatch"]).has(env.GITHUB_EVENT_NAME)) {
    throw new Error("실전 클라우드 명령은 승인된 GitHub Actions 이벤트에서만 실행됩니다.");
  }
  if (env.GITHUB_EVENT_NAME === "schedule") {
    const expected = SCHEDULED_COMMANDS.get(String(env.CLOUD_EVENT_SCHEDULE || ""));
    if (!expected || expected !== command) {
      throw new Error("예약 실행 시간과 클라우드 자동투자 명령이 일치하지 않습니다.");
    }
  }
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    exact(env.CLOUD_MANUAL_LIVE_CONFIRM, "true", "수동 실전 실행");
  }
  if (command === "topup") {
    exact(env.GITHUB_EVENT_NAME, "workflow_dispatch", "추가입금 수동 이벤트");
    exact(env.CLOUD_MANUAL_TOPUP_ID, String(env.GITHUB_RUN_ID || ""), "추가입금 실행 식별자");
  }

  exact(env.CLOUD_LIVE_TRADING_ACK, CLOUD_LIVE_ACKNOWLEDGEMENT, "클라우드 실전 위험");
  exact(env.TRADING_REQUIRE_PUBLISHED_SELECTION, "true", "공개 선정목록 사용");
  if (
    config?.mode !== "live" ||
    config?.broker !== "kis" ||
    config?.kis?.environment !== "prod"
  ) {
    throw new Error("클라우드 실전 명령은 KIS 실전 모드에서만 실행됩니다.");
  }
  if (
    config?.live?.enabled !== true ||
    config?.live?.acknowledgement !== LIVE_ACKNOWLEDGEMENT
  ) {
    throw new Error("실전 주문 잠금이 해제되지 않았습니다.");
  }
  if (
    config?.scheduler?.enabled !== true ||
    config?.scheduler?.unattendedLiveEnabled !== true ||
    config?.scheduler?.unattendedAcknowledgement !==
      UNATTENDED_LIVE_ACKNOWLEDGEMENT
  ) {
    throw new Error("무인 실전 주문 잠금이 해제되지 않았습니다.");
  }
}

async function writeStateAtomically(stateFile, state) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.cloud-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await rename(temporary, stateFile);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function acquireCloudLease(
  stateStore,
  { owner, now = () => new Date(), leaseMs = DEFAULT_CLOUD_LEASE_MS } = {}
) {
  const normalizedOwner = String(owner || "").trim();
  if (!normalizedOwner) throw new Error("클라우드 lease 소유자 식별자가 없습니다.");
  const duration = parsePositiveInteger(leaseMs, DEFAULT_CLOUD_LEASE_MS, "클라우드 lease 시간");
  const acquiredAt = now();
  const expiresAt = new Date(acquiredAt.getTime() + duration);
  let lease;
  await stateStore.update(
    (state) => {
      state.cloud ||= { fence: 0, lease: null };
      const current = state.cloud.lease;
      const currentExpiry = Date.parse(current?.expiresAt || "");
      if (
        current &&
        current.owner !== normalizedOwner &&
        Number.isFinite(currentExpiry) &&
        currentExpiry > acquiredAt.getTime()
      ) {
        const error = new Error("다른 클라우드 자동투자 실행이 lease를 보유하고 있습니다.");
        error.code = "CLOUD_LEASE_BUSY";
        throw error;
      }
      const fence = Math.max(0, Number(state.cloud.fence) || 0) + 1;
      lease = {
        owner: normalizedOwner,
        fence,
        acquiredAt: acquiredAt.toISOString(),
        expiresAt: expiresAt.toISOString()
      };
      state.cloud.fence = fence;
      state.cloud.lease = lease;
    },
    { type: "cloud_lease_acquired", owner: normalizedOwner }
  );
  return structuredClone(lease);
}

export function assertCloudLeaseOwned(stateStore, lease, now = () => new Date()) {
  const current = stateStore.snapshot().cloud?.lease;
  if (
    !current ||
    current.owner !== lease.owner ||
    current.fence !== lease.fence ||
    Date.parse(current.expiresAt || "") <= now().getTime()
  ) {
    const error = new Error("클라우드 자동투자 lease가 만료되었거나 소유권이 변경되었습니다.");
    error.code = "CLOUD_LEASE_LOST";
    throw error;
  }
}

export async function releaseCloudLease(stateStore, lease) {
  await stateStore.update(
    (state) => {
      const current = state.cloud?.lease;
      if (!current) return;
      if (current.owner !== lease.owner || current.fence !== lease.fence) {
        const error = new Error("클라우드 lease 소유권이 변경되어 해제를 중단합니다.");
        error.code = "CLOUD_LEASE_LOST";
        throw error;
      }
      state.cloud.lease = null;
    },
    { type: "cloud_lease_released", owner: lease.owner, fence: lease.fence }
  );
}

function reconciliationSummary(result) {
  if (!result || typeof result !== "object") {
    return { status: "completed", pendingCount: null, canceledCount: null };
  }
  return {
    status: String(result.status || (result.cleared ? "cleared" : "completed")),
    pendingCount: Number.isSafeInteger(result.pendingCount) ? result.pendingCount : null,
    canceledCount: Number.isSafeInteger(result.canceledCount) ? result.canceledCount : null
  };
}

function executionSummary(command, result, reconciliation = null) {
  const statuses = Array.isArray(result?.results)
    ? result.results.reduce((counts, item) => {
        const status = String(item?.status || "unknown");
        counts[status] = (counts[status] || 0) + 1;
        return counts;
      }, {})
    : {};
  return {
    command,
    ok: result?.ok !== false,
    executed: result?.executed === true,
    orderCount: Array.isArray(result?.orders) ? result.orders.length : 0,
    blockedCount: Array.isArray(result?.blockedReasons) ? result.blockedReasons.length : 0,
    resultStatuses: statuses,
    ...(reconciliation ? { reconciliation } : {})
  };
}

function reconciliationNeedsAttention(summary) {
  return (
    summary &&
    !RESOLVED_RECONCILIATION_STATUSES.has(String(summary.status || ""))
  );
}

function assertSafeExecutionSummary(command, summary) {
  const blockedExecution =
    new Set(["plan", "trade", "topup-plan", "topup"]).has(command) &&
    (summary?.ok !== true || Number(summary?.blockedCount) > 0);
  const unresolvedReconciliation =
    new Set(["trade", "reconcile", "topup"]).has(command) &&
    reconciliationNeedsAttention(summary?.reconciliation);
  if (blockedExecution || unresolvedReconciliation) {
    throw new CloudAutotradeOutcomeError();
  }
}

async function reconcile(engine, options) {
  if (typeof engine.reconcileInFlight !== "function") {
    const status = typeof engine.status === "function" ? await engine.status() : null;
    if (!status?.state?.strategy?.inFlight && options.cancelOpenOrders === false) {
      return { status: "none", pendingCount: 0, canceledCount: 0 };
    }
    throw new Error("주문 체결내역 자동 대조 기능이 준비되지 않았습니다.");
  }
  return engine.reconcileInFlight(options);
}

export async function runCloudAutotrade({
  command: requestedCommand = "plan",
  env = process.env,
  now = () => new Date(),
  config = null,
  cloudStore = null,
  engineFactory = createTradingEngine,
  stateStoreFactory = createTradingStateStore,
  output = console.log
} = {}) {
  const command = normalizeCommand(requestedCommand);
  const resolvedConfig = config || getTradingConfig({ env, loadEnv: false });
  assertCloudLiveAuthorization(command, resolvedConfig, env);

  const token = String(env.GITHUB_TOKEN || "").trim();
  const stateKey = String(env.AUTOTRADE_STATE_KEY || "").trim();
  const repository = String(env.GITHUB_REPOSITORY || "").trim();
  const remote =
    cloudStore ||
    new GitHubEncryptedStateStore({
      repository,
      token,
      encryptionKey: stateKey
    });

  await remote.ensureBranch();
  const loaded = await remote.load();
  let remoteSha = loaded.sha;
  let stateStore;
  const persistRemote = async (state) => {
    const saved = await remote.save(state, {
      sha: remoteSha,
      message: "trade-state: checkpoint cloud runner"
    });
    remoteSha = saved.sha;
  };

  if (loaded.exists) {
    await writeStateAtomically(
      path.join(resolvedConfig.stateDir, "state.json"),
      loaded.state
    );
  }
  stateStore = await stateStoreFactory(resolvedConfig.stateDir, {
    startingCashKrw: resolvedConfig.paper?.startingCashKrw,
    now,
    onStateCommitted: persistRemote
  });
  if (!loaded.exists) {
    const initialized = await remote.save(stateStore.snapshot(), {
      sha: null,
      message: "trade-state: initialize encrypted cloud runner"
    });
    remoteSha = initialized.sha;
  }

  const owner = makeLeaseOwner(env);
  const lease = await acquireCloudLease(stateStore, {
    owner,
    now,
    leaseMs: parsePositiveInteger(
      env.AUTOTRADE_CLOUD_LEASE_MS,
      DEFAULT_CLOUD_LEASE_MS,
      "AUTOTRADE_CLOUD_LEASE_MS"
    )
  });
  let primaryError = null;
  try {
    const beforeOrder = async () => {
      assertCloudLeaseOwned(stateStore, lease, now);
      await remote.assertUnchanged(remoteSha);
    };
    const engine = await engineFactory(resolvedConfig, {
      stateStore,
      now,
      beforeOrder
    });

    let summary;
    if (command === "plan" || command === "topup-plan") {
      // plan never submits broker orders. Passing the confirmation flag here
      // only lets the same live-order risk rules validate the proposed plan.
      summary = executionSummary(
        command,
        await engine.plan(
          command === "topup-plan"
            ? {
                liveConfirmation: true,
                force: true,
                cashDeploymentOnly: true,
                cycleScope: `manual-topup-plan:${env.GITHUB_RUN_ID}`
              }
            : { liveConfirmation: true }
        )
      );
    } else if (command === "trade" || command === "topup") {
      const previous = await reconcile(engine, {
        trigger: "github-actions-pretrade",
        cancelOpenOrders: false
      });
      const previousSummary = reconciliationSummary(previous);
      if (reconciliationNeedsAttention(previousSummary)) {
        summary = {
          command,
          ok: false,
          executed: false,
          orderCount: 0,
          blockedCount: 1,
          resultStatuses: {},
          reconciliation: previousSummary
        };
      } else {
        const result = await engine.execute(
          command === "topup"
            ? {
                trigger: "github-actions-manual-topup",
                liveConfirmation: true,
                force: true,
                cashDeploymentOnly: true,
                cycleScope: `manual-topup:${env.GITHUB_RUN_ID}`
              }
            : {
                trigger: "github-actions-scheduled",
                liveConfirmation: true
              }
        );
        summary = executionSummary(command, result, previousSummary);
      }
    } else {
      const result = await reconcile(engine, {
        trigger: "github-actions-reconcile",
        cancelOpenOrders: true
      });
      const reconciliation = reconciliationSummary(result);
      const needsAttention = reconciliationNeedsAttention(reconciliation);
      summary = {
        command,
        ok: !needsAttention,
        executed: false,
        orderCount: 0,
        blockedCount: needsAttention ? 1 : 0,
        resultStatuses: {},
        reconciliation
      };
    }
    output(JSON.stringify(summary));
    assertSafeExecutionSummary(command, summary);
    return summary;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await releaseCloudLease(stateStore, lease);
    } catch (releaseError) {
      if (!primaryError) throw releaseError;
    }
  }
}

export function redactCloudRunnerError(error, env = process.env, config = null) {
  const secrets = [
    config?.kis?.appKey,
    config?.kis?.appSecret,
    config?.kis?.accountNumber,
    config?.kis?.htsId,
    env.GITHUB_TOKEN,
    env.AUTOTRADE_STATE_KEY,
    env.CLOUD_LIVE_TRADING_ACK,
    env.LIVE_TRADING_ACK,
    env.USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACK,
    env.UNATTENDED_LIVE_TRADING_ACK
  ].filter((value) => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
  // Exact values must be removed before generic account/token patterns can
  // partially rewrite them and make an exact second-pass replacement miss.
  const cloudSafe = redactCloudStateSecrets(error, secrets);
  return redactSensitive(cloudSafe, secrets);
}

async function main() {
  const command = normalizeCommand(process.argv[2] || "plan");
  let config = null;
  try {
    config = getTradingConfig({ env: process.env, loadEnv: false });
    await runCloudAutotrade({ command, config });
  } catch (error) {
    console.error("클라우드 자동투자 실행 실패:", redactCloudRunnerError(error, process.env, config));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
