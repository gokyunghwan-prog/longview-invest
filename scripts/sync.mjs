import { getRuntimeConfig } from "../lib/config.mjs";
import { syncAll } from "../lib/sync.mjs";

const config = getRuntimeConfig();

try {
  const result = await syncAll(config, {
    onProgress: (message) => console.log("[" + new Date().toISOString() + "] " + message)
  });
  console.log(
    "데이터 모드: " +
      result.meta.dataMode +
      ", 상태: " +
      result.meta.sync.status
  );
} catch (error) {
  console.error("동기화 실패:", error.message);
  process.exitCode = 1;
}
