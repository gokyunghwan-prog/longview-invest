import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { getRuntimeConfig } from "../lib/config.mjs";

export function priceProviderFailures(
  diagnostics,
  { requireKoreanProvider = false } = {}
) {
  const providers = Array.isArray(diagnostics?.providers) ? diagnostics.providers : [];
  const failures = providers.filter(
    (provider) => provider?.attempted === true && provider?.status !== "ok"
  );
  if (requireKoreanProvider) {
    const koreanProvider = providers.find((provider) => provider?.code === "KR_PUBLIC");
    if (
      !koreanProvider ||
      koreanProvider.attempted !== true ||
      koreanProvider.status !== "ok"
    ) {
      if (koreanProvider && !failures.includes(koreanProvider)) failures.push(koreanProvider);
      if (!koreanProvider) {
        failures.push({
          code: "KR_PUBLIC",
          status: "missing",
          error: "국내 공식 시세 공급자가 실행되지 않았습니다."
        });
      }
    }
  }
  return failures;
}

export async function verifyPriceProviders({
  config = getRuntimeConfig(),
  env = process.env,
  logger = console
} = {}) {
  try {
    const diagnostics = JSON.parse(await readFile(config.priceSyncDiagnosticsFile, "utf8"));
    const failures = priceProviderFailures(diagnostics, {
      requireKoreanProvider: env.REQUIRE_KR_PRICE_PROVIDER === "true"
    });
    if (failures.length > 0) {
      logger.error(
        "설정된 시세 공급자 갱신 실패: " +
          failures
            .map((provider) => `${provider.code}: ${provider.error || provider.status}`)
            .join(" · ")
      );
      return false;
    }
    logger.log("설정된 시세 공급자 검증 완료");
    return true;
  } catch (error) {
    logger.error(
      "시세 진단 파일 검증 실패:",
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule() && !(await verifyPriceProviders())) process.exitCode = 1;
