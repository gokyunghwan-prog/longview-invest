import { pathToFileURL } from "node:url";

import {
  assertLegacyGitHubWorkflowIdle,
  createLegacyGitHubStateStore,
  ensureLegacyGitHubWorkflowDisabled,
  inspectAwsStateMigration,
  migrateGitHubStateToAws,
  seedAwsRuntimeSecrets
} from "../autotrade/aws/bootstrap.mjs";
import { createAwsClients } from "../autotrade/aws/clients.mjs";
import {
  DEFAULT_AWS_TRADE_LEASE_MS,
  DynamoTradingRepository
} from "../autotrade/aws/dynamo.mjs";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label}이(가) 필요합니다.`);
  return normalized;
}

function publicFailure(error) {
  const allowed = new Set([
    "AWS_BOOTSTRAP_CONFIRMATION_REQUIRED",
    "AWS_BOOTSTRAP_INPUT_INVALID",
    "AWS_BOOTSTRAP_LEGACY_WRITER_ACTIVE",
    "AWS_BOOTSTRAP_LEGACY_WORKFLOW_ACTIVE",
    "AWS_BOOTSTRAP_LEGACY_WORKFLOW_NOT_DISABLED",
    "AWS_BOOTSTRAP_LEGACY_ACTIVITY_CHECK_FAILED",
    "AWS_BOOTSTRAP_SOURCE_STATE_MISSING",
    "AWS_BOOTSTRAP_IN_FLIGHT_PRESENT",
    "AWS_BOOTSTRAP_TARGET_STATE_CONFLICT",
    "AWS_BOOTSTRAP_MIGRATION_VERIFY_FAILED",
    "AWS_BOOTSTRAP_TARGET_ROLLBACK_FAILED",
    "AWS_BOOTSTRAP_SECRET_WRITE_FAILED",
    "AWS_LEASE_BUSY"
  ]);
  const code = String(error?.code || "");
  return {
    ok: false,
    errorCode: allowed.has(code) ? code : "AWS_BOOTSTRAP_FAILED"
  };
}

export async function runAwsBootstrap({
  operation,
  env = process.env,
  clients = null,
  fetchImpl = fetch
} = {}) {
  const command = String(operation || "").trim().toLowerCase();
  if (
    !new Set(["seed-secrets", "inspect-state", "migrate-state"]).has(command)
  ) {
    throw new Error("허용되지 않은 AWS bootstrap 명령입니다.");
  }
  const ownedClients = clients || createAwsClients();
  try {
    if (command === "seed-secrets") {
      return await seedAwsRuntimeSecrets({
        client: ownedClients.secrets,
        kisSecretArn: required(env.AUTOTRADE_KIS_SECRET_ARN, "KIS Secret ARN"),
        dataSecretArn: required(
          env.AUTOTRADE_DATA_SECRET_ARN,
          "시장데이터 Secret ARN"
        ),
        env
      });
    }

    const tableName = required(
      env.AUTOTRADE_STATE_TABLE,
      "AWS 상태 테이블"
    );
    const namespace = String(
      env.AUTOTRADE_STATE_NAMESPACE || "longview"
    ).trim();
    const githubStore = createLegacyGitHubStateStore({
      repository: required(env.GITHUB_REPOSITORY, "GitHub 저장소"),
      token: required(env.GITHUB_TOKEN, "GitHub token"),
      encryptionKey: required(
        env.AUTOTRADE_STATE_KEY,
        "GitHub 상태 암호화 키"
      ),
      fetchImpl
    });
    const repository = new DynamoTradingRepository({
      client: ownedClients.dynamo,
      tableName,
      namespace
    });
    if (command === "inspect-state") {
      return await inspectAwsStateMigration({ githubStore, repository });
    }
    return await migrateGitHubStateToAws({
      githubStore,
      repository,
      leaseOptions: {
        client: ownedClients.dynamo,
        tableName,
        namespace,
        scope: "trading",
        owner: `migration-${env.GITHUB_RUN_ID || Date.now()}`,
        leaseMs: DEFAULT_AWS_TRADE_LEASE_MS
      },
      legacySchedulerDisabled:
        env.LEGACY_AUTOTRADE_DISABLED === "true",
      legacyActivityCheck: (() => {
        let disabled = false;
        return async () => {
          if (!disabled) {
            await ensureLegacyGitHubWorkflowDisabled({
              repository: env.GITHUB_REPOSITORY,
              token: env.GITHUB_TOKEN,
              fetchImpl
            });
            disabled = true;
          }
          return assertLegacyGitHubWorkflowIdle({
            repository: env.GITHUB_REPOSITORY,
            token: env.GITHUB_TOKEN,
            fetchImpl
          });
        };
      })(),
      confirmation: env.AWS_BOOTSTRAP_CONFIRM
    });
  } finally {
    if (!clients) ownedClients.destroy();
  }
}

async function main() {
  try {
    const result = await runAwsBootstrap({ operation: process.argv[2] });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify(publicFailure(error)));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
