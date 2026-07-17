import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CompanyQueryError,
  createCompanyStore,
  parseCompanyQuery
} from "../lib/company-store.mjs";

const UPDATED_AT = "2026-07-17T00:00:00.000Z";

function strongMetrics() {
  return {
    roe: 25,
    operatingMargin: 25,
    netMargin: 20,
    revenueGrowth: 20,
    operatingIncomeGrowth: 25,
    debtRatio: 50,
    currentRatio: 200,
    fcfMargin: 20,
    cashConversion: 130,
    positiveIncomeYears: 3,
    revenueStability: 95,
    per: null
  };
}

function weakMetrics() {
  return {
    roe: -5,
    operatingMargin: -3,
    netMargin: -4,
    revenueGrowth: -20,
    operatingIncomeGrowth: -30,
    debtRatio: 300,
    currentRatio: 50,
    fcfMargin: -10,
    cashConversion: 10,
    positiveIncomeYears: 1,
    revenueStability: 20,
    per: null
  };
}

function company(index, overrides = {}) {
  const ticker = String(index).padStart(6, "0");
  return {
    id: "KR-" + ticker,
    providerId: "corp-" + ticker,
    name: "기업 " + ticker,
    nameEn: "Company " + ticker,
    ticker,
    country: "KR",
    exchange: "KOSPI",
    sector: "정보기술",
    currency: "KRW",
    period: "2025 사업연도",
    statementBasis: "K-IFRS · 연결재무제표",
    dataMode: "live",
    metrics: strongMetrics(),
    history: [
      { label: "2023", revenue: 100, operatingIncome: 20 },
      { label: "2024", revenue: 120, operatingIncome: 24 },
      { label: "2025", revenue: 150, operatingIncome: 32 }
    ],
    historyUnit: "KRW billion",
    disclosures: [
      {
        id: "filing-" + ticker,
        title: "사업보고서",
        form: "사업보고서",
        date: "2026-07-10",
        url: "https://example.com/filing/" + ticker,
        source: "Open DART"
      }
    ],
    latestDisclosure: { date: "2026-07-10" },
    riskFlags: [],
    sourceUrl: "https://example.com/company/" + ticker,
    lineage: { provider: "Open DART", filingId: "filing-" + ticker },
    validation: { score: 100 },
    stale: false,
    syncStatus: "ok",
    updatedAt: UPDATED_AT,
    ...overrides
  };
}

function dataset(companies, updatedAt = UPDATED_AT) {
  return {
    meta: {
      schemaVersion: 1,
      dataMode: "live",
      updatedAt,
      note: "테스트 스냅샷",
      sources: [],
      sync: {
        status: "partial",
        successful: companies.length,
        attempted: companies.length + 1,
        failed: 1,
        errors: [{ company: "비공개", message: "목록 API에서 제외되어야 함" }]
      }
    },
    companies
  };
}

async function temporaryDataset(companies) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "longview-store-"));
  const file = path.join(directory, "companies.json");
  await writeFile(file, JSON.stringify(dataset(companies)), "utf8");
  return { directory, file };
}

function query(value = "") {
  return parseCompanyQuery(new URLSearchParams(value));
}

test("쿼리 파서는 허용값과 상한을 검증한다", () => {
  assert.deepEqual(query(), {
    q: "",
    normalizedQuery: "",
    country: "ALL",
    sector: "ALL",
    sort: "score",
    candidateOnly: false,
    page: 1,
    pageSize: 25
  });
  assert.equal(query("candidateOnly=1&country=kr").candidateOnly, true);
  assert.throws(() => query("sort=random"), CompanyQueryError);
  assert.throws(() => query("page=0"), CompanyQueryError);
  assert.throws(() => query("pageSize=101"), CompanyQueryError);
  assert.throws(() => query("candidateOnly=yes"), CompanyQueryError);
  assert.throws(() => query("q=" + "가".repeat(101)), CompanyQueryError);
});

test("목록은 서버 필터·안정 정렬·페이지네이션을 적용하고 상세 필드를 제외한다", async (t) => {
  const companies = [
    company(1, { name: "알파", nameEn: "Alpha", sector: "정보기술" }),
    company(2, { name: "베타", sector: "소재", metrics: weakMetrics() }),
    company(3, {
      id: "US-ALP",
      ticker: "ALP",
      name: "Alpha US",
      nameEn: "Alpha",
      country: "US",
      exchange: "NASDAQ",
      sector: "정보기술"
    }),
    company(4, { name: "델타", sector: "필수소비재" })
  ];
  const temporary = await temporaryDataset(companies);
  t.after(() => rm(temporary.directory, { recursive: true, force: true }));
  const store = await createCompanyStore(temporary.file, { refreshIntervalMs: 0 });

  const overview = store.getOverview();
  assert.equal(overview.summary.companies, 4);
  assert.equal(overview.meta.sync.failed, 1);
  assert.equal("errors" in overview.meta.sync, false);
  assert.equal(overview.facets.countries.find((item) => item.value === "US").count, 1);

  const firstPage = store.list(query("pageSize=2"));
  assert.equal(firstPage.pagination.total, 4);
  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.items[0].position, 1);
  assert.equal(firstPage.pagination.hasNext, true);
  assert.equal("disclosures" in firstPage.items[0], false);
  assert.equal("lineage" in firstPage.items[0], false);
  assert.equal(firstPage.items[0].reasons.length, 1);

  const filtered = store.list(
    query("q=%EF%BC%A1%EF%BC%AC%EF%BC%B0%EF%BC%A8%EF%BC%A1&country=US&sector=정보기술")
  );
  assert.equal(filtered.pagination.total, 1);
  assert.equal(filtered.items[0].id, "US-ALP");

  const candidates = store.list(query("candidateOnly=true&pageSize=100"));
  assert.equal(candidates.items.some((item) => item.id === "KR-000002"), false);
  assert.ok(candidates.items.every((item) => item.score.candidate.eligible));

  const byName = store.list(query("sort=name&pageSize=100"));
  const names = byName.items.map((item) => item.name);
  assert.deepEqual(names, [...names].sort((left, right) => left.localeCompare(right, "ko")));

  const detail = store.getCompany("US-ALP");
  assert.equal(detail.disclosures.length, 1);
  assert.equal(detail.lineage.provider, "Open DART");
  assert.equal(store.getCompany("US-NOT-FOUND"), null);
});

test("외부 파일 교체를 감지하고 잘못된 새 파일에서는 마지막 정상 스냅샷을 유지한다", async (t) => {
  const temporary = await temporaryDataset([company(1)]);
  t.after(() => rm(temporary.directory, { recursive: true, force: true }));
  const store = await createCompanyStore(temporary.file, { refreshIntervalMs: 0 });
  const firstRevision = store.getOverview().revision;

  await writeFile(
    temporary.file,
    JSON.stringify(dataset([company(1), company(2)], "2026-07-18T00:00:00.000Z")),
    "utf8"
  );
  assert.equal(await store.refreshIfChanged(), true);
  assert.notEqual(store.getOverview().revision, firstRevision);
  assert.equal(store.getOverview().summary.companies, 2);

  await writeFile(temporary.file, "{ invalid json", "utf8");
  assert.equal(await store.refreshIfChanged({ force: true }), false);
  assert.equal(store.getOverview().summary.companies, 2);
  assert.equal(store.getStatus().dataLoadStatus, "stale");
});

test("평가 보류와 데이터 부족 기업은 점수가 높아도 평가 가능한 기업 뒤에 둔다", async (t) => {
  const held = company(2, {
    analysisStatus: "ok",
    modelApplicability: { status: "not_applicable", reason: "테스트 모델 제외" }
  });
  const insufficient = company(3, {
    analysisStatus: "insufficient_data",
    metrics: {}
  });
  const temporary = await temporaryDataset([
    held,
    insufficient,
    company(1, { metrics: weakMetrics() })
  ]);
  t.after(() => rm(temporary.directory, { recursive: true, force: true }));
  const store = await createCompanyStore(temporary.file, { refreshIntervalMs: 0 });

  const result = store.list(query("sort=score&pageSize=100"));
  assert.equal(result.items[0].id, "KR-000001");
  assert.equal(result.items.at(-1).id, "KR-000002");
  assert.equal(result.items.at(-1).analysisStatus, "not_applicable");
});

test("10,000개 데이터도 한 페이지의 경량 응답만 반환한다", async (t) => {
  const companies = Array.from({ length: 10_000 }, (_, index) =>
    company(index + 1, {
      country: index % 2 === 0 ? "KR" : "US",
      id: (index % 2 === 0 ? "KR-" : "US-") + String(index + 1).padStart(6, "0")
    })
  );
  const temporary = await temporaryDataset(companies);
  t.after(() => rm(temporary.directory, { recursive: true, force: true }));
  const store = await createCompanyStore(temporary.file, { refreshIntervalMs: 0 });
  const result = store.list(query("country=US&page=50&pageSize=50"));

  assert.equal(result.pagination.total, 5_000);
  assert.equal(result.items.length, 50);
  assert.equal(result.items[0].position, 2_451);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 500_000);
});
