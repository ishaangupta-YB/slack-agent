import "dotenv/config";
import { WebClient } from "@slack/web-api";
import { cfg } from "../src/config.js";

export interface VerifyCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
}

function looksLikeTestToken(token: string): boolean {
  return token.includes("-test") || token.startsWith("xoxb-0000000") || token.startsWith("xapp-0000000");
}

async function callSlack<T>(
  fn: () => Promise<T>,
  checkName: string,
  success: (result: T) => string,
): Promise<VerifyCheck> {
  try {
    const result = await fn();
    const anyResult = result as { ok?: boolean; error?: string };
    if (anyResult.ok === false) {
      return { name: checkName, ok: false, message: anyResult.error ?? "Slack API returned ok=false" };
    }
    return { name: checkName, ok: true, message: success(result as T) };
  } catch (err) {
    return {
      name: checkName,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface VerifyClients {
  bot?: WebClient;
  app?: WebClient;
}

/**
 * Verify Slack connectivity and scopes using the Slack Web API.
 *
 * The checks exercise the same credentials that `src/app.ts` uses at runtime,
 * so passing verification gives high confidence the bot will start and post
 * messages successfully. Each check is independent: a user-token failure does
 * not mask a bot-token success.
 */
export async function verifySlack(clients?: VerifyClients): Promise<VerifyResult> {
  const botToken = cfg.slack.botToken;
  const appToken = cfg.slack.appToken;
  const userToken = cfg.slack.userToken;

  const botClient = clients?.bot ?? new WebClient(botToken);
  const appClient = clients?.app ?? new WebClient(appToken);
  const checks: VerifyCheck[] = [];

  // Bot auth.test validates the token and surfaces the installed workspace.
  checks.push(
    await callSlack(
      () => botClient.auth.test(),
      "bot_auth",
      (r) =>
        `Authenticated as ${r.user ?? "unknown"} (${r.user_id ?? "unknown"})` +
        ` in workspace ${r.team ?? "unknown"}`,
    ),
  );

  // App-level auth.test validates the xapp token used for Socket Mode. A
  // correct bot token is not enough — Socket Mode also needs a valid app token.
  checks.push(
    await callSlack(
      () => appClient.auth.test(),
      "app_auth",
      (r) =>
        `Socket Mode app token OK${r.app_id ? ` (app ${r.app_id})` : ""}` +
        ` in workspace ${r.team ?? "unknown"}`,
    ),
  );

  // conversations.list validates the channels:read scope, which is required
  // for search and for the deploy monitor to resolve channel IDs.
  checks.push(
    await callSlack(
      () => botClient.conversations.list({ types: "public_channel,private_channel" }),
      "channels_read",
      (r) => {
        const channels = (r as { channels?: Array<{ name?: string }> }).channels ?? [];
        return `channels:read scope OK — ${channels.length} channel(s) visible`;
      },
    ),
  );

  // chat.postMessage to a known channel validates chat:write. We only do this
  // when TEST_CHANNEL is set so the check is opt-in and non-spammy.
  const testChannel = process.env.VERIFY_SLACK_TEST_CHANNEL;
  if (testChannel) {
    checks.push(
      await callSlack(
        () =>
          botClient.chat.postMessage({
            channel: testChannel,
            text: "Moon Bot connectivity check — posting to this channel works.",
          }),
        "chat_write",
        () => `chat:write scope OK — posted to ${testChannel}`,
      ),
    );
  }

  if (userToken) {
    const userClient = new WebClient(userToken);
    checks.push(
      await callSlack(
        () => userClient.auth.test(),
        "user_auth",
        (r) =>
          `User token valid for ${r.user ?? "unknown"} (${r.user_id ?? "unknown"})` +
          ` in workspace ${r.team ?? "unknown"}`,
      ),
    );
  }

  return { ok: checks.every((c) => c.ok), checks };
}

function formatReport(result: VerifyResult): void {
  console.log("Moon Bot Slack connectivity verification\n");
  for (const check of result.checks) {
    const icon = check.ok ? "✅" : "❌";
    console.log(`${icon} ${check.name}: ${check.message}`);
  }
  console.log("");
  if (result.ok) {
    console.log("All Slack connectivity checks passed. The bot should start and respond correctly.");
  } else {
    console.log("Some Slack connectivity checks failed. Fix the issues above before Slack testing.");
  }
}

async function main(): Promise<void> {
  if (looksLikeTestToken(cfg.slack.botToken) || looksLikeTestToken(cfg.slack.appToken)) {
    console.log("Moon Bot Slack connectivity verification\n");
    console.log(
      "❌ tokens: Slack tokens look like placeholders. Configure real SLACK_BOT_TOKEN and SLACK_APP_TOKEN from your Slack app.",
    );
    process.exit(1);
  }
  const result = await verifySlack();
  formatReport(result);
  process.exit(result.ok ? 0 : 1);
}

import { pathToFileURL } from "node:url";

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
