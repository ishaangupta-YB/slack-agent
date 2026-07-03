/**
 * Container-friendly healthcheck for Moon Bot.
 *
 * Polls the bucket server's /health endpoint (or HEALTHCHECK_URL) and exits
 * with code 0 when it returns { status: "ok" }.
 *
 * Runs without importing src/config.ts so it can be executed in production
 * images before Slack/Cloudflare tokens are available.
 */

const DEFAULT_PORT = 3001;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 0;
const DEFAULT_INTERVAL_MS = 1000;

function getHealthUrl(): string {
  if (process.env.HEALTHCHECK_URL) return process.env.HEALTHCHECK_URL;
  const port = process.env.BUCKET_HTTP_PORT || String(DEFAULT_PORT);
  return `http://localhost:${port}/health`;
}

async function attemptFetch(url: string, timeoutMs: number): Promise<{ status?: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { status?: unknown };
    if (body.status !== "ok") {
      throw new Error(`unexpected status: ${JSON.stringify(body)}`);
    }
    return body;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function main() {
  const url = getHealthUrl();
  const timeoutMs = parseInt(process.env.HEALTHCHECK_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
  const retries = parseInt(process.env.HEALTHCHECK_RETRIES || String(DEFAULT_RETRIES), 10);
  const intervalMs = parseInt(process.env.HEALTHCHECK_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const body = await attemptFetch(url, timeoutMs);
      console.log(`healthcheck OK: ${JSON.stringify(body)}`);
      process.exit(0);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(`healthcheck failed: ${message}`);
  process.exit(1);
}

await main();
