import { access, constants, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface DiagnosticCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
}

export interface DiagnosticResult {
  ok: boolean;
  checks: DiagnosticCheck[];
}

function env(name: string): string | undefined {
  return process.env[name];
}

function isSet(name: string): boolean {
  return Boolean(env(name)?.trim());
}

async function ensureDirWritable(path: string): Promise<boolean> {
  try {
    await mkdir(path, { recursive: true });
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function checkRequiredEnv(
  checks: DiagnosticCheck[],
  name: string,
  prefix?: string,
): void {
  const value = env(name);
  if (!value) {
    checks.push({ name, status: "fail", message: "Missing required environment variable" });
    return;
  }
  if (prefix && !value.startsWith(prefix)) {
    checks.push({ name, status: "warn", message: `Expected value to start with ${prefix}` });
    return;
  }
  checks.push({ name, status: "ok", message: "Set" });
}

function checkOptionalToken(
  checks: DiagnosticCheck[],
  name: string,
  prefix: string,
): void {
  const value = env(name);
  if (!value) {
    checks.push({ name, status: "warn", message: "Not set — related integration will be unavailable" });
    return;
  }
  if (!value.startsWith(prefix)) {
    checks.push({ name, status: "warn", message: `Expected value to start with ${prefix}` });
    return;
  }
  checks.push({ name, status: "ok", message: "Set" });
}

function checkOptionalUrl(checks: DiagnosticCheck[], name: string): void {
  const value = env(name);
  if (!value) {
    checks.push({ name, status: "warn", message: "Not set — related integration will be unavailable" });
    return;
  }
  try {
    new URL(value);
    checks.push({ name, status: "ok", message: "Set" });
  } catch {
    checks.push({ name, status: "warn", message: "Value does not look like a valid URL" });
  }
}

/**
 * Run a full configuration diagnostic against the current process environment.
 *
 * Returns a structured result that can be formatted for the CLI, Slack, or
 * other callers without printing to stdout. This keeps the diagnostic logic
 * reusable for both `npm run diagnose` and `/moonbot diagnose`.
 */
export async function runDiagnostics(): Promise<DiagnosticResult> {
  const checks: DiagnosticCheck[] = [];

  // Required core credentials
  checkRequiredEnv(checks, "SLACK_BOT_TOKEN", "xoxb-");
  checkRequiredEnv(checks, "SLACK_APP_TOKEN", "xapp-");
  checkOptionalToken(checks, "SLACK_USER_TOKEN", "xoxp-");
  checkRequiredEnv(checks, "CLOUDFLARE_ACCOUNT_ID");
  checkRequiredEnv(checks, "CLOUDFLARE_API_TOKEN");

  const model = env("CLOUDFLARE_MODEL") || "@cf/moonshotai/kimi-k2.7-code";
  if (model.startsWith("@cf/")) {
    checks.push({ name: "CLOUDFLARE_MODEL", status: "ok", message: model });
  } else {
    checks.push({ name: "CLOUDFLARE_MODEL", status: "warn", message: `${model} does not start with @cf/ — verify this model is available` });
  }

  const cfTimeout = parseInt(env("CLOUDFLARE_TIMEOUT_MS") || "120000", 10);
  const cfRetries = parseInt(env("CLOUDFLARE_RETRIES") || "2", 10);
  if (Number.isNaN(cfTimeout) || cfTimeout <= 0) {
    checks.push({ name: "CLOUDFLARE_TIMEOUT_MS", status: "warn", message: "Invalid timeout value; must be a positive number of milliseconds" });
  } else {
    checks.push({ name: "CLOUDFLARE_TIMEOUT_MS", status: "ok", message: `${cfTimeout}ms` });
  }
  if (Number.isNaN(cfRetries) || cfRetries < 0) {
    checks.push({ name: "CLOUDFLARE_RETRIES", status: "warn", message: "Invalid retry count; must be a non-negative integer" });
  } else {
    checks.push({ name: "CLOUDFLARE_RETRIES", status: "ok", message: `${cfRetries} retries` });
  }

  const slackSayRetries = parseInt(env("SLACK_SAY_RETRIES") || "2", 10);
  const slackSayRetryBaseMs = parseInt(env("SLACK_SAY_RETRY_BASE_MS") || "1000", 10);
  if (Number.isNaN(slackSayRetries) || slackSayRetries < 0) {
    checks.push({ name: "SLACK_SAY_RETRIES", status: "warn", message: "Invalid retry count; must be a non-negative integer" });
  } else {
    checks.push({ name: "SLACK_SAY_RETRIES", status: "ok", message: `${slackSayRetries} retries` });
  }
  if (Number.isNaN(slackSayRetryBaseMs) || slackSayRetryBaseMs <= 0) {
    checks.push({ name: "SLACK_SAY_RETRY_BASE_MS", status: "warn", message: "Invalid base delay; must be a positive number of milliseconds" });
  } else {
    checks.push({ name: "SLACK_SAY_RETRY_BASE_MS", status: "ok", message: `${slackSayRetryBaseMs}ms` });
  }

  // Writable state directories
  const sessionsDir = env("SESSIONS_DIR") || "./sessions";
  if (await ensureDirWritable(sessionsDir)) {
    checks.push({ name: "SESSIONS_DIR", status: "ok", message: `${sessionsDir} is writable` });
  } else {
    checks.push({ name: "SESSIONS_DIR", status: "fail", message: `${sessionsDir} is not writable` });
  }

  const bucketDir = env("BUCKET_DIR") || "./bucket";
  if (await ensureDirWritable(bucketDir)) {
    checks.push({ name: "BUCKET_DIR", status: "ok", message: `${bucketDir} is writable` });
  } else {
    checks.push({ name: "BUCKET_DIR", status: "fail", message: `${bucketDir} is not writable` });
  }

  const reposDir = env("CODE_REPOS_DIR") || "./repos";
  if (await ensureDirWritable(reposDir)) {
    checks.push({ name: "CODE_REPOS_DIR", status: "ok", message: `${reposDir} is writable` });
  } else {
    checks.push({ name: "CODE_REPOS_DIR", status: "warn", message: `${reposDir} is not writable — clone_repo/search_code may fail` });
  }

  const auditLogFile = env("SECURITY_AUDIT_LOG_FILE") || `${sessionsDir}/audit.jsonl`;
  try {
    await mkdir(dirname(auditLogFile), { recursive: true });
    checks.push({ name: "SECURITY_AUDIT_LOG_FILE", status: "ok", message: `${auditLogFile} directory is writable` });
  } catch {
    checks.push({ name: "SECURITY_AUDIT_LOG_FILE", status: "warn", message: "Cannot create audit log directory" });
  }

  // Security
  if (env("ALLOW_BASH") === "true") {
    checks.push({ name: "ALLOW_BASH", status: "warn", message: "bash execution is enabled — make sure the host is appropriately locked down" });
  } else {
    checks.push({ name: "ALLOW_BASH", status: "ok", message: "bash execution is disabled (safe default)" });
  }

  if (isSet("BASH_TIER_USERS")) {
    const pairs = env("BASH_TIER_USERS")!.split(",").map((p) => p.trim().split(":"));
    const validTiers = new Set(["basic", "elastic", "privileged"]);
    const invalid = pairs.filter(([t]) => !validTiers.has(t?.trim().toLowerCase()));
    if (invalid.length > 0) {
      checks.push({ name: "BASH_TIER_USERS", status: "warn", message: `Contains unrecognized tiers: ${invalid.map(([t]) => t).join(", ")}` });
    } else {
      checks.push({ name: "BASH_TIER_USERS", status: "ok", message: env("BASH_TIER_USERS")! });
    }
    if (process.getuid?.() !== 0) {
      checks.push({ name: "BASH_TIER_USERS", status: "warn", message: "Bash sandboxing requires the bot process to run as root unless BASH_REQUIRE_ROOT_FOR_SU=false" });
    }
  }

  if (env("ALLOW_GUESTS") === "true") {
    checks.push({ name: "ALLOW_GUESTS", status: "warn", message: "guest accounts are allowed — verify this matches your security policy" });
  } else {
    checks.push({ name: "ALLOW_GUESTS", status: "ok", message: "guest accounts are refused (safe default)" });
  }

  // GitHub
  const githubToken = isSet("GITHUB_TOKEN");
  const githubAppId = isSet("GITHUB_APP_ID");
  const githubPrivateKey = isSet("GITHUB_PRIVATE_KEY");
  const githubInstallationId = isSet("GITHUB_INSTALLATION_ID");
  if (githubAppId && githubPrivateKey && githubInstallationId) {
    checks.push({ name: "GitHub auth", status: "ok", message: "GitHub App authentication configured" });
  } else if (githubToken) {
    checks.push({ name: "GitHub auth", status: "ok", message: "Static GITHUB_TOKEN configured" });
  } else {
    checks.push({ name: "GitHub auth", status: "warn", message: "No GitHub credentials configured — GitHub tools will fail" });
  }
  if (githubAppId || githubPrivateKey || githubInstallationId) {
    if (!githubAppId || !githubPrivateKey || !githubInstallationId) {
      checks.push({ name: "GitHub App auth", status: "warn", message: "Partial GitHub App config; all of GITHUB_APP_ID, GITHUB_PRIVATE_KEY, and GITHUB_INSTALLATION_ID are needed" });
    }
  }
  if (isSet("GITHUB_USER_MAP")) {
    try {
      JSON.parse(env("GITHUB_USER_MAP")!);
      checks.push({ name: "GITHUB_USER_MAP", status: "ok", message: "Valid JSON" });
    } catch {
      checks.push({ name: "GITHUB_USER_MAP", status: "warn", message: "Invalid JSON — PR/issue footers will not include requester handle" });
    }
  } else {
    checks.push({ name: "GITHUB_USER_MAP", status: "warn", message: "Not set — PR/issue footers will not map to GitHub handles" });
  }

  // Optional integrations
  checkOptionalUrl(checks, "ES_URL");
  if (isSet("ES_URL")) {
    if (!isSet("ES_API_KEY") && !(isSet("ES_USERNAME") && isSet("ES_PASSWORD"))) {
      checks.push({ name: "Elasticsearch auth", status: "warn", message: "ES_URL set but no ES_API_KEY or ES_USERNAME+ES_PASSWORD — es_query will fail" });
    }
    if (!isSet("ES_PROXY_TOKEN")) {
      checks.push({ name: "ES_PROXY_TOKEN", status: "warn", message: "Running without local ES credential proxy — upstream key may be exposed to tools" });
    }
  }

  checkOptionalToken(checks, "PLAUSIBLE_API_KEY", "plausible_");
  if (isSet("PLAUSIBLE_API_KEY") && !isSet("PLAUSIBLE_PROXY_TOKEN")) {
    checks.push({ name: "PLAUSIBLE_PROXY_TOKEN", status: "warn", message: "Plausible key set but no proxy token — upstream key may be exposed to tools" });
  }

  checkOptionalUrl(checks, "MONGODB_URI");
  if (isSet("MONGODB_URI") && !isSet("MONGODB_DATABASE")) {
    checks.push({ name: "MONGODB_DATABASE", status: "warn", message: "MONGODB_URI set but no database name — mongo_query may fail" });
  }

  checkOptionalUrl(checks, "HF_UPSTREAM_URL");
  if (isSet("HF_PROXY_REPO") && !isSet("HF_PROXY_TOKEN")) {
    checks.push({ name: "HF_PROXY_TOKEN", status: "warn", message: "HF proxy repo set but no proxy token — upstream HF token may be exposed" });
  }

  if (isSet("HF_TOKEN")) {
    checks.push({ name: "HF_TOKEN", status: "ok", message: "Set — HuggingFace Bucket persistence enabled" });
    if (!isSet("HF_BUCKET_REPO")) {
      checks.push({ name: "HF_BUCKET_REPO", status: "warn", message: "HF_TOKEN set but no HF_BUCKET_REPO — bucket persistence will remain local" });
    }
  } else {
    checks.push({ name: "HF_TOKEN", status: "warn", message: "Not set — using local filesystem bucket" });
  }

  checkOptionalUrl(checks, "PLAUSIBLE_UPSTREAM_URL");

  // AWS Athena
  const awsConfigured =
    isSet("AWS_ACCESS_KEY_ID") &&
    isSet("AWS_SECRET_ACCESS_KEY") &&
    isSet("AWS_REGION");
  if (awsConfigured) {
    checks.push({ name: "AWS credentials", status: "ok", message: "Set" });
  } else if (
    isSet("AWS_ACCESS_KEY_ID") ||
    isSet("AWS_SECRET_ACCESS_KEY") ||
    isSet("AWS_SESSION_TOKEN")
  ) {
    checks.push({ name: "AWS credentials", status: "warn", message: "Partial AWS config — athena_query may fail" });
  } else {
    checks.push({ name: "AWS credentials", status: "warn", message: "Not set — athena_query will be unavailable" });
  }

  if (isSet("SIZZLE_DATA_DIR")) {
    if (await ensureDirWritable(env("SIZZLE_DATA_DIR")!)) {
      checks.push({ name: "SIZZLE_DATA_DIR", status: "ok", message: `${env("SIZZLE_DATA_DIR")} is writable` });
    } else {
      checks.push({ name: "SIZZLE_DATA_DIR", status: "warn", message: `${env("SIZZLE_DATA_DIR")} is not writable` });
    }
  } else {
    checks.push({ name: "SIZZLE_DATA_DIR", status: "warn", message: "Not set — sizzle_query will be unavailable" });
  }

  // MCP
  if (isSet("MCP_SERVERS")) {
    try {
      JSON.parse(env("MCP_SERVERS")!);
      checks.push({ name: "MCP_SERVERS", status: "ok", message: "Valid JSON" });
    } catch {
      checks.push({ name: "MCP_SERVERS", status: "warn", message: "Invalid JSON — MCP integration will fail" });
    }
  } else {
    checks.push({ name: "MCP_SERVERS", status: "warn", message: "Not set — no external MCP servers will be loaded" });
  }

  // Tiers / Okta
  if (isSet("USER_TIERS")) {
    checks.push({ name: "USER_TIERS", status: "ok", message: "Set" });
  } else if (isSet("OKTA_DOMAIN") || isSet("OKTA_API_TOKEN")) {
    if (!isSet("OKTA_DOMAIN") || !isSet("OKTA_API_TOKEN")) {
      checks.push({ name: "Okta", status: "warn", message: "Partial Okta config — tier resolution may fail closed to basic" });
    } else {
      checks.push({ name: "Okta", status: "ok", message: "Configured for group-based tier resolution" });
    }
  } else {
    checks.push({ name: "Access tiers", status: "warn", message: "No USER_TIERS or Okta config — all users will default to basic" });
  }

  const defaultTier = (env("DEFAULT_ACCESS_TIER") || "basic").toLowerCase();
  if (["basic", "elastic", "privileged"].includes(defaultTier)) {
    checks.push({ name: "DEFAULT_ACCESS_TIER", status: "ok", message: defaultTier });
  } else {
    checks.push({ name: "DEFAULT_ACCESS_TIER", status: "warn", message: `${defaultTier} is not a recognized tier (basic/elastic/privileged)` });
  }

  // Scheduler
  if (isSet("SCHEDULED_WEEKLY_REPORT_CHANNEL")) {
    checks.push({ name: "SCHEDULED_WEEKLY_REPORT_CHANNEL", status: "ok", message: env("SCHEDULED_WEEKLY_REPORT_CHANNEL")! });
  } else {
    checks.push({ name: "SCHEDULED_WEEKLY_REPORT_CHANNEL", status: "warn", message: "Not set — weekly ops report disabled" });
  }
  if (isSet("SCHEDULED_DEPLOY_CHANNEL")) {
    checks.push({ name: "SCHEDULED_DEPLOY_CHANNEL", status: "ok", message: env("SCHEDULED_DEPLOY_CHANNEL")! });
  } else {
    checks.push({ name: "Scheduled deploy monitor", status: "warn", message: "SCHEDULED_DEPLOY_CHANNEL not set — deploy monitor disabled" });
  }

  // Bucket public URL
  const usesHfBucket = isSet("HF_TOKEN") && isSet("HF_BUCKET_REPO");
  if (!usesHfBucket && !isSet("BUCKET_PUBLIC_URL") && env("BUCKET_HTTP_PORT") !== "0") {
    checks.push({ name: "BUCKET_PUBLIC_URL", status: "warn", message: "Not set — artifact buttons will use local filesystem paths" });
  }

  const fails = checks.filter((c) => c.status === "fail").length;

  return {
    ok: fails === 0,
    checks,
  };
}

/**
 * Format a diagnostic result as Slack mrkdwn. Secrets are not exposed;
 * only check names and statuses are shown.
 */
export function formatDiagnosticResultForSlack(result: DiagnosticResult): string {
  const okCount = result.checks.filter((c) => c.status === "ok").length;
  const warnCount = result.checks.filter((c) => c.status === "warn").length;
  const failCount = result.checks.filter((c) => c.status === "fail").length;

  const header = result.ok
    ? `*Moon Bot diagnostic* ✅ ${okCount} ok, ${warnCount} warn\nConfiguration looks good. Moon Bot is ready to start.`
    : `*Moon Bot diagnostic* ❌ ${okCount} ok, ${warnCount} warn, ${failCount} fail\nCritical issues must be fixed before Slack testing.`;

  const lines = result.checks.map((c) => {
    const icon = c.status === "ok" ? "✅" : c.status === "warn" ? "⚠️" : "❌";
    return `${icon} *${c.name}*: ${c.message}`;
  });

  return [header, "", ...lines].join("\n");
}

/**
 * Format a diagnostic result for the terminal. Mirrors the original
 * scripts/diagnose.ts output so existing users see no change.
 */
export function formatDiagnosticResultForConsole(result: DiagnosticResult): string {
  const ok = result.checks.filter((c) => c.status === "ok").length;
  const warns = result.checks.filter((c) => c.status === "warn").length;
  const fails = result.checks.filter((c) => c.status === "fail").length;

  const lines: string[] = ["Moon Bot configuration diagnostic\n", `Checks: ${ok} ok, ${warns} warn, ${fails} fail\n`];
  for (const c of result.checks) {
    const icon = c.status === "ok" ? "✅" : c.status === "warn" ? "⚠️" : "❌";
    lines.push(`${icon} ${c.name}: ${c.message}`);
  }
  lines.push("");

  if (fails > 0) {
    lines.push(`Diagnostic failed: ${fails} critical issue(s) must be fixed before starting Moon Bot.`);
  } else if (warns > 0) {
    lines.push("Configuration is usable, but review the warnings above before Slack testing.");
  } else {
    lines.push("Configuration looks good. Moon Bot is ready to start.");
  }

  return lines.join("\n");
}
