const TERMINAL_STATUSES = new Set([
  "filled",
  "canceled",
  "partial_canceled",
  "rejected",
  "blocked",
  "not_found"
]);

function clean(value) {
  return String(value ?? "").trim();
}

function integer(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function kstParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("주문 대조 시각이 올바르지 않습니다.");
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}${parts.month}${parts.day}`,
    time: `${parts.hour}${parts.minute}${parts.second}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function terminal(status, item) {
  return TERMINAL_STATUSES.has(status) && !(status === "blocked" && item?.notSent !== true);
}

function exactFallbackMatch(intent, order, created) {
  return (
    clean(order.ticker) === clean(intent.ticker) &&
    clean(order.side).toLowerCase() === clean(intent.side).toLowerCase() &&
    Number(order.quantity) === Number(intent.quantity) &&
    Number(order.limitPrice) === Number(intent.limitPrice) &&
    (!clean(order.orderDate) || clean(order.orderDate) === created.date) &&
    (!clean(order.orderTime) || clean(order.orderTime) >= created.time)
  );
}

function matchIntent(intent, orders, created) {
  const brokerOrderId = clean(intent.brokerOrderId);
  const matches = brokerOrderId
    ? orders.filter((order) => clean(order.brokerOrderId) === brokerOrderId)
    : orders.filter((order) => exactFallbackMatch(intent, order, created));
  if (matches.length === 1) return { match: matches[0], ambiguous: false };
  return { match: null, ambiguous: matches.length > 1 };
}

export function reconcileOrderIntents({ inFlight, brokerOrders = [], now = new Date() } = {}) {
  if (!inFlight || typeof inFlight !== "object" || !Array.isArray(inFlight.orders)) {
    throw new TypeError("대조할 미결 주문 실행이 필요합니다.");
  }
  if (!Array.isArray(brokerOrders)) throw new TypeError("KIS 주문내역 배열이 필요합니다.");
  const created = kstParts(inFlight.createdAt);
  const current = kstParts(now);
  const safelyPastSubmissionDay = current.date > created.date || current.minute >= 15 * 60 + 40;
  const updates = [];
  const cancelCandidates = [];
  let ambiguous = false;

  for (const intent of inFlight.orders) {
    const priorStatus = clean(intent.status) || "intent_persisted";
    if (terminal(priorStatus, intent)) {
      updates.push({ ...intent, status: priorStatus });
      continue;
    }

    const matched = matchIntent(intent, brokerOrders, created);
    if (matched.ambiguous) {
      ambiguous = true;
      updates.push({
        ...intent,
        status: "unknown",
        reconciliationCode: "ambiguous_broker_match"
      });
      continue;
    }

    if (!matched.match) {
      const missingChecks = integer(intent.missingChecks) + (safelyPastSubmissionDay ? 1 : 0);
      const confirmedMissing = safelyPastSubmissionDay && missingChecks >= 2;
      updates.push({
        ...intent,
        status: confirmedMissing ? "not_found" : priorStatus,
        missingChecks,
        reconciliationCode: confirmedMissing
          ? "not_found_after_two_post_close_checks"
          : "broker_order_not_yet_confirmed"
      });
      continue;
    }

    const order = matched.match;
    const status = clean(order.status).toLowerCase() || "unknown";
    const update = {
      ...intent,
      status,
      brokerOrderId: clean(order.brokerOrderId) || intent.brokerOrderId || null,
      branchNumber: clean(order.branchNumber) || intent.branchNumber || null,
      filledQuantity: integer(order.filledQuantity),
      remainingQuantity: integer(order.remainingQuantity),
      canceledQuantity: integer(order.canceledQuantity),
      averageFillPrice: Number.isFinite(Number(order.averageFillPrice))
        ? Number(order.averageFillPrice)
        : null,
      missingChecks: 0,
      reconciliationCode: "matched_broker_order"
    };
    updates.push(update);
    if (["submitted", "open", "partial"].includes(status) && update.remainingQuantity > 0) {
      cancelCandidates.push(update);
    }
    if (status === "unknown") ambiguous = true;
  }

  const allTerminal = updates.every((item) => terminal(item.status, item));
  return {
    updates,
    cancelCandidates,
    allTerminal,
    ambiguous,
    safelyPastSubmissionDay
  };
}

export function orderStatusIsTerminal(status, item = null) {
  return terminal(clean(status).toLowerCase(), item);
}
