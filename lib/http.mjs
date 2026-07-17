const DEFAULT_TIMEOUT_MS = 25_000;

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fetchJson(
  url,
  { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2 } = {}
) {
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
        signal: controller.signal
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < retries) {
          await sleep(600 * 2 ** attempt);
          continue;
        }
        throw new Error("HTTP " + response.status + " from upstream provider");
      }

      return await response.json();
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
