import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  validateAwsArtifactManifest,
  validateAwsArtifactPair
} from "../lib/aws-artifacts.mjs";
import {
  refreshRemoteArtifactBundle,
  writePairAtomically
} from "../lib/remote-artifact-bundle.mjs";

const ROOT = path.resolve(".");
const [companiesText, selectionText] = await Promise.all([
  readFile(path.join(ROOT, "data", "companies.json"), "utf8"),
  readFile(path.join(ROOT, "data", "trading-selection.json"), "utf8")
]);
const pair = validateAwsArtifactPair({ companiesText, selectionText });
const base = `revisions/${pair.revision}`;

function descriptor(key, text) {
  return {
    key,
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text, "utf8"),
    contentType: "application/json"
  };
}

const pairHashes = {
  companies: createHash("sha256").update(companiesText).digest("hex"),
  selection: createHash("sha256").update(selectionText).digest("hex")
};

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: pair.revision,
    sourceUpdatedAt: pair.snapshot.meta.updatedAt,
    selectionGeneratedAt: pair.selection.generatedAt,
    publishedAt: "2026-07-24T12:00:00.000Z",
    artifacts: {
      companies: descriptor(`${base}/companies.json`, companiesText),
      selection: descriptor(
        `${base}/trading-selection-${pairHashes.selection}.json`,
        selectionText
      )
    },
    ...overrides
  };
}

function response(text) {
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text, "utf8"))
    }
  });
}

test("manifest는 snapshot revision의 immutable 두 경로만 허용한다", () => {
  assert.equal(validateAwsArtifactManifest(manifest()).revision, pair.revision);
  for (const key of [
    "latest/companies.json",
    `revisions/${pair.revision}/other.json`,
    `revisions/${"0".repeat(20)}/companies.json`
  ]) {
    const value = manifest();
    value.artifacts.companies.key = key;
    assert.throws(
      () => validateAwsArtifactManifest(value),
      { code: "AWS_ARTIFACT_MANIFEST_INVALID" }
    );
  }
  for (const key of [
    `${base}/trading-selection.json`,
    `${base}/trading-selection-${"0".repeat(64)}.json`,
    `revisions/${"0".repeat(20)}/trading-selection-${pairHashes.selection}.json`
  ]) {
    const value = manifest();
    value.artifacts.selection.key = key;
    assert.throws(
      () => validateAwsArtifactManifest(value),
      { code: "AWS_ARTIFACT_MANIFEST_INVALID" }
    );
  }
});

test("CloudFront manifest의 두 checksum과 revision이 모두 맞아야 runtime pair를 교체한다", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "longview-remote-pair-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeDataFile = path.join(directory, "companies.json");
  const runtimeInvestmentSelectionFile = path.join(
    directory,
    "trading-selection.json"
  );
  const manifestUrl = new URL(
    "https://example.cloudfront.net/latest/manifest.json"
  );
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/latest/manifest.json") {
      return response(JSON.stringify(manifest()));
    }
    if (pathname === `/${base}/companies.json`) {
      return response(companiesText);
    }
    if (
      pathname ===
      `/${base}/trading-selection-${pairHashes.selection}.json`
    ) {
      return response(selectionText);
    }
    return new Response("", { status: 404 });
  };

  const result = await refreshRemoteArtifactBundle(
    {
      remoteArtifactManifestUrl: manifestUrl.toString(),
      remoteSnapshotToken: "",
      runtimeDataFile,
      runtimeInvestmentSelectionFile
    },
    { fetchImpl }
  );

  assert.equal(result.success, true);
  assert.equal(result.revision, pair.revision);
  assert.equal(await readFile(runtimeDataFile, "utf8"), companiesText);
  assert.equal(
    await readFile(runtimeInvestmentSelectionFile, "utf8"),
    selectionText
  );
});

test("GitHub raw 하위경로 manifest는 같은 저장소·ref 경로에서 artifact를 읽는다", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "longview-raw-pair-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeDataFile = path.join(directory, "companies.json");
  const runtimeInvestmentSelectionFile = path.join(
    directory,
    "trading-selection.json"
  );
  const requested = [];
  const prefix = "/example/longview/main/aws-artifacts";
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    requested.push(pathname);
    if (pathname === `${prefix}/latest/manifest.json`) {
      return response(JSON.stringify(manifest()));
    }
    if (pathname === `${prefix}/${base}/companies.json`) {
      return response(companiesText);
    }
    if (
      pathname ===
      `${prefix}/${base}/trading-selection-${pairHashes.selection}.json`
    ) {
      return response(selectionText);
    }
    return new Response("", { status: 404 });
  };

  const result = await refreshRemoteArtifactBundle(
    {
      remoteArtifactManifestUrl:
        `https://raw.githubusercontent.com${prefix}/latest/manifest.json`,
      remoteSnapshotToken: "",
      runtimeDataFile,
      runtimeInvestmentSelectionFile
    },
    { fetchImpl }
  );

  assert.equal(result.success, true);
  assert.deepEqual(requested, [
    `${prefix}/latest/manifest.json`,
    `${prefix}/${base}/companies.json`,
    `${prefix}/${base}/trading-selection-${pairHashes.selection}.json`
  ]);
});

test("CloudFront에는 남아 있는 GitHub token을 보내지 않고 시작 전에 차단한다", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "longview-token-boundary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sensitive = "legacy-github-token-must-not-leak";
  let requestCount = 0;
  const result = await refreshRemoteArtifactBundle(
    {
      remoteArtifactManifestUrl:
        "https://example.cloudfront.net/latest/manifest.json",
      remoteSnapshotToken: sensitive,
      runtimeDataFile: path.join(directory, "companies.json"),
      runtimeInvestmentSelectionFile: path.join(
        directory,
        "trading-selection.json"
      )
    },
    {
      fetchImpl: async () => {
        requestCount += 1;
        return new Response("", { status: 500 });
      }
    }
  );

  assert.equal(result.success, false);
  assert.equal(requestCount, 0);
  assert.match(result.error, /REMOTE_SNAPSHOT_TOKEN을 제거/);
  assert.doesNotMatch(result.error, new RegExp(sensitive));
});

test("두 번째 rename 실패는 첫 파일을 이전 정상본으로 rollback한다", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "longview-pair-rollback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeDataFile = path.join(directory, "companies.json");
  const runtimeInvestmentSelectionFile = path.join(
    directory,
    "trading-selection.json"
  );
  await Promise.all([
    writeFile(runtimeDataFile, "previous-companies", "utf8"),
    writeFile(runtimeInvestmentSelectionFile, "previous-selection", "utf8")
  ]);
  let renameCount = 0;

  await assert.rejects(
    writePairAtomically(
      {
        companiesFile: runtimeDataFile,
        selectionFile: runtimeInvestmentSelectionFile,
        companiesText: "next-companies",
        selectionText: "next-selection"
      },
      {
        renameImpl: async (source, destination) => {
          renameCount += 1;
          if (renameCount === 2) {
            throw new Error("simulated second rename failure");
          }
          await rename(source, destination);
        }
      }
    ),
    /simulated second rename failure/
  );

  assert.equal(await readFile(runtimeDataFile, "utf8"), "previous-companies");
  assert.equal(
    await readFile(runtimeInvestmentSelectionFile, "utf8"),
    "previous-selection"
  );
  assert.deepEqual(
    (await readdir(directory)).sort(),
    ["companies.json", "trading-selection.json"]
  );
});

test("checksum 불일치나 손상된 기존 runtime은 마지막 정상 pair를 부분 교체하지 않는다", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "longview-remote-fail-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeDataFile = path.join(directory, "companies.json");
  const runtimeInvestmentSelectionFile = path.join(
    directory,
    "trading-selection.json"
  );
  const broken = manifest();
  broken.artifacts.selection.sha256 = "0".repeat(64);
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/latest/manifest.json") {
      return response(JSON.stringify(broken));
    }
    if (pathname.endsWith("/companies.json")) return response(companiesText);
    return response(selectionText);
  };

  const result = await refreshRemoteArtifactBundle(
    {
      remoteArtifactManifestUrl:
        "https://example.cloudfront.net/latest/manifest.json",
      remoteSnapshotToken: "",
      runtimeDataFile,
      runtimeInvestmentSelectionFile
    },
    { fetchImpl }
  );

  assert.equal(result.success, false);
  await assert.rejects(readFile(runtimeDataFile, "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(runtimeInvestmentSelectionFile, "utf8"), {
    code: "ENOENT"
  });
});
