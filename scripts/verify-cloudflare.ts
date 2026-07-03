import "dotenv/config";
import { pathToFileURL } from "node:url";

export interface CloudflareVerifyCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface CloudflareVerifyResult {
  ok: boolean;
  checks: CloudflareVerifyCheck[];
  primaryModel: string;
  fallbackModel?: string;
}

interface RunResponse {
  response?: string;
  result?: { response?: string } | string;
}

interface FetchModelPingOptions {
  accountId: string;
  apiToken: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.7-code";
const DEFAULT_TIMEOUT_MS = 120_000;

function buildRunUrl(accountId: string, model: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
}

function looksLikeAccountId(value: string): boolean {
  return /^[a-f0-9]{32}$/i.test(value);
}

async function fetchModelPing(options: FetchModelPingOptions): Promise<{ latencyMs: number; snippet: string }> {
  const { accountId, apiToken, model, timeoutMs, fetchImpl = fetch } = options;
  const url = buildRunUrl(accountId, model);

  const start = Date.now();
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "ping" }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const latencyMs = Date.now() - start;

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Cloudflare Workers AI error ${resp.status}: ${body}`);
  }

  const json = (await resp.json()) as RunResponse;
  let text: string;
  if (typeof json.result === "string") {
    text = json.result;
  } else {
    text = json.result?.response ?? json.response ?? "";
  }
  if (!text) {
    throw new Error(`Unexpected Cloudflare response: ${JSON.stringify(json)}`);
  }

  return {
    latencyMs,
    snippet: text.trim().slice(0, 140).replace(/\s+/g, " "),
  };
}

function extractStatus(err: unknown): number | undefined {
  if (err instanceof Error) {
    const match = err.message.match(/Cloudflare Workers AI error (\d{3})/);
    if (match) return Number.parseInt(match[1]!, 10);
  }
  return undefined;
}

function isModelNotFoundError(err: unknown): boolean {
  const status = extractStatus(err);
  return status === 404 || status === 422 || (status === 400 && err instanceof Error && /not found/i.test(err.message));
}

export interface VerifyCloudflareOptions {
  accountId?: string;
  apiToken?: string;
  model?: string;
  fallbackModel?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Verify that Cloudflare Workers AI is reachable and that the configured Kimi
 * model responds to a tiny prompt. If a fallback model is configured, it is
 * also checked so there are no surprises when the primary model is unavailable.
 */
export async function verifyCloudflare(options?: VerifyCloudflareOptions): Promise<CloudflareVerifyResult> {
  const accountId = options?.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = options?.apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? "";
  const model = options?.model ?? process.env.CLOUDFLARE_MODEL ?? DEFAULT_MODEL;
  const fallbackModel = options?.fallbackModel ?? process.env.CLOUDFLARE_FALLBACK_MODEL ?? "";
  const timeoutMs = options?.timeoutMs ?? Number.parseInt(process.env.CLOUDFLARE_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10);
  const fetchImpl = options?.fetchImpl ?? fetch;

  const checks: CloudflareVerifyCheck[] = [];

  checks.push({
    name: "env_account_id",
    ok: Boolean(accountId) && looksLikeAccountId(accountId),
    message: accountId
      ? looksLikeAccountId(accountId)
        ? `CLOUDFLARE_ACCOUNT_ID looks valid (${accountId.slice(0, 6)}...)`
        : "CLOUDFLARE_ACCOUNT_ID does not look like a 32-character Cloudflare account ID."
      : "CLOUDFLARE_ACCOUNT_ID is not set.",
  });

  checks.push({
    name: "env_api_token",
    ok: Boolean(apiToken),
    message: apiToken
      ? "CLOUDFLARE_API_TOKEN is set."
      : "CLOUDFLARE_API_TOKEN is not set.",
  });

  if (!accountId || !apiToken) {
    return { ok: false, checks, primaryModel: model, fallbackModel: fallbackModel || undefined };
  }

  let primaryError: Error | undefined;
  try {
    const { latencyMs, snippet } = await fetchModelPing({ accountId, apiToken, model, timeoutMs, fetchImpl });
    checks.push({
      name: "primary_model",
      ok: true,
      message: `Model ${model} responded in ${latencyMs}ms: "${snippet}"`,
    });
  } catch (err) {
    primaryError = err instanceof Error ? err : new Error(String(err));
    checks.push({
      name: "primary_model",
      ok: false,
      message: primaryError.message,
    });
  }

  if (fallbackModel) {
    try {
      const { latencyMs, snippet } = await fetchModelPing({ accountId, apiToken, model: fallbackModel, timeoutMs, fetchImpl });
      checks.push({
        name: "fallback_model",
        ok: true,
        message: `Fallback model ${fallbackModel} responded in ${latencyMs}ms: "${snippet}"`,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      checks.push({
        name: "fallback_model",
        ok: false,
        message: error.message,
      });
    }
  }

  const ok = checks.every((c) => c.ok);

  if (!ok && primaryError && fallbackModel && isModelNotFoundError(primaryError)) {
    return { ok, checks, primaryModel: model, fallbackModel };
  }

  return { ok, checks, primaryModel: model, fallbackModel: fallbackModel || undefined };
}

function formatReport(result: CloudflareVerifyResult): void {
  console.log("Ishu Cloudflare Workers AI verification\n");
  for (const check of result.checks) {
    const icon = check.ok ? "✅" : "❌";
    console.log(`${icon} ${check.name}: ${check.message}`);
  }
  console.log("");
  if (result.ok) {
    console.log(
      result.fallbackModel
        ? `All Cloudflare checks passed. Primary ${result.primaryModel} and fallback ${result.fallbackModel} are reachable.`
        : `All Cloudflare checks passed. Model ${result.primaryModel} is reachable.`,
    );
  } else {
    console.log("Some Cloudflare checks failed. Fix the issues above before starting Ishu.");
  }
}

async function main(): Promise<void> {
  const result = await verifyCloudflare();
  formatReport(result);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
