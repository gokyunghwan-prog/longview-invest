import { createHash, randomUUID } from "node:crypto";

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";

export const DEFAULT_AWS_STATE_MAX_BYTES = 350 * 1024;
export const DEFAULT_AWS_TRADE_LEASE_MS = 45 * 60 * 1_000;
export const DEFAULT_AWS_SYNC_LEASE_MS = 150 * 60 * 1_000;
export const DEFAULT_AWS_LEASE_HEARTBEAT_MS = 2 * 60 * 1_000;

const TERMINAL_EXECUTION_STATUSES = new Set([
  "success",
  "market_closed",
  "dry_run",
  "failed"
]);

export class AwsDurableStateError extends Error {
  constructor(message, { code = "AWS_DURABLE_STATE_ERROR", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AwsDurableStateError";
    this.code = code;
  }
}

function conditionalFailure(error) {
  return error?.name === "ConditionalCheckFailedException";
}

function safeTimestamp(value) {
  const resolved = typeof value === "function" ? value() : value;
  const timestamp =
    resolved instanceof Date ? resolved.getTime() : Number(resolved ?? Date.now());
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new TypeError("AWS 영구상태 시각이 올바르지 않습니다.");
  }
  return Math.floor(timestamp);
}

function positiveInteger(value, fallback, label) {
  const resolved = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label}은(는) 양의 정수여야 합니다.`);
  }
  return resolved;
}

function requiredText(value, label, maximum = 512) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new TypeError(`${label}이(가) 없거나 너무 깁니다.`);
  }
  return normalized;
}

function safeKeyPart(value, label) {
  const normalized = requiredText(value, label, 128);
  if (!/^[A-Za-z0-9._:/-]+$/.test(normalized)) {
    throw new TypeError(`${label}에 허용되지 않은 문자가 있습니다.`);
  }
  return normalized;
}

function statePayload(state, maximumBytes) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("저장할 자동매매 상태가 올바르지 않습니다.");
  }
  const payload = JSON.stringify(state);
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > maximumBytes) {
    throw new AwsDurableStateError("자동매매 상태가 DynamoDB 안전 크기를 초과했습니다.", {
      code: "AWS_STATE_TOO_LARGE"
    });
  }
  return {
    payload,
    bytes,
    checksum: createHash("sha256").update(payload).digest("hex")
  };
}

function parseStateItem(item, maximumBytes) {
  if (!item) return { exists: false, state: null, version: 0, checksum: null };
  const version = Number(item.version);
  const payload = typeof item.payload === "string" ? item.payload : "";
  if (!Number.isSafeInteger(version) || version < 1 || !payload) {
    throw new AwsDurableStateError("DynamoDB 자동매매 상태 형식이 올바르지 않습니다.", {
      code: "AWS_STATE_INVALID"
    });
  }
  if (Buffer.byteLength(payload, "utf8") > maximumBytes) {
    throw new AwsDurableStateError("DynamoDB 자동매매 상태가 안전 크기를 초과했습니다.", {
      code: "AWS_STATE_TOO_LARGE"
    });
  }
  const checksum = createHash("sha256").update(payload).digest("hex");
  if (item.checksum && item.checksum !== checksum) {
    throw new AwsDurableStateError("DynamoDB 자동매매 상태 checksum이 일치하지 않습니다.", {
      code: "AWS_STATE_CHECKSUM_MISMATCH"
    });
  }
  let state;
  try {
    state = JSON.parse(payload);
  } catch {
    throw new AwsDurableStateError("DynamoDB 자동매매 상태 JSON이 손상되었습니다.", {
      code: "AWS_STATE_INVALID"
    });
  }
  return { exists: true, state, version, checksum };
}

export class DynamoTradingRepository {
  constructor({
    client,
    tableName,
    namespace = "longview",
    now = Date.now,
    maximumStateBytes = DEFAULT_AWS_STATE_MAX_BYTES
  } = {}) {
    if (!client || typeof client.send !== "function") {
      throw new TypeError("DynamoDB DocumentClient가 필요합니다.");
    }
    this.client = client;
    this.tableName = requiredText(tableName, "DynamoDB 테이블 이름", 255);
    this.namespace = safeKeyPart(namespace, "DynamoDB namespace");
    this.now = now;
    this.maximumStateBytes = positiveInteger(
      maximumStateBytes,
      DEFAULT_AWS_STATE_MAX_BYTES,
      "DynamoDB 상태 최대크기"
    );
    if (this.maximumStateBytes > 380 * 1024) {
      throw new TypeError("DynamoDB 상태 최대크기는 380KiB 이하여야 합니다.");
    }
  }

  key(suffix) {
    return `${this.namespace}#${safeKeyPart(suffix, "DynamoDB 상태 키")}`;
  }

  async load() {
    let response;
    try {
      response = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk: this.key("state") },
          ConsistentRead: true
        })
      );
    } catch (error) {
      throw new AwsDurableStateError("DynamoDB 자동매매 상태를 읽지 못했습니다.", {
        code: "AWS_STATE_READ_FAILED",
        cause: error
      });
    }
    return parseStateItem(response?.Item, this.maximumStateBytes);
  }

  async initialize(state) {
    const encoded = statePayload(state, this.maximumStateBytes);
    const updatedAt = new Date(safeTimestamp(this.now)).toISOString();
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: this.key("state"),
            kind: "trading_state",
            version: 1,
            payload: encoded.payload,
            checksum: encoded.checksum,
            bytes: encoded.bytes,
            createdAt: updatedAt,
            updatedAt
          },
          ConditionExpression: "attribute_not_exists(pk)"
        })
      );
    } catch (error) {
      if (conditionalFailure(error)) {
        throw new AwsDurableStateError(
          "DynamoDB 자동매매 상태가 이미 있어 초기화를 거부했습니다.",
          { code: "AWS_STATE_ALREADY_EXISTS", cause: error }
        );
      }
      throw new AwsDurableStateError("DynamoDB 자동매매 상태를 초기화하지 못했습니다.", {
        code: "AWS_STATE_WRITE_FAILED",
        cause: error
      });
    }
    return { version: 1, checksum: encoded.checksum, bytes: encoded.bytes };
  }

  async save(state, { expectedVersion } = {}) {
    const version = positiveInteger(expectedVersion, null, "DynamoDB 예상 상태 버전");
    const nextVersion = version + 1;
    const encoded = statePayload(state, this.maximumStateBytes);
    const updatedAt = new Date(safeTimestamp(this.now)).toISOString();
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: this.key("state") },
          UpdateExpression:
            "SET #payload = :payload, #checksum = :checksum, #bytes = :bytes, " +
            "#version = :nextVersion, #updatedAt = :updatedAt",
          ConditionExpression: "#version = :expectedVersion",
          ExpressionAttributeNames: {
            "#payload": "payload",
            "#checksum": "checksum",
            "#bytes": "bytes",
            "#version": "version",
            "#updatedAt": "updatedAt"
          },
          ExpressionAttributeValues: {
            ":payload": encoded.payload,
            ":checksum": encoded.checksum,
            ":bytes": encoded.bytes,
            ":nextVersion": nextVersion,
            ":updatedAt": updatedAt,
            ":expectedVersion": version
          }
        })
      );
    } catch (error) {
      if (conditionalFailure(error)) {
        throw new AwsDurableStateError(
          "DynamoDB 자동매매 상태가 다른 실행에서 변경되어 덮어쓰기를 거부했습니다.",
          { code: "AWS_STATE_CONFLICT", cause: error }
        );
      }
      throw new AwsDurableStateError("DynamoDB 자동매매 상태를 저장하지 못했습니다.", {
        code: "AWS_STATE_WRITE_FAILED",
        cause: error
      });
    }
    return {
      version: nextVersion,
      checksum: encoded.checksum,
      bytes: encoded.bytes
    };
  }

  async rollbackInitialization({ expectedVersion, expectedChecksum } = {}) {
    const version = positiveInteger(
      expectedVersion,
      null,
      "DynamoDB 초기화 rollback 버전"
    );
    const checksum = requiredText(
      expectedChecksum,
      "DynamoDB 초기화 rollback checksum",
      64
    );
    if (!/^[a-f0-9]{64}$/.test(checksum)) {
      throw new TypeError("DynamoDB 초기화 rollback checksum이 올바르지 않습니다.");
    }
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: this.key("state") },
          ConditionExpression:
            "#kind = :kind AND #version = :version AND #checksum = :checksum",
          ExpressionAttributeNames: {
            "#kind": "kind",
            "#version": "version",
            "#checksum": "checksum"
          },
          ExpressionAttributeValues: {
            ":kind": "trading_state",
            ":version": version,
            ":checksum": checksum
          }
        })
      );
    } catch (error) {
      throw new AwsDurableStateError(
        "DynamoDB 초기 상태가 변경되었거나 rollback에 실패했습니다.",
        {
          code: conditionalFailure(error)
            ? "AWS_STATE_ROLLBACK_CONFLICT"
            : "AWS_STATE_ROLLBACK_FAILED",
          cause: error
        }
      );
    }
    return { rolledBack: true, version, checksum };
  }

  async assertVersion(expectedVersion) {
    const expected = positiveInteger(
      expectedVersion,
      null,
      "DynamoDB 예상 상태 버전"
    );
    const loaded = await this.load();
    if (!loaded.exists || loaded.version !== expected) {
      throw new AwsDurableStateError(
        "주문 직전 DynamoDB 자동매매 상태 버전이 변경되었습니다.",
        { code: "AWS_STATE_CONFLICT" }
      );
    }
    return loaded;
  }

  executionKey(command, businessDate) {
    const normalizedCommand = safeKeyPart(command, "실행 명령");
    const normalizedDate = requiredText(businessDate, "KST 영업일", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
      throw new TypeError("KST 영업일은 YYYY-MM-DD 형식이어야 합니다.");
    }
    return this.key(`execution/${normalizedCommand}/${normalizedDate}`);
  }

  async markExecutionStarted({
    command,
    businessDate,
    executionId,
    scheduledAt = null,
    mode
  }) {
    const id = requiredText(executionId, "AWS 실행 ID");
    const now = safeTimestamp(this.now);
    const startedAt = new Date(now).toISOString();
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: this.executionKey(command, businessDate) },
        UpdateExpression:
          "SET #kind = :kind, #command = :command, #businessDate = :businessDate, " +
          "#executionId = :executionId, #scheduledAt = :scheduledAt, #mode = :mode, " +
          "#status = :status, #terminal = :terminal, #startedAt = :startedAt, " +
          "#updatedAt = :startedAt, #ttl = :ttl ADD #attemptCount :one",
        ExpressionAttributeNames: {
          "#kind": "kind",
          "#command": "command",
          "#businessDate": "businessDate",
          "#executionId": "executionId",
          "#scheduledAt": "scheduledAt",
          "#mode": "mode",
          "#status": "status",
          "#terminal": "terminal",
          "#startedAt": "startedAt",
          "#updatedAt": "updatedAt",
          "#ttl": "ttl",
          "#attemptCount": "attemptCount"
        },
        ExpressionAttributeValues: {
          ":kind": "execution",
          ":command": String(command),
          ":businessDate": businessDate,
          ":executionId": id,
          ":scheduledAt": scheduledAt || null,
          ":mode": String(mode || "unknown"),
          ":status": "started",
          ":terminal": false,
          ":startedAt": startedAt,
          ":ttl": Math.floor(now / 1_000) + 120 * 86_400,
          ":one": 1
        }
      })
    );
    return { executionId: id, startedAt };
  }

  async markExecutionFinished({
    command,
    businessDate,
    executionId,
    status,
    summary = {}
  }) {
    const id = requiredText(executionId, "AWS 실행 ID");
    const normalizedStatus = requiredText(status, "AWS 실행 상태", 64);
    if (!TERMINAL_EXECUTION_STATUSES.has(normalizedStatus)) {
      throw new TypeError("AWS 실행 종료 상태가 허용되지 않습니다.");
    }
    const completedAt = new Date(safeTimestamp(this.now)).toISOString();
    const safeSummary = JSON.stringify(summary);
    if (Buffer.byteLength(safeSummary, "utf8") > 64 * 1024) {
      throw new TypeError("AWS 실행 요약이 너무 큽니다.");
    }
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: this.executionKey(command, businessDate) },
          UpdateExpression:
            "SET #status = :status, #terminal = :terminal, #summary = :summary, " +
            "#completedAt = :completedAt, #updatedAt = :completedAt",
          ConditionExpression: "#executionId = :executionId",
          ExpressionAttributeNames: {
            "#status": "status",
            "#terminal": "terminal",
            "#summary": "summary",
            "#completedAt": "completedAt",
            "#updatedAt": "updatedAt",
            "#executionId": "executionId"
          },
          ExpressionAttributeValues: {
            ":status": normalizedStatus,
            ":terminal": true,
            ":summary": safeSummary,
            ":completedAt": completedAt,
            ":executionId": id
          }
        })
      );
    } catch (error) {
      if (conditionalFailure(error)) {
        throw new AwsDurableStateError(
          "AWS 실행 기록 소유권이 변경되어 완료 기록을 거부했습니다.",
          { code: "AWS_EXECUTION_CONFLICT", cause: error }
        );
      }
      throw error;
    }
    return { status: normalizedStatus, completedAt };
  }

  async getExecution({ command, businessDate }) {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: this.executionKey(command, businessDate) },
        ConsistentRead: true
      })
    );
    if (!response?.Item) return null;
    let summary = null;
    try {
      summary = response.Item.summary ? JSON.parse(response.Item.summary) : null;
    } catch {
      throw new AwsDurableStateError("AWS 실행 요약 JSON이 손상되었습니다.", {
        code: "AWS_EXECUTION_INVALID"
      });
    }
    return { ...response.Item, summary };
  }
}

export class DynamoLeaseGuard {
  constructor({
    client,
    tableName,
    namespace,
    scope,
    owner,
    fence,
    leaseMs,
    heartbeatMs,
    now,
    expiresAt
  }) {
    this.client = client;
    this.tableName = tableName;
    this.namespace = namespace;
    this.scope = scope;
    this.owner = owner;
    this.fence = fence;
    this.leaseMs = leaseMs;
    this.heartbeatMs = heartbeatMs;
    this.now = now;
    this.expiresAt = expiresAt;
    this.timer = null;
    this.failure = null;
    this.chain = Promise.resolve();
  }

  static async acquire({
    client,
    tableName,
    namespace = "longview",
    scope = "trading",
    owner = randomUUID(),
    leaseMs = DEFAULT_AWS_TRADE_LEASE_MS,
    heartbeatMs = DEFAULT_AWS_LEASE_HEARTBEAT_MS,
    now = Date.now
  } = {}) {
    if (!client || typeof client.send !== "function") {
      throw new TypeError("DynamoDB DocumentClient가 필요합니다.");
    }
    const resolvedTable = requiredText(tableName, "DynamoDB 테이블 이름", 255);
    const resolvedNamespace = safeKeyPart(namespace, "DynamoDB namespace");
    const resolvedScope = safeKeyPart(scope, "DynamoDB lease scope");
    const resolvedOwner = requiredText(owner, "DynamoDB lease owner");
    const duration = positiveInteger(
      leaseMs,
      DEFAULT_AWS_TRADE_LEASE_MS,
      "DynamoDB lease 시간"
    );
    if (duration < 60_000 || duration > 4 * 60 * 60 * 1_000) {
      throw new TypeError("DynamoDB lease 시간은 1분~4시간이어야 합니다.");
    }
    const heartbeat = positiveInteger(
      heartbeatMs,
      DEFAULT_AWS_LEASE_HEARTBEAT_MS,
      "DynamoDB lease heartbeat"
    );
    if (heartbeat >= duration / 2) {
      throw new TypeError("DynamoDB lease heartbeat는 lease 시간의 절반보다 짧아야 합니다.");
    }
    const acquiredAt = safeTimestamp(now);
    const expiresAt = acquiredAt + duration;
    let response;
    try {
      response = await client.send(
        new UpdateCommand({
          TableName: resolvedTable,
          Key: { pk: `${resolvedNamespace}#lease/${resolvedScope}` },
          UpdateExpression:
            "SET #kind = :kind, #scope = :scope, #owner = :owner, " +
            "#expiresAt = :expiresAt, #updatedAt = :updatedAt, #ttl = :ttl " +
            "ADD #fence :one",
          ConditionExpression:
            "attribute_not_exists(#owner) OR #expiresAt <= :now",
          ExpressionAttributeNames: {
            "#kind": "kind",
            "#scope": "scope",
            "#owner": "owner",
            "#expiresAt": "expiresAtEpochMs",
            "#updatedAt": "updatedAt",
            "#ttl": "ttl",
            "#fence": "fence"
          },
          ExpressionAttributeValues: {
            ":kind": "lease",
            ":scope": resolvedScope,
            ":owner": resolvedOwner,
            ":expiresAt": expiresAt,
            ":updatedAt": new Date(acquiredAt).toISOString(),
            ":ttl": Math.floor(expiresAt / 1_000) + 86_400,
            ":now": acquiredAt,
            ":one": 1
          },
          ReturnValues: "ALL_NEW"
        })
      );
    } catch (error) {
      if (conditionalFailure(error)) {
        throw new AwsDurableStateError("다른 AWS 자동투자 실행이 lease를 보유하고 있습니다.", {
          code: "AWS_LEASE_BUSY",
          cause: error
        });
      }
      throw new AwsDurableStateError("AWS 자동투자 lease를 획득하지 못했습니다.", {
        code: "AWS_LEASE_ACQUIRE_FAILED",
        cause: error
      });
    }
    const fence = Number(response?.Attributes?.fence);
    if (!Number.isSafeInteger(fence) || fence < 1) {
      throw new AwsDurableStateError("AWS 자동투자 lease fence가 올바르지 않습니다.", {
        code: "AWS_LEASE_INVALID"
      });
    }
    return new DynamoLeaseGuard({
      client,
      tableName: resolvedTable,
      namespace: resolvedNamespace,
      scope: resolvedScope,
      owner: resolvedOwner,
      fence,
      leaseMs: duration,
      heartbeatMs: heartbeat,
      now,
      expiresAt
    });
  }

  leaseKey() {
    return { pk: `${this.namespace}#lease/${this.scope}` };
  }

  async _renew() {
    const checkedAt = safeTimestamp(this.now);
    const expiresAt = checkedAt + this.leaseMs;
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.leaseKey(),
          UpdateExpression:
            "SET #expiresAt = :expiresAt, #updatedAt = :updatedAt, #ttl = :ttl",
          ConditionExpression:
            "#owner = :owner AND #fence = :fence AND #expiresAt > :now",
          ExpressionAttributeNames: {
            "#owner": "owner",
            "#fence": "fence",
            "#expiresAt": "expiresAtEpochMs",
            "#updatedAt": "updatedAt",
            "#ttl": "ttl"
          },
          ExpressionAttributeValues: {
            ":owner": this.owner,
            ":fence": this.fence,
            ":now": checkedAt,
            ":expiresAt": expiresAt,
            ":updatedAt": new Date(checkedAt).toISOString(),
            ":ttl": Math.floor(expiresAt / 1_000) + 86_400
          }
        })
      );
    } catch (error) {
      throw new AwsDurableStateError("AWS 자동투자 lease가 만료되었거나 변경되었습니다.", {
        code: conditionalFailure(error) ? "AWS_LEASE_LOST" : "AWS_LEASE_RENEW_FAILED",
        cause: error
      });
    }
    this.expiresAt = expiresAt;
    return { owner: this.owner, fence: this.fence, expiresAt };
  }

  renew() {
    const pending = this.chain.then(() => this._renew());
    this.chain = pending.catch((error) => {
      this.failure = error;
    });
    return pending;
  }

  async ensure() {
    if (this.failure) throw this.failure;
    return this.renew();
  }

  startHeartbeat() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.renew().catch(() => {});
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  async stopHeartbeat() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.chain;
    if (this.failure) throw this.failure;
  }

  async release() {
    await this.stopHeartbeat();
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: this.leaseKey(),
          ConditionExpression: "#owner = :owner AND #fence = :fence",
          ExpressionAttributeNames: {
            "#owner": "owner",
            "#fence": "fence"
          },
          ExpressionAttributeValues: {
            ":owner": this.owner,
            ":fence": this.fence
          }
        })
      );
    } catch (error) {
      throw new AwsDurableStateError("AWS 자동투자 lease를 안전하게 해제하지 못했습니다.", {
        code: conditionalFailure(error) ? "AWS_LEASE_LOST" : "AWS_LEASE_RELEASE_FAILED",
        cause: error
      });
    }
  }
}
