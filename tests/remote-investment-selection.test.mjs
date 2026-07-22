import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildInvestmentSelection } from "../lib/investment-selection.mjs";
import {
  deriveRemoteInvestmentSelectionUrl,
  prepareRuntimeInvestmentSelection,
  refreshRemoteInvestmentSelection
} from "../lib/remote-investment-selection.mjs";

const GENERATED_AT = "2026-07-21T00:00:00.000Z";

function company(id, price, sector) {
  return {
    id,
    ticker: id.slice(3),
    name: `회사 ${id}`,
    country: "KR",
    exchange: "KOSPI",
    sector,
    dataMode: "live",
    stale: false,
    marketData: {
      status: "ok",
      freshness: "current",
      currency: "KRW",
      asOf: "2026-07-20",
      price,
      marketCap: 300_000_000_000,
      turnover: 2_000_000_000
    },
    score: {
      total: 90,
      dataConfidence: 95,
      completeness: 95,
      valuationConfidence: 90,
      evaluationReady: true,
      candidate: { eligible: true },
      components: {
        valuation: { score: 85 },
        longGrowth: { score: 88 }
      }
    }
  };
}

function artifact(revision, generatedAt = GENERATED_AT) {
  return buildInvestmentSelection({
    companies: [
      company("KR-000001", 8_000, "업종-A"),
      company("KR-000002", 10_000, "업종-B"),
      company("KR-000003", 20_000, "업종-C")
    ],
    sourceRevision: revision,
    sourceUpdatedAt: "2026-07-20T10:00:00.000Z",
    modelVersion: "2.0.0",
    generatedAt
  });
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "longview-selection-"));
  return {
    root,
    config: {
      investmentSelectionFile: path.join(root, "tracked.json"),
      runtimeInvestmentSelectionFile: path.join(root, "runtime.json"),
      remoteInvestmentSelectionUrl:
        "https://raw.githubusercontent.com/example/longview/main/data/trading-selection.json",
      remoteSnapshotToken: ""
    }
  };
}

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

test("회사 스냅샷 URL에서 같은 revision의 투자선정 URL만 유도한다", () => {
  assert.equal(
    deriveRemoteInvestmentSelectionUrl(
      "https://raw.githubusercontent.com/example/longview/main/data/companies.json"
    ),
    "https://raw.githubusercontent.com/example/longview/main/data/trading-selection.json"
  );
  assert.equal(deriveRemoteInvestmentSelectionUrl(""), "");
  assert.throws(
    () =>
      deriveRemoteInvestmentSelectionUrl(
        "https://example.com/example/longview/main/data/companies.json"
      ),
    /raw\.githubusercontent\.com/
  );
  assert.throws(
    () =>
      deriveRemoteInvestmentSelectionUrl(
        "https://raw.githubusercontent.com/example/longview/main/data/other.json"
      ),
    /data\/companies\.json/
  );
  assert.throws(
    () =>
      deriveRemoteInvestmentSelectionUrl(
        "https://raw.githubusercontent.com/example/longview/main/data/companies.json?token=leak"
      ),
    /raw\.githubusercontent\.com/
  );
});

test("런타임 준비는 유효한 추적 산출물을 정규화해 로컬 캐시에 복사한다", async () => {
  const { root, config } = await fixture();
  try {
    const tracked = artifact("local-revision");
    await writeFile(config.investmentSelectionFile, JSON.stringify(tracked, null, 2), "utf8");

    const result = await prepareRuntimeInvestmentSelection(config);

    assert.equal(result.source, "local");
    assert.equal(result.file, config.runtimeInvestmentSelectionFile);
    assert.equal(result.artifact.sourceRevision, "local-revision");
    const saved = JSON.parse(await readFile(config.runtimeInvestmentSelectionFile, "utf8"));
    assert.deepEqual(saved, tracked);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("유효한 원격 선정은 예상 회사 revision과 일치할 때만 runtime에 반영한다", async () => {
  const { root, config } = await fixture();
  try {
    const remote = artifact("snapshot-revision-7");
    let received;
    const result = await refreshRemoteInvestmentSelection(
      { ...config, remoteSnapshotToken: "selection-test-token" },
      {
        expectedRevision: "snapshot-revision-7",
        fetchImpl: async (url, options) => {
          received = { url: url.toString(), options };
          return jsonResponse(remote);
        }
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.sourceRevision, "snapshot-revision-7");
    assert.equal(received.url, config.remoteInvestmentSelectionUrl);
    assert.equal(received.options.method, "GET");
    assert.equal(received.options.redirect, "error");
    assert.equal(received.options.headers.Authorization, "Bearer selection-test-token");
    const saved = JSON.parse(await readFile(config.runtimeInvestmentSelectionFile, "utf8"));
    assert.deepEqual(saved, remote);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("원격 선정 revision이 회사 스냅샷과 다르면 기존 runtime을 보존한다", async () => {
  const { root, config } = await fixture();
  try {
    const current = artifact("current-revision", "2026-07-20T00:00:00.000Z");
    await writeFile(config.runtimeInvestmentSelectionFile, JSON.stringify(current), "utf8");
    const before = await readFile(config.runtimeInvestmentSelectionFile, "utf8");

    const result = await refreshRemoteInvestmentSelection(config, {
      expectedRevision: "expected-revision",
      fetchImpl: async () => jsonResponse(artifact("unexpected-revision"))
    });

    assert.equal(result.success, false);
    assert.match(result.error, /revision/);
    assert.equal(await readFile(config.runtimeInvestmentSelectionFile, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("과대 응답은 저장하지 않고 fetch 오류에 포함된 인증 토큰은 가린다", async (t) => {
  await t.test("content-length 제한", async () => {
    const { root, config } = await fixture();
    try {
      const result = await refreshRemoteInvestmentSelection(config, {
        fetchImpl: async () =>
          jsonResponse({}, { headers: { "content-length": String(5 * 1024 * 1024 + 1) } })
      });
      assert.equal(result.success, false);
      assert.match(result.error, /허용 크기/);
      await assert.rejects(readFile(config.runtimeInvestmentSelectionFile, "utf8"), {
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("토큰 redaction", async () => {
    const { root, config } = await fixture();
    const token = "very-private-github-token";
    try {
      const result = await refreshRemoteInvestmentSelection(
        { ...config, remoteSnapshotToken: token },
        {
          fetchImpl: async () => {
            throw new Error(`authorization: Bearer ${token}`);
          }
        }
      );
      assert.equal(result.success, false);
      assert.equal(result.error.includes(token), false);
      assert.match(result.error, /\[redacted\]/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
