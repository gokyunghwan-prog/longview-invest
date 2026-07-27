import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

import {
  applyAwsTradingEnvironment,
  publicAwsTaskFailure,
  runAwsTask
} from "../autotrade/aws/runner.mjs";

const NOW = new Date("2026-07-24T01:00:00.000Z");
const BUSINESS_DATE = "2026-07-24";

function stateItem() {
  const state = {
    schemaVersion: 1,
    strategy: { inFlight: null },
    runs: []
  };
  const payload = JSON.stringify(state);
  return {
    pk: "longview#state",
    kind: "trading_state",
    version: 7,
    payload,
    checksum: createHash("sha256").update(payload).digest("hex")
  };
}

function executionItem(command) {
  return {
    pk: `longview#execution/${command}/${BUSINESS_DATE}`,
    kind: "execution",
    command,
    businessDate: BUSINESS_DATE,
    executionId: `previous-${command}`,
    status: "success",
    terminal: true,
    summary: "{}"
  };
}

function manifest() {
  const selectionHash = "a".repeat(64);
  return {
    schemaVersion: 1,
    revision: "0123456789abcdef0123",
    sourceUpdatedAt: "2026-07-23T12:00:00.000Z",
    selectionGeneratedAt: "2026-07-23T12:01:00.000Z",
    publishedAt: "2026-07-23T12:02:00.000Z",
    artifacts: {
      companies: {
        key: "revisions/0123456789abcdef0123/companies.json",
        sha256: "b".repeat(64),
        bytes: 10,
        contentType: "application/json"
      },
      selection: {
        key:
          "revisions/0123456789abcdef0123/" +
          `trading-selection-${selectionHash}.json`,
        sha256: selectionHash,
        bytes: 10,
        contentType: "application/json"
      }
    }
  };
}

class AuditDynamoClient {
  constructor({ includeState = true, includeExecutions = true } = {}) {
    this.includeState = includeState;
    this.includeExecutions = includeExecutions;
    this.calls = [];
  }

  async send(command) {
    this.calls.push(command);
    assert.ok(command instanceof GetCommand);
    const pk = command.input.Key.pk;
    if (pk === "longview#state") {
      return this.includeState ? { Item: stateItem() } : {};
    }
    if (pk.includes("#execution/auto/")) {
      return this.includeExecutions ? { Item: executionItem("auto") } : {};
    }
    if (pk.includes("#execution/reconcile-final/")) {
      return this.includeExecutions
        ? { Item: executionItem("reconcile-final") }
        : {};
    }
    throw new Error(`예상하지 못한 Dynamo key: ${pk}`);
  }
}

class AuditS3Client {
  constructor({ includeManifest = true } = {}) {
    this.includeManifest = includeManifest;
    this.calls = [];
  }

  async send(command) {
    this.calls.push(command);
    assert.ok(command instanceof GetObjectCommand);
    assert.equal(command.input.Key, "latest/manifest.json");
    if (!this.includeManifest) {
      const error = new Error("missing");
      error.name = "NoSuchKey";
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    }
    const body = `${JSON.stringify(manifest())}\n`;
    return {
      ContentLength: Buffer.byteLength(body),
      Body: Readable.from([body])
    };
  }
}

function logger() {
  const events = [];
  return {
    events,
    info(event, fields) {
      events.push({ level: "info", event, fields });
    },
    warn(event, fields) {
      events.push({ level: "warn", event, fields });
    },
    error(event, fields) {
      events.push({ level: "error", event, fields });
    },
    metric(name, value, fields) {
      events.push({ level: "metric", name, value, fields });
    },
    async audit() {}
  };
}

function auditEnvironment() {
  return {
    AUTOTRADE_TASK_SOURCE: "manual",
    AUTOTRADE_EXECUTION_ID: "manual-audit",
    AUTOTRADE_EXECUTION_MODE: "dry-run",
    AUTOTRADE_SCHEDULE_ARN: "manual",
    AUTOTRADE_SCHEDULE_SLOT: "audit",
    AUTOTRADE_STATE_TABLE: "longview-state",
    AUTOTRADE_SNAPSHOT_BUCKET: "longview-snapshots",
    AUTOTRADE_FINAL_RECONCILE_SLOT: "reconcile-final"
  };
}

test("AWS 거래 환경은 승인된 가치·장기 전략값을 고정하고 임의 override를 거부한다", () => {
  const env = {};
  applyAwsTradingEnvironment(env);
  assert.equal(env.TRADING_MIN_POSITIONS, "3");
  assert.equal(env.TRADING_MAX_POSITIONS, "5");
  assert.equal(env.TRADING_CASH_RESERVE_PERCENT, "0");
  assert.equal(env.TRADING_REBALANCE_FREQUENCY, "daily");
  assert.equal(env.TRADING_REQUIRE_PUBLISHED_SELECTION, "true");
  assert.throws(
    () => applyAwsTradingEnvironment({ TRADING_MAX_POSITION_PERCENT: "99" }),
    /승인값/
  );
});

test("audit 명령은 KIS·SSM 없이 Dynamo 상태와 동일 manifest를 끝까지 확인한다", async () => {
  const dynamo = new AuditDynamoClient();
  const s3 = new AuditS3Client();
  const output = logger();
  const clients = {
    dynamo,
    s3,
    secrets: {
      async send() {
        throw new Error("audit가 Secret을 읽으면 안 됩니다.");
      }
    },
    ssm: {
      async send() {
        throw new Error("audit가 SSM을 읽으면 안 됩니다.");
      }
    }
  };

  const result = await runAwsTask({
    command: "audit",
    env: auditEnvironment(),
    now: () => new Date(NOW),
    clients,
    logger: output
  });

  assert.deepEqual(result.issues, []);
  assert.equal(result.stateVersion, 7);
  assert.equal(result.artifactRevision, manifest().revision);
  assert.equal(dynamo.calls.length, 3);
  assert.equal(s3.calls.length, 1);
  assert.ok(
    output.events.some(
      (entry) => entry.level === "metric" && entry.name === "DailyAuditSucceeded"
    )
  );
});

test("audit는 실행·상태·manifest 누락을 한꺼번에 fail-closed 보고한다", async () => {
  const output = logger();
  let failure;
  try {
    await runAwsTask({
      command: "audit",
      env: auditEnvironment(),
      now: () => new Date(NOW),
      clients: {
        dynamo: new AuditDynamoClient({
          includeState: false,
          includeExecutions: false
        }),
        s3: new AuditS3Client({ includeManifest: false }),
        secrets: {},
        ssm: {}
      },
      logger: output
    });
    assert.fail("audit가 실패해야 합니다.");
  } catch (error) {
    failure = error;
  }

  assert.equal(failure.code, "AWS_AUDIT_FAILED");
  assert.deepEqual(failure.summary.issues.sort(), [
    "AUTO_EXECUTION_MISSING",
    "SNAPSHOT_MANIFEST_MISSING",
    "SNAPSHOT_STALE",
    "TRADING_STATE_MISSING"
  ]);
  assert.deepEqual(publicAwsTaskFailure(failure), {
    ok: false,
    errorCode: "AUDIT_FAILED"
  });
  assert.ok(
    output.events.some(
      (entry) =>
        entry.level === "metric" && entry.name === "AbsenceOrSafetyFailure"
    )
  );
});
