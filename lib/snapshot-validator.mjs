const COUNTRY_EXCHANGES = Object.freeze({
  KR: new Set(["KOSPI", "KOSDAQ"])
});

export const DEFAULT_MINIMUM_COUNTS = Object.freeze({
  KR: 2_000
});

export const DEFAULT_MAX_DROP_FRACTION = 0.2;
export const DEFAULT_MAX_SNAPSHOT_BYTES = 90 * 1024 * 1024;

function normalizedExchange(value) {
  return String(value || "").trim().toUpperCase();
}

function isDemo(company) {
  return [company?.dataMode, company?.evaluationStatus, company?.analysisStatus]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase() === "demo");
}

function countByCountry(companies) {
  const counts = { KR: 0 };
  for (const company of companies) {
    if (Object.hasOwn(counts, company?.country)) counts[company.country] += 1;
  }
  return counts;
}

function numberEquals(value, expected) {
  return Number.isInteger(value) && value === expected;
}

function validIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function finiteOrNull(value) {
  return value === null || value === undefined || Number.isFinite(value);
}

function previousCountryIsTrusted(snapshot, country, minimumCount) {
  if (!snapshot || !Array.isArray(snapshot.companies)) return false;
  const companies = snapshot.companies.filter((company) => company?.country === country);
  if (companies.length < minimumCount || companies.some(isDemo)) return false;

  const ids = new Set();
  for (const company of companies) {
    const id = String(company?.id || "").trim();
    if (!id || ids.has(id)) return false;
    ids.add(id);
    if (!COUNTRY_EXCHANGES[country].has(normalizedExchange(company.exchange))) return false;
  }

  const coverage = snapshot.meta?.coverage;
  if (coverage) {
    const counts = countByCountry(snapshot.companies);
    if (!numberEquals(coverage.total, snapshot.companies.length)) return false;
    if (!numberEquals(coverage.kr, counts.KR)) return false;
  }
  return true;
}

function optionsWithDefaults(options) {
  const requiredCountries = options.requiredCountries || ["KR"];
  return {
    label: options.label || "snapshot",
    requiredCountries,
    allowAdditionalCountries: options.allowAdditionalCountries ?? false,
    forbidDemo: options.forbidDemo ?? true,
    requireCoverage: options.requireCoverage ?? true,
    enforceMinimums: options.enforceMinimums ?? true,
    minimumCounts: { ...DEFAULT_MINIMUM_COUNTS, ...(options.minimumCounts || {}) },
    maxDropFraction: options.maxDropFraction ?? DEFAULT_MAX_DROP_FRACTION,
    maxSnapshotBytes: options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES,
    snapshotBytes: options.snapshotBytes,
    previousSnapshot: options.previousSnapshot || null
  };
}

/**
 * Validate a publishable market snapshot without mutating it.
 *
 * Small synthetic fixtures must explicitly override `minimumCounts`; production
 * callers intentionally inherit the conservative full-market defaults above.
 */
export function validateSnapshot(snapshot, options = {}) {
  const settings = optionsWithDefaults(options);
  const errors = [];
  const addError = (message) => {
    if (errors.length < 100) errors.push(message);
  };

  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return {
      valid: false,
      label: settings.label,
      errors: [settings.label + " must be a JSON object."],
      counts: { total: 0, KR: 0 }
    };
  }

  if (!Array.isArray(snapshot.companies)) {
    return {
      valid: false,
      label: settings.label,
      errors: [settings.label + ".companies must be an array."],
      counts: { total: 0, KR: 0 }
    };
  }

  const companies = snapshot.companies;
  const ids = new Set();
  const required = new Set(settings.requiredCountries);
  const snapshotBytes = Number.isFinite(settings.snapshotBytes)
    ? settings.snapshotBytes
    : Buffer.byteLength(JSON.stringify(snapshot), "utf8");

  if (!Number.isInteger(settings.maxSnapshotBytes) || settings.maxSnapshotBytes < 1) {
    addError("maxSnapshotBytes must be a positive integer.");
  } else if (snapshotBytes > settings.maxSnapshotBytes) {
    addError(
      `Snapshot size ${snapshotBytes} bytes exceeds the safe limit ${settings.maxSnapshotBytes} bytes.`
    );
  }

  if (settings.forbidDemo && String(snapshot.meta?.dataMode || "").toLowerCase() === "demo") {
    addError("meta.dataMode must not be demo.");
  }

  companies.forEach((company, index) => {
    const prefix = "companies[" + index + "]";
    const id = String(company?.id || "").trim();
    if (!id) addError(prefix + ".id is required.");
    else if (ids.has(id)) addError("Duplicate company id: " + id);
    else ids.add(id);

    const country = company?.country;
    if (!Object.hasOwn(COUNTRY_EXCHANGES, country)) {
      addError(prefix + ".country must be KR.");
      return;
    }
    if (!settings.allowAdditionalCountries && !required.has(country)) {
      addError(prefix + ".country is outside the requested scope: " + country);
    }

    const exchange = normalizedExchange(company.exchange);
    if (!COUNTRY_EXCHANGES[country].has(exchange)) {
      addError(prefix + ".exchange is invalid for " + country + ": " + company.exchange);
    }
    if (settings.forbidDemo && isDemo(company)) {
      addError(prefix + " is demo data.");
    }

    const financials = company?.financials?.latest;
    if (financials !== undefined) {
      if (!financials || typeof financials !== "object" || Array.isArray(financials)) {
        addError(prefix + ".financials.latest must be an object.");
      } else {
        for (const key of [
          "revenue",
          "operatingIncome",
          "netIncome",
          "assets",
          "liabilities",
          "equity",
          "currentAssets",
          "currentLiabilities",
          "operatingCashFlow",
          "capex",
          "freeCashFlow",
          "epsBasic",
          "epsDiluted",
          "sharesOutstanding"
        ]) {
          if (!finiteOrNull(financials[key])) {
            addError(prefix + ".financials.latest." + key + " must be finite or null.");
          }
        }
        if (
          Number.isFinite(financials.sharesOutstanding) &&
          financials.sharesOutstanding <= 0
        ) {
          addError(prefix + ".financials.latest.sharesOutstanding must be positive.");
        }
      }
    }

    const marketData = company?.marketData;
    if (marketData !== undefined) {
      if (!marketData || typeof marketData !== "object" || Array.isArray(marketData)) {
        addError(prefix + ".marketData must be an object.");
      } else {
        if (marketData.usageMode !== "public") {
          addError(prefix + ".marketData must be publishable public data.");
        }
        if (!["ok", "preserved", "stale"].includes(marketData.status)) {
          addError(prefix + ".marketData.status is invalid.");
        }
        if (!["current", "stale"].includes(marketData.freshness)) {
          addError(prefix + ".marketData.freshness is invalid.");
        }
        if (!validIsoDate(marketData.asOf)) {
          addError(prefix + ".marketData.asOf must be an ISO date.");
        }
        if (!/^[A-Z]{3}$/.test(String(marketData.currency || ""))) {
          addError(prefix + ".marketData.currency must be a three-letter code.");
        }
        if (!Number.isFinite(marketData.price) || marketData.price <= 0) {
          addError(prefix + ".marketData.price must be positive and finite.");
        }
        for (const key of ["open", "high", "low", "previousClose", "listedShares", "marketCap"]) {
          if (!finiteOrNull(marketData[key])) {
            addError(prefix + ".marketData." + key + " must be finite or null.");
          } else if (Number.isFinite(marketData[key]) && marketData[key] <= 0) {
            addError(prefix + ".marketData." + key + " must be positive.");
          }
        }
        for (const key of ["volume", "turnover"]) {
          if (!finiteOrNull(marketData[key])) {
            addError(prefix + ".marketData." + key + " must be finite or null.");
          } else if (Number.isFinite(marketData[key]) && marketData[key] < 0) {
            addError(prefix + ".marketData." + key + " must be nonnegative.");
          }
        }
        for (const key of ["change", "changePercent"]) {
          if (!finiteOrNull(marketData[key])) {
            addError(prefix + ".marketData." + key + " must be finite or null.");
          }
        }
        if (
          Number.isFinite(marketData.high) &&
          [marketData.price, marketData.open, marketData.low]
            .filter(Number.isFinite)
            .some((value) => value > marketData.high)
        ) {
          addError(prefix + ".marketData.high is below another OHLC value.");
        }
        if (
          Number.isFinite(marketData.low) &&
          [marketData.price, marketData.open, marketData.high]
            .filter(Number.isFinite)
            .some((value) => value < marketData.low)
        ) {
          addError(prefix + ".marketData.low is above another OHLC value.");
        }
        const source = marketData.source;
        if (!source || typeof source !== "object" || !String(source.name || "").trim()) {
          addError(prefix + ".marketData.source is required.");
        } else {
          try {
            const sourceUrl = new URL(source.url);
            if (
              sourceUrl.protocol !== "https:" ||
              sourceUrl.username ||
              sourceUrl.password
            ) throw new Error("unsafe");
          } catch {
            addError(prefix + ".marketData.source.url must be a public HTTPS URL.");
          }
          if (source.licenseReference) {
            try {
              const licenseUrl = new URL(source.licenseReference);
              if (
                licenseUrl.protocol !== "https:" ||
                licenseUrl.username ||
                licenseUrl.password ||
                licenseUrl.search ||
                licenseUrl.hash
              ) throw new Error("unsafe");
            } catch {
              addError(prefix + ".marketData.source.licenseReference must be a public HTTPS URL.");
            }
          }
        }
        for (const [key, value] of Object.entries(marketData.valuation || {})) {
          if (["per", "pbr", "psr", "fcfYield", "marketCap"].includes(key) && !finiteOrNull(value)) {
            addError(prefix + ".marketData.valuation." + key + " must be finite or null.");
          }
        }
      }
    }
  });

  const countryCounts = countByCountry(companies);
  const counts = { total: companies.length, ...countryCounts };

  const coverage = snapshot.meta?.coverage;
  if (settings.requireCoverage && (!coverage || typeof coverage !== "object")) {
    addError("meta.coverage is required.");
  }
  if (coverage && typeof coverage === "object") {
    if (!numberEquals(coverage.total, counts.total)) {
      addError(`meta.coverage.total=${coverage.total} does not match ${counts.total}.`);
    }
    if (!numberEquals(coverage.kr, counts.KR)) {
      addError(`meta.coverage.kr=${coverage.kr} does not match ${counts.KR}.`);
    }
  }

  const marketCoverage = snapshot.meta?.marketData?.coverage;
  if (marketCoverage && typeof marketCoverage === "object") {
    const isFresh = (company, country) =>
      company.country === country &&
      company.marketData?.usageMode === "public" &&
      company.marketData.status === "ok" &&
      company.marketData.freshness === "current";
    const actualKr = companies.filter((company) => isFresh(company, "KR")).length;
    if (!numberEquals(marketCoverage.kr, actualKr)) {
      addError(`meta.marketData.coverage.kr=${marketCoverage.kr} does not match ${actualKr}.`);
    }
    for (const [bucket, predicate] of [
      ["available", (quote) => quote?.usageMode === "public"],
      ["preserved", (quote) => quote?.status === "preserved"],
      ["stale", (quote) => quote?.status === "stale" || quote?.freshness === "stale"]
    ]) {
      const declared = snapshot.meta?.marketData?.[bucket];
      if (!declared) continue;
      const actual = companies.filter(
        (company) => company.country === "KR" && predicate(company.marketData)
      ).length;
      if (!numberEquals(declared.kr, actual)) {
        addError(`meta.marketData.${bucket}.kr=${declared.kr} does not match ${actual}.`);
      }
    }
  }

  if (settings.previousSnapshot && Array.isArray(settings.previousSnapshot.companies)) {
    const maximumDrop = settings.maxMarketDataDropFraction ?? settings.maxDropFraction ?? 0.2;
    for (const country of ["KR"]) {
      const previousAvailable = settings.previousSnapshot.companies.filter(
        (company) =>
          company.country === country &&
          company.marketData?.usageMode === "public" &&
          Number.isFinite(company.marketData?.price) &&
          company.marketData.price > 0
      ).length;
      if (previousAvailable === 0) continue;
      const currentAvailable = companies.filter(
        (company) =>
          company.country === country &&
          company.marketData?.usageMode === "public" &&
          Number.isFinite(company.marketData?.price) &&
          company.marketData.price > 0
      ).length;
      const floor = Math.ceil(previousAvailable * (1 - maximumDrop));
      if (currentAvailable < floor) {
        addError(
          `${country} market-data availability dropped from ${previousAvailable} to ${currentAvailable}; minimum is ${floor}.`
        );
      }
    }
  }

  const universeCount = snapshot.meta?.universe?.companies;
  if (universeCount !== undefined && !numberEquals(universeCount, counts.total)) {
    addError(`meta.universe.companies=${universeCount} does not match ${counts.total}.`);
  }

  if (!Number.isFinite(settings.maxDropFraction) || settings.maxDropFraction < 0 || settings.maxDropFraction >= 1) {
    addError("maxDropFraction must be at least 0 and less than 1.");
  }

  for (const country of required) {
    if (!Object.hasOwn(COUNTRY_EXCHANGES, country)) {
      addError("Unsupported required country: " + country);
      continue;
    }
    const minimum = Number(settings.minimumCounts[country]);
    if (!Number.isInteger(minimum) || minimum < 1) {
      addError("minimumCounts." + country + " must be a positive integer.");
      continue;
    }
    if (settings.enforceMinimums && counts[country] < minimum) {
      addError(`${country} company count ${counts[country]} is below the safe minimum ${minimum}.`);
    }

    if (
      previousCountryIsTrusted(settings.previousSnapshot, country, minimum) &&
      Number.isFinite(settings.maxDropFraction) &&
      settings.maxDropFraction >= 0 &&
      settings.maxDropFraction < 1
    ) {
      const previousCount = countByCountry(settings.previousSnapshot.companies)[country];
      const floor = Math.ceil(previousCount * (1 - settings.maxDropFraction));
      if (counts[country] < floor) {
        addError(
          `${country} company count dropped from ${previousCount} to ${counts[country]} ` +
            `(allowed floor ${floor}).`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    label: settings.label,
    errors,
    counts
  };
}

export class SnapshotValidationError extends Error {
  constructor(report) {
    super(
      report.label + " validation failed: " +
        (report.errors.length ? report.errors.join(" ") : "unknown validation error")
    );
    this.name = "SnapshotValidationError";
    this.report = report;
  }
}

export function assertValidSnapshot(snapshot, options = {}) {
  const report = validateSnapshot(snapshot, options);
  if (!report.valid) throw new SnapshotValidationError(report);
  return report;
}
