import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildInvestmentSelection } from "../lib/investment-selection.mjs";
import { normalizeKoreanSnapshot } from "../lib/korean-snapshot.mjs";
import { SCORING_MODEL_VERSION, scoreAndRank } from "../lib/scoring.mjs";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));

function snapshotRevision(snapshot) {
  return createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex")
    .slice(0, 20);
}

function parseArguments(argv) {
  const values = {
    dataFile: path.join(ROOT_DIR, "data", "companies.json"),
    outputFile: path.join(ROOT_DIR, "data", "trading-selection.json"),
    now: new Date()
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--data" && value) {
      values.dataFile = path.resolve(value);
      index += 1;
    } else if (argument === "--output" && value) {
      values.outputFile = path.resolve(value);
      index += 1;
    } else if (argument === "--now" && value) {
      values.now = new Date(value);
      index += 1;
    } else {
      throw new Error(`알 수 없는 인수입니다: ${argument}`);
    }
  }
  if (Number.isNaN(values.now.getTime())) throw new Error("--now 값이 올바르지 않습니다.");
  return values;
}

export async function generateInvestmentSelectionFile({
  dataFile = path.join(ROOT_DIR, "data", "companies.json"),
  outputFile = path.join(ROOT_DIR, "data", "trading-selection.json"),
  now = new Date(),
  policy = undefined
} = {}) {
  const generatedAt = now instanceof Date ? new Date(now) : new Date(now);
  if (Number.isNaN(generatedAt.getTime())) throw new Error("생성시각이 올바르지 않습니다.");
  const raw = JSON.parse(await readFile(dataFile, "utf8"));
  const snapshot = normalizeKoreanSnapshot(raw);
  const companies = scoreAndRank(snapshot.companies, generatedAt);
  const artifact = buildInvestmentSelection({
    companies,
    sourceRevision: snapshotRevision(snapshot),
    sourceUpdatedAt: snapshot.meta?.updatedAt || generatedAt.toISOString(),
    modelVersion: SCORING_MODEL_VERSION,
    generatedAt,
    ...(policy ? { policy } : {})
  });

  await mkdir(path.dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify(artifact, null, 2) + "\n", {
    encoding: "utf8",
    flag: "w"
  });
  await rename(temporary, outputFile);
  return artifact;
}

function isMainModule() {
  return (
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  );
}

if (isMainModule()) {
  const options = parseArguments(process.argv.slice(2));
  const artifact = await generateInvestmentSelectionFile(options);
  console.log(
    `자동투자 선정 산출물 생성: ${artifact.selected.length}개 · ` +
      `참조 잔액 ${artifact.summary.projectedReferenceCashKrw.toLocaleString("ko-KR")}원`
  );
}
