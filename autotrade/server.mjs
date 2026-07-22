import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getTradingConfig, publicTradingConfig } from "./config.mjs";
import { createTradingEngine } from "./engine.mjs";
import { redactSensitive } from "./risk.mjs";
import { TradingScheduler } from "./scheduler.mjs";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const MAX_REQUEST_BYTES = 8 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};

function securityHeaders(response, contentType) {
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  );
}

function sendJson(response, status, payload) {
  securityHeaders(response, "application/json; charset=utf-8");
  response.statusCode = status;
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) {
    throw Object.assign(new Error("JSON 요청만 허용합니다."), { status: 415 });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) {
      throw Object.assign(new Error("요청 본문이 너무 큽니다."), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON 형식이 올바르지 않습니다."), { status: 400 });
  }
}

function sameOrigin(request, config) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (
      LOOPBACK_HOSTS.has(url.hostname) &&
      Number(url.port || (url.protocol === "https:" ? 443 : 80)) === config.port
    );
  } catch {
    return false;
  }
}

function requireMutationGuard(request, config, csrfToken) {
  if (!sameOrigin(request, config)) {
    throw Object.assign(new Error("허용되지 않은 요청 출처입니다."), { status: 403 });
  }
  if (request.headers["x-longview-csrf"] !== csrfToken) {
    throw Object.assign(new Error("요청 보안 토큰이 올바르지 않습니다."), { status: 403 });
  }
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  try {
    const details = await stat(resolved);
    if (!details.isFile()) throw Object.assign(new Error("not file"), { code: "ENOENT" });
    securityHeaders(response, CONTENT_TYPES[path.extname(resolved)] || "application/octet-stream");
    response.statusCode = 200;
    if (request.method === "HEAD") response.end();
    else createReadStream(resolved).pipe(response);
  } catch (error) {
    if (error?.code === "ENOENT") sendJson(response, 404, { error: "Not found" });
    else throw error;
  }
}

export async function createTradingServer(
  config = getTradingConfig(),
  { engine: suppliedEngine = null, csrfToken = randomUUID() } = {}
) {
  if (!LOOPBACK_HOSTS.has(config.host)) {
    throw new Error("자동매매 대시보드는 loopback 주소에서만 실행할 수 있습니다.");
  }
  const engine = suppliedEngine || (await createTradingEngine(config));
  let lastPlan = null;

  const server = createServer((request, response) => {
    (async () => {
      const url = new URL(request.url, `http://${request.headers.host || `${config.host}:${config.port}`}`);
      if (request.method === "GET" && url.pathname === "/api/status") {
        const status = await engine.status();
        const account =
          engine.broker.name === "paper" ? await engine.broker.getAccount() : null;
        sendJson(response, 200, {
          config: publicTradingConfig(config),
          ...status,
          account,
          lastPlan: lastPlan
            ? { signal: lastPlan.signal, portfolio: lastPlan.portfolio, risk: lastPlan.risk }
            : null,
          csrfToken
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/plan") {
        requireMutationGuard(request, config, csrfToken);
        await readJson(request);
        lastPlan = await engine.plan();
        sendJson(response, 200, lastPlan);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/paper-run") {
        requireMutationGuard(request, config, csrfToken);
        await readJson(request);
        if (config.mode !== "paper") {
          sendJson(response, 409, { error: "paper 모드에서만 대시보드 모의실행이 가능합니다." });
          return;
        }
        const result = await engine.execute({ trigger: "dashboard", liveConfirmation: false });
        lastPlan = result;
        sendJson(response, result.executed || result.reason === "no_orders" ? 200 : 409, result);
        return;
      }
      if (["GET", "HEAD"].includes(request.method) && !url.pathname.startsWith("/api/")) {
        await serveStatic(request, response, url.pathname);
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    })().catch((error) => {
      const safe = redactSensitive(error, [
        config.kis.appKey,
        config.kis.appSecret,
        config.kis.accountNumber
      ]);
      if (!response.headersSent) sendJson(response, error.status || 500, { error: safe });
      else response.end();
    });
  });

  const scheduler = new TradingScheduler(engine, config, {
    onResult: (result) => {
      lastPlan = result;
      console.log(`[${new Date().toISOString()}] 자동매매 예약 실행 완료`);
    },
    onError: (error) =>
      console.error(
        "자동매매 예약 실행 실패:",
        redactSensitive(error, [config.kis.appKey, config.kis.appSecret, config.kis.accountNumber])
      )
  });

  return {
    server,
    engine,
    scheduler,
    csrfToken,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, resolve);
      });
      scheduler.start();
      return server.address();
    },
    async close() {
      scheduler.stop();
      if (!server.listening) return;
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const config = getTradingConfig();
  const app = await createTradingServer(config);
  await app.listen();
  console.log(
    `Longview Auto 대시보드: http://${config.host}:${config.port} · ${config.mode}/${config.broker}`
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => app.close().finally(() => process.exit(0)));
  }
}
