import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";

import {
  AwsDurableStateError,
  DynamoLeaseGuard,
  DynamoTradingRepository
} from "../autotrade/aws/dynamo.mjs";
import {
  DynamoKisTokenCache,
  kisTokenCacheKey
} from "../autotrade/aws/token-cache.mjs";

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

function conditionalFailure() {
  const error = new Error("conditional detail");
  error.name = "ConditionalCheckFailedException";
  return error;
}

function assertCode(code) {
  return (error) => {
    assert.ok(error instanceof AwsDurableStateError);
    assert.equal(error.code, code);
    return true;
  };
}

function stateItem(state, version = 1, overrides = {}) {
  const payload = JSON.stringify(state);
  return {
    pk: "longview#state",
    version,
    payload,
    checksum: createHash("sha256").update(payload).digest("hex"),
    ...overrides
  };
}

test("Dynamo 상태 저장소는 consistent read와 checksum 검증을 사용한다", async () => {
  const state = { strategy: { cycleKey: "2026-07-24" } };
  const client = new QueueClient({ Item: stateItem(state, 7) });
  const repository = new DynamoTradingRepository({
    client,
    tableName: "trading-state"
  });

  const loaded = await repository.load();
  assert.deepEqual(loaded.state, state);
  assert.equal(loaded.version, 7);
  assert.ok(client.calls[0] instanceof GetCommand);
  assert.equal(client.calls[0].input.ConsistentRead, true);
  assert.deepEqual(client.calls[0].input.Key, { pk: "longview#state" });
});

test("손상되거나 과대한 Dynamo 상태는 조용히 사용하지 않는다", async (t) => {
  await t.test("checksum 불일치", async () => {
    const repository = new DynamoTradingRepository({
      client: new QueueClient({
        Item: stateItem({ safe: true }, 1, { checksum: "0".repeat(64) })
      }),
      tableName: "trading-state"
    });
    await assert.rejects(
      repository.load(),
      assertCode("AWS_STATE_CHECKSUM_MISMATCH")
    );
  });

  await t.test("크기 제한", async () => {
    const repository = new DynamoTradingRepository({
      client: new QueueClient(),
      tableName: "trading-state",
      maximumStateBytes: 128
    });
    await assert.rejects(
      repository.initialize({ payload: "x".repeat(256) }),
      assertCode("AWS_STATE_TOO_LARGE")
    );
  });
});

test("Dynamo 상태 초기화는 create-only, 갱신은 version CAS로 수행한다", async () => {
  const client = new QueueClient({}, {});
  const repository = new DynamoTradingRepository({
    client,
    tableName: "trading-state",
    now: () => Date.parse("2026-07-24T01:00:00.000Z")
  });

  const initialized = await repository.initialize({ value: 1 });
  const saved = await repository.save({ value: 2 }, { expectedVersion: 1 });

  assert.equal(initialized.version, 1);
  assert.equal(saved.version, 2);
  assert.ok(client.calls[0] instanceof PutCommand);
  assert.equal(client.calls[0].input.ConditionExpression, "attribute_not_exists(pk)");
  assert.equal(client.calls[0].input.Item.version, 1);
  assert.ok(client.calls[1] instanceof UpdateCommand);
  assert.equal(
    client.calls[1].input.ExpressionAttributeValues[":expectedVersion"],
    1
  );
  assert.equal(
    client.calls[1].input.ExpressionAttributeValues[":nextVersion"],
    2
  );
});

test("마이그레이션 rollback은 방금 만든 동일 version·checksum 상태만 삭제한다", async () => {
  const state = { value: 1 };
  const expectedChecksum = createHash("sha256")
    .update(JSON.stringify(state))
    .digest("hex");
  const client = new QueueClient({}, {});
  const repository = new DynamoTradingRepository({
    client,
    tableName: "trading-state"
  });

  const initialized = await repository.initialize(state);
  const rolledBack = await repository.rollbackInitialization({
    expectedVersion: initialized.version,
    expectedChecksum
  });

  assert.equal(rolledBack.rolledBack, true);
  assert.ok(client.calls[1] instanceof DeleteCommand);
  assert.match(client.calls[1].input.ConditionExpression, /#version = :version/);
  assert.match(client.calls[1].input.ConditionExpression, /#checksum = :checksum/);
  assert.equal(
    client.calls[1].input.ExpressionAttributeValues[":checksum"],
    expectedChecksum
  );

  const conflicted = new DynamoTradingRepository({
    client: new QueueClient(conditionalFailure()),
    tableName: "trading-state"
  });
  await assert.rejects(
    conflicted.rollbackInitialization({
      expectedVersion: 1,
      expectedChecksum
    }),
    assertCode("AWS_STATE_ROLLBACK_CONFLICT")
  );
});

test("Dynamo 초기화·CAS 충돌은 기존 상태를 덮어쓰지 않고 구분한다", async () => {
  const initialize = new DynamoTradingRepository({
    client: new QueueClient(conditionalFailure()),
    tableName: "trading-state"
  });
  await assert.rejects(
    initialize.initialize({ value: 1 }),
    assertCode("AWS_STATE_ALREADY_EXISTS")
  );

  const save = new DynamoTradingRepository({
    client: new QueueClient(conditionalFailure()),
    tableName: "trading-state"
  });
  await assert.rejects(
    save.save({ value: 2 }, { expectedVersion: 1 }),
    assertCode("AWS_STATE_CONFLICT")
  );
});

test("주문 직전 상태 version fencing은 누락·변경을 차단한다", async () => {
  const matching = new DynamoTradingRepository({
    client: new QueueClient({ Item: stateItem({ value: 1 }, 3) }),
    tableName: "trading-state"
  });
  assert.equal((await matching.assertVersion(3)).version, 3);

  const changed = new DynamoTradingRepository({
    client: new QueueClient({ Item: stateItem({ value: 2 }, 4) }),
    tableName: "trading-state"
  });
  await assert.rejects(changed.assertVersion(3), assertCode("AWS_STATE_CONFLICT"));

  const missing = new DynamoTradingRepository({
    client: new QueueClient({}),
    tableName: "trading-state"
  });
  await assert.rejects(missing.assertVersion(3), assertCode("AWS_STATE_CONFLICT"));
});

test("일별 실행 journal은 시작·종료 소유권과 summary JSON을 보존한다", async () => {
  const client = new QueueClient(
    {},
    {},
    {
      Item: {
        pk: "longview#execution/auto/2026-07-24",
        executionId: "exec-1",
        terminal: true,
        status: "success",
        summary: JSON.stringify({ orderCount: 3 })
      }
    }
  );
  const repository = new DynamoTradingRepository({
    client,
    tableName: "trading-state",
    now: () => Date.parse("2026-07-24T01:00:00.000Z")
  });

  await repository.markExecutionStarted({
    command: "auto",
    businessDate: "2026-07-24",
    executionId: "exec-1",
    scheduledAt: "2026-07-24T00:00:00.000Z",
    mode: "live"
  });
  await repository.markExecutionFinished({
    command: "auto",
    businessDate: "2026-07-24",
    executionId: "exec-1",
    status: "success",
    summary: { orderCount: 3 }
  });
  const loaded = await repository.getExecution({
    command: "auto",
    businessDate: "2026-07-24"
  });

  assert.equal(
    client.calls[0].input.Key.pk,
    "longview#execution/auto/2026-07-24"
  );
  assert.equal(
    client.calls[1].input.ConditionExpression,
    "#executionId = :executionId"
  );
  assert.deepEqual(loaded.summary, { orderCount: 3 });
  assert.ok(client.calls[2] instanceof GetCommand);
  assert.equal(client.calls[2].input.ConsistentRead, true);
});

test("실행 journal 종료는 다른 execution ID와 허용되지 않은 status를 거부한다", async () => {
  const repository = new DynamoTradingRepository({
    client: new QueueClient(conditionalFailure()),
    tableName: "trading-state"
  });
  await assert.rejects(
    repository.markExecutionFinished({
      command: "auto",
      businessDate: "2026-07-24",
      executionId: "wrong-owner",
      status: "success"
    }),
    assertCode("AWS_EXECUTION_CONFLICT")
  );
  await assert.rejects(
    repository.markExecutionFinished({
      command: "auto",
      businessDate: "2026-07-24",
      executionId: "exec-1",
      status: "unknown"
    }),
    /종료 상태/
  );
});

test("Dynamo lease는 조건부 획득·fence renew·조건부 해제를 이어서 수행한다", async () => {
  let now = Date.parse("2026-07-24T00:00:00.000Z");
  const client = new QueueClient({ Attributes: { fence: 7 } }, {}, {});
  const lease = await DynamoLeaseGuard.acquire({
    client,
    tableName: "trading-state",
    namespace: "longview",
    scope: "trading",
    owner: "exec-1",
    leaseMs: 120_000,
    heartbeatMs: 30_000,
    now: () => now
  });

  assert.ok(client.calls[0] instanceof UpdateCommand);
  assert.match(client.calls[0].input.ConditionExpression, /attribute_not_exists/);
  assert.equal(lease.fence, 7);

  now += 10_000;
  const renewed = await lease.ensure();
  assert.equal(renewed.fence, 7);
  assert.equal(
    client.calls[1].input.ExpressionAttributeValues[":owner"],
    "exec-1"
  );
  assert.equal(client.calls[1].input.ExpressionAttributeValues[":fence"], 7);

  await lease.release();
  assert.ok(client.calls[2] instanceof DeleteCommand);
  assert.equal(client.calls[2].input.ExpressionAttributeValues[":fence"], 7);
});

test("다른 소유자의 lease와 잃어버린 fence는 fail-closed한다", async () => {
  const busy = new QueueClient(conditionalFailure());
  await assert.rejects(
    DynamoLeaseGuard.acquire({
      client: busy,
      tableName: "trading-state",
      owner: "exec-2",
      leaseMs: 120_000,
      heartbeatMs: 30_000
    }),
    assertCode("AWS_LEASE_BUSY")
  );

  const lost = new QueueClient(
    { Attributes: { fence: 2 } },
    conditionalFailure()
  );
  const lease = await DynamoLeaseGuard.acquire({
    client: lost,
    tableName: "trading-state",
    owner: "exec-1",
    leaseMs: 120_000,
    heartbeatMs: 30_000
  });
  await assert.rejects(lease.ensure(), assertCode("AWS_LEASE_LOST"));
  await assert.rejects(lease.stopHeartbeat(), assertCode("AWS_LEASE_LOST"));
});

test("KIS token cache key는 App Key 원문을 노출하지 않고 환경별로 분리된다", () => {
  const appKey = "real-app-key-must-not-appear";
  const live = kisTokenCacheKey({
    namespace: "longview",
    environment: "live",
    appKey
  });
  const paper = kisTokenCacheKey({
    namespace: "longview",
    environment: "paper",
    appKey
  });

  assert.doesNotMatch(live, new RegExp(appKey));
  assert.notEqual(live, paper);
  assert.match(live, /^longview#token\/kis\/live\/[a-f0-9]{24}$/);
});

test("KIS token cache는 consistent read·TTL 저장·명시적 삭제를 수행한다", async () => {
  const now = Date.parse("2026-07-24T00:00:00.000Z");
  const expiresAt = now + 60 * 60_000;
  const client = new QueueClient(
    {
      Item: {
        accessToken: "cached-access-token",
        expiresAtEpochMs: expiresAt
      }
    },
    {},
    {}
  );
  const cache = new DynamoKisTokenCache({
    client,
    tableName: "trading-state",
    environment: "live",
    appKey: "app-key",
    now: () => now
  });

  assert.deepEqual(await cache.load(), {
    accessToken: "cached-access-token",
    expiresAt
  });
  await cache.save({ accessToken: "new-access-token", expiresAt });
  await cache.clear();

  assert.ok(client.calls[0] instanceof GetCommand);
  assert.equal(client.calls[0].input.ConsistentRead, true);
  assert.ok(client.calls[1] instanceof PutCommand);
  assert.equal(client.calls[1].input.Item.expiresAtEpochMs, expiresAt);
  assert.equal(
    client.calls[1].input.Item.ttl,
    Math.floor(expiresAt / 1_000) + 86_400
  );
  assert.ok(client.calls[2] instanceof DeleteCommand);
});

test("KIS token cache는 손상값·만료값·AWS 오류를 구분해 거부한다", async (t) => {
  await t.test("손상된 저장값", async () => {
    const cache = new DynamoKisTokenCache({
      client: new QueueClient({ Item: { accessToken: "", expiresAtEpochMs: 1 } }),
      tableName: "state",
      environment: "live",
      appKey: "key"
    });
    await assert.rejects(cache.load(), assertCode("AWS_TOKEN_CACHE_INVALID"));
  });

  await t.test("이미 만료된 저장 요청", async () => {
    const client = new QueueClient();
    const cache = new DynamoKisTokenCache({
      client,
      tableName: "state",
      environment: "live",
      appKey: "key",
      now: () => 1_000
    });
    await assert.rejects(
      cache.save({ accessToken: "token", expiresAt: 1_000 }),
      /만료시각/
    );
    assert.equal(client.calls.length, 0);
  });

  await t.test("AWS read 오류", async () => {
    const cache = new DynamoKisTokenCache({
      client: new QueueClient(new Error("backend detail")),
      tableName: "state",
      environment: "live",
      appKey: "key"
    });
    await assert.rejects(
      cache.load(),
      assertCode("AWS_TOKEN_CACHE_READ_FAILED")
    );
  });
});
