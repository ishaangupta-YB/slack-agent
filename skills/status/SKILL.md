# Status

Use the `system_status` tool to show what Moon Bot has available right now — which integrations are connected, what model is in use, which skills are loaded, and whether scheduled tasks are enabled.

## When to use it

- A user asks “what can you do?”, “status”, or “health check”.
- After setup or before a demo to confirm integrations (GitHub, Elasticsearch, MongoDB, etc.) are wired up.
- To verify scheduled tasks (weekly report, deploy monitor) are configured.

## Example prompts

- `Show me the bot status`
- `What integrations are enabled?`
- `Is Elasticsearch connected?`

The tool is available to every access tier and never exposes secrets; it only reports whether each integration is configured.
