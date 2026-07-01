import type { App, SlackEventMiddlewareArgs, AllMiddlewareArgs } from "@slack/bolt";
import { schedule, validate, type ScheduledTask } from "node-cron";
import { cfg } from "./config.js";
import { esSearch, totalHits, type EsSearchResponse } from "./integrations/es.js";

export interface SchedulerState {
  cronTasks: ScheduledTask[];
  deployTimeouts: NodeJS.Timeout[];
  deployHandlers: Array<((args: SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs) => Promise<void>)>;
}

let activeScheduler: SchedulerState | undefined;

const WEEKLY_CRON = "0 9 * * 1";
const DEPLOY_KEYWORDS = ["deploy", "deploying", "release", "releasing", "shipping", "rolled out"];

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
    `*Moon Bot Weekly Ops Report* 🌙\n` +
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
      `*Moon Bot Weekly Ops Report* 🌙\n` +
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
      `*Moon Bot Weekly Ops Report* 🌙\n` +
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

export function startScheduler(app: App): SchedulerState {
  stopScheduler();
  const state: SchedulerState = {
    cronTasks: [],
    deployTimeouts: [],
    deployHandlers: [],
  };
  activeScheduler = state;

  registerWeeklyReport(app, state);
  registerDeployMonitor(app, state);

  return state;
}

export function stopScheduler(): void {
  if (!activeScheduler) return;
  for (const task of activeScheduler.cronTasks) {
    task.stop();
  }
  for (const timeout of activeScheduler.deployTimeouts) {
    clearTimeout(timeout);
  }
  activeScheduler = undefined;
}

export function getActiveScheduler(): SchedulerState | undefined {
  return activeScheduler;
}
