import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";

import { PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import {
  DeleteCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";

import {
  AwsBootstrapError,
  assertLegacyGitHubWorkflowIdle,
  ensureLegacyGitHubWorkflowDisabled,
  inspectAwsStateMigration,
  migrateGitHubStateToAws,
  seedAwsRuntimeSecrets
} from "../autotrade/aws/bootstrap.mjs";
import { runAwsBootstrap } from "../scripts/aws-bootstrap.mjs";

const execFileAsync = promisify(execFile);
const SOURCE_SHA = "a".repeat(40);
const NOW = "2026-07-24T00:00:00.000Z";

function tradingState({ inFlight = null, companyName = "테스트기업" } = {}) {
  return {
    schemaVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    paper: {
      cashKrw: 100_000,
      positions: {
        "KR-000001": {
          id: "KR-000001",
          name: companyName
        }
      },
      orders: []
    },
    strategy: {
      lastSnapshotRevision: "revision-1",
      lastPlanAt: NOW,
      candidateCount: 5,
      candidateCountScope: "KR",
      removalStreaks: {},
      managedSecurities: {},
      pendingManagedSecurities: {},
      completedCycleKeys: ["cycle-1"],
      inFlight
    },
    cloud: {
      fence: 0,
      lease: null
    },
    runs: [{ at: NOW }]
  };
}

function checksum(state) {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function assertCode(code) {
  return (error) => {
    assert.ok(error instanceof AwsBootstrapError);
    assert.equal(error.code, code);
    return true;
  };
}

class QueueClient {
  constructor(...responses) {
    this.responses = responses;
    this.calls = [];
  }

  async send(command) {
    this.calls.push(command);
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(command);
    return next ?? {};
  }
}

class FakeGitHubStore {
  constructor(source, { events = [], assertResponses = [] } = {}) {
    this.source = source;
    this.events = events;
    this.assertResponses = assertResponses;
    this.loadCalls = 0;
    this.assertCalls = [];
  }

  async load() {
    this.events.push("github.load");
    this.loadCalls += 1;
    return structuredClone(this.source);
  }

  async assertUnchanged(sha) {
    this.events.push(`github.assert:${sha}`);
    this.assertCalls.push(sha);
    const next = this.assertResponses.shift();
    if (next instanceof Error) throw next;
    return next ?? { unchanged: true, sha };
  }
}

class FakeRepository {
  constructor(
    loads,
    {
      events = [],
      initializeResult = { version: 1 },
      rollbackResult = { rolledBack: true }
    } = {}
  ) {
    this.loads = loads.map((value) => structuredClone(value));
    this.events = events;
    this.initializeResult = initializeResult;
    this.rollbackResult = rollbackResult;
    this.loadCalls = 0;
    this.initializeCalls = [];
    this.rollbackCalls = [];
  }

  async load() {
    this.events.push("repository.load");
    this.loadCalls += 1;
    const next = this.loads.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("예상하지 못한 repository.load");
    return structuredClone(next);
  }

  async initialize(state) {
    this.events.push("repository.initialize");
    this.initializeCalls.push(structuredClone(state));
    if (this.initializeResult instanceof Error) throw this.initializeResult;
    return structuredClone(this.initializeResult);
  }

  async rollbackInitialization(options) {
    this.events.push("repository.rollback");
    this.rollbackCalls.push(structuredClone(options));
    if (this.rollbackResult instanceof Error) throw this.rollbackResult;
    return structuredClone(this.rollbackResult);
  }
}

class FakeLeaseClient {
  constructor({ events = [], acquireError = null, releaseError = null } = {}) {
    this.events = events;
    this.acquireError = acquireError;
    this.releaseError = releaseError;
    this.calls = [];
  }

  async send(command) {
    this.calls.push(command);
    if (command instanceof UpdateCommand) {
      this.events.push("lease.acquire");
      if (this.acquireError) throw this.acquireError;
      return { Attributes: { fence: 1 } };
    }
    if (command instanceof DeleteCommand) {
      this.events.push("lease.release");
      if (this.releaseError) throw this.releaseError;
      return {};
    }
    throw new Error(`예상하지 못한 lease 명령: ${command.constructor.name}`);
  }
}

function leaseOptions(client) {
  return {
    client,
    tableName: "longview-state",
    namespace: "longview",
    scope: "trading",
    owner: "migration-test",
    leaseMs: 120_000,
    heartbeatMs: 30_000,
    now: () => Date.parse(NOW)
  };
}

function missingTarget() {
  return { exists: false, state: null, version: 0, checksum: null };
}

function existingTarget(state, version = 1) {
  return {
    exists: true,
    state: structuredClone(state),
    version,
    checksum: checksum(state)
  };
}

test("AWS secret seed는 정확한 확인문구와 모든 필수 입력을 먼저 요구한다", async () => {
  const client = new QueueClient();
  const env = {
    KIS_APP_KEY: "kis-app-key",
    KIS_APP_SECRET: "kis-app-secret",
    KIS_ACCOUNT_NUMBER: "12345678",
    KIS_ACCOUNT_PRODUCT_CODE: "01",
    DART_API_KEY: "dart-key",
    DATA_GO_KR_API_KEY: "data-key"
  };

  await assert.rejects(
    seedAwsRuntimeSecrets({
      client,
      kisSecretArn: "arn:aws:secretsmanager:region:account:secret:kis",
      dataSecretArn: "arn:aws:secretsmanager:region:account:secret:data",
      env,
      confirmation: "almost"
    }),
    assertCode("AWS_BOOTSTRAP_CONFIRMATION_REQUIRED")
  );
  assert.equal(client.calls.length, 0);

  await assert.rejects(
    seedAwsRuntimeSecrets({
      client,
      kisSecretArn: "arn:aws:secretsmanager:region:account:secret:kis",
      dataSecretArn: "arn:aws:secretsmanager:region:account:secret:data",
      env: { ...env, KIS_ACCOUNT_NUMBER: "1234-5678" },
      confirmation: "SEED_AWS_SECRETS"
    }),
    assertCode("AWS_BOOTSTRAP_INPUT_INVALID")
  );
  assert.equal(client.calls.length, 0);
});

test("AWS secret seed 결과와 request token은 비밀 원문을 노출하지 않는다", async () => {
  const secrets = [
    "kis-app-key-sensitive",
    "kis-app-secret-sensitive",
    "12345678",
    "dart-key-sensitive",
    "data-key-sensitive"
  ];
  const client = new QueueClient({}, {});
  const result = await seedAwsRuntimeSecrets({
    client,
    kisSecretArn: "arn:aws:secretsmanager:region:account:secret:kis",
    dataSecretArn: "arn:aws:secretsmanager:region:account:secret:data",
    env: {
      KIS_APP_KEY: secrets[0],
      KIS_APP_SECRET: secrets[1],
      KIS_ACCOUNT_NUMBER: secrets[2],
      KIS_ACCOUNT_PRODUCT_CODE: "01",
      KIS_HTS_ID: "hts-user",
      DART_API_KEY: secrets[3],
      DATA_GO_KR_API_KEY: secrets[4]
    },
    confirmation: "SEED_AWS_SECRETS"
  });

  assert.deepEqual(result, {
    ok: true,
    operation: "seed-secrets",
    secretCount: 2
  });
  assert.equal(client.calls.length, 2);
  for (const call of client.calls) {
    assert.ok(call instanceof PutSecretValueCommand);
    assert.match(call.input.ClientRequestToken, /^[a-f0-9]{64}$/);
    for (const secret of secrets) {
      assert.doesNotMatch(call.input.ClientRequestToken, new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    }
  }
  assert.deepEqual(JSON.parse(client.calls[0].input.SecretString), {
    KIS_APP_KEY: secrets[0],
    KIS_APP_SECRET: secrets[1],
    KIS_ACCOUNT_NUMBER: secrets[2],
    KIS_ACCOUNT_PRODUCT_CODE: "01",
    KIS_HTS_ID: "hts-user"
  });
  assert.deepEqual(JSON.parse(client.calls[1].input.SecretString), {
    DART_API_KEY: secrets[3],
    DATA_GO_KR_API_KEY: secrets[4]
  });
});

test("script의 seed-secrets 경로도 주입된 client만 사용하고 공개 결과만 반환한다", async () => {
  const secretClient = new QueueClient({}, {});
  const destroyCalls = [];
  const result = await runAwsBootstrap({
    operation: "seed-secrets",
    env: {
      AUTOTRADE_KIS_SECRET_ARN:
        "arn:aws:secretsmanager:region:account:secret:kis",
      AUTOTRADE_DATA_SECRET_ARN:
        "arn:aws:secretsmanager:region:account:secret:data",
      AWS_BOOTSTRAP_CONFIRM: "SEED_AWS_SECRETS",
      KIS_APP_KEY: "script-kis-key",
      KIS_APP_SECRET: "script-kis-secret",
      KIS_ACCOUNT_NUMBER: "12345678",
      KIS_ACCOUNT_PRODUCT_CODE: "01",
      DART_API_KEY: "script-dart-key",
      DATA_GO_KR_API_KEY: "script-data-key"
    },
    clients: {
      secrets: secretClient,
      dynamo: null,
      destroy: () => destroyCalls.push(true)
    }
  });

  assert.equal(result.secretCount, 2);
  assert.equal(secretClient.calls.length, 2);
  assert.deepEqual(destroyCalls, []);
  assert.doesNotMatch(JSON.stringify(result), /script-(kis|dart|data)/);
});

test("CLI 실패 출력은 주입된 비밀값이나 내부 오류를 노출하지 않는다", async () => {
  const sensitive = "cli-secret-must-not-leak";
  let failure;
  try {
    await execFileAsync(
      process.execPath,
      [path.resolve("scripts/aws-bootstrap.mjs"), "seed-secrets"],
      {
        cwd: path.resolve("."),
        env: {
          PATH: process.env.PATH || "",
          SystemRoot: process.env.SystemRoot || "",
          AWS_REGION: "ap-northeast-2",
          AUTOTRADE_KIS_SECRET_ARN:
            "arn:aws:secretsmanager:region:account:secret:kis",
          AUTOTRADE_DATA_SECRET_ARN:
            "arn:aws:secretsmanager:region:account:secret:data",
          AWS_BOOTSTRAP_CONFIRM: "wrong-confirmation",
          KIS_APP_KEY: sensitive
        },
        timeout: 10_000
      }
    );
    assert.fail("CLI가 실패해야 합니다.");
  } catch (error) {
    failure = error;
  }

  assert.equal(failure.code, 1);
  const output = String(failure.stderr || "").trim();
  assert.deepEqual(JSON.parse(output), {
    ok: false,
    errorCode: "AWS_BOOTSTRAP_CONFIRMATION_REQUIRED"
  });
  assert.doesNotMatch(output, new RegExp(sensitive));
});

test("state inspect는 원본·대상의 안전한 요약과 동일 checksum만 반환한다", async () => {
  const hidden = "sensitive-company-name";
  const state = tradingState({ companyName: hidden });
  const githubStore = new FakeGitHubStore({
    exists: true,
    state,
    sha: SOURCE_SHA
  });
  const repository = new FakeRepository([existingTarget(state, 4)]);

  const result = await inspectAwsStateMigration({ githubStore, repository });

  assert.deepEqual(result, {
    ok: true,
    operation: "inspect-state",
    sourceExists: true,
    targetExists: true,
    targetVersion: 4,
    schemaVersion: 1,
    inFlight: false,
    completedCycleCount: 1,
    runCount: 1,
    sameState: true
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(hidden));
});

test("migration은 legacy writer가 켜져 있으면 원본 조회 전 차단한다", async () => {
  const githubStore = new FakeGitHubStore({
    exists: true,
    state: tradingState(),
    sha: SOURCE_SHA
  });
  const repository = new FakeRepository([missingTarget()]);
  const leaseClient = new FakeLeaseClient();

  await assert.rejects(
    migrateGitHubStateToAws({
      githubStore,
      repository,
      leaseOptions: leaseOptions(leaseClient),
      legacySchedulerDisabled: false,
      confirmation: "MIGRATE_GITHUB_STATE_TO_AWS"
    }),
    assertCode("AWS_BOOTSTRAP_LEGACY_WRITER_ACTIVE")
  );
  assert.equal(githubStore.loadCalls, 0);
  assert.equal(repository.loadCalls, 0);
  assert.equal(leaseClient.calls.length, 0);
});

test("migration 전 GitHub legacy workflow 실행이 모두 끝났는지 fail-closed 확인한다", async () => {
  const requests = [];
  const completed = await assertLegacyGitHubWorkflowIdle({
    repository: "owner/repository",
    token: "hidden-token",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (!url.includes("/runs?")) {
        return new Response(JSON.stringify({ state: "disabled_manually" }));
      }
      return new Response(
        JSON.stringify({
          workflow_runs: [
            { id: 1, status: "completed" },
            { id: 2, status: "completed" }
          ]
        })
      );
    }
  });
  assert.deepEqual(completed, {
    idle: true,
    disabled: true,
    checkedRuns: 2
  });
  assert.match(
    requests[1].url,
    /actions\/workflows\/live-autotrade\.yml\/runs/
  );
  assert.equal(
    requests[0].options.headers.Authorization,
    "Bearer hidden-token"
  );

  await assert.rejects(
    assertLegacyGitHubWorkflowIdle({
      repository: "owner/repository",
      token: "hidden-token",
      fetchImpl: async (url) =>
        new Response(
          JSON.stringify(
            url.includes("/runs?")
              ? {
                  workflow_runs: [{ id: 3, status: "in_progress" }]
                }
              : { state: "disabled_manually" }
          )
        )
    }),
    assertCode("AWS_BOOTSTRAP_LEGACY_WORKFLOW_ACTIVE")
  );
  await assert.rejects(
    assertLegacyGitHubWorkflowIdle({
      repository: "owner/repository",
      token: "hidden-token",
      fetchImpl: async () => new Response("not-json")
    }),
    assertCode("AWS_BOOTSTRAP_LEGACY_ACTIVITY_CHECK_FAILED")
  );
});

test("migration gate는 legacy workflow를 API로 비활성화한 뒤 상태를 재확인한다", async () => {
  const calls = [];
  const responses = [
    new Response(JSON.stringify({ state: "active" })),
    new Response(null, { status: 204 }),
    new Response(JSON.stringify({ state: "disabled_manually" }))
  ];
  const result = await ensureLegacyGitHubWorkflowDisabled({
    repository: "owner/repository",
    token: "hidden-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    }
  });

  assert.deepEqual(result, { disabled: true, alreadyDisabled: false });
  assert.deepEqual(
    calls.map((item) => item.options.method),
    ["GET", "PUT", "GET"]
  );
  assert.match(calls[1].url, /live-autotrade\.yml\/disable$/);
});

test("migration은 in-flight 장부를 target 조회·lease 전에 차단한다", async () => {
  const state = tradingState({
    inFlight: {
      cycleKey: "cycle-in-flight",
      trigger: "test",
      createdAt: NOW,
      orders: []
    }
  });
  const githubStore = new FakeGitHubStore({
    exists: true,
    state,
    sha: SOURCE_SHA
  });
  const repository = new FakeRepository([missingTarget()]);
  const leaseClient = new FakeLeaseClient();

  await assert.rejects(
    migrateGitHubStateToAws({
      githubStore,
      repository,
      leaseOptions: leaseOptions(leaseClient),
      legacySchedulerDisabled: true,
      confirmation: "MIGRATE_GITHUB_STATE_TO_AWS"
    }),
    assertCode("AWS_BOOTSTRAP_IN_FLIGHT_PRESENT")
  );
  assert.equal(githubStore.loadCalls, 1);
  assert.equal(repository.loadCalls, 0);
  assert.equal(leaseClient.calls.length, 0);
});

test("동일한 target 상태는 create·lease 없이 멱등 성공 처리한다", async () => {
  const state = tradingState();
  const githubStore = new FakeGitHubStore({
    exists: true,
    state,
    sha: SOURCE_SHA
  });
  const repository = new FakeRepository([existingTarget(state, 3)]);
  const leaseClient = new FakeLeaseClient();

  const result = await migrateGitHubStateToAws({
    githubStore,
    repository,
    leaseOptions: leaseOptions(leaseClient),
    legacySchedulerDisabled: true,
    confirmation: "MIGRATE_GITHUB_STATE_TO_AWS"
  });

  assert.equal(result.alreadyMigrated, true);
  assert.equal(result.targetVersion, 3);
  assert.equal(repository.initializeCalls.length, 0);
  assert.equal(leaseClient.calls.length, 0);
});

test("다른 target 상태는 덮어쓰기·lease 없이 충돌로 중단한다", async () => {
  const sourceState = tradingState();
  const targetState = tradingState();
  targetState.paper.cashKrw = 99_999;
  const githubStore = new FakeGitHubStore({
    exists: true,
    state: sourceState,
    sha: SOURCE_SHA
  });
  const repository = new FakeRepository([existingTarget(targetState, 2)]);
  const leaseClient = new FakeLeaseClient();

  await assert.rejects(
    migrateGitHubStateToAws({
      githubStore,
      repository,
      leaseOptions: leaseOptions(leaseClient),
      legacySchedulerDisabled: true,
      confirmation: "MIGRATE_GITHUB_STATE_TO_AWS"
    }),
    assertCode("AWS_BOOTSTRAP_TARGET_STATE_CONFLICT")
  );
  assert.equal(repository.initializeCalls.length, 0);
  assert.equal(leaseClient.calls.length, 0);
});

test("새 migration은 원본 불변→lease→target 재확인→create-only→원본·target 재검증 순서다", async () => {
  const events = [];
  const state = tradingState();
  const persisted = existingTarget(state, 1);
  const githubStore = new FakeGitHubStore(
    { exists: true, state, sha: SOURCE_SHA },
    { events }
  );
  const repository = new FakeRepository(
    [missingTarget(), missingTarget(), persisted],
    { events }
  );
  const leaseClient = new FakeLeaseClient({ events });

  const result = await migrateGitHubStateToAws({
    githubStore,
    repository,
    leaseOptions: leaseOptions(leaseClient),
    legacySchedulerDisabled: true,
    confirmation: "MIGRATE_GITHUB_STATE_TO_AWS"
  });

  assert.equal(result.alreadyMigrated, false);
  assert.equal(repository.initializeCalls.length, 1);
  assert.deepEqual(repository.initializeCalls[0], state);
  assert.deepEqual(githubStore.assertCalls, [SOURCE_SHA, SOURCE_SHA]);
  assert.deepEqual(events, [
    "github.load",
    "repository.load",
    `github.assert:${SOURCE_SHA}`,
    "lease.acquire",
    "repository.load",
    "repository.initialize",
    `github.assert:${SOURCE_SHA}`,
    "repository.load",
    "lease.release"
  ]);
});

test("lease 획득 뒤 target이 생긴 race는 create하지 않고 lease를 해제한다", async () => {
  const state = tradingState();
  const events = [];
  const githubStore = new FakeGitHubStore(
    { exists: true, state, sha: SOURCE_SHA },
    { events }
  );
  const repository = new FakeRepository(
    [missingTarget(), existingTarget(state, 1)],
    { events }
  );
  const leaseClient = new FakeLeaseClient({ events });

  await assert.rejects(
    migrateGitHubStateToAws({
      githubStore,
      repository,
      leaseOptions: leaseOptions(leaseClient),
      legacySchedulerDisabled: true,
      confirmation: "MIGRATE_GITHUB_STATE_TO_AWS"
    }),
    assertCode("AWS_BOOTSTRAP_TARGET_STATE_CONFLICT")
  );
  assert.equal(repository.initializeCalls.length, 0);
  assert.equal(events.at(-1), "lease.release");
});

test("create 후 원본이 바뀌면 방금 만든 target을 조건부 rollback하고 lease를 해제한다", async () => {
  const state = tradingState();
  const sourceChanged = new Error("source changed");
  sourceChanged.code = "CLOUD_STATE_CONFLICT";
  const events = [];
  const githubStore = new FakeGitHubStore(
    { exists: true, state, sha: SOURCE_SHA },
    {
      events,
      assertResponses: [{ unchanged: true, sha: SOURCE_SHA }, sourceChanged]
    }
  );
  const repository = new FakeRepository(
    [missingTarget(), missingTarget()],
    { events }
  );
  const leaseClient = new FakeLeaseClient({ events });

  await assert.rejects(
    migrateGitHubStateToAws({
      githubStore,
      repository,
      leaseOptions: leaseOptions(leaseClient),
      legacySchedulerDisabled: true,
      confirmation: "MIGRATE_GITHUB_STATE_TO_AWS"
    }),
    (error) => error === sourceChanged
  );
  assert.equal(repository.initializeCalls.length, 1);
  assert.deepEqual(repository.rollbackCalls, [
    { expectedVersion: 1, expectedChecksum: checksum(state) }
  ]);
  assert.deepEqual(events.slice(-2), [
    "repository.rollback",
    "lease.release"
  ]);
  assert.equal(events.at(-1), "lease.release");
  assert.ok(leaseClient.calls.at(-1) instanceof DeleteCommand);
});

test("target create 직후 legacy workflow가 시작돼도 target을 rollback한다", async () => {
  const state = tradingState();
  const activeError = new AwsBootstrapError("legacy active", {
    code: "AWS_BOOTSTRAP_LEGACY_WORKFLOW_ACTIVE"
  });
  let checks = 0;
  const repository = new FakeRepository([
    missingTarget(),
    missingTarget()
  ]);
  const leaseClient = new FakeLeaseClient();

  await assert.rejects(
    migrateGitHubStateToAws({
      githubStore: new FakeGitHubStore({
        exists: true,
        state,
        sha: SOURCE_SHA
      }),
      repository,
      leaseOptions: leaseOptions(leaseClient),
      legacySchedulerDisabled: true,
      legacyActivityCheck: async () => {
        checks += 1;
        if (checks === 3) throw activeError;
        return { idle: true };
      },
      confirmation: "MIGRATE_GITHUB_STATE_TO_AWS"
    }),
    (error) => error === activeError
  );
  assert.equal(checks, 3);
  assert.equal(repository.initializeCalls.length, 1);
  assert.equal(repository.rollbackCalls.length, 1);
});

test("migration 실패 뒤 target rollback도 실패하면 부분 이전 상태를 명시한다", async () => {
  const state = tradingState();
  const sourceChanged = new Error("source changed");
  sourceChanged.code = "CLOUD_STATE_CONFLICT";
  const rollbackError = new Error("rollback conflict");
  rollbackError.code = "AWS_STATE_ROLLBACK_CONFLICT";
  const githubStore = new FakeGitHubStore(
    { exists: true, state, sha: SOURCE_SHA },
    {
      assertResponses: [{ unchanged: true, sha: SOURCE_SHA }, sourceChanged]
    }
  );
  const repository = new FakeRepository(
    [missingTarget(), missingTarget()],
    { rollbackResult: rollbackError }
  );
  const leaseClient = new FakeLeaseClient();

  await assert.rejects(
    migrateGitHubStateToAws({
      githubStore,
      repository,
      leaseOptions: leaseOptions(leaseClient),
      legacySchedulerDisabled: true,
      confirmation: "MIGRATE_GITHUB_STATE_TO_AWS"
    }),
    assertCode("AWS_BOOTSTRAP_TARGET_ROLLBACK_FAILED")
  );
  assert.equal(repository.rollbackCalls.length, 1);
  assert.ok(leaseClient.calls.at(-1) instanceof DeleteCommand);
});

test("성공 경로의 lease 해제 실패는 성공으로 숨기지 않는다", async () => {
  const state = tradingState();
  const persisted = existingTarget(state, 1);
  const releaseError = new Error("release failed");
  releaseError.name = "ConditionalCheckFailedException";
  const githubStore = new FakeGitHubStore({
    exists: true,
    state,
    sha: SOURCE_SHA
  });
  const repository = new FakeRepository([
    missingTarget(),
    missingTarget(),
    persisted
  ]);
  const leaseClient = new FakeLeaseClient({ releaseError });

  await assert.rejects(
    migrateGitHubStateToAws({
      githubStore,
      repository,
      leaseOptions: leaseOptions(leaseClient),
      legacySchedulerDisabled: true,
      confirmation: "MIGRATE_GITHUB_STATE_TO_AWS"
    }),
    (error) => error.code === "AWS_LEASE_LOST"
  );
  assert.ok(leaseClient.calls.at(-1) instanceof DeleteCommand);
});

test("migration 본문과 lease 해제가 함께 실패하면 원래 실패 원인을 보존한다", async () => {
  const state = tradingState();
  const migrationError = new Error("initialize failed");
  migrationError.code = "INITIALIZE_FAILED";
  const releaseError = new Error("release failed");
  releaseError.name = "ConditionalCheckFailedException";
  const githubStore = new FakeGitHubStore({
    exists: true,
    state,
    sha: SOURCE_SHA
  });
  const repository = new FakeRepository(
    [missingTarget(), missingTarget()],
    { initializeResult: migrationError }
  );
  const leaseClient = new FakeLeaseClient({ releaseError });

  await assert.rejects(
    migrateGitHubStateToAws({
      githubStore,
      repository,
      leaseOptions: leaseOptions(leaseClient),
      legacySchedulerDisabled: true,
      confirmation: "MIGRATE_GITHUB_STATE_TO_AWS"
    }),
    (error) => error === migrationError
  );
  assert.ok(leaseClient.calls.at(-1) instanceof DeleteCommand);
});
