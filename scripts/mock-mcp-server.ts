#!/usr/bin/env node
/**
 * Minimal MCP stdio server for smoke testing.
 * Implements just enough of the Model Context Protocol to respond to
 * initialize, tools/list, and tools/call requests.
 *
 * Note: the version of @modelcontextprotocolprotocol/sdk installed in this
 * project uses newline-delimited JSON over stdio rather than Content-Length
 * framing, so this server reads lines.
 */

import * as readline from "node:readline";
import { stdin, stdout } from "node:process";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function send(message: Record<string, unknown>) {
  const json = JSON.stringify(message);
  stdout.write(json + "\n");
}

function reply(id: number | string, result: Record<string, unknown>) {
  send({ jsonrpc: "2.0", id, result });
}

const tools = [
  {
    name: "echo",
    description: "Echoes the input back as an MCP tool result",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message to echo" },
      },
      required: ["message"],
    },
  },
];

function processMessage(json: string) {
  const req = JSON.parse(json) as JsonRpcRequest;

  if (req.method === "initialize") {
    reply(req.id!, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mock-mcp-server", version: "0.1.0" },
    });
  } else if (req.method === "notifications/initialized") {
    // No-op
  } else if (req.method === "tools/list") {
    reply(req.id!, { tools });
  } else if (req.method === "tools/call") {
    const params = req.params ?? {};
    const args = params.arguments as Record<string, unknown>;
    const text = typeof args.message === "string" ? args.message : JSON.stringify(args);
    reply(req.id!, {
      content: [
        {
          type: "text",
          text: `echo: ${text}`,
        },
      ],
    });
  } else {
    reply(req.id!, { content: [] });
  }
}

const rl = readline.createInterface({ input: stdin, terminal: false });

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    processMessage(line);
  } catch (err) {
    stderr.write(`Mock MCP server error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
});
