import type { SayFn } from "@slack/bolt";
import { setTimeout } from "node:timers/promises";

/**
 * Slack Web API error shape exposed by Bolt / @slack/web-api. The `data`
 * property contains the platform error response, including the well-known
 * `retry_after` seconds hint for rate_limited responses.
 */
interface SlackApiError {
  code?: string;
  data?: {
    ok?: boolean;
    error?: string;
    retry_after?: number;
  };
  message?: string;
}

function isRetryableSlackError(err: unknown): boolean {
  const error = err as SlackApiError;

  // Platform-level retryable errors
  const slackError = error.data?.error;
  if (slackError === "rate_limited") return true;
  if (slackError === "fatal_error") return true;
  if (slackError === "internal_error") return true;
  if (slackError === "timeout") return true;

  // SDK/network-level retryable errors
  if (error.code === "slack_sdk_network_error") return true;
  if (error.code === "slack_sdk_request_timeout") return true;
  if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "ENOTFOUND"].includes(error.code ?? "")) {
    return true;
  }

  return false;
}

export interface SafeSayOptions {
  retries?: number;
  baseDelayMs?: number;
}

/**
 * Deliver a Slack message with automatic retry and exponential backoff.
 *
 * Slack enforces rate limits and can return transient errors; this helper
 * ensures Ishu retries rate-limited or network-related failures before
 * giving up, which keeps long-running ReAct sessions reliable in production.
 *
 * For rate_limited errors the Slack-provided retry_after hint is honored.
 * For other retryable errors we back off exponentially from baseDelayMs.
 */
export async function safeSay(
  say: SayFn,
  message: Parameters<SayFn>[0],
  options?: SafeSayOptions,
): ReturnType<SayFn> {
  const retries = Math.max(0, options?.retries ?? 2);
  const baseDelayMs = Math.max(100, options?.baseDelayMs ?? 1000);

  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await say(message);
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === retries;
      if (!isRetryableSlackError(err) || isLastAttempt) {
        throw err;
      }

      const retryAfterSeconds = (err as SlackApiError).data?.retry_after;
      const delayMs = retryAfterSeconds
        ? retryAfterSeconds * 1000
        : baseDelayMs * 2 ** attempt;

      await setTimeout(delayMs);
    }
  }

  // Unreachable in practice because the last attempt throws, but keeps TS happy.
  throw lastErr;
}

/**
 * Wrap a Bolt say function so every call is retried transparently.
 */
export function wrapSay(say: SayFn, options?: SafeSayOptions): SayFn {
  return (message: Parameters<SayFn>[0]) => safeSay(say, message, options);
}
