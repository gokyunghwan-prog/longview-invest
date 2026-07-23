import { portfolioSecurityKey } from "./strategy.mjs";

const DATA_FAILURE_REASONS = new Set([
  "current_price_missing",
  "current_price_stale",
  "currency_not_krw",
  "market_cap_missing",
  "turnover_missing"
]);

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value) {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizedConfig(config = {}) {
  const strategy = config.strategy || config || {};
  const risk = config.risk || {};
  const paper = config.paper || {};
  return {
    rebalanceFrequency:
      String(strategy.rebalanceFrequency || "monthly").toLowerCase() === "daily"
        ? "daily"
        : "monthly",
    reserveWeight: finite(strategy.reserveWeight) ?? 0,
    rebalanceDrift: finite(strategy.rebalanceDrift) ?? 0.01,
    removalConfirmations: Math.max(1, Math.floor(finite(strategy.removalConfirmations) ?? 2)),
    minimumOrderKrw: positive(strategy.minimumOrderKrw) ?? 50_000,
    maximumPositions: Math.max(
      1,
      Math.floor(finite(strategy.maximumPositions) ?? 5)
    ),
    maximumPositionWeight: finite(strategy.maximumPositionWeight) ?? 0.15,
    maximumSectorWeight: finite(strategy.maximumSectorWeight) ?? 0.2,
    maximumTurnoverWeight: finite(risk.maximumTurnoverWeight) ?? 0.1,
    initialDeploymentTurnoverWeight:
      finite(risk.initialDeploymentTurnoverWeight) ?? 0.3,
    maximumOrdersPerRun: Math.max(1, Math.floor(finite(risk.maximumOrdersPerRun) ?? 20)),
    limitPriceBuffer: Math.max(0, finite(risk.limitPriceBuffer) ?? 0),
    estimatedFeeRate: Math.max(0, finite(paper.feeRate) ?? 0),
    reuseProjectedSellProceeds: risk.reuseProjectedSellProceeds !== false,
    deployAvailableCash: risk.deployAvailableCash === true
  };
}

function strategyState(state) {
  if (state?.strategy && typeof state.strategy === "object") return state.strategy;
  return state || {};
}

function withStrategyState(state, nextStrategy) {
  if (state?.strategy && typeof state.strategy === "object") {
    const next = clone(state);
    next.strategy = { ...next.strategy, ...nextStrategy };
    return next;
  }
  return { ...(clone(state) || {}), ...nextStrategy };
}

function kstMonth(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const shifted = new Date(timestamp + 9 * 60 * 60 * 1_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function kstDate(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const shifted = new Date(timestamp + 9 * 60 * 60 * 1_000);
  return shifted.toISOString().slice(0, 10);
}

export function isDailyRebalanceDue({ now, lastPlanAt = null } = {}) {
  const currentDate = kstDate(now);
  if (!currentDate) throw new RangeError("올바른 now가 필요합니다.");
  const previousDate = kstDate(lastPlanAt);
  return previousDate === null || previousDate !== currentDate;
}

export function isMonthlyRebalanceDue({ now, lastPlanAt = null } = {}) {
  const currentMonth = kstMonth(now);
  if (!currentMonth) throw new RangeError("올바른 now가 필요합니다.");
  const previousMonth = kstMonth(lastPlanAt);
  return previousMonth === null || previousMonth !== currentMonth;
}

export function isRebalanceDue({
  now,
  lastPlanAt = null,
  frequency = "monthly"
} = {}) {
  if (frequency === "daily") return isDailyRebalanceDue({ now, lastPlanAt });
  if (frequency === "monthly") return isMonthlyRebalanceDue({ now, lastPlanAt });
  throw new RangeError("리밸런싱 주기는 daily 또는 monthly여야 합니다.");
}

function positionsArray(account) {
  if (Array.isArray(account?.positions)) return account.positions;
  if (account?.positions && typeof account.positions === "object") {
    return Object.values(account.positions);
  }
  return [];
}

function investedWeight(account, equity, positions) {
  const explicit = finite(account?.positionsValueKrw);
  const positionsValue =
    explicit !== null
      ? explicit
      : positions.reduce(
          (sum, position) => sum + Math.max(0, finite(position.marketValueKrw) || 0),
          0
        );
  if (positionsValue > 0) return Math.min(1, positionsValue / equity);
  const cash = finite(account?.cashKrw);
  return cash === null ? 0 : Math.min(1, Math.max(0, (equity - cash) / equity));
}

function targetInvestedWeight(portfolio) {
  const explicit = finite(portfolio?.investedTargetWeight);
  if (explicit !== null) return Math.min(1, Math.max(0, explicit));
  return Math.min(
    1,
    Math.max(
      0,
      (portfolio?.selected || []).reduce(
        (sum, item) => sum + Math.max(0, finite(item.targetWeight) || 0),
        0
      )
    )
  );
}

function evaluationMap(portfolio) {
  return new Map(
    (portfolio?.evaluations || []).map((evaluation) => [
      evaluation.securityKey || portfolioSecurityKey(evaluation.company || evaluation),
      evaluation
    ])
  );
}

function nativePrice(item, selected = null, evaluation = null) {
  return positive(
    selected?.currentPrice ??
      evaluation?.quote?.price ??
      item?.currentPrice ??
      item?.price ??
      item?.lastPrice
  );
}

function priceKrw(item, selected = null, evaluation = null) {
  const direct = positive(
    selected?.currentPriceKrw ?? evaluation?.quote?.priceKrw ?? item?.currentPriceKrw ?? item?.priceKrw
  );
  if (direct) return direct;
  const quantity = positive(item?.quantity);
  const marketValue = positive(item?.marketValueKrw);
  if (quantity && marketValue) return marketValue / quantity;
  const price = nativePrice(item, selected, evaluation);
  return price;
}

function marketValueKrw(position, selected, evaluation) {
  return (
    finite(position?.marketValueKrw) ??
    ((positive(position?.quantity) || 0) * (priceKrw(position, selected, evaluation) || 0))
  );
}

function identity(source = {}) {
  return {
    id: String(source.id || ""),
    ticker: source.ticker,
    name: source.name,
    country: String(source.country || "KR").toUpperCase(),
    exchange: source.exchange,
    sector: source.sector || "미분류"
  };
}

function commonOrder({
  source,
  side,
  quantity,
  limitPrice,
  reason,
  notionalKrw
}) {
  return {
    ...identity(source),
    side,
    quantity,
    limitPrice,
    currency: "KRW",
    reason,
    estimatedNotionalKrw: notionalKrw
  };
}

function evaluationHasDataFailure(evaluation) {
  if (!evaluation) return false;
  if (evaluation.dataFailure === true) return true;
  if (evaluation.eligible) return false;
  const codes = evaluation.reasonCodes || [];
  return codes.some((code) => DATA_FAILURE_REASONS.has(code));
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

function bufferedCashPrice(price, side, buffer) {
  const raw = price * (side === "buy" ? 1 + buffer : 1 - buffer);
  const tick = tickSizeKrw(raw);
  return side === "buy"
    ? Math.ceil(raw / tick) * tick
    : Math.max(tick, Math.floor(raw / tick) * tick);
}

function estimatedCashAmount(candidate, quantity, side, policy) {
  const price = bufferedCashPrice(candidate.limitPrice, side, policy.limitPriceBuffer);
  const gross = quantity * price;
  const fee = Math.ceil(gross * policy.estimatedFeeRate);
  return side === "buy" ? gross + fee : Math.max(0, gross - fee);
}

function affordableBuyQuantity(candidate, maximumQuantity, availableCash, policy) {
  const unitPrice = bufferedCashPrice(
    candidate.limitPrice,
    "buy",
    policy.limitPriceBuffer
  );
  let quantity = Math.min(
    maximumQuantity,
    Math.floor(availableCash / (unitPrice * (1 + policy.estimatedFeeRate)))
  );
  while (quantity > 0 && estimatedCashAmount(candidate, quantity, "buy", policy) > availableCash) {
    quantity -= 1;
  }
  return quantity;
}

function applyTurnoverAndCashLimits(candidates, {
  equity,
  cashKrw,
  reserveKrw,
  maximumTurnoverKrw,
  maximumBuyTurnoverKrw = maximumTurnoverKrw,
  maximumSellTurnoverKrw = maximumTurnoverKrw,
  maximumOrders,
  policy,
  sweepCandidates = [],
  positionValues = new Map(),
  sectorValues = new Map(),
  positionKeys = new Set()
}) {
  const orders = [];
  const skipped = [];
  const residualBlockers = new Set();
  let remainingGrossTurnover = maximumTurnoverKrw;
  let remainingBuyTurnover = maximumBuyTurnoverKrw;
  let remainingSellTurnover = maximumSellTurnoverKrw;
  let buyTurnoverKrw = 0;
  let sellTurnoverKrw = 0;
  let availableCash = Math.max(0, cashKrw - reserveKrw);
  let estimatedCashAfterKrw = cashKrw;
  const nextPositionValues = new Map(positionValues);
  const nextSectorValues = new Map(sectorValues);
  const nextPositionKeys = new Set(positionKeys);
  const maximumPositionKrw = equity * policy.maximumPositionWeight;
  const maximumSectorKrw = equity * policy.maximumSectorWeight;

  for (const candidate of candidates) {
    if (orders.length >= maximumOrders) {
      skipped.push({ id: candidate.source.id, reason: "maximum_orders" });
      residualBlockers.add("maximum_orders");
      continue;
    }
    const remainingSideTurnover =
      candidate.side === "buy" ? remainingBuyTurnover : remainingSellTurnover;
    const turnoverQuantity = Math.floor(
      Math.min(remainingGrossTurnover, remainingSideTurnover) / candidate.priceKrw
    );
    let quantity = Math.min(candidate.quantity, turnoverQuantity);
    if (quantity <= 0) {
      skipped.push({ id: candidate.source.id, reason: "turnover_or_cash_limit" });
      residualBlockers.add("turnover_or_cash_limit");
      continue;
    }
    if (candidate.side === "buy") {
      const key = portfolioSecurityKey(candidate.source);
      const sector = String(candidate.source.sector || "미분류");
      if (
        !nextPositionKeys.has(key) &&
        nextPositionKeys.size >= policy.maximumPositions
      ) {
        skipped.push({ id: candidate.source.id, reason: "maximum_positions" });
        residualBlockers.add("maximum_positions");
        continue;
      }
      const bufferedUnitPrice = bufferedCashPrice(
        candidate.limitPrice,
        "buy",
        policy.limitPriceBuffer
      );
      const positionRoomKrw =
        maximumPositionKrw - (nextPositionValues.get(key) || 0);
      const sectorRoomKrw =
        maximumSectorKrw - (nextSectorValues.get(sector) || 0);
      const positionQuantity = Math.floor(
        Math.max(0, positionRoomKrw) / bufferedUnitPrice
      );
      const sectorQuantity = Math.floor(
        Math.max(0, sectorRoomKrw) / bufferedUnitPrice
      );
      if (positionQuantity <= 0 || sectorQuantity <= 0) {
        skipped.push({ id: candidate.source.id, reason: "position_weight_limit" });
        residualBlockers.add("position_weight_limit");
        continue;
      }
      quantity = Math.min(quantity, positionQuantity, sectorQuantity);
      quantity = affordableBuyQuantity(candidate, quantity, availableCash, policy);
    }
    if (quantity <= 0) {
      skipped.push({ id: candidate.source.id, reason: "turnover_or_cash_limit" });
      residualBlockers.add(
        candidate.side === "buy" && availableCash < policy.minimumOrderKrw
          ? "minimum_order"
          : "turnover_or_cash_limit"
      );
      continue;
    }
    let notionalKrw = quantity * candidate.priceKrw;
    const isCompleteRemoval =
      candidate.reason === "confirmed_removal" && quantity === candidate.quantity;
    if (notionalKrw < policy.minimumOrderKrw && !isCompleteRemoval) {
      skipped.push({ id: candidate.source.id, reason: "minimum_order" });
      residualBlockers.add("minimum_order");
      continue;
    }

    const order = commonOrder({
      source: candidate.source,
      side: candidate.side,
      quantity,
      limitPrice: candidate.limitPrice,
      reason: candidate.reason,
      notionalKrw
    });
    orders.push(order);
    remainingGrossTurnover -= notionalKrw;
    if (candidate.side === "sell") {
      remainingSellTurnover -= notionalKrw;
      sellTurnoverKrw += notionalKrw;
    } else {
      remainingBuyTurnover -= notionalKrw;
      buyTurnoverKrw += notionalKrw;
    }
    const cashAmount = estimatedCashAmount(candidate, quantity, candidate.side, policy);
    const key = portfolioSecurityKey(candidate.source);
    const sector = String(candidate.source.sector || "미분류");
    const bufferedExposureKrw =
      candidate.side === "buy"
        ? quantity * bufferedCashPrice(candidate.limitPrice, "buy", policy.limitPriceBuffer)
        : notionalKrw;
    const valueChange =
      candidate.side === "sell"
        ? policy.reuseProjectedSellProceeds
          ? -notionalKrw
          : 0
        : bufferedExposureKrw;
    nextPositionValues.set(key, Math.max(0, (nextPositionValues.get(key) || 0) + valueChange));
    nextSectorValues.set(sector, Math.max(0, (nextSectorValues.get(sector) || 0) + valueChange));
    if (candidate.side === "sell") {
      if (policy.reuseProjectedSellProceeds) {
        availableCash += cashAmount;
        if (isCompleteRemoval) nextPositionKeys.delete(key);
      }
      estimatedCashAfterKrw += cashAmount;
    } else {
      nextPositionKeys.add(key);
      availableCash -= cashAmount;
      estimatedCashAfterKrw -= cashAmount;
    }
  }

  // A zero target reserve should not leave an avoidable cash pile merely
  // because target quantities were rounded down. Add deterministic whole
  // shares, merging them into one order per security, while preserving every
  // position, sector, cash, turnover and order-count ceiling.
  const sweepQueue = [...sweepCandidates].sort(
    (left, right) =>
      (right.targetValueKrw - (nextPositionValues.get(portfolioSecurityKey(right.source)) || 0)) -
        (left.targetValueKrw - (nextPositionValues.get(portfolioSecurityKey(left.source)) || 0)) ||
      right.score - left.score ||
      String(left.source.id).localeCompare(String(right.source.id))
  );
  const buyOrders = new Map(
    orders
      .filter((order) => order.side === "buy")
      .map((order) => [portfolioSecurityKey(order), order])
  );
  const sellKeys = new Set(
    orders
      .filter((order) => order.side === "sell")
      .map((order) => portfolioSecurityKey(order))
  );
  let swept = true;
  while (
    swept &&
    availableCash > 0 &&
    remainingGrossTurnover > 0 &&
    remainingBuyTurnover > 0
  ) {
    swept = false;
    for (const candidate of sweepQueue) {
      const key = portfolioSecurityKey(candidate.source);
      if (sellKeys.has(key)) continue;
      const sector = String(candidate.source.sector || "미분류");
      const positionValue = nextPositionValues.get(key) || 0;
      const sectorValue = nextSectorValues.get(sector) || 0;
      const existingOrder = buyOrders.get(key);
      if (
        !existingOrder &&
        !nextPositionKeys.has(key) &&
        nextPositionKeys.size >= policy.maximumPositions
      ) {
        residualBlockers.add("maximum_positions");
        continue;
      }
      const minimumQuantity = existingOrder
        ? 1
        : Math.max(1, Math.ceil(policy.minimumOrderKrw / candidate.priceKrw));
      const rawNotional = minimumQuantity * candidate.priceKrw;
      const bufferedExposure =
        minimumQuantity *
        bufferedCashPrice(candidate.limitPrice, "buy", policy.limitPriceBuffer);
      if (positionValue >= candidate.targetValueKrw - 1) continue;
      if (rawNotional > remainingGrossTurnover + 1) {
        residualBlockers.add("turnover_or_cash_limit");
        continue;
      }
      if (rawNotional > remainingBuyTurnover + 1) {
        residualBlockers.add("turnover_or_cash_limit");
        continue;
      }
      if (positionValue + bufferedExposure > maximumPositionKrw + 1) {
        residualBlockers.add("position_weight_limit");
        continue;
      }
      if (sectorValue + bufferedExposure > maximumSectorKrw + 1) {
        residualBlockers.add("position_weight_limit");
        continue;
      }
      const cashCost = estimatedCashAmount(candidate, minimumQuantity, "buy", policy);
      if (cashCost > availableCash) {
        residualBlockers.add(
          availableCash < policy.minimumOrderKrw
            ? "minimum_order"
            : "turnover_or_cash_limit"
        );
        continue;
      }
      if (!existingOrder && orders.length >= maximumOrders) {
        residualBlockers.add("maximum_orders");
        continue;
      }

      if (existingOrder) {
        existingOrder.quantity += minimumQuantity;
        existingOrder.estimatedNotionalKrw += rawNotional;
      } else {
        const order = commonOrder({
          source: candidate.source,
          side: "buy",
          quantity: minimumQuantity,
          limitPrice: candidate.limitPrice,
          reason: "cash_excess_sweep",
          notionalKrw: rawNotional
        });
        orders.push(order);
        buyOrders.set(key, order);
      }
      nextPositionKeys.add(key);
      remainingGrossTurnover -= rawNotional;
      remainingBuyTurnover -= rawNotional;
      buyTurnoverKrw += rawNotional;
      availableCash -= cashCost;
      estimatedCashAfterKrw -= cashCost;
      nextPositionValues.set(key, positionValue + bufferedExposure);
      nextSectorValues.set(sector, sectorValue + bufferedExposure);
      swept = true;
    }
  }

  return {
    orders,
    skipped,
    turnoverKrw: buyTurnoverKrw + sellTurnoverKrw,
    turnoverWeight: equity ? (buyTurnoverKrw + sellTurnoverKrw) / equity : 0,
    buyTurnoverKrw,
    buyTurnoverWeight: equity ? buyTurnoverKrw / equity : 0,
    sellTurnoverKrw,
    sellTurnoverWeight: equity ? sellTurnoverKrw / equity : 0,
    residualBlockers: [...residualBlockers],
    resultingPositionCount: nextPositionKeys.size,
    availableCashAfterKrw: Math.max(0, availableCash),
    estimatedCashAfterKrw: Math.max(0, estimatedCashAfterKrw)
  };
}

function automaticCashResidualCode({
  active,
  availableCashAfterKrw,
  minimumOrderKrw,
  skipped,
  residualBlockers
}) {
  if (!active || availableCashAfterKrw <= 1) return null;
  const reasons = new Set([
    ...skipped.map((item) => item.reason),
    ...residualBlockers
  ]);
  if (
    reasons.has("replacement_waiting_for_removal_confirmation") ||
    reasons.has("maximum_orders") ||
    reasons.has("maximum_positions")
  ) {
    return "POSITION_LIMIT";
  }
  if (reasons.has("position_weight_limit")) return "POSITION_WEIGHT_LIMIT";
  if (
    reasons.has("minimum_order") ||
    availableCashAfterKrw < minimumOrderKrw
  ) {
    return "BELOW_MIN_ORDER";
  }
  if (reasons.has("turnover_or_cash_limit")) return "CASH_LIMIT";
  return "NO_ELIGIBLE_TARGET";
}

export function planMonthlyRebalance({
  portfolio,
  account,
  state = {},
  config = {},
  now,
  force = false,
  cashDeploymentOnly = false
} = {}) {
  const policy = normalizedConfig(config);
  const previousStrategy = strategyState(state);
  const previousStreaks = previousStrategy.removalStreaks || {};
  const unchangedState = clone(state) || {};
  const isoNow = new Date(now).toISOString();
  if (isoNow === "Invalid Date") throw new RangeError("올바른 now가 필요합니다.");

  if (
    !force &&
    !isRebalanceDue({
      now,
      lastPlanAt: previousStrategy.lastPlanAt,
      frequency: policy.rebalanceFrequency
    })
  ) {
    return {
      status: "not_due",
      orders: [],
      nextState: unchangedState,
      diagnostics: {
        reason:
          policy.rebalanceFrequency === "daily"
            ? "already_planned_today"
            : "already_planned_this_month",
        rebalanceFrequency: policy.rebalanceFrequency
      }
    };
  }
  if (!portfolio || portfolio.status !== "ready" || portfolio.deployable === false) {
    return {
      status: "blocked",
      orders: [],
      nextState: unchangedState,
      diagnostics: { reason: "portfolio_not_deployable", blockedReasons: portfolio?.blockedReasons || [] }
    };
  }

  const equity = positive(account?.totalEquityKrw);
  const cashKrw = finite(account?.cashKrw);
  if (!equity || cashKrw === null || cashKrw < 0) {
    return {
      status: "blocked",
      orders: [],
      nextState: unchangedState,
      diagnostics: { reason: "invalid_account" }
    };
  }

  const selected = portfolio.selected || [];
  const selectedByKey = new Map(
    selected.map((item) => [item.securityKey || portfolioSecurityKey(item), item])
  );
  const evaluations = evaluationMap(portfolio);
  const positions = positionsArray(account);
  const positionsByKey = new Map(
    positions.map((position) => [portfolioSecurityKey(position), position])
  );
  const positionValues = new Map();
  const sectorValues = new Map();
  const positionKeys = new Set();
  for (const position of positions) {
    const key = portfolioSecurityKey(position);
    const evaluation = evaluations.get(key);
    const value = Math.max(
      0,
      marketValueKrw(position, selectedByKey.get(key), evaluation)
    );
    const sector = String(position.sector || evaluation?.sector || "미분류");
    positionValues.set(key, value);
    sectorValues.set(sector, (sectorValues.get(sector) || 0) + value);
    if (
      (positive(position.quantity) || 0) > 0 ||
      value > 0
    ) {
      positionKeys.add(key);
    }
  }
  const nextStreaks = { ...previousStreaks };
  const candidates = [];
  const sweepCandidates = [];
  const skipped = [];
  let replacementSlotsWaiting = 0;
  const currentInvestedWeight = investedWeight(account, equity, positions);
  const portfolioTargetWeight = targetInvestedWeight(portfolio);
  const deploymentCompletionTolerance = Math.max(policy.rebalanceDrift, 0.01);
  const initialDeploymentCompleted =
    previousStrategy.initialDeploymentCompleted === true ||
    currentInvestedWeight + deploymentCompletionTolerance >= portfolioTargetWeight;
  const regularTurnoverCapWeight = initialDeploymentCompleted
    ? policy.maximumTurnoverWeight
    : policy.initialDeploymentTurnoverWeight;
  const turnoverCapWeight = cashDeploymentOnly
    ? Math.min(regularTurnoverCapWeight, cashKrw / equity)
    : regularTurnoverCapWeight;
  const reserveKrw =
    equity * Math.max(policy.reserveWeight, portfolio.cashTargetWeight || 0);
  const startingDeployableCashKrw = Math.max(0, cashKrw - reserveKrw);
  const cashDeploymentActive =
    !cashDeploymentOnly &&
    initialDeploymentCompleted &&
    policy.deployAvailableCash &&
    startingDeployableCashKrw > 0;
  const sellTurnoverCapKrw = equity * turnoverCapWeight;
  const buyTurnoverCapKrw = cashDeploymentActive
    ? Math.max(sellTurnoverCapKrw, startingDeployableCashKrw)
    : sellTurnoverCapKrw;
  // Preserve the legacy shared gross ceiling unless automatic cash
  // deployment is active. When active, buys funded by cash that existed at
  // plan start have their own budget, while sells keep the routine ceiling.
  const grossTurnoverCapKrw = cashDeploymentActive
    ? buyTurnoverCapKrw + sellTurnoverCapKrw
    : sellTurnoverCapKrw;

  if (!cashDeploymentOnly) {
    for (const selectedCompany of selected) {
      delete nextStreaks[selectedCompany.securityKey || portfolioSecurityKey(selectedCompany)];
      delete nextStreaks[selectedCompany.id];
    }

    for (const position of positions) {
      const id = String(position.id);
      const securityKey = portfolioSecurityKey(position);
      if (selectedByKey.has(securityKey)) continue;
      const evaluation = evaluations.get(securityKey);
      if (evaluationHasDataFailure(evaluation)) {
        skipped.push({ id, reason: "data_failure_is_not_sell_signal" });
        replacementSlotsWaiting += 1;
        continue;
      }
      const streak =
        (finite(previousStreaks[securityKey]) ?? finite(previousStreaks[id]) ?? 0) + 1;
      delete nextStreaks[id];
      nextStreaks[securityKey] = streak;
      if (streak < policy.removalConfirmations) {
        skipped.push({ id, reason: "removal_confirmation_pending", streak });
        replacementSlotsWaiting += 1;
        continue;
      }
      const quantity = Math.floor(positive(position.quantity) || 0);
      const evaluationCompany = evaluation?.company || {};
      const source = { ...evaluationCompany, ...position, id };
      const localPrice = priceKrw(position, null, evaluation);
      const limitPrice = nativePrice(position, null, evaluation);
      if (!quantity || !localPrice || !limitPrice) {
        skipped.push({ id, reason: "position_price_missing" });
        continue;
      }
      candidates.push({
        source,
        side: "sell",
        quantity,
        priceKrw: localPrice,
        limitPrice,
        reason: "confirmed_removal",
        priority: 0,
        score: evaluation?.score ?? -Infinity
      });
    }
  }

  for (const target of selected) {
    const securityKey = target.securityKey || portfolioSecurityKey(target);
    const position = positionsByKey.get(securityKey);
    if (!position && replacementSlotsWaiting > 0) {
      replacementSlotsWaiting -= 1;
      skipped.push({
        id: target.id,
        reason: "replacement_waiting_for_removal_confirmation"
      });
      continue;
    }
    const evaluation = evaluations.get(securityKey);
    const currentValue = position ? marketValueKrw(position, target, evaluation) : 0;
    const targetValue = equity * target.targetWeight;
    const difference = targetValue - currentValue;
    const differenceWeight = Math.abs(difference) / equity;
    const driftThreshold = Math.max(policy.rebalanceDrift, target.targetWeight * 0.2);
    const localPrice = positive(target.currentPriceKrw);
    const limitPrice = positive(target.currentPrice);
    if (!localPrice || !limitPrice) {
      skipped.push({ id: target.id, reason: "target_price_missing" });
      continue;
    }
    sweepCandidates.push({
      source: target,
      priceKrw: localPrice,
      limitPrice,
      targetValueKrw: targetValue,
      score: target.score ?? -Infinity
    });
    if (differenceWeight < driftThreshold) continue;
    const side = difference > 0 ? "buy" : "sell";
    if (cashDeploymentOnly && side === "sell") {
      skipped.push({ id: target.id, reason: "cash_deployment_buy_only" });
      continue;
    }
    let quantity = Math.floor(Math.abs(difference) / localPrice);
    if (side === "sell") quantity = Math.min(quantity, Math.floor(positive(position?.quantity) || 0));
    if (quantity <= 0) continue;
    candidates.push({
      source: target,
      side,
      quantity,
      priceKrw: localPrice,
      limitPrice,
      reason: side === "buy" ? "rebalance_underweight" : "rebalance_overweight",
      priority: side === "sell" ? 1 : 2,
      score: target.score ?? -Infinity
    });
  }

  candidates.sort(
    (left, right) =>
      left.priority - right.priority ||
      (right.quantity * right.priceKrw) - (left.quantity * left.priceKrw) ||
      right.score - left.score ||
      String(left.source.id).localeCompare(String(right.source.id))
  );

  const limited = applyTurnoverAndCashLimits(candidates, {
    equity,
    cashKrw,
    reserveKrw,
    maximumTurnoverKrw: grossTurnoverCapKrw,
    maximumBuyTurnoverKrw: buyTurnoverCapKrw,
    maximumSellTurnoverKrw: sellTurnoverCapKrw,
    maximumOrders: policy.maximumOrdersPerRun,
    policy,
    sweepCandidates,
    positionValues,
    sectorValues,
    positionKeys
  });
  const nextState = withStrategyState(
    state,
    cashDeploymentOnly
      ? {
          removalStreaks: previousStreaks,
          initialDeploymentCompleted: previousStrategy.initialDeploymentCompleted === true
        }
      : {
          lastPlanAt: isoNow,
          removalStreaks: nextStreaks,
          initialDeploymentCompleted
        }
  );
  const allSkipped = [...skipped, ...limited.skipped];
  const cashDeploymentResidualCode = automaticCashResidualCode({
    active: cashDeploymentActive,
    availableCashAfterKrw: limited.availableCashAfterKrw,
    minimumOrderKrw: policy.minimumOrderKrw,
    skipped: allSkipped,
    residualBlockers: limited.residualBlockers
  });

  return {
    status: "planned",
    orders: limited.orders,
    nextState,
    diagnostics: {
      candidates: candidates.length,
      skipped: allSkipped,
      turnoverKrw: limited.turnoverKrw,
      turnoverWeight: limited.turnoverWeight,
      turnoverCapWeight,
      buyTurnoverKrw: limited.buyTurnoverKrw,
      buyTurnoverWeight: limited.buyTurnoverWeight,
      buyTurnoverCapKrw,
      buyTurnoverCapWeight: buyTurnoverCapKrw / equity,
      sellTurnoverKrw: limited.sellTurnoverKrw,
      sellTurnoverWeight: limited.sellTurnoverWeight,
      sellTurnoverCapKrw,
      sellTurnoverCapWeight: sellTurnoverCapKrw / equity,
      grossTurnoverCapKrw,
      grossTurnoverCapWeight: grossTurnoverCapKrw / equity,
      deploymentPhase: initialDeploymentCompleted ? "routine" : "initial",
      currentInvestedWeight,
      targetInvestedWeight: portfolioTargetWeight,
      estimatedCashAfterKrw: limited.estimatedCashAfterKrw,
      reserveKrw,
      rebalanceFrequency: policy.rebalanceFrequency,
      reuseProjectedSellProceeds: policy.reuseProjectedSellProceeds,
      cashDeploymentActive,
      cashDeploymentResidualCode,
      cashDeploymentOnly
    }
  };
}

// Backward-compatible name: existing callers may keep importing
// planMonthlyRebalance while the configured cadence controls the due check.
export const planRebalance = planMonthlyRebalance;
