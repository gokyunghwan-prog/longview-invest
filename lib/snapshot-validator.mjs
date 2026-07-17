const COUNTRY_EXCHANGES = Object.freeze({
  KR: new Set(["KOSPI", "KOSDAQ"]),
  US: new Set(["NASDAQ", "NYSE", "CBOE"])
});

export const DEFAULT_MINIMUM_COUNTS = Object.freeze({
  KR: 2_000,
  US: 3_000
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
  const counts = { KR: 0, US: 0 };
  for (const company of companies) {
    if (Object.hasOwn(counts, company?.country)) counts[company.country] += 1;
  }
  return counts;
}

function numberEquals(value, expected) {
  return Number.isInteger(value) && value === expected;
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
    if (!numberEquals(coverage.us, counts.US)) return false;
  }
  return true;
}

function optionsWithDefaults(options) {
  const requiredCountries = options.requiredCountries || ["KR", "US"];
  return {
    label: options.label || "snapshot",
    requiredCountries,
    allowAdditionalCountries: options.allowAdditionalCountries ?? true,
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
      counts: { total: 0, KR: 0, US: 0 }
    };
  }

  if (!Array.isArray(snapshot.companies)) {
    return {
      valid: false,
      label: settings.label,
      errors: [settings.label + ".companies must be an array."],
      counts: { total: 0, KR: 0, US: 0 }
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
      addError(prefix + ".country must be KR or US.");
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
    if (!numberEquals(coverage.us, counts.US)) {
      addError(`meta.coverage.us=${coverage.us} does not match ${counts.US}.`);
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
