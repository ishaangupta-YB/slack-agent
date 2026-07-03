import type { App, SlackEventMiddlewareArgs, AllMiddlewareArgs } from "@slack/bolt";
import { schedule, validate, type ScheduledTask } from "node-cron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cfg } from "./config.js";
import { esSearch, totalHits, type EsSearchResponse } from "./integrations/es.js";
import { bucket } from "./storage/bucket.js";

export interface PublicStatusPageState {
  url: string;
  lastIndicator?: string;
}

export interface SchedulerState {
  cronTasks: ScheduledTask[];
  deployTimeouts: NodeJS.Timeout[];
  deployHandlers: Array<((args: SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs) => Promise<void>)>;
  statusMonitorPageState?: Map<string, PublicStatusPageState>;
}

let activeScheduler: SchedulerState | undefined;

const WEEKLY_CRON = "0 9 * * 1";
const STATUS_MONITOR_CRON_DEFAULT = "*/15 * * * *";
const STATUS_MONITOR_STATE_BUCKET_KEY = "status-monitor-state.json";
const DEPLOY_KEYWORDS = ["deploy", "deploying", "release", "releasing", "shipping", "rolled out"];
const OPERATIONAL_STATUS_VALUES = new Set([
  "none",
  "operational",
  "ok",
  "up",
  "available",
  "healthy",
  "green",
]);

function isDeployMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return DEPLOY_KEYWORDS.some((kw) => lower.includes(kw));
}

function slackTsToDate(ts: string): Date {
  return new Date(Number(ts) * 1000);
}

function timeRangeQuery(start: Date, end: Date): Record<string, unknown> {
  return {
    query: {
      bool: {
        filter: [
          {
            range: {
              "@timestamp": {
                gte: start.toISOString(),
                lt: end.toISOString(),
              },
            },
          },
        ],
      },
    },
  };
}

async function countLogs(index: string, query: Record<string, unknown>): Promise<number> {
  const result = await esSearch({ index, query, size: 0 });
  if (!result.ok) return 0;
  return totalHits(result.data!);
}

async function searchLogs(index: string, query: Record<string, unknown>, size = 5): Promise<EsSearchResponse> {
  const result = await esSearch({ index, query, size });
  return result.ok ? result.data! : { hits: { total: 0, hits: [] } };
}

function hitsToBullets(data: EsSearchResponse): string {
  const hits = data.hits?.hits ?? [];
  if (hits.length === 0) return "_No matching logs found._";
  return hits
    .map((hit) => {
      const source = hit._source ?? {};
      const message = source.message ?? source.msg ?? source.error?.toString() ?? JSON.stringify(source);
      const ts = source["@timestamp"] ?? hit._id;
      return `• \`${ts}\` ${String(message).slice(0, 200)}`;
    })
    .join("\n");
}

async function getWeeklyMetrics(now: Date): Promise<{
  totalLogs: number;
  errorCount: number;
  errorRate: string;
  rateLimitCount: number;
  gitalyCount: number;
  topErrors: EsSearchResponse;
}> {
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const index = "logs-*";
  const baseRange = timeRangeQuery(start, now);

  const totalLogs = await countLogs(index, baseRange);

  const errorQuery: Record<string, unknown> = {
    query: {
      bool: {
        filter: [
          (baseRange.query as { bool: { filter: unknown[] } }).bool.filter[0],
        ],
        should: [
          { range: { status: { gte: 500 } } },
          { query_string: { query: "error OR exception OR fatal", default_field: "message" } },
        ],
        minimum_should_match: 1,
      },
    },
  };
  const errorCount = await countLogs(index, errorQuery);
  const errorRate = totalLogs > 0 ? ((errorCount / totalLogs) * 100).toFixed(2) : "0.00";

  const rateLimitQuery: Record<string, unknown> = {
    query: {
      bool: {
        filter: [
          (baseRange.query as { bool: { filter: unknown[] } }).bool.filter[0],
          { query_string: { query: '"rate limit"', default_field: "message" } },
        ],
      },
    },
  };
  const rateLimitCount = await countLogs(index, rateLimitQuery);

  const gitalyQuery: Record<string, unknown> = {
    query: {
      bool: {
        filter: [
          (baseRange.query as { bool: { filter: unknown[] } }).bool.filter[0],
        ],
        should: [
          { query_string: { query: "gitaly", default_field: "message" } },
          { match: { service: "gitaly" } },
        ],
        minimum_should_match: 1,
      },
    },
  };
  const gitalyCount = await countLogs(index, gitalyQuery);

  const topErrors = await searchLogs(index, errorQuery, 5);

  return { totalLogs, errorCount, errorRate, rateLimitCount, gitalyCount, topErrors };
}

async function weeklyFallbackReport(now: Date): Promise<string> {
  return (
    `*Ishu Weekly Ops Report* 🌙\n` +
    `_Generated at ${now.toISOString()} UTC_\n\n` +
    `Elasticsearch is not connected, so this is a template report. Once ES_URL is ` +
    `configured, this report will include live error rates, rate-limiting patterns, ` +
    `latency percentiles, and Gitaly health snapshots.`
  );
}

export async function generateWeeklyReport(): Promise<string> {
  const now = new Date();
  if (!cfg.integrations.esUrl) {
    return weeklyFallbackReport(now);
  }

  try {
    const metrics = await getWeeklyMetrics(now);
    const totalErrorRate = metrics.errorRate;

    return (
      `*Ishu Weekly Ops Report* 🌙\n` +
      `_Generated at ${now.toISOString()} UTC_\n\n` +
      `• Total logs (7d): ${metrics.totalLogs.toLocaleString()}\n` +
      `• Error-level logs: ${metrics.errorCount.toLocaleString()} (${totalErrorRate}%)\n` +
      `• Rate-limiting mentions: ${metrics.rateLimitCount.toLocaleString()}\n` +
      `• Gitaly-related logs: ${metrics.gitalyCount.toLocaleString()}\n\n` +
      `*Recent top errors:*\n${hitsToBullets(metrics.topErrors)}\n\n` +
      `_Logs sourced from \`logs-*\` via Elasticsearch._`
    );
  } catch (err) {
    return (
      `*Ishu Weekly Ops Report* 🌙\n` +
      `_Generated at ${now.toISOString()} UTC_\n\n` +
      `Could not generate the live report: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

interface WindowMetrics {
  total: number;
  errors: number;
  errorRate: string;
  topErrors: EsSearchResponse;
}

async function getWindowMetrics(start: Date, end: Date): Promise<WindowMetrics> {
  const index = "logs-*";
  const range = timeRangeQuery(start, end);
  const total = await countLogs(index, range);

  const errorQuery: Record<string, unknown> = {
    query: {
      bool: {
        filter: [(range.query as { bool: { filter: unknown[] } }).bool.filter[0]],
        should: [
          { range: { status: { gte: 500 } } },
          { query_string: { query: "error OR exception OR fatal", default_field: "message" } },
        ],
        minimum_should_match: 1,
      },
    },
  };

  const errors = await countLogs(index, errorQuery);
  const topErrors = await searchLogs(index, errorQuery, 3);
  const errorRate = total > 0 ? ((errors / total) * 100).toFixed(2) : "0.00";

  return { total, errors, errorRate, topErrors };
}

async function deployFallbackReport(now: Date): Promise<string> {
  return (
    `*Deploy Impact Check* 🚀\n` +
    `_15-minute post-deploy window elapsed at ${now.toISOString()} UTC_\n\n` +
    `Elasticsearch is not connected, so no before/after comparison could be made. ` +
    `Configure ES_URL to enable automated deploy impact analysis.`
  );
}

export async function generateDeployReport(deployTs: string): Promise<string> {
  const now = new Date();
  if (!cfg.integrations.esUrl) {
    return deployFallbackReport(now);
  }

  try {
    const deployTime = slackTsToDate(deployTs);
    const tenMinutes = 10 * 60 * 1000;

    const beforeStart = new Date(deployTime.getTime() - tenMinutes);
    const beforeEnd = deployTime;
    const afterStart = deployTime;
    const afterEnd = new Date(deployTime.getTime() + tenMinutes);

    const before = await getWindowMetrics(beforeStart, beforeEnd);
    const after = await getWindowMetrics(afterStart, afterEnd);

    const totalDelta = after.total - before.total;
    const errorDelta = after.errors - before.errors;
    const rateDelta = Number.parseFloat(after.errorRate) - Number.parseFloat(before.errorRate);
    const rateDeltaText = `${rateDelta >= 0 ? "+" : ""}${rateDelta.toFixed(2)}%`;

    let assessment = "No clear change in error rate.";
    if (rateDelta > 0.5 || errorDelta > 10) {
      assessment = "⚠️ Potential regression detected: error rate increased after the deploy.";
    } else if (rateDelta < -0.5) {
      assessment = "✅ Error rate decreased after the deploy.";
    }

    return (
      `*Deploy Impact Check* 🚀\n` +
      `_Compared 10 minutes before vs. after ${deployTime.toISOString()} UTC_\n\n` +
      `| Window | Total logs | Errors | Error rate |\n` +
      `| --- | --- | --- | --- |\n` +
      `| Before deploy | ${before.total.toLocaleString()} | ${before.errors.toLocaleString()} | ${before.errorRate}% |\n` +
      `| After deploy | ${after.total.toLocaleString()} | ${after.errors.toLocaleString()} | ${after.errorRate}% |\n\n` +
      `*Delta:* ${totalDelta >= 0 ? "+" : ""}${totalDelta.toLocaleString()} logs, ` +
      `${errorDelta >= 0 ? "+" : ""}${errorDelta.toLocaleString()} errors, ` +
      `${rateDeltaText} error rate\n` +
      `${assessment}\n\n` +
      `*Top errors after deploy:*\n${hitsToBullets(after.topErrors)}`
    );
  } catch (err) {
    return (
      `*Deploy Impact Check* 🚀\n` +
      `_Generated at ${now.toISOString()} UTC_\n\n` +
      `Could not generate the live report: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function postWeeklyReport(app: App, channel: string): Promise<void> {
  try {
    const report = await generateWeeklyReport();
    await app.client.chat.postMessage({
      channel,
      text: report,
      unfurl_links: false,
    });
    console.log(`Weekly ops report posted to ${channel}`);
  } catch (err) {
    console.error("Weekly report failed:", err);
  }
}

async function postDeployFollowUp(
  app: App,
  channel: string,
  threadTs: string,
): Promise<void> {
  try {
    const report = await generateDeployReport(threadTs);
    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: report,
      unfurl_links: false,
    });
    console.log(`Deploy follow-up posted to ${channel} thread ${threadTs}`);
  } catch (err) {
    console.error("Deploy follow-up failed:", err);
  }
}

function registerDeployMonitor(app: App, state: SchedulerState): void {
  const channel = cfg.scheduler.deployChannel;
  if (!channel) return;

  const handler = async (args: SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs) => {
    const msg = args.message as {
      channel?: string;
      text?: string;
      ts?: string;
      subtype?: string;
      bot_id?: string;
    };
    if (msg.channel !== channel) return;
    if (msg.subtype || msg.bot_id) return;
    if (!msg.text || !isDeployMessage(msg.text)) return;
    if (!msg.ts) return;

    console.log(`Deploy detected in ${channel}; scheduling ${cfg.scheduler.deployMonitorDelayMs}ms follow-up`);

    const timeout = setTimeout(() => {
      void postDeployFollowUp(app, channel, msg.ts!);
    }, cfg.scheduler.deployMonitorDelayMs);

    state.deployTimeouts.push(timeout);
  };

  app.message(handler as never);
  state.deployHandlers.push(handler);
  console.log(`Deploy monitor registered for ${channel}`);
}

function parseStatusPageJson(body: unknown): { name: string; indicator: string; description: string } | undefined {
  if (!body || typeof body !== "object") return undefined;

  if ("page" in body && "status" in body) {
    const page = (body as { page?: { name?: string; updated_at?: string } }).page;
    const status = (body as { status?: { indicator?: string; description?: string } }).status;
    return {
      name: page?.name ?? "Service",
      indicator: status?.indicator ?? "unknown",
      description: status?.description ?? "No status description provided.",
    };
  }

  const record = body as Record<string, unknown>;
  return {
    name: (record.name as string) ?? "Service",
    indicator: String(record.indicator ?? record.status ?? "unknown"),
    description: String(record.description ?? record.message ?? "No status description provided."),
  };
}

function isIncidentStatus(indicator: string): boolean {
  return !OPERATIONAL_STATUS_VALUES.has(indicator.toLowerCase().trim());
}

function ensureStatusMonitorStateDir() {
  const dir = dirname(cfg.scheduler.statusMonitorStateFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function serializePageState(state: Map<string, PublicStatusPageState>): string {
  return JSON.stringify(Object.fromEntries(state.entries()), null, 2);
}

function deserializePageState(payload: string): Map<string, PublicStatusPageState> {
  try {
    const parsed = JSON.parse(payload) as Record<string, PublicStatusPageState>;
    const map = new Map<string, PublicStatusPageState>();
    for (const [url, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.url === "string") {
        map.set(url, entry);
      }
    }
    return map;
  } catch {
    return new Map<string, PublicStatusPageState>();
  }
}

export async function loadStatusMonitorState(): Promise<Map<string, PublicStatusPageState>> {
  ensureStatusMonitorStateDir();
  const localPath = cfg.scheduler.statusMonitorStateFile;

  if (!existsSync(localPath)) {
    try {
      const remote = await bucket.read(STATUS_MONITOR_STATE_BUCKET_KEY);
      writeFileSync(localPath, remote);
    } catch {
      // No remote state yet; start fresh.
    }
  }

  if (!existsSync(localPath)) {
    return new Map<string, PublicStatusPageState>();
  }

  try {
    return deserializePageState(readFileSync(localPath, "utf-8"));
  } catch {
    return new Map<string, PublicStatusPageState>();
  }
}

export async function saveStatusMonitorState(state: Map<string, PublicStatusPageState>): Promise<void> {
  ensureStatusMonitorStateDir();
  const payload = serializePageState(state);
  writeFileSync(cfg.scheduler.statusMonitorStateFile, payload);
  try {
    await bucket.write(STATUS_MONITOR_STATE_BUCKET_KEY, payload, "application/json; charset=utf-8");
  } catch (err) {
    console.warn("Failed to sync status-monitor-state.json to bucket:", err instanceof Error ? err.message : String(err));
  }
}

export async function getPublicStatusImpactSummary(): Promise<string> {
  const channel = cfg.scheduler.statusMonitorChannel;
  const pages = cfg.scheduler.statusMonitorPages;

  if (!channel || pages.length === 0) {
    return (
      "*Ishu public service impact* 🌍\n" +
      "Public status monitoring is not configured.\n\n" +
      "Enable it by setting `STATUS_MONITOR_CHANNEL` and `STATUS_MONITOR_PAGES` " +
      "so Ishu can watch nonprofit, civic-tech, and open-source services " +
      "and alert the channel when they go down."
    );
  }

  const state = await loadStatusMonitorState();
  let summary =
    `*Ishu public service impact* 🌍\n` +
    `_Monitoring ${pages.length} public status page(s) and posting alerts to <#${channel}>. _\n\n`;

  for (const url of pages) {
    const pageState = state.get(url);
    const indicator = pageState?.lastIndicator ?? "unknown";
    const emoji = isIncidentStatus(indicator) ? "🚨" : "✅";
    summary += `${emoji} ${url} — \`${indicator}\`\n`;
  }

  summary +=
    "\n_Check a page on demand with `/ishu statuspage <url>` or ask Ishu " +
    "to summarize a public service status. _";
  return summary;
}

async function postStatusAlert(
  app: App,
  channel: string,
  pageName: string,
  url: string,
  indicator: string,
  description: string,
): Promise<void> {
  try {
    const text =
      `*${pageName} status alert* 🚨\n` +
      `• Indicator: \`${indicator}\`\n` +
      `• Description: ${description}\n` +
      `• Page: ${url}`;
    await app.client.chat.postMessage({ channel, text, unfurl_links: false });
    console.log(`Public status alert posted to ${channel} for ${pageName} (${indicator})`);
  } catch (err) {
    console.error("Public status alert failed:", err);
  }
}

async function postStatusRecovery(
  app: App,
  channel: string,
  pageName: string,
  url: string,
  indicator: string,
  description: string,
): Promise<void> {
  try {
    const text =
      `*${pageName} status recovered* ✅\n` +
      `• Indicator: \`${indicator}\`\n` +
      `• Description: ${description}\n` +
      `• Page: ${url}`;
    await app.client.chat.postMessage({ channel, text, unfurl_links: false });
    console.log(`Public status recovery posted to ${channel} for ${pageName} (${indicator})`);
  } catch (err) {
    console.error("Public status recovery failed:", err);
  }
}

export async function checkPublicStatusPages(
  app: App,
  channel: string,
  pages: string[],
  state: Map<string, PublicStatusPageState>,
): Promise<void> {
  for (const url of pages) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        console.warn(`Status monitor: ${url} returned HTTP ${response.status}`);
        continue;
      }
      const body = await response.json();
      const parsed = parseStatusPageJson(body);
      if (!parsed) {
        console.warn(`Status monitor: unrecognized JSON shape from ${url}`);
        continue;
      }
      const prev = state.get(url);
      const wasIncident = prev?.lastIndicator ? isIncidentStatus(prev.lastIndicator) : false;
      const isIncident = isIncidentStatus(parsed.indicator);
      if (isIncident && !wasIncident) {
        await postStatusAlert(app, channel, parsed.name, url, parsed.indicator, parsed.description);
      } else if (!isIncident && wasIncident) {
        await postStatusRecovery(app, channel, parsed.name, url, parsed.indicator, parsed.description);
      }
      state.set(url, { url, lastIndicator: parsed.indicator });
    } catch (err) {
      console.error(`Status monitor: failed to check ${url}:`, err);
    }
  }

  await saveStatusMonitorState(state);
}

async function registerPublicStatusMonitor(app: App, state: SchedulerState): Promise<void> {
  const channel = cfg.scheduler.statusMonitorChannel;
  const pages = cfg.scheduler.statusMonitorPages;
  const cron = cfg.scheduler.statusMonitorCron || STATUS_MONITOR_CRON_DEFAULT;
  if (!channel || pages.length === 0) return;
  if (!validate(cron)) {
    console.error(`Invalid status monitor cron expression: ${cron}`);
    return;
  }

  if (!state.statusMonitorPageState) {
    state.statusMonitorPageState = await loadStatusMonitorState();
  }

  const task = schedule(
    cron,
    async () => {
      await checkPublicStatusPages(app, channel, pages, state.statusMonitorPageState!);
    },
    { timezone: "UTC" },
  );

  state.cronTasks.push(task);
  console.log(`Public status monitor scheduled for ${channel} (${cron} UTC) watching ${pages.length} page(s)`);
}

function registerWeeklyReport(app: App, state: SchedulerState): void {
  const channel = cfg.scheduler.weeklyReportChannel;
  if (!channel) return;
  if (!validate(WEEKLY_CRON)) {
    console.error(`Invalid weekly report cron expression: ${WEEKLY_CRON}`);
    return;
  }

  const task = schedule(
    WEEKLY_CRON,
    async () => {
      await postWeeklyReport(app, channel);
    },
    { timezone: "UTC" },
  );

  state.cronTasks.push(task);
  console.log(`Weekly report scheduled for ${channel} (${WEEKLY_CRON} UTC)`);
}

export async function startScheduler(app: App): Promise<SchedulerState> {
  await stopScheduler();
  const state: SchedulerState = {
    cronTasks: [],
    deployTimeouts: [],
    deployHandlers: [],
  };
  activeScheduler = state;

  registerWeeklyReport(app, state);
  registerDeployMonitor(app, state);
  await registerPublicStatusMonitor(app, state);

  return state;
}

export async function stopScheduler(): Promise<void> {
  if (!activeScheduler) return;
  await Promise.all(activeScheduler.cronTasks.map((task) => task.stop()));
  for (const timeout of activeScheduler.deployTimeouts) {
    clearTimeout(timeout);
  }
  activeScheduler = undefined;
}

export function getActiveScheduler(): SchedulerState | undefined {
  return activeScheduler;
}
