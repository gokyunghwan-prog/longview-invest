import test from "node:test";
import assert from "node:assert/strict";

import { normalizeKoreanSnapshot } from "../lib/korean-snapshot.mjs";

function mixedSnapshot() {
  return {
    meta: {
      schemaVersion: 3,
      dataMode: "mixed",
      updatedAt: "2026-07-19T00:00:00.000Z",
      sourceUpdatedAt: "2026-07-19T00:00:00.000Z",
      universe: {
        companies: 2,
        exchanges: ["KOSPI", "FOREIGN"],
        sourceUrl: "https://example.com/foreign-universe.json"
      },
      note: "혼합 시장 fixture",
      sources: [
        { name: "Open DART", url: "https://opendart.fss.or.kr/" },
        { name: "Foreign regulator", url: "https://example.com/foreign/" }
      ],
      coverage: { total: 2, kr: 1, us: 1 },
      providers: [
        {
          country: "KR",
          provider: "Open DART",
          status: "ok",
          companyCount: 1,
          sourceUpdatedAt: "2026-07-18T00:00:00.000Z"
        },
        {
          country: "JP",
          provider: "Foreign regulator",
          status: "failed",
          companyCount: 1,
          sourceUpdatedAt: "2026-07-19T00:00:00.000Z"
        }
      ],
      marketData: {
        updatedAt: "2026-07-19T01:00:00.000Z",
        lastAttemptAt: "2026-07-19T02:00:00.000Z",
        maxQuoteAgeDays: 10,
        coverage: { kr: 1, us: 1 },
        available: { kr: 1, us: 1 },
        preserved: { kr: 0, us: 1 },
        stale: { kr: 0, us: 1 },
        providers: [
          {
            code: "KR_PUBLIC",
            provider: "금융위원회 주식시세정보",
            status: "ok"
          },
          {
            code: "FOREIGN_PUBLIC",
            provider: "Foreign price feed",
            status: "failed_preserved"
          }
        ],
        remoteSnapshot: {
          coverage: { total: 2, kr: 1, us: 1 },
          sourceUrl: "https://example.com/mixed.json"
        }
      },
      sync: {
        status: "partial",
        successful: 1,
        attempted: 2,
        failed: 1,
        errors: [
          { provider: "Open DART", message: "국내 fixture 오류" },
          { provider: "Foreign regulator", message: "해외 fixture 오류" }
        ]
      }
    },
    companies: [
      {
        id: "KR-005930",
        country: "KR",
        ticker: "005930",
        exchange: "KOSPI",
        name: "삼성전자",
        dataMode: "live",
        marketData: {
          usageMode: "public",
          status: "ok",
          freshness: "current",
          price: 70_000,
          currency: "KRW",
          fetchedAt: "2026-07-18T01:00:00.000Z",
          source: { name: "금융위원회 주식시세정보" }
        }
      },
      {
        id: "JP-TEST",
        country: "JP",
        ticker: "TEST",
        exchange: "FOREIGN",
        name: "Foreign Test",
        dataMode: "live",
        marketData: {
          usageMode: "public",
          status: "preserved",
          freshness: "stale",
          price: 100,
          currency: "JPY"
        }
      }
    ]
  };
}

test("혼합 스냅샷을 국내 회사와 국내 메타데이터만 남기도록 정규화한다", () => {
  const input = mixedSnapshot();
  const before = structuredClone(input);

  const normalized = normalizeKoreanSnapshot(input);

  assert.deepEqual(normalized.companies.map((company) => company.id), ["KR-005930"]);
  assert.deepEqual(normalized.meta.coverage, { total: 1, kr: 1 });
  assert.equal(normalized.meta.dataMode, "live");
  assert.equal(normalized.meta.sourceUpdatedAt, "2026-07-18T00:00:00.000Z");
  assert.equal(normalized.meta.marketData.updatedAt, "2026-07-18T01:00:00.000Z");
  assert.equal(normalized.meta.updatedAt, "2026-07-18T01:00:00.000Z");
  assert.equal(Object.hasOwn(normalized.meta, "universe"), false);
  assert.deepEqual(normalized.meta.sources, [
    { name: "Open DART", url: "https://opendart.fss.or.kr/" }
  ]);
  assert.deepEqual(normalized.meta.providers, [
    {
      country: "KR",
      provider: "Open DART",
      status: "ok",
      companyCount: 1,
      sourceUpdatedAt: "2026-07-18T00:00:00.000Z"
    }
  ]);
  assert.deepEqual(normalized.meta.marketData.coverage, { kr: 1 });
  assert.deepEqual(normalized.meta.marketData.available, { kr: 1 });
  assert.deepEqual(normalized.meta.marketData.preserved, { kr: 0 });
  assert.deepEqual(normalized.meta.marketData.stale, { kr: 0 });
  assert.deepEqual(
    normalized.meta.marketData.providers.map((provider) => provider.code),
    ["KR_PUBLIC"]
  );
  assert.equal(Object.hasOwn(normalized.meta.marketData, "remoteSnapshot"), false);
  assert.deepEqual(normalized.meta.sync, {
    status: "ok",
    successful: 1,
    attempted: 1,
    failed: 0,
    errors: [{ provider: "Open DART", message: "국내 fixture 오류" }]
  });
  assert.equal(Object.hasOwn(normalized.meta.coverage, "us"), false);
  assert.equal(Object.hasOwn(normalized.meta.marketData.coverage, "us"), false);
  assert.equal(JSON.stringify(normalized).includes("Foreign regulator"), false);
  assert.equal(JSON.stringify(normalized).includes("FOREIGN_PUBLIC"), false);
  assert.equal(JSON.stringify(normalized).includes("FOREIGN"), false);

  assert.deepEqual(input, before);
});

test("공급자 메타가 없으면 동기화 성공으로 과장하지 않는다", () => {
  const input = mixedSnapshot();
  input.meta.providers = [];
  input.meta.sync = { status: "failed", attempted: 1, successful: 0, failed: 1 };

  const normalized = normalizeKoreanSnapshot(input);

  assert.deepEqual(normalized.meta.sync, {
    status: "unknown",
    successful: 0,
    attempted: 0,
    failed: 0,
    errors: []
  });
});

test("국내 평가 비적용 기업은 공식 스냅샷을 혼합 데이터로 바꾸지 않는다", () => {
  const input = mixedSnapshot();
  input.companies[0].dataMode = "not_applicable";

  const normalized = normalizeKoreanSnapshot(input);

  assert.equal(normalized.meta.dataMode, "live");
});

test("정규화 결과는 원본과 참조를 공유하지 않는 깊은 복제본이다", () => {
  const input = mixedSnapshot();
  const before = structuredClone(input);
  const normalized = normalizeKoreanSnapshot(input);

  assert.notStrictEqual(normalized.companies[0], input.companies[0]);
  assert.notStrictEqual(normalized.companies[0].marketData, input.companies[0].marketData);
  assert.notStrictEqual(normalized.meta.sources[0], input.meta.sources[0]);
  assert.notStrictEqual(normalized.meta.providers[0], input.meta.providers[0]);
  assert.notStrictEqual(
    normalized.meta.marketData.providers[0],
    input.meta.marketData.providers[0]
  );

  normalized.companies[0].name = "변경된 이름";
  normalized.companies[0].marketData.source.name = "변경된 시세 출처";
  normalized.meta.sources[0].name = "변경된 공시 출처";
  normalized.meta.providers[0].status = "changed";
  normalized.meta.marketData.providers[0].status = "changed";

  assert.deepEqual(input, before);
});
