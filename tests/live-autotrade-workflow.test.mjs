import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/live-autotrade.yml", import.meta.url);

test("legacy GitHub live workflow는 예약·주문·비밀 없이 영구 폐기 상태다", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /Retired GitHub live autotrade/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.doesNotMatch(workflow, /cloud-autotrade|KIS_|AUTOTRADE_STATE_KEY|secrets\./);
});
