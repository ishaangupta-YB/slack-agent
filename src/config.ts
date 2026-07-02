import { config } from "dotenv";
import { join } from "node:path";
config();

export const cfg = {
  slack: {
    botToken: requireEnv("SLACK_BOT_TOKEN"),
    appToken: requireEnv("SLACK_APP_TOKEN"),
    userToken: process.env.SLACK_USER_TOKEN || "",
  },
  cloudflare: {
    accountId: requireEnv("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: requireEnv("CLOUDFLARE_API_TOKEN"),
    model: process.env.CLOUDFLARE_MODEL || "@cf/moonshotai/kimi-k2.7-code",
    timeoutMs: parseInt(process.env.CLOUDFLARE_TIMEOUT_MS || "120000", 10),
    retries: parseInt(process.env.CLOUDFLARE_RETRIES || "2", 10),
  },
  agent: {
    sessionsDir: process.env.SESSIONS_DIR || "./sessions",
    memoryFile:
      process.env.MEMORY_FILE ||
      join(process.env.SESSIONS_DIR || "./sessions", "memory.json"),
    threadMapFile:
      process.env.THREAD_MAP_FILE ||
      join(process.env.SESSIONS_DIR || "./sessions", "thread-map.json"),
    maxMemoryEntries: parseInt(process.env.MAX_MEMORY_ENTRIES || "200", 10),
    systemPromptOverride: process.env.AGENT_SYSTEM_PROMPT_OVERRIDE,
  },
  code: {
    reposDir: process.env.CODE_REPOS_DIR || "./repos",
  },
  security: {
    allowBash: process.env.ALLOW_BASH === "true",
    allowGuests: process.env.ALLOW_GUESTS === "true",
    allowedUserIds: csv(process.env.ALLOWED_USER_IDS),
    adminUserIds: csv(process.env.ADMIN_USER_IDS),
    auditLogFile:
      process.env.SECURITY_AUDIT_LOG_FILE ||
      join(process.env.SESSIONS_DIR || "./sessions", "audit.jsonl"),
    slackAlertChannel: process.env.SLACK_SECURITY_ALERT_CHANNEL || "",
  },
  integrations: {
    githubToken: process.env.GITHUB_TOKEN,
    githubApp: {
      appId: process.env.GITHUB_APP_ID || "",
      privateKey: process.env.GITHUB_PRIVATE_KEY || "",
      installationId: process.env.GITHUB_INSTALLATION_ID || "",
    },
    githubUserMap: parseJsonMap(process.env.GITHUB_USER_MAP),
    plausibleApiKey: process.env.PLAUSIBLE_API_KEY,
    esUrl: process.env.ES_URL,
    esApiKey: process.env.ES_API_KEY,
    esUsername: process.env.ES_USERNAME,
    esPassword: process.env.ES_PASSWORD,
    esProxyPort: parseInt(process.env.ES_PROXY_PORT || "9201", 10),
    esProxyToken: process.env.ES_PROXY_TOKEN || "",
    plausibleProxyPort: parseInt(process.env.PLAUSIBLE_PROXY_PORT || "9203", 10),
    plausibleProxyToken: process.env.PLAUSIBLE_PROXY_TOKEN || "",
    plausibleUpstreamUrl: process.env.PLAUSIBLE_UPSTREAM_URL || "https://plausible.io",
    hfProxyPort: parseInt(process.env.HF_PROXY_PORT || "9202", 10),
    hfProxyToken: process.env.HF_PROXY_TOKEN || "",
    hfProxyRepo: process.env.HF_PROXY_REPO || "huggingface/storage-visualization-data",
    hfUpstreamUrl: process.env.HF_UPSTREAM_URL || "https://huggingface.co",
    mongoUri: process.env.MONGODB_URI,
    mongoDatabase: process.env.MONGODB_DATABASE,
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    awsSessionToken: process.env.AWS_SESSION_TOKEN,
    awsRegion: process.env.AWS_REGION || "us-east-1",
    sizzleDataDir: process.env.SIZZLE_DATA_DIR,
  },
  storage: {
    bucketDir: process.env.BUCKET_DIR || "./bucket",
    bucketPublicUrl: process.env.BUCKET_PUBLIC_URL || "",
    bucketHttpPort: parseInt(process.env.BUCKET_HTTP_PORT || "3001", 10),
    enableBucketServer: process.env.BUCKET_HTTP_PORT !== "0",
  },
  hf: {
    token: process.env.HF_TOKEN || "",
    bucketRepo: process.env.HF_BUCKET_REPO || "",
  },
  mcp: {
    serversRaw: process.env.MCP_SERVERS,
  },
  scheduler: {
    weeklyReportChannel: process.env.SCHEDULED_WEEKLY_REPORT_CHANNEL || "",
    deployChannel: process.env.SCHEDULED_DEPLOY_CHANNEL || "",
    deployMonitorDelayMs: parseInt(
      process.env.SCHEDULED_DEPLOY_MONITOR_DELAY_MS || "900000",
      10,
    ),
  },
  okta: {
    domain: process.env.OKTA_DOMAIN || "",
    apiToken: process.env.OKTA_API_TOKEN || "",
    privilegedGroups: csv(process.env.OKTA_PRIVILEGED_GROUPS),
    elasticGroups: csv(process.env.OKTA_ELASTIC_GROUPS),
    userTiers: process.env.USER_TIERS || "",
    defaultTier: normalizeTier(process.env.DEFAULT_ACCESS_TIER) || "basic",
  },
};

function parseJsonMap(value?: string): Record<string, string> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return {};
  }
}

function normalizeTier(value?: string): "basic" | "elastic" | "privileged" | undefined {
  const t = value?.toLowerCase().trim();
  if (t === "basic" || t === "elastic" || t === "privileged") return t;
  return undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function csv(value?: string): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}
