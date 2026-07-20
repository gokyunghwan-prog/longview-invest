import path from "node:path";

import { ROOT_DIR, loadLocalEnv } from "../lib/config.mjs";
import {
  DEFAULT_INVESTMENT_SELECTION_POLICY,
  INVESTMENT_SELECTION_STRATEGY_VERSION
} from "../lib/investment-selection.mjs";

export const LIVE_ACKNOWLEDGEMENT = "I_UNDERSTAND_LIVE_TRADING_RISK";
export const UNATTENDED_LIVE_ACKNOWLEDGEMENT =
  "I_ACCEPT_UNATTENDED_LIVE_TRADING_RISK";
export const USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACKNOWLEDGEMENT =
  "I_ACCEPT_USING_ALL_DEDICATED_ACCOUNT_ASSETS";

const MINIMUM_LIVE_DAILY_DRIFT = 0.01;
const MINIMUM_LIVE_DAILY_REMOVAL_CONFIRMATIONS = 2;
const MINIMUM_LIVE_DAILY_REPLACEMENT_SCORE_LEAD = 1;

const MODES = new Set(["disabled", "paper", "live"]);
const BROKERS = new Set(["paper", "kis"]);
const KIS_ENVIRONMENTS = new Set(["vps", "prod"]);
const REBALANCE_FREQUENCIES = new Set(["daily", "monthly"]);

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function boolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("불리언 설정값은 true 또는 false여야 합니다: " + value);
}

function number(value, fallback, { minimum = -Infinity, maximum = Infinity } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`숫자 설정값은 ${minimum} 이상 ${maximum} 이하여야 합니다: ${value}`);
  }
  return parsed;
}

function integer(value, fallback, limits = {}) {
  const parsed = number(value, fallback, limits);
  if (!Number.isInteger(parsed)) throw new Error("정수 설정값이 필요합니다: " + value);
  return parsed;
}

function enumValue(value, fallback, allowed, label) {
  const normalized = text(value, fallback).toLowerCase();
  if (!allowed.has(normalized)) {
    throw new Error(`${label} 설정값이 올바르지 않습니다: ${normalized}`);
  }
  return normalized;
}

function validateAccount(value) {
  const normalized = text(value);
  if (normalized && !/^\d{8}$/.test(normalized)) {
    throw new Error("KIS_ACCOUNT_NUMBER는 계좌번호 앞 8자리여야 합니다.");
  }
  return normalized;
}

function validateProduct(value) {
  const normalized = text(value, "01");
  if (!/^\d{2}$/.test(normalized)) {
    throw new Error("KIS_ACCOUNT_PRODUCT_CODE는 계좌번호 뒤 2자리여야 합니다.");
  }
  return normalized;
}

export function getTradingConfig({ env = process.env, rootDir = ROOT_DIR, loadEnv = true } = {}) {
  if (loadEnv && env === process.env) loadLocalEnv();

  const mode = enumValue(env.TRADING_MODE, "disabled", MODES, "TRADING_MODE");
  const broker = enumValue(env.TRADING_BROKER, "paper", BROKERS, "TRADING_BROKER");
  const kisEnvironment = enumValue(env.KIS_ENV, "vps", KIS_ENVIRONMENTS, "KIS_ENV");
  const minimumPositions = integer(env.TRADING_MIN_POSITIONS, 3, { minimum: 2, maximum: 30 });
  const maximumPositions = integer(env.TRADING_MAX_POSITIONS, 5, {
    minimum: minimumPositions,
    maximum: 30
  });
  const reserveWeight = number(env.TRADING_CASH_RESERVE_PERCENT, 0, {
    minimum: 0,
    maximum: 50
  }) / 100;
  const maximumPositionWeight = number(env.TRADING_MAX_POSITION_PERCENT, 35, {
    minimum: 1,
    maximum: 50
  }) / 100;
  const maximumSectorWeight = number(env.TRADING_MAX_SECTOR_PERCENT, 35, {
    minimum: 5,
    maximum: 100
  }) / 100;
  const investableWeight = 1 - reserveWeight;
  if (maximumPositions * maximumPositionWeight + 1e-12 < investableWeight) {
    throw new Error(
      "TRADING_MAX_POSITIONS와 TRADING_MAX_POSITION_PERCENT 조합으로 투자 가능 금액을 전액 배분할 수 없습니다."
    );
  }

  const config = {
    rootDir,
    mode,
    broker,
    host: text(env.TRADING_HOST, "127.0.0.1"),
    port: integer(env.TRADING_PORT, 4180, { minimum: 1, maximum: 65_535 }),
    stateDir: path.join(rootDir, ".autotrade"),
    longview: {
      baseUrl: text(env.LONGVIEW_BASE_URL, "http://127.0.0.1:4173"),
      timeoutMs: integer(env.LONGVIEW_TIMEOUT_MS, 10_000, {
        minimum: 1_000,
        maximum: 120_000
      }),
      requirePublishedSelection: boolean(env.TRADING_REQUIRE_PUBLISHED_SELECTION, true),
      selectionPolicy: DEFAULT_INVESTMENT_SELECTION_POLICY
    },
    countries: ["KR"],
    strategy: {
      version: INVESTMENT_SELECTION_STRATEGY_VERSION,
      rebalanceFrequency: enumValue(
        env.TRADING_REBALANCE_FREQUENCY,
        "monthly",
        REBALANCE_FREQUENCIES,
        "TRADING_REBALANCE_FREQUENCY"
      ),
      approvedModelVersion: text(env.TRADING_APPROVED_MODEL_VERSION, "2.0.0"),
      minimumScore: number(env.TRADING_MIN_SCORE, 78, { minimum: 0, maximum: 100 }),
      minimumConfidence: number(env.TRADING_MIN_CONFIDENCE, 85, {
        minimum: 0,
        maximum: 100
      }),
      minimumCompleteness: number(env.TRADING_MIN_COMPLETENESS, 85, {
        minimum: 0,
        maximum: 100
      }),
      minimumValuationConfidence: number(env.TRADING_MIN_VALUATION_CONFIDENCE, 75, {
        minimum: 0,
        maximum: 100
      }),
      minimumPositions,
      maximumPositions,
      reserveWeight,
      maximumPositionWeight,
      maximumSectorWeight,
      minimumMarketCapKrw: number(env.TRADING_MIN_MARKET_CAP_KRW, 100_000_000_000, {
        minimum: 0
      }),
      minimumDailyTurnoverKrw: number(env.TRADING_MIN_DAILY_TURNOVER_KRW, 500_000_000, {
        minimum: 0
      }),
      minimumPositionKrw: number(env.TRADING_MIN_POSITION_KRW, 20_000, { minimum: 1 }),
      minimumOrderKrw: number(env.TRADING_MIN_ORDER_KRW, 5_000, { minimum: 1 }),
      maximumSnapshotAgeDays: integer(env.TRADING_MAX_SNAPSHOT_AGE_DAYS, 3, {
        minimum: 0,
        maximum: 30
      }),
      rebalanceDrift: number(env.TRADING_REBALANCE_DRIFT_PERCENT, 3, {
        minimum: 0,
        maximum: 50
      }) / 100,
      removalConfirmations: integer(env.TRADING_REMOVAL_CONFIRMATIONS, 2, {
        minimum: 1,
        maximum: 30
      }),
      replacementScoreLead: number(env.TRADING_REPLACEMENT_SCORE_LEAD, 3, {
        minimum: 0,
        maximum: 25
      })
    },
    risk: {
      maximumOrdersPerRun: integer(env.TRADING_MAX_ORDERS_PER_RUN, 20, {
        minimum: 1,
        maximum: 100
      }),
      maximumTurnoverWeight: number(env.TRADING_MAX_TURNOVER_PERCENT, 10, {
        minimum: 1,
        maximum: 100
      }) / 100,
      initialDeploymentTurnoverWeight: number(
        env.TRADING_INITIAL_DEPLOYMENT_TURNOVER_PERCENT,
        100,
        { minimum: 1, maximum: 100 }
      ) / 100,
      maximumPriceAgeDays: integer(env.TRADING_MAX_PRICE_AGE_DAYS, 10, {
        minimum: 0,
        maximum: 30
      }),
      limitPriceBuffer: number(env.TRADING_LIMIT_BUFFER_PERCENT, 0.5, {
        minimum: 0,
        maximum: 5
      }) / 100,
      maximumSignalPriceDeviation: number(env.TRADING_MAX_SIGNAL_PRICE_DEVIATION_PERCENT, 10, {
        minimum: 0,
        maximum: 100
      }) / 100,
      capitalLimitKrw: number(env.TRADING_CAPITAL_LIMIT_KRW, 0, { minimum: 0 }),
      requireDedicatedAccount: boolean(env.TRADING_REQUIRE_DEDICATED_ACCOUNT, true)
    },
    paper: {
      startingCashKrw: number(env.PAPER_STARTING_CASH_KRW, 10_000_000, { minimum: 1 }),
      feeRate: number(env.PAPER_FEE_PERCENT, 0.02, { minimum: 0, maximum: 5 }) / 100
    },
    scheduler: {
      enabled: boolean(env.TRADING_AUTORUN_ENABLED, false),
      hourKst: integer(env.TRADING_AUTORUN_HOUR_KST, 9, { minimum: 0, maximum: 23 }),
      minuteKst: integer(env.TRADING_AUTORUN_MINUTE_KST, 20, { minimum: 0, maximum: 59 }),
      unattendedLiveEnabled: boolean(env.ENABLE_UNATTENDED_LIVE_TRADING, false),
      unattendedAcknowledgement: text(env.UNATTENDED_LIVE_TRADING_ACK)
    },
    kis: {
      environment: kisEnvironment,
      appKey: text(env.KIS_APP_KEY),
      appSecret: text(env.KIS_APP_SECRET),
      accountNumber: validateAccount(env.KIS_ACCOUNT_NUMBER),
      productCode: validateProduct(env.KIS_ACCOUNT_PRODUCT_CODE),
      htsId: text(env.KIS_HTS_ID),
      productionUrl: "https://openapi.koreainvestment.com:9443",
      virtualUrl: "https://openapivts.koreainvestment.com:29443"
    },
    live: {
      enabled: boolean(env.ENABLE_LIVE_TRADING, false),
      acknowledgement: text(env.LIVE_TRADING_ACK),
      useAllDedicatedAccountAssets: boolean(
        env.TRADING_USE_ALL_DEDICATED_ACCOUNT_ASSETS,
        false
      ),
      useAllDedicatedAccountAssetsAcknowledgement: text(
        env.USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACK
      )
    }
  };

  if (mode === "live") {
    if (broker !== "kis" || kisEnvironment !== "prod") {
      throw new Error("실전 모드는 TRADING_BROKER=kis와 KIS_ENV=prod가 필요합니다.");
    }
    if (!config.live.enabled || config.live.acknowledgement !== LIVE_ACKNOWLEDGEMENT) {
      throw new Error("실전 주문 잠금이 해제되지 않았습니다.");
    }
    if (!config.risk.requireDedicatedAccount) {
      throw new Error("실전 모드는 자동매매 전용 계좌 설정이 필요합니다.");
    }
    if (
      config.risk.capitalLimitKrw === 0 &&
      (!config.live.useAllDedicatedAccountAssets ||
        config.live.useAllDedicatedAccountAssetsAcknowledgement !==
          USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACKNOWLEDGEMENT)
    ) {
      throw new Error(
        "실전에서 투자금 상한 없이 전용계좌 전체 관리자산을 사용하려면 별도 전체자산 잠금을 해제해야 합니다."
      );
    }
    if (!config.longview.requirePublishedSelection) {
      throw new Error("실전 모드는 웹사이트와 동일한 공개 투자선정 산출물이 필요합니다.");
    }
    const publishedPolicy = config.longview.selectionPolicy;
    const configuredPolicy = {
      version: config.strategy.version,
      countries: config.countries,
      minimumPositions: config.strategy.minimumPositions,
      maximumPositions: config.strategy.maximumPositions,
      targetCashWeight: config.strategy.reserveWeight,
      maximumPositionWeight: config.strategy.maximumPositionWeight,
      maximumSectorWeight: config.strategy.maximumSectorWeight,
      minimumPositionKrw: config.strategy.minimumPositionKrw,
      minimumOrderKrw: config.strategy.minimumOrderKrw,
      minimumScore: config.strategy.minimumScore,
      minimumConfidence: config.strategy.minimumConfidence,
      minimumCompleteness: config.strategy.minimumCompleteness,
      minimumValuationConfidence: config.strategy.minimumValuationConfidence,
      minimumMarketCapKrw: config.strategy.minimumMarketCapKrw,
      minimumDailyTurnoverKrw: config.strategy.minimumDailyTurnoverKrw,
      maximumPriceAgeDays: config.risk.maximumPriceAgeDays
    };
    for (const [key, value] of Object.entries(configuredPolicy)) {
      if (JSON.stringify(value) !== JSON.stringify(publishedPolicy[key])) {
        throw new Error(`실전 설정 ${key} 값이 웹사이트 투자선정 정책과 일치하지 않습니다.`);
      }
    }
    if (
      config.strategy.rebalanceFrequency === "daily" &&
      config.strategy.rebalanceDrift < MINIMUM_LIVE_DAILY_DRIFT
    ) {
      throw new Error("실전 일간 리밸런싱은 최소 1%의 비중 이탈 기준이 필요합니다.");
    }
    if (
      config.strategy.rebalanceFrequency === "daily" &&
      config.strategy.removalConfirmations < MINIMUM_LIVE_DAILY_REMOVAL_CONFIRMATIONS
    ) {
      throw new Error("실전 일간 리밸런싱은 종목 제외 신호를 최소 2회 확인해야 합니다.");
    }
    if (
      config.strategy.rebalanceFrequency === "daily" &&
      config.strategy.replacementScoreLead < MINIMUM_LIVE_DAILY_REPLACEMENT_SCORE_LEAD
    ) {
      throw new Error("실전 일간 리밸런싱은 교체 후보의 점수가 최소 1점 앞서야 합니다.");
    }
  }
  if (
    config.scheduler.enabled &&
    mode === "live" &&
    (!config.scheduler.unattendedLiveEnabled ||
      config.scheduler.unattendedAcknowledgement !== UNATTENDED_LIVE_ACKNOWLEDGEMENT)
  ) {
    throw new Error("무인 실전 주문 잠금이 해제되지 않았습니다.");
  }
  if (broker === "kis" && mode !== "disabled") {
    if (!config.kis.appKey || !config.kis.appSecret || !config.kis.accountNumber) {
      throw new Error("KIS 사용에는 App Key, App Secret, 계좌번호가 필요합니다.");
    }
    if (mode === "paper" && kisEnvironment === "prod") {
      throw new Error("paper 모드에서는 KIS_ENV=vps만 허용합니다.");
    }
  }

  return config;
}

export function publicTradingConfig(config) {
  return {
    mode: config.mode,
    broker: config.broker,
    host: config.host,
    port: config.port,
    longviewBaseUrl: config.longview.baseUrl,
    countries: config.countries,
    strategy: config.strategy,
    risk: config.risk,
    scheduler: {
      enabled: config.scheduler.enabled,
      hourKst: config.scheduler.hourKst,
      minuteKst: config.scheduler.minuteKst,
      unattendedLiveEnabled: config.scheduler.unattendedLiveEnabled
    },
    kis: {
      environment: config.kis.environment,
      configured: Boolean(
        config.kis.appKey && config.kis.appSecret && config.kis.accountNumber
      )
    },
    liveOrderLocked: !(
      config.mode === "live" &&
      config.live.enabled &&
      config.live.acknowledgement === LIVE_ACKNOWLEDGEMENT
    ),
    useAllDedicatedAccountAssetsUnlocked:
      config.mode === "live" &&
      config.risk.capitalLimitKrw === 0 &&
      config.risk.requireDedicatedAccount &&
      config.live.useAllDedicatedAccountAssets &&
      config.live.useAllDedicatedAccountAssetsAcknowledgement ===
        USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACKNOWLEDGEMENT,
    unattendedLiveOrderLocked: !(
      config.mode === "live" &&
      config.scheduler.enabled &&
      config.scheduler.unattendedLiveEnabled &&
      config.scheduler.unattendedAcknowledgement === UNATTENDED_LIVE_ACKNOWLEDGEMENT
    )
  };
}
