import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "../tools/types.js";
import { jsonSchemaToZod } from "./schema.js";
import { type z } from "zod";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** URL for SSE or Streamable HTTP transports. When set, command is ignored. */
  url?: string;
  /** Transport type when a URL is provided. Defaults to "streamableHttp". */
  transport?: "sse" | "streamableHttp";
}

export type McpServersConfig = Record<string, McpServerConfig>;

interface ActiveConnection {
  client: Client;
  transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
  serverName: string;
}

const activeConnections: ActiveConnection[] = [];
let cachedTools: Tool[] | undefined;

export function parseMcpServersConfig(raw: string | undefined): McpServersConfig {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as McpServersConfig;
  } catch (err) {
    console.error("MCP_SERVERS config is not valid JSON:", err instanceof Error ? err.message : String(err));
    return {};
  }
}

function buildTransport(
  name: string,
  config: McpServerConfig,
): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
  if (config.url) {
    const url = new URL(config.url);
    if (config.transport === "sse") {
      return new SSEClientTransport(url);
    }
    return new StreamableHTTPClientTransport(url);
  }

  if (!config.command) {
    throw new Error(`MCP server "${name}" must specify either a command or a url`);
  }

  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: config.env,
    cwd: config.cwd,
    stderr: "inherit",
  });
}

export async function initializeMcpClients(config: McpServersConfig): Promise<Tool[]> {
  const tools: Tool[] = [];

  for (const [serverName, serverConfig] of Object.entries(config)) {
    const client = new Client({ name: "moon-bot-mcp-client", version: "0.1.0" });
    const transport = buildTransport(serverName, serverConfig);

    try {
      await client.connect(transport);
      const response = await client.listTools();

      for (const toolInfo of response.tools) {
        const toolName = toolInfo.name;
        const prefixedName = `mcp_${serverName}_${toolName}`;
        const schema = jsonSchemaToZod(toolInfo.inputSchema);

        const tool: Tool = {
          name: prefixedName,
          description: `[${serverName}/${toolName}] ${toolInfo.description ?? ""}`.trim(),
          params: schema,
          run: async (params: z.infer<typeof schema>) => {
            const result = await client.callTool({ name: toolName, arguments: params as Record<string, unknown> });
            return formatMcpToolResult(result as { content?: unknown; isError?: boolean });
          },
        };

        tools.push(tool);
      }

      activeConnections.push({ client, transport, serverName });
      console.log(`Connected to MCP server "${serverName}" with ${response.tools.length} tool(s)`);
    } catch (err) {
      console.error(`Failed to connect to MCP server "${serverName}":`, err instanceof Error ? err.message : String(err));
      // Clean up partial connection if possible.
      try {
        await transport.close();
      } catch {
        // ignore cleanup errors
      }
    }
  }

  cachedTools = tools;
  return tools;
}

export function getMcpTools(): Tool[] {
  return cachedTools ?? [];
}

export async function closeMcpClients(): Promise<void> {
  await Promise.all(
    activeConnections.map(async ({ client, serverName }) => {
      try {
        await client.close();
      } catch (err) {
        console.error(`Error closing MCP server "${serverName}":`, err instanceof Error ? err.message : String(err));
      }
    }),
  );
  activeConnections.length = 0;
  cachedTools = undefined;
}

interface McpToolResultItem {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
  resource?: Record<string, unknown>;
}

function formatMcpToolResult(result: { content?: unknown; isError?: boolean | unknown }): string {
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? (result.content as McpToolResultItem[]) : [];

  for (const item of content) {
    const type = String(item.type ?? "");
    if (type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (type === "image" || type === "audio") {
      const mimeType = String(item.mimeType ?? "binary");
      parts.push(`[${type}/${mimeType}]`);
    } else if (type === "resource") {
      const resource = item.resource ?? {};
      if (typeof resource.text === "string") {
        parts.push(resource.text);
      } else if (typeof resource.blob === "string") {
        parts.push(`[resource/${String(resource.mimeType ?? "binary")}]`);
      }
    }
  }

  const text = parts.join("\n\n").trim();
  if (result.isError === true) {
    return `MCP tool error: ${text || "unknown error"}`;
  }
  return text || "(no output)";
}
