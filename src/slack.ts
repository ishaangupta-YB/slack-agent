import {
  App,
  Assistant,
  type AllMiddlewareArgs,
  type SlackEventMiddlewareArgs,
  type SlackCommandMiddlewareArgs,
  type SlackShortcutMiddlewareArgs,
  type SlackActionMiddlewareArgs,
  type MessageShortcut,
  type KnownEventFromType,
  type SayFn,
} from "@slack/bolt";
import { WebClient, type ChatPostMessageResponse } from "@slack/web-api";
import { cfg } from "./config.js";
import { handleMessage, hasThreadKey } from "./agent.js";
import { uploadArtifacts } from "./artifacts.js";
import { prepareSlackMessage } from "./slack-blocks.js";
import { runWithToolContext } from "./context.js";
import { publishHomeView } from "./app-home.js";
import { helpTool } from "./tools/help.js";
import { statusTool } from "./tools/status.js";
import { safeSay } from "./slack-delivery.js";
import { recordFeedback, type FeedbackKind } from "./feedback.js";
import { generateWeeklyReport, generateDeployReport } from "./scheduler.js";

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
const guestCache = new Map<string, boolean | undefined>();
let botUserIdCache: string | undefined | null = null;

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

async function ensureBotUserId(client: WebClient): Promise<string | undefined> {
  if (botUserIdCache !== null) return botUserIdCache ?? undefined;
  try {
    const resp = await client.auth.test({ token: cfg.slack.botToken });
    botUserIdCache = resp.user_id || undefined;
    return botUserIdCache;
  } catch {
    botUserIdCache = undefined;
    return undefined;
  }
}

export async function isGuestUser(client: WebClient, userId: string): Promise<boolean> {
  const cached = guestCache.get(userId);
  if (cached !== undefined || guestCache.has(userId)) return cached ?? false;

  try {
    const resp = await client.users.info({ user: userId });
    const user = (resp as unknown as {
      user?: { is_restricted?: boolean; is_ultra_restricted?: boolean };
    }).user;
    const guest = Boolean(user?.is_restricted || user?.is_ultra_restricted);
    guestCache.set(userId, guest);
    return guest;
  } catch {
    guestCache.set(userId, false);
    return false;
  }
}

async function assertNotGuest(
  client: WebClient,
  userId: string,
  channel: string,
): Promise<boolean> {
  if (cfg.security.allowGuests) return true;
  const guest = await isGuestUser(client, userId);
  if (!guest) return true;
  await client.chat.postEphemeral({
    channel,
    user: userId,
    text: "Sorry, guest accounts are not allowed to use Moon Bot in this workspace.",
  });
  return false;
}

export function stripBotMention(text: string, botUserId?: string): string {
  if (!text) return text;
  if (botUserId) {
    const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(`<@${escaped}(?:\\|[^>]*)?>\\s*`, "g"), "").trim();
  }
  return text.replace(/^<@[A-Z0-9_-]+(?:\|[^>]*)?>\s*/, "").trim();
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
  if (!(await assertNotGuest(client, userId, channel))) return;

  const threadKey = getThreadKey(event);
  const userEmail = await getUserEmail(client, userId);
  const botUserId = await ensureBotUserId(client);
  const cleanText = stripBotMention(text, botUserId);

  try {
    const { text: reply, sessionFilename, skipped } = await runWithToolContext(
      { actionToken, channelId: channel, threadKey, userId },
      () => handleMessage(threadKey, cleanText.trim(), ts, userId, userEmail),
    );
    if (skipped) return;
    const { responseUrl, sessionUrl, traceUrl } = await uploadArtifacts(
      threadKey,
      sessionFilename,
      reply,
    );
    const threadTs = event.thread_ts ?? ts;
    const { text: fallbackText, blocks } = prepareSlackMessage(
      reply,
      responseUrl,
      sessionUrl,
      traceUrl,
    );
    await safeSay(
      say,
      {
        text: fallbackText,
        blocks,
        thread_ts: threadTs,
        unfurl_links: false,
      },
      { retries: cfg.slack.sayRetries, baseDelayMs: cfg.slack.sayRetryBaseMs },
    );
  } catch (err) {
    console.error("Agent error:", err);
    await safeSay(
      say,
      {
        text: "Oops, something went wrong while processing your request. Check the logs for details.",
        thread_ts: event.thread_ts ?? ts,
      },
      { retries: cfg.slack.sayRetries, baseDelayMs: cfg.slack.sayRetryBaseMs },
    );
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
  const channelType = (event as { channel_type?: string }).channel_type;

  // Respond to all direct messages without requiring a mention.
  if (channelType === "im") {
    await routeEvent(args as SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs);
    return;
  }

  // In public channels, private groups, and multi-person DMs, respond only
  // when the bot is @-mentioned or when the message is a follow-up in a
  // thread the bot already participates in.
  if (channelType !== "channel" && channelType !== "group" && channelType !== "mpim") {
    return;
  }

  const botId = (event as { bot_id?: string }).bot_id;
  if (botId) return;

  const channel = (event as { channel: string }).channel;
  const ts = (event as { ts: string }).ts;
  const threadTs = (event as { thread_ts?: string }).thread_ts;
  const text = (event as { text?: string }).text;
  const threadKey = threadTs ? `${channel}:${threadTs}` : `${channel}:${ts}`;
  const botUserId = await ensureBotUserId(args.client);
  const isMention = botUserId ? (text ?? "").includes(`<@${botUserId}`) : false;
  const inActiveThread = await hasThreadKey(threadKey);

  if (isMention || inActiveThread) {
    await routeEvent(args as SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs);
  }
});

/**
 * Slack AI Assistant integration.
 *
 * Registering the Assistant makes Moon Bot available as a Slack AI assistant:
 * users can open the assistant panel in Slack and chat with Moon Bot directly.
 * This fulfills the hackathon's "Slack AI capabilities" requirement.
 */
const moonAssistant = new Assistant({
  threadStarted: async ({ say, setStatus, setSuggestedPrompts, event, client }) => {
    await setStatus("Moon Bot is ready.");

    const userId = event.assistant_thread?.user_id;
    if (userId && !userIsAuthorized(userId)) {
      await say("Sorry, you’re not authorized to use Moon Bot in this workspace.");
      return;
    }
    if (
      userId &&
      !cfg.security.allowGuests &&
      (await isGuestUser(client, userId))
    ) {
      await say("Sorry, guest accounts are not allowed to use Moon Bot in this workspace.");
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

/**
 * App Home tab: publishes a helpful landing view when a user opens the bot's
 * Home tab in Slack. This improves discoverability and gives sandbox testers
 * a quick overview of Moon Bot's capabilities and configuration.
 */
async function handleAppHomeOpened({
  event,
  client,
}: {
  event: { user: string; tab?: string };
  client: WebClient;
}): Promise<void> {
  if (event.tab && event.tab !== "home") return;
  await publishHomeView(client, event.user);
}

app.event("app_home_opened", handleAppHomeOpened as never);

/**
 * Slash command entry point: /moonbot [help | status | report].
 *
 * Gives users a quick, discoverable way to check capabilities and health
 * without starting a threaded conversation.
 */
export async function handleMoonbotCommand({
  command,
  ack,
  respond,
}: SlackCommandMiddlewareArgs): Promise<void> {
  await ack();

  const args = command.text.trim().split(/\s+/).filter(Boolean);
  const subcommand = args[0] || "welcome";

  if (subcommand === "help" || subcommand === "h") {
    const topic = args[1] as "general" | "code" | "data" | "slack" | undefined;
    const safeTopic =
      topic && ["general", "code", "data", "slack"].includes(topic) ? topic : "general";
    await respond({
      text: await helpTool.run({ topic: safeTopic }),
      response_type: "ephemeral",
    });
    return;
  }

  if (subcommand === "status") {
    const text = await statusTool.run();
    await respond({
      text,
      response_type: "ephemeral",
    });
    return;
  }

  if (subcommand === "report") {
    const reportType = args[1];

    if (reportType === "weekly") {
      const report = await generateWeeklyReport();
      await respond({
        text: report,
        response_type: "ephemeral",
      });
      return;
    }

    if (reportType === "deploy") {
      const timestamp = args[2];
      const deployTs = timestamp ?? String((Date.now() / 1000 - 15 * 60).toFixed(6));
      const report = await generateDeployReport(deployTs);
      await respond({
        text: report,
        response_type: "ephemeral",
      });
      return;
    }

    await respond({
      text:
        "*Moon Bot reports* 🌙\n" +
        "Run scheduled reports on demand:\n" +
        "• `/moonbot report weekly` — weekly ops report\n" +
        "• `/moonbot report deploy [timestamp]` — deploy impact check (defaults to 15 minutes ago)",
      response_type: "ephemeral",
    });
    return;
  }

  await respond({
    text:
      "*Moon Bot* 🌙\n" +
      "I’m your engineering assistant inside Slack. Mention me in a channel, DM me, or open the Slack AI Assistant panel.\n\n" +
      "Try:\n" +
      "• `/moonbot help` — what I can do\n" +
      "• `/moonbot status` — my current configuration\n" +
      "• `/moonbot report weekly` — weekly ops report on demand\n" +
      "• `@Moon Bot search Slack for deploy discussions`",
    response_type: "ephemeral",
  });
}

app.command("/moonbot", handleMoonbotCommand);

/**
 * Message shortcut: Ask Moon Bot.
 *
 * When a user selects a message and chooses "Ask Moon Bot" from the actions
 * menu, the bot starts a threaded session keyed to that message, runs the same
 * ReAct agent, and posts the reply in the thread. This gives users a fast,
 * context-aware way to ask about a specific Slack message without leaving the
 * channel.
 */
export async function handleAskMoonBotShortcut({
  ack,
  shortcut,
  client,
}: SlackShortcutMiddlewareArgs<MessageShortcut> & AllMiddlewareArgs): Promise<void> {
  await ack();

  const userId = shortcut.user.id;
  const channel = shortcut.channel.id;
  const messageTs = shortcut.message.ts;
  const text = shortcut.message.text ?? "";

  // The native Bolt `say` helper is not present for message shortcuts, so build
  // a minimal wrapper over chat.postMessage that injects the shortcut channel.
  const shortcutSay: SayFn = async (message) => {
    const args = typeof message === "string" ? { text: message } : message;
    return client.chat.postMessage({
      channel,
      unfurl_links: false,
      ...args,
    }) as Promise<ChatPostMessageResponse>;
  };

  await handleIncomingMessage({
    event: {
      user: userId,
      text,
      ts: messageTs,
      channel,
      thread_ts: messageTs,
      bot_id: undefined,
      channel_type: undefined,
      action_token: undefined,
    },
    say: shortcutSay,
    client,
  });
}

app.shortcut("ask_moon_bot", handleAskMoonBotShortcut as never);

/**
 * Feedback block actions: users can tap 👍 / 👎 on any Moon Bot response.
 *
 * Feedback is recorded to a JSONL log (default: under SESSIONS_DIR) and a
 * brief ephemeral confirmation is sent. This gives hackathon judges and
 * sandbox users a quick, interactive way to flag helpful or unhelpful replies.
 */
async function handleFeedbackAction({
  ack,
  body,
  client,
  action,
}: SlackActionMiddlewareArgs & AllMiddlewareArgs): Promise<void> {
  await ack();

  const kind = (action as { value?: string }).value as FeedbackKind | undefined;
  if (!kind || (kind !== "helpful" && kind !== "not_helpful")) return;

  const userId = (body as { user?: { id?: string } }).user?.id ?? "unknown";
  const channel = (body as { channel?: { id?: string } }).channel?.id ?? "unknown";
  const message = (body as { message?: { ts?: string; thread_ts?: string } }).message;
  const messageTs = message?.ts ?? "unknown";
  const threadTs = message?.thread_ts;
  const threadKey = threadTs ? `${channel}:${threadTs}` : `${channel}:${messageTs}`;

  const sessionFilename = await import("./agent.js").then((m) =>
    m.getSessionFilenameByThreadKey(threadKey),
  );

  recordFeedback({
    ts: new Date().toISOString(),
    kind,
    userId,
    channel,
    messageTs,
    threadKey,
    sessionFilename,
  });

  await client.chat.postEphemeral({
    channel,
    user: userId,
    thread_ts: threadTs,
    text: kind === "helpful" ? "Thanks for the feedback! 🌙" : "Thanks — we’ll use this to improve Moon Bot.",
  });
}

app.action("feedback_helpful", handleFeedbackAction as never);
app.action("feedback_not_helpful", handleFeedbackAction as never);

app.error(async (error) => {
  console.error("Slack app error:", error);
});
