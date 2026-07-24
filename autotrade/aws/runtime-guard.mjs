export class AwsRuntimeGuardError extends Error {
  constructor(message, { code = "AWS_RUNTIME_GUARD_ERROR", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AwsRuntimeGuardError";
    this.code = code;
  }
}

function requiredText(value, label, maximum = 2_048) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new TypeError(`${label}이(가) 없거나 너무 깁니다.`);
  }
  return normalized;
}

export function kstBusinessDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("AWS 실행시각이 올바르지 않습니다.");
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function compactKstBusinessDate(value = new Date()) {
  return kstBusinessDate(value).replaceAll("-", "");
}

function normalizedScheduleSlot(value, fallback) {
  return (
    String(value || fallback)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._/-]/g, "")
      .slice(0, 64) || fallback
  );
}

function expectedScheduledBinding({ command, slot, prefix }) {
  if (command === "auto" && slot === "auto") {
    return new Set([`${prefix}-auto`]);
  }
  if (command === "audit" && slot === "audit") {
    return new Set([`${prefix}-audit`]);
  }
  if (command === "sync" && slot === "sync") {
    return new Set([`${prefix}-data-sync`]);
  }
  if (command === "reconcile" && slot === "reconcile-close") {
    return new Set([`${prefix}-reconcile-close`]);
  }
  if (command === "reconcile" && slot === "reconcile-verify-1") {
    return new Set([`${prefix}-reconcile-verify`]);
  }
  if (command === "reconcile" && slot === "reconcile-final") {
    return new Set([
      `${prefix}-reconcile-final`,
      `${prefix}-reconcile-final-retry`
    ]);
  }
  return null;
}

function validateScheduledBinding({ env, command, slot }) {
  const arn = requiredText(env.AUTOTRADE_SCHEDULE_ARN, "AWS schedule ARN", 512);
  const group = requiredText(
    env.AUTOTRADE_EXPECTED_SCHEDULE_GROUP,
    "AWS schedule group",
    64
  );
  const prefix = requiredText(
    env.AUTOTRADE_EXPECTED_SCHEDULE_NAME_PREFIX,
    "AWS schedule name prefix",
    48
  );
  const match = arn.match(
    /^arn:aws[a-z-]*:scheduler:[a-z0-9-]+:\d{12}:schedule\/([^/]+)\/([^/]+)$/
  );
  const expectedNames = expectedScheduledBinding({ command, slot, prefix });
  if (
    !match ||
    match[1] !== group ||
    !expectedNames ||
    !expectedNames.has(match[2])
  ) {
    throw new AwsRuntimeGuardError(
      "AWS schedule ARN과 command/slot binding이 일치하지 않습니다.",
      { code: "AWS_SCHEDULE_BINDING_INVALID" }
    );
  }
  return arn;
}

export function validateAwsInvocation({
  command,
  env = process.env,
  now = () => new Date()
} = {}) {
  const normalizedCommand = requiredText(command, "AWS task 명령", 32).toLowerCase();
  if (!new Set(["sync", "auto", "reconcile", "audit"]).has(normalizedCommand)) {
    throw new AwsRuntimeGuardError("허용되지 않은 AWS task 명령입니다.", {
      code: "AWS_COMMAND_INVALID"
    });
  }
  const source = requiredText(env.AUTOTRADE_TASK_SOURCE, "AWS task source", 64);
  if (!new Set(["eventbridge-scheduler", "manual"]).has(source)) {
    throw new AwsRuntimeGuardError("AWS task source가 허용되지 않습니다.", {
      code: "AWS_SOURCE_INVALID"
    });
  }
  const executionId = requiredText(env.AUTOTRADE_EXECUTION_ID, "AWS 실행 ID", 512);
  const currentValue = now();
  const current = currentValue instanceof Date ? new Date(currentValue) : new Date(currentValue);
  if (Number.isNaN(current.getTime())) {
    throw new AwsRuntimeGuardError("AWS 현재시각이 올바르지 않습니다.", {
      code: "AWS_TIME_INVALID"
    });
  }
  let scheduledAt;
  if (source === "manual") {
    scheduledAt = current;
    if (String(env.AUTOTRADE_EXECUTION_MODE || "").toLowerCase() === "live") {
      throw new AwsRuntimeGuardError("AWS 수동 실전 실행은 허용되지 않습니다.", {
        code: "AWS_MANUAL_LIVE_FORBIDDEN"
      });
    }
  } else {
    scheduledAt = new Date(requiredText(env.AUTOTRADE_SCHEDULED_AT, "AWS 예약시각", 64));
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new AwsRuntimeGuardError("AWS 예약시각이 올바르지 않습니다.", {
        code: "AWS_SCHEDULE_TIME_INVALID"
      });
    }
    const delayMs = current.getTime() - scheduledAt.getTime();
    const maximumDelayMs = normalizedCommand === "sync" ? 30 * 60_000 : 10 * 60_000;
    if (delayMs < -2 * 60_000 || delayMs > maximumDelayMs) {
      throw new AwsRuntimeGuardError("AWS 예약 이벤트가 허용시간보다 늦거나 미래입니다.", {
        code: "AWS_SCHEDULE_STALE"
      });
    }
  }
  const scheduleSlot = normalizedScheduleSlot(
    env.AUTOTRADE_SCHEDULE_SLOT,
    normalizedCommand
  );
  if (source === "eventbridge-scheduler") {
    validateScheduledBinding({
      env,
      command: normalizedCommand,
      slot: scheduleSlot
    });
  } else {
    const manualSlots = {
      auto: "auto",
      reconcile: "reconcile-manual",
      audit: "audit",
      sync: "sync"
    };
    if (
      env.AUTOTRADE_SCHEDULE_ARN !== "manual" ||
      scheduleSlot !== manualSlots[normalizedCommand]
    ) {
      throw new AwsRuntimeGuardError(
        "AWS 수동 dry-run command/slot binding이 올바르지 않습니다.",
        { code: "AWS_SCHEDULE_BINDING_INVALID" }
      );
    }
  }
  const finalFlag = String(env.AUTOTRADE_FINAL_RECONCILE || "false")
    .trim()
    .toLowerCase();
  if (!new Set(["true", "false"]).has(finalFlag)) {
    throw new AwsRuntimeGuardError(
      "AWS 최종 주문대조 플래그는 true 또는 false여야 합니다.",
      { code: "AWS_FINAL_RECONCILE_INVALID" }
    );
  }
  const expectedFinalSlot = normalizedScheduleSlot(
    env.AUTOTRADE_FINAL_RECONCILE_SLOT,
    "reconcile-final"
  );
  const finalReconcile = finalFlag === "true";
  const isFinalSlot =
    normalizedCommand === "reconcile" && scheduleSlot === expectedFinalSlot;
  if (finalReconcile !== isFinalSlot) {
    throw new AwsRuntimeGuardError(
      "AWS 최종 주문대조 slot과 플래그가 일치하지 않습니다.",
      { code: "AWS_FINAL_RECONCILE_INVALID" }
    );
  }
  return {
    command: normalizedCommand,
    source,
    executionId,
    scheduledAt,
    current,
    businessDate: kstBusinessDate(scheduledAt),
    scheduleSlot,
    finalReconcile
  };
}

export async function attestEcsRuntime({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 3_000
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("ECS metadata fetch 구현이 필요합니다.");
  }
  const base = requiredText(
    env.ECS_CONTAINER_METADATA_URI_V4,
    "ECS metadata URI",
    1_024
  );
  if (!base.startsWith("http://169.254.170.2/")) {
    throw new AwsRuntimeGuardError("ECS metadata URI가 task metadata endpoint가 아닙니다.", {
      code: "AWS_ECS_ATTESTATION_FAILED"
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}/task`, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) {
      throw new AwsRuntimeGuardError("ECS task metadata 응답이 실패했습니다.", {
        code: "AWS_ECS_ATTESTATION_FAILED"
      });
    }
    const metadata = await response.json();
    const taskArn = String(metadata?.TaskARN || "");
    const family = String(metadata?.Family || "");
    const cluster = String(metadata?.Cluster || "");
    if (
      !/^arn:aws[a-z-]*:ecs:[a-z0-9-]+:\d{12}:task\//.test(taskArn) ||
      !family ||
      !cluster
    ) {
      throw new AwsRuntimeGuardError("ECS task metadata 형식이 올바르지 않습니다.", {
        code: "AWS_ECS_ATTESTATION_FAILED"
      });
    }
    const expectedFamily = String(env.AUTOTRADE_EXPECTED_TASK_FAMILY || "").trim();
    if (expectedFamily && family !== expectedFamily) {
      throw new AwsRuntimeGuardError("ECS task definition family가 예상값과 다릅니다.", {
        code: "AWS_ECS_ATTESTATION_FAILED"
      });
    }
    return { taskArn, family, cluster };
  } catch (error) {
    if (error instanceof AwsRuntimeGuardError) throw error;
    throw new AwsRuntimeGuardError("ECS task runtime을 확인하지 못했습니다.", {
      code: "AWS_ECS_ATTESTATION_FAILED",
      cause: error
    });
  } finally {
    clearTimeout(timer);
  }
}
