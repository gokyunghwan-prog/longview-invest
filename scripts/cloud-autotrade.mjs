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
import {
  createTradingEngine,
  liveOrderWindowBoundsAreOpen
} from "../autotrade/engine.mjs";
import { redactSensitive } from "../autotrade/risk.mjs";
import { createTradingStateStore } from "../autotrade/state-store.mjs";
import { createGitHubDateTrustedClock } from "../autotrade/trusted-clock.mjs";

export const CLOUD_LIVE_ACKNOWLEDGEMENT =
  "I_ACCEPT_GITHUB_ACTIONS_LIVE_TRADING";
export const DEFAULT_CLOUD_LEASE_MS = 20 * 60 * 1_000;
export const DEFAULT_CLOUD_MUTATION_GUARD_MS = 60_000;

const CLOUD_COMMANDS = new Set([
  "plan",
  "trade",
  "auto",
  "reconcile",
  "topup-plan",
  "topup"
]);
const MUTATING_COMMANDS = new Set(["trade", "auto", "reconcile", "topup"]);
const SCHEDULED_COMMANDS = new Map([
  ["17,47 * * * 1-5", "auto"],
  ["13 6 * * 1-5", "reconcile"]
]);
const RESOLVED_RECONCILIATION_STATUSES = new Set(["none", "cleared"]);
const SAFE_RESIDUAL_CODES = new Set([
  "BELOW_MIN_ORDER",
  "POSITION_LIMIT",
  "POSITION_WEIGHT_LIMIT",
  "NO_ELIGIBLE_TARGET",
  "REPLACEMENT_WAITING",
  "CASH_LIMIT",
  "PRICE_MISSING"
]);
const SAFE_RESULT_STATUSES = new Set([
  "submitted",
  "filled",
  "rejected",
  "unknown",
  "blocked",
  "canceled",
  "partial_canceled",
  "not_found",
  "cancel_submitted"
]);
const ORDER_COMMANDS = new Set(["trade", "auto", "topup"]);
const SUCCESSFUL_ORDER_RESULT_STATUSES = new Set(["submitted", "filled"]);

export class CloudAutotradeOutcomeError extends Error {
  constructor(message = "Cloud autotrade finished with a blocked or unresolved outcome.") {
    super(message);
    this.name = "CloudAutotradeOutcomeError";
    this.code = "CLOUD_AUTOTRADE_OUTCOME_UNSAFE";
  }
}

export function publicCloudRunnerFailure(error) {
  const code = String(error?.code || "");
  let errorCode = "INTERNAL_ERROR";
  if (code === "CLOUD_AUTOTRADE_OUTCOME_UNSAFE") {
    errorCode = "UNSAFE_OUTCOME";
  } else if (code === "CLOUD_LIVE_NOT_AUTHORIZED") {
    errorCode = "AUTHORIZATION_BLOCKED";
  } else if (code.startsWith("TRUSTED_CLOCK_")) {
    errorCode = "TRUSTED_CLOCK_FAILED";
  } else if (new Set(["CLOUD_LEASE_BUSY", "CLOUD_LEASE_LOST"]).has(code)) {
    errorCode = "CLOUD_LEASE_FAILED";
  } else if (code === "CLOUD_STATE_CONFLICT") {
    errorCode = "STATE_CONFLICT";
  } else if (code === "TRADING_RUN_LOCKED") {
    errorCode = "CONCURRENT_RUN";
  }
  return { ok: false, errorCode };
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
      "클라우드 자동투자 명령은 plan, trade, auto, reconcile, topup-plan, topup 중 하나여야 합니다."
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

function parseNonNegativeInteger(value, fallback, label) {
  const resolved = value === undefined || value === null || value === "" ? fallback : value;
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label}은(는) 0 이상의 정수여야 합니다.`);
  }
  return parsed;
}

function normalizedCloudTimeBounds(value, fallback) {
  const source = value && typeof value === "object"
    ? value
    : { earliest: fallback, latest: fallback };
  const earliest = new Date(source.earliest ?? fallback);
  const latest = new Date(source.latest ?? fallback);
  if (
    Number.isNaN(earliest.getTime()) ||
    Number.isNaN(latest.getTime()) ||
    earliest.getTime() > latest.getTime()
  ) {
    const error = new Error("신뢰 시각 범위가 올바르지 않습니다.");
    error.code = "TRUSTED_CLOCK_BOUNDS_INVALID";
    throw error;
  }
  return { earliest, latest };
}

function exactTimeBounds(now) {
  const value = now();
  return normalizedCloudTimeBounds(null, value);
}

function kstBusinessDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    const error = new Error("신뢰 시각이 올바르지 않습니다.");
    error.code = "TRUSTED_CLOCK_BOUNDS_INVALID";
    throw error;
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function resolveCloudClock({ now, trustedClock, remote }) {
  if (now !== null && now !== undefined) {
    if (typeof now !== "function") throw new TypeError("현재 시각은 함수여야 합니다.");
    if (trustedClock !== null && trustedClock !== undefined) {
      throw new TypeError("주입 시각과 신뢰 시계를 동시에 지정할 수 없습니다.");
    }
    return {
      now,
      bounds: () => exactTimeBounds(now),
      refresh: async () => exactTimeBounds(now)
    };
  }

  const clock = trustedClock || createGitHubDateTrustedClock({
    sample: async () => {
      if (typeof remote.sampleServerTime !== "function") {
        const error = new Error("GitHub API 신뢰 시각 조회 기능이 없습니다.");
        error.code = "TRUSTED_CLOCK_SAMPLE_UNAVAILABLE";
        throw error;
      }
      return remote.sampleServerTime();
    }
  });
  if (
    !clock ||
    typeof clock.refresh !== "function" ||
    typeof clock.now !== "function" ||
    typeof clock.bounds !== "function"
  ) {
    const error = new Error("GitHub API 신뢰 시계 구현이 올바르지 않습니다.");
    error.code = "TRUSTED_CLOCK_IMPLEMENTATION_INVALID";
    throw error;
  }
  await clock.refresh();
  return {
    now: () => clock.now(),
    bounds: () => clock.bounds(),
    refresh: () => clock.refresh()
  };
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
  {
    owner,
    now = () => new Date(),
    timeBounds = null,
    leaseMs = DEFAULT_CLOUD_LEASE_MS
  } = {}
) {
  const normalizedOwner = String(owner || "").trim();
  if (!normalizedOwner) throw new Error("클라우드 lease 소유자 식별자가 없습니다.");
  const duration = parsePositiveInteger(leaseMs, DEFAULT_CLOUD_LEASE_MS, "클라우드 lease 시간");
  const acquiredAt = now();
  const bounds = normalizedCloudTimeBounds(
    timeBounds ? timeBounds() : null,
    acquiredAt
  );
  const expiresAt = new Date(bounds.latest.getTime() + duration);
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
        currentExpiry > bounds.earliest.getTime()
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

export function assertCloudLeaseOwned(
  stateStore,
  lease,
  now = () => new Date(),
  { timeBounds = null, minimumRemainingMs = 0 } = {}
) {
  const current = stateStore.snapshot().cloud?.lease;
  const checkedAt = now();
  const bounds = normalizedCloudTimeBounds(
    timeBounds ? timeBounds() : null,
    checkedAt
  );
  const remainingGuard = parseNonNegativeInteger(
    minimumRemainingMs,
    0,
    "클라우드 lease 최소 잔여시간"
  );
  if (
    !current ||
    current.owner !== lease.owner ||
    current.fence !== lease.fence ||
    Date.parse(current.expiresAt || "") <= bounds.latest.getTime() + remainingGuard
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

function safeBlockedCode(reason) {
  const text = String(reason || "").toLowerCase();
  if (text.includes("허용시간") || text.includes("order window")) {
    return "OUTSIDE_ORDER_WINDOW";
  }
  if (text.includes("새로 게시") || text.includes("이전 신호")) {
    return "STALE_SIGNAL";
  }
  if (text.includes("스냅샷") && text.includes("오래")) {
    return "STALE_SNAPSHOT";
  }
  if (
    text.includes("확인이 끝나지 않은") ||
    text.includes("잔고에 반영") ||
    text.includes("미결")
  ) {
    return "UNRESOLVED_ORDER";
  }
  if (text.includes("관리 밖")) return "UNMANAGED_POSITION";
  if (text.includes("긴급 정지")) return "KILL_SWITCH";
  if (text.includes("이미 처리")) return "ALREADY_COMPLETED";
  if (text.includes("후보 수")) return "CANDIDATE_COUNT_CHANGE";
  if (text.includes("최소 주문")) return "BELOW_MIN_ORDER";
  if (text.includes("종목 수")) return "POSITION_LIMIT";
  if (text.includes("종목당") || text.includes("비중")) {
    return "POSITION_WEIGHT_LIMIT";
  }
  if (text.includes("후보") || text.includes("선정")) return "NO_ELIGIBLE_TARGET";
  return "RISK_BLOCKED";
}

function safeResidualCode(reason) {
  const text = String(reason || "").toLowerCase();
  if (text.includes("minimum_order")) return "BELOW_MIN_ORDER";
  if (text.includes("position_weight")) return "POSITION_WEIGHT_LIMIT";
  if (
    text.includes("maximum_orders") ||
    text.includes("maximum_positions")
  ) {
    return "POSITION_LIMIT";
  }
  if (
    text.includes("replacement_waiting") ||
    text.includes("removal_confirmation_pending")
  ) {
    return "REPLACEMENT_WAITING";
  }
  if (text.includes("turnover_or_cash_limit")) return "CASH_LIMIT";
  if (text.includes("target_price_missing") || text.includes("position_price_missing")) {
    return "PRICE_MISSING";
  }
  if (text.includes("data_failure") || text.includes("portfolio_not_deployable")) {
    return "NO_ELIGIBLE_TARGET";
  }
  return null;
}

function resultOutcomeCodes(command, result, orders) {
  if (!ORDER_COMMANDS.has(command) || result?.alreadyCompleted === true) return [];
  const results = Array.isArray(result?.results) ? result.results : [];
  if (orders.length === 0 && results.length === 0) return [];
  const codes = new Set();
  if (results.length !== orders.length) codes.add("INCOMPLETE_RESULT_SET");
  let successCount = 0;
  let unsafeCount = 0;
  for (const item of results) {
    const status = String(item?.status || "unknown").toLowerCase();
    if (SUCCESSFUL_ORDER_RESULT_STATUSES.has(status)) {
      successCount += 1;
      continue;
    }
    unsafeCount += 1;
    if (status === "blocked" && item?.notSent === true) {
      codes.add("ORDER_BLOCKED_NOT_SENT");
    } else if (status === "blocked") {
      codes.add("ORDER_BLOCKED");
    } else if (status === "rejected") {
      codes.add("ORDER_REJECTED");
    } else if (status === "unknown") {
      codes.add("ORDER_UNKNOWN");
    } else {
      codes.add("UNEXPECTED_RESULT_STATUS");
    }
  }
  if (successCount > 0 && unsafeCount > 0) codes.add("MIXED_RESULT");
  return [...codes];
}

function executionSummary(command, result, reconciliation = null) {
  const statuses = Array.isArray(result?.results)
    ? result.results.reduce((counts, item) => {
        const rawStatus = String(item?.status || "unknown").toLowerCase();
        const status = SAFE_RESULT_STATUSES.has(rawStatus) ? rawStatus : "other";
        counts[status] = (counts[status] || 0) + 1;
        return counts;
      }, {})
    : {};
  const orders = Array.isArray(result?.orders) ? result.orders : [];
  const resultBlockedCodes = resultOutcomeCodes(command, result, orders);
  const blockedCodes = [
    ...new Set(
      (Array.isArray(result?.blockedReasons) ? result.blockedReasons : [])
        .map(safeBlockedCode)
    )
  ];
  const plannerDiagnostics = result?.planner?.diagnostics;
  const residualCodes = [
    ...new Set([
      ...(Array.isArray(plannerDiagnostics?.skipped)
        ? plannerDiagnostics.skipped
            .map((item) => safeResidualCode(item?.reason))
            .filter(Boolean)
        : []),
      ...(SAFE_RESIDUAL_CODES.has(plannerDiagnostics?.cashDeploymentResidualCode)
        ? [plannerDiagnostics.cashDeploymentResidualCode]
        : [])
    ])
  ];
  const orderSubmissionAttempted =
    Array.isArray(result?.results) &&
    result.results.some(
      (item) =>
        item?.notSent !== true &&
        !["blocked", "intent_persisted"].includes(
          String(item?.status || "").toLowerCase()
        )
    );
  return {
    command,
    ok: result?.ok !== false && resultBlockedCodes.length === 0,
    executed: result?.executed === true,
    orderSubmissionAttempted,
    orderCount: orders.length,
    plannedBuyCount: orders.filter((order) => order?.side === "buy").length,
    plannedSellCount: orders.filter((order) => order?.side === "sell").length,
    blockedCount:
      (Array.isArray(result?.blockedReasons) ? result.blockedReasons.length : 0) +
      resultBlockedCodes.length,
    blockedCodes,
    resultBlockedCodes,
    residualCodes,
    deploymentPhase: ["initial", "routine"].includes(
      result?.planner?.diagnostics?.deploymentPhase
    )
      ? result.planner.diagnostics.deploymentPhase
      : null,
    cashDeploymentActive:
      result?.planner?.diagnostics?.cashDeploymentActive === true,
    idempotentDuplicate: result?.alreadyCompleted === true,
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
    new Set(["plan", "trade", "auto", "topup-plan", "topup"]).has(command) &&
    (summary?.ok !== true || Number(summary?.blockedCount) > 0);
  const unresolvedReconciliation =
    new Set(["trade", "auto", "reconcile", "topup"]).has(command) &&
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
  now = null,
  trustedClock = null,
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

  const cloudClock = await resolveCloudClock({ now, trustedClock, remote });
  const resolvedNow = cloudClock.now;

  if (command === "auto") {
    const trustedBounds = normalizedCloudTimeBounds(
      cloudClock.bounds(),
      resolvedNow()
    );
    if (!liveOrderWindowBoundsAreOpen(trustedBounds)) {
      const summary = {
        ...executionSummary("auto", {
          ok: true,
          executed: false,
          orders: [],
          results: [],
          blockedReasons: []
        }),
        skipped: true,
        skipCode: "OUTSIDE_ORDER_WINDOW",
        blockedCodes: ["OUTSIDE_ORDER_WINDOW"]
      };
      output(JSON.stringify(summary));
      return summary;
    }
  }

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
    now: resolvedNow,
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
    now: resolvedNow,
    timeBounds: cloudClock.bounds,
    leaseMs: parsePositiveInteger(
      env.AUTOTRADE_CLOUD_LEASE_MS,
      DEFAULT_CLOUD_LEASE_MS,
      "AUTOTRADE_CLOUD_LEASE_MS"
    )
  });
  let primaryError = null;
  try {
    const refreshMutationFence = async () => {
      await cloudClock.refresh();
      await remote.assertUnchanged(remoteSha);
      assertCloudLeaseOwned(stateStore, lease, resolvedNow, {
        timeBounds: cloudClock.bounds,
        minimumRemainingMs: DEFAULT_CLOUD_MUTATION_GUARD_MS
      });
    };
    const engine = await engineFactory(resolvedConfig, {
      stateStore,
      now: resolvedNow,
      timeBounds: cloudClock.bounds,
      beforePersist: refreshMutationFence,
      beforeOrder: refreshMutationFence
    });

    let summary;
    if (command === "plan" || command === "topup-plan") {
      await cloudClock.refresh();
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
    } else if (command === "trade" || command === "auto" || command === "topup") {
      await cloudClock.refresh();
      const previous = await reconcile(engine, {
        trigger: "github-actions-pretrade",
        cancelOpenOrders: false
      });
      const previousSummary = reconciliationSummary(previous);
      if (reconciliationNeedsAttention(previousSummary)) {
        summary = executionSummary(
          command,
          {
            ok: false,
            executed: false,
            orders: [],
            results: [],
            blockedReasons: ["확인이 끝나지 않은 이전 주문 실행이 있습니다."]
          },
          previousSummary
        );
      } else {
        await cloudClock.refresh();
        const result = await engine.execute(
          command === "topup"
            ? {
                trigger: "github-actions-manual-topup",
                liveConfirmation: true,
                force: true,
                cashDeploymentOnly: true,
                cycleScope: `manual-topup:${env.GITHUB_RUN_ID}`
              }
            : command === "auto"
              ? {
                  trigger: "github-actions-scheduled-auto",
                  liveConfirmation: true,
                  scheduledRetry: true,
                  cycleScope: `scheduled-trade:${kstBusinessDate(resolvedNow())}`
                }
            : {
                trigger: "github-actions-scheduled",
                liveConfirmation: true
              }
        );
        summary = executionSummary(command, result, previousSummary);
      }
    } else {
      await cloudClock.refresh();
      const result = await reconcile(engine, {
        trigger: "github-actions-reconcile",
        cancelOpenOrders: true
      });
      const reconciliation = reconciliationSummary(result);
      const needsAttention = reconciliationNeedsAttention(reconciliation);
      summary = executionSummary(
        command,
        {
          ok: !needsAttention,
          executed: false,
          orders: [],
          results: [],
          blockedReasons: needsAttention
            ? ["확인이 끝나지 않은 이전 주문 실행이 있습니다."]
            : []
        },
        reconciliation
      );
    }
    output(JSON.stringify(summary));
    assertSafeExecutionSummary(command, summary);
    return summary;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await cloudClock.refresh();
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
  let command = "plan";
  let config = null;
  try {
    command = normalizeCommand(process.argv[2] || "plan");
    config = getTradingConfig({ env: process.env, loadEnv: false });
    await runCloudAutotrade({ command, config });
  } catch (error) {
    console.error(JSON.stringify(publicCloudRunnerFailure(error)));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
