import assert from "node:assert/strict";
import test from "node:test";

import { GetParameterCommand } from "@aws-sdk/client-ssm";

import {
  AwsTradingControl,
  AwsTradingControlError
} from "../autotrade/aws/control.mjs";
import {
  AwsRuntimeGuardError,
  attestEcsRuntime,
  compactKstBusinessDate,
  kstBusinessDate,
  validateAwsInvocation
} from "../autotrade/aws/runtime-guard.mjs";

const SCHEDULE_GROUP = "longview-prod-schedules";
const SCHEDULE_PREFIX = "longview-prod";

function scheduledEnvironment(command, variant = command) {
  const bindings = {
    auto: ["auto", "auto"],
    sync: ["sync", "data-sync"],
    audit: ["audit", "audit"],
    close: ["reconcile-close", "reconcile-close"],
    verify: ["reconcile-verify-1", "reconcile-verify"],
    final: ["reconcile-final", "reconcile-final"]
  };
  const [slot, name] = bindings[variant];
  return {
    AUTOTRADE_TASK_SOURCE: "eventbridge-scheduler",
    AUTOTRADE_EXECUTION_ID: `exec-${variant}`,
    AUTOTRADE_SCHEDULED_AT: "2026-07-24T00:00:00.000Z",
    AUTOTRADE_SCHEDULE_SLOT: slot,
    AUTOTRADE_SCHEDULE_ARN:
      "arn:aws:scheduler:ap-northeast-2:123456789012:" +
      `schedule/${SCHEDULE_GROUP}/${SCHEDULE_PREFIX}-${name}`,
    AUTOTRADE_EXPECTED_SCHEDULE_GROUP: SCHEDULE_GROUP,
    AUTOTRADE_EXPECTED_SCHEDULE_NAME_PREFIX: SCHEDULE_PREFIX,
    AUTOTRADE_FINAL_RECONCILE:
      command === "reconcile" && variant === "final" ? "true" : "false",
    AUTOTRADE_FINAL_RECONCILE_SLOT: "reconcile-final"
  };
}

class QueueClient {
  constructor(...responses) {
    this.responses = responses;
    this.calls = [];
  }

  async send(command) {
    this.calls.push(command);
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(command);
    return next ?? {};
  }
}

function controlResponse(value) {
  return {
    Parameter: {
      Value: typeof value === "string" ? value : JSON.stringify(value)
    }
  };
}

function controlValue(overrides = {}) {
  return {
    schemaVersion: 1,
    killSwitch: false,
    liveEnabled: true,
    reason: "승인된 배포",
    updatedAt: "2026-07-24T00:00:00.000Z",
    ...overrides
  };
}

function assertCode(ErrorClass, code) {
  return (error) => {
    assert.ok(error instanceof ErrorClass);
    assert.equal(error.code, code);
    return true;
  };
}

test("AWS 제어값은 SSM에서 fail-closed 형식으로 읽는다", async () => {
  const client = new QueueClient(controlResponse(controlValue()));
  const control = new AwsTradingControl({
    client,
    parameterName: "/longview/prod/trading-control"
  });

  assert.deepEqual(await control.read(), controlValue());
  assert.equal(client.calls.length, 1);
  assert.ok(client.calls[0] instanceof GetParameterCommand);
  assert.deepEqual(client.calls[0].input, {
    Name: "/longview/prod/trading-control",
    WithDecryption: false
  });
});

test("AWS 제어값 읽기·JSON·schema 오류는 모두 안전하게 차단한다", async (t) => {
  await t.test("SSM 오류", async () => {
    const control = new AwsTradingControl({
      client: new QueueClient(new Error("secret backend detail")),
      parameterName: "/control"
    });
    await assert.rejects(
      control.read(),
      assertCode(AwsTradingControlError, "AWS_TRADING_CONTROL_READ_FAILED")
    );
  });

  await t.test("깨진 JSON", async () => {
    const control = new AwsTradingControl({
      client: new QueueClient(controlResponse("{")),
      parameterName: "/control"
    });
    await assert.rejects(
      control.read(),
      assertCode(AwsTradingControlError, "AWS_TRADING_CONTROL_INVALID")
    );
  });

  await t.test("불완전한 schema", async () => {
    const control = new AwsTradingControl({
      client: new QueueClient(
        controlResponse({ schemaVersion: 1, killSwitch: false })
      ),
      parameterName: "/control"
    });
    await assert.rejects(
      control.read(),
      assertCode(AwsTradingControlError, "AWS_TRADING_CONTROL_INVALID")
    );
  });
});

test("dry-run은 주문 승인을 받을 수 없고 live는 이중 gate를 모두 요구한다", async (t) => {
  const dryClient = new QueueClient();
  const dryControl = new AwsTradingControl({
    client: dryClient,
    parameterName: "/control"
  });
  assert.equal(await dryControl.killSwitchActive("dry-run"), false);
  assert.equal(dryClient.calls.length, 0);
  await assert.rejects(
    dryControl.assertNewOrdersAllowed("dry-run"),
    assertCode(AwsTradingControlError, "AWS_LIVE_MODE_DISABLED")
  );

  await t.test("liveEnabled=false", async () => {
    const control = new AwsTradingControl({
      client: new QueueClient(
        controlResponse(controlValue({ liveEnabled: false }))
      ),
      parameterName: "/control"
    });
    assert.equal(await control.killSwitchActive("live"), true);
  });

  await t.test("killSwitch=true", async () => {
    const control = new AwsTradingControl({
      client: new QueueClient(
        controlResponse(controlValue({ killSwitch: true }))
      ),
      parameterName: "/control"
    });
    await assert.rejects(
      control.assertNewOrdersAllowed("live"),
      assertCode(AwsTradingControlError, "AWS_KILL_SWITCH")
    );
  });

  await t.test("두 gate가 모두 열린 live", async () => {
    const control = new AwsTradingControl({
      client: new QueueClient(controlResponse(controlValue())),
      parameterName: "/control"
    });
    assert.equal((await control.assertNewOrdersAllowed("live")).liveEnabled, true);
  });
});

test("긴급정지 중에도 기존 미체결 주문 취소는 허용하되 live 승인은 요구한다", async () => {
  const control = new AwsTradingControl({
    client: new QueueClient(
      controlResponse(controlValue({ killSwitch: true }))
    ),
    parameterName: "/control"
  });
  assert.equal((await control.assertCancellationAllowed("live")).killSwitch, true);

  const disabled = new AwsTradingControl({
    client: new QueueClient(
      controlResponse(controlValue({ liveEnabled: false, killSwitch: true }))
    ),
    parameterName: "/control"
  });
  await assert.rejects(
    disabled.assertCancellationAllowed("live"),
    assertCode(AwsTradingControlError, "AWS_LIVE_GATE_DISABLED")
  );
});

test("AWS 예약 호출은 명령·출처·지연시간·KST 영업일을 검증한다", () => {
  const result = validateAwsInvocation({
    command: "AUTO",
    env: {
      ...scheduledEnvironment("auto"),
      AUTOTRADE_SCHEDULED_AT: "2026-07-21T15:30:00.000Z",
    },
    now: () => new Date("2026-07-21T15:39:59.000Z")
  });

  assert.equal(result.command, "auto");
  assert.equal(result.businessDate, "2026-07-22");
  assert.equal(result.scheduleSlot, "auto");
  assert.equal(result.finalReconcile, false);
  assert.equal(kstBusinessDate("2026-07-21T15:00:00.000Z"), "2026-07-22");
  assert.equal(compactKstBusinessDate("2026-07-21T14:59:59.999Z"), "20260721");
});

test("stale·과도한 미래 예약과 모든 수동 live 실행을 거부한다", async (t) => {
  for (const [name, command, now] of [
    ["trade 10분 초과", "auto", "2026-07-24T00:10:00.001Z"],
    ["sync 30분 초과", "sync", "2026-07-24T00:30:00.001Z"],
    ["2분 초과 미래", "audit", "2026-07-23T23:57:59.999Z"]
  ]) {
    await t.test(name, () => {
      assert.throws(
        () =>
          validateAwsInvocation({
            command,
            env: scheduledEnvironment(command),
            now: () => new Date(now)
          }),
        assertCode(AwsRuntimeGuardError, "AWS_SCHEDULE_STALE")
      );
    });
  }

  assert.throws(
    () =>
      validateAwsInvocation({
        command: "auto",
        env: {
          AUTOTRADE_TASK_SOURCE: "manual",
          AUTOTRADE_EXECUTION_ID: "manual-1",
          AUTOTRADE_EXECUTION_MODE: "live",
          AUTOTRADE_SCHEDULE_ARN: "manual",
          AUTOTRADE_SCHEDULE_SLOT: "auto"
        },
        now: () => new Date("2026-07-24T01:00:00.000Z")
      }),
    assertCode(AwsRuntimeGuardError, "AWS_MANUAL_LIVE_FORBIDDEN")
  );
});

test("정확히 결합된 dry-run 수동호출만 허용한다", () => {
  const dry = validateAwsInvocation({
    command: "audit",
    env: {
      AUTOTRADE_TASK_SOURCE: "manual",
      AUTOTRADE_EXECUTION_ID: "manual-dry",
      AUTOTRADE_EXECUTION_MODE: "dry-run",
      AUTOTRADE_SCHEDULE_ARN: "manual",
      AUTOTRADE_SCHEDULE_SLOT: "audit"
    },
    now: () => new Date("2026-07-24T01:00:00.000Z")
  });
  assert.equal(dry.executionId, "manual-dry");
});

test("Scheduler ARN·group·name·command·slot 중 하나라도 다르면 거부한다", () => {
  const valid = scheduledEnvironment("auto");
  for (const changed of [
    { AUTOTRADE_SCHEDULE_SLOT: "reconcile-close" },
    {
      AUTOTRADE_SCHEDULE_ARN:
        "arn:aws:scheduler:ap-northeast-2:123456789012:" +
        `schedule/other-group/${SCHEDULE_PREFIX}-auto`
    },
    {
      AUTOTRADE_SCHEDULE_ARN:
        "arn:aws:scheduler:ap-northeast-2:123456789012:" +
        `schedule/${SCHEDULE_GROUP}/${SCHEDULE_PREFIX}-audit`
    }
  ]) {
    assert.throws(
      () =>
        validateAwsInvocation({
          command: "auto",
          env: { ...valid, ...changed },
          now: () => new Date("2026-07-24T00:00:30.000Z")
        }),
      assertCode(AwsRuntimeGuardError, "AWS_SCHEDULE_BINDING_INVALID")
    );
  }
});

test("최종 reconcile은 전용 slot과 true 플래그가 반드시 함께 와야 한다", () => {
  const base = {
    ...scheduledEnvironment("reconcile", "final"),
    AUTOTRADE_SCHEDULED_AT: "2026-07-24T06:55:00.000Z",
  };
  const valid = validateAwsInvocation({
    command: "reconcile",
    env: {
      ...base,
      AUTOTRADE_SCHEDULE_SLOT: "reconcile-final",
      AUTOTRADE_FINAL_RECONCILE: "true"
    },
    now: () => new Date("2026-07-24T06:55:30.000Z")
  });
  assert.equal(valid.finalReconcile, true);

  for (const env of [
    {
      ...base,
      AUTOTRADE_SCHEDULE_SLOT: "reconcile-final",
      AUTOTRADE_FINAL_RECONCILE: "false"
    },
    {
      ...base,
      ...scheduledEnvironment("reconcile", "close"),
      AUTOTRADE_SCHEDULED_AT: "2026-07-24T06:55:00.000Z",
      AUTOTRADE_FINAL_RECONCILE: "true"
    },
    {
      ...base,
      AUTOTRADE_SCHEDULE_SLOT: "reconcile-final",
      AUTOTRADE_FINAL_RECONCILE: "yes"
    }
  ]) {
    assert.throws(
      () =>
        validateAwsInvocation({
          command: "reconcile",
          env,
          now: () => new Date("2026-07-24T06:55:30.000Z")
        }),
      assertCode(AwsRuntimeGuardError, "AWS_FINAL_RECONCILE_INVALID")
    );
  }
});

test("ECS runtime attestation은 link-local metadata와 task family를 검증한다", async () => {
  const calls = [];
  const result = await attestEcsRuntime({
    env: {
      ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/container-id",
      AUTOTRADE_EXPECTED_TASK_FAMILY: "longview-trading"
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            TaskARN:
              "arn:aws:ecs:ap-northeast-2:123456789012:task/cluster/task-id",
            Family: "longview-trading",
            Cluster: "longview-cluster"
          };
        }
      };
    }
  });

  assert.equal(result.family, "longview-trading");
  assert.equal(calls[0].url, "http://169.254.170.2/v4/container-id/task");
  assert.equal(calls[0].options.redirect, "error");
});

test("위조 metadata 주소·task family·timeout은 ECS 증명 실패로 닫힌다", async (t) => {
  await t.test("외부 주소", async () => {
    await assert.rejects(
      attestEcsRuntime({
        env: { ECS_CONTAINER_METADATA_URI_V4: "https://example.com/metadata" },
        fetchImpl: async () => {
          throw new Error("호출되면 안 됨");
        }
      }),
      assertCode(AwsRuntimeGuardError, "AWS_ECS_ATTESTATION_FAILED")
    );
  });

  await t.test("family 불일치", async () => {
    await assert.rejects(
      attestEcsRuntime({
        env: {
          ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/id",
          AUTOTRADE_EXPECTED_TASK_FAMILY: "expected"
        },
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return {
              TaskARN:
                "arn:aws:ecs:ap-northeast-2:123456789012:task/cluster/task-id",
              Family: "unexpected",
              Cluster: "cluster"
            };
          }
        })
      }),
      assertCode(AwsRuntimeGuardError, "AWS_ECS_ATTESTATION_FAILED")
    );
  });

  await t.test("timeout", async () => {
    await assert.rejects(
      attestEcsRuntime({
        env: { ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/id" },
        timeoutMs: 5,
        fetchImpl: async (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true
            });
          })
      }),
      assertCode(AwsRuntimeGuardError, "AWS_ECS_ATTESTATION_FAILED")
    );
  });
});
