import type { WebClient } from "@slack/web-api";
import type { ViewsPublishArguments } from "@slack/web-api/dist/types/request/views.js";
import type { KnownBlock, HeaderBlock, SectionBlock, DividerBlock, ContextBlock } from "@slack/types";
import { cfg } from "./config.js";
import { statusTool } from "./tools/status.js";

function header(text: string): HeaderBlock {
  return {
    type: "header",
    text: { type: "plain_text", text, emoji: true },
  };
}

function section(markdown: string): SectionBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: markdown },
  };
}

function divider(): DividerBlock {
  return { type: "divider" };
}

function context(text: string): ContextBlock {
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text }],
  };
}

function capabilitiesBlock(): SectionBlock {
  const lines = [
    "*Ask Moon Bot to:*",
    "• Search code across cloned repos (`search_code`)",
    "• Open GitHub PRs and file issues (`open_pr`, `create_issue`)",
    "• Query Elasticsearch logs, MongoDB, AWS Athena, and Plausible analytics",
    "• Search Slack history in real time (`search_slack`)",
    "• Run safe shell commands and manage memory across threads",
    "• Discover tools from connected MCP servers",
  ];
  return section(lines.join("\n"));
}

function buildHomeBlocks(statusMarkdown: string): KnownBlock[] {
  const blocks: KnownBlock[] = [
    header("Moon Bot 🌙"),
    section(
      "Your engineering assistant inside Slack. Ask me about code, GitHub, metrics, ops tasks, or Slack history — right where your team already works.",
    ),
    divider(),
    capabilitiesBlock(),
    divider(),
    section(statusMarkdown),
    context(
      `Built for the Slack Agent Builder Challenge • Model: ${cfg.cloudflare.model} • <https://api.slack.com/|Slack API docs>`,
    ),
  ];

  return blocks;
}

/**
 * Publish the App Home view for a Slack user. The view is rendered from the
 * system status tool so it stays consistent with the bot's live configuration,
 * without exposing secrets.
 */
export async function publishHomeView(client: WebClient, userId: string): Promise<void> {
  try {
    const statusMarkdown = await statusTool.run();
    const blocks = buildHomeBlocks(statusMarkdown);
    const payload: ViewsPublishArguments = {
      user_id: userId,
      view: {
        type: "home",
        blocks,
      },
    };
    await client.views.publish(payload);
  } catch (error) {
    console.error("Failed to publish App Home view:", error instanceof Error ? error.message : String(error));
  }
}
