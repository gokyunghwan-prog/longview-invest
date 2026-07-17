import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertPruneCoverage,
  downloadToFile,
  syncUsBulk
} from "../scripts/sync-us-bulk.mjs";

test("SEC prune coverage guard rejects a severely truncated archive", () => {
  assert.throws(
    () => assertPruneCoverage({ kind: "facts", requested: 100, found: 12 }, 100),
    /coverage is too low/
  );
  assert.doesNotThrow(() =>
    assertPruneCoverage({ kind: "facts", requested: 100, found: 80 }, 100)
  );
});

test("SEC bulk 다운로드는 선언된 User-Agent를 보내되 결과·오류에 노출하지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "longview-sec-test-"));
  const destination = path.join(directory, "fixture.zip");
  const userAgent = "Longview Screener private-contact@example.com";
  let receivedUserAgent = null;
  const fetchImpl = async (_url, options) => {
    receivedUserAgent = options.headers["User-Agent"];
    return new Response(Buffer.from("PK\u0003\u0004fixture"), {
      status: 200,
      headers: {
        etag: "fixture-etag",
        "content-length": "11"
      }
    });
  };

  try {
    const metadata = await downloadToFile("https://www.sec.gov/example.zip", destination, {
      userAgent,
      fetchImpl,
      retries: 0
    });
    assert.equal(receivedUserAgent, userAgent);
    assert.equal((await readFile(destination)).subarray(0, 2).toString("ascii"), "PK");
    assert.equal(metadata.etag, "fixture-etag");
    assert.equal(JSON.stringify(metadata).includes("private-contact"), false);

    const deniedFetch = async () =>
      new Response("denied", { status: 403, statusText: userAgent });
    await assert.rejects(
      downloadToFile("https://www.sec.gov/denied.zip", destination + ".denied", {
        userAgent,
        fetchImpl: deniedFetch,
        retries: 0
      }),
      (error) => {
        assert.equal(error.message.includes("private-contact"), false);
        assert.match(error.message, /HTTP 403/);
        return true;
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("로컬 SEC bulk 전체 흐름은 선택 CIK만 평가하고 누락 회사도 보존한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "longview-sec-integration-"));
  const tickerFile = path.join(directory, "tickers.json");
  const factsSource = path.join(directory, "fact-source.json");
  const submissionsSource = path.join(directory, "submission-source.json");
  const factsZip = path.join(directory, "companyfacts.zip");
  const submissionsZip = path.join(directory, "submissions.zip");
  const output = path.join(directory, "us-companies.json");
  const diagnostics = path.join(directory, "diagnostics.json");
  const workDir = path.join(directory, "work");
  const python = process.env.PYTHON || "python";
  const annual = (year, value, tag = "") => ({
    start: `${year}-01-01`,
    end: `${year}-12-31`,
    val: value,
    accn: `0000000123-${String(year + 1).slice(-2)}-000001${tag}`,
    fy: year,
    fp: "FY",
    form: "10-K",
    filed: `${year + 1}-02-01`
  });

  try {
    await writeFile(
      tickerFile,
      JSON.stringify({
        fields: ["cik", "name", "ticker", "exchange"],
        data: [
          [123, "Complete Corp", "CMP", "Nasdaq"],
          [123, "Complete Corp", "CMP.A", "NYSE"],
          [456, "Sparse Corp", "SPRS", "NYSE"],
          [789, "Ignored OTC", "IGN", "OTC"]
        ]
      }),
      "utf8"
    );
    await writeFile(
      factsSource,
      JSON.stringify({
        cik: 123,
        entityName: "Complete Corp",
        facts: {
          "us-gaap": {
            Revenues: {
              units: { USD: [annual(2024, 100), annual(2025, 120)] }
            },
            NetIncomeLoss: {
              units: { USD: [annual(2024, 10), annual(2025, 12, "n")] }
            }
          }
        }
      }),
      "utf8"
    );
    await writeFile(
      submissionsSource,
      JSON.stringify({
        cik: "0000000123",
        entityType: "operating",
        sic: "3571",
        sicDescription: "Electronic Computers",
        name: "Complete Corp",
        tickers: ["CMP", "CMP.A"],
        exchanges: ["Nasdaq", "NYSE"],
        filings: {
          recent: {
            accessionNumber: ["0000000123-26-000001"],
            filingDate: ["2026-02-01"],
            reportDate: ["2025-12-31"],
            form: ["10-K"],
            primaryDocument: ["complete-2025.htm"]
          }
        }
      }),
      "utf8"
    );

    const zipScript = [
      "import sys, zipfile",
      "with zipfile.ZipFile(sys.argv[1], 'w') as z: z.write(sys.argv[2], 'CIK0000000123.json')",
      "with zipfile.ZipFile(sys.argv[3], 'w') as z: z.write(sys.argv[4], 'CIK0000000123.json')"
    ].join("\n");
    const zipped = spawnSync(
      python,
      ["-c", zipScript, factsZip, factsSource, submissionsZip, submissionsSource],
      { encoding: "utf8" }
    );
    assert.equal(zipped.status, 0, zipped.stderr);

    const baseOptions = {
      userAgent: "Longview Integration contact@example.com",
      tickerSource: tickerFile,
      factsSource: factsZip,
      submissionsSource: submissionsZip,
      output,
      diagnostics,
      workDir,
      python,
      generatedAt: "2026-07-17T00:00:00.000Z"
    };
    const previousOutput = { sentinel: "last-known-good" };
    await writeFile(output, JSON.stringify(previousOutput), "utf8");
    await assert.rejects(syncUsBulk(baseOptions), /coverage is too low/);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), previousOutput);

    const dataset = await syncUsBulk({
      ...baseOptions,
      minPruneFoundRatio: 0.5,
      validatorOptions: { minimumCounts: { US: 1 } }
    });

    assert.equal(dataset.companies.length, 2);
    const complete = dataset.companies.find((company) => company.providerId === "0000000123");
    const sparse = dataset.companies.find((company) => company.providerId === "0000000456");
    assert.equal(complete.dataMode, "live");
    assert.deepEqual(complete.tickers, ["CMP", "CMP.A"]);
    assert.equal(sparse.dataMode, "insufficient_data");
    assert.equal(dataset.companies.some((company) => company.ticker === "IGN"), false);
    assert.equal((await readFile(output, "utf8")).includes("contact@example.com"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
