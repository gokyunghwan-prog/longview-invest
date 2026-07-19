const DEFAULT_TIMEOUT_MS = 25_000;

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fetchJson(
  url,
  {
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 2,
    redirect = "follow",
    maxBytes = null
  } = {}
) {
  if (maxBytes !== null && (!Number.isInteger(maxBytes) || maxBytes < 1)) {
    throw new TypeError("maxBytes must be a positive integer or null");
  }
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          ...headers
        },
        signal: controller.signal,
        redirect
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < retries) {
          await sleep(600 * 2 ** attempt);
          continue;
        }
        throw new Error("HTTP " + response.status + " from upstream provider");
      }

      if (maxBytes === null) return await response.json();

      const declaredLength = Number.parseInt(response.headers.get("content-length") || "", 10);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        const error = new Error("Upstream JSON response exceeds the configured size limit");
        error.retryable = false;
        throw error;
      }

      const chunks = [];
      let received = 0;
      const reader = response.body?.getReader?.();
      if (!reader) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maxBytes) {
          const error = new Error("Upstream JSON response exceeds the configured size limit");
          error.retryable = false;
          throw error;
        }
        return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        received += chunk.length;
        if (received > maxBytes) {
          await reader.cancel().catch(() => {});
          const error = new Error("Upstream JSON response exceeds the configured size limit");
          error.retryable = false;
          throw error;
        }
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
      lastError = error;
      if (attempt >= retries || error?.retryable === false) break;
      await sleep(600 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

export async function fetchBuffer(
  url,
  { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2 } = {}
) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < retries) {
          await sleep(600 * 2 ** attempt);
          continue;
        }
        throw new Error("HTTP " + response.status + " from upstream provider");
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await sleep(600 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}
