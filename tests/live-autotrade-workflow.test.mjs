import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/live-autotrade.yml", import.meta.url);

test("live workflow uses retry-safe heartbeats and never schedules manual top-up", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /cron: "17,47 \* \* \* 1-5"/);
  assert.match(workflow, /cron: "13 6 \* \* 1-5"/);
  assert.match(workflow, /TRADING_AUTODEPLOY_CASH: "true"/);
  assert.match(workflow, /run: node scripts\/cloud-autotrade\.mjs auto/);
  assert.match(workflow, /CLOUD_EVENT_SCHEDULE: "17,47 \* \* \* 1-5"/);
  assert.match(workflow, /cancel-in-progress: false/);

  const scheduledTopUp = [
    ...workflow.matchAll(
      /if: github\.event_name == 'schedule'[^\n]*\n\s+run: node scripts\/cloud-autotrade\.mjs ([^\s]+)/g
    )
  ].map((match) => match[1]);
  assert.ok(!scheduledTopUp.includes("topup"));
  assert.ok(!scheduledTopUp.includes("topup-plan"));
});
