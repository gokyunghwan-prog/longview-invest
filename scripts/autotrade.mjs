import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getTradingConfig, publicTradingConfig } from "../autotrade/config.mjs";
import { createTradingEngine } from "../autotrade/engine.mjs";
import { redactSensitive } from "../autotrade/risk.mjs";

const LIVE_RUN_CONFIRMATION = "I_CONFIRM_THIS_LIVE_ORDER_RUN";

function formatWon(value) {
  return Number.isFinite(Number(value))
    ? `${Math.round(Number(value)).toLocaleString("ko-KR")}원`
    : "확인 불가";
}

function printPlan(plan) {
  console.log(`신호: ${plan.signal.modelVersion} · 후보 ${plan.signal.candidateCount}개`);
  console.log(
    `포트폴리오: ${plan.portfolio.selected.length}개 · 현금 목표 ${Math.round(plan.portfolio.cashTargetWeight * 100)}%`
  );
  console.log(`계좌 기준금액: ${formatWon(plan.account.totalEquityKrw)}`);
  console.log(`주문 계획: ${plan.orders.length}건`);
  for (const order of plan.orders) {
    console.log(
      `- ${order.side === "buy" ? "매수" : "매도"} ${order.name || order.ticker} ${order.quantity}주 @ ${order.limitPrice.toLocaleString("ko-KR")} ${order.currency}`
    );
  }
  if (plan.blockedReasons.length > 0) {
    console.log("차단 사유:");
    for (const reason of plan.blockedReasons) console.log(`- ${reason}`);
  }
}

async function main() {
  const command = process.argv[2] || "help";
  const config = getTradingConfig();
  const killSwitchFile = path.join(config.stateDir, "KILL_SWITCH");

  if (command === "stop") {
    await mkdir(config.stateDir, { recursive: true });
    await writeFile(killSwitchFile, `stoppedAt=${new Date().toISOString()}\n`, {
      encoding: "utf8",
      flag: "w"
    });
    console.log("긴급 정지 스위치를 켰습니다. 이후 주문은 차단됩니다.");
    return;
  }
  if (command === "resume") {
    if (!process.argv.includes("--confirm-resume")) {
      throw new Error("재개하려면 --confirm-resume을 함께 입력하세요.");
    }
    await rm(killSwitchFile, { force: true });
    console.log("긴급 정지 스위치를 해제했습니다.");
    return;
  }
  if (!["plan", "run", "status", "resolve-inflight", "resolve-pending"].includes(command)) {
    console.log("사용법:");
    console.log("  npm.cmd run trade:plan    계획만 확인(주문 없음)");
    console.log("  npm.cmd run trade:run     현재 모드 실행");
    console.log("  npm.cmd run trade:status  상태 확인");
    console.log("  node scripts/autotrade.mjs stop   긴급 정지");
    console.log(
      "  node scripts/autotrade.mjs resolve-inflight --confirm-no-retry=실행키"
    );
    console.log(
      "  node scripts/autotrade.mjs resolve-pending 실행키 --confirm-no-fill"
    );
    return;
  }

  const engine = await createTradingEngine(config);
  if (command === "resolve-inflight") {
    const prefix = "--confirm-no-retry=";
    const confirmation = process.argv.find((item) => item.startsWith(prefix));
    const cycleKey = confirmation?.slice(prefix.length) || "";
    if (!cycleKey) {
      throw new Error(
        "증권사 주문내역을 직접 대조한 뒤 --confirm-no-retry=실행키를 입력하세요."
      );
    }
    await engine.resolveInFlightNoRetry(cycleKey);
    console.log("미결 실행을 재주문 없이 종료했습니다. 해당 실행 주기는 다시 주문하지 않습니다.");
    return;
  }
  if (command === "resolve-pending") {
    const cycleKey = String(process.argv[3] || "").trim();
    if (!process.argv.includes("--confirm-no-fill")) {
      throw new Error(
        "증권사 앱에서 해당 실행키의 체결·미체결 주문이 모두 없음을 대조한 뒤 --confirm-no-fill을 입력하세요."
      );
    }
    const result = await engine.resolvePendingNoFill(cycleKey);
    console.log(
      `매수 대기 ${result.resolvedCount}건을 미체결로 확인해 해제했습니다. 늦은 체결이 나타나면 관리 밖 보유종목으로 차단됩니다.`
    );
    return;
  }
  if (command === "status") {
    const status = await engine.status();
    const publicConfig = publicTradingConfig(config);
    console.log(`모드: ${publicConfig.mode} · 브로커: ${publicConfig.broker}`);
    console.log(`긴급 정지: ${status.killSwitchActive ? "켜짐" : "꺼짐"}`);
    console.log(`최근 실행: ${status.lastRun?.at || "없음"}`);
    console.log(
      `미결 주문 실행: ${status.state.strategy.inFlight?.cycleKey || "없음"}`
    );
    const pendingCycles = [...new Set(
      Object.values(status.state.strategy.pendingManagedSecurities || {})
        .map((item) => item?.cycleKey)
        .filter(Boolean)
    )];
    console.log(`잔고 미확인 매수 실행: ${pendingCycles.join(", ") || "없음"}`);
    console.log(`모의 현금: ${formatWon(status.state.paper.cashKrw)}`);
    console.log(`모의 보유종목: ${Object.keys(status.state.paper.positions).length}개`);
    return;
  }
  if (command === "plan") {
    printPlan(await engine.plan());
    return;
  }

  const liveConfirmation = process.argv.includes(
    `--confirm-live=${LIVE_RUN_CONFIRMATION}`
  );
  const result = await engine.execute({ trigger: "cli", liveConfirmation });
  printPlan(result);
  console.log(
    result.executed
      ? `실행 결과: ${result.results.map((item) => item.status).join(", ")}`
      : `실행 안 함: ${result.reason}`
  );
  if (!result.ok) process.exitCode = 2;
}

main().catch((error) => {
  const config = (() => {
    try {
      return getTradingConfig();
    } catch {
      return null;
    }
  })();
  console.error(
    "자동매매 명령 실패:",
    redactSensitive(error, [
      config?.kis?.appKey,
      config?.kis?.appSecret,
      config?.kis?.accountNumber
    ])
  );
  process.exitCode = 1;
});
