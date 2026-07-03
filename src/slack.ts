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
import { randomUUID } from "node:crypto";
import { cfg } from "./config.js";
import {
  getSessionFilenameByThreadKey,
  getThreadInfo,
  handleMessage,
  hasThreadKey,
  requestRegenerate,
  resetThread,
} from "./agent.js";
import { resolveAccessTier } from "./auth/tiers.js";
import { uploadArtifacts } from "./artifacts.js";
import { prepareSlackMessage } from "./slack-blocks.js";
import { runWithToolContext } from "./context.js";
import { publishHomeView } from "./app-home.js";
import { pingLLM } from "./llm/cloudflare.js";
import { helpTool } from "./tools/help.js";
import { statusTool } from "./tools/status.js";
import { formatToolList } from "./tools/registry.js";
import { publicStatusTool } from "./tools/public-status.js";
import { searchSlackTool } from "./tools/slack-search.js";
import { safeSay } from "./slack-delivery.js";
import { getDemoMessage } from "./demo.js";
import { getMetrics } from "./storage/metrics.js";
import { downloadSlackFiles, formatSlackFiles, type SlackFile } from "./slack-files.js";
import { recordFeedback, type FeedbackKind } from "./feedback.js";
import { getMemoryRecent, rememberFact, formatMemoryEntry } from "./tools/memory.js";
import { generateWeeklyReport, generateDeployReport, getPublicStatusImpactSummary } from "./scheduler.js";
import { runDiagnostics, formatDiagnosticResultForSlack } from "./diagnostics.js";
import { readRecentAuditEvents } from "./tools/security.js";

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
  /** Slack message subtype (e.g. message_changed, message_deleted). Non-chat subtypes are ignored. */
  subtype?: string;
  /** File attachments shared with the message (requires the files:read scope). */
  files?: SlackFile[];
}

function getThreadKey(event: MessageEventShape): string {
  const channel = event.channel ?? "unknown";
  // Direct messages are one continuous conversation; all top-level and threaded
  // messages in an IM channel should share the same session key. Channels,
  // groups, and MPIMs keep per-thread sessions so multi-topic conversations
  // stay isolated.
  if (event.channel_type === "im") return channel;
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

/**
 * Tracks Moon Bot message timestamps so emoji reactions on those messages can
 * trigger actions (feedback, reset, help) without requiring users to tap
 * Block Kit buttons.
 */
const botMessageTracker = new Map<string, string>(); // key: channel:ts -> threadKey

export function trackBotMessage(channel: string, ts: string | undefined, threadKey: string) {
  if (channel && ts) {
    botMessageTracker.set(`${channel}:${ts}`, threadKey);
  }
}

export function getTrackedThreadKey(channel: string, ts: string): string | undefined {
  return botMessageTracker.get(`${channel}:${ts}`);
}

export async function getUserEmail(client: WebClient, userId: string): Promise<string | undefined> {
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

export function clearBotUserIdCache(): void {
  botUserIdCache = null;
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

/**
 * Common authorization gate for interactive Slack surfaces (slash commands,
 * message shortcuts, block actions, emoji reactions). Returns true if the user
 * is allowed to interact with Moon Bot, otherwise sends an ephemeral refusal
 * and returns false.
 */
async function assertUserCanInteract(
  client: WebClient,
  userId: string,
  channel: string,
  respond?: (args: { text: string; response_type: "ephemeral" }) => Promise<unknown>,
): Promise<boolean> {
  if (!userIsAuthorized(userId)) {
    const text = "Sorry, you’re not authorized to use Moon Bot in this workspace.";
    if (respond) {
      await respond({ text, response_type: "ephemeral" });
    } else {
      await client.chat.postEphemeral({ channel, user: userId, text });
    }
    return false;
  }
  if (!cfg.security.allowGuests && (await isGuestUser(client, userId))) {
    const text = "Sorry, guest accounts are not allowed to use Moon Bot in this workspace.";
    if (respond) {
      await respond({ text, response_type: "ephemeral" });
    } else {
      await client.chat.postEphemeral({ channel, user: userId, text });
    }
    return false;
  }
  return true;
}

export function stripBotMention(text: string, botUserId?: string): string {
  if (!text) return text;
  if (botUserId) {
    const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(`<@${escaped}(?:\\|[^>]*)?>\\s*`, "g"), "").trim();
  }
  return text.replace(/^<@[A-Z0-9_-]+(?:\|[^>]*)?>\s*/, "").trim();
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

async function safePostMessage(
  client: WebClient,
  args: Parameters<WebClient["chat"]["postMessage"]>[0],
  options?: { retries?: number; baseDelayMs?: number },
): Promise<ChatPostMessageResponse> {
  const retries = Math.max(0, options?.retries ?? cfg.slack.sayRetries);
  const baseDelayMs = Math.max(100, options?.baseDelayMs ?? cfg.slack.sayRetryBaseMs);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return (await client.chat.postMessage(args)) as ChatPostMessageResponse;
    } catch (err) {
      lastErr = err;
      const isLast = attempt === retries;
      const slackError = (err as { data?: { error?: string; retry_after?: number } }).data?.error;
      const code = (err as { code?: string }).code;
      const retryable =
        slackError === "rate_limited" ||
        slackError === "fatal_error" ||
        slackError === "internal_error" ||
        slackError === "timeout" ||
        code === "slack_sdk_network_error" ||
        code === "slack_sdk_request_timeout" ||
        ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "ENOTFOUND"].includes(code ?? "");
      if (!retryable || isLast) throw err;
      const retryAfter = (err as { data?: { retry_after?: number } }).data?.retry_after;
      const delayMs = retryAfter ? retryAfter * 1000 : baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

async function postAgentReply(
  client: WebClient,
  channel: string,
  threadTs: string | undefined,
  threadKey: string,
  reply: string,
  sessionFilename: string,
): Promise<void> {
  const { responseUrl, sessionUrl, traceUrl } = await uploadArtifacts(
    threadKey,
    sessionFilename,
    reply,
  );
  const { text: fallbackText, blocks } = prepareSlackMessage(
    reply,
    responseUrl,
    sessionUrl,
    traceUrl,
    threadKey,
  );
  const botResponse = await safePostMessage(
    client,
    {
      channel,
      text: fallbackText,
      blocks,
      thread_ts: threadTs,
      unfurl_links: false,
    },
    { retries: cfg.slack.sayRetries, baseDelayMs: cfg.slack.sayRetryBaseMs },
  );
  if (
    botResponse &&
    typeof botResponse === "object" &&
    "channel" in botResponse &&
    "ts" in botResponse
  ) {
    trackBotMessage(String(botResponse.channel), String(botResponse.ts), threadKey);
  }
}

async function handleIncomingMessage({
  event,
  say,
  client,
  onToolStatus,
}: {
  event: MessageEventShape;
  say: SayFn;
  client: WebClient;
  onToolStatus?: (toolNames: string[]) => unknown;
}) {
  const userId = event.user;
  const text = event.text ?? "";
  const ts = event.ts;
  const channel = event.channel;
  const actionToken = event.action_token;

  if (!userId || event.bot_id) return;
  // Ignore message edits, deletions, channel joins, and other non-chat message subtypes.
  if (event.subtype) return;
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
  const correlationId = randomUUID().slice(0, 8);

  // Download any text-like file attachments and append their contents as context
  // so users can ask questions about logs, CSVs, code snippets, etc. shared in Slack.
  let fileContext = "";
  if (event.files && event.files.length > 0) {
    const files = await downloadSlackFiles(client, event.files);
    fileContext = formatSlackFiles(files);
  }

  const prompt = cleanText.trim() + fileContext;

  // Ignore messages that contain no usable text after stripping the bot mention
  // and no readable file attachments (e.g. a bare @-mention, an emoji-only message,
  // or a binary-only file share).
  if (!prompt.trim()) return;

  try {
    const { text: reply, sessionFilename, skipped } = await runWithToolContext(
      { actionToken, channelId: channel, threadKey, userId, correlationId },
      () => handleMessage(threadKey, prompt.trim(), ts, userId, userEmail, "slack", onToolStatus),
    );
    if (skipped) return;
    // Keep channel/group/MPIM replies threaded (create a thread for top-level
    // mentions, reply in the thread for follow-ups). For one-on-one DMs, post
    // replies as top-level messages so the conversation stays in the main DM
    // view; only keep an explicit DM thread reply threaded when the user already
    // threaded their message.
    const threadTs = event.channel_type === "im" ? event.thread_ts : (event.thread_ts ?? ts);
    await postAgentReply(client, channel, threadTs, threadKey, reply, sessionFilename);
  } catch (err) {
    console.error(
      `[correlationId=${correlationId}] Agent error for channel=${channel} threadKey=${threadKey} userId=${userId}:`,
      err,
    );
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
  const subtype = (event as { subtype?: string }).subtype;
  const files = (event as { files?: SlackFile[] }).files;

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
      subtype,
      files,
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
    const subtype = (event as { subtype?: string }).subtype;
    const files = (event as { files?: SlackFile[] }).files;

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
          subtype,
          files,
        },
        say,
        client,
        onToolStatus: (names) =>
          setStatus(
            names.length === 1
              ? `Moon Bot is using ${names[0]}...`
              : `Moon Bot is using ${names.join(", ")}...`,
          ),
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
 * Slash command entry point: /moonbot [help | demo | tools | status | diagnose | ping | whoami | thread | remember | memory | search | report | statuspage | impact].
 *
 * Gives users a quick, discoverable way to check capabilities, health,
 * configuration diagnostics, tool inventory, real-time search, session info,
 * and live LLM connectivity without starting a threaded conversation.
 */
export async function handleMoonbotCommand({
  command,
  ack,
  respond,
  client,
}: SlackCommandMiddlewareArgs & AllMiddlewareArgs): Promise<void> {
  await ack();

  if (!(await assertUserCanInteract(client, command.user_id, command.channel_id, respond))) return;

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

  if (subcommand === "whoami") {
    const userId = command.user_id;
    const userEmail = await getUserEmail(client, userId);
    const tier = await resolveAccessTier(userId, userEmail);
    const guest = await isGuestUser(client, userId);

    await respond({
      text:
        `*Your Moon Bot identity* 🌙\n` +
        `• Slack user ID: \`${userId}\`\n` +
        `• Email: ${userEmail || "_not available_"}\n` +
        `• Resolved access tier: \`${tier}\`\n` +
        `• Guest account: ${guest ? "yes (access blocked)" : "no"}`,
      response_type: "ephemeral",
    });
    return;
  }

  if (subcommand === "thread") {
    // Slash commands do not receive thread_ts, so we can only introspect the
    // single continuous session for a one-on-one DM (keyed by channel ID).
    const channelId = command.channel_id;
    if (!channelId.startsWith("D")) {
      await respond({
        text:
          "*Thread info* 🧵\n" +
          "Thread details are available for direct-message conversations via this command. " +
          "In channel threads, tap *View trace* or *Session* on any Moon Bot reply to inspect the session.",
        response_type: "ephemeral",
      });
      return;
    }

    const info = await getThreadInfo(channelId);
    if (!info.exists) {
      await respond({
        text: "*Thread info* 🧵\nYou don't have an active Moon Bot session in this DM yet. Send me a message to start one!",
        response_type: "ephemeral",
      });
      return;
    }

    const lastTs = info.lastProcessedMessageTs?.split(".")[0] ?? "";
    const lastMsgLine = lastTs ? `• Last message: <!date^${lastTs}^{date_pretty} {time}|${info.lastProcessedMessageTs}>` : "";
    await respond({
      text:
        `*Current DM session* 🧵\n` +
        `• Session file: \`${info.sessionFilename}\`\n` +
        `• Visible messages: ${info.messageCount}\n` +
        lastMsgLine,
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

  if (subcommand === "metrics") {
    const m = getMetrics();
    await respond({
      text:
        `*Moon Bot runtime metrics* 📊\n` +
        `• Uptime: ${formatDuration(m.uptimeSeconds)}\n` +
        `• Messages handled: ${m.messagesHandled.toLocaleString()}\n` +
        `• LLM calls: ${m.llmCalls.toLocaleString()}\n` +
        `• Tool calls: ${m.toolCalls.toLocaleString()}\n` +
        `• Tool errors: ${m.toolErrors.toLocaleString()}\n` +
        `• Sessions: ${m.sessions}\n` +
        `• Thread map entries: ${m.threadMapEntries}\n` +
        `• Memory entries: ${m.memoryEntries}\n` +
        `• Feedback entries: ${m.feedbackEntries}\n` +
        `• Audit entries: ${m.auditEntries}\n` +
        `• Response artifacts: ${m.responseArtifacts}`,
      response_type: "ephemeral",
    });
    return;
  }

  if (subcommand === "diagnose") {
    const result = await runDiagnostics();
    await respond({
      text: formatDiagnosticResultForSlack(result),
      response_type: "ephemeral",
    });
    return;
  }

  if (subcommand === "audit") {
    const userId = command.user_id;
    const userEmail = await getUserEmail(client, userId);
    const tier = await resolveAccessTier(userId, userEmail);
    if (tier !== "privileged") {
      await respond({
        text: "*Security audit log* \nOnly privileged-tier users can view the security audit log.",
        response_type: "ephemeral",
      });
      return;
    }

    const limit = Math.min(parseInt(args[1] || "10", 10) || 10, 50);
    const events = readRecentAuditEvents(limit);

    if (events.length === 0) {
      await respond({
        text: "*Security audit log* \nNo security events have been recorded yet.",
        response_type: "ephemeral",
      });
      return;
    }

    const lines = events
      .map(
        (evt, idx) =>
          `${idx + 1}. *${evt.type}* — ${new Date(evt.timestamp).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}` +
          (evt.userId ? ` | user \`${evt.userId}\`` : "") +
          (evt.threadKey ? ` | thread \`${evt.threadKey}\`` : "") +
          (evt.details && Object.keys(evt.details).length > 0
            ? `\n   \`${JSON.stringify(evt.details).slice(0, 180)}\``
            : ""),
      )
      .join("\n");

    await respond({
      text: `*Security audit log* \nShowing the last ${events.length} event(s):\n\n${lines}`,
      response_type: "ephemeral",
    });
    return;
  }

  if (subcommand === "ping") {
    const result = await pingLLM();
    if (result.ok) {
      await respond({
        text: `Pong from \`${result.model}\` in ${result.latencyMs}ms: "${result.snippet}"`,
        response_type: "ephemeral",
      });
    } else {
      await respond({
        text: `*LLM connectivity check failed* for \`${result.model}\`: ${result.error}`,
        response_type: "ephemeral",
      });
    }
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

  if (subcommand === "impact") {
    const summary = await getPublicStatusImpactSummary();
    await respond({ text: summary, response_type: "ephemeral" });
    return;
  }

  if (subcommand === "statuspage") {
    const url = args[1];
    if (!url) {
      await respond({
        text:
          "*Moon Bot status page check* 🌐\n" +
          "Check a public status page on demand: `/moonbot statuspage <url>`\n" +
          "Example: `/moonbot statuspage https://status.cloudflare.com/api/v2/status.json`",
        response_type: "ephemeral",
      });
      return;
    }

    try {
      const summary = await publicStatusTool.run({ status_page_url: url });
      await respond({ text: summary, response_type: "ephemeral" });
    } catch (err) {
      await respond({
        text: `Could not check status page: ${err instanceof Error ? err.message : String(err)}`,
        response_type: "ephemeral",
      });
    }
    return;
  }

  if (subcommand === "search") {
    const query = args.slice(1).join(" ");
    if (!query) {
      await respond({
        text:
          "*Moon Bot Slack search* 🔍\n" +
          "Search workspace history with the Real-Time Search API: `/moonbot search <query>`\n" +
          "Example: `/moonbot search deployment discussions`",
        response_type: "ephemeral",
      });
      return;
    }

    const summary = await runWithToolContext(
      { channelId: command.channel_id, userId: command.user_id },
      async () => await searchSlackTool.run({ query }),
    );
    await respond({ text: summary, response_type: "ephemeral" });
    return;
  }

  if (subcommand === "demo") {
    await respond({ text: getDemoMessage(), response_type: "ephemeral" });
    return;
  }

  if (subcommand === "tools") {
    const userId = command.user_id;
    const userEmail = await getUserEmail(client, userId);
    const tier = await resolveAccessTier(userId, userEmail);
    await respond({ text: formatToolList(tier, "slack"), response_type: "ephemeral" });
    return;
  }

  if (subcommand === "remember") {
    const text = args.slice(1).join(" ").trim();
    if (!text) {
      await respond({
        text:
          "*Remember* 🧠\n" +
          "Save a fact so I can recall it in future conversations: `/moonbot remember <fact>`\n" +
          "Example: `/moonbot remember staging DB host is db-staging.example.com`",
        response_type: "ephemeral",
      });
      return;
    }

    const threadKey = `remember:${command.user_id}:${command.channel_id}`;
    await rememberFact(threadKey, command.user_id, text);
    await respond({
      text: `*Remembered* 🧠\nI'll recall this in future conversations:\n• ${text}`,
      response_type: "ephemeral",
    });
    return;
  }

  if (subcommand === "memory") {
    const limit = Math.min(parseInt(args[1] || "5", 10) || 5, 20);
    const entries = await getMemoryRecent(limit);
    if (entries.length === 0) {
      await respond({
        text: "*Memory* 🧠\nNo memories stored yet. Use `/moonbot remember <fact>` to add one.",
        response_type: "ephemeral",
      });
      return;
    }

    const lines = entries.map(formatMemoryEntry).join("\n");
    await respond({
      text: `*Recent memories* 🧠 (showing ${entries.length})\n${lines}`,
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
      "• `/moonbot demo` — curated hackathon demo prompts\n" +
      "• `/moonbot tools` — tools available to your access tier\n" +
      "• `/moonbot status` — my current configuration\n" +
      "• `/moonbot metrics` — runtime usage metrics\n" +
      "• `/moonbot diagnose` — pre-flight configuration check\n" +
      "• `/moonbot audit [limit]` — view recent security audit events (privileged only)\n" +
      "• `/moonbot ping` — live LLM connectivity check\n" +
      "• `/moonbot whoami` — your resolved access tier and guest status\n" +
      "• `/moonbot thread` — your current DM session info\n" +
      "• `/moonbot remember <fact>` — save a fact for future conversations\n" +
      "• `/moonbot memory [limit]` — recall recent remembered facts\n" +
      "• `/moonbot search <query>` — search Slack history with the Real-Time Search API\n" +
      "• `/moonbot report weekly` — weekly ops report on demand\n" +
      "• `/moonbot impact` — public service status monitoring for the Agent for Good track\n" +
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
  if (!(await assertUserCanInteract(client, userId, channel))) return;

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
export async function handleFeedbackAction({
  ack,
  body,
  client,
  action,
}: SlackActionMiddlewareArgs & AllMiddlewareArgs): Promise<void> {
  await ack();

  const userId = (body as { user?: { id?: string } }).user?.id ?? "unknown";
  const channel = (body as { channel?: { id?: string } }).channel?.id ?? "unknown";
  if (!(await assertUserCanInteract(client, userId, channel))) return;

  const actionId = (action as { action_id?: string }).action_id ?? "";
  const kind: FeedbackKind | undefined =
    actionId === "feedback_helpful"
      ? "helpful"
      : actionId === "feedback_not_helpful"
        ? "not_helpful"
        : undefined;
  if (!kind) return;

  const message = (body as { message?: { ts?: string; thread_ts?: string } }).message;
  const messageTs = message?.ts ?? "unknown";
  const threadTs = message?.thread_ts;

  // New responses embed the exact thread key in the button value so feedback
  // works for one-on-one DM sessions (keyed by channel) as well as threaded
  // channel/MPIM sessions. Fall back to the previous computed key for legacy
  // messages or payloads without a value.
  const actionValue = (action as { value?: string }).value;
  const threadKey =
    actionValue ??
    (threadTs ? `${channel}:${threadTs}` : `${channel}:${messageTs}`);

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

  if (kind === "helpful") {
    await client.chat.postEphemeral({
      channel,
      user: userId,
      thread_ts: threadTs,
      text: "Thanks for the feedback! 🌙",
    });
    return;
  }

  // For thumbs-down feedback, offer a one-click regenerate action so the user
  // can ask Moon Bot to try again with a different approach.
  await client.chat.postEphemeral({
    channel,
    user: userId,
    thread_ts: threadTs,
    text: "Thanks — we’ll use this to improve Moon Bot.",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "Thanks — we’ll use this to improve Moon Bot. Want me to try again?" },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "🔄 Regenerate response", emoji: true },
            action_id: "regenerate_response",
            value: threadKey,
            style: "primary",
          } as never,
        ],
      },
    ],
  });
}

app.action("feedback_helpful", handleFeedbackAction as never);
app.action("feedback_not_helpful", handleFeedbackAction as never);

/**
 * Reset action: users can tap "Start over" on any Moon Bot response to clear
 * the current thread session.
 *
 * This is useful when a conversation drifts, the context window fills up, or a
 * user wants to begin a fresh task. After a reset, the next message in the
 * thread starts a brand-new agent session.
 */
export async function handleResetThread({
  ack,
  body,
  client,
  action,
}: SlackActionMiddlewareArgs & AllMiddlewareArgs): Promise<void> {
  await ack();

  const userId = (body as { user?: { id?: string } }).user?.id ?? "unknown";
  const channel = (body as { channel?: { id?: string } }).channel?.id ?? "unknown";
  if (!(await assertUserCanInteract(client, userId, channel))) return;

  const message = (body as { message?: { ts?: string; thread_ts?: string } }).message;
  const messageTs = message?.ts ?? "unknown";
  const threadTs = message?.thread_ts;

  // Use the thread key carried by the button value so resetting works for
  // one-on-one DM sessions (keyed by channel alone) in addition to threaded
  // channel/MPIM sessions. Fall back to the computed key for older messages.
  const actionValue = (action as { value?: string }).value;
  const threadKey =
    actionValue ??
    (threadTs ? `${channel}:${threadTs}` : `${channel}:${messageTs}`);

  const existed = await resetThread(threadKey);

  await client.chat.postEphemeral({
    channel,
    user: userId,
    thread_ts: threadTs,
    text: existed
      ? "Got it — this thread has been reset. Your next message will start a fresh session."
      : "This thread was not active, so there was nothing to reset.",
  });
}

app.action("reset_thread", handleResetThread as never);

/**
 * Regenerate response action: triggered from the thumbs-down feedback ephemeral
 * message. It asks the agent to retry the last turn with a different approach,
 * then posts the new response in the same thread.
 */
export async function handleRegenerateResponse({
  ack,
  body,
  client,
  action,
}: SlackActionMiddlewareArgs & AllMiddlewareArgs): Promise<void> {
  await ack();

  const userId = (body as { user?: { id?: string } }).user?.id ?? "unknown";
  const channel = (body as { channel?: { id?: string } }).channel?.id ?? "unknown";
  if (!(await assertUserCanInteract(client, userId, channel))) return;

  const message = (body as { message?: { ts?: string; thread_ts?: string } }).message;
  const messageTs = message?.ts ?? "unknown";
  const threadTs = message?.thread_ts;

  const threadKey = (action as { value?: string }).value ??
    (threadTs ? `${channel}:${threadTs}` : `${channel}:${messageTs}`);

  const userEmail = await getUserEmail(client, userId);
  // Use a synthetic timestamp that is guaranteed to be newer than the last
  // processed message so the regenerate turn is not de-duplicated.
  const syntheticTs = `${Math.floor(Date.now() / 1000)}.${String(Date.now()).slice(-6).padStart(6, "0")}`;

  try {
    const result = await runWithToolContext(
      { channelId: channel, threadKey, userId, userEmail },
      () => requestRegenerate(threadKey, syntheticTs, userId, userEmail, "slack"),
    );
    if (!result) {
      await client.chat.postEphemeral({
        channel,
        user: userId,
        thread_ts: threadTs,
        text: "I couldn’t find an active session to regenerate. Try sending a new message instead.",
      });
      return;
    }
    await postAgentReply(
      client,
      channel,
      threadTs,
      threadKey,
      result.text,
      result.sessionFilename,
    );
    await client.chat.postEphemeral({
      channel,
      user: userId,
      thread_ts: threadTs,
      text: "I’ve posted a regenerated response above. Let me know if that’s better!",
    });
  } catch (err) {
    console.error("Regenerate error:", err);
    await client.chat.postEphemeral({
      channel,
      user: userId,
      thread_ts: threadTs,
      text: "Sorry, I wasn’t able to regenerate the response. Please try again in a moment.",
    });
  }
}

app.action("regenerate_response", handleRegenerateResponse as never);

/**
 * Emoji reaction handler: users can react to Moon Bot responses with 👍/👎,
 * 🔄, or ❓ to provide feedback, reset the thread, or get help without tapping
 * buttons. This makes Moon Bot feel native in Slack and supports quick mobile
 * interactions.
 */
export async function handleReactionAdded({
  event,
  client,
}: SlackEventMiddlewareArgs<"reaction_added"> & AllMiddlewareArgs): Promise<void> {
  const reactionEvent = event as unknown as {
    user?: string;
    reaction?: string;
    item?: { type: string; channel?: string; ts?: string };
  };
  const reaction = reactionEvent.reaction;
  if (!reaction) return;

  const userId = reactionEvent.user;
  const item = reactionEvent.item;
  if (!item || item.type !== "message" || !item.channel || !item.ts || !userId) return;

  if (!(await assertUserCanInteract(client, userId, item.channel))) return;

  const threadKey = getTrackedThreadKey(item.channel, item.ts);
  if (!threadKey) return; // reaction was not on a tracked Moon Bot message

  if (reaction === "+1") {
    const sessionFilename = await getSessionFilenameByThreadKey(threadKey);
    recordFeedback({
      ts: new Date().toISOString(),
      kind: "helpful",
      userId,
      channel: item.channel,
      messageTs: item.ts,
      threadKey,
      sessionFilename,
    });
    await client.chat.postEphemeral({
      channel: item.channel,
      user: userId,
      text: "Thanks for the feedback! 🌙",
    });
    return;
  }

  if (reaction === "-1") {
    const sessionFilename = await getSessionFilenameByThreadKey(threadKey);
    recordFeedback({
      ts: new Date().toISOString(),
      kind: "not_helpful",
      userId,
      channel: item.channel,
      messageTs: item.ts,
      threadKey,
      sessionFilename,
    });
    await client.chat.postEphemeral({
      channel: item.channel,
      user: userId,
      text: "Thanks — we’ll use this to improve Moon Bot.",
    });
    return;
  }

  if (reaction === "arrows_counterclockwise") {
    const existed = await resetThread(threadKey);
    await client.chat.postEphemeral({
      channel: item.channel,
      user: userId,
      text: existed
        ? "Got it — this thread has been reset. Your next message will start a fresh session."
        : "This thread was not active, so there was nothing to reset.",
    });
    return;
  }

  if (reaction === "question") {
    const helpText = await helpTool.run({ topic: "general" });
    await client.chat.postEphemeral({
      channel: item.channel,
      user: userId,
      text: `*Moon Bot help* 🌙\n${helpText}`,
    });
    return;
  }
}

app.event("reaction_added", handleReactionAdded as never);

/**
 * Welcome users when Moon Bot is invited to a public/private channel.
 * This gives new channels an immediate pointer to /moonbot help and @-mentions
 * without waiting for a first message, which improves the Slack sandbox demo UX.
 */
export async function handleMemberJoinedChannel({
  event,
  client,
}: SlackEventMiddlewareArgs<"member_joined_channel"> & AllMiddlewareArgs): Promise<void> {
  const userId = (event as { user?: string }).user;
  const channel = (event as { channel?: string }).channel;
  if (!userId || !channel) return;

  const botUserId = await ensureBotUserId(client);
  if (!botUserId || userId !== botUserId) return;

  await safePostMessage(
    client,
    {
      channel,
      text:
        "Hi! 🌙 I’m Moon Bot, your engineering assistant inside Slack. " +
        "Mention me in a thread, send me a DM, type `/moonbot help` for commands, " +
        "or open me from the Slack AI assistant panel.",
    },
    { retries: cfg.slack.sayRetries, baseDelayMs: cfg.slack.sayRetryBaseMs },
  );
}

app.event("member_joined_channel", handleMemberJoinedChannel as never);

app.error(async (error) => {
  console.error("Slack app error:", error);
});
