import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";

import { LongviewClient } from "./longview-client.mjs";
import { planMonthlyRebalance } from "./planner.mjs";
import { orderStatusIsTerminal, reconcileOrderIntents } from "./reconciliation.mjs";
import {
  assessOrders,
  assessSignal,
  buildCycleKey,
  candidateCountForSignal,
  redactSensitive
} from "./risk.mjs";
import {
  portfolioSecurityKey,
  selectBalancedPortfolio,
  selectPublishedPortfolio
} from "./strategy.mjs";
import { createTradingStateStore } from "./state-store.mjs";
import { PaperBroker } from "./brokers/paper.mjs";
import { KisBroker } from "./brokers/kis.mjs";

const PENDING_MANAGEMENT_MAX_AGE_MS = 7 * 86_400_000;
const LIVE_ORDER_WINDOW_START_MINUTE_KST = 9 * 60 + 5;
const LIVE_ORDER_WINDOW_END_MINUTE_KST = 14 * 60 + 50;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function kstTradingClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("현재 시각이 올바르지 않습니다.");
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return {
    businessDate: `${parts.year}${parts.month}${parts.day}`,
    weekday: parts.weekday,
    minute: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function normalizedTimeBounds(value, fallback) {
  const source = value && typeof value === "object"
    ? value
    : { earliest: fallback, latest: fallback };
  const earliest = source.earliest instanceof Date
    ? new Date(source.earliest)
    : new Date(source.earliest ?? fallback);
  const latest = source.latest instanceof Date
    ? new Date(source.latest)
    : new Date(source.latest ?? fallback);
  if (
    Number.isNaN(earliest.getTime()) ||
    Number.isNaN(latest.getTime()) ||
    earliest.getTime() > latest.getTime()
  ) {
    const error = new Error("신뢰 시각 범위가 올바르지 않아 실전 주문을 중단했습니다.");
    error.code = "TRUSTED_CLOCK_BOUNDS_INVALID";
    throw error;
  }
  return { earliest, latest };
}

export function liveOrderWindowBoundsAreOpen(bounds) {
  const earliest = kstTradingClock(bounds.earliest);
  const latest = kstTradingClock(bounds.latest);
  return (
    earliest.businessDate === latest.businessDate &&
    !["Sat", "Sun"].includes(earliest.weekday) &&
    !["Sat", "Sun"].includes(latest.weekday) &&
    earliest.minute >= LIVE_ORDER_WINDOW_START_MINUTE_KST &&
    latest.minute <= LIVE_ORDER_WINDOW_END_MINUTE_KST
  );
}

function rebalancePeriodKst(now, frequency = "monthly") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
  return frequency === "daily"
    ? `${values.year}-${values.month}-${values.day}`
    : `${values.year}-${values.month}`;
}

function accountIdentity(config) {
  const raw =
    config.broker === "paper"
      ? "paper"
      : `${config.kis.environment}:${config.kis.accountNumber}:${config.kis.productCode}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function normalizedCycleScope(value) {
  const scope = String(value || "").trim();
  if (!scope) return "";
  if (!/^[a-z0-9][a-z0-9:._-]{7,95}$/i.test(scope)) {
    throw new TypeError("수동 실행 식별자 형식이 올바르지 않습니다.");
  }
  return scope;
}

function quoteKey(company) {
  return `${String(company.country || "").toUpperCase()}:${String(company.ticker || "").toUpperCase()}`;
}

function securityMetadata(source = {}) {
  return {
    id: source.id,
    ticker: source.ticker,
    country: source.country,
    exchange: source.exchange,
    name: source.name,
    sector: source.sector
  };
}

function positionQuantityMap(positions = []) {
  return new Map(
    positions.map((position) => [
      portfolioSecurityKey(position),
      finite(Number(position.quantity)) || 0
    ])
  );
}

function brokerRows(result, label) {
  const rows = Array.isArray(result) ? result : result?.orders;
  if (!Array.isArray(rows)) throw new TypeError(`${label} 응답에 주문 배열이 없습니다.`);
  return rows;
}

function sameBrokerOrder(left, right) {
  return (
    String(left?.brokerOrderId || "").trim() === String(right?.brokerOrderId || "").trim() &&
    String(left?.branchNumber || "").trim() === String(right?.branchNumber || "").trim() &&
    String(left?.ticker || "").trim() === String(right?.ticker || "").trim()
  );
}

function orderStatusCounts(orders = []) {
  const counts = {};
  for (const order of orders) {
    const status = String(order?.status || "unknown").toLowerCase();
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function orderCheckpointId(cycleKey, index, order) {
  return createHash("sha256")
    .update([
      "longview-order-v1",
      cycleKey,
      String(index),
      String(order?.country || ""),
      String(order?.ticker || ""),
      String(order?.side || ""),
      String(order?.quantity || ""),
      String(order?.limitPrice || "")
    ].join("\0"))
    .digest("hex")
    .slice(0, 24);
}

function pendingManagementIsFresh(pending, now) {
  const submittedAt = Date.parse(pending?.submittedAt || "");
  const age = now.getTime() - submittedAt;
  return Number.isFinite(submittedAt) && age >= 0 && age <= PENDING_MANAGEMENT_MAX_AGE_MS;
}

function rebuildManagedSecurities(state, account, orders) {
  const previous = state.strategy.managedSecurities || {};
  const positions = Array.isArray(account?.positions) ? account.positions : [];
  const confirmedBuys = new Map();
  for (const order of orders || []) {
    if (String(order?.side || "").toLowerCase() !== "buy") continue;
    if (!["filled", "partial_canceled"].includes(String(order?.status || "").toLowerCase())) {
      continue;
    }
    const filledQuantity = finite(Number(order.filledQuantity));
    if (filledQuantity !== null && filledQuantity <= 0) continue;
    confirmedBuys.set(portfolioSecurityKey(order), order);
  }

  const rebuilt = {};
  for (const position of positions) {
    const quantity = finite(Number(position?.quantity));
    if (quantity === null || quantity <= 0) continue;
    const key = portfolioSecurityKey(position);
    const prior = previous[key];
    if (prior) {
      rebuilt[key] = securityMetadata({ ...position, ...prior });
      continue;
    }
    const buy = confirmedBuys.get(key);
    const baseline = finite(Number(buy?.baselineQuantity));
    if (!buy || baseline === null || quantity <= baseline) continue;
    rebuilt[key] = securityMetadata({ ...position, ...buy });
  }
  return rebuilt;
}

function normalizeBrokerQuotes(value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (Array.isArray(value)) {
    const entries = {};
    for (const quote of value) {
      if (!quote || typeof quote !== "object") continue;
      if (quote.id) entries[quote.id] = quote;
      if (quote.ticker) {
        entries[String(quote.ticker).toUpperCase()] = quote;
        entries[`${String(quote.country || "").toUpperCase()}:${String(quote.ticker).toUpperCase()}`] = quote;
      }
    }
    return entries;
  }
  return value && typeof value === "object" ? value : {};
}

function mergeExecutionQuotes(
  signal,
  brokerQuotes,
  maximumDeviation,
  requireBrokerQuotes = false,
  expectedMarketDate = null
) {
  const merged = {};
  const issues = [];
  const liveQuotes = normalizeBrokerQuotes(brokerQuotes);
  for (const company of signal.companies) {
    const research = signal.quotes?.[company.id] || company.marketData || null;
    const live = liveQuotes[company.id] || liveQuotes[quoteKey(company)] || liveQuotes[company.ticker];
    if (!live) {
      merged[company.id] = requireBrokerQuotes
        ? { ...(research || {}), current: false, freshness: "blocked" }
        : research;
      if (requireBrokerQuotes) {
        issues.push({ id: company.id, code: "broker_price_missing", deviation: null });
      }
      continue;
    }
    if (
      expectedMarketDate &&
      String(live.marketDate || "").trim() !== expectedMarketDate
    ) {
      merged[company.id] = {
        ...(research || {}),
        ...(live || {}),
        current: false,
        freshness: "blocked"
      };
      issues.push({
        id: company.id,
        code: "broker_market_date_stale",
        deviation: null
      });
      continue;
    }
    const researchPrice = finite(Number(research?.price));
    const livePrice = finite(Number(live?.price));
    const deviation =
      researchPrice && livePrice ? Math.abs(livePrice / researchPrice - 1) : Infinity;
    if (!livePrice || deviation > maximumDeviation) {
      merged[company.id] = {
        ...(research || {}),
        ...(live || {}),
        current: false,
        freshness: "blocked"
      };
      issues.push({
        id: company.id,
        code: !livePrice ? "broker_price_missing" : "price_deviation",
        deviation: Number.isFinite(deviation) ? deviation : null
      });
      continue;
    }
    merged[company.id] = {
      ...(research || {}),
      ...(live || {}),
      current: true,
      freshness: "current"
    };
  }
  return { quotes: merged, issues };
}

function priceMap(companies, quotes) {
  return new Map(
    companies
      .map((company) => {
        const quote = quotes?.[company.id];
        const price = finite(Number(quote?.price));
        if (!price) return null;
        return [
          company.id,
          { price }
        ];
      })
      .filter(Boolean)
  );
}

function tickSizeKrw(price) {
  if (price < 2_000) return 1;
  if (price < 5_000) return 5;
  if (price < 20_000) return 10;
  if (price < 50_000) return 50;
  if (price < 200_000) return 100;
  if (price < 500_000) return 500;
  return 1_000;
}

function bufferedLimitPrice(order, buffer) {
  const raw = order.limitPrice * (order.side === "buy" ? 1 + buffer : 1 - buffer);
  const tick = tickSizeKrw(raw);
  return order.side === "buy"
    ? Math.ceil(raw / tick) * tick
    : Math.max(tick, Math.floor(raw / tick) * tick);
}

function prepareOrders(orders, config) {
  return orders.map((order) => ({
    ...order,
    orderType: "limit",
    limitPrice: bufferedLimitPrice(order, config.risk.limitPriceBuffer)
  }));
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function signalSummary(signal, candidateCountScope = null) {
  return {
    revision: signal.revision,
    rawRevision: signal.rawRevision,
    modelVersion: signal.modelVersion,
    sourceUpdatedAt: signal.sourceUpdatedAt,
    fetchedAt: signal.fetchedAt,
    candidateCount: candidateCountForSignal(signal),
    candidateCountScope
  };
}

async function enrichManagedCompanies(signal, state, client) {
  const companies = [...signal.companies];
  const knownIds = new Set(companies.map((company) => company.id));
  for (const managed of Object.values(state.strategy.managedSecurities || {})) {
    if (!managed?.id || knownIds.has(managed.id)) continue;
    const company = await client.getCompany(managed.id, { modelVersion: signal.modelVersion });
    companies.push(company);
    signal.quotes[company.id] = company.marketData || null;
    knownIds.add(company.id);
  }
  return { ...signal, companies };
}

function managedAccount(account, state, config, now) {
  const managed = state.strategy.managedSecurities || {};
  const pending = state.strategy.pendingManagedSecurities || {};
  const positions = Array.isArray(account.positions) ? account.positions : [];
  const confirmedPending = {};
  if (config.risk.requireDedicatedAccount) {
    for (const position of positions) {
      const key = portfolioSecurityKey(position);
      const candidate = pending[key];
      if (
        !candidate?.brokerOrderId ||
        candidate.side !== "buy" ||
        !pendingManagementIsFresh(candidate, now)
      ) {
        continue;
      }
      const baseline = finite(Number(candidate.baselineQuantity));
      const expected = finite(Number(candidate.expectedQuantity));
      const current = finite(Number(position.quantity));
      const increase = current !== null && baseline !== null ? current - baseline : null;
      if (
        baseline < 0 ||
        !Number.isInteger(expected) ||
        expected <= 0 ||
        increase === null ||
        increase <= 0 ||
        increase > expected
      ) {
        continue;
      }
      confirmedPending[key] = securityMetadata({ ...position, ...candidate });
    }
  }
  const effectiveManaged = { ...managed, ...confirmedPending };
  const unresolvedPending = Object.fromEntries(
    Object.entries(pending)
      .filter(([key]) => !confirmedPending[key])
      .map(([key, candidate]) => [key, securityMetadata(candidate)])
  );
  const unmanaged = positions.filter(
    (position) => !effectiveManaged[portfolioSecurityKey(position)]
  );
  const managedPositions = positions.filter(
    (position) => effectiveManaged[portfolioSecurityKey(position)]
  );
  const managedValue = managedPositions.reduce(
    (sum, position) => sum + (finite(Number(position.marketValueKrw)) || 0),
    0
  );
  const actualEquity = finite(Number(account.totalEquityKrw)) || 0;
  const actualCash = finite(Number(account.cashKrw)) || 0;
  const allPositionsValue = positions.reduce(
    (sum, position) => sum + (finite(Number(position.marketValueKrw)) || 0),
    0
  );
  // KIS can keep today's filled purchases inside the deposit field until
  // settlement. Bound spendable cash by total equity minus all holdings so
  // same-day fills are never counted once as cash and again as a position.
  const equityBackedCash =
    actualEquity > 0 ? Math.max(0, actualEquity - allPositionsValue) : actualCash;
  const spendableCash = Math.min(actualCash, equityBackedCash);
  const managedEquity = spendableCash + managedValue;
  const limit = config.risk.capitalLimitKrw > 0 ? config.risk.capitalLimitKrw : managedEquity;
  const totalEquityKrw = Math.min(managedEquity, limit);
  const cashKrw = Math.min(
    spendableCash,
    Math.max(0, totalEquityKrw - managedValue)
  );
  return {
    account: {
      ...account,
      actualTotalEquityKrw: actualEquity,
      reportedCashKrw: actualCash,
      managedEquityKrw: managedEquity,
      totalEquityKrw,
      cashKrw,
      positions: managedPositions,
      managedPositionsValueKrw: managedValue
    },
    unmanaged,
    confirmedPending,
    unresolvedPending
  };
}

function enrichAccountPositionSectors(account, companies) {
  const sectors = new Map();
  for (const company of companies || []) {
    const sector = String(company?.sector || "").trim();
    if (!sector) continue;
    sectors.set(portfolioSecurityKey(company), sector);
  }
  return {
    ...account,
    positions: (Array.isArray(account?.positions) ? account.positions : []).map(
      (position) => {
        if (String(position?.sector || "").trim()) return position;
        const sector = sectors.get(portfolioSecurityKey(position));
        return sector ? { ...position, sector } : position;
      }
    )
  };
}

export class TradingEngine {
  constructor(
    config,
    {
      client,
      stateStore,
      broker,
      now = () => new Date(),
      timeBounds = null,
      beforePersist = null,
      beforeOrder = null
    } = {}
  ) {
    if (timeBounds !== null && typeof timeBounds !== "function") {
      throw new TypeError("신뢰 시각 범위 확인은 함수여야 합니다.");
    }
    if (beforePersist !== null && typeof beforePersist !== "function") {
      throw new TypeError("주문 의도 저장 전 원격 안전 확인은 함수여야 합니다.");
    }
    if (beforeOrder !== null && typeof beforeOrder !== "function") {
      throw new TypeError("주문 직전 원격 안전 확인은 함수여야 합니다.");
    }
    this.config = config;
    this.client = client;
    this.stateStore = stateStore;
    this.broker = broker;
    this.now = now;
    this.timeBounds = timeBounds;
    this.beforePersist = beforePersist;
    this.beforeOrder = beforeOrder;
    this.killSwitchFile = path.join(config.stateDir, "KILL_SWITCH");
  }

  currentTimeBounds() {
    const fallback = this.now();
    return normalizedTimeBounds(
      this.timeBounds ? this.timeBounds() : null,
      fallback
    );
  }

  async status() {
    if (typeof this.stateStore.reload === "function") await this.stateStore.reload();
    const state = this.stateStore.snapshot();
    return {
      state,
      lastRun: state.runs.at(-1) || null,
      killSwitchActive: await fileExists(this.killSwitchFile)
    };
  }

  async plan({
    force = false,
    liveConfirmation = false,
    cycleScope = "",
    cashDeploymentOnly = false,
    scheduledRetry = false
  } = {}) {
    if (typeof this.stateStore.reload === "function") await this.stateStore.reload();
    const now = this.now();
    const state = this.stateStore.snapshot();
    const resolvedCycleScope = normalizedCycleScope(cycleScope);
    if (cashDeploymentOnly && !resolvedCycleScope) {
      throw new Error("추가입금 실행에는 일회성 실행 식별자가 필요합니다.");
    }
    if (scheduledRetry && !resolvedCycleScope) {
      throw new Error("예약 재시도에는 일일 실행 식별자가 필요합니다.");
    }
    if (scheduledRetry && cashDeploymentOnly) {
      throw new Error("예약 재시도는 추가입금 매수전용 실행과 함께 사용할 수 없습니다.");
    }
    if (resolvedCycleScope && !cashDeploymentOnly && !scheduledRetry) {
      throw new Error(
        "실행 식별자는 추가입금 매수전용 또는 명시적인 예약 재시도에서만 사용할 수 있습니다."
      );
    }
    const scopedCycleKey = resolvedCycleScope
      ? buildCycleKey({
          accountId: accountIdentity(this.config),
          scope: resolvedCycleScope
        })
      : "";
    if (
      scopedCycleKey &&
      new Set(state.strategy.completedCycleKeys || []).has(scopedCycleKey)
    ) {
      return {
        ok: true,
        alreadyCompleted: true,
        signal: null,
        account: null,
        portfolio: null,
        planner: null,
        orders: [],
        risk: null,
        management: null,
        blockedReasons: [],
        cycleKey: scopedCycleKey,
        plannedAt: now.toISOString()
      };
    }
    const blockedReasons = [];
    if (await fileExists(this.killSwitchFile)) blockedReasons.push("긴급 정지 스위치가 켜져 있습니다.");
    if (state.strategy.inFlight) {
      blockedReasons.push(
        `확인이 끝나지 않은 이전 주문 실행이 있습니다(${state.strategy.inFlight.cycleKey}).`
      );
    }
    const liveKisOrder = this.config.mode === "live" && this.broker.name === "kis";
    if (liveKisOrder && !liveOrderWindowBoundsAreOpen(this.currentTimeBounds())) {
      blockedReasons.push("실전 주문 허용시간(평일 09:05~14:50 KST)이 아닙니다.");
    }

    let signal = await this.client.getSignal();
    try {
      signal = await enrichManagedCompanies(signal, state, this.client);
    } catch {
      blockedReasons.push("기존 보유종목의 최신 평가를 확인하지 못했습니다.");
    }
    const signalRisk = assessSignal(signal, this.config, {
      now,
      previous: {
        candidateCount: state.strategy.candidateCount,
        candidateCountScope: state.strategy.candidateCountScope
      }
    });
    blockedReasons.push(...signalRisk.reasons);

    let brokerQuotes = null;
    if (this.broker.name === "kis") {
      if (typeof this.broker.getQuotes !== "function") {
        blockedReasons.push("KIS 주문 직전 현재가 확인 기능이 없습니다.");
      } else {
        brokerQuotes = await this.broker.getQuotes(signal.companies);
      }
    }
    const executionQuotes = mergeExecutionQuotes(
      signal,
      brokerQuotes,
      this.config.risk.maximumSignalPriceDeviation,
      this.broker.name === "kis",
      liveKisOrder ? kstTradingClock(now).businessDate : null
    );

    const brokerAccount = await this.broker.getAccount(
      priceMap(signal.companies, executionQuotes.quotes)
    );
    const rawAccount = enrichAccountPositionSectors(
      brokerAccount,
      signal.companies
    );
    const managed = managedAccount(rawAccount, state, this.config, now);
    const account = managed.account;
    if (
      this.broker.name === "kis" &&
      Object.keys(managed.unresolvedPending).length > 0
    ) {
      blockedReasons.push(
        "이전에 제출한 매수 주문이 잔고에 반영됐는지 확인되지 않아 새 주문을 중단합니다."
      );
    }
    if (this.config.risk.requireDedicatedAccount && managed.unmanaged.length > 0) {
      blockedReasons.push("자동매매 관리 밖의 기존 보유종목이 계좌에 있습니다.");
    }
    const portfolioOptions = {
      companies: signal.companies,
      quotes: executionQuotes.quotes,
      totalEquityKrw: account.totalEquityKrw,
      config: this.config,
      // Live quotes are observed after the plan-start timestamp. Evaluate
      // freshness against a clock sampled after all broker reads so a quote
      // cannot look artificially "from the future" by a few seconds.
      now: this.now(),
      incumbents: account.positions
    };
    const portfolio = this.config.longview.requirePublishedSelection
      ? selectPublishedPortfolio({
          ...portfolioOptions,
          selection: signal.selection
        })
      : selectBalancedPortfolio(portfolioOptions);
    if (portfolio.status !== "ready") blockedReasons.push(...portfolio.blockedReasons);

    const cashDeploymentTurnoverWeight =
      cashDeploymentOnly && account.totalEquityKrw > 0
        ? Math.min(1, account.cashKrw / account.totalEquityKrw)
        : null;
    const plannerTurnoverWeight =
      cashDeploymentTurnoverWeight ?? this.config.risk.maximumTurnoverWeight;
    const plannerInitialTurnoverWeight =
      cashDeploymentTurnoverWeight ?? this.config.risk.initialDeploymentTurnoverWeight;
    const planned = planMonthlyRebalance({
      portfolio,
      account,
      state,
      config: {
        ...this.config,
        risk: {
          ...this.config.risk,
          maximumTurnoverWeight:
            plannerTurnoverWeight /
            (1 + this.config.risk.limitPriceBuffer),
          initialDeploymentTurnoverWeight:
            plannerInitialTurnoverWeight /
            (1 + this.config.risk.limitPriceBuffer),
          // A KIS order acknowledgement is not a fill confirmation. Do not
          // finance follow-up buys with projected sell proceeds; the next
          // verified balance can deploy them safely.
          reuseProjectedSellProceeds: this.broker.name !== "kis"
        }
      },
      now,
      force: force || cashDeploymentOnly,
      cashDeploymentOnly
    });
    if (planned.status === "blocked") {
      blockedReasons.push(planned.diagnostics?.reason || "주문계획을 만들 수 없습니다.");
    }
    let orders = prepareOrders(planned.orders || [], this.config);
    const existingCycleKeys = new Set(state.strategy.completedCycleKeys || []);
    const sameDailyRevision =
      !force &&
      this.config.strategy.rebalanceFrequency === "daily" &&
      Boolean(state.strategy.lastSnapshotRevision) &&
      state.strategy.lastSnapshotRevision === signal.revision;
    const cycleKey =
      scopedCycleKey ||
      buildCycleKey({
        signalRevision: signal.revision,
        modelVersion: signal.modelVersion,
        strategyVersion: this.config.strategy.version,
        period: rebalancePeriodKst(now, this.config.strategy.rebalanceFrequency),
        accountId: accountIdentity(this.config)
      });
    orders = orders.map((order, index) => ({
      ...order,
      checkpointId: orderCheckpointId(cycleKey, index, order)
    }));
    const staleDailySignal =
      sameDailyRevision &&
      !existingCycleKeys.has(cycleKey);
    if (staleDailySignal) {
      blockedReasons.push("새로 게시된 일일 데이터가 없어 이전 신호를 다시 처리하지 않습니다.");
    }
    const fallbackTurnoverWeight =
      cashDeploymentTurnoverWeight ??
      (planned.diagnostics?.deploymentPhase === "initial"
        ? this.config.risk.initialDeploymentTurnoverWeight
        : this.config.risk.maximumTurnoverWeight);
    const plannedBuyTurnoverCapWeight = finite(
      planned.diagnostics?.buyTurnoverCapWeight
    );
    const plannedSellTurnoverCapWeight = finite(
      planned.diagnostics?.sellTurnoverCapWeight
    );
    const plannedGrossTurnoverCapWeight = finite(
      planned.diagnostics?.grossTurnoverCapWeight
    );
    const buyTurnoverRiskCapWeight =
      plannedBuyTurnoverCapWeight === null
        ? null
        : plannedBuyTurnoverCapWeight *
          (1 + this.config.risk.limitPriceBuffer);
    const sellTurnoverRiskCapWeight = plannedSellTurnoverCapWeight;
    const grossTurnoverRiskCapWeight =
      plannedGrossTurnoverCapWeight === null
        ? null
        : plannedGrossTurnoverCapWeight +
          (plannedBuyTurnoverCapWeight || 0) *
            this.config.risk.limitPriceBuffer;
    const hasSideTurnoverCaps =
      buyTurnoverRiskCapWeight !== null &&
      sellTurnoverRiskCapWeight !== null;
    const orderRiskConfig = {
      ...this.config,
      risk: {
        ...this.config.risk,
        maximumTurnoverWeight:
          hasSideTurnoverCaps
            ? buyTurnoverRiskCapWeight + sellTurnoverRiskCapWeight
            : fallbackTurnoverWeight,
        ...(buyTurnoverRiskCapWeight !== null
          ? { maximumBuyTurnoverWeight: buyTurnoverRiskCapWeight }
          : {}),
        ...(sellTurnoverRiskCapWeight !== null
          ? { maximumSellTurnoverWeight: sellTurnoverRiskCapWeight }
          : {}),
        ...(grossTurnoverRiskCapWeight !== null
          ? { maximumGrossTurnoverWeight: grossTurnoverRiskCapWeight }
          : {})
      }
    };
    const orderRisk = assessOrders(orders, account, orderRiskConfig, {
      liveConfirmation,
      cycleKey,
      existingCycleKeys
    });
    blockedReasons.push(...orderRisk.reasons);

    return {
      ok: blockedReasons.length === 0,
      signal: signalSummary(signal, signalRisk.candidateCountScope),
      account,
      portfolio,
      planner: planned,
      orders,
      risk: {
        signal: signalRisk,
        orders: orderRisk,
        quoteIssues: executionQuotes.issues
      },
      management: {
        confirmedPending: managed.confirmedPending,
        unresolvedPending: managed.unresolvedPending
      },
      blockedReasons: [...new Set(blockedReasons)],
      cycleKey,
      plannedAt: now.toISOString()
    };
  }

  async assertKillSwitchInactive() {
    if (await fileExists(this.killSwitchFile)) {
      const error = new Error("긴급 정지 스위치가 켜져 있어 주문을 중단했습니다.");
      error.code = "TRADING_KILL_SWITCH";
      throw error;
    }
  }

  assertLiveOrderWindowOpen() {
    if (this.config.mode !== "live" || this.broker.name !== "kis") return;
    if (!liveOrderWindowBoundsAreOpen(this.currentTimeBounds())) {
      const error = new Error("실전 주문 허용시간이 지나 주문을 중단했습니다.");
      error.code = "LIVE_ORDER_WINDOW_CLOSED";
      throw error;
    }
  }

  async assertLivePreOrderSafety(order) {
    this.assertLiveOrderWindowOpen();
    if (this.config.mode !== "live" || this.broker.name !== "kis") return;
    if (String(order?.side || "").toLowerCase() !== "buy") return;
    if (typeof this.broker.getBuyableOrder !== "function") {
      const error = new Error("KIS 미수 없는 매수가능수량 확인 기능이 없습니다.");
      error.code = "KIS_BUYABLE_CHECK_MISSING";
      throw error;
    }
    const capacity = await this.broker.getBuyableOrder(order);
    if (capacity?.sufficient !== true) {
      const error = new Error("미수 없는 매수가능수량보다 주문수량이 커서 주문을 중단했습니다.");
      error.code = "KIS_BUYABLE_QUANTITY_EXCEEDED";
      throw error;
    }
  }

  async persistInFlight(plan, trigger) {
    const createdAt = this.now().toISOString();
    const baselineQuantities = positionQuantityMap(plan.account?.positions || []);
    await this.stateStore.update(
      (state) => {
        if (state.strategy.inFlight) {
          const error = new Error("확인이 끝나지 않은 이전 주문 실행이 있습니다.");
          error.code = "TRADING_IN_FLIGHT";
          throw error;
        }
        state.strategy.inFlight = {
          cycleKey: plan.cycleKey,
          trigger,
          createdAt,
          signalRevision: plan.signal?.revision || null,
          orders: plan.orders.map((order, index) => ({
            index,
            checkpointId: order.checkpointId,
            id: order.id,
            ticker: order.ticker,
            country: order.country,
            side: order.side,
            quantity: order.quantity,
            limitPrice: order.limitPrice,
            currency: order.currency,
            baselineQuantity:
              baselineQuantities.get(portfolioSecurityKey(order)) || 0,
            status: "intent_persisted",
            brokerOrderId: null,
            branchNumber: null,
            submittedAt: null,
            checkedAt: null
          }))
        };
      },
      {
        type: "trading_in_flight_created",
        cycleKey: plan.cycleKey,
        trigger,
        orderCount: plan.orders.length
      }
    );
  }

  async checkpointOrderResult(plan, result, index) {
    const checkpointId = plan.orders[index]?.checkpointId;
    if (!checkpointId) throw new Error("주문 체크포인트 식별자가 없습니다.");
    const checkedAt = this.now().toISOString();
    await this.stateStore.update(
      (state) => {
        const inFlight = state.strategy.inFlight;
        if (!inFlight || inFlight.cycleKey !== plan.cycleKey) {
          throw new Error("원격 저장 전 주문 실행 상태가 변경되었습니다.");
        }
        const target = inFlight.orders?.[index];
        if (!target || target.checkpointId !== checkpointId) {
          throw new Error("원격 저장할 주문 체크포인트가 일치하지 않습니다.");
        }
        Object.assign(target, {
          status: String(result?.status || "unknown"),
          brokerOrderId: String(result?.brokerOrderId || "") || null,
          branchNumber: String(result?.branchNumber || "") || null,
          submittedAt: result?.submittedAt || target.submittedAt || null,
          errorCode: String(result?.errorCode || "") || null,
          notSent: result?.notSent === true,
          checkedAt
        });
      },
      {
        type: "trading_order_checkpointed",
        cycleKey: plan.cycleKey,
        checkpointId,
        orderIndex: index,
        status: String(result?.status || "unknown")
      }
    );
  }

  async clearUnsentInFlight(plan, results, trigger) {
    const summary = {
      at: this.now().toISOString(),
      trigger,
      cycleKey: plan.cycleKey,
      signalRevision: plan.signal?.revision || null,
      candidateCount: plan.signal?.candidateCount ?? null,
      selectedCount: plan.portfolio?.selected?.length || 0,
      orderCount: plan.orders?.length || 0,
      executed: false,
      resultStatuses: results.map((item) => item.status),
      blockedReasons: plan.blockedReasons || []
    };
    await this.stateStore.update(
      (state) => {
        const current = state.strategy.inFlight;
        if (!current || current.cycleKey !== plan.cycleKey) {
          const error = new Error("전송되지 않은 주문의 미결 상태가 변경되었습니다.");
          error.code = "TRADING_IN_FLIGHT_CHANGED";
          throw error;
        }
        state.strategy.inFlight = null;
        state.runs.push(summary);
        state.runs = state.runs.slice(-200);
      },
      {
        type: "trading_run_no_external_order",
        cycleKey: plan.cycleKey,
        trigger,
        orderCount: plan.orders.length
      }
    );
  }

  async execute(options = {}) {
    const { trigger = "manual" } = options;
    const run = async () => {
      if (typeof this.stateStore.reload === "function") await this.stateStore.reload();
      return this.executeLocked(options);
    };
    if (typeof this.stateStore.withRunLock !== "function") return run();
    return this.stateStore.withRunLock(run, {
      type: "trading_execute",
      trigger,
      mode: this.config.mode,
      broker: this.config.broker
    });
  }

  async executeLocked({
    force = false,
    liveConfirmation = false,
    trigger = "manual",
    cycleScope = "",
    cashDeploymentOnly = false,
    scheduledRetry = false
  } = {}) {
    let plan;
    try {
      plan = await this.plan({
        force,
        liveConfirmation,
        cycleScope,
        cashDeploymentOnly,
        scheduledRetry
      });
    } catch (error) {
      const safeError = redactSensitive(error, [
        this.config.kis.appKey,
        this.config.kis.appSecret,
        this.config.kis.accountNumber
      ]);
      await this.stateStore.appendAudit({ type: "run_failed_before_order", trigger, error: safeError });
      throw new Error(safeError);
    }

    if (plan.alreadyCompleted === true) {
      return {
        ...plan,
        executed: false,
        results: [],
        reason: "already_completed"
      };
    }

    if (!plan.ok || plan.orders.length === 0) {
      const result = {
        ...plan,
        executed: false,
        results: [],
        reason: !plan.ok ? "blocked" : "no_orders"
      };
      await this.recordRun(result, { trigger, completed: plan.ok });
      return result;
    }

    await this.assertKillSwitchInactive();
    if (this.beforePersist) await this.beforePersist(plan);
    await this.assertKillSwitchInactive();
    await this.assertLivePreOrderSafety(null);
    await this.persistInFlight(plan, trigger);
    let results;
    try {
      // The second check closes the planning/persistence gap. KIS also awaits
      // the callback before every individual order, so a stop requested during
      // a batch prevents all remaining submissions.
      await this.assertKillSwitchInactive();
      results = await this.broker.placeOrders(plan.orders, {
        beforeEach: async (order, index) => {
          await this.assertKillSwitchInactive();
          if (this.beforeOrder) await this.beforeOrder(order, index, plan);
          await this.assertKillSwitchInactive();
          await this.assertLivePreOrderSafety(order);
        },
        beforeSubmit: async (order, index) => {
          await this.assertKillSwitchInactive();
          if (this.beforeOrder) await this.beforeOrder(order, index, plan);
          await this.assertKillSwitchInactive();
          this.assertLiveOrderWindowOpen();
        },
        afterEach: async (result, index) =>
          this.checkpointOrderResult(plan, result, index)
      });
      if (!Array.isArray(results)) throw new Error("브로커 주문 결과 형식이 올바르지 않습니다.");
    } catch (error) {
      const safeError = redactSensitive(error, [
        this.config.kis.appKey,
        this.config.kis.appSecret,
        this.config.kis.accountNumber
      ]);
      await this.stateStore.appendAudit({
        type: "order_submission_interrupted",
        trigger,
        cycleKey: plan.cycleKey,
        error: safeError
      });
      // Keep strategy.inFlight intact. The operator must compare the broker's
      // order history before explicitly resolving it; automatic retries are unsafe.
      throw new Error(safeError);
    }
    const noExternalOrderAttempt =
      results.length > 0 &&
      results.length === plan.orders.length &&
      results.every(
        (item, index) =>
          String(item?.status || "").toLowerCase() === "blocked" &&
          item?.notSent === true &&
          item?.checkpointId === plan.orders[index]?.checkpointId
      );
    const result = {
      ...plan,
      executed: !noExternalOrderAttempt,
      results,
      reason: noExternalOrderAttempt ? "orders_not_sent" : null
    };
    if (noExternalOrderAttempt) {
      await this.clearUnsentInFlight(plan, results, trigger);
      return result;
    }
    // Any submitted/unknown order makes an immediate rerun unsafe. Mark the
    // cycle processed and reconcile with the broker before a future retry.
    await this.recordRun(result, { trigger, completed: true });
    return result;
  }

  async checkpointReconciliation(cycleKey, reconciliation, trigger) {
    const checkedAt = this.now().toISOString();
    await this.stateStore.update(
      (state) => {
        const current = state.strategy.inFlight;
        if (!current || current.cycleKey !== cycleKey) {
          throw new Error("주문 대조 중 미결 실행 상태가 변경되었습니다.");
        }
        if (current.orders?.length !== reconciliation.updates.length) {
          throw new Error("주문 대조 결과의 주문 수가 미결 실행과 일치하지 않습니다.");
        }
        for (let index = 0; index < reconciliation.updates.length; index += 1) {
          const before = current.orders[index];
          const after = reconciliation.updates[index];
          if (
            before?.checkpointId !== after?.checkpointId ||
            before?.index !== after?.index
          ) {
            throw new Error("주문 대조 체크포인트가 미결 실행과 일치하지 않습니다.");
          }
        }
        current.orders = reconciliation.updates.map((order) => ({
          ...order,
          checkedAt
        }));
        current.lastReconciledAt = checkedAt;
        current.reconciliationCount = (Number(current.reconciliationCount) || 0) + 1;
      },
      {
        type: "trading_orders_reconciled",
        trigger,
        cycleKey,
        allTerminal: reconciliation.allTerminal,
        ambiguous: reconciliation.ambiguous,
        cancelCandidateCount: reconciliation.cancelCandidates.length
      }
    );
  }

  async checkpointCancellation(cycleKey, candidate, cancellation, trigger) {
    const checkedAt = this.now().toISOString();
    await this.stateStore.update(
      (state) => {
        const inFlight = state.strategy.inFlight;
        if (!inFlight || inFlight.cycleKey !== cycleKey) {
          throw new Error("취소 결과 저장 전 미결 실행 상태가 변경되었습니다.");
        }
        const target = inFlight.orders?.find(
          (order) => order.checkpointId === candidate.checkpointId
        );
        if (!target || !sameBrokerOrder(target, candidate)) {
          throw new Error("취소 결과를 저장할 원주문이 일치하지 않습니다.");
        }
        target.cancel = {
          status: String(cancellation.status || "unknown"),
          cancelOrderId: String(cancellation.cancelOrderId || "") || null,
          submittedAt: cancellation.submittedAt || null,
          errorCode: String(cancellation.errorCode || "") || null,
          reason: String(cancellation.reason || "") || null,
          checkedAt
        };
        target.checkedAt = checkedAt;
      },
      {
        type: "trading_cancel_checkpointed",
        trigger,
        cycleKey,
        checkpointId: candidate.checkpointId,
        status: String(cancellation.status || "unknown")
      }
    );
  }

  async finalizeReconciliation(cycleKey, account, trigger) {
    const completedAt = this.now().toISOString();
    let completedOrders = [];
    await this.stateStore.update(
      (state) => {
        const inFlight = state.strategy.inFlight;
        if (!inFlight || inFlight.cycleKey !== cycleKey) {
          throw new Error("주문 대조 완료 전 미결 실행 상태가 변경되었습니다.");
        }
        if (!inFlight.orders.every((order) => orderStatusIsTerminal(order.status, order))) {
          throw new Error("종료되지 않은 주문이 있어 미결 실행을 해제할 수 없습니다.");
        }
        completedOrders = structuredClone(inFlight.orders);
        const pending = Object.fromEntries(
          Object.entries(state.strategy.pendingManagedSecurities || {}).filter(
            ([, item]) => item?.cycleKey !== cycleKey
          )
        );
        state.strategy.managedSecurities = rebuildManagedSecurities(
          state,
          account,
          inFlight.orders
        );
        state.strategy.pendingManagedSecurities = pending;
        state.strategy.inFlight = null;
        state.strategy.completedCycleKeys = [...new Set([
          ...(state.strategy.completedCycleKeys || []),
          cycleKey
        ])].slice(-120);
      },
      {
        type: "trading_reconciliation_completed",
        trigger,
        cycleKey,
        completedAt,
        positionCount: Array.isArray(account?.positions) ? account.positions.length : 0
      }
    );
    return completedOrders;
  }

  async reconcileInFlight({ cancelOpenOrders = false, trigger = "manual" } = {}) {
    if (typeof cancelOpenOrders !== "boolean") {
      throw new TypeError("미체결 취소 여부는 불리언이어야 합니다.");
    }
    const run = async () => {
      if (typeof this.stateStore.reload === "function") await this.stateStore.reload();
      return this.reconcileInFlightLocked({ cancelOpenOrders, trigger });
    };
    if (typeof this.stateStore.withRunLock !== "function") return run();
    return this.stateStore.withRunLock(run, {
      type: "trading_reconcile",
      trigger,
      cancelOpenOrders,
      broker: this.config.broker
    });
  }

  async reconcileInFlightLocked({ cancelOpenOrders, trigger }) {
    const snapshot = this.stateStore.snapshot();
    const inFlight = snapshot.strategy.inFlight;
    if (!inFlight) {
      return {
        status: "none",
        reconciled: false,
        cleared: false,
        pendingCount: 0,
        canceledCount: 0,
        ambiguous: false,
        statusCounts: {}
      };
    }
    if (this.broker.name !== "kis") {
      throw new Error("미결 주문 자동 대조는 KIS 브로커에서만 지원합니다.");
    }
    if (typeof this.broker.getDailyOrders !== "function") {
      throw new Error("KIS 일별 주문체결 조회 기능이 없습니다.");
    }

    const cycleKey = inFlight.cycleKey;
    try {
      const daily = await this.broker.getDailyOrders({
        startDate: kstTradingClock(inFlight.createdAt).businessDate,
        endDate: kstTradingClock(this.now()).businessDate
      });
      const reconciliation = reconcileOrderIntents({
        inFlight,
        brokerOrders: brokerRows(daily, "KIS 일별 주문체결"),
        now: this.now()
      });
      // Persist the broker view before any cancellation request. If this
      // checkpoint cannot reach durable storage, no external mutation follows.
      await this.checkpointReconciliation(cycleKey, reconciliation, trigger);

      const cancelResults = [];
      if (cancelOpenOrders && reconciliation.cancelCandidates.length > 0) {
        if (
          typeof this.broker.getCancelableOrders !== "function" ||
          typeof this.broker.cancelOrder !== "function"
        ) {
          throw new Error("KIS 안전 취소 조회 또는 취소 기능이 없습니다.");
        }
        const cancelableResponse = await this.broker.getCancelableOrders({ side: "all" });
        const cancelableOrders = brokerRows(cancelableResponse, "KIS 정정취소 가능 주문");
        for (let index = 0; index < reconciliation.cancelCandidates.length; index += 1) {
          const candidate = reconciliation.cancelCandidates[index];
          // A cancellation acknowledgement is itself an external mutation.
          // Never submit it twice merely because the daily history is delayed.
          if (candidate.cancel?.checkedAt) continue;
          const matches = cancelableOrders.filter((order) => sameBrokerOrder(order, candidate));
          const available = matches.length === 1 ? matches[0] : null;
          const fullyUnfilled =
            available &&
            Number(candidate.filledQuantity) === 0 &&
            Number(candidate.remainingQuantity) === Number(candidate.quantity) &&
            Number(available.filledQuantity) === 0 &&
            Number(available.cancelableQuantity) === Number(candidate.remainingQuantity) &&
            Number(available.orderQuantity) === Number(candidate.quantity) &&
            String(available.side || "").toLowerCase() ===
              String(candidate.side || "").toLowerCase();
          if (!fullyUnfilled) {
            cancelResults.push({
              checkpointId: candidate.checkpointId,
              status: "not_safely_cancelable"
            });
            continue;
          }

          let cancellation;
          try {
            if (this.beforeOrder) {
              await this.beforeOrder(candidate, index, {
                type: "cancel",
                cycleKey,
                trigger
              });
            }
            cancellation = await this.broker.cancelOrder(candidate);
          } catch (error) {
            const reason = redactSensitive(error, [
              this.config.kis.appKey,
              this.config.kis.appSecret,
              this.config.kis.accountNumber
            ]);
            cancellation = {
              status: "failed",
              errorCode: String(error?.code || "KIS_CANCEL_ERROR"),
              reason
            };
            await this.checkpointCancellation(cycleKey, candidate, cancellation, trigger);
            cancelResults.push({
              checkpointId: candidate.checkpointId,
              status: cancellation.status,
              errorCode: cancellation.errorCode
            });
            throw new Error(reason);
          }
          await this.checkpointCancellation(cycleKey, candidate, cancellation, trigger);
          cancelResults.push({
            checkpointId: candidate.checkpointId,
            status: String(cancellation?.status || "unknown")
          });
        }
      }

      if (!reconciliation.allTerminal) {
        const pendingCount = reconciliation.updates.filter(
          (order) => !orderStatusIsTerminal(order.status, order)
        ).length;
        return {
          status: reconciliation.ambiguous ? "ambiguous" : "pending",
          reconciled: true,
          cleared: false,
          pendingCount,
          canceledCount: cancelResults.filter(
            (item) => item.status === "cancel_submitted"
          ).length,
          ambiguous: reconciliation.ambiguous,
          statusCounts: orderStatusCounts(reconciliation.updates)
        };
      }

      const account = await this.broker.getAccount();
      const completedOrders = await this.finalizeReconciliation(cycleKey, account, trigger);
      return {
        status: "cleared",
        reconciled: true,
        cleared: true,
        pendingCount: 0,
        canceledCount: cancelResults.filter(
          (item) => item.status === "cancel_submitted"
        ).length,
        ambiguous: false,
        statusCounts: orderStatusCounts(completedOrders)
      };
    } catch (error) {
      const safeError = redactSensitive(error, [
        this.config.kis.appKey,
        this.config.kis.appSecret,
        this.config.kis.accountNumber
      ]);
      try {
        await this.stateStore.appendAudit({
          type: "trading_reconciliation_failed",
          trigger,
          cycleKey,
          error: safeError
        });
      } catch {
        // Preserve the original broker/durable-state error.
      }
      throw new Error(safeError);
    }
  }

  async resolveInFlightNoRetry(cycleKey) {
    const normalized = String(cycleKey || "").trim();
    if (!normalized) throw new Error("해결할 실행 주기 키가 필요합니다.");
    const resolve = async () => {
      if (typeof this.stateStore.reload === "function") await this.stateStore.reload();
      await this.stateStore.update(
        (state) => {
          const inFlight = state.strategy.inFlight;
          if (!inFlight) throw new Error("확인이 필요한 미결 주문 실행이 없습니다.");
          if (inFlight.cycleKey !== normalized) {
            throw new Error("미결 주문 실행 키가 일치하지 않습니다.");
          }
          state.strategy.inFlight = null;
          state.strategy.completedCycleKeys = [...new Set([
            ...(state.strategy.completedCycleKeys || []),
            normalized
          ])].slice(-120);
        },
        { type: "trading_in_flight_resolved_no_retry", cycleKey: normalized }
      );
    };
    if (typeof this.stateStore.withRunLock !== "function") return resolve();
    return this.stateStore.withRunLock(resolve, {
      type: "resolve_in_flight",
      cycleKey: normalized
    });
  }

  async resolvePendingNoFill(cycleKey) {
    const normalized = String(cycleKey || "").trim();
    if (!/^[a-f0-9]{24}$/i.test(normalized)) {
      throw new Error("해결할 대기 주문의 24자리 실행 주기 키가 필요합니다.");
    }
    const resolve = async () => {
      if (typeof this.stateStore.reload === "function") await this.stateStore.reload();
      const snapshot = this.stateStore.snapshot();
      const matches = Object.entries(
        snapshot.strategy.pendingManagedSecurities || {}
      ).filter(([, item]) => item?.cycleKey === normalized);
      if (matches.length === 0) {
        throw new Error("해당 실행 주기에서 확인할 매수 대기 주문이 없습니다.");
      }
      const resolvedKeys = matches.map(([key]) => key);
      const resolvedIds = matches.map(([, item]) => item?.id).filter(Boolean);
      await this.stateStore.update(
        (state) => {
          const pending = state.strategy.pendingManagedSecurities || {};
          for (const key of resolvedKeys) {
            if (pending[key]?.cycleKey !== normalized) {
              throw new Error("매수 대기 주문 상태가 확인 중 변경되어 해제를 중단합니다.");
            }
          }
          for (const key of resolvedKeys) delete pending[key];
          state.strategy.pendingManagedSecurities = pending;
          state.strategy.completedCycleKeys = [...new Set([
            ...(state.strategy.completedCycleKeys || []),
            normalized
          ])].slice(-120);
        },
        {
          type: "trading_pending_resolved_no_fill",
          cycleKey: normalized,
          resolvedCount: resolvedIds.length,
          ids: resolvedIds
        }
      );
      return { cycleKey: normalized, resolvedCount: resolvedIds.length, ids: resolvedIds };
    };
    if (typeof this.stateStore.withRunLock !== "function") return resolve();
    return this.stateStore.withRunLock(resolve, {
      type: "resolve_pending_no_fill",
      cycleKey: normalized
    });
  }

  async recordRun(result, { trigger, completed }) {
    const summary = {
      at: this.now().toISOString(),
      trigger,
      cycleKey: result.cycleKey,
      signalRevision: result.signal?.revision || null,
      candidateCount: result.signal?.candidateCount ?? null,
      selectedCount: result.portfolio?.selected?.length || 0,
      orderCount: result.orders?.length || 0,
      executed: Boolean(result.executed),
      resultStatuses: (result.results || []).map((item) => item.status),
      blockedReasons: result.blockedReasons || []
    };
    await this.stateStore.update(
      (state) => {
        const nextStrategy = completed ? result.planner?.nextState?.strategy || {} : {};
        const signalBaselineAccepted = result.risk?.signal?.ok === true;
        const retainedKeys = new Set(
          (result.account?.positions || []).map(portfolioSecurityKey)
        );
        const retainedManaged = Object.fromEntries(
          Object.entries(state.strategy.managedSecurities || {}).filter(([key]) =>
            retainedKeys.has(key)
          )
        );
        const confirmedPending = result.management?.confirmedPending || {};
        const confirmedFilled = Object.fromEntries(
          (result.results || [])
            .filter((item) => item.status === "filled" && item.side === "buy")
            .map((item) => [portfolioSecurityKey(item), securityMetadata(item)])
        );
        const baselineQuantities = positionQuantityMap(result.account?.positions || []);
        const submittedPending = Object.fromEntries(
          (result.results || [])
            .filter(
              (item) =>
                item.status === "submitted" &&
                item.side === "buy" &&
                String(item.brokerOrderId || "").trim()
            )
            .map((item) => {
              const key = portfolioSecurityKey(item);
              return [
                key,
                {
                  ...securityMetadata(item),
                  side: "buy",
                  brokerOrderId: String(item.brokerOrderId),
                  baselineQuantity: baselineQuantities.get(key) || 0,
                  expectedQuantity: item.quantity,
                  submittedAt: item.submittedAt || this.now().toISOString(),
                  cycleKey: result.cycleKey
                }
              ];
            })
        );
        const pendingManaged = {
          ...(state.strategy.pendingManagedSecurities || {}),
          ...submittedPending
        };
        for (const key of Object.keys(confirmedPending)) delete pendingManaged[key];
        const executionOutcomeIsResolved =
          (result.results || []).length === (result.orders || []).length &&
          (result.results || []).every(
            (item) =>
              item.status === "filled" ||
              item.status === "rejected" ||
              item.status === "canceled" ||
              item.status === "partial_canceled" ||
              (item.status === "blocked" && item.notSent === true)
          );
        state.strategy = {
          ...state.strategy,
          ...nextStrategy,
          lastSnapshotRevision:
            completed && result.signal?.revision
              ? result.signal.revision
              : state.strategy.lastSnapshotRevision,
          candidateCount: signalBaselineAccepted
            ? result.signal?.candidateCount ?? state.strategy.candidateCount
            : state.strategy.candidateCount,
          candidateCountScope:
            signalBaselineAccepted
              ? result.signal?.candidateCountScope ?? state.strategy.candidateCountScope
              : state.strategy.candidateCountScope,
          managedSecurities: {
            ...retainedManaged,
            ...confirmedPending,
            ...confirmedFilled
          },
          pendingManagedSecurities: pendingManaged,
          inFlight:
            completed &&
            executionOutcomeIsResolved &&
            state.strategy.inFlight?.cycleKey === result.cycleKey
              ? null
              : state.strategy.inFlight,
          completedCycleKeys: [...new Set([
            ...(state.strategy.completedCycleKeys || []),
            ...(completed && result.cycleKey ? [result.cycleKey] : [])
          ])].slice(-120)
        };
        state.runs.push(summary);
        state.runs = state.runs.slice(-200);
      },
      { type: "trading_run", ...summary }
    );
  }
}

export async function createTradingEngine(config, dependencies = {}) {
  const stateStore =
    dependencies.stateStore ||
    (await createTradingStateStore(config.stateDir, {
      startingCashKrw: config.paper.startingCashKrw,
      now: dependencies.now
    }));
  const client =
    dependencies.client ||
    new LongviewClient({
      baseUrl: config.longview.baseUrl,
      timeoutMs: config.longview.timeoutMs,
      expectedModelVersion: config.strategy.approvedModelVersion,
      requirePublishedSelection: config.longview.requirePublishedSelection,
      expectedSelectionPolicy: config.longview.selectionPolicy,
      now: dependencies.now
    });
  const broker =
    dependencies.broker ||
    (config.broker === "kis"
      ? new KisBroker(
          config.kis,
          dependencies.now ? { now: dependencies.now } : undefined
        )
      : new PaperBroker(stateStore, { feeRate: config.paper.feeRate }));
  return new TradingEngine(config, {
    ...dependencies,
    client,
    stateStore,
    broker
  });
}
