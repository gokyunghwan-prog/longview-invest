import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ROOT_DIR } from "../lib/config.mjs";
import { normalizeKoreanSnapshot } from "../lib/korean-snapshot.mjs";
import { scoreAndRank } from "../lib/scoring.mjs";

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function normalizeFile(file) {
  const raw = JSON.parse(await readFile(file, "utf8"));
  const normalized = normalizeKoreanSnapshot(raw);
  normalized.companies = scoreAndRank(normalized.companies, new Date());
  const temporary = file + ".tmp-" + process.pid;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(normalized) + "\n", "utf8");
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  console.log(`${path.relative(ROOT_DIR, file)}: 한국 기업 ${normalized.companies.length}개`);
}

const requested = process.argv.slice(2).map((file) => path.resolve(file));
const files = requested.length
  ? requested
  : [
      path.join(ROOT_DIR, "data", "companies.json"),
      path.join(ROOT_DIR, ".cache", "companies.json")
    ];

for (const file of files) {
  if (await exists(file)) await normalizeFile(file);
}
