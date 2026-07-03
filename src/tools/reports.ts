import { z } from "zod";
import { generateWeeklyReport, generateDeployReport } from "../scheduler.js";
import type { Tool } from "./types.js";

const weeklyReportParams = z.object({});

const deployReportParams = z.object({
  deployTs: z.string().describe("Slack timestamp of the deploy message, e.g. 1776379256.075999"),
});

async function runWeeklyReport(): Promise<string> {
  return generateWeeklyReport();
}

async function runDeployReport(input: z.infer<typeof deployReportParams>): Promise<string> {
  return generateDeployReport(input.deployTs);
}

export const weeklyReportTool: Tool = {
  name: "weekly_report",
  description:
    "Generate the Ishu weekly ops report on demand. When Elasticsearch is configured, returns live error rates, rate-limiting mentions, and Gitaly health. Otherwise returns a fallback template.",
  params: weeklyReportParams,
  tier: "basic",
  run: runWeeklyReport,
};

export const deployReportTool: Tool = {
  name: "deploy_report",
  description:
    "Generate a 10-minute before/after deploy impact comparison for a given Slack message timestamp. Requires Elasticsearch to be configured; otherwise returns a fallback template.",
  params: deployReportParams,
  tier: "basic",
  run: runDeployReport,
};
