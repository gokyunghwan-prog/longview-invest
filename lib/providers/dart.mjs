import { inflateRawSync } from "node:zlib";
import { fetchBuffer, fetchJson, sleep } from "../http.mjs";

const DART_API_BASE = "https://opendart.fss.or.kr/api";

const ACCOUNT_ALIASES = {
  revenue: {
    ids: ["ifrs-full_Revenue", "ifrs-full_RevenueFromContractsWithCustomers"],
    names: [/^매출액$/, /^영업수익$/, /^수익\(매출액\)$/],
    statements: ["IS", "CIS"]
  },
  operatingIncome: {
    ids: ["dart_OperatingIncomeLoss", "ifrs-full_ProfitLossFromOperatingActivities"],
    names: [/^영업이익/, /^영업이익\(손실\)/],
    statements: ["IS", "CIS"]
  },
  netIncome: {
    ids: ["ifrs-full_ProfitLoss"],
    names: [/^당기순이익/, /^연결당기순이익/, /^당기순이익\(손실\)/],
    statements: ["IS", "CIS"]
  },
  assets: {
    ids: ["ifrs-full_Assets"],
    names: [/^자산총계$/],
    statements: ["BS"]
  },
  liabilities: {
    ids: ["ifrs-full_Liabilities"],
    names: [/^부채총계$/],
    statements: ["BS"]
  },
  equity: {
    ids: ["ifrs-full_Equity"],
    names: [/^자본총계$/],
    statements: ["BS"]
  },
  currentAssets: {
    ids: ["ifrs-full_CurrentAssets"],
    names: [/^유동자산$/],
    statements: ["BS"]
  },
  currentLiabilities: {
    ids: ["ifrs-full_CurrentLiabilities"],
    names: [/^유동부채$/],
    statements: ["BS"]
  },
  operatingCashFlow: {
    ids: ["ifrs-full_CashFlowsFromUsedInOperatingActivities"],
    names: [/영업활동.*현금흐름/, /영업활동으로.*현금/],
    statements: ["CF"]
  },
  capex: {
    ids: [
      "ifrs-full_PurchaseOfPropertyPlantAndEquipment",
      "dart_PurchaseOfPropertyPlantAndEquipment"
    ],
    names: [/유형자산.*취득/, /유형자산의 증가/],
    statements: ["CF"]
  }
};

function buildDartUrl(endpoint, apiKey, parameters = {}) {
  const url = new URL(DART_API_BASE + "/" + endpoint);
  url.searchParams.set("crtfc_key", apiKey);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function dartJson(endpoint, apiKey, parameters = {}, { allowNoData = false } = {}) {
  const payload = await fetchJson(buildDartUrl(endpoint, apiKey, parameters));
  if (payload.status === "000") return payload;
  if (allowNoData && payload.status === "013") return null;
  throw new Error("Open DART 오류 " + payload.status + ": " + payload.message);
}

function extractFirstZipEntry(buffer) {
  const centralSignature = 0x02014b50;
  let centralOffset = -1;
  for (let offset = buffer.length - 46; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === centralSignature) {
      centralOffset = offset;
      break;
    }
  }
  if (centralOffset < 0) throw new Error("Open DART 기업코드 ZIP 구조를 읽지 못했습니다.");

  const method = buffer.readUInt16LE(centralOffset + 10);
  const compressedSize = buffer.readUInt32LE(centralOffset + 20);
  const localOffset = buffer.readUInt32LE(centralOffset + 42);
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error("Open DART 기업코드 ZIP의 로컬 헤더가 올바르지 않습니다.");
  }

  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

  if (method === 0) return compressed;
  if (method === 8) return inflateRawSync(compressed);
  throw new Error("지원하지 않는 ZIP 압축 방식입니다: " + method);
}

function decodeXml(value) {
  return String(value || "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .trim();
}

function xmlValue(block, tag) {
  const match = block.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">"));
  return decodeXml(match?.[1] || "");
}

function parseCorpCodes(xml) {
  return [...xml.matchAll(/<list>([\s\S]*?)<\/list>/g)].map((match) => ({
    corpCode: xmlValue(match[1], "corp_code"),
    name: xmlValue(match[1], "corp_name"),
    englishName: xmlValue(match[1], "corp_eng_name"),
    stockCode: xmlValue(match[1], "stock_code"),
    modifiedAt: xmlValue(match[1], "modify_date")
  }));
}

export async function fetchDartCorpCodes(apiKey) {
  const buffer = await fetchBuffer(buildDartUrl("corpCode.xml", apiKey));
  const firstBytes = buffer.subarray(0, 100).toString("utf8").trimStart();
  const xml = firstBytes.startsWith("<")
    ? buffer.toString("utf8")
    : extractFirstZipEntry(buffer).toString("utf8");
  return parseCorpCodes(xml);
}

function parseAmount(value) {
  if (value === null || value === undefined || value === "" || value === "-") return null;
  const normalized = String(value).replaceAll(",", "").replace(/\((.+)\)/, "-$1").trim();
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function accountMatches(row, aliases) {
  if (aliases.statements && !aliases.statements.includes(row.sj_div)) return false;
  if (aliases.ids.includes(row.account_id)) return true;
  const name = String(row.account_nm || "").replace(/\s+/g, "");
  return aliases.names.some((pattern) => pattern.test(name));
}

function findAccount(rows, aliases) {
  const exactId = rows.find(
    (row) => aliases.statements.includes(row.sj_div) && aliases.ids.includes(row.account_id)
  );
  return exactId || rows.find((row) => accountMatches(row, aliases)) || null;
}

function accountSeries(row) {
  if (!row) return [];
  return [
    {
      label: row.bfefrmtrm_nm || "Y-2",
      val: parseAmount(row.bfefrmtrm_amount)
    },
    { label: row.frmtrm_nm || "Y-1", val: parseAmount(row.frmtrm_amount) },
    { label: row.thstrm_nm || "Y", val: parseAmount(row.thstrm_amount) }
  ].filter((point) => Number.isFinite(point.val));
}

function valueAt(series, offset = 0) {
  return series.at(-1 - offset)?.val ?? null;
}

function percentage(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0)
    return null;
  return (numerator / denominator) * 100;
}

function yearOverYear(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function stability(series) {
  const changes = [];
  for (let index = 1; index < series.length; index += 1) {
    const growth = yearOverYear(series[index].val, series[index - 1].val);
    if (growth !== null) changes.push(growth);
  }
  if (changes.length < 2) return series.length >= 2 ? 65 : null;
  const mean = changes.reduce((sum, value) => sum + value, 0) / changes.length;
  const variance =
    changes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / changes.length;
  return Math.max(0, Math.min(100, 100 - Math.sqrt(variance) * 3));
}

async function fetchLatestAnnualStatements(corpCode, apiKey) {
  const currentYear = new Date().getUTCFullYear();
  for (const year of [currentYear - 1, currentYear - 2, currentYear - 3]) {
    for (const fsDiv of ["CFS", "OFS"]) {
      const payload = await dartJson(
        "fnlttSinglAcntAll.json",
        apiKey,
        {
          corp_code: corpCode,
          bsns_year: year,
          reprt_code: "11011",
          fs_div: fsDiv
        },
        { allowNoData: true }
      );
      if (payload?.list?.length) return { rows: payload.list, year, fsDiv };
      await sleep(120);
    }
  }
  throw new Error("최근 3개 사업연도의 재무제표를 찾지 못했습니다.");
}

function formatDartDate(value) {
  if (!/^\d{8}$/.test(String(value))) return value || null;
  return value.slice(0, 4) + "-" + value.slice(4, 6) + "-" + value.slice(6, 8);
}

async function fetchDisclosures(corpCode, apiKey) {
  const end = new Date();
  const begin = new Date(end.getTime() - 370 * 86_400_000);
  const compact = (date) =>
    date.getUTCFullYear().toString() +
    String(date.getUTCMonth() + 1).padStart(2, "0") +
    String(date.getUTCDate()).padStart(2, "0");

  const payload = await dartJson(
    "list.json",
    apiKey,
    {
      corp_code: corpCode,
      bgn_de: compact(begin),
      end_de: compact(end),
      last_reprt_at: "N",
      sort: "date",
      sort_mth: "desc",
      page_count: 20
    },
    { allowNoData: true }
  );

  return (payload?.list || []).slice(0, 8).map((filing) => ({
    id: filing.rcept_no,
    title: filing.report_nm,
    form: filing.report_nm,
    date: formatDartDate(filing.rcept_dt),
    url: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + filing.rcept_no,
    source: "Open DART",
    note: filing.rm || ""
  }));
}

function deriveDartRiskFlags(disclosures) {
  const flags = [];
  const withdrawal = disclosures.find((filing) => /철회|회생절차|부도발생|상장폐지/.test(filing.title));
  if (withdrawal) {
    flags.push({
      level: "critical",
      code: "material_event",
      label: "중대 위험 관련 공시",
      sourceUrl: withdrawal.url
    });
  }
  return flags;
}

export async function syncDartCompany(company, corpRecord, config) {
  if (!config.dartApiKey) throw new Error("DART_API_KEY가 설정되지 않았습니다.");
  const statements = await fetchLatestAnnualStatements(corpRecord.corpCode, config.dartApiKey);
  const accounts = {};
  const series = {};

  for (const [key, aliases] of Object.entries(ACCOUNT_ALIASES)) {
    accounts[key] = findAccount(statements.rows, aliases);
    series[key] = accountSeries(accounts[key]);
  }

  if (series.revenue.length === 0 || series.netIncome.length === 0) {
    throw new Error("필수 K-IFRS 계정을 찾지 못했습니다.");
  }

  const revenueNow = valueAt(series.revenue);
  const revenuePrevious = valueAt(series.revenue, 1);
  const operatingIncomeNow = valueAt(series.operatingIncome);
  const operatingIncomePrevious = valueAt(series.operatingIncome, 1);
  const netIncomeNow = valueAt(series.netIncome);
  const equityNow = valueAt(series.equity);
  const equityPrevious = valueAt(series.equity, 1);
  const liabilitiesNow = valueAt(series.liabilities);
  const currentAssetsNow = valueAt(series.currentAssets);
  const currentLiabilitiesNow = valueAt(series.currentLiabilities);
  const cashFlowNow = valueAt(series.operatingCashFlow);
  const capexNow = Math.abs(valueAt(series.capex) || 0);
  const freeCashFlow = Number.isFinite(cashFlowNow) ? cashFlowNow - capexNow : null;
  const averageEquity =
    Number.isFinite(equityNow) && Number.isFinite(equityPrevious)
      ? (equityNow + equityPrevious) / 2
      : equityNow;

  const disclosures = await fetchDisclosures(corpRecord.corpCode, config.dartApiKey);
  const latestDisclosure = disclosures[0] || null;
  const metrics = {
    roe: percentage(netIncomeNow, averageEquity),
    operatingMargin: percentage(operatingIncomeNow, revenueNow),
    netMargin: percentage(netIncomeNow, revenueNow),
    revenueGrowth: yearOverYear(revenueNow, revenuePrevious),
    operatingIncomeGrowth: yearOverYear(operatingIncomeNow, operatingIncomePrevious),
    debtRatio:
      Number.isFinite(equityNow) && equityNow > 0
        ? percentage(liabilitiesNow, equityNow)
        : null,
    currentRatio: percentage(currentAssetsNow, currentLiabilitiesNow),
    fcfMargin: percentage(freeCashFlow, revenueNow),
    cashConversion:
      Number.isFinite(netIncomeNow) && netIncomeNow > 0
        ? percentage(cashFlowNow, netIncomeNow)
        : null,
    positiveIncomeYears: series.netIncome.filter((point) => point.val > 0).length,
    revenueStability: stability(series.revenue),
    per: null
  };

  const history = series.revenue.map((point) => {
    const index = series.revenue.indexOf(point);
    return {
      label: point.label.replace(/\s+/g, " "),
      revenue: point.val / 1_000_000_000,
      operatingIncome: series.operatingIncome[index]?.val
        ? series.operatingIncome[index].val / 1_000_000_000
        : null
    };
  });

  const statementReceipt = accounts.revenue?.rcept_no || accounts.netIncome?.rcept_no || null;
  return {
    id: "KR-" + company.ticker,
    providerId: corpRecord.corpCode,
    name: corpRecord.name || company.name,
    nameEn: corpRecord.englishName || null,
    ticker: company.ticker,
    country: "KR",
    exchange: company.exchange || "KRX",
    sector: company.sector || "미분류",
    currency: accounts.revenue?.currency || "KRW",
    period: statements.year + " 사업연도",
    statementBasis:
      "K-IFRS · " + (statements.fsDiv === "CFS" ? "연결재무제표" : "별도재무제표"),
    dataMode: "live",
    metrics,
    history,
    historyUnit: "KRW billion",
    disclosures,
    latestDisclosure,
    riskFlags: deriveDartRiskFlags(disclosures),
    sourceUrl: statementReceipt
      ? "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + statementReceipt
      : "https://dart.fss.or.kr/",
    lineage: {
      provider: "Open DART",
      filingId: statementReceipt,
      periodEnd: String(statements.year),
      taxonomy: "K-IFRS",
      statementBasis: statements.fsDiv,
      accountIds: Object.fromEntries(
        Object.entries(accounts).map(([key, row]) => [key, row?.account_id || null])
      )
    },
    stale: false,
    syncStatus: "ok",
    updatedAt: new Date().toISOString()
  };
}

export async function syncDartCompanies(companies, config, onProgress = () => {}) {
  onProgress("Open DART 기업코드 목록 확인 중");
  const corpCodes = await fetchDartCorpCodes(config.dartApiKey);
  const byStockCode = new Map(
    corpCodes.filter((record) => record.stockCode).map((record) => [record.stockCode, record])
  );
  const results = [];

  for (const company of companies) {
    const corpRecord = byStockCode.get(company.ticker);
    if (!corpRecord) throw new Error(company.ticker + "의 DART 고유번호를 찾지 못했습니다.");
    onProgress("DART " + company.ticker + " 수집 중");
    results.push(await syncDartCompany(company, corpRecord, config));
    await sleep(180);
  }

  return results;
}
