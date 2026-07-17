import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { getRuntimeConfig, ROOT_DIR } from "../lib/config.mjs";
import {
  normalizeSecCompany,
  normalizeSecTickerUniverse,
  SEC_LISTED_EXCHANGES
} from "../lib/providers/sec.mjs";
import { scoreAndRank } from "../lib/scoring.mjs";
import { assertValidSnapshot } from "../lib/snapshot-validator.mjs";

export const SEC_BULK_URLS = Object.freeze({
  tickers: "https://www.sec.gov/files/company_tickers_exchange.json",
  facts: "https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip",
  submissions:
    "https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip"
});

const PRUNE_SCRIPT = path.join(ROOT_DIR, "scripts", "prune-sec-bulk.py");
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MIN_PRUNE_FOUND_RATIO = 0.8;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isHttpSource(source) {
  return /^https?:\/\//i.test(source);
}

function redactSensitive(value) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 2_000);
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function assertPruneCoverage(
  summary,
  expectedRequested,
  minimumFoundRatio = DEFAULT_MIN_PRUNE_FOUND_RATIO
) {
  const requested = Number(summary?.requested);
  const found = Number(summary?.found);
  const kind = String(summary?.kind || "SEC archive");
  if (!Number.isInteger(requested) || requested !== expectedRequested) {
    throw new Error(
      `${kind} prune requested ${requested} CIKs; expected ${expectedRequested}.`
    );
  }
  if (!Number.isInteger(found) || found < 0 || found > requested) {
    throw new Error(`${kind} prune returned an invalid found count: ${found}.`);
  }
  if (
    !Number.isFinite(minimumFoundRatio) ||
    minimumFoundRatio <= 0 ||
    minimumFoundRatio > 1
  ) {
    throw new Error("minimum SEC prune found ratio must be greater than 0 and at most 1.");
  }
  const ratio = requested === 0 ? 0 : found / requested;
  if (ratio < minimumFoundRatio) {
    throw new Error(
      `${kind} prune coverage is too low: ${found}/${requested} ` +
        `(${(ratio * 100).toFixed(1)}%, minimum ${(minimumFoundRatio * 100).toFixed(1)}%).`
    );
  }
  return { requested, found, ratio };
}

async function assertZip(pathname) {
  const handle = await open(pathname, "r");
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    if (bytesRead < 2 || magic[0] !== 0x50 || magic[1] !== 0x4b) {
      throw new Error("다운로드 결과가 ZIP 형식이 아닙니다.");
    }
  } finally {
    await handle.close();
  }
}

export async function downloadToFile(
  url,
  destination,
  {
    userAgent,
    label = "SEC bulk file",
    retries = 3,
    timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
    fetchImpl = fetch
  } = {}
) {
  if (!userAgent) throw new Error("SEC_USER_AGENT가 설정되지 않았습니다.");
  await mkdir(path.dirname(destination), { recursive: true });
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const temporary = destination + ".part-" + process.pid + "-" + attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/octet-stream, application/json;q=0.9",
          "Accept-Encoding": "gzip, deflate",
          "User-Agent": userAgent
        },
        redirect: "follow",
        signal: controller.signal
      });

      if (!response.ok || !response.body) {
        const retryable = response.status === 429 || response.status >= 500;
        await response.body?.cancel().catch(() => {});
        if (retryable && attempt < retries) {
          await sleep(1_000 * 2 ** attempt);
          continue;
        }
        throw new Error(label + " 응답 실패(HTTP " + response.status + ")");
      }

      await pipeline(response.body, createWriteStream(temporary, { flags: "wx" }));
      await rename(temporary, destination);
      const file = await stat(destination);
      return {
        bytes: file.size,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        contentLength: response.headers.get("content-length")
      };
    } catch (error) {
      lastError = error;
      await rm(temporary, { force: true }).catch(() => {});
      if (attempt >= retries || /HTTP 4\d\d/.test(String(error?.message))) break;
      await sleep(1_000 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(redactSensitive(lastError?.message || label + " 다운로드 실패"));
}

async function materializeSource(source, destination, options) {
  if (isHttpSource(source)) {
    return downloadToFile(source, destination, options);
  }

  const resolved = path.resolve(source);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(resolved, destination);
  const file = await stat(destination);
  return {
    bytes: file.size,
    etag: null,
    lastModified: file.mtime.toISOString(),
    contentLength: String(file.size)
  };
}

export function runPruner(
  {
    python = process.env.PYTHON || "python",
    archive,
    ciks,
    output,
    kind,
    maxEntryBytes = 128 * 1024 * 1024
  },
  spawnImpl = spawn
) {
  return new Promise((resolve, reject) => {
    const args = [
      PRUNE_SCRIPT,
      "--archive",
      archive,
      "--ciks",
      ciks,
      "--output",
      output,
      "--kind",
      kind,
      "--max-entry-bytes",
      String(maxEntryBytes)
    ];
    const childEnvironment = {};
    for (const key of [
      "PATH",
      "Path",
      "PATHEXT",
      "SYSTEMROOT",
      "SystemRoot",
      "TEMP",
      "TMP",
      "LANG",
      "LC_ALL"
    ]) {
      if (process.env[key]) childEnvironment[key] = process.env[key];
    }
    childEnvironment.PYTHONIOENCODING = "utf-8";
    const child = spawnImpl(python, args, {
      cwd: ROOT_DIR,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-20_000);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-20_000);
    });
    child.once("error", (error) => reject(new Error(redactSensitive(error.message))));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            "SEC " + kind + " 가지치기 실패: " + redactSensitive(stderr || stdout)
          )
        );
        return;
      }
      const lastLine = stdout.trim().split(/\r?\n/).at(-1);
      try {
        resolve(lastLine ? JSON.parse(lastLine) : { kind, found: 0 });
      } catch {
        reject(new Error("SEC " + kind + " 가지치기 요약을 읽지 못했습니다."));
      }
    });
  });
}

export async function readPrunedJsonl(file) {
  const records = new Map();
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record?.cik) records.set(String(record.cik).padStart(10, "0"), record.data);
  }
  return records;
}

async function writeJsonAtomic(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp-" + process.pid;
  await writeFile(temporary, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await rename(temporary, file);
}

async function readJsonOptional(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function assertSafeRunDirectory(workRoot, runDirectory) {
  const root = path.resolve(workRoot);
  const run = path.resolve(runDirectory);
  if (run === root || !run.startsWith(root + path.sep)) {
    throw new Error("임시 SEC 작업 디렉터리 범위가 올바르지 않습니다.");
  }
}

function fallbackSubmission(company) {
  return {
    __missing: true,
    cik: company.cik,
    name: company.name,
    tickers: company.tickers,
    exchanges: company.exchanges,
    filings: { recent: {} }
  };
}

export async function syncUsBulk(options = {}) {
  const runtime = getRuntimeConfig();
  const userAgent = options.userAgent || runtime.secUserAgent;
  if (!userAgent) throw new Error("SEC_USER_AGENT가 설정되지 않았습니다.");

  const generatedAt = options.generatedAt || new Date().toISOString();
  const workRoot = path.resolve(
    options.workDir || path.join(tmpdir(), "longview-sec-bulk")
  );
  const runDirectory = path.join(
    workRoot,
    "run-" + generatedAt.replace(/[^0-9A-Za-z]/g, "") + "-" + process.pid
  );
  assertSafeRunDirectory(workRoot, runDirectory);
  await mkdir(runDirectory, { recursive: true });

  const output = path.resolve(
    options.output || path.join(ROOT_DIR, "data", "us-companies.json")
  );
  const diagnosticsFile = path.resolve(
    options.diagnostics || path.join(path.dirname(output), "us-sync-diagnostics.json")
  );
  const progress = options.onProgress || (() => {});
  const sourceMetadata = {};

  try {
    const tickerFile = path.join(runDirectory, "company-tickers-exchange.json");
    progress("SEC 미국 상장사 기준 목록 수집");
    sourceMetadata.tickers = await materializeSource(
      options.tickerSource || SEC_BULK_URLS.tickers,
      tickerFile,
      { userAgent, label: "SEC ticker 파일", retries: options.retries }
    );
    const tickerPayload = JSON.parse(await readFile(tickerFile, "utf8"));
    const universe = normalizeSecTickerUniverse(tickerPayload);
    if (universe.length === 0) {
      throw new Error("SEC ticker 파일에서 대상 거래소 회사를 찾지 못했습니다.");
    }

    const ciksFile = path.join(runDirectory, "target-ciks.json");
    await writeFile(
      ciksFile,
      JSON.stringify({ ciks: universe.map((company) => company.cik) }),
      "utf8"
    );

    const submissionsArchive = path.join(runDirectory, "submissions.zip");
    const submissionsJsonl = path.join(runDirectory, "submissions.jsonl");
    progress("SEC 제출 이력 bulk ZIP 수집·가지치기");
    sourceMetadata.submissions = await materializeSource(
      options.submissionsSource || SEC_BULK_URLS.submissions,
      submissionsArchive,
      { userAgent, label: "SEC submissions ZIP", retries: options.retries }
    );
    await assertZip(submissionsArchive);
    const submissionsPrune = await runPruner({
      python: options.python,
      archive: submissionsArchive,
      ciks: ciksFile,
      output: submissionsJsonl,
      kind: "submissions",
      maxEntryBytes: options.maxEntryBytes
    });
    assertPruneCoverage(
      submissionsPrune,
      universe.length,
      options.minPruneFoundRatio ?? DEFAULT_MIN_PRUNE_FOUND_RATIO
    );
    await rm(submissionsArchive, { force: true });

    const factsArchive = path.join(runDirectory, "companyfacts.zip");
    const factsJsonl = path.join(runDirectory, "companyfacts.jsonl");
    progress("SEC Company Facts bulk ZIP 수집·가지치기");
    sourceMetadata.facts = await materializeSource(
      options.factsSource || SEC_BULK_URLS.facts,
      factsArchive,
      { userAgent, label: "SEC Company Facts ZIP", retries: options.retries }
    );
    await assertZip(factsArchive);
    const factsPrune = await runPruner({
      python: options.python,
      archive: factsArchive,
      ciks: ciksFile,
      output: factsJsonl,
      kind: "facts",
      maxEntryBytes: options.maxEntryBytes
    });
    assertPruneCoverage(
      factsPrune,
      universe.length,
      options.minPruneFoundRatio ?? DEFAULT_MIN_PRUNE_FOUND_RATIO
    );
    await rm(factsArchive, { force: true });

    progress("SEC 미국 전체 회사 정규화·평가");
    const [submissionsByCik, factsByCik] = await Promise.all([
      readPrunedJsonl(submissionsJsonl),
      readPrunedJsonl(factsJsonl)
    ]);
    const normalized = universe.map((company) =>
      normalizeSecCompany(
        company,
        factsByCik.get(company.cik) || null,
        submissionsByCik.get(company.cik) || fallbackSubmission(company),
        { updatedAt: generatedAt }
      )
    );
    const companies = scoreAndRank(normalized, new Date(generatedAt));
    const statusCounts = companies.reduce((counts, company) => {
      const status = company.evaluationStatus || "insufficient_data";
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {});
    const dataset = {
      meta: {
        schemaVersion: 1,
        provider: "SEC EDGAR",
        dataMode: statusCounts.live === companies.length ? "live" : "mixed",
        updatedAt: generatedAt,
        universe: {
          source: SEC_BULK_URLS.tickers,
          exchanges: SEC_LISTED_EXCHANGES,
          companies: companies.length
        },
        sync: {
          status: "ok",
          statusCounts,
          pruned: {
            submissions: submissionsPrune,
            facts: factsPrune
          }
        },
        sources: {
          tickers: { url: SEC_BULK_URLS.tickers, ...sourceMetadata.tickers },
          submissions: {
            url: SEC_BULK_URLS.submissions,
            ...sourceMetadata.submissions
          },
          facts: { url: SEC_BULK_URLS.facts, ...sourceMetadata.facts }
        }
      },
      companies
    };

    const previousSnapshot = await readJsonOptional(output);
    assertValidSnapshot(dataset, {
      label: "SEC US regional snapshot",
      requiredCountries: ["US"],
      allowAdditionalCountries: false,
      requireCoverage: false,
      previousSnapshot,
      snapshotBytes: Buffer.byteLength(JSON.stringify(dataset, null, 2) + "\n", "utf8"),
      ...(options.validatorOptions || {})
    });
    await writeJsonAtomic(output, dataset);
    await writeJsonAtomic(diagnosticsFile, {
      status: "ok",
      updatedAt: generatedAt,
      companyCount: companies.length,
      statusCounts,
      pruned: dataset.meta.sync.pruned
    });
    progress("SEC 미국 전체 동기화 완료: " + companies.length + "개 회사");
    return dataset;
  } finally {
    if (!options.keepWorkDir) {
      assertSafeRunDirectory(workRoot, runDirectory);
      await rm(runDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function parseArgs(argv) {
  const options = {};
  const valueOptions = new Map([
    ["--output", "output"],
    ["--diagnostics", "diagnostics"],
    ["--work-dir", "workDir"],
    ["--ticker-source", "tickerSource"],
    ["--facts-source", "factsSource"],
    ["--submissions-source", "submissionsSource"],
    ["--python", "python"],
    ["--retries", "retries"],
    ["--max-entry-bytes", "maxEntryBytes"]
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--keep-work-dir") {
      options.keepWorkDir = true;
      continue;
    }
    const property = valueOptions.get(key);
    if (!property || index + 1 >= argv.length) {
      throw new Error("알 수 없거나 값이 없는 인자: " + key);
    }
    options[property] = argv[index + 1];
    index += 1;
  }

  options.retries = parseInteger(options.retries, 3);
  options.maxEntryBytes = parseInteger(options.maxEntryBytes, 128 * 1024 * 1024);
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    await syncUsBulk({
      ...options,
      onProgress: (message) =>
        console.log("[" + new Date().toISOString() + "] " + message)
    });
  } catch (error) {
    const message = redactSensitive(error instanceof Error ? error.message : error);
    const diagnostics = path.resolve(
      options?.diagnostics ||
        path.join(
          path.dirname(options?.output || path.join(ROOT_DIR, "data", "us-companies.json")),
          "us-sync-diagnostics.json"
        )
    );
    await writeJsonAtomic(diagnostics, {
      status: "failed",
      failedAt: new Date().toISOString(),
      message
    }).catch(() => {});
    console.error("SEC 미국 bulk 동기화 실패:", message);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
