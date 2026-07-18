import { readFile } from "node:fs/promises";

import { getRuntimeConfig } from "../lib/config.mjs";

const config = getRuntimeConfig();

try {
  const diagnostics = JSON.parse(await readFile(config.priceSyncDiagnosticsFile, "utf8"));
  const failures = (diagnostics.providers || []).filter(
    (provider) => provider.attempted && provider.status !== "ok"
  );
  if (failures.length > 0) {
    console.error(
      "설정된 시세 공급자 갱신 실패: " +
        failures.map((provider) => `${provider.code}: ${provider.error || provider.status}`).join(" · ")
    );
    process.exitCode = 1;
  } else {
    console.log("설정된 시세 공급자 검증 완료");
  }
} catch (error) {
  console.error("시세 진단 파일 검증 실패:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
