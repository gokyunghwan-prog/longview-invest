import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDynamoBackedTradingStateStore } from "../autotrade/aws/state-adapter.mjs";
import { createTradingStateStore } from "../autotrade/state-store.mjs";

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fakeRepository(loaded) {
  const calls = {
    load: 0,
    initialize: [],
    save: [],
    assertVersion: []
  };
  let version = loaded.version || 0;
  return {
    calls,
    async load() {
      calls.load += 1;
      return structuredClone(loaded);
    },
    async initialize(state) {
      calls.initialize.push(structuredClone(state));
      version = 1;
      return { version };
    },
    async save(state, options) {
      calls.save.push({
        state: structuredClone(state),
        options: structuredClone(options)
      });
      assert.equal(options.expectedVersion, version);
      version += 1;
      return { version };
    },
    async assertVersion(expectedVersion) {
      calls.assertVersion.push(expectedVersion);
      assert.equal(expectedVersion, version);
      return { exists: true, version };
    }
  };
}

test("기존 원격 상태가 없으면 기본적으로 migration을 요구하고 새 장부를 만들지 않는다", async (t) => {
  const stateDir = await temporaryDirectory(t, "longview-aws-state-missing-");
  const repository = fakeRepository({
    exists: false,
    state: null,
    version: 0
  });

  await assert.rejects(
    createDynamoBackedTradingStateStore({
      repository,
      stateDir,
      startingCashKrw: 100_000
    }),
    (error) => {
      assert.equal(error.code, "AWS_STATE_MIGRATION_REQUIRED");
      return true;
    }
  );
  assert.equal(repository.calls.initialize.length, 0);
  assert.equal(repository.calls.save.length, 0);
});

test("명시적 최초 초기화 뒤 모든 로컬 커밋을 Dynamo version CAS에 연결한다", async (t) => {
  const stateDir = await temporaryDirectory(t, "longview-aws-state-init-");
  const repository = fakeRepository({
    exists: false,
    state: null,
    version: 0
  });
  const backed = await createDynamoBackedTradingStateStore({
    repository,
    stateDir,
    startingCashKrw: 100_000,
    requireExisting: false,
    now: () => new Date("2026-07-24T00:00:00.000Z")
  });

  assert.equal(backed.version, 1);
  assert.equal(repository.calls.initialize.length, 1);
  assert.equal(repository.calls.initialize[0].paper.cashKrw, 100_000);

  await backed.stateStore.update((state) => {
    state.strategy.candidateCount = 4;
  });
  assert.equal(backed.version, 2);
  assert.equal(repository.calls.save.length, 1);
  assert.equal(repository.calls.save[0].options.expectedVersion, 1);
  assert.equal(repository.calls.save[0].state.strategy.candidateCount, 4);

  await backed.assertCurrentVersion();
  assert.deepEqual(repository.calls.assertVersion, [2]);
});

test("기존 Dynamo 상태를 로컬에 materialize하고 감사 이벤트를 sink로 전달한다", async (t) => {
  const sourceDir = await temporaryDirectory(t, "longview-aws-state-source-");
  const source = await createTradingStateStore(sourceDir, {
    startingCashKrw: 250_000,
    now: () => new Date("2026-07-23T00:00:00.000Z")
  });
  await source.update((state) => {
    state.strategy.candidateCount = 2;
  });

  const stateDir = await temporaryDirectory(t, "longview-aws-state-loaded-");
  const repository = fakeRepository({
    exists: true,
    state: source.snapshot(),
    version: 9
  });
  const audits = [];
  const backed = await createDynamoBackedTradingStateStore({
    repository,
    stateDir,
    startingCashKrw: 999_999,
    now: () => new Date("2026-07-24T00:00:00.000Z"),
    auditSink: async (entry) => audits.push(entry)
  });

  assert.equal(backed.version, 9);
  assert.equal(backed.stateStore.snapshot().paper.cashKrw, 250_000);
  assert.equal(backed.stateStore.snapshot().strategy.candidateCount, 2);
  assert.equal(repository.calls.initialize.length, 0);

  await backed.stateStore.update(
    (state) => {
      state.strategy.candidateCount = 3;
    },
    { type: "aws_state_test", safe: true }
  );
  assert.equal(backed.version, 10);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].type, "aws_state_test");
  assert.equal(audits[0].safe, true);
});

test("Dynamo CAS 저장 실패는 로컬 update 호출까지 실패시켜 다음 주문 단계를 막는다", async (t) => {
  const sourceDir = await temporaryDirectory(t, "longview-aws-state-source-");
  const source = await createTradingStateStore(sourceDir, {
    startingCashKrw: 100_000
  });
  const stateDir = await temporaryDirectory(t, "longview-aws-state-failure-");
  const repository = fakeRepository({
    exists: true,
    state: source.snapshot(),
    version: 3
  });
  repository.save = async () => {
    const error = new Error("remote CAS failed");
    error.code = "AWS_STATE_CONFLICT";
    throw error;
  };
  const backed = await createDynamoBackedTradingStateStore({
    repository,
    stateDir,
    startingCashKrw: 100_000
  });

  await assert.rejects(
    backed.stateStore.update((state) => {
      state.strategy.candidateCount = 99;
    }),
    (error) => error.code === "AWS_STATE_CONFLICT"
  );
  assert.equal(backed.version, 3);
});
