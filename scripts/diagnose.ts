#!/usr/bin/env node
/**
 * Moon Bot pre-flight configuration diagnostic.
 *
 * Run this before starting the bot in Slack to catch missing env vars,
 * unwritable directories, and incomplete integration configs. It exits
 * non-zero when the configuration is not ready for production use.
 */
import "dotenv/config";
import { access, constants, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
}

const checks: Check[] = [];

function add(status: Check["status"], name: string, message: string): void {
  checks.push({ status, name, message });
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

function checkRequiredEnv(name: string, prefix?: string): void {
  const value = env(name);
  if (!value) {
    add("fail", name, "Missing required environment variable");
    return;
  }
  if (prefix && !value.startsWith(prefix)) {
    add("warn", name, `Expected value to start with ${prefix}`);
    return;
  }
  add("ok", name, "Set");
}

function checkOptionalToken(name: string, prefix: string): void {
  const value = env(name);
  if (!value) {
    add("warn", name, "Not set — related integration will be unavailable");
    return;
  }
  if (!value.startsWith(prefix)) {
    add("warn", name, `Expected value to start with ${prefix}`);
    return;
  }
  add("ok", name, "Set");
}

function checkOptionalUrl(name: string): void {
  const value = env(name);
  if (!value) {
    add("warn", name, "Not set — related integration will be unavailable");
    return;
  }
  try {
    new URL(value);
    add("ok", name, "Set");
  } catch {
    add("warn", name, "Value does not look like a valid URL");
  }
}

async function main(): Promise<number> {
  console.log("Moon Bot configuration diagnostic\n");

  // Required core credentials
  checkRequiredEnv("SLACK_BOT_TOKEN", "xoxb-");
  checkRequiredEnv("SLACK_APP_TOKEN", "xapp-");
  checkOptionalToken("SLACK_USER_TOKEN", "xoxp-");
  checkRequiredEnv("CLOUDFLARE_ACCOUNT_ID");
  checkRequiredEnv("CLOUDFLARE_API_TOKEN");
  const model = env("CLOUDFLARE_MODEL") || "@cf/moonshotai/kimi-k2.7-code";
  if (model.startsWith("@cf/")) {
    add("ok", "CLOUDFLARE_MODEL", model);
  } else {
    add("warn", "CLOUDFLARE_MODEL", `${model} does not start with @cf/ — verify this model is available`);
  }
  const cfTimeout = parseInt(env("CLOUDFLARE_TIMEOUT_MS") || "120000", 10);
  const cfRetries = parseInt(env("CLOUDFLARE_RETRIES") || "2", 10);
  if (Number.isNaN(cfTimeout) || cfTimeout <= 0) {
    add("warn", "CLOUDFLARE_TIMEOUT_MS", "Invalid timeout value; must be a positive number of milliseconds");
  } else {
    add("ok", "CLOUDFLARE_TIMEOUT_MS", `${cfTimeout}ms`);
  }
  if (Number.isNaN(cfRetries) || cfRetries < 0) {
    add("warn", "CLOUDFLARE_RETRIES", "Invalid retry count; must be a non-negative integer");
  } else {
    add("ok", "CLOUDFLARE_RETRIES", `${cfRetries} retries`);
  }

  const slackSayRetries = parseInt(env("SLACK_SAY_RETRIES") || "2", 10);
  const slackSayRetryBaseMs = parseInt(env("SLACK_SAY_RETRY_BASE_MS") || "1000", 10);
  if (Number.isNaN(slackSayRetries) || slackSayRetries < 0) {
    add("warn", "SLACK_SAY_RETRIES", "Invalid retry count; must be a non-negative integer");
  } else {
    add("ok", "SLACK_SAY_RETRIES", `${slackSayRetries} retries`);
  }
  if (Number.isNaN(slackSayRetryBaseMs) || slackSayRetryBaseMs <= 0) {
    add("warn", "SLACK_SAY_RETRY_BASE_MS", "Invalid base delay; must be a positive number of milliseconds");
  } else {
    add("ok", "SLACK_SAY_RETRY_BASE_MS", `${slackSayRetryBaseMs}ms`);
  }

  // Writable state directories
  const sessionsDir = env("SESSIONS_DIR") || "./sessions";
  if (await ensureDirWritable(sessionsDir)) {
    add("ok", "SESSIONS_DIR", `${sessionsDir} is writable`);
  } else {
    add("fail", "SESSIONS_DIR", `${sessionsDir} is not writable`);
  }

  const bucketDir = env("BUCKET_DIR") || "./bucket";
  if (await ensureDirWritable(bucketDir)) {
    add("ok", "BUCKET_DIR", `${bucketDir} is writable`);
  } else {
    add("fail", "BUCKET_DIR", `${bucketDir} is not writable`);
  }

  const reposDir = env("CODE_REPOS_DIR") || "./repos";
  if (await ensureDirWritable(reposDir)) {
    add("ok", "CODE_REPOS_DIR", `${reposDir} is writable`);
  } else {
    add("warn", "CODE_REPOS_DIR", `${reposDir} is not writable — clone_repo/search_code may fail`);
  }

  const auditLogFile = env("SECURITY_AUDIT_LOG_FILE") || `${sessionsDir}/audit.jsonl`;
  try {
    await mkdir(dirname(auditLogFile), { recursive: true });
    add("ok", "SECURITY_AUDIT_LOG_FILE", `${auditLogFile} directory is writable`);
  } catch {
    add("warn", "SECURITY_AUDIT_LOG_FILE", "Cannot create audit log directory");
  }

  // Security
  if (env("ALLOW_BASH") === "true") {
    add("warn", "ALLOW_BASH", "bash execution is enabled — make sure the host is appropriately locked down");
  } else {
    add("ok", "ALLOW_BASH", "bash execution is disabled (safe default)");
  }

  if (env("ALLOW_GUESTS") === "true") {
    add("warn", "ALLOW_GUESTS", "guest accounts are allowed — verify this matches your security policy");
  } else {
    add("ok", "ALLOW_GUESTS", "guest accounts are refused (safe default)");
  }

  // GitHub
  const githubToken = isSet("GITHUB_TOKEN");
  const githubAppId = isSet("GITHUB_APP_ID");
  const githubPrivateKey = isSet("GITHUB_PRIVATE_KEY");
  const githubInstallationId = isSet("GITHUB_INSTALLATION_ID");
  if (githubAppId && githubPrivateKey && githubInstallationId) {
    add("ok", "GitHub auth", "GitHub App authentication configured");
  } else if (githubToken) {
    add("ok", "GitHub auth", "Static GITHUB_TOKEN configured");
  } else {
    add("warn", "GitHub auth", "No GitHub credentials configured — GitHub tools will fail");
  }
  if (githubAppId || githubPrivateKey || githubInstallationId) {
    if (!githubAppId || !githubPrivateKey || !githubInstallationId) {
      add("warn", "GitHub App auth", "Partial GitHub App config; all of GITHUB_APP_ID, GITHUB_PRIVATE_KEY, and GITHUB_INSTALLATION_ID are needed");
    }
  }
  if (isSet("GITHUB_USER_MAP")) {
    try {
      JSON.parse(env("GITHUB_USER_MAP")!);
      add("ok", "GITHUB_USER_MAP", "Valid JSON");
    } catch {
      add("warn", "GITHUB_USER_MAP", "Invalid JSON — PR/issue footers will not include requester handle");
    }
  } else {
    add("warn", "GITHUB_USER_MAP", "Not set — PR/issue footers will not map to GitHub handles");
  }

  // Optional integrations
  checkOptionalUrl("ES_URL");
  if (isSet("ES_URL")) {
    if (!isSet("ES_API_KEY") && !(isSet("ES_USERNAME") && isSet("ES_PASSWORD"))) {
      add("warn", "Elasticsearch auth", "ES_URL set but no ES_API_KEY or ES_USERNAME+ES_PASSWORD — es_query will fail");
    }
    if (!isSet("ES_PROXY_TOKEN")) {
      add("warn", "ES_PROXY_TOKEN", "Running without local ES credential proxy — upstream key may be exposed to tools");
    }
  }

  checkOptionalToken("PLAUSIBLE_API_KEY", "plausible_");
  if (isSet("PLAUSIBLE_API_KEY") && !isSet("PLAUSIBLE_PROXY_TOKEN")) {
    add("warn", "PLAUSIBLE_PROXY_TOKEN", "Plausible key set but no proxy token — upstream key may be exposed to tools");
  }

  checkOptionalUrl("MONGODB_URI");
  if (isSet("MONGODB_URI") && !isSet("MONGODB_DATABASE")) {
    add("warn", "MONGODB_DATABASE", "MONGODB_URI set but no database name — mongo_query may fail");
  }

  checkOptionalUrl("HF_UPSTREAM_URL");
  if (isSet("HF_PROXY_REPO") && !isSet("HF_PROXY_TOKEN")) {
    add("warn", "HF_PROXY_TOKEN", "HF proxy repo set but no proxy token — upstream HF token may be exposed");
  }

  if (isSet("HF_TOKEN")) {
    add("ok", "HF_TOKEN", "Set — HuggingFace Bucket persistence enabled");
    if (!isSet("HF_BUCKET_REPO")) {
      add("warn", "HF_BUCKET_REPO", "HF_TOKEN set but no HF_BUCKET_REPO — bucket persistence will remain local");
    }
  } else {
    add("warn", "HF_TOKEN", "Not set — using local filesystem bucket");
  }

  checkOptionalUrl("PLAUSIBLE_UPSTREAM_URL");

  // AWS Athena
  const awsConfigured =
    isSet("AWS_ACCESS_KEY_ID") &&
    isSet("AWS_SECRET_ACCESS_KEY") &&
    isSet("AWS_REGION");
  if (awsConfigured) {
    add("ok", "AWS credentials", "Set");
  } else if (
    isSet("AWS_ACCESS_KEY_ID") ||
    isSet("AWS_SECRET_ACCESS_KEY") ||
    isSet("AWS_SESSION_TOKEN")
  ) {
    add("warn", "AWS credentials", "Partial AWS config — athena_query may fail");
  } else {
    add("warn", "AWS credentials", "Not set — athena_query will be unavailable");
  }

  if (isSet("SIZZLE_DATA_DIR")) {
    if (await ensureDirWritable(env("SIZZLE_DATA_DIR")!)) {
      add("ok", "SIZZLE_DATA_DIR", `${env("SIZZLE_DATA_DIR")} is writable`);
    } else {
      add("warn", "SIZZLE_DATA_DIR", `${env("SIZZLE_DATA_DIR")} is not writable`);
    }
  } else {
    add("warn", "SIZZLE_DATA_DIR", "Not set — sizzle_query will be unavailable");
  }

  // MCP
  if (isSet("MCP_SERVERS")) {
    try {
      JSON.parse(env("MCP_SERVERS")!);
      add("ok", "MCP_SERVERS", "Valid JSON");
    } catch {
      add("warn", "MCP_SERVERS", "Invalid JSON — MCP integration will fail");
    }
  } else {
    add("warn", "MCP_SERVERS", "Not set — no external MCP servers will be loaded");
  }

  // Tiers / Okta
  if (isSet("USER_TIERS")) {
    add("ok", "USER_TIERS", "Set");
  } else if (isSet("OKTA_DOMAIN") || isSet("OKTA_API_TOKEN")) {
    if (!isSet("OKTA_DOMAIN") || !isSet("OKTA_API_TOKEN")) {
      add("warn", "Okta", "Partial Okta config — tier resolution may fail closed to basic");
    } else {
      add("ok", "Okta", "Configured for group-based tier resolution");
    }
  } else {
    add("warn", "Access tiers", "No USER_TIERS or Okta config — all users will default to basic");
  }

  const defaultTier = (env("DEFAULT_ACCESS_TIER") || "basic").toLowerCase();
  if (["basic", "elastic", "privileged"].includes(defaultTier)) {
    add("ok", "DEFAULT_ACCESS_TIER", defaultTier);
  } else {
    add("warn", "DEFAULT_ACCESS_TIER", `${defaultTier} is not a recognized tier (basic/elastic/privileged)`);
  }

  // Scheduler
  if (isSet("SCHEDULED_WEEKLY_REPORT_CHANNEL")) {
    add("ok", "SCHEDULED_WEEKLY_REPORT_CHANNEL", env("SCHEDULED_WEEKLY_REPORT_CHANNEL")!);
  } else {
    add("warn", "SCHEDULED_WEEKLY_REPORT_CHANNEL", "Not set — weekly ops report disabled");
  }
  if (isSet("SCHEDULED_DEPLOY_CHANNEL")) {
    add("ok", "SCHEDULED_DEPLOY_CHANNEL", env("SCHEDULED_DEPLOY_CHANNEL")!);
  } else {
    add("warn", "Scheduled deploy monitor", "SCHEDULED_DEPLOY_CHANNEL not set — deploy monitor disabled");
  }

  // Bucket public URL
  const usesHfBucket = isSet("HF_TOKEN") && isSet("HF_BUCKET_REPO");
  if (!usesHfBucket && !isSet("BUCKET_PUBLIC_URL") && env("BUCKET_HTTP_PORT") !== "0") {
    add("warn", "BUCKET_PUBLIC_URL", "Not set — artifact buttons will use local filesystem paths");
  }

  // Summary
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const ok = checks.filter((c) => c.status === "ok").length;

  console.log(`Checks: ${ok} ok, ${warns} warn, ${fails} fail\n`);
  for (const c of checks) {
    const icon = c.status === "ok" ? "✅" : c.status === "warn" ? "⚠️" : "❌";
    console.log(`${icon} ${c.name}: ${c.message}`);
  }
  console.log();

  if (fails > 0) {
    console.log(`Diagnostic failed: ${fails} critical issue(s) must be fixed before starting Moon Bot.`);
    return 1;
  }
  if (warns > 0) {
    console.log("Configuration is usable, but review the warnings above before Slack testing.");
  } else {
    console.log("Configuration looks good. Moon Bot is ready to start.");
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("Diagnostic crashed:", err);
    process.exit(2);
  });
