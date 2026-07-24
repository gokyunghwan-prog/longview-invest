import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { KisBroker } from "../brokers/kis.mjs";
import {
  LIVE_ACKNOWLEDGEMENT,
  UNATTENDED_LIVE_ACKNOWLEDGEMENT,
  USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACKNOWLEDGEMENT,
  getTradingConfig
} from "../config.mjs";
import { createTradingEngine } from "../engine.mjs";
import { redactSensitive } from "../risk.mjs";
import { createLongviewApp } from "../../server.mjs";
import { getRuntimeConfig } from "../../lib/config.mjs";
import {
  S3ArtifactStore,
  copyArtifactBaseline
} from "../../lib/aws-artifacts.mjs";
import { createAwsClients } from "./clients.mjs";
import { AwsTradingControl } from "./control.mjs";
import {
  DEFAULT_AWS_SYNC_LEASE_MS,
  DEFAULT_AWS_TRADE_LEASE_MS,
  DEFAULT_AWS_LEASE_HEARTBEAT_MS,
  DynamoLeaseGuard,
  DynamoTradingRepository
} from "./dynamo.mjs";
import { createAwsStructuredLogger } from "./logging.mjs";
import {
  applySecretEnvironment,
  loadJsonSecret
} from "./secrets.mjs";
import { createDynamoBackedTradingStateStore } from "./state-adapter.mjs";
import { DynamoKisTokenCache } from "./token-cache.mjs";
import {
  attestEcsRuntime,
  compactKstBusinessDate,
  kstBusinessDate,
  validateAwsInvocation
} from "./runtime-guard.mjs";

const SAFE_ORDER_RESULT_STATUSES = new Set(["submitted", "filled"]);
const RESOLVED_RECONCILIATION_STATUSES = new Set(["none", "cleared"]);
const TERMINAL_EXECUTION_STATUSES = new Set([
  "success",
  "market_closed",
  "dry_run"
]);
const DEFAULT_MAX_PUBLISHED_CANDIDATES = 50;

function requiredText(value, label, maximum = 2_048) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new TypeError(`${label}이(가) 없거나 너무 깁니다.`);
  }
  return normalized;
}

function positiveInteger(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value === undefined || value === "" ? fallback : value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new TypeError(`${label}은(는) 1~${maximum} 정수여야 합니다.`);
  }
  return parsed;
}

function exactEnvironment(env, key, expected) {
  if (env[key] !== undefined && String(env[key]) !== expected) {
    throw new Error(`${key}는 AWS 승인값 ${expected}와 일치해야 합니다.`);
  }
  env[key] = expected;
}

export function applyAwsTradingEnvironment(env = process.env) {
  const expected = {
    AUTOTRADE_CLOUD_PROVIDER: "aws-fargate",
    TRADING_MODE: "live",
    TRADING_BROKER: "kis",
    KIS_ENV: "prod",
    TRADING_REBALANCE_FREQUENCY: "daily",
    TRADING_MIN_POSITIONS: "3",
    TRADING_MAX_POSITIONS: "5",
    TRADING_CASH_RESERVE_PERCENT: "0",
    TRADING_MAX_POSITION_PERCENT: "35",
    TRADING_MAX_SECTOR_PERCENT: "35",
    TRADING_MIN_POSITION_KRW: "20000",
    TRADING_MIN_ORDER_KRW: "5000",
    TRADING_CAPITAL_LIMIT_KRW: "0",
    TRADING_USE_ALL_DEDICATED_ACCOUNT_ASSETS: "true",
    TRADING_INITIAL_DEPLOYMENT_TURNOVER_PERCENT: "100",
    TRADING_MAX_TURNOVER_PERCENT: "20",
    TRADING_AUTODEPLOY_CASH: "true",
    TRADING_MAX_ORDERS_PER_RUN: "10",
    TRADING_REBALANCE_DRIFT_PERCENT: "3",
    TRADING_REMOVAL_CONFIRMATIONS: "2",
    TRADING_REPLACEMENT_SCORE_LEAD: "3",
    TRADING_REQUIRE_DEDICATED_ACCOUNT: "true",
    TRADING_REQUIRE_PUBLISHED_SELECTION: "true",
    TRADING_AUTORUN_ENABLED: "true",
    ENABLE_LIVE_TRADING: "true",
    ENABLE_UNATTENDED_LIVE_TRADING: "true",
    LIVE_TRADING_ACK: LIVE_ACKNOWLEDGEMENT,
    USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACK:
      USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACKNOWLEDGEMENT,
    UNATTENDED_LIVE_TRADING_ACK: UNATTENDED_LIVE_ACKNOWLEDGEMENT
  };
  for (const [key, value] of Object.entries(expected)) {
    exactEnvironment(env, key, value);
  }
  return env;
}

function executionMode(env) {
  const mode = String(env.AUTOTRADE_EXECUTION_MODE || "dry-run")
    .trim()
    .toLowerCase();
  if (!new Set(["dry-run", "live"]).has(mode)) {
    throw new Error("AUTOTRADE_EXECUTION_MODE는 dry-run 또는 live여야 합니다.");
  }
  if (mode === "live" && env.AUTOTRADE_LIVE_ENABLED !== "true") {
    const error = new Error("AWS live 환경 승인이 활성화되지 않았습니다.");
    error.code = "AWS_LIVE_ENV_DISABLED";
    throw error;
  }
  return mode;
}

function reconciliationSummary(result) {
  return {
    status: String(result?.status || "unknown"),
    pendingCount: Number.isSafeInteger(result?.pendingCount)
      ? result.pendingCount
      : null,
    canceledCount: Number.isSafeInteger(result?.canceledCount)
      ? result.canceledCount
      : null,
    ambiguous: result?.ambiguous === true
  };
}

function planSummary(command, result, reconciliation = null) {
  const orders = Array.isArray(result?.orders) ? result.orders : [];
  const results = Array.isArray(result?.results) ? result.results : [];
  return {
    command,
    ok: result?.ok === true,
    executed: result?.executed === true,
    alreadyCompleted: result?.alreadyCompleted === true,
    cycleKey: String(result?.cycleKey || "") || null,
    signalRevision: String(result?.signal?.revision || "") || null,
    rawRevision: String(result?.signal?.rawRevision || "") || null,
    candidateCount: Number.isSafeInteger(result?.signal?.candidateCount)
      ? result.signal.candidateCount
      : null,
    selectedCount: Array.isArray(result?.portfolio?.selected)
      ? result.portfolio.selected.length
      : 0,
    orderCount: orders.length,
    resultCount: results.length,
    buyCount: orders.filter((order) => order?.side === "buy").length,
    sellCount: orders.filter((order) => order?.side === "sell").length,
    resultStatuses: results.reduce((counts, item) => {
      const status = String(item?.status || "unknown").toLowerCase();
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {}),
    blockedCount: Array.isArray(result?.blockedReasons)
      ? result.blockedReasons.length
      : 0,
    residualCode:
      String(result?.planner?.diagnostics?.cashDeploymentResidualCode || "") ||
      null,
    ...(reconciliation ? { reconciliation } : {})
  };
}

function assertSafePlan(summary) {
  const liveOrderResultIncomplete =
    summary?.mode === "live" &&
    summary?.alreadyCompleted !== true &&
    summary?.orderCount > 0 &&
    (
      summary?.executed !== true ||
      summary?.resultCount !== summary?.orderCount
    );
  const unsafeResultStatus =
    summary?.mode === "live" &&
    Object.keys(summary?.resultStatuses || {}).some(
      (status) => !SAFE_ORDER_RESULT_STATUSES.has(status)
    );
  if (
    summary?.ok !== true ||
    Number(summary?.blockedCount) > 0 ||
    liveOrderResultIncomplete ||
    unsafeResultStatus
  ) {
    const error = new Error("AWS 자동투자 결과에 차단 또는 불명확 주문이 있습니다.");
    error.code = "AWS_AUTOTRADE_UNSAFE_OUTCOME";
    throw error;
  }
}

function assertResolvedReconciliation(result, { final = true } = {}) {
  const summary = reconciliationSummary(result);
  if (final && !RESOLVED_RECONCILIATION_STATUSES.has(summary.status)) {
    const error = new Error("AWS 최종 주문대조가 아직 해결되지 않았습니다.");
    error.code = "AWS_RECONCILIATION_UNRESOLVED";
    throw error;
  }
  return summary;
}

function terminalExecution(record) {
  return record?.terminal === true && TERMINAL_EXECUTION_STATUSES.has(record.status);
}

function concurrentExecutionSummary(command, mode, invocation, logger) {
  const summary = {
    command,
    mode,
    concurrentDuplicate: true,
    businessDate: invocation.businessDate,
    scheduleSlot: invocation.scheduleSlot
  };
  logger.info("aws_task_concurrent_duplicate", summary);
  return summary;
}

function createTaskDeadline({ env, invocation, now, fallbackMs, maximumMs }) {
  const durationMs = positiveInteger(
    env.AUTOTRADE_TASK_DEADLINE_MS,
    fallbackMs,
    "AWS task 제한시간",
    maximumMs
  );
  const guardMs = positiveInteger(
    env.AUTOTRADE_TASK_DEADLINE_GUARD_MS,
    60_000,
    "AWS task 종료 안전여유",
    Math.max(1, durationMs - 1)
  );
  const expiresAt = invocation.current.getTime() + durationMs;
  return {
    expiresAt,
    ensure() {
      if (now().getTime() >= expiresAt - guardMs) {
        const error = new Error(
          "AWS task 제한시간이 임박해 추가 상태변경과 주문을 차단했습니다."
        );
        error.code = "AWS_TASK_DEADLINE";
        throw error;
      }
      return { expiresAt, guardMs };
    }
  };
}

function childExitError(script, code, signal) {
  const error = new Error(`${script} 실행이 성공적으로 끝나지 않았습니다.`);
  error.code = "AWS_SYNC_CHILD_FAILED";
  error.exitCode = code;
  error.signal = signal || null;
  return error;
}

async function runNodeScript(script, args = [], { env = process.env, cwd } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(childExitError(script, code, signal));
    });
  });
}

export function awsResourceSettings(env, command) {
  const normalizedCommand = requiredText(command, "AWS resource command", 32);
  const requiresTradingControl = new Set(["auto", "reconcile"]).has(
    normalizedCommand
  );
  return {
    tableName: requiredText(env.AUTOTRADE_STATE_TABLE, "AWS 상태 테이블"),
    bucket: requiredText(env.AUTOTRADE_SNAPSHOT_BUCKET, "AWS snapshot bucket"),
    namespace: String(env.AUTOTRADE_STATE_NAMESPACE || "longview").trim(),
    controlParameter: requiresTradingControl
      ? requiredText(
          env.AUTOTRADE_KILL_SWITCH_PARAMETER,
          "AWS 자동투자 제어 파라미터"
        )
      : "",
    kisSecretArn: String(env.AUTOTRADE_KIS_SECRET_ARN || "").trim(),
    dataSecretArn: String(env.AUTOTRADE_DATA_SECRET_ARN || "").trim()
  };
}

async function loadKisEnvironment({ clients, secretArn, env }) {
  const secret = await loadJsonSecret({
    client: clients.secrets,
    secretId: requiredText(secretArn, "KIS Secret ARN"),
    requiredKeys: [
      "KIS_APP_KEY",
      "KIS_APP_SECRET",
      "KIS_ACCOUNT_NUMBER",
      "KIS_ACCOUNT_PRODUCT_CODE"
    ],
    allowedKeys: [
      "KIS_APP_KEY",
      "KIS_APP_SECRET",
      "KIS_ACCOUNT_NUMBER",
      "KIS_ACCOUNT_PRODUCT_CODE",
      "KIS_HTS_ID"
    ]
  });
  applySecretEnvironment(secret, env);
  applyAwsTradingEnvironment(env);
  return secret;
}

async function loadDataEnvironment({ clients, secretArn, env }) {
  const secret = await loadJsonSecret({
    client: clients.secrets,
    secretId: requiredText(secretArn, "데이터 수집 Secret ARN"),
    requiredKeys: ["DART_API_KEY", "DATA_GO_KR_API_KEY"],
    allowedKeys: ["DART_API_KEY", "DATA_GO_KR_API_KEY"]
  });
  applySecretEnvironment(secret, env);
  return secret;
}

function createRepository({ clients, resources, now }) {
  return new DynamoTradingRepository({
    client: clients.dynamo,
    tableName: resources.tableName,
    namespace: resources.namespace,
    now: () => now().getTime()
  });
}

async function startLocalRankingApi({
  rootDir,
  companiesFile,
  selectionFile
}) {
  const base = getRuntimeConfig();
  const config = {
    ...base,
    rootDir,
    dataFile: companiesFile,
    investmentSelectionFile: selectionFile,
    remoteSnapshotUrl: "",
    remoteArtifactManifestUrl: "",
    remoteInvestmentSelectionUrl: "",
    remoteSnapshotToken: "",
    remoteStartupRefreshRequired: false,
    schedulerEnabled: false,
    host: "127.0.0.1",
    port: 0
  };
  const app = await createLongviewApp(config);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  if (!address || typeof address !== "object" || !Number.isInteger(address.port)) {
    await app.close().catch(() => {});
    throw new Error("AWS Longview 로컬 API가 포트를 열지 못했습니다.");
  }
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

function trustedNow(now) {
  return {
    now,
    bounds: () => {
      const current = now();
      return { earliest: current, latest: current };
    }
  };
}

async function buildTradingRuntime({
  clients,
  resources,
  artifactStore,
  repository,
  lease,
  control,
  invocation,
  mode,
  env,
  logger,
  now,
  deadline
}) {
  deadline.ensure();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "longview-aws-trade-"));
  const dataDirectory = path.join(runtimeRoot, "data");
  const companiesFile = path.join(dataDirectory, "companies.json");
  const selectionFile = path.join(dataDirectory, "trading-selection.json");
  await mkdir(dataDirectory, { recursive: true });
  const materialized = await artifactStore.materializeLatest({
    companiesFile,
    selectionFile
  });
  deadline.ensure();
  if (!materialized.exists) {
    const error = new Error("AWS S3에 게시된 투자 snapshot이 없습니다.");
    error.code = "AWS_SNAPSHOT_NOT_PUBLISHED";
    throw error;
  }
  const maxCandidates = positiveInteger(
    env.AUTOTRADE_MAX_PUBLISHED_CANDIDATES,
    DEFAULT_MAX_PUBLISHED_CANDIDATES,
    "AWS 최대 게시 후보 수",
    100
  );
  if (materialized.selection.ranked.length > maxCandidates) {
    const error = new Error("AWS 게시 후보 수가 실행 안전한도를 초과했습니다.");
    error.code = "AWS_CANDIDATE_LIMIT";
    throw error;
  }

  const ranking = await startLocalRankingApi({
    rootDir: path.resolve("."),
    companiesFile,
    selectionFile
  });
  env.LONGVIEW_BASE_URL = ranking.baseUrl;
  const config = getTradingConfig({
    env,
    rootDir: runtimeRoot,
    loadEnv: false
  });
  const tokenCache = new DynamoKisTokenCache({
    client: clients.dynamo,
    tableName: resources.tableName,
    namespace: resources.namespace,
    environment: config.kis.environment,
    appKey: config.kis.appKey,
    now: () => now().getTime()
  });
  const broker = new KisBroker(config.kis, {
    now: () => now().getTime(),
    tokenCache
  });
  const backed = await createDynamoBackedTradingStateStore({
    repository,
    stateDir: config.stateDir,
    startingCashKrw: config.paper.startingCashKrw,
    now,
    requireExisting: env.AUTOTRADE_ALLOW_EMPTY_STATE !== "true",
    auditSink: logger.audit
  });

  const checkMutation = async (context = null) => {
    deadline.ensure();
    await lease.ensure();
    await backed.assertCurrentVersion();
    if (context?.type === "cancel") {
      await control.assertCancellationAllowed(mode);
    } else {
      await control.assertNewOrdersAllowed(mode);
    }
  };
  const clock = trustedNow(now);
  const engine = await createTradingEngine(config, {
    stateStore: backed.stateStore,
    broker,
    now,
    timeBounds: clock.bounds,
    beforePersist: () => checkMutation(),
    beforeOrder: (_order, _index, context) => checkMutation(context),
    killSwitch: () => control.killSwitchActive(mode)
  });
  return {
    runtimeRoot,
    ranking,
    materialized,
    config,
    broker,
    backed,
    engine
  };
}

async function finishExecution({
  repository,
  journalCommand,
  invocation,
  status,
  summary,
  logger
}) {
  await repository.markExecutionFinished({
    command: journalCommand,
    businessDate: invocation.businessDate,
    executionId: invocation.executionId,
    status,
    summary
  });
  logger.metric(status === "failed" ? "ExecutionFailed" : "ExecutionSucceeded", 1, {
    dimensions: {
      Command: journalCommand,
      Mode: String(summary?.mode || "unknown")
    }
  });
  if (journalCommand === "auto" && status !== "failed") {
    logger.metric("TradeCycleSuccess", 1);
  }
}

async function runAutoOrReconcile({
  command,
  invocation,
  env,
  clients,
  resources,
  logger,
  now,
  fetchImpl
}) {
  const mode = executionMode(env);
  const deadline = createTaskDeadline({
    env,
    invocation,
    now,
    fallbackMs: 29 * 60_000,
    maximumMs: 30 * 60_000
  });
  if (mode === "live") await attestEcsRuntime({ env, fetchImpl });
  const repository = createRepository({ clients, resources, now });
  const artifactStore = new S3ArtifactStore({
    client: clients.s3,
    bucket: resources.bucket
  });
  const control = new AwsTradingControl({
    client: clients.ssm,
    parameterName: resources.controlParameter
  });
  const journalCommand =
    command === "reconcile" ? invocation.scheduleSlot : command;
  const previous = await repository.getExecution({
    command: journalCommand,
    businessDate: invocation.businessDate
  });
  if (terminalExecution(previous)) {
    const summary = {
      command,
      mode,
      idempotentDuplicate: true,
      previousStatus: previous.status
    };
    logger.info("aws_task_idempotent_duplicate", summary);
    return summary;
  }

  let lease;
  try {
    lease = await DynamoLeaseGuard.acquire({
      client: clients.dynamo,
      tableName: resources.tableName,
      namespace: resources.namespace,
      scope: "trading",
      owner: invocation.executionId,
      leaseMs: positiveInteger(
        env.AUTOTRADE_AWS_TRADE_LEASE_MS,
        DEFAULT_AWS_TRADE_LEASE_MS,
        "AWS 거래 lease",
        4 * 60 * 60 * 1_000
      ),
      now: () => now().getTime(),
      heartbeatMs: positiveInteger(
        env.AUTOTRADE_AWS_LEASE_HEARTBEAT_MS,
        DEFAULT_AWS_LEASE_HEARTBEAT_MS,
        "AWS lease heartbeat",
        60 * 60 * 1_000
      )
    });
  } catch (error) {
    if (error?.code === "AWS_LEASE_BUSY") {
      if (command === "reconcile" && invocation.finalReconcile) throw error;
      return concurrentExecutionSummary(command, mode, invocation, logger);
    }
    throw error;
  }
  lease.startHeartbeat();
  let runtime = null;
  let preflightRoot = null;
  let primaryError = null;
  let executionStarted = false;
  try {
    deadline.ensure();
    await repository.markExecutionStarted({
      command: journalCommand,
      businessDate: invocation.businessDate,
      executionId: invocation.executionId,
      scheduledAt: invocation.scheduledAt.toISOString(),
      mode
    });
    executionStarted = true;
    if (mode === "live") {
      if (command === "auto") await control.assertNewOrdersAllowed(mode);
      else await control.assertCancellationAllowed(mode);
    }

    if (command === "auto") {
      // A temporary config is sufficient for the read-only holiday endpoint.
      preflightRoot = await mkdtemp(
        path.join(tmpdir(), "longview-aws-preflight-")
      );
      env.LONGVIEW_BASE_URL = "http://127.0.0.1:1";
      const preliminaryConfig = getTradingConfig({
        env,
        rootDir: preflightRoot,
        loadEnv: false
      });
      const preliminaryTokenCache = new DynamoKisTokenCache({
        client: clients.dynamo,
        tableName: resources.tableName,
        namespace: resources.namespace,
        environment: preliminaryConfig.kis.environment,
        appKey: preliminaryConfig.kis.appKey,
        now: () => now().getTime()
      });
      const preliminaryBroker = new KisBroker(preliminaryConfig.kis, {
        now: () => now().getTime(),
        tokenCache: preliminaryTokenCache
      });
      const tradingDay = await preliminaryBroker.getTradingDayStatus(
        compactKstBusinessDate(invocation.scheduledAt)
      );
      deadline.ensure();
      if (!tradingDay.canPlaceOrders) {
        const summary = {
          command,
          mode,
          marketClosed: true,
          businessDate: invocation.businessDate
        };
        await finishExecution({
          repository,
          journalCommand,
          invocation,
          status: "market_closed",
          summary,
          logger
        });
        logger.info("aws_market_closed", summary);
        return summary;
      }
    }

    runtime = await buildTradingRuntime({
      clients,
      resources,
      artifactStore,
      repository,
      lease,
      control,
      invocation,
      mode,
      env,
      logger,
      now,
      deadline
    });
    let summary;
    if (command === "auto") {
      deadline.ensure();
      const previousReconciliation = await runtime.engine.reconcileInFlight({
        cancelOpenOrders: false,
        trigger: "aws-pretrade"
      });
      const previousSummary = assertResolvedReconciliation(previousReconciliation);
      if (mode === "dry-run") {
        const planned = await runtime.engine.plan({
          liveConfirmation: true,
          scheduledRetry: true,
          cycleScope: `scheduled-trade:${invocation.businessDate}`
        });
        summary = {
          ...planSummary("auto", planned, previousSummary),
          mode,
          artifactRevision: runtime.materialized.manifest.revision
        };
      } else {
        const executed = await runtime.engine.execute({
          trigger: "aws-scheduled-auto",
          liveConfirmation: true,
          scheduledRetry: true,
          cycleScope: `scheduled-trade:${invocation.businessDate}`
        });
        summary = {
          ...planSummary("auto", executed, previousSummary),
          mode,
          artifactRevision: runtime.materialized.manifest.revision
        };
      }
      assertSafePlan(summary);
    } else {
      const reconciliation = await runtime.engine.reconcileInFlight({
        cancelOpenOrders: mode === "live",
        trigger: `aws-${invocation.scheduleSlot}`
      });
      const final = invocation.finalReconcile;
      const reconciled = assertResolvedReconciliation(reconciliation, { final });
      summary = {
        command: "reconcile",
        mode,
        artifactRevision: runtime.materialized.manifest.revision,
        reconciliation: reconciled,
        final
      };
      if (!final && !RESOLVED_RECONCILIATION_STATUSES.has(reconciled.status)) {
        logger.warn("aws_reconciliation_pending", summary);
      }
    }
    await finishExecution({
      repository,
      journalCommand,
      invocation,
      status: mode === "dry-run" ? "dry_run" : "success",
      summary,
      logger
    });
    logger.info("aws_task_completed", summary);
    return summary;
  } catch (error) {
    primaryError = error;
    const summary = {
      command,
      mode,
      errorCode: String(error?.code || "AWS_TASK_FAILED")
    };
    if (executionStarted) {
      try {
        await finishExecution({
          repository,
          journalCommand,
          invocation,
          status: "failed",
          summary,
          logger
        });
      } catch {
        // The original trading/durable-state error remains authoritative.
      }
    }
    throw error;
  } finally {
    await runtime?.ranking?.app?.close().catch(() => {});
    if (runtime?.runtimeRoot) {
      await rm(runtime.runtimeRoot, { recursive: true, force: true }).catch(() => {});
    }
    if (preflightRoot) {
      await rm(preflightRoot, { recursive: true, force: true }).catch(() => {});
    }
    try {
      await lease.release();
    } catch (releaseError) {
      if (!primaryError) throw releaseError;
    }
  }
}

async function runSyncTask({
  invocation,
  env,
  clients,
  resources,
  logger,
  now,
  projectRoot
}) {
  const repository = createRepository({ clients, resources, now });
  const deadline = createTaskDeadline({
    env,
    invocation,
    now,
    fallbackMs: 119 * 60_000,
    maximumMs: 120 * 60_000
  });
  const previous = await repository.getExecution({
    command: "sync",
    businessDate: invocation.businessDate
  });
  if (terminalExecution(previous)) {
    const summary = {
      command: "sync",
      mode: "data",
      idempotentDuplicate: true,
      previousStatus: previous.status
    };
    logger.info("aws_sync_idempotent_duplicate", summary);
    return summary;
  }
  let lease;
  try {
    lease = await DynamoLeaseGuard.acquire({
      client: clients.dynamo,
      tableName: resources.tableName,
      namespace: resources.namespace,
      scope: "sync",
      owner: invocation.executionId,
      leaseMs: positiveInteger(
        env.AUTOTRADE_AWS_SYNC_LEASE_MS,
        DEFAULT_AWS_SYNC_LEASE_MS,
        "AWS sync lease",
        4 * 60 * 60 * 1_000
      ),
      now: () => now().getTime(),
      heartbeatMs: positiveInteger(
        env.AUTOTRADE_AWS_LEASE_HEARTBEAT_MS,
        DEFAULT_AWS_LEASE_HEARTBEAT_MS,
        "AWS lease heartbeat",
        60 * 60 * 1_000
      )
    });
  } catch (error) {
    if (error?.code === "AWS_LEASE_BUSY") {
      return concurrentExecutionSummary("sync", "data", invocation, logger);
    }
    throw error;
  }
  lease.startHeartbeat();
  const artifactStore = new S3ArtifactStore({
    client: clients.s3,
    bucket: resources.bucket
  });
  const dataDirectory = path.join(projectRoot, "data");
  const companiesFile = path.join(dataDirectory, "companies.json");
  const selectionFile = path.join(dataDirectory, "trading-selection.json");
  const dartDirectory = path.join(dataDirectory, "dart-market");
  const previousFile = path.join(
    tmpdir(),
    `longview-previous-${process.pid}-${randomUUID()}.json`
  );
  let previousSnapshot = null;
  let primaryError = null;
  let executionStarted = false;
  let checkpointsUploaded = false;
  try {
    deadline.ensure();
    await repository.markExecutionStarted({
      command: "sync",
      businessDate: invocation.businessDate,
      executionId: invocation.executionId,
      scheduledAt: invocation.scheduledAt.toISOString(),
      mode: "data"
    });
    executionStarted = true;
    await artifactStore.restoreDartCheckpoints({ directory: dartDirectory });
    const restored = await artifactStore.materializeLatest({
      companiesFile,
      selectionFile
    });
    if (restored.exists) previousSnapshot = restored.snapshot;
    const hasBaseline = await copyArtifactBaseline(companiesFile, previousFile);
    if (hasBaseline && !previousSnapshot) {
      previousSnapshot = JSON.parse(await readFile(previousFile, "utf8"));
    }

    const childEnv = {
      ...env,
      ALLOW_PRICE_PROVIDER_FAILURE: "false",
      ENABLE_SCHEDULER: "false"
    };
    await runNodeScript("scripts/sync-daily-markets.mjs", [], {
      env: childEnv,
      cwd: projectRoot
    });
    deadline.ensure();
    await lease.ensure();
    await runNodeScript("scripts/verify-price-sync.mjs", [], {
      env: childEnv,
      cwd: projectRoot
    });
    deadline.ensure();
    await runNodeScript("scripts/generate-investment-selection.mjs", [], {
      env: childEnv,
      cwd: projectRoot
    });
    deadline.ensure();
    await runNodeScript(
      "scripts/validate-snapshot.mjs",
      hasBaseline ? ["--previous", previousFile] : [],
      { env: childEnv, cwd: projectRoot }
    );
    await lease.ensure();
    deadline.ensure();
    const published = await artifactStore.publish({
      companiesFile,
      selectionFile,
      previousSnapshot,
      now: now()
    });
    await lease.ensure();
    deadline.ensure();
    await artifactStore.uploadDartCheckpoints({ directory: dartDirectory });
    checkpointsUploaded = true;
    const summary = {
      command: "sync",
      mode: "data",
      revision: published.manifest.revision,
      companies: published.snapshot.companies.length,
      selected: published.selection.selected.length
    };
    await repository.markExecutionFinished({
      command: "sync",
      businessDate: invocation.businessDate,
      executionId: invocation.executionId,
      status: "success",
      summary
    });
    logger.metric("DataSyncSucceeded", 1, {
      dimensions: { Command: "sync", Mode: "data" }
    });
    logger.metric("SnapshotPublishSuccess", 1);
    logger.info("aws_sync_completed", summary);
    return summary;
  } catch (error) {
    primaryError = error;
    if (!checkpointsUploaded) {
      try {
        await artifactStore.uploadDartCheckpoints({ directory: dartDirectory });
        checkpointsUploaded = true;
      } catch (checkpointError) {
        logger.error("aws_checkpoint_upload_failed", {
          errorCode: String(
            checkpointError?.code || "AWS_CHECKPOINT_UPLOAD_FAILED"
          )
        });
      }
    }
    if (executionStarted) {
      try {
        await repository.markExecutionFinished({
          command: "sync",
          businessDate: invocation.businessDate,
          executionId: invocation.executionId,
          status: "failed",
          summary: { errorCode: String(error?.code || "AWS_SYNC_FAILED") }
        });
      } catch {
        // Preserve the original sync or durable-state failure.
      }
    }
    throw error;
  } finally {
    await rm(previousFile, { force: true }).catch(() => {});
    try {
      await lease.release();
    } catch (releaseError) {
      if (!primaryError) throw releaseError;
    }
  }
}

async function runAuditTask({
  invocation,
  env,
  clients,
  resources,
  logger,
  now
}) {
  const mode = executionMode(env);
  const repository = createRepository({ clients, resources, now });
  const artifactStore = new S3ArtifactStore({
    client: clients.s3,
    bucket: resources.bucket
  });
  const [auto, finalReconcile, state, manifest] = await Promise.all([
    repository.getExecution({
      command: "auto",
      businessDate: invocation.businessDate
    }),
    repository.getExecution({
      command: String(env.AUTOTRADE_FINAL_RECONCILE_SLOT || "reconcile-final"),
      businessDate: invocation.businessDate
    }),
    repository.load(),
    artifactStore.loadManifest()
  ]);
  const issues = [];
  if (!terminalExecution(auto)) issues.push("AUTO_EXECUTION_MISSING");
  if (auto?.status === "success" && !terminalExecution(finalReconcile)) {
    issues.push("FINAL_RECONCILIATION_MISSING");
  }
  if (!state.exists) issues.push("TRADING_STATE_MISSING");
  if (state.state?.strategy?.inFlight) issues.push("IN_FLIGHT_UNRESOLVED");
  if (!manifest) issues.push("SNAPSHOT_MANIFEST_MISSING");
  const sourceAgeMs = manifest?.sourceUpdatedAt
    ? now().getTime() - Date.parse(manifest.sourceUpdatedAt)
    : Number.POSITIVE_INFINITY;
  if (
    auto?.status !== "market_closed" &&
    (!Number.isFinite(sourceAgeMs) || sourceAgeMs > 3 * 86_400_000)
  ) {
    issues.push("SNAPSHOT_STALE");
  }
  const summary = {
    command: "audit",
    mode,
    businessDate: invocation.businessDate,
    autoStatus: auto?.status || null,
    finalReconcileStatus: finalReconcile?.status || null,
    stateVersion: state.version,
    artifactRevision: manifest?.revision || null,
    issues
  };
  if (issues.length > 0) {
    logger.metric("AbsenceOrSafetyFailure", 1, {
      dimensions: { Command: "audit", Mode: mode }
    });
    const error = new Error("AWS 자동투자 일일 감사에서 안전 문제를 발견했습니다.");
    error.code = "AWS_AUDIT_FAILED";
    error.summary = summary;
    throw error;
  }
  logger.metric("DailyAuditSucceeded", 1, {
    dimensions: { Command: "audit", Mode: mode }
  });
  logger.info("aws_audit_completed", summary);
  return summary;
}

export function publicAwsTaskFailure(error) {
  const allowed = new Map([
    ["AWS_COMMAND_INVALID", "COMMAND_INVALID"],
    ["AWS_SOURCE_INVALID", "SOURCE_INVALID"],
    ["AWS_SCHEDULE_STALE", "SCHEDULE_STALE"],
    ["AWS_ECS_ATTESTATION_FAILED", "RUNTIME_ATTESTATION_FAILED"],
    ["AWS_LEASE_BUSY", "CONCURRENT_EXECUTION"],
    ["AWS_LEASE_LOST", "LEASE_LOST"],
    ["AWS_STATE_CONFLICT", "STATE_CONFLICT"],
    ["AWS_STATE_MIGRATION_REQUIRED", "STATE_MIGRATION_REQUIRED"],
    ["AWS_AUTOTRADE_UNSAFE_OUTCOME", "UNSAFE_OUTCOME"],
    ["AWS_RECONCILIATION_UNRESOLVED", "RECONCILIATION_UNRESOLVED"],
    ["AWS_AUDIT_FAILED", "AUDIT_FAILED"],
    ["AWS_TASK_DEADLINE", "TASK_DEADLINE"],
    ["AWS_FINAL_RECONCILE_INVALID", "FINAL_RECONCILE_INVALID"],
    ["AWS_SCHEDULE_BINDING_INVALID", "SCHEDULE_BINDING_INVALID"],
    ["AWS_MANUAL_LIVE_FORBIDDEN", "MANUAL_LIVE_FORBIDDEN"],
    ["AWS_LIVE_ENV_DISABLED", "LIVE_ENV_DISABLED"]
  ]);
  return {
    ok: false,
    errorCode: allowed.get(String(error?.code || "")) || "AWS_TASK_FAILED"
  };
}

export async function runAwsTask({
  command,
  env = process.env,
  now = () => new Date(),
  clients = null,
  fetchImpl = fetch,
  projectRoot = path.resolve("."),
  logger = null
} = {}) {
  const invocation = validateAwsInvocation({ command, env, now });
  const ownedClients = clients || createAwsClients();
  let resources = null;
  let secretValues = [];
  let resolvedLogger = logger;
  try {
    resources = awsResourceSettings(env, invocation.command);
    if (invocation.command === "sync") {
      const secret = await loadDataEnvironment({
        clients: ownedClients,
        secretArn: resources.dataSecretArn,
        env
      });
      secretValues = Object.values(secret);
    } else if (invocation.command !== "audit") {
      const secret = await loadKisEnvironment({
        clients: ownedClients,
        secretArn: resources.kisSecretArn,
        env
      });
      secretValues = Object.values(secret);
    }
    resolvedLogger ||= createAwsStructuredLogger({
      secrets: secretValues,
      baseDimensions: env.AUTOTRADE_STACK_NAME
        ? { StackName: env.AUTOTRADE_STACK_NAME }
        : {}
    });
    resolvedLogger.info("aws_task_started", {
      command: invocation.command,
      source: invocation.source,
      executionId: invocation.executionId,
      scheduledAt: invocation.scheduledAt.toISOString(),
      businessDate: invocation.businessDate,
      scheduleSlot: invocation.scheduleSlot
    });
    if (invocation.command === "sync") {
      return await runSyncTask({
        invocation,
        env,
        clients: ownedClients,
        resources,
        logger: resolvedLogger,
        now,
        projectRoot
      });
    }
    if (invocation.command === "audit") {
      return await runAuditTask({
        invocation,
        env,
        clients: ownedClients,
        resources,
        logger: resolvedLogger,
        now
      });
    }
    return await runAutoOrReconcile({
      command: invocation.command,
      invocation,
      env,
      clients: ownedClients,
      resources,
      logger: resolvedLogger,
      now,
      fetchImpl
    });
  } catch (error) {
    const secrets = secretValues.filter(Boolean);
    resolvedLogger ||= createAwsStructuredLogger({
      secrets,
      baseDimensions: env.AUTOTRADE_STACK_NAME
        ? { StackName: env.AUTOTRADE_STACK_NAME }
        : {}
    });
    resolvedLogger.error("aws_task_failed", {
      command: invocation.command,
      failure: publicAwsTaskFailure(error),
      safeError: redactSensitive(error, secrets)
    });
    throw error;
  } finally {
    if (!clients) ownedClients.destroy();
  }
}
