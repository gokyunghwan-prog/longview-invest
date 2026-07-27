import { redactSensitive } from "../risk.mjs";

function sanitize(value, secrets) {
  const text = JSON.stringify(value);
  const redacted = redactSensitive(text, secrets);
  try {
    return JSON.parse(redacted);
  } catch {
    return { message: redacted.slice(0, 2_000) };
  }
}

export function createAwsStructuredLogger({
  output = console.log,
  errorOutput = console.error,
  secrets = [],
  baseDimensions = {}
} = {}) {
  if (typeof output !== "function" || typeof errorOutput !== "function") {
    throw new TypeError("AWS 구조화 로그 출력 함수가 필요합니다.");
  }
  const knownSecrets = secrets
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
  const safeBaseDimensions = Object.fromEntries(
    Object.entries(baseDimensions).map(([key, value]) => [
      String(key).slice(0, 64),
      String(value).slice(0, 255)
    ])
  );
  const write = (level, event, details = {}) => {
    const payload = sanitize(
      {
        timestamp: new Date().toISOString(),
        level,
        event: String(event || "unknown").slice(0, 128),
        ...details
      },
      knownSecrets
    );
    (level === "error" ? errorOutput : output)(JSON.stringify(payload));
  };
  return {
    info: (event, details) => write("info", event, details),
    warn: (event, details) => write("warn", event, details),
    error: (event, details) => write("error", event, details),
    audit: async (entry) => write("info", "autotrade_audit", { audit: entry }),
    metric(
      name,
      value = 1,
      {
        namespace = "Longview/Autotrade",
        dimensions = {},
        unit = "Count"
      } = {}
    ) {
      const mergedDimensions = { ...safeBaseDimensions, ...dimensions };
      const dimensionNames = Object.keys(mergedDimensions);
      const payload = sanitize(
        {
          _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
              {
                Namespace: namespace,
                Dimensions: [dimensionNames],
                Metrics: [{ Name: name, Unit: unit }]
              }
            ]
          },
          ...mergedDimensions,
          [name]: Number(value)
        },
        knownSecrets
      );
      output(JSON.stringify(payload));
    }
  };
}
