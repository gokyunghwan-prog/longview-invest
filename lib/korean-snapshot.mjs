const SOURCE_HINTS = [
  "open dart",
  "opendart",
  "dart",
  "dart.fss",
  "data.go.kr",
  "금융위원회",
  "한국거래소",
  "krx"
];

function text(value) {
  return String(value || "").trim();
}

function isKoreanMetadataEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (entry.country) return text(entry.country).toUpperCase() === "KR";
  const searchable = [
    entry.code,
    entry.id,
    entry.name,
    entry.provider,
    entry.originalSource,
    entry.url
  ]
    .map((value) => text(value).toLowerCase())
    .join(" ");
  return SOURCE_HINTS.some((hint) => searchable.includes(hint));
}

function quoteCounts(companies) {
  const quotes = companies
    .map((company) => company.marketData)
    .filter(
      (marketData) =>
        marketData?.usageMode === "public" &&
        Number.isFinite(marketData.price) &&
        marketData.price > 0
    );
  const count = (predicate) => quotes.filter(predicate).length;
  return {
    coverage: {
      kr: count(
        (quote) => quote.status === "ok" && quote.freshness === "current"
      )
    },
    available: { kr: quotes.length },
    preserved: { kr: count((quote) => quote.status === "preserved") },
    stale: {
      kr: count(
        (quote) => quote.status === "stale" || quote.freshness === "stale"
      )
    }
  };
}

function normalizedSync(providers, previous) {
  const errors = Array.isArray(previous?.errors)
    ? previous.errors.filter(isKoreanMetadataEntry).slice(0, 20)
    : [];
  if (providers.length === 0) {
    return {
      status: "unknown",
      successful: 0,
      attempted: 0,
      failed: 0,
      errors
    };
  }
  const attempted = providers.filter((provider) => provider.status !== "preserved").length;
  const successful = providers.filter((provider) => provider.status === "ok").length;
  const failed = Math.max(0, attempted - successful);
  return {
    status: failed === 0 ? "ok" : successful > 0 ? "partial" : "failed",
    successful,
    attempted,
    failed,
    errors
  };
}

function latestIso(values) {
  let latest = null;
  let latestTime = -Infinity;
  for (const value of values) {
    const time = Date.parse(value);
    if (Number.isFinite(time) && time > latestTime) {
      latest = value;
      latestTime = time;
    }
  }
  return latest;
}

function normalizedDataMode(companies) {
  const demoCount = companies.filter((company) => company.dataMode === "demo").length;
  if (demoCount === companies.length) return "demo";
  if (demoCount > 0 || companies.some((company) => company.stale === true)) return "mixed";
  return "live";
}

export function normalizeKoreanSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.companies)) {
    throw new TypeError("한국 시장 스냅샷 형식이 올바르지 않습니다.");
  }

  const companies = snapshot.companies
    .filter((company) => company?.country === "KR")
    .map((company) => structuredClone(company));
  if (companies.length === 0) {
    throw new Error("한국 상장기업 데이터가 없습니다.");
  }

  const previousMeta = snapshot.meta || {};
  const providers = (previousMeta.providers || [])
    .filter(isKoreanMetadataEntry)
    .map((provider) => ({
      ...structuredClone(provider),
      country: "KR",
      companyCount: companies.length
    }));
  const sources = (previousMeta.sources || [])
    .filter(isKoreanMetadataEntry)
    .map((source) => structuredClone(source));
  const marketProviders = (previousMeta.marketData?.providers || [])
    .filter(isKoreanMetadataEntry)
    .map((provider) => structuredClone(provider));
  const counts = quoteCounts(companies);
  const sourceUpdatedAt = latestIso([
    ...providers.map((provider) => provider.sourceUpdatedAt),
    ...companies.map((company) => company.updatedAt)
  ]);
  const marketUpdatedAt = latestIso([
    ...marketProviders.flatMap((provider) => [
      provider.lastSuccessAt,
      provider.updatedAt,
      provider.fetchedAt
    ]),
    ...companies.flatMap((company) => [
      company.marketData?.fetchedAt,
      company.marketData?.updatedAt
    ])
  ]);
  const updatedAt = latestIso([sourceUpdatedAt, marketUpdatedAt]);

  const marketData = previousMeta.marketData
    ? {
        updatedAt: marketUpdatedAt,
        ...(previousMeta.marketData.lastAttemptAt
          ? { lastAttemptAt: previousMeta.marketData.lastAttemptAt }
          : {}),
        maxQuoteAgeDays: previousMeta.marketData.maxQuoteAgeDays || 10,
        ...counts,
        providers: marketProviders
      }
    : undefined;

  const meta = {
    schemaVersion: Math.max(3, Number(previousMeta.schemaVersion) || 0),
    dataMode: normalizedDataMode(companies),
    updatedAt,
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    note: "한국 KOSPI·KOSDAQ 공식 공시 전체시장 스냅샷입니다. 평가 보류와 결측치는 그대로 표시합니다.",
    sources,
    coverage: { total: companies.length, kr: companies.length },
    providers,
    ...(marketData ? { marketData } : {}),
    sync: normalizedSync(providers, previousMeta.sync)
  };

  return { meta, companies };
}
