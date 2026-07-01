# MCP Skill

Moon Bot can extend its capabilities by connecting to external **Model Context Protocol (MCP)** servers.
MCP is an open standard that exposes tools to the agent over stdio, SSE, or Streamable HTTP. Adding a
new capability does not require changing Moon Bot's code — only an environment configuration entry.

## How MCP tools appear in Slack

Every MCP tool is imported with a `mcp_<server_name>_<tool_name>` prefix. For example, if you configure
a server named `github` that exposes a `search_repositories` tool, Moon Bot can call:

```
<tool_call>
{"tool": "mcp_github_search_repositories", "params": {"query": "moonshot-ai/kimi"}}
</tool_call>
```

## Configuring MCP servers

Set the `MCP_SERVERS` environment variable to a JSON object. Each key is the server alias used in the
tool name prefix, and each value describes how to launch or connect to the server.

### stdio example (filesystem server)

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  }
}
```

### SSE / Streamable HTTP example

```json
{
  "openweather": {
    "url": "http://localhost:3002/mcp",
    "transport": "streamableHttp"
  }
}
```

Supported `transport` values:
- `streamableHttp` (default for URLs)
- `sse` (deprecated by the spec but still common)

## Security notes

- MCP stdio servers run as the same OS user as Moon Bot. Only configure servers you trust.
- Prefer URL-based transports for remote servers and gate them with network policies.
- Each MCP tool runs inside the same ReAct loop as built-in tools and is subject to the same output
  truncation rules.

## Troubleshooting

If a configured MCP server fails to connect, Moon Bot prints the error to the console and continues
with built-in tools only. Check the logs for the server alias and failure reason, then verify the
command/URL, arguments, and environment variables.
