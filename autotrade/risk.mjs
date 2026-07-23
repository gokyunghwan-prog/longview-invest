import { createHash } from "node:crypto";
import { portfolioSecurityKey } from "./strategy.mjs";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positionsArray(account) {
  if (Array.isArray(account?.positions)) return account.positions;
  if (account?.positions && typeof account.positions === "object") {
    return Object.values(account.positions);
  }
  return [];
}

function positivePosition(position) {
  return (
    (numeric(position?.quantity) || 0) > 0 ||
    (numeric(position?.marketValueKrw) || 0) > 0
  );
}

function positionValueKrw(position) {
  const direct = numeric(position?.marketValueKrw);
  if (direct !== null && direct >= 0) return direct;
  const quantity = numeric(position?.quantity);
  const price =
    numeric(position?.priceKrw) ??
    numeric(position?.price) ??
    numeric(position?.currentPriceKrw) ??
    numeric(position?.currentPrice);
  if (quantity !== null && quantity >= 0 && price !== null && price >= 0) {
    return quantity * price;
  }
  return null;
}

function ageDays(value, now) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return Infinity;
  return Math.max(0, (now.getTime() - timestamp) / 86_400_000);
}

export function redactSensitive(value, secrets = []) {
  let text = value instanceof Error ? value.message : String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      text = text.split(secret).join("[redacted]");
    }
  }
  return text
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[redacted]")
    .replace(/(app(?:key|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b\d{8}-?\d{2}\b/g, "[redacted-account]")
    .slice(0, 1_000);
}

export function buildCycleKey({
  signalRevision,
  modelVersion,
  strategyVersion,
  period,
  accountId,
  scope = ""
}) {
  const normalizedScope = String(scope || "").trim();
  // A confirmed one-shot operation must stay idempotent even if a later
  // workflow re-run observes a new signal revision, model, or KST period.
  // Bind its key only to the account and explicit scope. Keep the legacy
  // five-field byte sequence unchanged for normal scheduled cycles.
  const parts = normalizedScope
    ? ["scoped-cycle-v1", accountId, normalizedScope]
    : [signalRevision, modelVersion, strategyVersion, period, accountId];
  const raw = parts
    .map((item) => String(item || ""))
    .join("\u0000");
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

export function candidateCountForSignal(signal) {
  if (Array.isArray(signal?.candidateSummaries)) return signal.candidateSummaries.length;
  if (Array.isArray(signal?.candidates)) return signal.candidates.length;
  if (Array.isArray(signal?.companies)) return signal.companies.length;
  return null;
}

export function assessSignal(signal, config, { now = new Date(), previous = null } = {}) {
  const reasons = [];
  const candidateCount = candidateCountForSignal(signal);
  const candidateCountScope = [
    String(signal?.modelVersion || ""),
    String(config?.strategy?.version || "")
  ].join("\u0000");
  if (!signal || typeof signal !== "object") reasons.push("신호 응답이 없습니다.");
  if (signal?.health?.dataLoadStatus !== "ok") reasons.push("Longview 데이터 상태가 정상이 아닙니다.");
  if (signal?.modelVersion !== config.strategy.approvedModelVersion) {
    reasons.push(
      `승인되지 않은 점수모델입니다(${signal?.modelVersion || "없음"}).`
    );
  }
  const sourceUpdatedAt =
    signal?.sourceUpdatedAt || signal?.health?.updatedAt || signal?.fetchedAt;
  if (ageDays(sourceUpdatedAt, now) > config.strategy.maximumSnapshotAgeDays) {
    reasons.push("투자 신호 스냅샷이 허용 기간보다 오래되었습니다.");
  }
  if (!signal?.revision) reasons.push("신호 revision이 없습니다.");
  if (!Array.isArray(signal?.companies)) reasons.push("후보 회사 목록이 없습니다.");

  const approvedLegacyCandidateMigration =
    previous?.candidateCount === 3 &&
    previous?.candidateCountScope == null &&
    candidateCount === 12 &&
    signal?.modelVersion === "2.0.0" &&
    config?.strategy?.version === "longview-domestic-capital-aware-v2";
  if (
    previous?.candidateCount > 0 &&
    candidateCount !== null &&
    Math.abs(candidateCount - previous.candidateCount) / previous.candidateCount > 0.3 &&
    !approvedLegacyCandidateMigration
  ) {
    reasons.push("후보 수가 직전 실행보다 30% 넘게 변했습니다.");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    sourceUpdatedAt,
    candidateCount,
    candidateCountScope
  };
}

export function assessOrders(
  orders,
  account,
  config,
  { liveConfirmation = false, existingCycleKeys = new Set(), cycleKey = "" } = {}
) {
  const reasons = [];
  if (!Array.isArray(orders)) reasons.push("주문 목록 형식이 올바르지 않습니다.");
  const safeOrders = Array.isArray(orders) ? orders : [];
  if (safeOrders.length > config.risk.maximumOrdersPerRun) {
    reasons.push("1회 최대 주문 수를 초과했습니다.");
  }
  if (cycleKey && existingCycleKeys.has(cycleKey)) reasons.push("이미 처리한 실행 주기입니다.");
  if (config.mode === "disabled" && safeOrders.length > 0) reasons.push("자동매매가 비활성 상태입니다.");
  if (config.mode === "live" && !liveConfirmation) {
    reasons.push("실전 주문은 실행 시점의 추가 확인이 필요합니다.");
  }

  const ids = new Set();
  let grossNotional = 0;
  let grossBuyNotional = 0;
  let grossSellNotional = 0;
  let estimatedBuyCashKrw = 0;
  const buyNotionalByKey = new Map();
  const buyNotionalBySector = new Map();
  const buySectorByKey = new Map();
  const sellQuantityByKey = new Map();
  const minimumOrderKrw = numeric(config?.strategy?.minimumOrderKrw);
  const estimatedFeeRate = Math.max(
    0,
    numeric(config?.paper?.feeRate) ??
      numeric(config?.risk?.estimatedFeeRate) ??
      0
  );
  for (const order of safeOrders) {
    if (!order?.id || !order.ticker || !["buy", "sell"].includes(order.side)) {
      reasons.push("필수 주문 필드가 누락되었습니다.");
      continue;
    }
    const identity = `${order.id}\u0000${order.side}`;
    if (ids.has(identity)) reasons.push("같은 종목·방향의 중복 주문이 있습니다.");
    ids.add(identity);
    if (String(order.country || "").toUpperCase() !== "KR") {
      reasons.push("국내주식이 아닌 주문이 있습니다.");
    }
    if (!Number.isInteger(order.quantity) || order.quantity <= 0) {
      reasons.push("주문 수량은 양의 정수여야 합니다.");
    }
    if (!finite(order.limitPrice) || order.limitPrice <= 0 || order.orderType === "market") {
      reasons.push("모든 주문은 유효한 지정가여야 합니다.");
    }
    if (finite(order.quantity) && finite(order.limitPrice)) {
      const notional = order.quantity * order.limitPrice;
      grossNotional += notional;
      if (order.side === "buy") {
        grossBuyNotional += notional;
        if (minimumOrderKrw !== null && notional < Math.max(0, minimumOrderKrw)) {
          reasons.push("매수 주문금액이 최소 주문금액보다 작습니다.");
        }
        estimatedBuyCashKrw += notional + Math.ceil(notional * estimatedFeeRate);
        const key = portfolioSecurityKey(order);
        const sector = String(order.sector || "미분류");
        buyNotionalByKey.set(key, (buyNotionalByKey.get(key) || 0) + notional);
        buyNotionalBySector.set(
          sector,
          (buyNotionalBySector.get(sector) || 0) + notional
        );
        const previousSector = buySectorByKey.get(key);
        if (previousSector && previousSector !== sector) {
          reasons.push("같은 종목 매수 주문의 섹터 정보가 일치하지 않습니다.");
        }
        buySectorByKey.set(key, sector);
      }
      if (order.side === "sell") {
        grossSellNotional += notional;
        const key = portfolioSecurityKey(order);
        sellQuantityByKey.set(
          key,
          (sellQuantityByKey.get(key) || 0) + order.quantity
        );
      }
    }
  }

  if (!finite(account?.totalEquityKrw) || account.totalEquityKrw <= 0) {
    reasons.push("계좌 순자산을 확인할 수 없습니다.");
  } else {
    const equity = account.totalEquityKrw;
    const baseTurnoverWeight = Math.max(
      0,
      finite(config?.risk?.maximumTurnoverWeight)
        ? config.risk.maximumTurnoverWeight
        : 0
    );
    const reserveWeight = Math.max(
      0,
      finite(config?.strategy?.reserveWeight) ? config.strategy.reserveWeight : 0
    );
    const deployableCashWeight =
      config?.risk?.deployAvailableCash === true && finite(account?.cashKrw)
        ? Math.max(0, (account.cashKrw - equity * reserveWeight) / equity)
        : 0;
    const explicitBuyWeight = finite(config?.risk?.maximumBuyTurnoverWeight)
      ? Math.max(0, config.risk.maximumBuyTurnoverWeight)
      : null;
    const explicitSellWeight = finite(config?.risk?.maximumSellTurnoverWeight)
      ? Math.max(0, config.risk.maximumSellTurnoverWeight)
      : null;
    const maximumBuyTurnoverWeight =
      explicitBuyWeight ?? Math.max(baseTurnoverWeight, deployableCashWeight);
    const maximumSellTurnoverWeight =
      explicitSellWeight ?? baseTurnoverWeight;
    const hasSeparateTurnoverBudgets =
      config?.risk?.deployAvailableCash === true ||
      explicitBuyWeight !== null ||
      explicitSellWeight !== null;
    const maximumGrossTurnoverWeight = finite(
      config?.risk?.maximumGrossTurnoverWeight
    )
      ? Math.max(0, config.risk.maximumGrossTurnoverWeight)
      : hasSeparateTurnoverBudgets
        ? maximumBuyTurnoverWeight + maximumSellTurnoverWeight
        : baseTurnoverWeight;

    if (grossBuyNotional > equity * maximumBuyTurnoverWeight + 1) {
      reasons.push("1회 허용 매수 회전율을 초과했습니다.");
    }
    if (grossSellNotional > equity * maximumSellTurnoverWeight + 1) {
      reasons.push("1회 허용 매도 회전율을 초과했습니다.");
    }
    if (grossNotional > equity * maximumGrossTurnoverWeight + 1) {
      reasons.push("1회 허용 회전율을 초과했습니다.");
    }

    const currentKeys = new Set();
    const currentValuesByKey = new Map();
    const currentSectorByKey = new Map();
    const currentQuantityByKey = new Map();
    let unverifiablePositionValue = false;
    for (const position of positionsArray(account)) {
      if (!positivePosition(position)) continue;
      const key = portfolioSecurityKey(position);
      if (!key) continue;
      currentKeys.add(key);
      const quantity = numeric(position?.quantity);
      if (quantity !== null && quantity > 0) {
        currentQuantityByKey.set(
          key,
          (currentQuantityByKey.get(key) || 0) + quantity
        );
      }
      const value = positionValueKrw(position);
      if (value === null) {
        unverifiablePositionValue = true;
        continue;
      }
      currentValuesByKey.set(key, (currentValuesByKey.get(key) || 0) + value);
      const explicitSector = String(position?.sector || "").trim();
      if (explicitSector) currentSectorByKey.set(key, explicitSector);
    }

    const resultingKeys = new Set(currentKeys);
    const canReuseConfirmedSellResults =
      config?.risk?.reuseProjectedSellProceeds !== false &&
      config?.broker !== "kis";
    if (canReuseConfirmedSellResults) {
      for (const [key, sellQuantity] of sellQuantityByKey) {
        const currentQuantity = currentQuantityByKey.get(key);
        if (currentQuantity && sellQuantity >= currentQuantity) {
          resultingKeys.delete(key);
        }
      }
    }
    for (const key of buyNotionalByKey.keys()) resultingKeys.add(key);
    const maximumPositions = numeric(config?.strategy?.maximumPositions);
    if (
      maximumPositions !== null &&
      resultingKeys.size > Math.max(0, Math.floor(maximumPositions))
    ) {
      reasons.push("매수 후 최대 보유 종목 수를 초과합니다.");
    }

    if (buyNotionalByKey.size > 0 && unverifiablePositionValue) {
      reasons.push("보유 종목 노출액을 확인할 수 없어 매수 안전성을 검증할 수 없습니다.");
    }

    const maximumPositionWeight = numeric(
      config?.strategy?.maximumPositionWeight
    );
    if (maximumPositionWeight !== null) {
      const maximumPositionKrw = equity * Math.max(0, maximumPositionWeight);
      for (const [key, buyNotional] of buyNotionalByKey) {
        const worstCaseValue = (currentValuesByKey.get(key) || 0) + buyNotional;
        if (worstCaseValue > maximumPositionKrw + 1) {
          reasons.push("매수 후 종목 최대비중을 초과합니다.");
          break;
        }
      }
    }

    const currentSectorValues = new Map();
    let unknownSectorValueKrw = 0;
    for (const [key, value] of currentValuesByKey) {
      const sector = currentSectorByKey.get(key) || buySectorByKey.get(key);
      if (sector) {
        currentSectorValues.set(
          sector,
          (currentSectorValues.get(sector) || 0) + value
        );
      } else {
        unknownSectorValueKrw += value;
      }
    }
    const maximumSectorWeight = numeric(config?.strategy?.maximumSectorWeight);
    if (maximumSectorWeight !== null) {
      const maximumSectorKrw = equity * Math.max(0, maximumSectorWeight);
      for (const [sector, buyNotional] of buyNotionalBySector) {
        // KIS balances do not always carry sector metadata. Treat every
        // unclassified current holding as if it belonged to the touched
        // sector so the final guard cannot understate worst-case exposure.
        const worstCaseValue =
          (currentSectorValues.get(sector) || 0) +
          unknownSectorValueKrw +
          buyNotional;
        if (worstCaseValue > maximumSectorKrw + 1) {
          reasons.push("매수 후 섹터 최대비중을 초과합니다.");
          break;
        }
      }
    }

    const forbidProjectedSellProceeds =
      config?.broker === "kis" ||
      config?.risk?.reuseProjectedSellProceeds === false;
    if (forbidProjectedSellProceeds && grossBuyNotional > 0) {
      const startingCashKrw = numeric(account?.cashKrw);
      if (startingCashKrw === null) {
        reasons.push("시작 가용현금을 확인할 수 없어 매수를 중단합니다.");
      } else {
        const startingSpendableCashKrw = Math.max(
          0,
          startingCashKrw - equity * reserveWeight
        );
        if (estimatedBuyCashKrw > startingSpendableCashKrw) {
          reasons.push("매수 예정액이 수수료를 포함한 시작 가용현금을 초과합니다.");
        }
      }
    }
  }

  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    grossNotionalKrw: Math.round(grossNotional),
    grossBuyNotionalKrw: Math.round(grossBuyNotional),
    grossSellNotionalKrw: Math.round(grossSellNotional),
    estimatedBuyCashKrw: Math.round(estimatedBuyCashKrw)
  };
}
