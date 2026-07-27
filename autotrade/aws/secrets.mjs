import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

export class AwsSecretError extends Error {
  constructor(message, { code = "AWS_SECRET_ERROR", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AwsSecretError";
    this.code = code;
  }
}

function requiredText(value, label, maximum = 4_096) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new TypeError(`${label}이(가) 없거나 너무 깁니다.`);
  }
  return normalized;
}

function secretText(response) {
  if (typeof response?.SecretString === "string") return response.SecretString;
  if (response?.SecretBinary) {
    return Buffer.from(response.SecretBinary).toString("utf8");
  }
  throw new AwsSecretError("AWS 비밀값 본문이 없습니다.", {
    code: "AWS_SECRET_VALUE_MISSING"
  });
}

export async function loadJsonSecret({
  client,
  secretId,
  requiredKeys = [],
  allowedKeys = requiredKeys
} = {}) {
  if (!client || typeof client.send !== "function") {
    throw new TypeError("Secrets Manager client가 필요합니다.");
  }
  const id = requiredText(secretId, "AWS Secret ID");
  let response;
  try {
    response = await client.send(new GetSecretValueCommand({ SecretId: id }));
  } catch (error) {
    throw new AwsSecretError("AWS 비밀값을 읽지 못했습니다.", {
      code: "AWS_SECRET_READ_FAILED",
      cause: error
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(secretText(response));
  } catch (error) {
    if (error instanceof AwsSecretError) throw error;
    throw new AwsSecretError("AWS 비밀값 JSON이 손상되었습니다.", {
      code: "AWS_SECRET_JSON_INVALID"
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AwsSecretError("AWS 비밀값은 JSON 객체여야 합니다.", {
      code: "AWS_SECRET_JSON_INVALID"
    });
  }
  const allowed = new Set(allowedKeys);
  const result = {};
  for (const [key, raw] of Object.entries(parsed)) {
    if (!allowed.has(key)) continue;
    result[key] = requiredText(raw, `AWS 비밀값 ${key}`, 16_384);
  }
  for (const key of requiredKeys) {
    if (!result[key]) {
      throw new AwsSecretError(`AWS 비밀값에 ${key}가 없습니다.`, {
        code: "AWS_SECRET_KEY_MISSING"
      });
    }
  }
  return result;
}

export function applySecretEnvironment(secret, env = process.env) {
  if (!secret || typeof secret !== "object" || Array.isArray(secret)) {
    throw new TypeError("적용할 AWS 비밀값 객체가 필요합니다.");
  }
  for (const [key, value] of Object.entries(secret)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new TypeError("AWS 비밀값 환경변수 이름이 올바르지 않습니다.");
    }
    env[key] = String(value);
  }
  return env;
}
