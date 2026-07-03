import { WebClient } from "@slack/web-api";
import { pathToFileURL } from "node:url";

export interface SlackE2EOptions {
  /** The message to post into the channel/DM. */
  messageText?: string;
  /** How long to wait for a reply in ms. */
  timeoutMs?: number;
  /** How long to sleep between poll attempts in ms. */
  pollIntervalMs?: number;
}

export interface SlackE2EResult {
  ok: boolean;
  botUserId: string;
  postedTs: string;
  replyTs?: string;
  replyText?: string;
  error?: string;
  durationMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a test message to a Slack channel/DM and poll until Ishu replies.
 *
 * This works for both threaded channel replies (using conversations.replies)
 * and one-on-one DM top-level replies (using conversations.history as a
 * fallback), so it can be used against any channel type the bot can access.
 */
export async function runSlackE2E(
  client: WebClient,
  channelId: string,
  opts: SlackE2EOptions = {},
): Promise<SlackE2EResult> {
  const start = Date.now();
  const messageText =
    opts.messageText ?? `Ishu Slack end-to-end test ${Date.now()}`;
  const timeoutMs = opts.timeoutMs ??
    Number.parseInt(process.env.SLACK_E2E_TIMEOUT_MS ?? "60000", 10);
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;

  const auth = await client.auth.test();
  if (!auth.ok || !auth.user_id) {
    return {
      ok: false,
      botUserId: "",
      postedTs: "",
      error: `auth.test failed: ${auth.error ?? "unknown"}`,
      durationMs: Date.now() - start,
    };
  }
  const botUserId = auth.user_id;

  const post = await client.chat.postMessage({
    channel: channelId,
    text: messageText,
  });
  if (!post.ok || !post.ts) {
    return {
      ok: false,
      botUserId,
      postedTs: "",
      error: `chat.postMessage failed: ${post.error ?? "unknown"}`,
      durationMs: Date.now() - start,
    };
  }
  const postedTs = post.ts;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let messages: Array<{ ts?: string; user?: string; text?: string }> = [];

    // Try a threaded reply first (channel/group/MPIM @-mention flow).
    try {
      const replies = await client.conversations.replies({
        channel: channelId,
        ts: postedTs,
        limit: 10,
      });
      if (replies.ok && Array.isArray(replies.messages)) {
        messages = replies.messages;
      }
    } catch {
      // Threaded lookup may fail for unsupported channel types; fall through.
    }

    // Fall back to channel/DM history for top-level replies.
    if (messages.length <= 1) {
      try {
        const history = await client.conversations.history({
          channel: channelId,
          limit: 10,
        });
        if (history.ok && Array.isArray(history.messages)) {
          messages = history.messages;
        }
      } catch {
        // Ignore transient history errors and retry on next poll.
      }
    }

    const reply = messages.find(
      (m) =>
        m.user === botUserId &&
        m.ts !== postedTs &&
        (m.text ?? "").length > 0,
    );
    if (reply) {
      return {
        ok: true,
        botUserId,
        postedTs,
        replyTs: reply.ts,
        replyText: reply.text,
        durationMs: Date.now() - start,
      };
    }

    await sleep(pollIntervalMs);
  }

  return {
    ok: false,
    botUserId,
    postedTs,
    error: `No reply from Ishu within ${timeoutMs}ms`,
    durationMs: Date.now() - start,
  };
}

async function main(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_E2E_CHANNEL;
  if (!token || !channelId) {
    console.error(
      "Set SLACK_BOT_TOKEN and SLACK_E2E_CHANNEL before running the Slack end-to-end test.",
    );
    process.exit(1);
  }

  const client = new WebClient(token);
  const result = await runSlackE2E(client, channelId, {
    timeoutMs: Number.parseInt(process.env.SLACK_E2E_TIMEOUT_MS ?? "60000", 10),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
