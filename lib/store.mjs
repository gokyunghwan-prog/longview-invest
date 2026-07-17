import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { scoreAndRank } from "./scoring.mjs";

export const CORRUPT_SYNC_LOCK_STALE_MS = 24 * 60 * 60 * 1_000;

export async function readDataset(dataFile) {
  const raw = JSON.parse(await readFile(dataFile, "utf8"));
  return {
    meta: raw.meta,
    companies: scoreAndRank(raw.companies || [])
  };
}

export async function writeDataset(dataFile, dataset) {
  await mkdir(path.dirname(dataFile), { recursive: true });
  const temporaryFile = dataFile + ".tmp";
  const normalized = {
    ...dataset,
    companies: scoreAndRank(dataset.companies || [])
  };
  // 전체시장 데이터는 수천 개의 상세 레코드가 포함되므로 공백 들여쓰기를 저장하지 않는다.
  await writeFile(temporaryFile, JSON.stringify(normalized) + "\n", "utf8");
  await rename(temporaryFile, dataFile);
}

function parseSyncLock(raw) {
  try {
    const record = JSON.parse(raw);
    const startedAtMs = Date.parse(record?.startedAt);
    if (
      !Number.isSafeInteger(record?.pid) ||
      record.pid <= 0 ||
      !Number.isFinite(startedAtMs)
    ) {
      return null;
    }

    return {
      ...record,
      // Older local-only locks did not include hostname. Treating those as
      // local preserves crash recovery without weakening new cross-host locks.
      hostname:
        typeof record.hostname === "string" && record.hostname.trim()
          ? record.hostname
          : hostname(),
      startedAtMs
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM means the process exists. Unknown platform errors also fail closed.
    return true;
  }
}

async function inspectExistingLock(lockFile, corruptLockStaleMs) {
  let raw;
  let fileStats;

  try {
    raw = await readFile(lockFile, "utf8");
    fileStats = await stat(lockFile);
  } catch (error) {
    if (error?.code === "ENOENT") return { retry: true };
    throw error;
  }

  const record = parseSyncLock(raw);
  if (record) {
    if (record.hostname !== hostname()) {
      return { reclaim: false, reason: "다른 호스트에서 동기화가 실행 중일 수 있습니다." };
    }
    if (isProcessAlive(record.pid)) {
      return { reclaim: false, reason: "이미 데이터 동기화가 실행 중입니다." };
    }
    return { reclaim: true };
  }

  const ageMs = Date.now() - fileStats.mtimeMs;
  if (!Number.isFinite(ageMs) || ageMs < corruptLockStaleMs) {
    return {
      reclaim: false,
      reason: "동기화 잠금 파일이 손상되어 안전하게 상태를 확인할 수 없습니다."
    };
  }

  return { reclaim: true };
}

async function createSyncLock(lockFile, record) {
  let handle;
  try {
    handle = await open(lockFile, "wx");
    await handle.writeFile(JSON.stringify(record), "utf8");
    await handle.sync();
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (handle) await unlink(lockFile).catch(() => {});
    throw error;
  }
}

async function releaseOwnedLock(lockFile, record, handle) {
  await handle?.close().catch(() => {});

  try {
    const current = JSON.parse(await readFile(lockFile, "utf8"));
    if (current?.lockId !== record.lockId) return;
    await unlink(lockFile);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.name !== "SyntaxError") throw error;
  }
}

export async function acquireSyncLock(
  dataFile,
  { corruptLockStaleMs = CORRUPT_SYNC_LOCK_STALE_MS } = {}
) {
  if (!Number.isFinite(corruptLockStaleMs) || corruptLockStaleMs < 0) {
    throw new TypeError("corruptLockStaleMs must be a non-negative finite number");
  }

  const lockFile = path.join(path.dirname(dataFile), ".sync-lock");
  const record = {
    hostname: hostname(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    lockId: randomUUID()
  };

  await mkdir(path.dirname(dataFile), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    try {
      handle = await createSyncLock(lockFile, record);
      return async () => releaseOwnedLock(lockFile, record, handle);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const inspection = await inspectExistingLock(lockFile, corruptLockStaleMs);
    if (inspection.retry) continue;
    if (!inspection.reclaim) throw new Error(inspection.reason);

    const abandonedFile = `${lockFile}.abandoned-${process.pid}-${randomUUID()}`;
    try {
      // rename is the atomic ownership boundary. The next exclusive create
      // decides which competing process owns the replacement lock.
      await rename(lockFile, abandonedFile);
    } catch (error) {
      if (
        error?.code === "ENOENT" ||
        error?.code === "EEXIST" ||
        error?.code === "EPERM"
      ) {
        continue;
      }
      throw error;
    }

    await unlink(abandonedFile).catch(() => {});
  }

  throw new Error("동기화 잠금을 안전하게 획득하지 못했습니다. 다시 시도해 주세요.");
}
