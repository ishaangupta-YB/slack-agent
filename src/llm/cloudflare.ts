import { cfg } from "../config.js";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface RunResponse {
  response?: string;
  result?: { response?: string } | string;
}

const endpoint =
  `https://api.cloudflare.com/client/v4/accounts/${cfg.cloudflare.accountId}/ai/run/${cfg.cloudflare.model}`;

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

async function fetchChat(messages: Message[], signal: AbortSignal): Promise<RunResponse> {
  const resp = await fetch(endpoint, {
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
    throw new Error(
      `Cloudflare Workers AI error ${resp.status}: ${body}`,
    );
  }

  return (await resp.json()) as RunResponse;
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.message.includes("fetch failed")) {
      return true;
    }
    const statusMatch = err.message.match(/Cloudflare Workers AI error (\d{3})/);
    if (statusMatch) {
      const status = parseInt(statusMatch[1], 10);
      return status >= 500 || status === 429;
    }
  }
  return false;
}

export async function chat(messages: Message[]): Promise<string> {
  if (chatOverride) {
    return chatOverride(messages);
  }

  const maxRetries = cfg.cloudflare.retries;
  const timeoutMs = cfg.cloudflare.timeoutMs;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const json = await fetchChat(messages, controller.signal);
      clearTimeout(timer);

      if (typeof json.result === "string") {
        return json.result;
      }
      const text = json.result?.response ?? json.response;
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
