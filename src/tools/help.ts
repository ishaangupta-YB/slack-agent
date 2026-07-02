import { z } from "zod";
import type { Tool } from "./types.js";
import { cfg } from "../config.js";

const params = z.object({
  topic: z
    .enum(["general", "code", "data", "slack"])
    .optional()
    .default("general"),
});

export const helpTool: Tool = {
  name: "moon_help",
  description:
    "Show a concise help message describing Moon Bot capabilities. Invoke this when the user greets the bot, asks for help, asks what it can do, or requests examples.",
  params,
  tier: "basic",
  run(input) {
    const model = cfg.cloudflare.model;
    const bucketMode = cfg.hf.token && cfg.hf.bucketRepo ? "HuggingFace Bucket" : "Local filesystem";

    const header =
      `👋 Hi! I’m **Moon Bot**, a Slack-native engineering assistant powered by \`${model}\`.\n\n` +
      `I run in Socket Mode and keep every conversation in its own thread so I can remember context across messages and restarts. Session artifacts are stored in a **${bucketMode}** bucket.\n`;

    const sections: Record<string, string> = {
      general:
        `**What I can help with**\n` +
        `• Code Q&A across cloned repos\n` +
        `• GitHub PRs, issue filing, and follow-up commits\n` +
        `• Elasticsearch, MongoDB, AWS Athena, and DuckDB/Sizzle queries\n` +
        `• Plausible traffic analytics, public status pages, and Slack real-time search\n` +
        `• Weekly ops reports, deploy-impact monitoring, and proactive public status monitoring\n\n` +
        `**How to talk to me**\n` +
        `• Mention me in a channel: \`@Moon Bot <your question>\`\n` +
        `• Send me a direct message — no mention needed\n` +
        `• Open the Slack AI Assistant panel and start a thread with me\n\n` +
        `Type one of these to dig deeper:\n` +
        `• \`help code\` — code navigation and PRs\n` +
        `• \`help data\` — databases, logs, and analytics\n` +
        `• \`help slack\` — Slack search and workspace tools\n\n` +
        `**Slash commands**\n` +
        `• \`/moonbot help\` — this message\n` +
        `• \`/moonbot status\` — current configuration\n` +
        `• \`/moonbot diagnose\` — pre-flight configuration check\n` +
        `• \`/moonbot ping\` — live LLM connectivity check\n` +
        `• \`/moonbot whoami\` — your access tier and guest status\n` +
        `• \`/moonbot report weekly\` — weekly ops report on demand\n` +
        `• \`/moonbot report deploy\` — deploy impact check on demand\n\n` +
        `Every reply includes buttons linking to the full response markdown and the session trace.`,

      code:
        `**Code & GitHub**\n` +
        `• \`search_code\` — search cloned repos by file path or content\n` +
        `• \`read_file\` / \`write_file\` / \`edit_file\` — inspect and modify code in the workspace\n` +
        `• \`clone_repo\` — clone a GitHub repo into the workspace\n` +
        `• \`open_pr\` / \`commit_to_pr\` / \`create_issue\` — open PRs/issues and push follow-up commits\n\n` +
        `**Example prompts**\n` +
        `• “Search the Hub repo for how Gitaly timeouts are handled.”\n` +
        `• “Clone huggingface/hub and find the function that validates repo IDs.”\n` +
        `• “Open a PR in my-org/my-repo that updates the README title.”\n\n` +
        `PRs include a standard footer with the requester and a link back to this Slack thread.`,

      data:
        `**Data & analytics** *(availability depends on your access tier)*\n` +
        `• \`es_query\` — Elasticsearch log analysis\n` +
        `• \`mongo_query\` — MongoDB queries\n` +
        `• \`athena_query\` — AWS ALB/WAF/CloudFront logs via Athena\n` +
        `• \`sizzle_query\` — DuckDB queries over Xet/Sizzle DuckLake files\n` +
        `• \`plausible_query\` — privacy-preserving traffic analytics\n` +
        `• \`public_status\` — check public status pages for civic/nonprofit services\n\n` +
        `**Example prompts**\n` +
        `• “How many 5xx errors did we see in the last hour?”\n` +
        `• “Show me the top 10 Plausible pages for docs this week.”\n` +
        `• “Query Athena for ALB 5xx rate in the last 30 minutes.”\n` +
        `• “Check the status page for status.cloudflare.com.”`,

      slack:
        `**Slack tools**\n` +
        `• \`search_slack\` — Real-Time Search API for workspace history\n` +
        `• \`memory\` — recall recent interactions or search past threads\n` +
        `• \`weekly_report\` / \`deploy_report\` — generate ops reports on demand\n` +
        `• \`system_status\` — show my current configuration and enabled integrations\n\n` +
        `**Automated reports**\n` +
        `• Weekly ops report (Mondays 09:00 UTC) — error rates, rate-limiting, Gitaly health\n` +
        `• Deploy monitor — watches the deploy channel and compares before/after error rates\n` +
        `• Public status monitor — watches civic/nonprofit service status pages and posts incident alerts\n` +
        `• Slash commands: \`/moonbot report weekly\`, \`/moonbot report deploy\`, \`/moonbot diagnose\`, \`/moonbot ping\`, or \`/moonbot whoami\`\n\n` +
        `**Example prompts**\n` +
        `• “Search Slack for recent deployment discussions.”\n` +
        `• “Run the weekly report.”\n` +
        `• “Show me your system status.”`,
    };

    const privacy =
      `\n\n_Access to data tools is governed by your access tier. Guests are not allowed to use Moon Bot unless explicitly configured._`;

    return `${header}\n\n${sections[input.topic]}${privacy}`;
  },
};
