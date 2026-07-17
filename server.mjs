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
import { getScoringModel } from "./lib/scoring.mjs";
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

export async function createLongviewApp(
  config = getRuntimeConfig(),
  { companyStore = null, storeOptions = undefined, syncRunner = syncAll } = {}
) {
  const store = companyStore || (await createCompanyStore(config.dataFile, storeOptions));
  let activeSync = null;
  let lastScheduledDate = null;
  let scheduleTimer = null;

  async function refreshStore() {
    await store.refreshIfChanged();
  }

  async function startSync() {
    if (activeSync) return activeSync;
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

    if (readMethod && url.pathname === "/api/companies") {
      try {
        const query = parseCompanyQuery(url.searchParams);
        await refreshStore();
        const result = store.list(query);
        const variant = JSON.stringify([
          query.normalizedQuery,
          query.country,
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
      const modelVersion = "1.0.0";
      sendJson(
        request,
        response,
        200,
        {
          modelVersion,
          name: "공시 기반 장기분석 모델 v1",
          groups: getScoringModel(),
          valuationIncluded: false,
          note: "PER 등 가격 지표는 검증된 시세 공급원이 연결되기 전까지 점수에 포함하지 않습니다."
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
        syncing: Boolean(activeSync),
        scheduler: Boolean(config.schedulerEnabled),
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
    return server.address();
  }

  async function close() {
    if (scheduleTimer) {
      clearInterval(scheduleTimer);
      scheduleTimer = null;
    }
    if (!server.listening) return;
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  return { server, store, startSync, handleRequest, listen, close };
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
      (config.schedulerEnabled
        ? " · 매일 " + config.scheduleHourKst + "시(KST) 자동 갱신"
        : " · 서버 스케줄러 꺼짐")
  );

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      app.close().finally(() => process.exit(0));
    });
  }
}
