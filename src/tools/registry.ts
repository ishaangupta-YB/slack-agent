import type { Tool, ToolCall, ToolResult } from "./types.js";
import { isAtLeast, type AccessTier } from "../auth/tiers.js";
import { bashTool } from "./bash.js";
import { readFileTool, writeFileTool, editFileTool, listFilesTool } from "./filesystem.js";
import { searchCodeTool } from "./code.js";
import { cloneRepoTool } from "./git.js";
import { memoryTool } from "./memory.js";
import { openPrTool, commitToPrTool, createIssueTool, commentOnIssueTool, searchIssuesTool, getPrDiffTool } from "./github.js";
import { plausibleQueryTool } from "./plausible.js";
import { esQueryTool } from "./es.js";
import { searchSlackTool } from "./slack-search.js";
import { mongoQueryTool } from "./mongo.js";
import { athenaQueryTool } from "./athena.js";
import { sizzleQueryTool } from "./sizzle.js";
import { statusTool } from "./status.js";
import { helpTool } from "./help.js";
import { reportInjectionTool } from "./security.js";
import { weeklyReportTool, deployReportTool } from "./reports.js";
import { publicStatusTool } from "./public-status.js";
import { hfHubInfoTool } from "./hf-hub.js";
import { truncateOutput } from "./types.js";
import { closeMcpClients, initializeMcpClients, parseMcpServersConfig } from "../mcp/client.js";
import { cfg } from "../config.js";
import { incrementMetrics } from "../storage/metrics.js";

const staticTools: Tool[] = [
  bashTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  searchCodeTool,
  cloneRepoTool,
  memoryTool,
  openPrTool,
  commitToPrTool,
  createIssueTool,
  commentOnIssueTool,
  searchIssuesTool,
  getPrDiffTool,
  plausibleQueryTool,
  esQueryTool,
  searchSlackTool,
  mongoQueryTool,
  athenaQueryTool,
  sizzleQueryTool,
  statusTool,
  helpTool,
  reportInjectionTool,
  weeklyReportTool,
  deployReportTool,
  publicStatusTool,
  hfHubInfoTool,
];

let registry = new Map<string, Tool>(staticTools.map((t) => [t.name, t]));
let initialized = false;

export async function initializeTools(): Promise<Tool[]> {
  if (initialized) return listTools();

  const serversConfig = parseMcpServersConfig(cfg.mcp.serversRaw);
  const mcpTools = await initializeMcpClients(serversConfig);

  const merged = [...staticTools, ...mcpTools];
  registry = new Map<string, Tool>(merged.map((t) => [t.name, t]));
  initialized = true;
  return listTools();
}

export async function shutdownTools(): Promise<void> {
  await closeMcpClients();
  initialized = false;
  registry = new Map<string, Tool>(staticTools.map((t) => [t.name, t]));
}

export type ToolEnvironment = "slack" | "github";

function isToolAvailableInEnvironment(tool: Tool, environment: ToolEnvironment): boolean {
  if (environment === "github") return tool.githubBot === true;
  return true;
}

export function listTools(
  tier: AccessTier = "basic",
  environment: ToolEnvironment = "slack",
): Tool[] {
  return [...registry.values()].filter(
    (t) => isAtLeast(tier, t.tier ?? "basic") && isToolAvailableInEnvironment(t, environment),
  );
}

function formatToolLine(tool: Tool): string {
  const firstSentence = tool.description.split(/\n/)[0] ?? "";
  const short = firstSentence.length > 90 ? `${firstSentence.slice(0, 90)}…` : firstSentence;
  const tierTag = tool.tier && tool.tier !== "basic" ? ` *(tier: ${tool.tier})*` : "";
  return `• \`${tool.name}\` — ${short}${tierTag}`;
}

/**
 * Build a Slack-markdown summary of all tools available to a user at their
 * access tier. Built-in tools and dynamically-discovered MCP server tools are
 * grouped separately so judges and sandbox users can see the full capability
 * surface at a glance.
 */
export function formatToolList(
  tier: AccessTier = "basic",
  environment: ToolEnvironment = "slack",
): string {
  const tools = listTools(tier, environment).sort((a, b) => a.name.localeCompare(b.name));
  const builtIn = tools.filter((t) => !t.name.startsWith("mcp_"));
  const mcp = tools.filter((t) => t.name.startsWith("mcp_"));

  const lines: string[] = [
    `*Tools available to you* 🛠️`,
    `Resolved access tier: \`${tier}\``,
    ``,
    `*Built-in tools (${builtIn.length})*`,
    ...builtIn.map(formatToolLine),
  ];

  if (mcp.length > 0) {
    lines.push("", `*MCP server tools (${mcp.length})*`, ...mcp.map(formatToolLine));
  }

  return lines.join("\n");
}

export function getTool(
  name: string,
  tier: AccessTier = "basic",
  environment: ToolEnvironment = "slack",
): Tool | undefined {
  const tool = registry.get(name);
  if (!tool) return undefined;
  if (!isAtLeast(tier, tool.tier ?? "basic")) return undefined;
  if (!isToolAvailableInEnvironment(tool, environment)) return undefined;
  return tool;
}

export async function runToolCall(
  call: ToolCall,
  maxOutputChars = 8_000,
  tier: AccessTier = "basic",
  environment: ToolEnvironment = "slack",
): Promise<ToolResult> {
  const tool = getTool(call.tool, tier, environment);
  if (!tool) {
    incrementMetrics("toolErrors");
    return {
      tool: call.tool,
      params: call.params,
      result: `Tool ${call.tool} is not available${environment === "github" ? " in GitHub-only mode" : ` for your access tier (${tier})`}.`,
      error: true,
    };
  }

  const parse = tool.params.safeParse(call.params);
  if (!parse.success) {
    incrementMetrics("toolErrors");
    return {
      tool: call.tool,
      params: call.params,
      result: `Invalid params: ${parse.error.message}`,
      error: true,
    };
  }

  incrementMetrics("toolCalls");
  try {
    const raw = await tool.run(parse.data);
    return {
      tool: call.tool,
      params: call.params,
      result: truncateOutput(raw, maxOutputChars),
    };
  } catch (err) {
    incrementMetrics("toolErrors");
    return {
      tool: call.tool,
      params: call.params,
      result: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
      error: true,
    };
  }
}
