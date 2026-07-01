import {
  App,
  Assistant,
  type AllMiddlewareArgs,
  type SlackEventMiddlewareArgs,
  type KnownEventFromType,
  type SayFn,
} from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { cfg } from "./config.js";
import { handleMessage } from "./agent.js";
import { uploadArtifacts } from "./artifacts.js";
import { buildResponseBlocks } from "./slack-blocks.js";
import { runWithToolContext } from "./context.js";

export const app = new App({
  token: cfg.slack.botToken,
  appToken: cfg.slack.appToken,
  socketMode: true,
  deferInitialization: true,
});

/**
 * Subset of Slack event fields required to route a user message through the
 * agent. This shape is shared between regular @-mentions / DMs and Slack AI
 * Assistant user messages.
 */
interface MessageEventShape {
  user?: string;
  text?: string;
  ts: string;
  channel: string;
  thread_ts?: string;
  bot_id?: string;
  channel_type?: string;
  action_token?: string;
}

function getThreadKey(event: MessageEventShape): string {
  const channel = event.channel ?? "unknown";
  const threadTs = event.thread_ts;
  if (threadTs) return `${channel}:${threadTs}`;
  return `${channel}:${event.ts ?? Date.now()}`;
}

function userIsAuthorized(userId: string): boolean {
  if (cfg.security.allowedUserIds.length === 0) return true;
  return cfg.security.allowedUserIds.includes(userId);
}

const emailCache = new Map<string, string | undefined>();

async function getUserEmail(client: WebClient, userId: string): Promise<string | undefined> {
  const cached = emailCache.get(userId);
  if (cached !== undefined || emailCache.has(userId)) return cached;

  try {
    const resp = await client.users.info({ user: userId });
    const email = (resp.user?.profile as { email?: string } | undefined)?.email;
    emailCache.set(userId, email);
    return email;
  } catch {
    emailCache.set(userId, undefined);
    return undefined;
  }
}

async function handleIncomingMessage({
  event,
  say,
  client,
}: {
  event: MessageEventShape;
  say: SayFn;
  client: WebClient;
}) {
  const userId = event.user;
  const text = event.text ?? "";
  const ts = event.ts;
  const channel = event.channel;
  const actionToken = event.action_token;

  if (!userId || event.bot_id) return;
  if (!userIsAuthorized(userId)) {
    await client.chat.postEphemeral({
      channel,
      user: userId,
      text: "Sorry, you’re not authorized to use Moon Bot in this workspace.",
    });
    return;
  }

  const threadKey = getThreadKey(event);
  const userEmail = await getUserEmail(client, userId);

  try {
    const { text: reply, sessionFilename } = await runWithToolContext(
      { actionToken, channelId: channel, threadKey, userId },
      () => handleMessage(threadKey, text.trim(), ts, userId, userEmail),
    );
    const { responseUrl, sessionUrl } = await uploadArtifacts(
      threadKey,
      sessionFilename,
      reply,
    );
    const threadTs = event.thread_ts ?? ts;
    await say({
      text: reply,
      blocks: buildResponseBlocks(reply, responseUrl, sessionUrl),
      thread_ts: threadTs,
      unfurl_links: false,
    });
  } catch (err) {
    console.error("Agent error:", err);
    await say({
      text: "Oops, something went wrong while processing your request. Check the logs for details.",
      thread_ts: event.thread_ts ?? ts,
    });
  }
}

async function routeEvent({
  event,
  say,
  client,
}: SlackEventMiddlewareArgs<"message" | "app_mention"> & AllMiddlewareArgs) {
  const channel = (event as { channel: string }).channel;
  const user = (event as { user?: string }).user;
  const text = (event as { text?: string }).text;
  const ts = (event as { ts: string }).ts;
  const threadTs = (event as { thread_ts?: string }).thread_ts;
  const botId = (event as { bot_id?: string }).bot_id;
  const channelType = (event as { channel_type?: string }).channel_type;
  const actionToken = (event as { action_token?: string }).action_token;

  await handleIncomingMessage({
    event: {
      user,
      text,
      ts,
      channel,
      thread_ts: threadTs,
      bot_id: botId,
      channel_type: channelType,
      action_token: actionToken,
    },
    say,
    client,
  });
}

app.event("app_mention", routeEvent as never);

app.event("message", async (args) => {
  const event = args.event as KnownEventFromType<"message">;
  // Only respond to direct messages without an explicit mention.
  if ((event as { channel_type?: string }).channel_type !== "im") return;
  await routeEvent(args as SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs);
});

/**
 * Slack AI Assistant integration.
 *
 * Registering the Assistant makes Moon Bot available as a Slack AI assistant:
 * users can open the assistant panel in Slack and chat with Moon Bot directly.
 * This fulfills the hackathon's "Slack AI capabilities" requirement.
 */
const moonAssistant = new Assistant({
  threadStarted: async ({ say, setStatus, setSuggestedPrompts, event }) => {
    await setStatus("Moon Bot is ready.");

    const userId = event.assistant_thread?.user_id;
    if (userId && !userIsAuthorized(userId)) {
      await say("Sorry, you’re not authorized to use Moon Bot in this workspace.");
      return;
    }

    await say(
      "Hi! I’m Moon Bot, your engineering assistant inside Slack. Ask me about code, GitHub, Slack history, metrics, or ops tasks.",
    );

    await setSuggestedPrompts({
      title: "Try asking Moon Bot",
      prompts: [
        { title: "Search Slack history", message: "Search Slack for recent deployment discussions" },
        { title: "Open a PR", message: "Open a PR in my-org/my-repo that updates the README" },
        { title: "Run a command", message: "Run a safe shell command and show me the output" },
      ],
    });
  },
  threadContextChanged: async ({ saveThreadContext }) => {
    await saveThreadContext();
  },
  userMessage: async ({ say, client, event, setStatus }) => {
    await setStatus("Moon Bot is thinking...");

    const channel = (event as { channel: string }).channel;
    const user = (event as { user?: string }).user;
    const text = (event as { text?: string }).text;
    const ts = (event as { ts: string }).ts;
    const threadTs = (event as { thread_ts?: string }).thread_ts;
    const botId = (event as { bot_id?: string }).bot_id;
    const actionToken = (event as { action_token?: string }).action_token;

    try {
      await handleIncomingMessage({
        event: {
          user,
          text,
          ts,
          channel,
          thread_ts: threadTs,
          bot_id: botId,
          channel_type: "im",
          action_token: actionToken,
        },
        say,
        client,
      });
    } finally {
      await setStatus("");
    }
  },
});

app.assistant(moonAssistant);

app.error(async (error) => {
  console.error("Slack app error:", error);
});
