import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { acquireSyncLock, CORRUPT_SYNC_LOCK_STALE_MS } from "../lib/store.mjs";

async function withTempDataset(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "longview-lock-"));
  try {
    await run(path.join(directory, "companies.json"), path.join(directory, ".sync-lock"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function exitedChildPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore"
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return child.pid;
}

test("active sync lock records ownership and refuses a second owner", async () => {
  await withTempDataset(async (dataFile, lockFile) => {
    const release = await acquireSyncLock(dataFile);
    const record = JSON.parse(await readFile(lockFile, "utf8"));

    assert.equal(record.hostname, hostname());
    assert.equal(record.pid, process.pid);
    assert.ok(Number.isFinite(Date.parse(record.startedAt)));
    assert.match(record.lockId, /^[0-9a-f-]{36}$/i);
    await assert.rejects(acquireSyncLock(dataFile), /이미 데이터 동기화가 실행 중/);

    await release();
    await assert.rejects(stat(lockFile), { code: "ENOENT" });
  });
});

test("dead local process lock is atomically reclaimed", async () => {
  await withTempDataset(async (dataFile, lockFile) => {
    const deadPid = await exitedChildPid();
    await writeFile(
      lockFile,
      JSON.stringify({ hostname: hostname(), pid: deadPid, startedAt: new Date().toISOString() }),
      "utf8"
    );

    const release = await acquireSyncLock(dataFile);
    const record = JSON.parse(await readFile(lockFile, "utf8"));
    assert.equal(record.pid, process.pid);
    assert.equal(record.hostname, hostname());
    assert.deepEqual(
      (await readdir(path.dirname(lockFile))).filter((name) => name.includes(".abandoned-")),
      []
    );
    await release();
  });
});

test("fresh corrupt lock fails closed", async () => {
  await withTempDataset(async (dataFile, lockFile) => {
    await writeFile(lockFile, "{not-json", "utf8");

    await assert.rejects(acquireSyncLock(dataFile), /손상되어 안전하게 상태를 확인할 수 없습니다/);
    assert.equal(await readFile(lockFile, "utf8"), "{not-json");
  });
});

test("sufficiently old corrupt lock can be reclaimed", async () => {
  await withTempDataset(async (dataFile, lockFile) => {
    await writeFile(lockFile, "{not-json", "utf8");
    const old = new Date(Date.now() - CORRUPT_SYNC_LOCK_STALE_MS - 60_000);
    await utimes(lockFile, old, old);

    const release = await acquireSyncLock(dataFile);
    const record = JSON.parse(await readFile(lockFile, "utf8"));
    assert.equal(record.pid, process.pid);
    await release();
  });
});
