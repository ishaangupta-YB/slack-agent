import type { Tool, ToolCall, ToolResult } from "./types.js";
import { bashTool } from "./bash.js";
import { readFileTool, writeFileTool, editFileTool } from "./filesystem.js";
import { memoryTool } from "./memory.js";
import { openPrTool, createIssueTool } from "./github.js";
import { searchSlackTool } from "./slack-search.js";
import { truncateOutput } from "./types.js";
import { closeMcpClients, initializeMcpClients, parseMcpServersConfig } from "../mcp/client.js";
import { cfg } from "../config.js";

const staticTools: Tool[] = [
  bashTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  memoryTool,
  openPrTool,
  createIssueTool,
  searchSlackTool,
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

export function listTools(): Tool[] {
  return [...registry.values()];
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

export async function runToolCall(
  call: ToolCall,
  maxOutputChars = 8_000,
): Promise<ToolResult> {
  const tool = getTool(call.tool);
  if (!tool) {
    return {
      tool: call.tool,
      params: call.params,
      result: `Unknown tool: ${call.tool}`,
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
