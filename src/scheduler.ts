import type { App, SlackEventMiddlewareArgs, AllMiddlewareArgs } from "@slack/bolt";
import { schedule, validate, type ScheduledTask } from "node-cron";
import { cfg } from "./config.js";

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

function buildWeeklyReport(): string {
  const now = new Date().toISOString();
  return (
    `*Moon Bot Weekly Ops Report* 🌙\n` +
    `_Generated at ${now} UTC_\n\n` +
    `This is a scheduled health check. Once the \`es-cli\`, \`mongo\`, and ` +
    `\`athena\` skills are wired to live connections, this report will include:\n` +
    `• Error rates and latency percentiles\n` +
    `• Rate-limiting patterns\n` +
    `• Gitaly health\n` +
    `• ALB/WAF/CloudFront anomalies`
  );
}

function buildDeployReport(): string {
  const now = new Date().toISOString();
  return (
    `*Deploy Impact Check* 🚀\n` +
    `_15-minute post-deploy window elapsed at ${now} UTC_\n\n` +
    `Once Elasticsearch is connected, this report will compare error rates and ` +
    `latency for the 10 minutes before vs. after the deploy. No regressions ` +
    `can be evaluated without live query access yet.`
  );
}

async function postWeeklyReport(app: App, channel: string): Promise<void> {
  try {
    await app.client.chat.postMessage({
      channel,
      text: buildWeeklyReport(),
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
    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: buildDeployReport(),
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
