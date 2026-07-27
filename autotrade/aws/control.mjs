import { GetParameterCommand } from "@aws-sdk/client-ssm";

export class AwsTradingControlError extends Error {
  constructor(message, { code = "AWS_TRADING_CONTROL_ERROR", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AwsTradingControlError";
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

function validateControl(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    typeof value.killSwitch !== "boolean" ||
    typeof value.liveEnabled !== "boolean"
  ) {
    throw new AwsTradingControlError("AWS 자동투자 제어값 형식이 올바르지 않습니다.", {
      code: "AWS_TRADING_CONTROL_INVALID"
    });
  }
  return {
    schemaVersion: 1,
    killSwitch: value.killSwitch,
    liveEnabled: value.liveEnabled,
    reason: String(value.reason || "").slice(0, 500),
    updatedAt:
      typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
        ? value.updatedAt
        : null
  };
}

export class AwsTradingControl {
  constructor({ client, parameterName } = {}) {
    if (!client || typeof client.send !== "function") {
      throw new TypeError("SSM client가 필요합니다.");
    }
    this.client = client;
    this.parameterName = requiredText(parameterName, "AWS 자동투자 제어 파라미터");
  }

  async read() {
    let response;
    try {
      response = await this.client.send(
        new GetParameterCommand({
          Name: this.parameterName,
          WithDecryption: false
        })
      );
    } catch (error) {
      throw new AwsTradingControlError("AWS 자동투자 제어값을 읽지 못했습니다.", {
        code: "AWS_TRADING_CONTROL_READ_FAILED",
        cause: error
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(String(response?.Parameter?.Value || ""));
    } catch {
      throw new AwsTradingControlError("AWS 자동투자 제어값 JSON이 손상되었습니다.", {
        code: "AWS_TRADING_CONTROL_INVALID"
      });
    }
    return validateControl(parsed);
  }

  async killSwitchActive(executionMode) {
    if (String(executionMode || "").toLowerCase() !== "live") return false;
    const control = await this.read();
    return control.killSwitch || !control.liveEnabled;
  }

  async assertNewOrdersAllowed(executionMode) {
    if (String(executionMode || "").toLowerCase() !== "live") {
      throw new AwsTradingControlError("AWS 실행모드가 live가 아니어서 주문을 차단했습니다.", {
        code: "AWS_LIVE_MODE_DISABLED"
      });
    }
    const control = await this.read();
    if (!control.liveEnabled) {
      throw new AwsTradingControlError("AWS 실전 자동투자 승인이 꺼져 있습니다.", {
        code: "AWS_LIVE_GATE_DISABLED"
      });
    }
    if (control.killSwitch) {
      throw new AwsTradingControlError("AWS 긴급 정지가 켜져 있어 신규 주문을 차단했습니다.", {
        code: "AWS_KILL_SWITCH"
      });
    }
    return control;
  }

  async assertCancellationAllowed(executionMode) {
    if (String(executionMode || "").toLowerCase() !== "live") {
      throw new AwsTradingControlError("AWS 실행모드가 live가 아니어서 주문취소를 차단했습니다.", {
        code: "AWS_LIVE_MODE_DISABLED"
      });
    }
    const control = await this.read();
    if (!control.liveEnabled) {
      throw new AwsTradingControlError("AWS 실전 자동투자 승인이 꺼져 있습니다.", {
        code: "AWS_LIVE_GATE_DISABLED"
      });
    }
    // 긴급정지는 신규 매수·매도를 막지만 기존 미체결 주문의 안전 취소는
    // 허용한다. 노출을 줄이는 취소까지 막으면 계좌 위험이 더 커질 수 있다.
    return control;
  }
}
