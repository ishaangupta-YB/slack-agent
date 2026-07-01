import type { Tool, ToolCall, ToolResult } from "./types.js";
import { isAtLeast, type AccessTier } from "../auth/tiers.js";
import { bashTool } from "./bash.js";
import { readFileTool, writeFileTool, editFileTool } from "./filesystem.js";
import { searchCodeTool } from "./code.js";
import { cloneRepoTool } from "./git.js";
import { memoryTool } from "./memory.js";
import { openPrTool, commitToPrTool, createIssueTool } from "./github.js";
import { plausibleQueryTool } from "./plausible.js";
import { esQueryTool } from "./es.js";
import { searchSlackTool } from "./slack-search.js";
import { mongoQueryTool } from "./mongo.js";
import { athenaQueryTool } from "./athena.js";
import { sizzleQueryTool } from "./sizzle.js";
import { statusTool } from "./status.js";
import { reportInjectionTool } from "./security.js";
import { truncateOutput } from "./types.js";
import { closeMcpClients, initializeMcpClients, parseMcpServersConfig } from "../mcp/client.js";
import { cfg } from "../config.js";

const staticTools: Tool[] = [
  bashTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  searchCodeTool,
  cloneRepoTool,
  memoryTool,
  openPrTool,
  commitToPrTool,
  createIssueTool,
  plausibleQueryTool,
  esQueryTool,
  searchSlackTool,
  mongoQueryTool,
  athenaQueryTool,
  sizzleQueryTool,
  statusTool,
  reportInjectionTool,
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

export function listTools(tier: AccessTier = "basic"): Tool[] {
  return [...registry.values()].filter((t) => isAtLeast(tier, t.tier ?? "basic"));
}

export function getTool(name: string, tier: AccessTier = "basic"): Tool | undefined {
  const tool = registry.get(name);
  if (!tool) return undefined;
  if (!isAtLeast(tier, tool.tier ?? "basic")) return undefined;
  return tool;
}

export async function runToolCall(
  call: ToolCall,
  maxOutputChars = 8_000,
  tier: AccessTier = "basic",
): Promise<ToolResult> {
  const tool = getTool(call.tool, tier);
  if (!tool) {
    return {
      tool: call.tool,
      params: call.params,
      result: `Tool ${call.tool} is not available for your access tier (${tier}).`,
      error: true,
    };
  }

  const parse = tool.params.safeParse(call.params);
  if (!parse.success) {
    return {
      tool: call.tool,
      params: call.params,
      result: `Invalid params: ${parse.error.message}`,
      error: true,
    };
  }

  try {
    const raw = await tool.run(parse.data);
    return {
      tool: call.tool,
      params: call.params,
      result: truncateOutput(raw, maxOutputChars),
    };
  } catch (err) {
    return {
      tool: call.tool,
      params: call.params,
      result: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
      error: true,
    };
  }
}
