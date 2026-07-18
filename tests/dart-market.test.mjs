import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildDartMarketCompany,
  chunkDartCompanies,
  defaultDartAnnualBusinessYear,
  defaultDartFinancialPeriods,
  deriveDartMarketMetrics,
  evaluateDartCashFlowCompatibility,
  getDartMarketApiLimits,
  hasDartCoreFinancials,
  mergeDartDisclosures,
  normalizeDartFinancialIndices,
  normalizeDartCashFlowStatement,
  normalizeDartMainAccounts,
  parseDartNumber,
  planDartUniverseRefresh,
  selectDartFinancialPeriod,
  syncDartMarket
} from "../lib/providers/dart-market.mjs";

test("DART 숫자는 쉼표·괄호 음수를 정규화하고 비수치 표시는 결측으로 둔다", () => {
  assert.equal(parseDartNumber("1,234.5"), 1234.5);
  assert.equal(parseDartNumber("(9,000)"), -9000);
  assert.equal(parseDartNumber("#########"), null);
  assert.equal(parseDartNumber("-"), null);
  assert.equal(parseDartNumber(null), null);
});

test("DART 연간 현금흐름은 exact XBRL ID를 우선하고 결측 CAPEX를 0으로 만들지 않는다", () => {
  const rows = [
    {
      corp_code: "00126380",
      fs_div: "CFS",
      sj_div: "CF",
      account_id: "custom_wrong",
      account_nm: "영업활동 현금흐름",
      thstrm_amount: "999",
      bsns_year: "2025",
      reprt_code: "11011"
    },
    {
      corp_code: "00126380",
      fs_div: "CFS",
      sj_div: "CF",
      account_id: "ifrs-full_CashFlowsFromUsedInOperatingActivities",
      account_nm: "영업활동으로 인한 현금흐름",
      thstrm_amount: "(120)",
      bsns_year: "2025",
      reprt_code: "11011",
      rcept_no: "20260301000001"
    }
  ];
  const cashFlow = normalizeDartCashFlowStatement(rows, {
    corpCode: "00126380",
    statementBasis: "CFS",
    businessYear: "2025"
  });
  assert.equal(cashFlow.accounts.operatingCashFlow.value, -120);
  assert.equal(cashFlow.accounts.capex, null);

  const annualAccounts = {
    statementBasis: "CFS",
    businessYear: "2025",
    reportCode: "11011",
    currency: "KRW",
    filingId: "20260301000001",
    accounts: {
      revenue: { current: 1000, previous: 900, twoYearsAgo: 800 },
      netIncome: { current: 100, previous: 90, twoYearsAgo: 80 }
    }
  };
  const annualPeriod = { businessYear: "2025", reportCode: "11011" };
  const metrics = deriveDartMarketMetrics(
    annualAccounts,
    {},
    annualAccounts,
    cashFlow,
    annualPeriod
  );
  assert.equal(metrics.fcfMargin, null);
  assert.equal(metrics.cashConversion, -120);

  const quarterlyPeriod = { businessYear: "2026", reportCode: "11013" };
  assert.equal(
    evaluateDartCashFlowCompatibility(annualAccounts, quarterlyPeriod, cashFlow)
      .compatible,
    false
  );
  assert.equal(
    deriveDartMarketMetrics(
      annualAccounts,
      {},
      annualAccounts,
      cashFlow,
      quarterlyPeriod
    ).cashConversion,
    null
  );
  assert.equal(
    evaluateDartCashFlowCompatibility(
      { ...annualAccounts, statementBasis: "OFS" },
      annualPeriod,
      cashFlow
    ).compatible,
    false
  );
});

test("사업보고서 기본연도는 1~3월에 아직 제출되지 않은 직전 연도를 선택하지 않는다", () => {
  assert.equal(
    defaultDartAnnualBusinessYear(new Date("2027-02-01T00:00:00.000Z")),
    "2025"
  );
  assert.equal(
    defaultDartAnnualBusinessYear(new Date("2027-04-01T00:00:00.000Z")),
    "2026"
  );
});

test("DART financial periods advance only after conservative KST filing cutoffs", () => {
  assert.deepEqual(
    defaultDartFinancialPeriods(new Date("2027-03-31T14:59:00.000Z")),
    {
      latest: { businessYear: "2026", reportCode: "11014", role: "latest" },
      annualFallback: {
        businessYear: "2025",
        reportCode: "11011",
        role: "annual_fallback"
      }
    }
  );
  assert.deepEqual(
    defaultDartFinancialPeriods(new Date("2027-03-31T15:00:00.000Z")),
    {
      latest: { businessYear: "2026", reportCode: "11011", role: "latest" },
      annualFallback: {
        businessYear: "2026",
        reportCode: "11011",
        role: "annual_fallback"
      }
    }
  );
  assert.equal(
    defaultDartFinancialPeriods(new Date("2027-05-15T14:59:00.000Z")).latest.reportCode,
    "11011"
  );
  assert.deepEqual(
    defaultDartFinancialPeriods(new Date("2027-05-15T15:00:00.000Z")).latest,
    { businessYear: "2027", reportCode: "11013", role: "latest" }
  );
  assert.deepEqual(
    defaultDartFinancialPeriods(new Date("2027-08-14T15:00:00.000Z")).latest,
    { businessYear: "2027", reportCode: "11012", role: "latest" }
  );
  assert.deepEqual(
    defaultDartFinancialPeriods(new Date("2027-11-14T15:00:00.000Z")).latest,
    { businessYear: "2027", reportCode: "11014", role: "latest" }
  );
});

test("DART financial selection uses latest core data and otherwise annual fallback", () => {
  const coreAccounts = (revenue, netIncome) => ({
    accounts: {
      revenue: { current: revenue },
      netIncome: { current: netIncome }
    }
  });
  const periodResults = [
    {
      period: {
        businessYear: "2027",
        reportCode: "11013",
        roles: ["latest"]
      },
      cache: {
        accountsByCorpCode: {
          "00000001": coreAccounts(120, 12),
          "00000002": coreAccounts(80, null)
        },
        indicesByCorpCode: {
          "00000001": { metrics: { roe: 11 } },
          "00000002": { metrics: { roe: 1 } }
        },
        errorsByCorpCode: {}
      }
    },
    {
      period: {
        businessYear: "2026",
        reportCode: "11011",
        roles: ["annual_fallback"]
      },
      cache: {
        accountsByCorpCode: {
          "00000001": coreAccounts(100, 10),
          "00000002": coreAccounts(70, 7)
        },
        indicesByCorpCode: {
          "00000001": { metrics: { roe: 9 } },
          "00000002": { metrics: { roe: 8 } }
        },
        errorsByCorpCode: {}
      }
    }
  ];

  const latest = selectDartFinancialPeriod(periodResults, "00000001");
  const fallback = selectDartFinancialPeriod(periodResults, "00000002");
  assert.equal(hasDartCoreFinancials(latest.mainAccounts), true);
  assert.equal(latest.selection, "latest");
  assert.equal(latest.period.reportCode, "11013");
  assert.equal(latest.financialIndices.metrics.roe, 11);
  assert.equal(latest.continuityPeriod.reportCode, "11011");
  assert.equal(latest.continuityAccounts.accounts.revenue.current, 100);
  assert.equal(fallback.selection, "annual_fallback");
  assert.equal(fallback.period.reportCode, "11011");
  assert.equal(fallback.mainAccounts.accounts.revenue.current, 70);
  assert.equal(fallback.financialIndices.metrics.roe, 8);
});

test("다중회사 요청은 공식 최대치인 100개 이하로 분할한다", () => {
  const companies = Array.from({ length: 205 }, (_, index) => ({ corpCode: String(index) }));
  const chunks = chunkDartCompanies(companies);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [100, 100, 5]);
  assert.throws(() => chunkDartCompanies(companies, 101), RangeError);
  assert.equal(getDartMarketApiLimits().maximumCompaniesPerBatch, 100);
  assert.equal(getDartMarketApiLimits().defaultFinancialBatchSize, 50);
  assert.equal(getDartMarketApiLimits().defaultFinancialTimeoutMs, 60_000);
});

test("주요계정은 연결재무제표를 우선하고 사업보고서 3개년 금액을 보존한다", () => {
  const common = {
    stock_code: "005930",
    bsns_year: "2025",
    reprt_code: "11011",
    rcept_no: "20260301000001",
    currency: "KRW"
  };
  const rows = [
    {
      ...common,
      fs_div: "OFS",
      sj_div: "IS",
      account_nm: "매출액",
      thstrm_amount: "80",
      frmtrm_amount: "70",
      bfefrmtrm_amount: "60"
    },
    {
      ...common,
      fs_div: "CFS",
      sj_div: "IS",
      account_nm: "매출액",
      thstrm_amount: "100",
      frmtrm_amount: "90",
      bfefrmtrm_amount: "75"
    },
    {
      ...common,
      fs_div: "CFS",
      sj_div: "IS",
      account_nm: "영업이익",
      thstrm_amount: "20",
      frmtrm_amount: "15",
      bfefrmtrm_amount: "10"
    },
    {
      ...common,
      fs_div: "CFS",
      sj_div: "IS",
      account_nm: "당기순이익(손실)",
      thstrm_amount: "10",
      frmtrm_amount: "9",
      bfefrmtrm_amount: "-2"
    },
    {
      ...common,
      fs_div: "CFS",
      sj_div: "BS",
      account_nm: "자본총계",
      thstrm_amount: "60",
      frmtrm_amount: "50",
      bfefrmtrm_amount: "45"
    },
    {
      ...common,
      fs_div: "CFS",
      sj_div: "BS",
      account_nm: "부채총계",
      thstrm_amount: "30",
      frmtrm_amount: "28",
      bfefrmtrm_amount: "25"
    },
    {
      ...common,
      fs_div: "CFS",
      sj_div: "BS",
      account_nm: "유동자산",
      thstrm_amount: "40"
    },
    {
      ...common,
      fs_div: "CFS",
      sj_div: "BS",
      account_nm: "유동부채",
      thstrm_amount: "20"
    }
  ];

  const normalized = normalizeDartMainAccounts(rows)["005930"];
  assert.equal(normalized.statementBasis, "CFS");
  assert.equal(normalized.accounts.revenue.current, 100);
  assert.equal(normalized.accounts.revenue.twoYearsAgo, 75);
  assert.equal(normalized.accounts.netIncome.twoYearsAgo, -2);

  const metrics = deriveDartMarketMetrics(normalized);
  assert.equal(metrics.operatingMargin, 20);
  assert.equal(metrics.netMargin, 10);
  assert.equal(metrics.debtRatio, 50);
  assert.equal(metrics.currentRatio, 200);
  assert.equal(metrics.positiveIncomeYears, 2);
  assert.equal(metrics.fcfMargin, null);
});

test("분기 손익계정은 3개월 값보다 누적금액을 우선한다", () => {
  const normalized = normalizeDartMainAccounts([
    {
      stock_code: "000001",
      fs_div: "CFS",
      sj_div: "IS",
      account_nm: "매출액",
      reprt_code: "11014",
      thstrm_amount: "30",
      thstrm_add_amount: "90",
      frmtrm_q_amount: "25",
      frmtrm_add_amount: "75"
    }
  ])["000001"];
  assert.equal(normalized.accounts.revenue.current, 90);
  assert.equal(normalized.accounts.revenue.previous, 75);
});

test("공식 재무지표 코드를 점수 지표로 매핑하고 비수치 값은 버린다", () => {
  const normalized = normalizeDartFinancialIndices([
    {
      corp_code: "00126380",
      stock_code: "005930",
      idx_code: "M211550",
      idx_nm: "ROE",
      idx_val: "10.783"
    },
    {
      corp_code: "00126380",
      stock_code: "005930",
      idx_code: "M221100",
      idx_nm: "부채비율",
      idx_val: "29.937"
    },
    {
      corp_code: "00126380",
      stock_code: "005930",
      idx_code: "M242000",
      idx_nm: "자본금회전율",
      idx_val: "#########"
    }
  ])["00126380"];

  assert.equal(normalized.metrics.roe, 10.783);
  assert.equal(normalized.metrics.debtRatio, 29.937);
  assert.equal(normalized.indices.M242000.value, null);
});

test("최근 공시는 접수번호로 중복 제거하고 최신순으로 합친다", () => {
  const merged = mergeDartDisclosures(
    [
      { id: "1", date: "2026-07-15", title: "기존 제목" },
      { id: "2", date: "2026-07-14", title: "둘째" }
    ],
    [
      { id: "1", date: "2026-07-15", title: "갱신 제목" },
      { id: "3", date: "2026-07-16", title: "최신" }
    ],
    { now: new Date("2026-07-17T00:00:00.000Z") }
  );
  assert.deepEqual(merged.map((filing) => filing.id), ["3", "1", "2"]);
  assert.equal(merged[1].title, "갱신 제목");
});

test("universe 계획은 변경 기업만 재조회하고 사라진 종목을 비활성화한다", () => {
  const plan = planDartUniverseRefresh(
    [
      {
        corpCode: "00000001",
        stockCode: "000001",
        name: "유지회사",
        modifiedAt: "20260701"
      },
      {
        corpCode: "00000002",
        stockCode: "000002",
        name: "변경회사",
        modifiedAt: "20260710"
      }
    ],
    [
      {
        corpCode: "00000001",
        stockCode: "000001",
        corpCls: "Y",
        overviewModifiedAt: "20260701",
        active: true
      },
      {
        corpCode: "00000002",
        stockCode: "000002",
        corpCls: "K",
        overviewModifiedAt: "20260701",
        active: true
      },
      {
        corpCode: "00000003",
        stockCode: "000003",
        corpCls: "K",
        overviewModifiedAt: "20260701",
        active: true
      }
    ]
  );

  assert.deepEqual(plan.reuse.map((entry) => entry.corpCode), ["00000001"]);
  assert.deepEqual(plan.refresh.map((entry) => entry.record.corpCode), ["00000002"]);
  assert.equal(plan.inactive[0].corpCode, "00000003");
  assert.equal(plan.inactive[0].active, false);
});

test("회사 정규화는 현금흐름 결측을 임의 값으로 채우지 않는다", () => {
  const mainAccounts = normalizeDartMainAccounts([
    {
      stock_code: "000001",
      fs_div: "CFS",
      sj_div: "IS",
      account_nm: "매출액",
      thstrm_amount: "100",
      frmtrm_amount: "90",
      bfefrmtrm_amount: "80",
      reprt_code: "11011",
      bsns_year: "2025",
      rcept_no: "20260301000001",
      currency: "KRW"
    },
    {
      stock_code: "000001",
      fs_div: "CFS",
      sj_div: "IS",
      account_nm: "당기순이익(손실)",
      thstrm_amount: "10",
      frmtrm_amount: "9",
      bfefrmtrm_amount: "8",
      reprt_code: "11011"
    }
  ])["000001"];
  const company = buildDartMarketCompany({
    universeEntry: {
      corpCode: "00000001",
      stockCode: "000001",
      name: "테스트",
      exchange: "KOSPI"
    },
    mainAccounts,
    financialIndices: null,
    disclosures: [],
    businessYear: "2025",
    reportCode: "11011",
    now: new Date("2026-07-17T00:00:00.000Z")
  });
  assert.equal(company.dataStatus, "live");
  assert.equal(company.metrics.fcfMargin, null);
  assert.equal(company.metrics.cashConversion, null);
  assert.equal(company.lineage.filingId, "20260301000001");

  const pending = buildDartMarketCompany({
    universeEntry: {
      corpCode: "00000002",
      stockCode: "000002",
      name: "신규상장사",
      exchange: "KOSDAQ"
    },
    mainAccounts: null,
    financialIndices: null,
    disclosures: [],
    businessYear: "2025",
    reportCode: "11011",
    now: new Date("2026-07-17T00:00:00.000Z")
  });
  assert.equal(pending.dataMode, "insufficient_data");
  assert.equal(pending.syncStatus, "insufficient_data");

  const bank = buildDartMarketCompany({
    universeEntry: {
      corpCode: "00000003",
      stockCode: "000003",
      name: "테스트은행",
      exchange: "KOSPI",
      industryCode: "64120"
    },
    mainAccounts,
    financialIndices: null,
    disclosures: [],
    businessYear: "2025",
    reportCode: "11011",
    now: new Date("2026-07-17T00:00:00.000Z")
  });
  assert.equal(bank.dataMode, "not_applicable");
  assert.equal(bank.modelApplicability.status, "not_applicable");
});

test("같은 실행 ID로 재시작하면 DART 목록 지연에도 저장된 체크포인트를 재사용한다", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "longview-dart-market-"));
  const stockByCorp = { "00000001": "000001", "00000002": "000002" };
  let companyCalls = 0;
  let apiCalls = 0;
  let corpCodeCalls = 0;
  let failCorpCodeFetch = false;
  const progress = [];
  const fetchCorpCodes = async () => {
    corpCodeCalls += 1;
    if (failCorpCodeFetch) throw new Error("temporary corpCode timeout");
    return [
      {
        corpCode: "00000001",
        stockCode: "000001",
        name: "코스피회사",
        modifiedAt: "20260701"
      },
      {
        corpCode: "00000002",
        stockCode: "000002",
        name: "코스닥회사",
        modifiedAt: "20260701"
      }
    ];
  };
  const fetchJsonImpl = async (url, requestOptions) => {
    assert.equal(requestOptions?.retries, 0);
    apiCalls += 1;
    const endpoint = new URL(url).pathname.split("/").at(-1);
    if (["fnlttMultiAcnt.json", "fnlttCmpnyIndx.json"].includes(endpoint)) {
      assert.equal(requestOptions?.timeoutMs, 60_000);
    }
    const parameters = new URL(url).searchParams;
    if (endpoint === "company.json") {
      companyCalls += 1;
      const corpCode = parameters.get("corp_code");
      return {
        status: "000",
        corp_name: corpCode === "00000001" ? "코스피회사" : "코스닥회사",
        stock_name: corpCode === "00000001" ? "코스피회사" : "코스닥회사",
        stock_code: stockByCorp[corpCode],
        corp_cls: corpCode === "00000001" ? "Y" : "K",
        induty_code: "100000",
        acc_mt: "12"
      };
    }
    if (endpoint === "list.json" || endpoint === "fnlttCmpnyIndx.json") {
      return { status: "013", message: "조회된 데이타가 없습니다." };
    }
    if (endpoint === "fnlttMultiAcnt.json") {
      const corpCodes = parameters.get("corp_code").split(",");
      return {
        status: "000",
        list: corpCodes.flatMap((corpCode) => {
          const common = {
            stock_code: stockByCorp[corpCode],
            fs_div: "CFS",
            reprt_code: "11011",
            bsns_year: "2025",
            rcept_no: `20260301${corpCode.slice(-6)}`,
            currency: "KRW"
          };
          return [
            {
              ...common,
              sj_div: "IS",
              account_nm: "매출액",
              thstrm_amount: "100",
              frmtrm_amount: "90",
              bfefrmtrm_amount: "80"
            },
            {
              ...common,
              sj_div: "IS",
              account_nm: "당기순이익(손실)",
              thstrm_amount: "10",
              frmtrm_amount: "9",
              bfefrmtrm_amount: "8"
            }
          ];
        })
      };
    }
    throw new Error(`예상하지 않은 endpoint: ${endpoint}`);
  };

  try {
    const options = {
      dataDir: temporary,
      runId: "2026-07-17-test",
      now: new Date("2026-07-17T00:00:00.000Z"),
      businessYear: "2025",
      reportCode: "11011",
      disclosureLookbackDays: 1,
      minIntervalMs: 0,
      maxRequests: 100,
      minimumUniverseCount: 2,
      minimumKospiCount: 1,
      minimumKosdaqCount: 1,
      fetchCorpCodes,
      fetchJsonImpl,
      onProgress: (message) => progress.push(message)
    };
    const first = await syncDartMarket({ dartApiKey: "x".repeat(40) }, options);
    const callsAfterFirst = apiCalls;
    failCorpCodeFetch = true;
    const second = await syncDartMarket({ dartApiKey: "x".repeat(40) }, options);

    assert.equal(first.companies.length, 2);
    assert.equal(first.meta.universeComplete, true);
    assert.equal(companyCalls, 2);
    assert.equal(corpCodeCalls, 2);
    assert.equal(second.companies.length, 2);
    assert.equal(apiCalls, callsAfterFirst);
    assert.ok(second.companies.every((company) => company.dataStatus === "live"));
    assert.equal(second.meta.universeListSource, "cached_fallback");
    assert.ok(progress.some((message) => message.includes("저장된 목록 2개로 안전하게 재개")));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("DART 목록 지연 시 최근 부분 universe에서 미처리 기업개황만 재개한다", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "longview-dart-partial-universe-"));
  const now = new Date("2026-07-17T00:00:00.000Z");
  await writeFile(
    path.join(temporary, "universe.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      source: "Open DART",
      fetchedAt: now.toISOString(),
      complete: false,
      pendingOverviewCount: 1,
      entries: [
        {
          corpCode: "00000001",
          stockCode: "000001",
          name: "완료회사",
          legalName: "완료회사",
          corpCls: "Y",
          exchange: "KOSPI",
          modifiedAt: "20260701",
          overviewModifiedAt: "20260701",
          active: true,
          needsRefresh: false
        },
        {
          corpCode: "00000002",
          stockCode: "000002",
          name: "미처리회사",
          legalName: "미처리회사",
          modifiedAt: "20260701",
          active: false,
          needsRefresh: true
        }
      ]
    })}\n`,
    "utf8"
  );
  let companyCalls = 0;

  try {
    const dataset = await syncDartMarket(
      { dartApiKey: "x".repeat(40) },
      {
        dataDir: temporary,
        runId: "2026-07-17-partial",
        now,
        businessYear: "2025",
        reportCode: "11011",
        disclosureLookbackDays: 1,
        minIntervalMs: 0,
        maxRequests: 100,
        minimumUniverseCount: 2,
        minimumKospiCount: 1,
        minimumKosdaqCount: 1,
        fetchCorpCodes: async () => {
          throw new Error("temporary corpCode timeout");
        },
        fetchJsonImpl: async (url) => {
          const endpoint = new URL(url).pathname.split("/").at(-1);
          if (endpoint === "company.json") {
            companyCalls += 1;
            return {
              status: "000",
              corp_name: "미처리회사",
              stock_name: "미처리회사",
              stock_code: "000002",
              corp_cls: "K",
              induty_code: "100000",
              acc_mt: "12"
            };
          }
          return { status: "013", message: "조회된 데이타가 없습니다." };
        }
      }
    );

    assert.equal(companyCalls, 1);
    assert.equal(dataset.companies.length, 2);
    assert.equal(dataset.meta.universeComplete, true);
    assert.equal(dataset.meta.universeListSource, "cached_fallback");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("DART 저장 목록이 오래되면 원격 목록 오류를 숨기지 않는다", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "longview-dart-stale-universe-"));
  await writeFile(
    path.join(temporary, "universe.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      source: "Open DART",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      complete: true,
      pendingOverviewCount: 0,
      entries: [
        { corpCode: "00000001", stockCode: "000001" },
        { corpCode: "00000002", stockCode: "000002" }
      ]
    })}\n`,
    "utf8"
  );

  try {
    await assert.rejects(
      syncDartMarket(
        { dartApiKey: "x".repeat(40) },
        {
          dataDir: temporary,
          now: new Date("2026-07-17T00:00:00.000Z"),
          minIntervalMs: 0,
          minimumUniverseCount: 2,
          fetchCorpCodes: async () => {
            throw new Error("corpCode timeout must surface");
          }
        }
      ),
      /corpCode timeout must surface/
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("default market sync collects latest and annual periods and falls back per company", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "longview-dart-periods-"));
  const stockByCorp = { "00000001": "000001", "00000002": "000002" };
  const requestedReports = new Set();
  const fetchCorpCodes = async () => [
    {
      corpCode: "00000001",
      stockCode: "000001",
      name: "Latest Corp",
      modifiedAt: "20260701"
    },
    {
      corpCode: "00000002",
      stockCode: "000002",
      name: "Fallback Corp",
      modifiedAt: "20260701"
    }
  ];
  const fetchJsonImpl = async (url) => {
    const parsed = new URL(url);
    const endpoint = parsed.pathname.split("/").at(-1);
    const parameters = parsed.searchParams;
    if (endpoint === "company.json") {
      const corpCode = parameters.get("corp_code");
      return {
        status: "000",
        corp_name: corpCode === "00000001" ? "Latest Corp" : "Fallback Corp",
        stock_name: corpCode === "00000001" ? "Latest Corp" : "Fallback Corp",
        stock_code: stockByCorp[corpCode],
        corp_cls: corpCode === "00000001" ? "Y" : "K",
        induty_code: "100000",
        acc_mt: "12"
      };
    }
    if (endpoint === "list.json" || endpoint === "fnlttCmpnyIndx.json") {
      return { status: "013", message: "No data" };
    }
    if (endpoint === "fnlttMultiAcnt.json") {
      const reportCode = parameters.get("reprt_code");
      requestedReports.add(reportCode);
      const businessYear = parameters.get("bsns_year");
      const corpCodes = parameters.get("corp_code").split(",");
      return {
        status: "000",
        list: corpCodes.flatMap((corpCode) => {
          const common = {
            stock_code: stockByCorp[corpCode],
            fs_div: "CFS",
            reprt_code: reportCode,
            bsns_year: businessYear,
            rcept_no: `${businessYear}${reportCode}${corpCode.slice(-2)}`,
            currency: "KRW"
          };
          const rows = [
            {
              ...common,
              sj_div: "IS",
              account_nm: "매출액",
              thstrm_amount: reportCode === "11013" ? "30" : "100",
              thstrm_add_amount: reportCode === "11013" ? "30" : undefined,
              frmtrm_amount: "90"
            }
          ];
          if (reportCode === "11011" || corpCode === "00000001") {
            rows.push({
              ...common,
              sj_div: "IS",
              account_nm: "당기순이익(손실)",
              thstrm_amount: reportCode === "11013" ? "3" : "10",
              thstrm_add_amount: reportCode === "11013" ? "3" : undefined,
              frmtrm_amount: "9"
            });
          }
          return rows;
        })
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  try {
    const dataset = await syncDartMarket(
      { dartApiKey: "x".repeat(40) },
      {
        dataDir: temporary,
        runId: "2026-07-17-periods",
        now: new Date("2026-07-17T00:00:00.000Z"),
        disclosureLookbackDays: 1,
        minIntervalMs: 0,
        maxRequests: 100,
        minimumUniverseCount: 2,
        minimumKospiCount: 1,
        minimumKosdaqCount: 1,
        fetchCorpCodes,
        fetchJsonImpl
      }
    );

    assert.deepEqual([...requestedReports].sort(), ["11011", "11013"]);
    assert.equal(dataset.companies[0].lineage.reportCode, "11013");
    assert.equal(dataset.companies[0].lineage.periodSelection, "latest");
    assert.equal(dataset.companies[1].lineage.reportCode, "11011");
    assert.equal(dataset.companies[1].lineage.periodSelection, "annual_fallback");
    assert.equal(dataset.meta.latestPeriodCount, 1);
    assert.equal(dataset.meta.annualFallbackCount, 1);
    await readFile(path.join(temporary, "financials-2026-11013.json"), "utf8");
    await readFile(path.join(temporary, "financials.json"), "utf8");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("기업개황이 하나라도 미확정이면 불완전한 전체시장 파일을 만들지 않는다", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "longview-dart-incomplete-"));
  try {
    await assert.rejects(
      syncDartMarket(
        { dartApiKey: "x".repeat(40) },
        {
          dataDir: temporary,
          runId: "2026-07-17-incomplete",
          now: new Date("2026-07-17T00:00:00.000Z"),
          minIntervalMs: 0,
          maxRequests: 10,
          minimumUniverseCount: 1,
          fetchCorpCodes: async () => [
            {
              corpCode: "00000001",
              stockCode: "000001",
              name: "확인실패회사",
              modifiedAt: "20260701"
            }
          ],
          fetchJsonImpl: async () => ({ status: "999", message: "일시 오류" })
        }
      ),
      /기업개황 1개를 확인하지 못했습니다/
    );
    await assert.rejects(readFile(path.join(temporary, "companies.json"), "utf8"), {
      code: "ENOENT"
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("DART 연간 현금흐름은 체크포인트를 재사용해 FCF를 같은 연도에서 계산한다", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "longview-dart-cashflow-"));
  let cashFlowCalls = 0;
  let annualFilingId = "20260301000001";
  let operatingCashFlowAmount = 30;
  const fetchCorpCodes = async () => [
    {
      corpCode: "00000001",
      stockCode: "000001",
      name: "현금회사",
      modifiedAt: "20260701"
    }
  ];
  const fetchJsonImpl = async (url) => {
    const parsed = new URL(url);
    const endpoint = parsed.pathname.split("/").at(-1);
    if (endpoint === "company.json") {
      return {
        status: "000",
        corp_name: "현금회사",
        stock_name: "현금회사",
        stock_code: "000001",
        corp_cls: "Y",
        induty_code: "100000",
        acc_mt: "12"
      };
    }
    if (endpoint === "list.json" || endpoint === "fnlttCmpnyIndx.json") {
      return { status: "013", message: "No data" };
    }
    if (endpoint === "fnlttMultiAcnt.json") {
      return {
        status: "000",
        list: [
          {
            stock_code: "000001",
            corp_code: "00000001",
            fs_div: "CFS",
            sj_div: "IS",
            account_nm: "매출액",
            thstrm_amount: "100",
            frmtrm_amount: "90",
            bfefrmtrm_amount: "80",
            reprt_code: "11011",
            bsns_year: "2025",
            currency: "KRW",
            rcept_no: annualFilingId
          },
          {
            stock_code: "000001",
            corp_code: "00000001",
            fs_div: "CFS",
            sj_div: "IS",
            account_nm: "당기순이익(손실)",
            thstrm_amount: "10",
            frmtrm_amount: "9",
            bfefrmtrm_amount: "8",
            reprt_code: "11011",
            bsns_year: "2025",
            currency: "KRW",
            rcept_no: annualFilingId
          }
        ]
      };
    }
    if (endpoint === "fnlttSinglAcntAll.json") {
      cashFlowCalls += 1;
      assert.equal(parsed.searchParams.get("fs_div"), "CFS");
      return {
        status: "000",
        list: [
          {
            corp_code: "00000001",
            fs_div: "CFS",
            sj_div: "CF",
            account_id: "ifrs-full_CashFlowsFromUsedInOperatingActivities",
            account_nm: "영업활동현금흐름",
            thstrm_amount: String(operatingCashFlowAmount),
            reprt_code: "11011",
            bsns_year: "2025",
            currency: "KRW",
            rcept_no: annualFilingId
          },
          {
            corp_code: "00000001",
            fs_div: "CFS",
            sj_div: "CF",
            account_id: "ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
            account_nm: "유형자산의 취득",
            thstrm_amount: "5",
            reprt_code: "11011",
            bsns_year: "2025",
            currency: "KRW",
            rcept_no: annualFilingId
          }
        ]
      };
    }
    throw new Error("Unexpected endpoint: " + endpoint);
  };

  try {
    const baseOptions = {
      dataDir: temporary,
      now: new Date("2026-07-17T00:00:00.000Z"),
      businessYear: "2025",
      reportCode: "11011",
      disclosureLookbackDays: 1,
      minIntervalMs: 0,
      maxRequests: 100,
      minimumUniverseCount: 1,
      minimumKospiCount: 1,
      minimumKosdaqCount: 0,
      enableCashFlowEnrichment: true,
      fetchCorpCodes,
      fetchJsonImpl
    };
    const first = await syncDartMarket(
      { dartApiKey: "x".repeat(40) },
      { ...baseOptions, runId: "cashflow-first" }
    );
    const second = await syncDartMarket(
      { dartApiKey: "x".repeat(40) },
      { ...baseOptions, runId: "cashflow-second" }
    );
    assert.equal(first.companies[0].metrics.fcfMargin, 25);
    assert.equal(first.companies[0].metrics.cashConversion, 300);
    assert.equal(first.companies[0].financials.latest.freeCashFlow, 25);
    assert.equal(second.companies[0].metrics.fcfMargin, 25);
    assert.equal(cashFlowCalls, 1);
    const cashFlowCacheFile = path.join(temporary, "cashflows-2025-11011.json");
    const cache = JSON.parse(await readFile(cashFlowCacheFile, "utf8"));
    cache.recordsByCorpCode["00000001"] = null;
    await writeFile(cashFlowCacheFile, JSON.stringify(cache), "utf8");

    operatingCashFlowAmount = 40;
    const retriedNull = await syncDartMarket(
      { dartApiKey: "x".repeat(40) },
      { ...baseOptions, runId: "cashflow-null-retry" }
    );
    assert.equal(cashFlowCalls, 2);
    assert.equal(retriedNull.companies[0].financials.latest.freeCashFlow, 35);

    annualFilingId = "20260302000002";
    operatingCashFlowAmount = 50;
    const refreshedFiling = await syncDartMarket(
      { dartApiKey: "x".repeat(40) },
      { ...baseOptions, runId: "cashflow-amended-filing" }
    );
    assert.equal(cashFlowCalls, 3);
    assert.equal(refreshedFiling.companies[0].financials.latest.freeCashFlow, 45);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
