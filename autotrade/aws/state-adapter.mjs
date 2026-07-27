import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createTradingStateStore } from "../state-store.mjs";
import { AwsDurableStateError } from "./dynamo.mjs";

async function writeStateAtomically(stateDir, state) {
  await mkdir(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, "state.json");
  const temporary = `${stateFile}.aws-${process.pid}-${randomUUID()}`;
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

export async function createDynamoBackedTradingStateStore({
  repository,
  stateDir,
  startingCashKrw,
  now = () => new Date(),
  requireExisting = true,
  auditSink = null
} = {}) {
  if (
    !repository ||
    typeof repository.load !== "function" ||
    typeof repository.initialize !== "function" ||
    typeof repository.save !== "function" ||
    typeof repository.assertVersion !== "function"
  ) {
    throw new TypeError("AWS 자동매매 상태 repository가 올바르지 않습니다.");
  }
  if (!stateDir) throw new TypeError("AWS 자동매매 로컬 상태 경로가 필요합니다.");
  if (auditSink !== null && typeof auditSink !== "function") {
    throw new TypeError("AWS 감사 로그 sink는 함수여야 합니다.");
  }

  const loaded = await repository.load();
  if (requireExisting && !loaded.exists) {
    throw new AwsDurableStateError(
      "AWS 자동매매 상태가 없습니다. 기존 GitHub 상태를 먼저 이전해야 합니다.",
      { code: "AWS_STATE_MIGRATION_REQUIRED" }
    );
  }
  if (loaded.exists) await writeStateAtomically(stateDir, loaded.state);

  let expectedVersion = loaded.version;
  const stateStore = await createTradingStateStore(stateDir, {
    startingCashKrw,
    now,
    onAuditAppended: auditSink
      ? async (entry) => {
          await auditSink(entry);
        }
      : null,
    onStateCommitted: async (state) => {
      if (expectedVersion < 1) {
        throw new AwsDurableStateError("AWS 상태 초기화 버전이 없습니다.", {
          code: "AWS_STATE_NOT_INITIALIZED"
        });
      }
      const saved = await repository.save(state, {
        expectedVersion
      });
      expectedVersion = saved.version;
    }
  });

  if (!loaded.exists) {
    const initialized = await repository.initialize(stateStore.snapshot());
    expectedVersion = initialized.version;
  }

  return {
    stateStore,
    get version() {
      return expectedVersion;
    },
    assertCurrentVersion: () => repository.assertVersion(expectedVersion)
  };
}
