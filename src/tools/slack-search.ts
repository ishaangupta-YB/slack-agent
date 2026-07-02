import { z } from "zod";
import { cfg } from "../config.js";
import { getToolContext } from "../context.js";
import { truncateOutput } from "./types.js";
import type { Tool } from "./types.js";

const SLACK_API_BASE = "https://slack.com/api";

const searchSlackParams = z.object({
  query: z.string().describe("Natural-language or keyword search query."),
  limit: z.number().int().min(1).max(20).default(5),
  channel_types: z
    .array(z.enum(["public_channel", "private_channel", "mpim", "im"]))
    .optional()
    .describe("Channel types to search."),
  content_types: z
    .array(z.enum(["messages", "files", "channels", "users"]))
    .optional()
    .describe("Content types to include."),
  after: z.number().optional().describe("UNIX timestamp lower bound."),
  before: z.number().optional().describe("UNIX timestamp upper bound."),
  include_context_messages: z.boolean().default(false),
  sort: z.enum(["score", "timestamp"]).default("score"),
  sort_dir: z.enum(["asc", "desc"]).default("desc"),
});

interface SlackSearchResultItem {
  permalink?: string;
  content?: string;
  text?: string;
  title?: string;
  name?: string;
  channel_name?: string;
  author_name?: string;
  message_ts?: string;
  file_id?: string;
  context_messages?: {
    before?: Array<{ text?: string; user_id?: string; ts?: string }>;
    after?: Array<{ text?: string; user_id?: string; ts?: string }>;
  };
}

interface SlackSearchResponse {
  ok: boolean;
  error?: string;
  results?: {
    messages?: SlackSearchResultItem[];
    files?: SlackSearchResultItem[];
    channels?: SlackSearchResultItem[];
    users?: SlackSearchResultItem[];
  };
  response_metadata?: { next_cursor?: string };
}

function pickToken(): { token: string; actionToken?: string } | undefined {
  const { actionToken } = getToolContext();
  if (cfg.slack.botToken && actionToken) {
    return { token: cfg.slack.botToken, actionToken };
  }
  if (cfg.slack.userToken) {
    return { token: cfg.slack.userToken };
  }
  return undefined;
}

function formatSearchResult(result: SlackSearchResponse, query: string): string {
  if (!result.ok) {
    return `Slack search failed: ${result.error ?? "unknown error"}`;
  }

  const parts: string[] = [];
  parts.push(`Results for "${query}":`);

  const messages = result.results?.messages ?? [];
  if (messages.length > 0) {
    parts.push("**Messages**");
    for (const m of messages) {
      const preview = (m.content ?? m.text ?? "(no preview)").replace(/\n+/g, " ");
      parts.push(`- ${preview} — <${m.permalink ?? "#"}|view> (${m.author_name ?? "unknown"} in #${m.channel_name ?? "?"})`);
    }
  }

  const files = result.results?.files ?? [];
  if (files.length > 0) {
    parts.push("**Files**");
    for (const f of files) {
      parts.push(`- ${f.title ?? f.name ?? "(file)"} — <${f.permalink ?? "#"}|view>`);
    }
  }

  const channels = result.results?.channels ?? [];
  if (channels.length > 0) {
    parts.push("**Channels**");
    for (const c of channels) {
      parts.push(`- #${c.name ?? "?"} — <${c.permalink ?? "#"}|view>`);
    }
  }

  const users = result.results?.users ?? [];
  if (users.length > 0) {
    parts.push("**Users**");
    for (const u of users) {
      parts.push(`- ${u.name ?? "?"}`);
    }
  }

  if (messages.length + files.length + channels.length + users.length === 0) {
    parts.push("No results found.");
  }

  if (result.response_metadata?.next_cursor) {
    parts.push("(more results available via pagination)");
  }

  return parts.join("\n\n");
}

async function searchSlack(input: z.infer<typeof searchSlackParams>): Promise<string> {
  const tokenInfo = pickToken();
  if (!tokenInfo) {
    return "Slack search is not configured. Set SLACK_USER_TOKEN, or ensure the bot is invoked with an action_token and SLACK_BOT_TOKEN is set.";
  }

  const body: Record<string, unknown> = {
    query: input.query,
    limit: input.limit,
    sort: input.sort,
    sort_dir: input.sort_dir,
    include_context_messages: input.include_context_messages,
  };

  if (tokenInfo.actionToken) {
    body.action_token = tokenInfo.actionToken;
  }
  if (input.channel_types && input.channel_types.length > 0) {
    body.channel_types = input.channel_types.join(",");
  }
  if (input.content_types && input.content_types.length > 0) {
    body.content_types = input.content_types.join(",");
  }
  if (input.after !== undefined) {
    body.after = input.after;
  }
  if (input.before !== undefined) {
    body.before = input.before;
  }

  const { channelId } = getToolContext();
  if (channelId) {
    body.context_channel_id = channelId;
  }

  try {
    const resp = await fetch(`${SLACK_API_BASE}/assistant.search.context`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenInfo.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    const data = (await resp.json()) as SlackSearchResponse;
    const formatted = formatSearchResult(data, input.query);
    return truncateOutput(formatted, 8_000);
  } catch (err) {
    return `Slack search request failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const searchSlackTool: Tool = {
  name: "search_slack",
  description:
    "Search across Slack messages, files, channels, and users using the Slack Real-Time Search API (assistant.search.context). Requires SLACK_USER_TOKEN or a bot token plus an action_token from a Slack AI event.",
  params: searchSlackParams,
  tier: "basic",
  run: searchSlack,
};
