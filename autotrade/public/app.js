const dom = Object.fromEntries(
  [
    "connection-dot", "connection-label", "mode-badge", "notice", "notice-text",
    "notice-close", "metric-mode", "metric-broker", "metric-equity", "metric-cash",
    "metric-cash-rate", "metric-positions", "metric-position-rule", "metric-last-run",
    "metric-last-result", "action-guidance", "refresh-button", "plan-button",
    "paper-run-button", "lock-state", "policy-list", "signal-health", "signal-model",
    "signal-updated", "signal-count", "signal-revision", "block-panel", "risk-badge",
    "blocked-empty", "blocked-list", "risk-summary", "risk-order-count", "risk-gross",
    "risk-turnover", "risk-cash-after", "portfolio-count", "portfolio-body", "orders-count", "orders-body",
    "results-time", "results-body", "busy-overlay", "busy-title", "busy-message"
  ].map((id) => [id, document.getElementById(id)])
);

const app = {
  status: null,
  plan: null,
  account: null,
  csrfToken: "",
  busy: false
};

const BLOCKED_LABELS = {
  insufficient_eligible_candidates: "투자 기준을 통과한 후보가 최소 종목 수보다 적습니다.",
  insufficient_capital: "설정된 최소 주문금액을 충족하기에 모의 자산이 부족합니다.",
  insufficient_feasible_positions: "분산 한도와 주문 단위를 함께 만족하는 종목 수가 부족합니다.",
  disabled: "자동매매 모드가 비활성 상태입니다.",
  stale_signal: "Longview 투자 신호가 허용된 최신성 기준을 넘었습니다.",
  duplicate_cycle: "동일한 데이터 주기로 이미 처리한 계획입니다.",
  risk_check_failed: "주문 전 안전 점검을 통과하지 못했습니다.",
  already_planned_this_month: "이번 달 리밸런싱 계획이 이미 처리되었습니다.",
  portfolio_not_deployable: "현재 후보로는 안전한 분산 포트폴리오를 구성할 수 없습니다.",
  invalid_account: "모의계좌의 현금 또는 총자산을 확인할 수 없습니다."
};

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function finite(...values) {
  const value = values.find((candidate) => Number.isFinite(Number(candidate)));
  return value === undefined ? null : Number(value);
}

function unwrap(payload) {
  if (!payload || typeof payload !== "object") return {};
  return payload.data && typeof payload.data === "object" ? { ...payload, ...payload.data } : payload;
}

function money(value) {
  const amount = finite(value);
  if (amount === null) return "—";
  try {
    return new Intl.NumberFormat("ko-KR", {
      style: "currency",
      currency: "KRW",
      maximumFractionDigits: 0
    }).format(amount);
  } catch {
    return `${amount.toLocaleString("ko-KR")}원`;
  }
}

function number(value, suffix = "") {
  const parsed = finite(value);
  return parsed === null ? "—" : `${parsed.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}${suffix}`;
}

function percent(value, inputIsRatio = false) {
  const parsed = finite(value);
  if (parsed === null) return "—";
  const normalized = inputIsRatio || Math.abs(parsed) <= 1 ? parsed * 100 : parsed;
  return `${normalized.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%`;
}

function dateTime(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(parsed);
}

function text(value, fallback = "—") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function setText(target, value) {
  if (target) target.textContent = text(value);
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = text(content, "");
  return node;
}

function tableCell(content, className = "") {
  return element("td", className, content);
}

function companyCell(item) {
  const cell = element("td", "company-cell");
  cell.append(
    element("strong", "", first(item.name, item.companyName, item.ticker, item.id, "알 수 없는 기업")),
    element("small", "", first(item.ticker, item.symbol, item.stockCode, item.id, "—"))
  );
  return cell;
}

function showNotice(message, kind = "info") {
  dom.notice.hidden = false;
  dom.notice.className = `notice notice-${kind}`;
  setText(dom["notice-text"], message);
  const icon = dom.notice.querySelector(".notice-icon");
  if (icon) icon.textContent = kind === "success" ? "✓" : kind === "error" ? "!" : "i";
}

function setBusy(busy, title = "처리 중", message = "잠시만 기다려 주세요.") {
  app.busy = busy;
  dom["busy-overlay"].hidden = !busy;
  setText(dom["busy-title"], title);
  setText(dom["busy-message"], message);
  updateButtons();
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    if (app.csrfToken) headers["X-Longview-CSRF"] = app.csrfToken;
  }

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin"
  });
  const raw = await response.text();
  let payload = {};
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch { payload = { message: raw }; }
  }
  if (!response.ok) {
    const message = first(payload.message, payload.error, payload.reason, `요청 실패 (${response.status})`);
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  return unwrap(payload);
}

function modeOf(status = app.status) {
  return String(first(status?.config?.mode, status?.mode, "disabled")).toLowerCase();
}

function accountOf(status = app.status) {
  const state = status?.state || {};
  return first(status?.account, app.account, state.account, state.paper?.account, status?.paperAccount, {
    cashKrw: state.paper?.cashKrw,
    positions: state.paper?.positions
  }) || {};
}

function positionsOf(account) {
  return asArray(first(account?.positions, app.status?.state?.paper?.positions, []));
}

function equityOf(account) {
  const positions = positionsOf(account);
  const positionsValue = finite(account.positionsValueKrw) ?? positions.reduce((sum, item) => {
    const value = finite(item.marketValueKrw, item.marketValue, item.valueKrw);
    if (value !== null) return sum + value;
    const quantity = finite(item.quantity) ?? 0;
    const price = finite(item.price, item.lastPrice, item.averagePrice) ?? 0;
    return sum + quantity * price;
  }, 0);
  return finite(account.totalEquityKrw, account.equityKrw, account.totalAssetsKrw) ??
    ((finite(account.cashKrw, app.status?.state?.paper?.cashKrw) ?? 0) + positionsValue);
}

function lastRunOf(status = app.status) {
  const runs = asArray(status?.state?.runs);
  return first(status?.lastRun, runs.at(-1), null);
}

function renderConnection(online) {
  dom["connection-dot"].className = `connection-dot ${online ? "online" : "offline"}`;
  setText(dom["connection-label"], online ? "서버 연결됨" : "서버 연결 안 됨");
}

function renderMode(status) {
  const mode = modeOf(status);
  const labels = { disabled: "비활성", paper: "모의투자", live: "실전 설정" };
  const badgeLabels = { disabled: "DISABLED", paper: "PAPER", live: "LIVE · UI LOCKED" };
  setText(dom["metric-mode"], labels[mode] || mode.toUpperCase());
  setText(dom["metric-broker"], `브로커 ${text(first(status.config?.broker, status.broker), "—").toUpperCase()}`);
  dom["mode-badge"].className = `mode-badge mode-${["disabled", "paper", "live"].includes(mode) ? mode : "disabled"}`;
  setText(dom["mode-badge"], badgeLabels[mode] || mode.toUpperCase());

  for (const name of ["disabled", "paper", "live"]) {
    const step = document.getElementById(`mode-step-${name}`);
    step.classList.toggle("active", name === mode);
    step.classList.toggle("danger", name === "live");
  }

  const liveLocked = first(status.config?.liveOrderLocked, status.liveOrderLocked, true) !== false;
  dom["lock-state"].className = `lock-state ${liveLocked ? "locked" : "unlocked"}`;
  setText(dom["lock-state"], liveLocked ? "실전 잠금 ON" : "서버 실전잠금 해제 · UI는 차단");
}

function renderAccount(status) {
  const account = accountOf(status);
  const cash = finite(account.cashKrw, status.state?.paper?.cashKrw) ?? 0;
  const equity = equityOf(account);
  const positions = positionsOf(account);
  const strategy = status.config?.strategy || {};

  setText(dom["metric-equity"], money(equity));
  setText(dom["metric-cash"], money(cash));
  setText(dom["metric-cash-rate"], equity > 0 ? `대기자금 ${percent(cash / equity, true)}` : "대기자금 —");
  setText(dom["metric-positions"], `${positions.length}개`);
  const min = finite(strategy.minimumPositions);
  const max = finite(strategy.maximumPositions);
  setText(dom["metric-position-rule"], min !== null && max !== null ? `목표 ${min}–${max}개` : "목표 범위 —");
}

function renderLastRun(status) {
  const run = lastRunOf(status);
  if (!run) {
    setText(dom["metric-last-run"], "없음");
    setText(dom["metric-last-result"], "아직 실행 전");
    return;
  }
  const at = first(run.finishedAt, run.completedAt, run.at, run.startedAt, run.createdAt);
  let results = asArray(first(run.results, run.orders, []));
  if (!results.length && Array.isArray(run.resultStatuses)) {
    results = run.resultStatuses.map((resultStatus) => ({ status: resultStatus }));
  }
  const filled = results.filter((item) => ["filled", "success", "executed"].includes(String(item.status).toLowerCase())).length;
  const orderCount = finite(run.orderCount) ?? results.length;
  setText(dom["metric-last-run"], dateTime(at));
  setText(
    dom["metric-last-result"],
    results.length
      ? `모의체결 ${filled}/${orderCount}건`
      : run.blockedReasons?.length
        ? `차단 ${run.blockedReasons.length}건`
        : orderCount
          ? `주문계획 ${orderCount}건`
          : text(first(run.status, run.type), "주문 없음")
  );
}

function policyValue(config, path, fallback = "—") {
  const value = path.reduce((current, key) => current?.[key], config);
  return value === undefined || value === null ? fallback : value;
}

function renderPolicy(status) {
  const config = status.config || {};
  const strategy = config.strategy || {};
  const risk = config.risk || {};
  const entries = [
    ["대상 시장", "한국 KOSPI · KOSDAQ"],
    ["최소 종합점수", number(strategy.minimumScore, "점")],
    ["최소 신뢰도", number(strategy.minimumConfidence, "%")],
    ["목표 종목 수", finite(strategy.minimumPositions) !== null ? `${strategy.minimumPositions}–${strategy.maximumPositions}개` : "—"],
    ["현금 보유", percent(strategy.reserveWeight, true)],
    ["종목당 최대", percent(strategy.maximumPositionWeight, true)],
    ["1회 최대 회전율", percent(risk.maximumTurnoverWeight, true)]
  ];
  const rows = [...dom["policy-list"].children];
  entries.forEach(([label, value], index) => {
    if (!rows[index]) return;
    rows[index].querySelector("dt").textContent = label;
    rows[index].querySelector("dd").textContent = value;
  });
}

function signalOf(plan = app.plan, status = app.status) {
  return first(plan?.signal, status?.signal, status?.lastPlan?.signal, {}) || {};
}

function renderSignal(signal) {
  const companies = asArray(first(signal.companies, signal.candidates, []));
  const candidateCount = finite(signal.candidateCount) ?? companies.length;
  const healthOk = first(signal.health?.dataLoadStatus, signal.status) === "ok" || Boolean(signal.revision);
  dom["signal-health"].className = `mini-badge ${healthOk ? "good" : "neutral"}`;
  setText(dom["signal-health"], healthOk ? "정상" : "대기");
  setText(dom["signal-model"], first(signal.modelVersion, signal.scoringVersion, "—"));
  setText(dom["signal-updated"], dateTime(first(signal.sourceUpdatedAt, signal.health?.updatedAt, signal.fetchedAt, signal.updatedAt)));
  setText(dom["signal-count"], Number.isFinite(candidateCount) ? `${candidateCount.toLocaleString("ko-KR")}개` : "—");
  setText(dom["signal-revision"], signal.revision ? String(signal.revision).slice(0, 14) : "—");
}

function renderStatus(status) {
  app.status = status;
  app.account = first(status.account, status.state?.account, null);
  app.csrfToken = text(first(status.csrfToken, status.csrf, status.token), "");
  renderConnection(true);
  renderMode(status);
  renderAccount(status);
  renderLastRun(status);
  renderPolicy(status);
  renderSignal(signalOf(null, status));
  const mode = modeOf(status);
  setText(dom["action-guidance"], mode === "paper"
    ? "계획 생성 후 안전 점검을 통과한 주문만 모의계좌에서 실행할 수 있습니다."
    : mode === "live"
      ? "서버가 실전 모드여도 이 화면에서는 계획 확인만 가능하며, 모든 실행 버튼을 잠급니다."
      : "자동매매가 비활성입니다. 계획은 확인할 수 있지만 주문 실행은 잠겨 있습니다.");
  updateButtons();
}

function portfolioOf(plan) {
  const portfolio = first(plan?.portfolio, plan?.allocation, plan?.targets, []);
  const selected = asArray(first(
    portfolio?.selected,
    portfolio?.positions,
    portfolio?.targets,
    portfolio?.companies,
    Array.isArray(portfolio) ? portfolio : []
  ));
  const targetWeights = portfolio?.targetWeights || {};
  const account = first(plan?.account, app.account, {});
  const equity = equityOf(account);
  const positionMap = new Map(
    positionsOf(account).flatMap((position) => {
      const keys = [position.id, position.securityKey, position.ticker]
        .filter(Boolean)
        .map((key) => String(key));
      return keys.map((key) => [key, position]);
    })
  );
  return selected.map((item) => {
    if (!item || typeof item !== "object") return {};
    const targetWeight = finite(item.targetWeight, item.weight, targetWeights[item.id]);
    const position = [item.id, item.securityKey, item.ticker]
      .filter(Boolean)
      .map((key) => positionMap.get(String(key)))
      .find(Boolean);
    const marketValue = finite(position?.marketValueKrw) ??
      ((finite(position?.quantity) ?? 0) *
        (finite(position?.price, position?.lastPrice, position?.averagePrice) ?? 0));
    return {
      ...item,
      targetWeight,
      currentWeight: finite(item.currentWeight) ?? (equity > 0 ? marketValue / equity : null)
    };
  });
}

function ordersOf(plan) {
  return asArray(first(plan?.orders, plan?.orderPlan, []));
}

function blockedReasonsOf(plan) {
  const direct = asArray(first(plan?.blockedReasons, plan?.risk?.reasons, plan?.blockReasons, []));
  return direct.map((reason) => {
    if (typeof reason === "string") return BLOCKED_LABELS[reason] || reason;
    return first(reason.message, reason.reason, reason.code, JSON.stringify(reason));
  });
}

function weightOf(item, kind) {
  const ratio = kind === "target"
    ? finite(item.targetWeight, item.weight, item.allocationWeight, item.targetPercent)
    : finite(item.currentWeight, item.currentPercent, item.actualWeight);
  if (ratio === null) return null;
  return Math.abs(ratio) <= 1 ? ratio : ratio / 100;
}

function renderPortfolio(plan) {
  const portfolio = portfolioOf(plan);
  dom["portfolio-body"].replaceChildren();
  setText(dom["portfolio-count"], `${portfolio.length}개 종목`);
  if (!portfolio.length) {
    const row = element("tr", "empty-row");
    const cell = tableCell("안전 기준을 만족해 선택된 종목이 없습니다.");
    cell.colSpan = 7;
    row.append(cell);
    dom["portfolio-body"].append(row);
    return;
  }

  portfolio.forEach((item, index) => {
    const row = document.createElement("tr");
    const market = first(item.exchange, item.market, "국내");
    const sector = first(item.sector, item.industry, "미분류");
    const currentWeight = weightOf(item, "current");
    const targetWeight = weightOf(item, "target");
    const marketCell = document.createElement("td");
    marketCell.append(element("span", "market-chip", market), document.createTextNode(` ${sector}`));
    const barCell = document.createElement("td");
    const bar = element("div", "allocation-bar");
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(0, Math.min(100, (targetWeight ?? 0) * 100))}%`;
    bar.append(fill);
    barCell.append(bar);
    row.append(
      tableCell(String(first(item.rank, item.signalRank, index + 1)).padStart(2, "0")),
      companyCell(item),
      marketCell,
      tableCell(number(first(item.score, item.totalScore), "점"), "number"),
      tableCell(currentWeight === null ? "—" : percent(currentWeight, true), "number"),
      tableCell(targetWeight === null ? "—" : percent(targetWeight, true), "number"),
      barCell
    );
    dom["portfolio-body"].append(row);
  });
}

function renderOrders(plan) {
  const orders = ordersOf(plan);
  dom["orders-body"].replaceChildren();
  setText(dom["orders-count"], `${orders.length}건`);
  if (!orders.length) {
    const row = element("tr", "empty-row");
    const cell = tableCell("현재 비중이 목표 범위 안이거나, 생성 가능한 주문이 없습니다.");
    cell.colSpan = 7;
    row.append(cell);
    dom["orders-body"].append(row);
    return;
  }

  orders.forEach((order) => {
    const row = document.createElement("tr");
    const side = String(first(order.side, order.action, "hold")).toLowerCase();
    const sideLabel = side === "buy" ? "매수" : side === "sell" ? "매도" : "유지";
    const sideCell = document.createElement("td");
    sideCell.append(element("span", `side-chip side-${side === "sell" ? "sell" : "buy"}`, sideLabel));
    const quantity = finite(order.quantity, order.qty);
    const price = finite(order.limitPrice, order.price);
    const estimated = finite(
      order.estimatedNotionalKrw,
      order.notionalKrw,
      order.estimatedAmountKrw
    ) ??
      (quantity !== null && price !== null ? quantity * price : null);
    row.append(
      sideCell,
      companyCell(order),
      tableCell(first(order.orderType, "limit") === "limit" ? "지정가" : text(order.orderType)),
      tableCell(number(quantity), "number"),
      tableCell(money(price), "number"),
      tableCell(money(estimated), "number"),
      tableCell(first(order.reason, order.note, order.rationale, "목표 비중 조정"))
    );
    dom["orders-body"].append(row);
  });
}

function renderRisk(plan) {
  const reasons = blockedReasonsOf(plan);
  const risk = plan?.risk || {};
  const orders = ordersOf(plan);
  const explicitlyOk = first(risk.orders?.ok, risk.ok, plan?.ok, reasons.length === 0) === true;
  const blocked = reasons.length > 0 || explicitlyOk === false;
  dom["block-panel"].className = `panel block-panel ${blocked ? "blocked" : "clear"}`;
  dom["risk-badge"].className = `mini-badge ${blocked ? "bad" : "good"}`;
  setText(dom["risk-badge"], blocked ? "주문 차단" : "안전 점검 통과");
  dom["blocked-empty"].hidden = true;
  dom["blocked-list"].hidden = false;
  dom["blocked-list"].replaceChildren();
  const items = blocked ? reasons : ["현재 계획은 설정된 주문 전 안전 기준을 통과했습니다."];
  items.forEach((reason) => dom["blocked-list"].append(element("li", blocked ? "" : "pass", reason)));

  const gross = finite(
    risk.orders?.grossNotionalKrw,
    risk.grossNotionalKrw,
    plan?.planner?.diagnostics?.turnoverKrw,
    plan?.grossNotionalKrw
  ) ?? orders.reduce((sum, order) => {
    const quantity = finite(order.quantity) ?? 0;
    const price = finite(order.limitPrice, order.price) ?? 0;
    return sum + quantity * price;
  }, 0);
  const equity = equityOf(accountOf());
  const turnover = finite(
    risk.turnoverWeight,
    plan?.planner?.diagnostics?.turnoverWeight
  ) ?? (equity > 0 ? gross / equity : null);
  dom["risk-summary"].hidden = false;
  setText(dom["risk-order-count"], `${orders.length}건`);
  setText(dom["risk-gross"], money(gross));
  setText(dom["risk-turnover"], turnover === null ? "—" : percent(turnover, true));
  const estimatedCashAfter = finite(plan?.planner?.diagnostics?.estimatedCashAfterKrw);
  setText(
    dom["risk-cash-after"],
    estimatedCashAfter === null ? "—" : money(estimatedCashAfter)
  );
}

function renderPlan(plan) {
  app.plan = plan;
  if (plan?.account && typeof plan.account === "object") {
    app.account = plan.account;
    renderAccount({ ...(app.status || {}), account: plan.account });
  }
  renderSignal(signalOf(plan));
  renderPortfolio(plan);
  renderOrders(plan);
  renderRisk(plan);
  updateButtons();
}

function renderResults(payload) {
  let results = asArray(first(payload?.results, payload?.run?.results, payload?.orders, []));
  if (!results.length && Array.isArray(payload?.resultStatuses)) {
    results = payload.resultStatuses.map((status) => ({ status, message: "요약 기록" }));
  }
  const at = first(payload?.finishedAt, payload?.run?.finishedAt, payload?.at, new Date().toISOString());
  setText(dom["results-time"], dateTime(at));
  dom["results-body"].replaceChildren();
  if (!results.length) {
    const row = element("tr", "empty-row");
    const cell = tableCell("실행 요청은 완료됐지만 처리된 모의주문이 없습니다.");
    cell.colSpan = 7;
    row.append(cell);
    dom["results-body"].append(row);
    return;
  }

  results.forEach((result) => {
    const row = document.createElement("tr");
    const status = String(first(result.status, result.result, "unknown")).toLowerCase();
    const success = ["filled", "success", "executed"].includes(status);
    const rejected = ["rejected", "failed", "error", "blocked"].includes(status);
    const statusCell = document.createElement("td");
    statusCell.append(element(
      "span",
      `result-chip ${success ? "result-filled" : rejected ? "result-rejected" : "result-other"}`,
      success ? "체결" : rejected ? "거절" : text(status).toUpperCase()
    ));
    const side = String(first(result.side, result.action, "—")).toLowerCase();
    row.append(
      statusCell,
      companyCell(result),
      tableCell(side === "buy" ? "매수" : side === "sell" ? "매도" : text(side)),
      tableCell(number(first(result.filledQuantity, result.quantity)), "number"),
      tableCell(money(first(result.filledPrice, result.limitPrice, result.price)), "number"),
      tableCell(money(first(result.feeKrw, result.fee, 0)), "number"),
      tableCell(first(result.reason, result.message, success ? "모의체결 완료" : "—"))
    );
    dom["results-body"].append(row);
  });
}

function planIsBlocked() {
  if (!app.plan) return true;
  const reasons = blockedReasonsOf(app.plan);
  return reasons.length > 0 || first(app.plan.risk?.ok, app.plan.ok, true) === false;
}

function updateButtons() {
  const mode = modeOf();
  const online = Boolean(app.status);
  dom["refresh-button"].disabled = app.busy;
  dom["plan-button"].disabled = app.busy || !online || !app.csrfToken;
  dom["paper-run-button"].disabled =
    app.busy || mode !== "paper" || !app.plan || planIsBlocked() || ordersOf(app.plan).length === 0;
  dom["paper-run-button"].title = mode === "live"
    ? "실전 모드에서는 이 화면의 실행 기능이 항상 잠깁니다."
    : mode !== "paper"
      ? "모의투자 모드에서만 실행할 수 있습니다."
      : planIsBlocked()
        ? "안전 점검을 통과한 계획이 필요합니다."
        : "실제 돈을 사용하지 않는 모의계좌에서만 실행합니다.";
}

async function loadStatus({ quiet = false } = {}) {
  if (!quiet) setBusy(true, "상태 확인 중", "설정과 모의계좌 상태를 안전하게 불러옵니다.");
  try {
    const status = await api("/api/status");
    renderStatus(status);
    const lastRun = lastRunOf(status);
    if (lastRun && (lastRun.results || lastRun.resultStatuses)) renderResults(lastRun);
    if (!quiet) showNotice("최신 서버 상태를 불러왔습니다. 실전 주문 기능은 제공되지 않습니다.", "success");
  } catch (error) {
    app.status = null;
    app.csrfToken = "";
    renderConnection(false);
    updateButtons();
    showNotice(`서버 상태를 불러오지 못했습니다: ${error.message}`, "error");
  } finally {
    if (!quiet) setBusy(false);
  }
}

async function createPlan() {
  setBusy(true, "투자 계획 생성 중", "최신 신호에 분산·유동성·회전율 안전 기준을 적용합니다.");
  try {
    const plan = await api("/api/plan", { method: "POST", body: {} });
    renderPlan(first(plan.plan, plan));
    const blocked = planIsBlocked();
    showNotice(
      blocked
        ? "계획은 생성됐지만 안전 기준에 따라 주문이 차단되었습니다. 차단 사유를 확인하세요."
        : "투자 계획이 생성됐습니다. 종목·목표 비중·주문 계획을 확인한 뒤 모의실행할 수 있습니다.",
      blocked ? "warning" : "success"
    );
  } catch (error) {
    showNotice(`계획을 생성하지 못했습니다: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
}

async function runPaper() {
  if (modeOf() !== "paper") {
    showNotice("모의투자 모드에서만 paper-run을 실행할 수 있습니다.", "warning");
    return;
  }
  if (!app.plan || planIsBlocked()) {
    showNotice("먼저 안전 점검을 통과한 투자 계획을 생성하세요.", "warning");
    return;
  }
  setBusy(true, "모의주문 실행 중", "실제 돈이 아닌 가상 잔고에만 주문을 반영합니다.");
  try {
    const payload = await api("/api/paper-run", { method: "POST", body: {} });
    renderResults(payload);
    showNotice("모의주문 실행이 끝났습니다. 체결·거절 결과와 변경된 가상 잔고를 확인하세요.", "success");
    await loadStatus({ quiet: true });
  } catch (error) {
    showNotice(`모의주문을 실행하지 못했습니다: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
}

dom["notice-close"].addEventListener("click", () => { dom.notice.hidden = true; });
dom["refresh-button"].addEventListener("click", () => loadStatus());
dom["plan-button"].addEventListener("click", createPlan);
dom["paper-run-button"].addEventListener("click", runPaper);

loadStatus();
