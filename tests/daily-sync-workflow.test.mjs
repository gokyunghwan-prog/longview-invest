import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/daily-sync.yml", import.meta.url);

function stepBlock(workflow, name, nextName) {
  const start = workflow.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const end = nextName
    ? workflow.indexOf(`      - name: ${nextName}`, start + 1)
    : workflow.length;
  assert.notEqual(end, -1, `missing following workflow step: ${nextName}`);
  return workflow.slice(start, end);
}

test("daily sync verifies every configured price provider before selection or publication", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(workflow, /cron: "35 10,13,16 \* \* \*"/);
  assert.match(workflow, /timeout-minutes: 120/);
  assert.match(workflow, /cancel-in-progress: false/);
  const syncAt = workflow.indexOf("      - name: Sync KOSPI and KOSDAQ");
  const pricesAt = workflow.indexOf(
    "      - name: Verify configured price providers before publishing"
  );
  const selectionAt = workflow.indexOf(
    "      - name: Generate the shared website and autotrade selection"
  );
  const validationAt = workflow.indexOf("      - name: Validate generated snapshot");
  const commitAt = workflow.indexOf("      - name: Commit updated public snapshot");
  const cacheSaveAt = workflow.indexOf("      - name: Save DART universe checkpoints");

  assert.ok(syncAt < pricesAt, "price verification must run after the sync diagnostics exist");
  assert.ok(pricesAt < selectionAt, "selection must not be generated before price verification");
  assert.ok(selectionAt < validationAt, "snapshot validation must follow selection generation");
  assert.ok(validationAt < commitAt, "publication must be the final guarded data step");
  assert.ok(commitAt < cacheSaveAt, "checkpoint caching must not block a valid publication");

  const priceStep = stepBlock(
    workflow,
    "Verify configured price providers before publishing",
    "Generate the shared website and autotrade selection"
  );
  assert.match(priceStep, /id: price_validation/);
  assert.match(priceStep, /continue-on-error: true/);
  assert.match(priceStep, /run: npm run verify:prices/);
  assert.match(priceStep, /REQUIRE_KR_PRICE_PROVIDER: "true"/);

  const selectionStep = stepBlock(
    workflow,
    "Generate the shared website and autotrade selection",
    "Validate generated snapshot"
  );
  assert.match(selectionStep, /steps\.price_validation\.outcome == 'success'/);

  const validationStep = stepBlock(
    workflow,
    "Validate generated snapshot",
    "Upload sync diagnostics"
  );
  assert.match(validationStep, /steps\.price_validation\.outcome == 'success'/);

  const cacheSaveStep = stepBlock(
    workflow,
    "Save DART universe checkpoints",
    "Fail when the Korean market collector failed"
  );
  assert.match(cacheSaveStep, /if: always\(\)/);
  assert.match(cacheSaveStep, /continue-on-error: true/);

  const commitStep = stepBlock(
    workflow,
    "Commit updated public snapshot",
    "Fail when the Korean market collector failed"
  );
  assert.match(commitStep, /steps\.price_validation\.outcome == 'success'/);
  assert.match(commitStep, /git add data\/companies\.json data\/trading-selection\.json/);
  assert.match(commitStep, /git push/);
  assert.doesNotMatch(workflow, /dedupe-generated-snapshot/);
  assert.doesNotMatch(workflow, /previous-trading-selection/);

  const failureStep = stepBlock(
    workflow,
    "Fail when a configured price provider failed",
    "Fail when the shared investment selection failed"
  );
  assert.match(failureStep, /steps\.price_validation\.outcome == 'failure'/);
  assert.match(failureStep, /run: exit 1/);
});
