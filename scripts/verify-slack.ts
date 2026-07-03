import "dotenv/config";
import { readFileSync } from "node:fs";
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

/**
 * Load the bot OAuth scopes declared in the local manifest.json. These are the
 * scopes the app should have installed in the workspace.
 */
function loadManifestBotScopes(): string[] {
  try {
    const raw = readFileSync("manifest.json", "utf-8");
    const manifest = JSON.parse(raw) as {
      oauth_config?: { scopes?: { bot?: string[] } };
    };
    return manifest.oauth_config?.scopes?.bot ?? [];
  } catch {
    return [];
  }
}

function compareScopes(actual: string[], expected: string[]): { missing: string[]; extra: string[] } {
  const missing = expected.filter((s) => !actual.includes(s));
  const extra = actual.filter((s) => !expected.includes(s));
  return { missing, extra };
}

/**
 * Compare the bot token's actual granted scopes with the scopes required by
 * manifest.json. This catches stale app installs after the manifest has been
 * updated, which is a common source of Slack runtime failures.
 */
async function verifyManifestScopes(client: WebClient): Promise<VerifyCheck> {
  const expected = loadManifestBotScopes();
  if (expected.length === 0) {
    return { name: "manifest_scopes", ok: false, message: "Could not read bot scopes from manifest.json" };
  }

  let result: Awaited<ReturnType<typeof client.auth.test>>;
  try {
    result = await client.auth.test();
  } catch (err) {
    return {
      name: "manifest_scopes",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const anyResult = result as { ok?: boolean; error?: string; scopes?: string[] };
  if (anyResult.ok === false) {
    return { name: "manifest_scopes", ok: false, message: anyResult.error ?? "auth.test returned ok=false" };
  }

  const actual = anyResult.scopes ?? [];
  const { missing, extra } = compareScopes(actual, expected);
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
    if (extra.length > 0) parts.push(`extra: ${extra.join(", ")}`);
    return {
      name: "manifest_scopes",
      ok: false,
      message: `Installed scopes do not match manifest.json (${parts.join("; ")}) — reinstall the app from manifest.json`,
    };
  }

  return {
    name: "manifest_scopes",
    ok: true,
    message: `Installed bot scopes match manifest.json (${actual.length} scope(s))`,
  };
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

/**
 * Verify that the app-level token can open a Socket Mode connection.
 *
 * This calls `apps.connections.open`, which is exactly what Bolt does under the
 * hood to obtain a WebSocket URL. If the call succeeds, both the app token's
 * `connections:write` scope and the app's Socket Mode setting are confirmed.
 */
async function verifySocketModeConnection(client: WebClient): Promise<VerifyCheck> {
  try {
    const result = await client.apps.connections.open();
    const anyResult = result as { ok?: boolean; error?: string; url?: string };
    if (anyResult.ok === false) {
      const error = anyResult.error ?? "apps.connections.open returned ok=false";
      let hint = "";
      if (error === "missing_scope") {
        hint = " — the app-level token must be granted the connections:write scope";
      } else if (error === "not_allowed") {
        hint = " — Socket Mode must be enabled for this Slack app";
      }
      return { name: "socket_mode", ok: false, message: `${error}${hint}` };
    }
    return {
      name: "socket_mode",
      ok: true,
      message: anyResult.url
        ? "Socket Mode connection URL generated successfully"
        : "Socket Mode connection check succeeded",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: "socket_mode", ok: false, message };
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

  // Verify the app token can actually open a Socket Mode connection. This is
  // the same call Bolt makes at startup, so success here means Socket Mode
  // will connect successfully.
  checks.push(await verifySocketModeConnection(appClient));

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

  // Verify the installed bot token grants exactly the scopes declared in
  // manifest.json. This catches stale installs after the manifest is updated.
  checks.push(await verifyManifestScopes(botClient));

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
