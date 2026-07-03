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
  githubBot: true,
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
        `• \`/moonbot demo\` — curated hackathon demo prompts\n` +
        `• \`/moonbot tools\` — tools available to your access tier\n` +
        `• \`/moonbot status\` — current configuration\n` +
        `• \`/moonbot metrics\` — runtime usage metrics\n` +
        `• \`/moonbot diagnose\` — pre-flight configuration check\n` +
        `• \`/moonbot audit [limit]\` — view recent security audit events (privileged only)\n` +
        `• \`/moonbot ping\` — live LLM connectivity check\n` +
        `• \`/moonbot whoami\` — your access tier and guest status\n` +
        `• \`/moonbot thread\` — your current DM session info\n` +
        `• \`/moonbot remember <fact>\` — save a fact for future conversations\n` +
        `• \`/moonbot memory [limit]\` — recall recent remembered facts\n` +
        `• \`/moonbot forget <text|all>\` — remove remembered facts\n` +
        `• \`/moonbot search <query>\` — search Slack history with the Real-Time Search API\n` +
        `• \`/moonbot report weekly\` — weekly ops report on demand\n` +
        `• \`/moonbot report deploy\` — deploy impact check on demand\n` +
        `• \`/moonbot statuspage <url>\` — check a public service status page on demand\n` +
        `• \`/moonbot impact\` — public service status monitoring for the Agent for Good track\n\n` +
        `Every reply includes buttons linking to the full response markdown and the session trace.\n` +
        `Click 👍 / 👎 to give feedback; after a thumbs-down, you can tap *Regenerate response* to ask me to try again.\n` +
        `You can also react with :+1:/:-1: (feedback), :arrows_counterclockwise: (reset thread), or :question: (show help).`,

      code:
        `**Code & GitHub**\n` +
        `• \`search_code\` — search cloned repos by file path or content\n` +
        `• \`read_file\` / \`write_file\` / \`edit_file\` — inspect and modify code in the workspace\n` +
        `• \`list_files\` — browse directories in a cloned repo\n` +
        `• \`clone_repo\` — clone a GitHub repo into the workspace\n` +
        `• \`open_pr\` / \`commit_to_pr\` / \`create_issue\` / \`comment_on_issue\` — open PRs/issues, push follow-up commits, and post comments\n` +
        `• \`search_issues\` — search GitHub issues/PRs to avoid duplicates and find related work\n` +
        `• \`get_pr_diff\` — fetch changed files and diff patches for a pull request review\n` +
        `• \`hf_hub_info\` — look up metadata for a HuggingFace Hub model, dataset, or Space\n\n` +
        `**Example prompts**\n` +
        `• “Search the Hub repo for how Gitaly timeouts are handled.”\n` +
        `• “Clone huggingface/hub and find the function that validates repo IDs.”\n` +
        `• “Review the diff for huggingface/hub#1234.”\n` +
        `• “What is the task for sentence-transformers/all-MiniLM-L6-v2?”\n` +
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
        `• Public status monitor — watches civic/nonprofit service status pages and posts incident and recovery alerts\n` +
        `• Slash commands: \`/moonbot search <query>\`, \`/moonbot report weekly\`, \`/moonbot report deploy\`, \`/moonbot statuspage <url>\`, \`/moonbot impact\`, \`/moonbot status\`, \`/moonbot metrics\`, \`/moonbot diagnose\`, \`/moonbot tools\`, \`/moonbot audit [limit]\` (privileged), \`/moonbot ping\`, \`/moonbot remember <fact>\`, \`/moonbot memory [limit]\`, \`/moonbot forget <text|all>\`, or \`/moonbot whoami\`\n\n` +
        `**Example prompts**\n` +
        `• “Search Slack for recent deployment discussions.”\n` +
        `• “Run the weekly report.”\n` +
        `• “Show me your system status.”\n` +
        `• “Check the status page for status.cloudflare.com.”\n\n` +
        `**Emoji reactions**\n` +
        `React to any Moon Bot message with :+1: / :-1: for feedback, :arrows_counterclockwise: to reset the thread, or :question: for help.\n` +
        `After a thumbs-down feedback button, you can also choose *Regenerate response* to retry the answer.`,
    };

    const privacy =
      `\n\n_Access to data tools is governed by your access tier. Guests are not allowed to use Moon Bot unless explicitly configured._`;

    return `${header}\n\n${sections[input.topic]}${privacy}`;
  },
};
