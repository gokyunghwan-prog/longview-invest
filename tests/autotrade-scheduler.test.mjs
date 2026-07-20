import test from "node:test";
import assert from "node:assert/strict";

import { TradingScheduler } from "../autotrade/scheduler.mjs";
import { UNATTENDED_LIVE_ACKNOWLEDGEMENT } from "../autotrade/config.mjs";

function config(overrides = {}) {
  return {
    mode: "paper",
    scheduler: {
      enabled: true,
      hourKst: 9,
      minuteKst: 20,
      unattendedLiveEnabled: false,
      ...overrides
    }
  };
}

test("평일 예정시각 이후 정규장 안에서 하루 한 번 실행한다", async () => {
  let calls = 0;
  const engine = { execute: async () => ({ ok: true, call: ++calls }) };
  const scheduler = new TradingScheduler(engine, config(), {
    now: () => new Date("2026-07-20T01:00:00.000Z")
  });
  assert.equal(scheduler.due(), true);
  await scheduler.check();
  await scheduler.check();
  assert.equal(calls, 1);
});

test("주말·예정시각 전·장 마감 뒤에는 실행하지 않는다", () => {
  const engine = { execute: async () => ({ ok: true }) };
  assert.equal(
    new TradingScheduler(engine, config(), {
      now: () => new Date("2026-07-19T01:00:00.000Z")
    }).due(),
    false
  );
  assert.equal(
    new TradingScheduler(engine, config(), {
      now: () => new Date("2026-07-20T00:00:00.000Z")
    }).due(),
    false
  );
  assert.equal(
    new TradingScheduler(engine, config(), {
      now: () => new Date("2026-07-20T06:30:00.000Z")
    }).due(),
    false
  );
});

test("로컬 paper만 저녁 갱신 뒤 자정 전까지 자동 실행할 수 있다", async () => {
  let calls = 0;
  const engine = { execute: async () => ({ ok: true, call: ++calls }) };
  const eveningConfig = {
    ...config({ hourKst: 21, minuteKst: 0 }),
    broker: "paper"
  };
  const scheduler = new TradingScheduler(engine, eveningConfig, {
    now: () => new Date("2026-07-20T13:00:00.000Z")
  });

  assert.equal(scheduler.due(), true, "KST 22시는 로컬 모의투자 catch-up 시간이다");
  await scheduler.check();
  await scheduler.check();
  assert.equal(calls, 1);

  const kisScheduler = new TradingScheduler(
    engine,
    { ...eveningConfig, broker: "kis" },
    { now: () => new Date("2026-07-20T13:00:00.000Z") }
  );
  assert.equal(kisScheduler.due(), false, "KIS 모의주문도 장후 자동 실행하지 않는다");
});

test("실전 스케줄러는 무인 실전 동의문까지 일치할 때만 실행 확인을 전달한다", async () => {
  const confirmations = [];
  const engine = {
    execute: async ({ liveConfirmation }) => {
      confirmations.push(liveConfirmation);
      return { ok: true };
    }
  };
  const liveConfig = {
    ...config({
      unattendedLiveEnabled: true,
      unattendedAcknowledgement: "wrong"
    }),
    mode: "live",
    broker: "kis"
  };
  await new TradingScheduler(engine, liveConfig, {
    now: () => new Date("2026-07-20T01:00:00.000Z")
  }).check();
  await new TradingScheduler(
    engine,
    {
      ...liveConfig,
      scheduler: {
        ...liveConfig.scheduler,
        unattendedAcknowledgement: UNATTENDED_LIVE_ACKNOWLEDGEMENT
      }
    },
    { now: () => new Date("2026-07-20T01:00:00.000Z") }
  ).check();
  assert.deepEqual(confirmations, [false, true]);
});
