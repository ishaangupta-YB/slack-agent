import { readFileSync } from "node:fs";
import { cfg } from "../config.js";
import { loadSkills } from "../skills/loader.js";
import { getToolContext } from "../context.js";
import { z } from "zod";

const statusParams = z.object({});

function isConfigured(value: string | undefined): string {
  return value && value.trim().length > 0 ? "configured" : "not configured";
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const statusTool = {
  name: "system_status",
  description:
    "Report Moon Bot's current configuration, enabled integrations, scheduled tasks, and security posture. Useful for health-checking the bot during setup or demos.",
  tier: "basic" as const,
  githubBot: true,
  params: statusParams,
  run: async (): Promise<string> => {
    const skills = loadSkills();
    const mcpServers = cfg.mcp.serversRaw
      ? `${Object.keys(JSON.parse(cfg.mcp.serversRaw) as Record<string, unknown>).length} MCP server(s)`
      : "none";

    const userTier = getToolContext().tier;
    const tierSource = cfg.okta.userTiers
      ? "USER_TIERS mapping"
      : cfg.okta.domain && cfg.okta.apiToken
        ? "Okta group lookup"
        : "default tier only";

    const lines = [
      `*Moon Bot status* 🌙`,
      ``,
      `*Version:* ${packageVersion()}`,
      `*Model:* ${cfg.cloudflare.model}${
        cfg.cloudflare.fallbackModel ? ` (fallback: ${cfg.cloudflare.fallbackModel})` : ""
      }`,
      `*LLM timeout:* ${cfg.cloudflare.timeoutMs}ms`,
      `*LLM retries:* ${cfg.cloudflare.retries}`,
      `*Memory context entries:* ${cfg.agent.memoryContextEntries}`,
      `*Max context messages:* ${cfg.agent.maxContextMessages === 0 ? "unlimited" : cfg.agent.maxContextMessages}`,
      `*Mode:* ${cfg.githubBot.enabled ? "GitHub-only bot" : "Socket Mode + Slack AI Assistant"}`,
      `*Slack message retries:* ${cfg.slack.sayRetries} (base delay ${cfg.slack.sayRetryBaseMs}ms)`,
      `*Loaded skills:* ${skills.map((s) => s.name).join(", ")}`,
      `*MCP servers:* ${mcpServers}`,
      `*Default access tier:* ${cfg.okta.defaultTier}`,
      `*Tier resolution:* ${tierSource}${userTier ? ` (your tier: ${userTier})` : ""}`,
      ``,
      `*Integrations:*`,
      `• GitHub static token: ${isConfigured(cfg.integrations.githubToken)}`,
      `• GitHub App auth: ${cfg.integrations.githubApp.appId ? "configured" : "not configured"}`,
      `• GitHub API retries: ${cfg.integrations.githubApiRetries} (base delay ${cfg.integrations.githubApiRetryBaseMs}ms, timeout ${cfg.integrations.githubApiTimeoutMs}ms)`,
      `• Elasticsearch: ${isConfigured(cfg.integrations.esUrl)}`,
      `• MongoDB: ${isConfigured(cfg.integrations.mongoUri)}`,
      `• AWS Athena: ${isConfigured(cfg.integrations.awsAccessKeyId)}`,
      `• Plausible: ${isConfigured(cfg.integrations.plausibleApiKey)}`,
    `• Sizzle data: ${isConfigured(cfg.integrations.sizzleDataDir)}`,
    `• HuggingFace Bucket: ${cfg.hf.token && cfg.hf.bucketRepo ? cfg.hf.bucketRepo : "not configured (local filesystem bucket in use)"}`,
    `• Bucket server: ${cfg.storage.enableBucketServer ? `${cfg.storage.bucketHttpHost}:${cfg.storage.bucketHttpPort}` : "disabled"}`,
    ``,
    `*Scheduled tasks:*`,
      `• Weekly report channel: ${cfg.scheduler.weeklyReportChannel || "disabled"}`,
      `• Deploy monitor channel: ${cfg.scheduler.deployChannel || "disabled"}`,
      `• Public status monitor channel: ${cfg.scheduler.statusMonitorChannel || "disabled"} (${cfg.scheduler.statusMonitorPages.length} page(s)${cfg.scheduler.statusMonitorChannel ? ", restart-safe state" : ""})`,
      ``,
      `*Security:*`,
      `• Guest accounts: ${cfg.security.allowGuests ? "allowed" : "refused"}`,
      `• Bash execution: ${cfg.security.allowBash ? "enabled" : "disabled"}`,
      `• Bash tier sandboxing: ${Object.values(cfg.bash.tierUsers).some(Boolean) ? Object.entries(cfg.bash.tierUsers).filter(([, u]) => u).map(([t, u]) => `${t}=${u}`).join(", ") : "not configured"}`,
      `• Security audit log: ${cfg.security.auditLogFile || "default location"}`,
      `• Local credential proxies: ES ${cfg.integrations.esProxyToken ? "on" : "off"}, Plausible ${cfg.integrations.plausibleProxyToken ? "on" : "off"}, HF ${cfg.integrations.hfProxyToken ? "on" : "off"}`,
    ];

    return lines.join("\n");
  },
};
