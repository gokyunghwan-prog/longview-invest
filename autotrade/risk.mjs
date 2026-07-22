import { createHash } from "node:crypto";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
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
      grossNotional += order.quantity * order.limitPrice;
    }
  }

  if (!finite(account?.totalEquityKrw) || account.totalEquityKrw <= 0) {
    reasons.push("계좌 순자산을 확인할 수 없습니다.");
  } else if (grossNotional > account.totalEquityKrw * config.risk.maximumTurnoverWeight + 1) {
    reasons.push("1회 허용 회전율을 초과했습니다.");
  }

  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    grossNotionalKrw: Math.round(grossNotional)
  };
}
