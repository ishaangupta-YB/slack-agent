import { App, type AllMiddlewareArgs, type SlackEventMiddlewareArgs, type KnownEventFromType } from "@slack/bolt";
import { cfg } from "./config.js";
import { handleMessage } from "./agent.js";

export const app = new App({
  token: cfg.slack.botToken,
  appToken: cfg.slack.appToken,
  socketMode: true,
});

function getThreadKey(event: KnownEventFromType<"message"> | KnownEventFromType<"app_mention">): string {
  const channel = (event as { channel?: string }).channel ?? "unknown";
  const threadTs = (event as { thread_ts?: string }).thread_ts;
  if (threadTs) return `${channel}:${threadTs}`;
  return `${channel}:${(event as { ts?: string }).ts ?? Date.now()}`;
}

function userIsAuthorized(userId: string): boolean {
  if (cfg.security.allowedUserIds.length === 0) return true;
  return cfg.security.allowedUserIds.includes(userId);
}

async function routeEvent({
  event,
  say,
  client,
}: SlackEventMiddlewareArgs<"message" | "app_mention"> & AllMiddlewareArgs) {
  const userId = (event as { user?: string }).user;
  const text = (event as { text?: string }).text ?? "";
  const ts = (event as { ts: string }).ts;
  const channel = (event as { channel: string }).channel;

  if (!userId || (event as { bot_id?: string }).bot_id) return;
  if (!userIsAuthorized(userId)) {
    await client.chat.postEphemeral({
      channel,
      user: userId,
      text: "Sorry, you’re not authorized to use Moon Bot in this workspace.",
    });
    return;
  }

  const threadKey = getThreadKey(event);

  try {
    const reply = await handleMessage(threadKey, text.trim(), ts, userId);
    await say({
      text: reply,
      thread_ts: (event as { thread_ts?: string }).thread_ts ?? ts,
      unfurl_links: false,
    });
  } catch (err) {
    console.error("Agent error:", err);
    await say({
      text: "Oops, something went wrong while processing your request. Check the logs for details.",
      thread_ts: (event as { thread_ts?: string }).thread_ts ?? ts,
    });
  }
}

app.event("app_mention", routeEvent as never);

app.event("message", async (args) => {
  const event = args.event as KnownEventFromType<"message">;
  // Only respond to direct messages without an explicit mention.
  if ((event as { channel_type?: string }).channel_type !== "im") return;
  await routeEvent(args as SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs);
});

app.error(async (error) => {
  console.error("Slack app error:", error);
});
