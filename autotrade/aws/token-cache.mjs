import { createHash } from "node:crypto";

import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import { AwsDurableStateError } from "./dynamo.mjs";

function requiredText(value, label, maximum = 512) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new TypeError(`${label}이(가) 없거나 너무 깁니다.`);
  }
  return normalized;
}

function timestamp(value) {
  const resolved = typeof value === "function" ? value() : value;
  const parsed = resolved instanceof Date ? resolved.getTime() : Number(resolved);
  if (!Number.isFinite(parsed)) throw new TypeError("KIS 토큰 캐시 시각이 올바르지 않습니다.");
  return Math.floor(parsed);
}

export function kisTokenCacheKey({
  namespace = "longview",
  environment,
  appKey
}) {
  const safeNamespace = requiredText(namespace, "토큰 namespace", 128);
  const safeEnvironment = requiredText(environment, "KIS 환경", 16).toLowerCase();
  const digest = createHash("sha256")
    .update(requiredText(appKey, "KIS App Key", 512))
    .digest("hex")
    .slice(0, 24);
  return `${safeNamespace}#token/kis/${safeEnvironment}/${digest}`;
}

export class DynamoKisTokenCache {
  constructor({
    client,
    tableName,
    namespace = "longview",
    environment,
    appKey,
    now = Date.now
  } = {}) {
    if (!client || typeof client.send !== "function") {
      throw new TypeError("DynamoDB DocumentClient가 필요합니다.");
    }
    this.client = client;
    this.tableName = requiredText(tableName, "DynamoDB 테이블 이름", 255);
    this.pk = kisTokenCacheKey({ namespace, environment, appKey });
    this.now = now;
  }

  async load() {
    let response;
    try {
      response = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk: this.pk },
          ConsistentRead: true
        })
      );
    } catch (error) {
      throw new AwsDurableStateError("DynamoDB KIS 토큰 캐시를 읽지 못했습니다.", {
        code: "AWS_TOKEN_CACHE_READ_FAILED",
        cause: error
      });
    }
    const item = response?.Item;
    if (!item) return null;
    const accessToken = String(item.accessToken || "").trim();
    const expiresAt = Number(item.expiresAtEpochMs);
    if (!accessToken || !Number.isFinite(expiresAt)) {
      throw new AwsDurableStateError("DynamoDB KIS 토큰 캐시 형식이 올바르지 않습니다.", {
        code: "AWS_TOKEN_CACHE_INVALID"
      });
    }
    return { accessToken, expiresAt };
  }

  async save({ accessToken, expiresAt }) {
    const token = requiredText(accessToken, "KIS 접근토큰", 8_192);
    const expiry = Number(expiresAt);
    const savedAt = timestamp(this.now);
    if (!Number.isFinite(expiry) || expiry <= savedAt) {
      throw new TypeError("KIS 접근토큰 만료시각이 올바르지 않습니다.");
    }
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: this.pk,
            kind: "kis_access_token",
            accessToken: token,
            expiresAtEpochMs: Math.floor(expiry),
            updatedAt: new Date(savedAt).toISOString(),
            ttl: Math.floor(expiry / 1_000) + 86_400
          }
        })
      );
    } catch (error) {
      throw new AwsDurableStateError("DynamoDB KIS 토큰 캐시를 저장하지 못했습니다.", {
        code: "AWS_TOKEN_CACHE_WRITE_FAILED",
        cause: error
      });
    }
  }

  async clear() {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: this.pk }
        })
      );
    } catch (error) {
      throw new AwsDurableStateError("DynamoDB KIS 토큰 캐시를 삭제하지 못했습니다.", {
        code: "AWS_TOKEN_CACHE_DELETE_FAILED",
        cause: error
      });
    }
  }
}
