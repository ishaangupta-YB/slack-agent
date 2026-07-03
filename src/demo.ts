/**
 * Curated demo prompts for the Slack Agent Builder Challenge.
 *
 * `/moonbot demo` surfaces copy-paste prompts that exercise the three
 * mandatory technologies (Slack AI capabilities, MCP, Real-Time Search API),
 * data/ops tools, and the Agent for Good track directly in Slack.
 */

export function getDemoMessage(): string {
  return (
    `*Moon Bot demo prompts* 🎬\n` +
    `Copy any prompt to try a capability the judges care about.\n\n` +

    `*Slack AI Assistant + Real-Time Search API*\n` +
    `• Open the Slack AI Assistant panel and ask:\n` +
    `  “Search Slack for recent deployment discussions and summarize what changed.”\n` +
    `• Or in any channel: \`/moonbot search deployment discussions\`\n\n` +

    `*MCP server integration*\n` +
    `• With an MCP filesystem server configured, ask:\n` +
    `  “List the files in /tmp and tell me which ones were modified today.”\n\n` +

    `*Code Q&A + GitHub + HuggingFace Hub*\n` +
    `• \`@Moon Bot clone huggingface/hub and find the function that validates repo IDs.\`\n` +
    `• \`@Moon Bot what is the task for sentence-transformers/all-MiniLM-L6-v2?\`\n` +
    `• \`@Moon Bot open a draft PR in my-org/my-repo that adds a hello-world script.\`\n` +
    `• Then reply in the same thread: “Add a README note about the new script.”\n\n` +

    `*Data, ops, and monitoring*\n` +
    `• \`@Moon Bot how many 5xx errors did we see in the last hour?\`\n` +
    `• \`/moonbot report weekly\`\n` +
    `• \`/moonbot report deploy\`\n` +
    `• \`/moonbot statuspage https://status.cloudflare.com/api/v2/status.json\`\n\n` +

    `*Security + compliance*\n` +
    `• \`/moonbot audit\` — review recent security events if you have privileged access\n` +
    `• \`/moonbot whoami\` — confirm your access tier and guest status\n` +
    `• \`/moonbot diagnose\` — run pre-flight configuration checks\n\n` +

    `*Agent for Good — public service resilience*\n` +
    `• \`/moonbot impact\` — see which public services Moon Bot is monitoring and their current status\n` +
    `• \`Check the status page for status.cloudflare.com and tell me if any public services nonprofits rely on are degraded.\`\n` +
    `• \`File a GitHub issue in huggingface/moon-bot-slack-agent summarizing the degraded service.\`\n\n` +

    `*Workflow polish*\n` +
    `• Select any message → “Ask Moon Bot” for a threaded reply.\n` +
    `• \`/moonbot tools\` — see which tools are available to your access tier.\n` +
    `• On any reply, click *View trace* to see the full agent reasoning timeline.\n` +
    `• Click *Start over* to clear the thread session and begin fresh.\n` +
    `• Click 👍 / 👎 or react with 👍 / 👎 / 🔄 / ❓ to record feedback, reset, or get help.`
  );
}
