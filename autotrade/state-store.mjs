import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const RUN_LOCK_DIRECTORY_NAME = "run.lock";
export const RUN_LOCK_ORPHAN_GRACE_MS = 30_000;

export class TradingRunLockedError extends Error {
  constructor(message = "다른 자동매매 실행이 이미 진행 중입니다.") {
    super(message);
    this.name = "TradingRunLockedError";
    this.code = "TRADING_RUN_LOCKED";
    this.status = 409;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM and unknown platform errors fail closed: never steal a lock from a
    // process that might still be alive.
    return true;
  }
}

function initialState(startingCashKrw, now) {
  const createdAt = now().toISOString();
  return {
    schemaVersion: 1,
    createdAt,
    updatedAt: createdAt,
    paper: {
      cashKrw: startingCashKrw,
      positions: {},
      orders: []
    },
    strategy: {
      lastSnapshotRevision: null,
      lastPlanAt: null,
      candidateCount: null,
      candidateCountScope: null,
      removalStreaks: {},
      managedSecurities: {},
      pendingManagedSecurities: {},
      completedCycleKeys: [],
      inFlight: null
    },
    cloud: {
      fence: 0,
      lease: null
    },
    runs: []
  };
}

function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !state.paper || !state.strategy) {
    throw new Error("자동매매 상태 파일 형식이 올바르지 않습니다.");
  }
  if (!Number.isFinite(state.paper.cashKrw) || state.paper.cashKrw < 0) {
    throw new Error("모의투자 현금 상태가 올바르지 않습니다.");
  }
  if (!state.paper.positions || typeof state.paper.positions !== "object") {
    throw new Error("모의투자 보유종목 상태가 올바르지 않습니다.");
  }
  if (!Array.isArray(state.strategy.completedCycleKeys || [])) {
    throw new Error("자동매매 중복방지 상태가 올바르지 않습니다.");
  }
  if (!("candidateCountScope" in state.strategy)) {
    state.strategy.candidateCountScope = null;
  }
  if (
    state.strategy.candidateCountScope !== null &&
    (typeof state.strategy.candidateCountScope !== "string" ||
      state.strategy.candidateCountScope.length > 256)
  ) {
    throw new Error("자동매매 후보 수 기준 상태가 올바르지 않습니다.");
  }
  if (!("pendingManagedSecurities" in state.strategy)) {
    state.strategy.pendingManagedSecurities = {};
  }
  if (
    !state.strategy.pendingManagedSecurities ||
    typeof state.strategy.pendingManagedSecurities !== "object" ||
    Array.isArray(state.strategy.pendingManagedSecurities)
  ) {
    throw new Error("자동매매 체결확인 대기 상태가 올바르지 않습니다.");
  }
  if (!("inFlight" in state.strategy)) state.strategy.inFlight = null;
  if (
    state.strategy.inFlight !== null &&
    (typeof state.strategy.inFlight !== "object" ||
      !String(state.strategy.inFlight.cycleKey || "").trim())
  ) {
    throw new Error("자동매매 미결 주문 상태가 올바르지 않습니다.");
  }
  if (!Array.isArray(state.runs || [])) {
    throw new Error("자동매매 실행 기록이 올바르지 않습니다.");
  }
  if (!("cloud" in state)) state.cloud = { fence: 0, lease: null };
  if (
    !state.cloud ||
    typeof state.cloud !== "object" ||
    Array.isArray(state.cloud) ||
    !Number.isSafeInteger(state.cloud.fence) ||
    state.cloud.fence < 0 ||
    (state.cloud.lease !== null &&
      (typeof state.cloud.lease !== "object" ||
        !String(state.cloud.lease.owner || "").trim() ||
        !Number.isFinite(Date.parse(state.cloud.lease.expiresAt || ""))))
  ) {
    throw new Error("자동매매 클라우드 lease 상태가 올바르지 않습니다.");
  }
  return state;
}

export function validateTradingState(state) {
  return validateState(structuredClone(state));
}

async function writeAtomic(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(payload, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx"
    });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export class TradingStateStore {
  constructor(
    directory,
    {
      startingCashKrw = 10_000_000,
      now = () => new Date(),
      lockNow = Date.now,
      pid = process.pid,
      isProcessAlive = processIsAlive,
      orphanGraceMs = RUN_LOCK_ORPHAN_GRACE_MS,
      onStateCommitted = null,
      onAuditAppended = null
    } = {}
  ) {
    if (onStateCommitted !== null && typeof onStateCommitted !== "function") {
      throw new TypeError("상태 저장 후 콜백은 함수여야 합니다.");
    }
    if (onAuditAppended !== null && typeof onAuditAppended !== "function") {
      throw new TypeError("감사 로그 저장 후 콜백은 함수여야 합니다.");
    }
    this.directory = directory;
    this.stateFile = path.join(directory, "state.json");
    this.auditFile = path.join(directory, "audit.ndjson");
    this.runLockDirectory = path.join(directory, RUN_LOCK_DIRECTORY_NAME);
    this.runLockOwnerFile = path.join(this.runLockDirectory, "owner.json");
    this.startingCashKrw = startingCashKrw;
    this.now = now;
    if (typeof lockNow !== "function") {
      throw new TypeError("실행 잠금 시각은 함수여야 합니다.");
    }
    this.lockNow = lockNow;
    this.pid = pid;
    this.isProcessAlive = isProcessAlive;
    this.orphanGraceMs = orphanGraceMs;
    this.onStateCommitted = onStateCommitted;
    this.onAuditAppended = onAuditAppended;
    this.state = null;
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    try {
      await this.reload();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.state = initialState(this.startingCashKrw, this.now);
      await writeAtomic(this.stateFile, this.state);
    }
    return this;
  }

  async reload() {
    // Do not let a read race an in-process atomic write and replace the fresh
    // in-memory state with an older snapshot. Cross-process writes are atomic.
    await this.writeChain.catch(() => {});
    this.state = validateState(JSON.parse(await readFile(this.stateFile, "utf8")));
    return this.snapshot();
  }

  snapshot() {
    if (!this.state) throw new Error("자동매매 상태 저장소가 준비되지 않았습니다.");
    return structuredClone(this.state);
  }

  async update(mutator, audit = null) {
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      const next = structuredClone(this.state);
      const result = await mutator(next);
      next.updatedAt = this.now().toISOString();
      validateState(next);
      await writeAtomic(this.stateFile, next);
      this.state = next;
      if (audit) await this.appendAudit(audit);
      if (this.onStateCommitted) {
        await this.onStateCommitted(structuredClone(next), {
          audit: audit ? structuredClone(audit) : null
        });
      }
      return result;
    });
    return this.writeChain;
  }

  async appendAudit(entry) {
    const safeEntry = {
      id: randomUUID(),
      at: this.now().toISOString(),
      ...entry
    };
    const line = JSON.stringify(safeEntry) + "\n";
    await writeFile(this.auditFile, line, { encoding: "utf8", flag: "a" });
    if (this.onAuditAppended) {
      await this.onAuditAppended(structuredClone(safeEntry));
    }
  }

  async inspectRunLock() {
    let owner = null;
    try {
      owner = JSON.parse(await readFile(this.runLockOwnerFile, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.name !== "SyntaxError") throw error;
    }
    if (owner && Number.isSafeInteger(owner.pid) && String(owner.token || "")) {
      return {
        owner,
        recoverable: !this.isProcessAlive(owner.pid)
      };
    }
    let details;
    try {
      details = await stat(this.runLockDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") return { owner: null, recoverable: true };
      throw error;
    }
    const lockTimestamp = Number(this.lockNow());
    if (!Number.isFinite(lockTimestamp)) {
      throw new Error("실행 잠금 시각이 올바르지 않습니다.");
    }
    // Filesystem mtime is written with the host wall clock. Keep stale-lock
    // recovery in that same clock domain even when durable trading timestamps
    // use a remote trusted clock.
    const age = Math.max(0, lockTimestamp - details.mtimeMs);
    return { owner: null, recoverable: age >= this.orphanGraceMs };
  }

  async recoverRunLock() {
    const inspection = await this.inspectRunLock();
    if (!inspection.recoverable) return false;
    const abandoned = path.join(
      this.directory,
      `.run.lock-abandoned-${this.pid}-${randomUUID()}`
    );
    try {
      await rename(this.runLockDirectory, abandoned);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      return false;
    }
    await rm(abandoned, { recursive: true, force: true });
    return true;
  }

  async acquireRunLock(metadata = {}) {
    await mkdir(this.directory, { recursive: true });
    const token = randomUUID();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await mkdir(this.runLockDirectory);
        try {
          await writeFile(
            this.runLockOwnerFile,
            JSON.stringify({
              ...metadata,
              token,
              pid: this.pid,
              createdAt: this.now().toISOString()
            }) + "\n",
            { encoding: "utf8", flag: "wx" }
          );
        } catch (error) {
          await rm(this.runLockDirectory, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          let owner;
          try {
            owner = JSON.parse(await readFile(this.runLockOwnerFile, "utf8"));
          } catch (error) {
            if (error?.code === "ENOENT") return;
            throw error;
          }
          if (owner?.token !== token) {
            throw new TradingRunLockedError("자동매매 실행 잠금 소유권이 변경되었습니다.");
          }
          const releasedDirectory = path.join(
            this.directory,
            `.run.lock-released-${this.pid}-${randomUUID()}`
          );
          await rename(this.runLockDirectory, releasedDirectory);
          await rm(releasedDirectory, { recursive: true, force: true });
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (!(await this.recoverRunLock())) throw new TradingRunLockedError();
      }
    }
    throw new TradingRunLockedError();
  }

  async withRunLock(work, metadata = {}) {
    const release = await this.acquireRunLock(metadata);
    try {
      return await work();
    } finally {
      await release();
    }
  }
}

export async function createTradingStateStore(directory, options) {
  return new TradingStateStore(directory, options).initialize();
}
