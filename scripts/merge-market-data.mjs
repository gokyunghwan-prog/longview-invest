import { getRuntimeConfig } from "../lib/config.mjs";
import { mergeMarketDatasets } from "../lib/market-dataset.mjs";

try {
  const dataset = await mergeMarketDatasets(getRuntimeConfig());
  console.log(
    `한국 전체시장 병합 완료: ${dataset.meta.coverage.kr.toLocaleString("ko-KR")}개`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
