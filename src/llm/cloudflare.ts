import { cfg } from "../config.js";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatChoice {
  message?: { content?: string };
  text?: string;
}

interface RunResult {
  response?: string;
  choices?: ChatChoice[];
}

export interface RunResponse {
  response?: string;
  choices?: ChatChoice[];
  result?: RunResult | string;
}

/**
 * Pull the assistant text out of a Workers AI /ai/run response. Cloudflare
 * returns two shapes depending on the model: the legacy `result.response`
 * string, and the OpenAI-style `result.choices[0].message.content` used by the
 * newer chat models (e.g. the Kimi K2 family). Handle both, plus the rare case
 * where `result` is itself a bare string.
 */
export function extractResponseText(json: RunResponse): string | undefined {
  if (typeof json.result === "string") return json.result;
  return (
    json.result?.response ??
    json.result?.choices?.[0]?.message?.content ??
    json.response ??
    json.choices?.[0]?.message?.content ??
    undefined
  );
}

let chatOverride: ((messages: Message[]) => Promise<string>) | undefined;

export function setChatOverride(fn: (messages: Message[]) => Promise<string>): void {
  chatOverride = fn;
}

export function clearChatOverride(): void {
  chatOverride = undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runEndpoint(model: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${cfg.cloudflare.accountId}/ai/run/${model}`;
}

async function fetchChat(messages: Message[], signal: AbortSignal, model: string): Promise<RunResponse> {
  const resp = await fetch(runEndpoint(model), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.cloudflare.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Cloudflare Workers AI error ${resp.status}: ${body}`);
  }

  return (await resp.json()) as RunResponse;
}

function extractStatus(err: unknown): number | undefined {
  if (err instanceof Error) {
    const statusMatch = err.message.match(/Cloudflare Workers AI error (\d{3})/);
    if (statusMatch) {
      return parseInt(statusMatch[1], 10);
    }
  }
  return undefined;
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.message.includes("fetch failed")) {
      return true;
    }
    const status = extractStatus(err);
    if (status !== undefined) {
      return status >= 500 || status === 429;
    }
  }
  return false;
}

function isModelNotFoundError(err: unknown): boolean {
  const status = extractStatus(err);
  if (status === 404 || status === 422) return true;
  if (status === 400 && err instanceof Error && /not found/i.test(err.message)) {
    return true;
  }
  return false;
}

async function chatWithModel(model: string, messages: Message[]): Promise<string> {
  const maxRetries = cfg.cloudflare.retries;
  const timeoutMs = cfg.cloudflare.timeoutMs;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const json = await fetchChat(messages, controller.signal, model);
      clearTimeout(timer);

      const text = extractResponseText(json);
      if (!text) {
        throw new Error(`Unexpected Cloudflare response: ${JSON.stringify(json)}`);
      }
      return text;
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxRetries && isRetryableError(err)) {
        const delay = 1000 * 2 ** attempt;
        console.warn(`Cloudflare chat attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message}`);
        await sleep(delay);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error("Cloudflare chat failed after retries");
}

export async function chat(messages: Message[]): Promise<string> {
  if (chatOverride) {
    return chatOverride(messages);
  }

  try {
    return await chatWithModel(cfg.cloudflare.model, messages);
  } catch (err) {
    if (cfg.cloudflare.fallbackModel && isModelNotFoundError(err)) {
      console.warn(
        `Primary Cloudflare model ${cfg.cloudflare.model} unavailable; trying fallback ${cfg.cloudflare.fallbackModel}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return await chatWithModel(cfg.cloudflare.fallbackModel, messages);
    }
    throw err;
  }
}

export interface PingResultOk {
  ok: true;
  model: string;
  latencyMs: number;
  snippet: string;
}

export interface PingResultError {
  ok: false;
  model: string;
  error: string;
}

export type PingResult = PingResultOk | PingResultError;

/**
 * Send a tiny prompt to the Cloudflare Workers AI endpoint and report whether
 * the LLM is reachable and how long it took. This is used by the `/ishu ping`
 * slash command so sandbox testers can confirm model connectivity from Slack.
 */
export async function pingLLM(): Promise<PingResult> {
  const start = Date.now();
  try {
    const response = await chat([{ role: "user", content: "ping" }]);
    return {
      ok: true,
      model: cfg.cloudflare.model,
      latencyMs: Date.now() - start,
      snippet: response.trim().slice(0, 140).replace(/\s+/g, " "),
    };
  } catch (err) {
    return {
      ok: false,
      model: cfg.cloudflare.model,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
