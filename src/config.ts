import { config } from "dotenv";
config();

export const cfg = {
  slack: {
    botToken: requireEnv("SLACK_BOT_TOKEN"),
    appToken: requireEnv("SLACK_APP_TOKEN"),
  },
  cloudflare: {
    accountId: requireEnv("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: requireEnv("CLOUDFLARE_API_TOKEN"),
    model: process.env.CLOUDFLARE_MODEL || "@cf/moonshotai/kimi-k2.7-code",
  },
  agent: {
    sessionsDir: process.env.SESSIONS_DIR || "./sessions",
    memoryFile: process.env.MEMORY_FILE || "./sessions/memory.json",
    threadMapFile: process.env.THREAD_MAP_FILE || "./sessions/thread-map.json",
    maxMemoryEntries: parseInt(process.env.MAX_MEMORY_ENTRIES || "200", 10),
    systemPromptOverride: process.env.AGENT_SYSTEM_PROMPT_OVERRIDE,
  },
  security: {
    allowBash: process.env.ALLOW_BASH === "true",
    allowedUserIds: csv(process.env.ALLOWED_USER_IDS),
    adminUserIds: csv(process.env.ADMIN_USER_IDS),
  },
  integrations: {
    githubToken: process.env.GITHUB_TOKEN,
    plausibleApiKey: process.env.PLAUSIBLE_API_KEY,
  },
  storage: {
    bucketDir: process.env.BUCKET_DIR || "./bucket",
    bucketPublicUrl: process.env.BUCKET_PUBLIC_URL || "",
    bucketHttpPort: parseInt(process.env.BUCKET_HTTP_PORT || "3001", 10),
    enableBucketServer: process.env.BUCKET_HTTP_PORT !== "0",
  },
};

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
