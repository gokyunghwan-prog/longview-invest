import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  LIVE_ACKNOWLEDGEMENT,
  UNATTENDED_LIVE_ACKNOWLEDGEMENT,
  USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACKNOWLEDGEMENT,
  getTradingConfig,
  publicTradingConfig
} from "../autotrade/config.mjs";

const ROOT = path.resolve("C:/longview-test");

function config(env = {}) {
  return getTradingConfig({ env, rootDir: ROOT, loadEnv: false });
}

test("자동매매는 기본적으로 비활성·로컬 모의 브로커다", () => {
  const result = config();
  assert.equal(result.mode, "disabled");
  assert.equal(result.broker, "paper");
  assert.equal(result.port, 4180);
  assert.deepEqual(result.countries, ["KR"]);
  assert.equal(result.strategy.minimumScore, 78);
  assert.equal(result.strategy.rebalanceFrequency, "monthly");
  assert.equal(result.strategy.replacementScoreLead, 3);
  assert.equal(result.strategy.minimumPositions, 3);
  assert.equal(result.strategy.maximumPositions, 5);
  assert.equal(result.strategy.reserveWeight, 0);
  assert.equal(result.strategy.maximumPositionWeight, 0.35);
  assert.equal(result.strategy.maximumSectorWeight, 0.35);
  assert.equal(result.strategy.minimumPositionKrw, 20_000);
  assert.equal(result.strategy.minimumOrderKrw, 5_000);
  assert.equal(result.longview.requirePublishedSelection, true);
  assert.equal(result.risk.deployAvailableCash, false);
  assert.equal(result.risk.maximumTurnoverWeight, 0.1);
  assert.equal(result.risk.initialDeploymentTurnoverWeight, 1);
  assert.equal(result.strategy.minimumMarketCapKrw, 100_000_000_000);
  assert.equal(result.strategy.minimumDailyTurnoverKrw, 500_000_000);
});

test("zero-cash allocation rejects mathematically impossible caps", () => {
  assert.throws(
    () =>
      config({
        TRADING_MIN_POSITIONS: "7",
        TRADING_MAX_POSITIONS: "7",
        TRADING_CASH_RESERVE_PERCENT: "0",
        TRADING_MAX_POSITION_PERCENT: "7"
      }),
    /전액 배분/
  );
});

test("실전 모드는 KIS prod와 이중 잠금 없이는 시작하지 않는다", () => {
  const base = {
    TRADING_MODE: "live",
    TRADING_BROKER: "kis",
    KIS_ENV: "prod",
    KIS_APP_KEY: "app",
    KIS_APP_SECRET: "secret",
    KIS_ACCOUNT_NUMBER: "12345678",
    TRADING_CAPITAL_LIMIT_KRW: "1000000"
  };
  assert.throws(() => config(base), /잠금/);
  assert.throws(
    () => config({ ...base, ENABLE_LIVE_TRADING: "true", LIVE_TRADING_ACK: "wrong" }),
    /잠금/
  );
  const enabled = config({
    ...base,
    ENABLE_LIVE_TRADING: "true",
    LIVE_TRADING_ACK: LIVE_ACKNOWLEDGEMENT
  });
  assert.equal(enabled.mode, "live");
  assert.equal(publicTradingConfig(enabled).liveOrderLocked, false);
  assert.equal("appSecret" in publicTradingConfig(enabled).kis, false);
  assert.throws(
    () =>
      config({
        ...base,
        ENABLE_LIVE_TRADING: "true",
        LIVE_TRADING_ACK: LIVE_ACKNOWLEDGEMENT,
        TRADING_REQUIRE_DEDICATED_ACCOUNT: "false"
      }),
    /전용 계좌/
  );
});

test("실전에서 상한 0은 전용계좌 전체자산 별도 잠금이 모두 맞아야 허용한다", () => {
  const base = {
    TRADING_MODE: "live",
    TRADING_BROKER: "kis",
    KIS_ENV: "prod",
    KIS_APP_KEY: "app",
    KIS_APP_SECRET: "secret",
    KIS_ACCOUNT_NUMBER: "12345678",
    TRADING_CAPITAL_LIMIT_KRW: "0",
    TRADING_REQUIRE_DEDICATED_ACCOUNT: "true",
    ENABLE_LIVE_TRADING: "true",
    LIVE_TRADING_ACK: LIVE_ACKNOWLEDGEMENT
  };

  assert.throws(() => config(base), /전체자산 잠금/);
  assert.throws(
    () =>
      config({
        ...base,
        TRADING_USE_ALL_DEDICATED_ACCOUNT_ASSETS: "true",
        USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACK: "wrong"
      }),
    /전체자산 잠금/
  );
  assert.throws(
    () =>
      config({
        ...base,
        TRADING_REQUIRE_DEDICATED_ACCOUNT: "false",
        TRADING_USE_ALL_DEDICATED_ACCOUNT_ASSETS: "true",
        USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACK:
          USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACKNOWLEDGEMENT
      }),
    /전용 계좌/
  );

  const enabled = config({
    ...base,
    TRADING_USE_ALL_DEDICATED_ACCOUNT_ASSETS: "true",
    USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACK:
      USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACKNOWLEDGEMENT
  });
  assert.equal(enabled.risk.capitalLimitKrw, 0);
  assert.equal(enabled.live.useAllDedicatedAccountAssets, true);
  assert.equal(
    publicTradingConfig(enabled).useAllDedicatedAccountAssetsUnlocked,
    true
  );
  assert.equal(
    "useAllDedicatedAccountAssetsAcknowledgement" in publicTradingConfig(enabled),
    false
  );
});

test("실전 가용현금 자동투입은 현금 0%와 전용계좌 전체자산 잠금을 요구한다", () => {
  const base = {
    TRADING_MODE: "live",
    TRADING_BROKER: "kis",
    KIS_ENV: "prod",
    KIS_APP_KEY: "app",
    KIS_APP_SECRET: "secret",
    KIS_ACCOUNT_NUMBER: "12345678",
    TRADING_CAPITAL_LIMIT_KRW: "0",
    TRADING_REQUIRE_DEDICATED_ACCOUNT: "true",
    ENABLE_LIVE_TRADING: "true",
    LIVE_TRADING_ACK: LIVE_ACKNOWLEDGEMENT,
    TRADING_AUTODEPLOY_CASH: "true",
    TRADING_USE_ALL_DEDICATED_ACCOUNT_ASSETS: "true",
    USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACK:
      USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACKNOWLEDGEMENT
  };

  const enabled = config(base);
  assert.equal(enabled.risk.deployAvailableCash, true);

  assert.throws(
    () => config({ ...base, TRADING_CASH_RESERVE_PERCENT: "5" }),
    /목표 현금 비중이 0%/
  );
  assert.throws(
    () => config({ ...base, TRADING_CAPITAL_LIMIT_KRW: "1000000" }),
    /전용계좌 전체자산 모드/
  );
  assert.throws(
    () =>
      config({
        ...base,
        TRADING_USE_ALL_DEDICATED_ACCOUNT_ASSETS: "false",
        USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACK: ""
      }),
    /전체자산 별도 잠금/
  );
});

test("모의 모드가 실전 KIS 키를 사용하는 설정은 거부한다", () => {
  assert.throws(
    () =>
      config({
        TRADING_MODE: "paper",
        TRADING_BROKER: "kis",
        KIS_ENV: "prod",
        KIS_APP_KEY: "app",
        KIS_APP_SECRET: "secret",
        KIS_ACCOUNT_NUMBER: "12345678"
      }),
    /vps/
  );
});

test("일간 리밸런싱은 실전에서도 안전 기준과 잠금을 갖추면 켤 수 있다", () => {
  const paper = config({
    TRADING_MODE: "paper",
    TRADING_REBALANCE_FREQUENCY: "daily"
  });
  assert.equal(paper.strategy.rebalanceFrequency, "daily");

  const live = config({
    TRADING_MODE: "live",
    TRADING_BROKER: "kis",
    KIS_ENV: "prod",
    KIS_APP_KEY: "app",
    KIS_APP_SECRET: "secret",
    KIS_ACCOUNT_NUMBER: "12345678",
    TRADING_CAPITAL_LIMIT_KRW: "1000000",
    ENABLE_LIVE_TRADING: "true",
    LIVE_TRADING_ACK: LIVE_ACKNOWLEDGEMENT,
    TRADING_REBALANCE_FREQUENCY: "daily"
  });
  assert.equal(live.strategy.rebalanceFrequency, "daily");
});

test("실전 일간 리밸런싱은 의미 있는 이탈·제외·교체 기준을 낮출 수 없다", () => {
  const base = {
    TRADING_MODE: "live",
    TRADING_BROKER: "kis",
    KIS_ENV: "prod",
    KIS_APP_KEY: "app",
    KIS_APP_SECRET: "secret",
    KIS_ACCOUNT_NUMBER: "12345678",
    TRADING_CAPITAL_LIMIT_KRW: "1000000",
    ENABLE_LIVE_TRADING: "true",
    LIVE_TRADING_ACK: LIVE_ACKNOWLEDGEMENT,
    TRADING_REBALANCE_FREQUENCY: "daily"
  };
  assert.throws(
    () => config({ ...base, TRADING_REBALANCE_DRIFT_PERCENT: "0" }),
    /최소 1%/
  );
  assert.throws(
    () => config({ ...base, TRADING_REMOVAL_CONFIRMATIONS: "1" }),
    /최소 2회/
  );
  assert.throws(
    () => config({ ...base, TRADING_REPLACEMENT_SCORE_LEAD: "0" }),
    /최소 1점/
  );
});

test("무인 실전 스케줄은 별도 동의문 없이는 시작하지 않는다", () => {
  const base = {
    TRADING_MODE: "live",
    TRADING_BROKER: "kis",
    KIS_ENV: "prod",
    KIS_APP_KEY: "app",
    KIS_APP_SECRET: "secret",
    KIS_ACCOUNT_NUMBER: "12345678",
    TRADING_CAPITAL_LIMIT_KRW: "1000000",
    ENABLE_LIVE_TRADING: "true",
    LIVE_TRADING_ACK: LIVE_ACKNOWLEDGEMENT,
    TRADING_REBALANCE_FREQUENCY: "daily",
    TRADING_AUTORUN_ENABLED: "true",
    ENABLE_UNATTENDED_LIVE_TRADING: "true"
  };
  assert.throws(() => config(base), /무인 실전 주문 잠금/);
  const enabled = config({
    ...base,
    UNATTENDED_LIVE_TRADING_ACK: UNATTENDED_LIVE_ACKNOWLEDGEMENT
  });
  assert.equal(enabled.scheduler.enabled, true);
  assert.equal(enabled.scheduler.unattendedLiveEnabled, true);
  assert.equal(publicTradingConfig(enabled).unattendedLiveOrderLocked, false);
  assert.equal("unattendedAcknowledgement" in publicTradingConfig(enabled).scheduler, false);
});

test("계좌 형식과 포트폴리오 한도를 검증한다", () => {
  assert.throws(() => config({ KIS_ACCOUNT_NUMBER: "123" }), /8자리/);
  assert.throws(
    () => config({ TRADING_MIN_POSITIONS: "12", TRADING_MAX_POSITIONS: "10" }),
    /숫자 설정값/
  );
});
