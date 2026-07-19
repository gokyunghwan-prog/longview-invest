const state = {
  overview: null,
  companies: [],
  methodology: null,
  pagination: {
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 0,
    hasPrevious: false,
    hasNext: false
  },
  revision: null,
  listRequest: null,
  listSequence: 0,
  detailRequest: null,
  detailSequence: 0,
  detailCache: new Map(),
  filters: {
    query: "",
    country: "ALL",
    sector: "ALL",
    sort: "score",
    candidateOnly: false
  }
};

const elements = {
  companyList: document.querySelector("#company-list"),
  resultCount: document.querySelector("#result-count"),
  searchInput: document.querySelector("#search-input"),
  sectorSelect: document.querySelector("#sector-select"),
  sortSelect: document.querySelector("#sort-select"),
  candidateOnly: document.querySelector("#candidate-only"),
  countryTabs: [...document.querySelectorAll("[data-country]")],
  companyDialog: document.querySelector("#company-dialog"),
  companyDialogContent: document.querySelector("#company-dialog-content"),
  methodDialog: document.querySelector("#method-dialog"),
  methodGroups: document.querySelector("#method-groups"),
  toast: document.querySelector("#toast"),
  dataAlert: document.querySelector("#data-alert"),
  dataAlertTitle: document.querySelector("#data-alert-title"),
  dataAlertMessage: document.querySelector("#data-alert-message"),
  pagination: document.querySelector("#results-pagination"),
  pageNumbers: document.querySelector("#page-numbers"),
  pageStatus: document.querySelector("#page-status"),
  previousPage: document.querySelector("#page-previous"),
  nextPage: document.querySelector("#page-next")
};

const METRIC_LABELS = {
  roe: "ROE",
  operatingMargin: "영업이익률",
  netMargin: "순이익률",
  revenueGrowth: "매출 성장률",
  operatingIncomeGrowth: "영업이익 성장률",
  debtRatio: "부채비율",
  currentRatio: "유동비율",
  fcfMargin: "FCF 마진",
  cashConversion: "현금 전환율",
  positiveIncomeYears: "흑자 연도",
  revenueStability: "매출 안정성",
  disclosureRecencyDays: "최근 공시 경과일",
  amendmentCount: "정정 공시",
  per: "PER"
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? escapeHtml(url.href) : "#";
  } catch {
    return "#";
  }
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatMetric(value, type = "percent") {
  if (!isNumber(value)) return '<span class="missing">—</span>';
  const formatted = new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 1
  }).format(value);
  if (type === "years") return formatted + "년";
  if (type === "multiple") return formatted + "배";
  if (type === "days") return formatted + "일";
  return formatted + "%";
}

function plainMetric(value, type = "percent") {
  if (!isNumber(value)) return "—";
  const formatted = new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 1
  }).format(value);
  if (type === "years") return formatted + "년";
  if (type === "multiple") return formatted + "배";
  if (type === "days") return formatted + "일";
  return formatted + "%";
}

function formatPrice(value, currency) {
  if (!isNumber(value)) return "—";
  try {
    return new Intl.NumberFormat("ko-KR", {
      style: "currency",
      currency: currency || "USD",
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: currency === "KRW" ? 0 : 2
    }).format(value);
  } catch {
    return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value);
  }
}

function formatMarketCap(value, currency) {
  if (!isNumber(value)) return "—";
  const formatted = new Intl.NumberFormat("ko-KR", {
    notation: "compact",
    maximumFractionDigits: 2
  }).format(value);
  return formatted + " " + String(currency || "");
}

function marketPriceChip(company) {
  const marketData = company.marketData;
  if (!marketData || !isNumber(marketData.price)) {
    return '<span class="company-price missing" title="검증된 시세가 아직 연결되지 않았습니다">시세 N/A</span>';
  }
  const change = marketData.changePercent;
  const changeClass = isNumber(change) ? (change > 0 ? "up" : change < 0 ? "down" : "flat") : "";
  const changeText = isNumber(change) ? " " + (change > 0 ? "+" : "") + plainMetric(change) : "";
  const delayed = marketData.status !== "ok" || marketData.freshness === "stale";
  const statusText =
    marketData.freshness === "stale" ? "오래된 시세" : delayed ? "마지막 보존 시세" : "최신 확인 시세";
  return (
    '<span class="company-price ' +
    changeClass +
    (delayed ? " stale" : "") +
    '" title="' +
    statusText +
    " · 가격 기준일 " +
    escapeHtml(marketData.asOf || "미상") +
    '">' +
    (delayed ? "지연 · " : "") +
    escapeHtml(formatPrice(marketData.price, marketData.currency)) +
    escapeHtml(changeText) +
    "</span>"
  );
}

function formatDate(value, includeTime = false) {
  if (!value) return "기준일 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {})
  }).format(date);
}

function scoreColor(score) {
  if (score >= 75) return "#5eb879";
  if (score >= 60) return "#e3a446";
  return "#df6e58";
}

function barClass(score) {
  if (score >= 75) return "";
  if (score >= 60) return "mid";
  return "low";
}

function countryLabel(country) {
  return country === "KR" ? "KR · 한국" : "US · 미국";
}

function evaluationStatus(company) {
  const modelStatus =
    company.modelApplicability && typeof company.modelApplicability === "object"
      ? company.modelApplicability.status
      : company.modelApplicability;
  const providerStatus =
    company.providerStatus && typeof company.providerStatus === "object"
      ? company.providerStatus.status
      : company.providerStatus;
  const statuses = [
    company.analysisStatus,
    company.evaluationStatus,
    company.dataStatus,
    company.syncStatus,
    modelStatus,
    providerStatus,
    company.dataMode
  ]
    .filter((status) => typeof status === "string" && status)
    .map((status) => status.toLowerCase());
  return (
    statuses.find((status) =>
      ["insufficient", "insufficient_data", "not_applicable"].includes(status)
    ) ||
    statuses[0] ||
    ""
  );
}

function isEvaluationHeld(company) {
  return evaluationStatus(company) === "not_applicable" || company.modelApplicability === false;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove("show"), 3200);
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function renderMeta(meta) {
  const mode = meta.dataMode || "demo";
  const statusDot = document.querySelector("#header-status-dot");
  statusDot.className = "status-dot " + (mode === "live" ? "live" : mode === "demo" ? "demo" : "");

  setText(
    "#header-status-text",
    mode === "live" ? "공식 데이터 정상" : mode === "mixed" ? "일부 데이터 지연" : "데모 데이터"
  );
  setText("#snapshot-mode", mode === "live" ? "LIVE DATA" : mode === "mixed" ? "MIXED" : "DEMO");
  setText("#snapshot-date", formatDate(meta.updatedAt).replaceAll(". ", ".").replace(".", "."));
  setText("#snapshot-note", meta.note || "데이터 상태 설명이 없습니다.");

  if (mode !== "live" && !sessionStorage.getItem("longview-alert-closed")) {
    elements.dataAlert.hidden = false;
    elements.dataAlertTitle.textContent =
      mode === "demo" ? "현재는 UI 시연용 데이터입니다" : "일부 회사의 갱신이 지연됐습니다";
    elements.dataAlertMessage.textContent =
      meta.note ||
      "회사별 데이터 기준일과 stale 표시를 확인한 뒤 반드시 원문 공시를 함께 보세요.";
  }
}

function renderSummary(summary = {}) {
  const count = summary.companies ?? summary.totalCompanies ?? 0;
  const candidates = summary.candidates ?? summary.candidateCompanies ?? 0;
  const averageScore = summary.averageScore ?? 0;
  const averageConfidence = summary.averageConfidence ?? 0;

  setText("#summary-companies", Number(count).toLocaleString("ko-KR"));
  setText("#summary-candidates", Number(candidates).toLocaleString("ko-KR"));
  setText("#summary-score", Math.round(Number(averageScore) || 0) + "점");
  setText("#summary-confidence", Math.round(Number(averageConfidence) || 0) + "%");
}

function populateSectors(facets = {}) {
  const sectors = (Array.isArray(facets) ? facets : facets.sectors || [])
    .map((sector) => (typeof sector === "string" ? sector : sector.value || sector.name))
    .filter((sector) => sector !== "ALL")
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "ko"));
  elements.sectorSelect.innerHTML =
    '<option value="ALL">전체 산업</option>' +
    sectors
      .map((sector) => '<option value="' + escapeHtml(sector) + '">' + escapeHtml(sector) + "</option>")
      .join("");
}

function componentBars(company) {
  const keys = ["profitability", "growth", "safety", "cashflow"];
  return keys
    .map((key) => {
      const component = company.score.components[key];
      const hasData =
        Number(component?.confidence || 0) > 0 && Number.isFinite(Number(component?.score));
      const score = hasData ? Number(component.score) : 0;
      return (
        '<div class="score-bar-row">' +
        "<span>" +
        escapeHtml(component?.label || key) +
        "</span>" +
        '<div class="bar-track"><i class="' +
        (hasData ? barClass(score) : "") +
        '" style="width:' +
        Math.max(0, Math.min(100, score)) +
        '%"></i></div>' +
        "<b>" +
        (hasData ? score : "—") +
        "</b></div>"
      );
    })
    .join("");
}

function renderCountryFacets(facets = {}) {
  const counts = new Map(
    (facets.countries || []).map((item) => [item.value, Number(item.count) || 0])
  );
  const labels = { ALL: "전체", KR: "한국", US: "미국" };
  for (const button of elements.countryTabs) {
    const country = button.dataset.country;
    const count = counts.get(country);
    button.textContent =
      labels[country] + (Number.isFinite(count) ? " " + count.toLocaleString("ko-KR") : "");
  }
}

function sparkBars(company) {
  const history = company.history || [];
  if (history.length === 0) {
    return '<div class="empty-spark">재무 추이 없음</div>';
  }
  const revenueMax = Math.max(...history.map((point) => Math.abs(point.revenue || 0)), 1);
  const incomeMax = Math.max(
    ...history.map((point) => Math.abs(point.operatingIncome || 0)),
    1
  );
  return history
    .map((point) => {
      const revenueHeight = Math.max(4, Math.min(100, (Math.abs(point.revenue || 0) / revenueMax) * 100));
      const incomeHeight = Math.max(
        3,
        Math.min(100, (Math.abs(point.operatingIncome || 0) / incomeMax) * 100)
      );
      return (
        '<div class="spark-column" title="' +
        escapeHtml(point.label) +
        '">' +
        '<i style="height:' +
        revenueHeight +
        '%"></i>' +
        '<i class="income" style="height:' +
        incomeHeight +
        '%"></i>' +
        "<span>" +
        escapeHtml(point.label) +
        "</span></div>"
      );
    })
    .join("");
}

function companyCard(company, visibleRank) {
  const score = company.score.total;
  const metrics = company.metrics || {};
  const reason =
    company.reasons?.[0] || "구조화된 공시 데이터에서 평가 근거를 생성하지 못했습니다.";
  const candidate = company.score.candidate;
  const analysisStatus = evaluationStatus(company);
  const evaluationHeld = isEvaluationHeld(company);
  const scoreForRing = evaluationHeld ? 0 : score;
  const scoreDisplay = evaluationHeld ? "—" : score;
  const reasonLabel = evaluationHeld ? "평가 안내" : "모델이 높게 평가한 이유";
  const ribbon = company.stale
    ? '<span class="stale-ribbon">STALE</span>'
    : company.dataMode === "demo"
      ? '<span class="demo-ribbon">DEMO</span>'
      : analysisStatus === "insufficient_data" || analysisStatus === "insufficient"
        ? '<span class="status-ribbon">DATA 부족</span>'
        : analysisStatus === "not_applicable" || company.modelApplicability === false
          ? '<span class="status-ribbon">평가 보류</span>'
      : "";

  return (
    '<article class="company-card" data-company="' +
    escapeHtml(company.id) +
    '">' +
    ribbon +
    '<div class="company-rank"><span>RANK</span><strong>' +
    String(visibleRank).padStart(2, "0") +
    "</strong></div>" +
    '<div class="company-primary">' +
    '<div class="company-meta"><span class="country-badge">' +
    countryLabel(company.country) +
    "</span><span>" +
    escapeHtml(company.exchange) +
    "</span><span>·</span><span>" +
    escapeHtml(company.sector || "미분류") +
    "</span></div>" +
    "<h3>" +
    escapeHtml(company.name) +
    "</h3>" +
    '<div class="company-market-line"><span class="company-ticker">' +
    escapeHtml(company.ticker) +
    " · " +
    escapeHtml(company.period || "기간 미상") +
    "</span>" +
    marketPriceChip(company) +
    "</div>" +
    '<div class="reason-block"><span class="reason-label">' + reasonLabel + '</span><p>' +
    escapeHtml(reason) +
    "</p></div></div>" +
    '<div class="metric-panel">' +
    '<div class="metric-grid">' +
    "<div><span>ROE</span><strong>" +
    formatMetric(metrics.roe) +
    "</strong></div>" +
    "<div><span>영업률</span><strong>" +
    formatMetric(metrics.operatingMargin) +
    "</strong></div>" +
    "<div><span>부채</span><strong>" +
    formatMetric(metrics.debtRatio) +
    "</strong></div>" +
    '<div title="검증된 시세와 연차 공시로 계산한 참고값이며 총점에는 미포함"><span>PER</span><strong>' +
    formatMetric(metrics.per, "multiple") +
    "</strong></div></div>" +
    '<div class="score-bars">' +
    componentBars(company) +
    "</div></div>" +
    '<div class="trend-panel">' +
    '<div class="panel-mini-heading"><span>연간 재무 추이</span><span>' +
    escapeHtml(company.historyUnit || "") +
    "</span></div>" +
    '<div class="spark-bars">' +
    sparkBars(company) +
    "</div>" +
    '<div class="trend-foot"><span><i></i>매출</span><span><i class="income"></i>영업이익</span></div>' +
    "</div>" +
    '<div class="company-score">' +
    '<div class="score-ring" style="--score:' +
    scoreForRing +
    ";--score-color:" +
    scoreColor(scoreForRing) +
    '">' +
    '<span class="score-value">' +
    scoreDisplay +
    (evaluationHeld ? "" : "<small>점</small>") +
    "</span></div>" +
    '<span class="score-band">' +
    escapeHtml(company.score.band.label) +
    "</span>" +
    '<span class="candidate-badge ' +
    (candidate.eligible ? "" : "observer") +
    '">' +
    escapeHtml(candidate.label) +
    "</span>" +
    '<span class="confidence-text">신뢰도 ' +
    company.score.dataConfidence +
    "% · 완전성 " +
    company.score.completeness +
    "%</span>" +
    '<button class="detail-button" type="button" data-open-company="' +
    escapeHtml(company.id) +
    '">상세 보기 →</button>' +
    "</div></article>"
  );
}

function renderCompanies() {
  const companies = state.companies;
  elements.resultCount.textContent = state.pagination.total.toLocaleString("ko-KR");
  elements.companyList.setAttribute("aria-busy", "false");

  if (companies.length === 0) {
    elements.companyList.innerHTML =
      '<div class="empty-state"><strong>조건에 맞는 기업이 없습니다.</strong>' +
      "<span>검색어 또는 국가·산업 필터를 바꿔보세요.</span></div>";
    return;
  }
  elements.companyList.innerHTML = companies
    .map(
      (company, index) =>
        companyCard(
          company,
          company.position || (state.pagination.page - 1) * state.pagination.pageSize + index + 1
        )
    )
    .join("");
}

function paginationWindow(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const values = new Set([1, total, current - 2, current - 1, current, current + 1, current + 2]);
  const pages = [...values].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const output = [];
  for (const page of pages) {
    if (output.length && page - output.at(-1) > 1) output.push("ellipsis-" + page);
    output.push(page);
  }
  return output;
}

function renderPagination() {
  const pagination = state.pagination;
  elements.pagination.hidden = pagination.totalPages <= 1;
  elements.previousPage.disabled = !pagination.hasPrevious;
  elements.nextPage.disabled = !pagination.hasNext;
  elements.pageStatus.textContent =
    pagination.totalPages > 0
      ? pagination.page.toLocaleString("ko-KR") + " / " + pagination.totalPages.toLocaleString("ko-KR") + " 페이지"
      : "결과 없음";
  elements.pageNumbers.innerHTML = paginationWindow(pagination.page, pagination.totalPages)
    .map((page) => {
      if (typeof page === "string") return '<span class="page-ellipsis" aria-hidden="true">…</span>';
      return (
        '<button type="button" data-page="' +
        page +
        '"' +
        (page === pagination.page ? ' class="active" aria-current="page"' : "") +
        ">" +
        page +
        "</button>"
      );
    })
    .join("");
}

function companyQuery() {
  const parameters = new URLSearchParams({
    q: state.filters.query.trim(),
    country: state.filters.country,
    sector: state.filters.sector,
    sort: state.filters.sort,
    candidateOnly: String(state.filters.candidateOnly),
    page: String(state.pagination.page),
    pageSize: String(state.pagination.pageSize)
  });
  return parameters;
}

function renderListLoading() {
  elements.companyList.setAttribute("aria-busy", "true");
  elements.companyList.innerHTML =
    '<article class="company-card skeleton-card"><div class="skeleton skeleton-rank"></div>' +
    '<div class="skeleton skeleton-copy"></div><div class="skeleton skeleton-bars"></div>' +
    '<div class="skeleton skeleton-score"></div></article>';
}

async function loadCompanies({ resetPage = false } = {}) {
  if (resetPage) state.pagination.page = 1;
  state.listRequest?.abort();
  const controller = new AbortController();
  const sequence = ++state.listSequence;
  state.listRequest = controller;
  renderListLoading();

  try {
    const response = await fetch("/api/companies?" + companyQuery(), {
      cache: "no-cache",
      signal: controller.signal
    });
    if (!response.ok) throw new Error("회사 목록을 불러오지 못했습니다.");
    const payload = await response.json();
    if (sequence !== state.listSequence) return;

    const revision = payload.revision || response.headers.get("etag");
    if (state.revision && revision && revision !== state.revision) state.detailCache.clear();
    if (revision) state.revision = revision;
    state.companies = payload.items || payload.companies || [];
    const nextPagination = {
      ...state.pagination,
      ...(payload.pagination || {}),
      total: payload.pagination?.total ?? state.companies.length,
      totalPages: payload.pagination?.totalPages ?? (state.companies.length ? 1 : 0),
      hasPrevious: payload.pagination?.hasPrevious ?? false,
      hasNext: payload.pagination?.hasNext ?? false
    };
    if (nextPagination.totalPages > 0 && nextPagination.page > nextPagination.totalPages) {
      state.pagination = { ...nextPagination, page: nextPagination.totalPages };
      await loadCompanies();
      return;
    }
    if (nextPagination.totalPages === 0) nextPagination.page = 1;
    state.pagination = nextPagination;
    renderCompanies();
    renderPagination();
  } catch (error) {
    if (error.name === "AbortError") return;
    elements.companyList.setAttribute("aria-busy", "false");
    elements.companyList.innerHTML =
      '<div class="empty-state"><strong>목록을 불러오지 못했습니다.</strong><span>' +
      escapeHtml(error.message) +
      "</span></div>";
    showToast("데이터 연결을 확인해 주세요.");
    elements.pagination.hidden = true;
  } finally {
    if (state.listRequest === controller) state.listRequest = null;
  }
}

function detailMetrics(company) {
  const metrics = company.metrics || {};
  const items = [
    ["ROE", plainMetric(metrics.roe)],
    ["영업이익률", plainMetric(metrics.operatingMargin)],
    ["순이익률", plainMetric(metrics.netMargin)],
    ["매출 성장률", plainMetric(metrics.revenueGrowth)],
    ["영업이익 성장률", plainMetric(metrics.operatingIncomeGrowth)],
    ["부채비율", plainMetric(metrics.debtRatio)],
    ["유동비율", plainMetric(metrics.currentRatio)],
    ["FCF 마진", plainMetric(metrics.fcfMargin)],
    ["현금 전환율", plainMetric(metrics.cashConversion)]
  ];
  return items
    .map(
      ([label, value]) =>
        "<div><span>" + escapeHtml(label) + "</span><strong>" + escapeHtml(value) + "</strong></div>"
    )
    .join("");
}

function detailMarketMetrics(company) {
  const marketData = company.marketData || {};
  const valuation = marketData.valuation || {};
  const items = [
    ["종가", formatPrice(marketData.price, marketData.currency)],
    ["일 등락률", plainMetric(marketData.changePercent)],
    [
      marketData.marketCapScope === "security" ? "종목 시가총액" : "시가총액",
      formatMarketCap(marketData.marketCap, marketData.currency)
    ],
    ["PER", plainMetric(valuation.per, "multiple")],
    ["PBR", plainMetric(valuation.pbr, "multiple")],
    ["PSR", plainMetric(valuation.psr, "multiple")],
    ["FCF 수익률", plainMetric(valuation.fcfYield)],
    ["가격 기준일", marketData.asOf || "—"]
  ];
  return items
    .map(
      ([label, value]) =>
        "<div><span>" + escapeHtml(label) + "</span><strong>" + escapeHtml(value) + "</strong></div>"
    )
    .join("");
}

function marketDataNote(company) {
  const source = company.marketData?.source;
  if (!source?.name) {
    return '<p class="market-data-note">검증된 시세 공급자가 연결되지 않아 N/A로 표시합니다.</p>';
  }
  const freshness =
    company.marketData.freshness === "stale"
      ? "오래된 가격이므로 기준일 확인 필요"
      : company.marketData.status !== "ok"
        ? "마지막 정상 가격 보존"
        : "최신성 확인";
  const sourceLink = source.url
    ? '<a href="' + safeUrl(source.url) + '" target="_blank" rel="noreferrer">공급자 문서 ↗</a>'
    : "";
  return (
    '<p class="market-data-note">출처: ' +
    escapeHtml(source.name) +
    " · " +
    escapeHtml(freshness + " · 연차 공시 기준 가치평가·총점 미포함") +
    sourceLink +
    "</p>"
  );
}

function detailComponents(company) {
  return Object.values(company.score.components)
    .map((component) => {
      const hasData =
        Number(component?.confidence || 0) > 0 && Number.isFinite(Number(component?.score));
      const score = hasData ? Number(component.score) : 0;
      return (
        '<div class="detail-component"><div><span>' +
        escapeHtml(component.label) +
        " · " +
        component.weight +
        "점</span><strong>" +
        (hasData ? score : "데이터 없음") +
        "</strong></div>" +
        '<div class="bar-track"><i class="' +
        (hasData ? barClass(score) : "") +
        '" style="width:' +
        score +
        '%"></i></div></div>'
      );
    })
    .join("");
}

function detailDisclosures(company) {
  const disclosures = company.disclosures || [];
  if (disclosures.length === 0) {
    return '<p class="empty-disclosures">연결된 실제 공시가 없습니다.</p>';
  }
  return (
    '<ul class="disclosure-list">' +
    disclosures
      .slice(0, 6)
      .map(
        (filing) =>
          '<li><a href="' +
          safeUrl(filing.url) +
          '" target="_blank" rel="noreferrer"><time>' +
          escapeHtml(filing.date || "날짜 미상") +
          "</time><b>" +
          escapeHtml(filing.title || filing.form) +
          "</b><em>원문 ↗</em></a></li>"
      )
      .join("") +
    "</ul>"
  );
}

function renderCompanyDetail(company) {
  const reasons = company.reasons?.length
    ? company.reasons
    : ["현재 구조화 데이터에서 뚜렷한 강점 근거를 만들지 못했습니다."];
  const riskFlagTexts = (company.riskFlags || []).map((flag) => flag.label);
  const risks = [...riskFlagTexts, ...(company.risks || [])];
  if (risks.length === 0) risks.push("구조화된 지표에서 두드러진 위험 신호가 없지만 원문 검토는 필요합니다.");
  const candidate = company.score.candidate;
  const evaluationHeld = isEvaluationHeld(company);
  const detailScore = evaluationHeld ? "—" : company.score.total;
  const detailScoreSuffix = evaluationHeld ? "" : "<small>/100</small>";
  const reasonHeading = evaluationHeld ? "평가 안내" : "모델이 높게 평가한 이유";

  elements.companyDialogContent.innerHTML =
    '<section class="detail-hero">' +
    '<div class="company-meta"><span class="country-badge">' +
    countryLabel(company.country) +
    "</span><span>" +
    escapeHtml(company.exchange) +
    "</span><span>·</span><span>" +
    escapeHtml(company.sector) +
    "</span></div>" +
    "<h2>" +
    escapeHtml(company.name) +
    "</h2>" +
    "<p>" +
    escapeHtml(company.ticker) +
    " · " +
    escapeHtml(company.period) +
    " · " +
    escapeHtml(company.statementBasis || "회계 기준 확인 필요") +
    "</p>" +
    '<div class="detail-score-line"><div class="detail-total">' +
    detailScore +
    detailScoreSuffix +
    "</div>" +
    '<div class="detail-status"><strong>' +
    escapeHtml(candidate.label) +
    "</strong><span>데이터 신뢰도 " +
    company.score.dataConfidence +
    "% · 완전성 " +
    company.score.completeness +
    "%</span></div></div></section>" +
    '<div class="detail-body"><div class="detail-main">' +
    '<section class="detail-section"><h3>' + reasonHeading + '</h3><ul class="detail-reasons">' +
    reasons.map((reason) => "<li>" + escapeHtml(reason) + "</li>").join("") +
    "</ul></section>" +
    '<section class="detail-section"><h3>주의 요인</h3><ul class="detail-risks">' +
    risks.slice(0, 4).map((risk) => "<li>" + escapeHtml(risk) + "</li>").join("") +
    "</ul></section>" +
    '<section class="detail-section"><h3>핵심 재무지표</h3><div class="metric-table">' +
    detailMetrics(company) +
    "</div></section>" +
    '<section class="detail-section"><h3>시세·연차 공시 기준 가치평가</h3><div class="metric-table">' +
    detailMarketMetrics(company) +
    "</div>" +
    marketDataNote(company) +
    "</section>" +
    '<section class="detail-section"><h3>최근 공시</h3>' +
    detailDisclosures(company) +
    "</section></div>" +
    '<aside class="detail-side"><section class="detail-section"><h3>영역별 점수</h3>' +
    detailComponents(company) +
    "</section>" +
    (!candidate.eligible
      ? '<section class="detail-section"><h3>후보 제외 사유</h3><ul class="detail-risks">' +
        candidate.reasons.map((reason) => "<li>" + escapeHtml(reason) + "</li>").join("") +
        "</ul></section>"
      : "") +
    '<div class="lineage-card"><span>원문 추적 정보</span><strong>' +
    escapeHtml(company.lineage?.provider || (company.country === "KR" ? "Open DART" : "SEC EDGAR")) +
    "</strong><span>Filing ID</span><strong>" +
    escapeHtml(company.lineage?.filingId || "데모 데이터 · 없음") +
    '</strong><a href="' +
    safeUrl(company.sourceUrl) +
    '" target="_blank" rel="noreferrer">공식 원문 페이지 열기 ↗</a></div></aside></div>';

}

async function showCompanyDetail(companyId) {
  state.detailRequest?.abort();
  const controller = new AbortController();
  const sequence = ++state.detailSequence;
  state.detailRequest = controller;
  if (!elements.companyDialog.open) elements.companyDialog.showModal();
  elements.companyDialogContent.innerHTML =
    '<div class="detail-loading" role="status"><span></span><strong>공시 상세를 불러오는 중입니다</strong></div>';

  try {
    let company = state.detailCache.get(companyId);
    if (!company) {
      const response = await fetch("/api/companies/" + encodeURIComponent(companyId), {
        cache: "no-cache",
        signal: controller.signal
      });
      if (response.status === 404) throw new Error("해당 기업을 찾지 못했습니다.");
      if (!response.ok) throw new Error("기업 상세를 불러오지 못했습니다.");
      const payload = await response.json();
      company = payload.company || payload;
      state.detailCache.set(companyId, company);
    }
    if (sequence !== state.detailSequence || !elements.companyDialog.open) return;
    renderCompanyDetail(company);
  } catch (error) {
    if (error.name === "AbortError" || sequence !== state.detailSequence) return;
    elements.companyDialogContent.innerHTML =
      '<div class="detail-loading error"><strong>상세 정보를 열 수 없습니다.</strong><p>' +
      escapeHtml(error.message) +
      "</p></div>";
  } finally {
    if (state.detailRequest === controller) state.detailRequest = null;
  }
}

function formatThreshold(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value).toFixed(1));
}

function renderMethodology() {
  if (!state.methodology) {
    elements.methodGroups.innerHTML = "<p>점수 모델을 불러오지 못했습니다.</p>";
    return;
  }
  elements.methodGroups.innerHTML = state.methodology.groups
    .map(
      (group) =>
        '<article class="method-group"><div class="method-group-head"><strong>' +
        escapeHtml(group.label) +
        "</strong><span>" +
        group.weight +
        "점</span></div><ul>" +
        group.metrics
          .map(
            (metric) =>
              "<li><span>" +
              escapeHtml(METRIC_LABELS[metric.key] || metric.key) +
              "</span><span>" +
              metric.weight +
              "점 · " +
              formatThreshold(metric.weak) +
              "→" +
              formatThreshold(metric.strong) +
              "</span></li>"
          )
          .join("") +
        "</ul></article>"
    )
    .join("");
}

function openMethodology() {
  renderMethodology();
  elements.methodDialog.showModal();
}

function bindEvents() {
  let searchTimer;
  const applyFilter = () => {
    window.clearTimeout(searchTimer);
    loadCompanies({ resetPage: true });
  };
  elements.searchInput.addEventListener("input", (event) => {
    state.filters.query = event.target.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => loadCompanies({ resetPage: true }), 300);
  });
  elements.sectorSelect.addEventListener("change", (event) => {
    state.filters.sector = event.target.value;
    applyFilter();
  });
  elements.sortSelect.addEventListener("change", (event) => {
    state.filters.sort = event.target.value;
    applyFilter();
  });
  elements.candidateOnly.addEventListener("change", (event) => {
    state.filters.candidateOnly = event.target.checked;
    applyFilter();
  });
  for (const button of elements.countryTabs) {
    button.addEventListener("click", () => {
      state.filters.country = button.dataset.country;
      elements.countryTabs.forEach((item) => item.classList.toggle("active", item === button));
      applyFilter();
    });
  }
  elements.companyList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-company]");
    if (button) showCompanyDetail(button.dataset.openCompany);
  });
  elements.previousPage.addEventListener("click", () => {
    if (!state.pagination.hasPrevious) return;
    state.pagination.page -= 1;
    loadCompanies();
    document.querySelector("#company-results")?.scrollIntoView({ behavior: "smooth" });
  });
  elements.nextPage.addEventListener("click", () => {
    if (!state.pagination.hasNext) return;
    state.pagination.page += 1;
    loadCompanies();
    document.querySelector("#company-results")?.scrollIntoView({ behavior: "smooth" });
  });
  elements.pageNumbers.addEventListener("click", (event) => {
    const button = event.target.closest("[data-page]");
    if (!button) return;
    state.pagination.page = Number(button.dataset.page);
    loadCompanies();
    document.querySelector("#company-results")?.scrollIntoView({ behavior: "smooth" });
  });

  for (const selector of [
    "#methodology-button",
    "#hero-methodology-button",
    "#footer-methodology-button"
  ]) {
    document.querySelector(selector)?.addEventListener("click", openMethodology);
  }
  document.querySelector("[data-close-dialog]")?.addEventListener("click", () => {
    elements.companyDialog.close();
  });
  document.querySelector("[data-close-method]")?.addEventListener("click", () => {
    elements.methodDialog.close();
  });
  for (const dialog of [elements.companyDialog, elements.methodDialog]) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
  elements.companyDialog.addEventListener("close", () => {
    state.detailRequest?.abort();
    state.detailRequest = null;
    state.detailSequence += 1;
  });
  document.querySelector("#data-alert-close")?.addEventListener("click", () => {
    elements.dataAlert.hidden = true;
    sessionStorage.setItem("longview-alert-closed", "true");
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    if (event.key === "/" && !typing && !elements.companyDialog.open && !elements.methodDialog.open) {
      event.preventDefault();
      elements.searchInput.focus();
    }
  });
}

async function initialize() {
  bindEvents();
  try {
    const [overviewResponse, methodologyResponse] = await Promise.all([
      fetch("/api/overview", { cache: "no-cache" }),
      fetch("/api/methodology", { cache: "no-cache" })
    ]);
    if (!overviewResponse.ok) throw new Error("전체시장 현황을 불러오지 못했습니다.");
    state.overview = await overviewResponse.json();
    if (methodologyResponse.ok) state.methodology = await methodologyResponse.json();

    state.revision = state.overview.revision || null;
    renderMeta(state.overview.meta || {});
    renderSummary(state.overview.summary || {});
    populateSectors(state.overview.facets || {});
    renderCountryFacets(state.overview.facets || {});
    await loadCompanies();
    startRevisionPolling();
  } catch (error) {
    elements.companyList.setAttribute("aria-busy", "false");
    elements.companyList.innerHTML =
      '<div class="empty-state"><strong>데이터를 불러오지 못했습니다.</strong><span>' +
      escapeHtml(error.message) +
      "</span></div>";
    showToast("데이터 연결을 확인해 주세요.");
  }
}

async function refreshOverviewIfChanged() {
  if (document.hidden || state.listRequest) return;
  try {
    const response = await fetch("/api/overview", { cache: "no-cache" });
    if (!response.ok) return;
    const overview = await response.json();
    if (!overview.revision || overview.revision === state.revision) return;
    state.overview = overview;
    state.revision = overview.revision;
    state.detailCache.clear();
    renderMeta(overview.meta || {});
    renderSummary(overview.summary || {});
    populateSectors(overview.facets || {});
    renderCountryFacets(overview.facets || {});
    await loadCompanies();
    showToast("오늘의 공시·시세 데이터로 자동 갱신했습니다.");
  } catch {
    // The next poll retries; a transient polling failure must not replace the current screen.
  }
}

function startRevisionPolling() {
  window.setInterval(refreshOverviewIfChanged, 5 * 60 * 1_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshOverviewIfChanged();
  });
}

initialize();
