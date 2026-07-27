import { pathToFileURL } from "node:url";

import {
  publicAwsTaskFailure,
  runAwsTask
} from "../autotrade/aws/runner.mjs";

async function main() {
  try {
    const command = String(process.argv[2] || "").trim().toLowerCase();
    const result = await runAwsTask({ command });
    console.log(JSON.stringify({ ok: true, result }));
  } catch (error) {
    console.error(JSON.stringify(publicAwsTaskFailure(error)));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
