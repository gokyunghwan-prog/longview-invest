import { createHash } from "node:crypto";

import { PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";

import { GitHubEncryptedStateStore } from "../cloud-state.mjs";
import { validateTradingState } from "../state-store.mjs";
import {
  DynamoLeaseGuard,
  DynamoTradingRepository
} from "./dynamo.mjs";

export class AwsBootstrapError extends Error {
  constructor(message, { code = "AWS_BOOTSTRAP_ERROR", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AwsBootstrapError";
    this.code = code;
  }
}

function requiredText(value, label, maximum = 16_384) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new AwsBootstrapError(`${label}이(가) 없거나 너무 깁니다.`, {
      code: "AWS_BOOTSTRAP_INPUT_INVALID"
    });
  }
  return normalized;
}

function exactConfirmation(actual, expected) {
  if (actual !== expected) {
    throw new AwsBootstrapError("AWS bootstrap 확인 문구가 일치하지 않습니다.", {
      code: "AWS_BOOTSTRAP_CONFIRMATION_REQUIRED"
    });
  }
}

function validateKisSecret(env) {
  const value = {
    KIS_APP_KEY: requiredText(env.KIS_APP_KEY, "KIS App Key"),
    KIS_APP_SECRET: requiredText(env.KIS_APP_SECRET, "KIS App Secret"),
    KIS_ACCOUNT_NUMBER: requiredText(
      env.KIS_ACCOUNT_NUMBER,
      "KIS 계좌번호",
      8
    ),
    KIS_ACCOUNT_PRODUCT_CODE: requiredText(
      env.KIS_ACCOUNT_PRODUCT_CODE,
      "KIS 계좌 상품코드",
      2
    )
  };
  if (!/^\d{8}$/.test(value.KIS_ACCOUNT_NUMBER)) {
    throw new AwsBootstrapError("KIS 계좌번호는 숫자 8자리여야 합니다.", {
      code: "AWS_BOOTSTRAP_INPUT_INVALID"
    });
  }
  if (!/^\d{2}$/.test(value.KIS_ACCOUNT_PRODUCT_CODE)) {
    throw new AwsBootstrapError("KIS 계좌 상품코드는 숫자 2자리여야 합니다.", {
      code: "AWS_BOOTSTRAP_INPUT_INVALID"
    });
  }
  const htsId = String(env.KIS_HTS_ID || "").trim();
  if (htsId) value.KIS_HTS_ID = requiredText(htsId, "KIS HTS ID");
  return value;
}

function validateDataSecret(env) {
  return {
    DART_API_KEY: requiredText(env.DART_API_KEY, "DART API Key"),
    DATA_GO_KR_API_KEY: requiredText(
      env.DATA_GO_KR_API_KEY,
      "data.go.kr API Key"
    )
  };
}

function requestToken(secretId, payload) {
  return createHash("sha256")
    .update(secretId)
    .update("\0")
    .update(payload)
    .digest("hex");
}

async function putJsonSecret(client, secretId, value) {
  if (!client || typeof client.send !== "function") {
    throw new TypeError("Secrets Manager client가 필요합니다.");
  }
  const id = requiredText(secretId, "AWS Secret ARN", 4_096);
  const payload = JSON.stringify(value);
  try {
    await client.send(
      new PutSecretValueCommand({
        SecretId: id,
        SecretString: payload,
        ClientRequestToken: requestToken(id, payload)
      })
    );
  } catch (error) {
    throw new AwsBootstrapError("AWS Secret 버전을 저장하지 못했습니다.", {
      code: "AWS_BOOTSTRAP_SECRET_WRITE_FAILED",
      cause: error
    });
  }
}

export async function seedAwsRuntimeSecrets({
  client,
  kisSecretArn,
  dataSecretArn,
  env = process.env,
  confirmation = env.AWS_BOOTSTRAP_CONFIRM
} = {}) {
  exactConfirmation(confirmation, "SEED_AWS_SECRETS");
  const kis = validateKisSecret(env);
  const data = validateDataSecret(env);
  await putJsonSecret(client, kisSecretArn, kis);
  await putJsonSecret(client, dataSecretArn, data);
  return {
    ok: true,
    operation: "seed-secrets",
    secretCount: 2
  };
}

function stateSummary({ source, target }) {
  const state = source?.state || target?.state || null;
  return {
    sourceExists: source?.exists === true,
    targetExists: target?.exists === true,
    targetVersion: Number(target?.version || 0),
    schemaVersion: Number(state?.schemaVersion || 0),
    inFlight: Boolean(state?.strategy?.inFlight),
    completedCycleCount: Array.isArray(state?.strategy?.completedCycleKeys)
      ? state.strategy.completedCycleKeys.length
      : 0,
    runCount: Array.isArray(state?.runs) ? state.runs.length : 0
  };
}

function stateChecksum(state) {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function legacyWorkflowRequestSettings({ repository, token, workflow }) {
  const repo = requiredText(repository, "GitHub 저장소", 255);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new AwsBootstrapError("GitHub 저장소 형식이 올바르지 않습니다.", {
      code: "AWS_BOOTSTRAP_INPUT_INVALID"
    });
  }
  const accessToken = requiredText(token, "GitHub token");
  const workflowName = requiredText(workflow, "GitHub workflow", 255);
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflowName)) {
    throw new AwsBootstrapError("GitHub workflow 파일명이 올바르지 않습니다.", {
      code: "AWS_BOOTSTRAP_INPUT_INVALID"
    });
  }
  return {
    baseUrl:
      `https://api.github.com/repos/${repo}/actions/workflows/` +
      encodeURIComponent(workflowName),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "longview-aws-bootstrap",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  };
}

async function parseGitHubJson(response, label, maximumBytes = 2 * 1024 * 1024) {
  if (!response?.ok) {
    throw new AwsBootstrapError(`${label} 응답이 실패했습니다.`, {
      code: "AWS_BOOTSTRAP_LEGACY_ACTIVITY_CHECK_FAILED"
    });
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > maximumBytes) {
    throw new AwsBootstrapError(`${label} 응답이 너무 큽니다.`, {
      code: "AWS_BOOTSTRAP_LEGACY_ACTIVITY_CHECK_FAILED"
    });
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new AwsBootstrapError(`${label} 응답이 올바르지 않습니다.`, {
      code: "AWS_BOOTSTRAP_LEGACY_ACTIVITY_CHECK_FAILED"
    });
  }
}

async function fetchLegacyWorkflowMetadata(settings, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(settings.baseUrl, {
      method: "GET",
      headers: settings.headers,
      redirect: "error"
    });
  } catch (error) {
    throw new AwsBootstrapError(
      "기존 GitHub 자동매매 workflow 상태를 확인하지 못했습니다.",
      {
        code: "AWS_BOOTSTRAP_LEGACY_ACTIVITY_CHECK_FAILED",
        cause: error
      }
    );
  }
  const parsed = await parseGitHubJson(
    response,
    "기존 GitHub 자동매매 workflow 상태",
    256 * 1024
  );
  if (typeof parsed?.state !== "string") {
    throw new AwsBootstrapError(
      "기존 GitHub 자동매매 workflow 상태 형식이 올바르지 않습니다.",
      { code: "AWS_BOOTSTRAP_LEGACY_ACTIVITY_CHECK_FAILED" }
    );
  }
  return parsed;
}

export async function ensureLegacyGitHubWorkflowDisabled({
  repository,
  token,
  workflow = "live-autotrade.yml",
  fetchImpl = fetch
} = {}) {
  const settings = legacyWorkflowRequestSettings({
    repository,
    token,
    workflow
  });
  const before = await fetchLegacyWorkflowMetadata(settings, fetchImpl);
  if (before.state === "disabled_manually") {
    return { disabled: true, alreadyDisabled: true };
  }
  let response;
  try {
    response = await fetchImpl(`${settings.baseUrl}/disable`, {
      method: "PUT",
      headers: settings.headers,
      redirect: "error"
    });
  } catch (error) {
    throw new AwsBootstrapError(
      "기존 GitHub 자동매매 workflow를 비활성화하지 못했습니다.",
      {
        code: "AWS_BOOTSTRAP_LEGACY_ACTIVITY_CHECK_FAILED",
        cause: error
      }
    );
  }
  if (!response || !new Set([200, 204]).has(response.status)) {
    throw new AwsBootstrapError(
      "기존 GitHub 자동매매 workflow 비활성화 응답이 실패했습니다.",
      { code: "AWS_BOOTSTRAP_LEGACY_ACTIVITY_CHECK_FAILED" }
    );
  }
  const after = await fetchLegacyWorkflowMetadata(settings, fetchImpl);
  if (after.state !== "disabled_manually") {
    throw new AwsBootstrapError(
      "기존 GitHub 자동매매 workflow가 비활성 상태로 전환되지 않았습니다.",
      { code: "AWS_BOOTSTRAP_LEGACY_WORKFLOW_NOT_DISABLED" }
    );
  }
  return { disabled: true, alreadyDisabled: false };
}

export async function assertLegacyGitHubWorkflowIdle({
  repository,
  token,
  workflow = "live-autotrade.yml",
  fetchImpl = fetch,
  maximumPages = 10
} = {}) {
  const settings = legacyWorkflowRequestSettings({
    repository,
    token,
    workflow
  });
  const metadata = await fetchLegacyWorkflowMetadata(settings, fetchImpl);
  if (metadata.state !== "disabled_manually") {
    throw new AwsBootstrapError(
      "기존 GitHub 자동매매 workflow가 수동 비활성 상태가 아닙니다.",
      { code: "AWS_BOOTSTRAP_LEGACY_WORKFLOW_NOT_DISABLED" }
    );
  }
  const pages = Number(maximumPages);
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 20) {
    throw new AwsBootstrapError("GitHub workflow 조회 페이지 상한이 올바르지 않습니다.", {
      code: "AWS_BOOTSTRAP_INPUT_INVALID"
    });
  }
  let checkedRuns = 0;
  for (let page = 1; page <= pages; page += 1) {
    let response;
    try {
      response = await fetchImpl(
        `${settings.baseUrl}/runs?per_page=100&page=${page}`,
        {
          method: "GET",
          headers: settings.headers,
          redirect: "error"
        }
      );
    } catch (error) {
      throw new AwsBootstrapError(
        "기존 GitHub 자동매매 실행 상태를 확인하지 못했습니다.",
        {
          code: "AWS_BOOTSTRAP_LEGACY_ACTIVITY_CHECK_FAILED",
          cause: error
        }
      );
    }
    const parsed = await parseGitHubJson(
      response,
      "기존 GitHub 자동매매 실행 상태"
    );
    if (!Array.isArray(parsed?.workflow_runs)) {
      throw new AwsBootstrapError(
        "기존 GitHub 자동매매 실행 상태 형식이 올바르지 않습니다.",
        { code: "AWS_BOOTSTRAP_LEGACY_ACTIVITY_CHECK_FAILED" }
      );
    }
    checkedRuns += parsed.workflow_runs.length;
    if (
      parsed.workflow_runs.some(
        (run) => String(run?.status || "").toLowerCase() !== "completed"
      )
    ) {
      throw new AwsBootstrapError(
        "기존 GitHub 자동매매 workflow가 아직 실행 중이어서 이전을 중단했습니다.",
        { code: "AWS_BOOTSTRAP_LEGACY_WORKFLOW_ACTIVE" }
      );
    }
    if (parsed.workflow_runs.length < 100) {
      return { idle: true, disabled: true, checkedRuns };
    }
  }
  throw new AwsBootstrapError(
    "기존 GitHub 자동매매 실행 이력이 조회 안전상한을 초과했습니다.",
    { code: "AWS_BOOTSTRAP_LEGACY_ACTIVITY_CHECK_FAILED" }
  );
}

export async function inspectAwsStateMigration({
  githubStore,
  repository
} = {}) {
  if (!githubStore || typeof githubStore.load !== "function") {
    throw new TypeError("GitHub 암호화 상태 저장소가 필요합니다.");
  }
  if (!repository || typeof repository.load !== "function") {
    throw new TypeError("AWS 상태 repository가 필요합니다.");
  }
  const [source, target] = await Promise.all([
    githubStore.load(),
    repository.load()
  ]);
  if (source.exists) validateTradingState(source.state);
  if (target.exists) validateTradingState(target.state);
  return {
    ok: true,
    operation: "inspect-state",
    ...stateSummary({ source, target }),
    sameState:
      source.exists &&
      target.exists &&
      stateChecksum(source.state) === target.checksum
  };
}

export async function migrateGitHubStateToAws({
  githubStore,
  repository,
  leaseOptions,
  legacySchedulerDisabled,
  legacyActivityCheck = async () => ({ idle: true }),
  confirmation
} = {}) {
  if (
    !repository ||
    typeof repository.load !== "function" ||
    typeof repository.initialize !== "function" ||
    typeof repository.rollbackInitialization !== "function"
  ) {
    throw new TypeError("AWS 상태 migration repository가 올바르지 않습니다.");
  }
  if (typeof legacyActivityCheck !== "function") {
    throw new TypeError("기존 GitHub workflow 상태 확인 함수가 필요합니다.");
  }
  exactConfirmation(confirmation, "MIGRATE_GITHUB_STATE_TO_AWS");
  if (legacySchedulerDisabled !== true) {
    throw new AwsBootstrapError(
      "기존 GitHub 실거래 스케줄을 먼저 비활성화해야 합니다.",
      { code: "AWS_BOOTSTRAP_LEGACY_WRITER_ACTIVE" }
    );
  }
  await legacyActivityCheck();
  const source = await githubStore.load();
  if (!source.exists) {
    throw new AwsBootstrapError("이전할 GitHub 암호화 상태가 없습니다.", {
      code: "AWS_BOOTSTRAP_SOURCE_STATE_MISSING"
    });
  }
  const validated = validateTradingState(source.state);
  if (validated.strategy?.inFlight) {
    throw new AwsBootstrapError(
      "미결 주문 상태가 있어 AWS 상태 이전을 중단했습니다.",
      { code: "AWS_BOOTSTRAP_IN_FLIGHT_PRESENT" }
    );
  }
  const target = await repository.load();
  if (target.exists) {
    if (stateChecksum(validated) !== target.checksum) {
      throw new AwsBootstrapError(
        "AWS에 다른 자동매매 상태가 있어 덮어쓰지 않았습니다.",
        { code: "AWS_BOOTSTRAP_TARGET_STATE_CONFLICT" }
      );
    }
    await legacyActivityCheck();
    await githubStore.assertUnchanged(source.sha);
    return {
      ok: true,
      operation: "migrate-state",
      alreadyMigrated: true,
      ...stateSummary({ source, target })
    };
  }

  await githubStore.assertUnchanged(source.sha);
  const lease = await DynamoLeaseGuard.acquire(leaseOptions);
  let primaryError = null;
  let initialized = null;
  let migrationVerified = false;
  try {
    await legacyActivityCheck();
    const checked = await repository.load();
    if (checked.exists) {
      throw new AwsBootstrapError(
        "AWS 상태가 이전 도중 생성되어 덮어쓰지 않았습니다.",
        { code: "AWS_BOOTSTRAP_TARGET_STATE_CONFLICT" }
      );
    }
    initialized = await repository.initialize(validated);
    await legacyActivityCheck();
    await githubStore.assertUnchanged(source.sha);
    const persisted = await repository.load();
    if (
      !persisted.exists ||
      persisted.version !== initialized.version ||
      persisted.checksum !== stateChecksum(validated)
    ) {
      throw new AwsBootstrapError("AWS 이전 상태 재검증에 실패했습니다.", {
        code: "AWS_BOOTSTRAP_MIGRATION_VERIFY_FAILED"
      });
    }
    migrationVerified = true;
    return {
      ok: true,
      operation: "migrate-state",
      alreadyMigrated: false,
      ...stateSummary({ source, target: persisted })
    };
  } catch (error) {
    primaryError = error;
    if (initialized && !migrationVerified) {
      try {
        await repository.rollbackInitialization({
          expectedVersion: initialized.version,
          expectedChecksum: stateChecksum(validated)
        });
      } catch (rollbackError) {
        const failure = new AwsBootstrapError(
          "AWS 상태 이전 실패 후 초기 상태 rollback도 완료하지 못했습니다.",
          {
            code: "AWS_BOOTSTRAP_TARGET_ROLLBACK_FAILED",
            cause: rollbackError
          }
        );
        failure.migrationCause = error;
        primaryError = failure;
        throw failure;
      }
    }
    throw error;
  } finally {
    try {
      await lease.release();
    } catch (releaseError) {
      if (!primaryError) throw releaseError;
    }
  }
}

export function createLegacyGitHubStateStore({
  repository,
  token,
  encryptionKey,
  fetchImpl = fetch
} = {}) {
  return new GitHubEncryptedStateStore({
    repository,
    token,
    encryptionKey,
    fetchImpl
  });
}
