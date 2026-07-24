import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getRuntimeConfig } from "./lib/config.mjs";
import {
  CompanyQueryError,
  createCompanyStore,
  parseCompanyQuery
} from "./lib/company-store.mjs";
import { validatePublicInvestmentSelection } from "./lib/investment-selection.mjs";
import {
  prepareRuntimeInvestmentSelection,
  refreshRemoteInvestmentSelection
} from "./lib/remote-investment-selection.mjs";
import { SCORING_MODEL_VERSION, getScoringModel } from "./lib/scoring.mjs";
import {
  prepareRuntimeSnapshot,
  refreshRemoteFullSnapshot
} from "./lib/remote-snapshot.mjs";
import { refreshRemoteArtifactBundle } from "./lib/remote-artifact-bundle.mjs";
import { syncAll } from "./lib/sync.mjs";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};
const DATA_CACHE = "public, max-age=60, stale-while-revalidate=300";

function securityHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  };
}

function representationEtag(revision, variant) {
  const suffix = createHash("sha256").update(variant).digest("hex").slice(0, 12);
  return 'W/"' + revision + "-" + suffix + '"';
}

function requestHasEtag(request, etag) {
  const value = request.headers["if-none-match"];
  if (!value) return false;
  return value === "*" || value.split(",").some((candidate) => candidate.trim() === etag);
}

function sendJson(
  request,
  response,
  status,
  body,
  { cacheControl = "no-store", etag = null } = {}
) {
  const headers = {
    ...securityHeaders("application/json; charset=utf-8"),
    "Cache-Control": cacheControl,
    ...(etag ? { ETag: etag } : {})
  };
  if (etag && status >= 200 && status < 300 && requestHasEtag(request, etag)) {
    response.writeHead(304, headers);
    response.end();
    return;
  }

  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...headers,
    "Content-Length": Buffer.byteLength(payload)
  });
  if (request.method === "HEAD") response.end();
  else response.end(payload);
}

async function serveStatic(config, request, response, pathname) {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const publicRoot = path.resolve(config.publicDir);
  const filePath = path.resolve(publicRoot, requested);

  if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) {
    sendJson(request, response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";
    const content = await readFile(filePath);
    response.writeHead(200, {
      ...securityHeaders(contentType),
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=300"
    });
    if (request.method === "HEAD") response.end();
    else response.end(content);
  } catch {
    sendJson(request, response, 404, { error: "Not found" });
  }
}

function kstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function safeRuntimeMessage(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, "[REDACTED]");
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 1_000);
}

export async function createLongviewApp(
  config = getRuntimeConfig(),
  {
    companyStore = null,
    storeOptions = undefined,
    syncRunner = syncAll,
    runtimeSnapshotPreparer = prepareRuntimeSnapshot,
    remoteSnapshotRefresher = refreshRemoteFullSnapshot,
    runtimeSelectionPreparer = prepareRuntimeInvestmentSelection,
    remoteSelectionRefresher = refreshRemoteInvestmentSelection,
    remoteBundleRefresher = refreshRemoteArtifactBundle
  } = {}
) {
  const remoteMode = Boolean(
    (config.remoteSnapshotUrl || config.remoteArtifactManifestUrl) &&
    !companyStore
  );
  const remoteBundleMode = Boolean(config.remoteArtifactManifestUrl && !companyStore);
  const preparedRuntime = remoteMode
    ? await runtimeSnapshotPreparer(config)
    : null;
  const store = companyStore ||
    (await createCompanyStore(preparedRuntime?.dataFile || config.dataFile, storeOptions));
  const preparedSelection =
    remoteMode && (config.remoteInvestmentSelectionUrl || remoteBundleMode)
      ? await runtimeSelectionPreparer(config)
      : null;
  const investmentSelectionFile = preparedSelection?.file ||
    config.investmentSelectionFile ||
    path.join(path.dirname(config.dataFile), "trading-selection.json");
  let activeSync = null;
  let activeRemoteRefresh = null;
  let lastScheduledDate = null;
  let scheduleTimer = null;
  let remoteRefreshTimer = null;
  let remoteEtag = preparedRuntime?.etag || null;
  const remoteSnapshotStatus = {
    enabled: remoteMode,
    status: remoteMode ? "ready" : "disabled",
    source: preparedRuntime?.source || (remoteMode ? "local" : null),
    lastAttemptAt: null,
    lastSuccessAt: null,
    sourceUpdatedAt: null,
    error: null
  };

  async function refreshStore() {
    const currentRemoteRefresh = activeRemoteRefresh;
    if (currentRemoteRefresh) await currentRemoteRefresh;
    await store.refreshIfChanged();
  }

  async function refreshRemoteStore({ throwOnFailure = false } = {}) {
    if (!remoteMode) {
      return { attempted: false, success: false, changed: false };
    }
    if (activeRemoteRefresh) return activeRemoteRefresh;

    activeRemoteRefresh = (async () => {
      remoteSnapshotStatus.lastAttemptAt = new Date().toISOString();
      remoteSnapshotStatus.status = "refreshing";
      try {
        const result = remoteBundleMode
          ? await remoteBundleRefresher(config)
          : await remoteSnapshotRefresher(config, {
              etag: remoteEtag,
              onProgress: (message) =>
                console.log("[" + new Date().toISOString() + "] " + message)
            });
        if (!result?.success) {
          throw new Error(result?.error || "최신 snapshot을 받지 못했습니다.");
        }
        if (result.etag) remoteEtag = result.etag;
        if (result.changed) await store.reload();
        if (!remoteBundleMode && config.remoteInvestmentSelectionUrl) {
          const selectionResult = await remoteSelectionRefresher(config, {
            expectedRevision: store.getStatus().revision
          });
          if (!selectionResult?.success) {
            throw new Error(
              selectionResult?.error || "최신 투자선정 파일을 받지 못했습니다."
            );
          }
        }
        remoteSnapshotStatus.status = "ok";
        remoteSnapshotStatus.source = "remote";
        remoteSnapshotStatus.lastSuccessAt = new Date().toISOString();
        remoteSnapshotStatus.sourceUpdatedAt =
          result.updatedAt || remoteSnapshotStatus.sourceUpdatedAt;
        remoteSnapshotStatus.error = null;
        return result;
      } catch (error) {
        const message = safeRuntimeMessage(error, [config.remoteSnapshotToken]);
        remoteSnapshotStatus.status = "stale";
        remoteSnapshotStatus.error = message;
        if (throwOnFailure) throw new Error(message);
        console.error("최신 snapshot 확인 실패, 마지막 정상 데이터 유지:", message);
        return { attempted: true, success: false, changed: false, error: message };
      }
    })().finally(() => {
      activeRemoteRefresh = null;
    });
    return activeRemoteRefresh;
  }

  async function startSync() {
    if (activeSync) return activeSync;
    if (remoteMode) {
      activeSync = (async () => {
        const result = await refreshRemoteStore();
        if (!result.success) {
          throw new Error(result.error || "최신 snapshot을 받지 못했습니다.");
        }
        return result;
      })().finally(() => {
        activeSync = null;
      });
      return activeSync;
    }
    activeSync = (async () => {
      try {
        return await syncRunner(config, {
          onProgress: (message) =>
            console.log("[" + new Date().toISOString() + "] " + message)
        });
      } finally {
        try {
          await store.reload();
        } catch (error) {
          console.error("동기화 후 데이터 다시 읽기 실패:", error.message);
        }
      }
    })().finally(() => {
      activeSync = null;
    });
    return activeSync;
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url, "http://" + (request.headers.host || "localhost"));
    const readMethod = request.method === "GET" || request.method === "HEAD";

    if (readMethod && url.pathname === "/api/overview") {
      await refreshStore();
      const overview = store.getOverview();
      sendJson(request, response, 200, overview, {
        cacheControl: DATA_CACHE,
        etag: representationEtag(overview.revision, "overview")
      });
      return;
    }

    if (readMethod && url.pathname === "/api/investment-selection") {
      await refreshStore();
      try {
        const artifact = validatePublicInvestmentSelection(
          JSON.parse(await readFile(investmentSelectionFile, "utf8"))
        );
        const currentRevision = store.getStatus().revision;
        if (artifact.sourceRevision !== currentRevision) {
          sendJson(request, response, 409, {
            code: "INVESTMENT_SELECTION_REVISION_MISMATCH",
            error: "최신 기업 데이터와 자동투자 선정 기준일이 달라 표시를 보류합니다."
          });
          return;
        }
        sendJson(request, response, 200, artifact, {
          cacheControl: DATA_CACHE,
          etag: representationEtag(
            artifact.sourceRevision,
            "investment-selection:" + artifact.policyHash + ":" + artifact.generatedAt
          )
        });
      } catch {
        sendJson(request, response, 503, {
          code: "INVESTMENT_SELECTION_UNAVAILABLE",
          error: "검증된 자동투자 선정 산출물을 불러올 수 없습니다."
        });
      }
      return;
    }

    if (readMethod && url.pathname === "/api/companies") {
      try {
        const query = parseCompanyQuery(url.searchParams);
        await refreshStore();
        const result = store.list(query);
        const variant = JSON.stringify([
          query.normalizedQuery,
          query.sector,
          query.sort,
          query.candidateOnly,
          query.page,
          query.pageSize
        ]);
        sendJson(request, response, 200, result, {
          cacheControl: DATA_CACHE,
          etag: representationEtag(result.revision, "companies:" + variant)
        });
      } catch (error) {
        if (error instanceof CompanyQueryError) {
          sendJson(request, response, 400, { error: error.message });
        } else {
          sendJson(request, response, 500, {
            error: "회사 데이터를 읽지 못했습니다.",
            detail: error.message
          });
        }
      }
      return;
    }

    const detailMatch = url.pathname.match(/^\/api\/companies\/([^/]+)$/);
    if (readMethod && detailMatch) {
      let companyId;
      try {
        companyId = decodeURIComponent(detailMatch[1]);
      } catch {
        sendJson(request, response, 400, { error: "회사 ID 형식이 올바르지 않습니다." });
        return;
      }
      await refreshStore();
      const company = store.getCompany(companyId);
      if (!company) {
        sendJson(request, response, 404, { error: "회사를 찾지 못했습니다." });
        return;
      }
      const revision = store.getStatus().revision;
      sendJson(request, response, 200, company, {
        cacheControl: DATA_CACHE,
        etag: representationEtag(revision, "company:" + companyId)
      });
      return;
    }

    if (readMethod && url.pathname === "/api/methodology") {
      const modelVersion = SCORING_MODEL_VERSION;
      sendJson(
        request,
        response,
        200,
        {
          modelVersion,
          name: "가치·장기성장 분석 모델 v2",
          groups: getScoringModel(),
          valuationIncluded: true,
          valuationRequiredForRanking: true,
          valuationDisplayed: true,
          candidateRules: {
            minimumTotal: 75,
            minimumDataConfidence: 80,
            minimumCompleteness: 80,
            minimumHistoryYears: 3,
            minimumValuationConfidence: 60,
            componentMinimums: {
              valuation: 60,
              longGrowth: 55,
              quality: 55,
              safety: 45
            },
            minimumAnnualRoeWhenAvailable: 5,
            minimumRevenueStabilityWhenAvailable: 40,
            requiresLiveDisclosure: true,
            requiresNoCriticalFlags: true,
            excludesValueTrapSignals: true
          },
          rankingOrder: [
            "candidateEligibility",
            "evaluationReadiness",
            "totalScore",
            "dataConfidence"
          ],
          note:
            "검증된 PER·PBR·PSR·FCF 수익률은 저평가 영역에 반영합니다. 가치지표가 부족하면 임의 점수 대신 가치 순위 평가를 보류하며, 재무 이력은 미래 수익을 보장하지 않습니다."
        },
        {
          cacheControl: "public, max-age=86400",
          etag: representationEtag(modelVersion, "methodology")
        }
      );
      return;
    }

    if (readMethod && url.pathname === "/api/health") {
      await refreshStore();
      sendJson(request, response, 200, {
        status: "ok",
        syncing: Boolean(activeSync || activeRemoteRefresh),
        scheduler: Boolean(config.schedulerEnabled),
        schedulerMode: remoteMode ? "remote_snapshot" : "local_sync",
        remoteSnapshot: { ...remoteSnapshotStatus },
        ...store.getStatus()
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/sync") {
      if (!config.syncToken) {
        sendJson(request, response, 404, { error: "수동 동기화 API가 비활성화되어 있습니다." });
        return;
      }
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (token !== config.syncToken) {
        sendJson(request, response, 401, { error: "인증에 실패했습니다." });
        return;
      }
      try {
        await startSync();
        const overview = store.getOverview();
        sendJson(request, response, 200, {
          ok: true,
          revision: overview.revision,
          meta: overview.meta
        });
      } catch (error) {
        sendJson(request, response, 502, {
          error: "동기화에 실패했습니다.",
          detail: error.message
        });
      }
      return;
    }

    if (readMethod) {
      await serveStatic(config, request, response, url.pathname);
      return;
    }

    sendJson(request, response, 405, { error: "Method not allowed" });
  }

  async function checkSchedule() {
    if (!config.schedulerEnabled || activeSync) return;
    const parts = kstParts();
    const dateKey = parts.year + "-" + parts.month + "-" + parts.day;
    if (Number(parts.hour) !== config.scheduleHourKst || lastScheduledDate === dateKey) return;
    lastScheduledDate = dateKey;
    try {
      await startSync();
    } catch (error) {
      console.error("예약 동기화 실패:", error.message);
    }
  }

  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error("요청 처리 오류:", error);
      if (!response.headersSent) {
        sendJson(request, response, 500, { error: "Internal server error" });
      } else {
        response.end();
      }
    });
  });

  async function listen({ port = config.port, host = config.host } = {}) {
    if (remoteMode && config.remoteStartupRefreshRequired) {
      await refreshRemoteStore({ throwOnFailure: true });
    }
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    if (!scheduleTimer) {
      scheduleTimer = setInterval(checkSchedule, 5 * 60 * 1000);
      scheduleTimer.unref();
    }
    if (remoteMode && !remoteRefreshTimer) {
      const refreshIntervalMs = Math.max(
        60_000,
        Number(config.remoteSnapshotRefreshMs) || 30 * 60 * 1000
      );
      remoteRefreshTimer = setInterval(() => {
        void refreshRemoteStore();
      }, refreshIntervalMs);
      remoteRefreshTimer.unref();
      if (!config.remoteStartupRefreshRequired) void refreshRemoteStore();
    }
    return server.address();
  }

  async function close() {
    if (scheduleTimer) {
      clearInterval(scheduleTimer);
      scheduleTimer = null;
    }
    if (remoteRefreshTimer) {
      clearInterval(remoteRefreshTimer);
      remoteRefreshTimer = null;
    }
    if (!server.listening) return;
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  return {
    server,
    store,
    startSync,
    refreshRemoteSnapshot: refreshRemoteStore,
    handleRequest,
    listen,
    close
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const config = getRuntimeConfig();
  const app = await createLongviewApp(config);
  await app.listen();
  console.log(
    "Longview 서버: http://" + config.host + ":" + config.port +
      (config.remoteSnapshotUrl
        ? " · 원격 최신 snapshot 시작 즉시·30분마다 자동 확인"
        : config.remoteArtifactManifestUrl
        ? " · AWS 검증 artifact 시작 즉시·30분마다 자동 확인"
        : config.schedulerEnabled
        ? " · 매일 " + config.scheduleHourKst + "시(KST) 자동 갱신"
        : " · 서버 스케줄러 꺼짐")
  );

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      app.close().finally(() => process.exit(0));
    });
  }
}
