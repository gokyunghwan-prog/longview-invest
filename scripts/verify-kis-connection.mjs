import { getTradingConfig } from "../autotrade/config.mjs";
import { createKisBroker } from "../autotrade/brokers/kis.mjs";
import { redactSensitive } from "../autotrade/risk.mjs";
import { loadLocalEnv } from "../lib/config.mjs";

let config;

try {
  loadLocalEnv();

  // 이 검사는 인증과 잔고 조회만 수행한다. 파일의 자동매매 설정과 관계없이
  // 현재 프로세스에서는 주문·자동실행·실전 잠금 해제를 모두 강제로 비활성화한다.
  const verificationEnv = {
    ...process.env,
    TRADING_MODE: "disabled",
    TRADING_BROKER: "kis",
    TRADING_AUTORUN_ENABLED: "false",
    ENABLE_LIVE_TRADING: "false",
    ENABLE_UNATTENDED_LIVE_TRADING: "false"
  };

  config = getTradingConfig({ env: verificationEnv, loadEnv: false });
  const broker = createKisBroker(config.kis);
  const account = await broker.getAccount();

  if (account.currency !== "KRW" || account.domestic?.country !== "KR") {
    throw new Error("KIS 국내주식 원화 계좌 응답을 확인하지 못했습니다.");
  }

  const environmentLabel = config.kis.environment === "prod" ? "실전" : "모의";
  const positionCount = Array.isArray(account.positions) ? account.positions.length : 0;
  console.log(
    `KIS ${environmentLabel} 인증 성공 · 국내주식 계좌 조회 성공 · ` +
      `주문가능 현금 ${Math.floor(account.cashKrw).toLocaleString("ko-KR")}원 · ` +
      `총평가 ${Math.floor(account.totalEquityKrw).toLocaleString("ko-KR")}원 · ` +
      `보유 종목 ${positionCount}개 · 주문 전송 0건`
  );
} catch (error) {
  console.error(
    "KIS 연결 검사 실패:",
    redactSensitive(error, [
      config?.kis?.appKey,
      config?.kis?.appSecret,
      config?.kis?.accountNumber
    ])
  );
  process.exitCode = 1;
}
