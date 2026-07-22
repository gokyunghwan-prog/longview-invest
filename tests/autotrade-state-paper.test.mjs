import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PaperBroker } from "../autotrade/brokers/paper.mjs";
import {
  RUN_LOCK_DIRECTORY_NAME,
  createTradingStateStore
} from "../autotrade/state-store.mjs";

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "longview-autotrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createTradingStateStore(directory, { startingCashKrw: 1_000_000 });
  return { directory, store, broker: new PaperBroker(store, { feeRate: 0.001 }) };
}

const company = {
  id: "KR-005930",
  ticker: "005930",
  name: "테스트전자",
  country: "KR",
  exchange: "KOSPI",
  sector: "정보기술"
};

test("모의 브로커는 매수·평가·매도를 원자적으로 기록한다", async (t) => {
  const { directory, store, broker } = await setup(t);
  const buy = await broker.placeOrders([
    { ...company, side: "buy", quantity: 5, limitPrice: 100_000 }
  ]);
  assert.equal(buy[0].status, "filled");
  assert.equal(buy[0].feeKrw, 500);

  const account = await broker.getAccount(new Map([[company.id, 110_000]]));
  assert.equal(account.cashKrw, 499_500);
  assert.equal(account.totalEquityKrw, 1_049_500);
  assert.equal(account.positions[0].unrealizedProfitKrw, 50_000);

  const sell = await broker.placeOrders([
    { ...company, side: "sell", quantity: 2, limitPrice: 110_000 }
  ]);
  assert.equal(sell[0].status, "filled");
  assert.equal(store.snapshot().paper.positions[company.id].quantity, 3);
  assert.match(await readFile(path.join(directory, "audit.ndjson"), "utf8"), /paper_orders/);
});

test("현금이나 보유수량을 넘는 모의 주문은 상태 변경 없이 거부한다", async (t) => {
  const { store, broker } = await setup(t);
  const tooLarge = await broker.placeOrders([
    { ...company, side: "buy", quantity: 20, limitPrice: 100_000 }
  ]);
  assert.equal(tooLarge[0].status, "rejected");
  assert.equal(store.snapshot().paper.cashKrw, 1_000_000);

  const sell = await broker.placeOrders([
    { ...company, side: "sell", quantity: 1, limitPrice: 100_000 }
  ]);
  assert.equal(sell[0].status, "rejected");
  assert.deepEqual(store.snapshot().paper.positions, {});
});

test("기존 국내 장부의 legacy fxRateKrw 필드는 원화 평가에 영향 없이 읽는다", async (t) => {
  const { store, broker } = await setup(t);
  await store.update((state) => {
    state.paper.positions[company.id] = {
      ...company,
      currency: "KRW",
      quantity: 2,
      averagePrice: 100_000,
      lastPrice: 100_000,
      fxRateKrw: 1
    };
  });

  const account = await broker.getAccount(new Map([[company.id, { price: 110_000, fxRateKrw: 9 }]]));
  assert.equal(account.positionsValueKrw, 220_000);
  assert.equal(account.positions[0].unrealizedProfitKrw, 20_000);
  assert.equal("fxRateKrw" in account.positions[0], false);
  assert.equal(store.snapshot().paper.positions[company.id].fxRateKrw, 1);
});

test("상태 커밋 콜백이 끝나야 update가 완료된다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "longview-state-hook-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const committed = [];
  const store = await createTradingStateStore(directory, {
    startingCashKrw: 100_000,
    onStateCommitted: async (state, metadata) => {
      committed.push({ state, metadata });
    }
  });

  await store.update(
    (state) => {
      state.strategy.candidateCount = 3;
    },
    { type: "test_remote_checkpoint" }
  );

  assert.equal(committed.length, 1);
  assert.equal(committed[0].state.strategy.candidateCount, 3);
  assert.equal(committed[0].metadata.audit.type, "test_remote_checkpoint");
});

test("새 상태의 생성시각도 주입된 신뢰 시각으로 기록한다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "longview-state-clock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trustedNow = new Date("2026-07-22T10:23:45.500Z");
  const store = await createTradingStateStore(directory, {
    startingCashKrw: 100_000,
    now: () => new Date(trustedNow)
  });

  assert.equal(store.snapshot().createdAt, trustedNow.toISOString());
  assert.equal(store.snapshot().updatedAt, trustedNow.toISOString());
});

test("손상된 상태 파일은 조용히 초기화하지 않고 중단한다", async (t) => {
  const { directory } = await setup(t);
  const stateFile = path.join(directory, "state.json");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(stateFile, "{}", "utf8"));
  await assert.rejects(() => createTradingStateStore(directory), /형식/);
});

test("실행 잠금은 같은 상태 폴더의 동시 프로세스 실행을 차단한다", async (t) => {
  const { directory, store } = await setup(t);
  const second = await createTradingStateStore(directory);
  let secondEntered = false;

  await store.withRunLock(async () => {
    await assert.rejects(
      () => second.withRunLock(async () => {
        secondEntered = true;
      }),
      /이미 진행 중/
    );
  });
  assert.equal(secondEntered, false);

  await second.withRunLock(async () => {
    secondEntered = true;
  });
  assert.equal(secondEntered, true);
});

test("종료된 프로세스가 남긴 실행 잠금만 안전하게 회수한다", async (t) => {
  const { directory } = await setup(t);
  const lockDirectory = path.join(directory, RUN_LOCK_DIRECTORY_NAME);
  await mkdir(lockDirectory);
  await writeFile(
    path.join(lockDirectory, "owner.json"),
    JSON.stringify({ token: "dead-owner", pid: 424242, createdAt: new Date().toISOString() }),
    "utf8"
  );
  const recoveryStore = await createTradingStateStore(directory, {
    pid: 525252,
    isProcessAlive: () => false
  });
  let entered = false;
  await recoveryStore.withRunLock(async () => {
    entered = true;
  });
  assert.equal(entered, true);
});

test("원격 신뢰 시각과 파일시각이 달라도 새 잠금을 오래된 것으로 오판하지 않는다", async (t) => {
  const { directory } = await setup(t);
  const lockDirectory = path.join(directory, RUN_LOCK_DIRECTORY_NAME);
  await mkdir(lockDirectory);
  const details = await stat(lockDirectory);
  const store = await createTradingStateStore(directory, {
    now: () => new Date(details.mtimeMs + 7 * 60 * 60 * 1_000),
    lockNow: () => details.mtimeMs + 100,
    orphanGraceMs: 1_000
  });

  const inspection = await store.inspectRunLock();
  assert.equal(inspection.owner, null);
  assert.equal(inspection.recoverable, false);
});
