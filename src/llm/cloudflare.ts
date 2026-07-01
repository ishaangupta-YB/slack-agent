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

export async function chat(messages: Message[]): Promise<string> {
  if (chatOverride) {
    return chatOverride(messages);
  }

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.cloudflare.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Cloudflare Workers AI error ${resp.status}: ${body}`,
    );
  }

  const json = (await resp.json()) as RunResponse;

  if (typeof json.result === "string") {
    return json.result;
  }
  const text = json.result?.response ?? json.response;
  if (!text) {
    throw new Error(`Unexpected Cloudflare response: ${JSON.stringify(json)}`);
  }
  return text;
}
