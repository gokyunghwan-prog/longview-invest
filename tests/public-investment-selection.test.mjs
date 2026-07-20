import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));

test("웹 기본 정렬은 자동투자 선정순이고 전체 연구 순위도 보존한다", async () => {
  const [html, script] = await Promise.all([
    readFile(path.join(publicDirectory, "index.html"), "utf8"),
    readFile(path.join(publicDirectory, "app.js"), "utf8")
  ]);
  assert.match(html, /<option value="investment" selected>자동투자 선정순<\/option>/);
  assert.match(html, /<option value="score">전체 연구 종합점수순<\/option>/);
  assert.match(html, /id="investment-selection-note"/);
  assert.match(script, /sort: "investment"/);
  assert.match(script, /fetch\("\/api\/investment-selection"/);
  assert.match(script, /projectedReferenceCashKrw/);
  assert.match(script, /!overviewChanged && state\.filters\.sort !== "investment"/);
});
