import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT_DIR } from "../lib/config.mjs";
import {
  assertValidSnapshot,
  DEFAULT_MAX_DROP_FRACTION,
  DEFAULT_MINIMUM_COUNTS
} from "../lib/snapshot-validator.mjs";

async function readJsonWithBytes(file) {
  const text = await readFile(file, "utf8");
  return { payload: JSON.parse(text), bytes: Buffer.byteLength(text, "utf8") };
}

function positiveInteger(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(option + " must be a positive integer.");
  }
  return parsed;
}

export function parseSnapshotValidationArgs(argv) {
  const options = {
    file: path.join(ROOT_DIR, "data", "companies.json"),
    previous: null,
    requiredCountries: ["KR"],
    minimumCounts: { ...DEFAULT_MINIMUM_COUNTS },
    maxDropFraction: DEFAULT_MAX_DROP_FRACTION
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--file" && value) options.file = path.resolve(value);
    else if (option === "--previous" && value) options.previous = path.resolve(value);
    else if (option === "--country" && value) {
      const country = value.toUpperCase();
      if (country !== "KR") {
        throw new Error("--country must be KR.");
      }
      options.requiredCountries = [country];
    } else if (option === "--minimum-kr" && value) {
      options.minimumCounts.KR = positiveInteger(value, option);
    } else if (option === "--max-drop-percent" && value) {
      const percent = Number(value);
      if (!Number.isFinite(percent) || percent < 0 || percent >= 100) {
        throw new Error("--max-drop-percent must be at least 0 and less than 100.");
      }
      options.maxDropFraction = percent / 100;
    } else {
      throw new Error("Unknown or incomplete option: " + option);
    }

    index += 1;
  }

  return options;
}

export async function validateSnapshotFile(options) {
  const [current, previous] = await Promise.all([
    readJsonWithBytes(options.file),
    options.previous ? readJsonWithBytes(options.previous) : null
  ]);
  return assertValidSnapshot(current.payload, {
    label: options.file,
    requiredCountries: options.requiredCountries,
    minimumCounts: options.minimumCounts,
    maxDropFraction: options.maxDropFraction,
    previousSnapshot: previous?.payload || null,
    snapshotBytes: current.bytes,
    requireCoverage: true
  });
}

async function main() {
  const options = parseSnapshotValidationArgs(process.argv.slice(2));
  const report = await validateSnapshotFile(options);
  console.log(
    `Snapshot valid: total=${report.counts.total}, KR=${report.counts.KR}`
  );
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
