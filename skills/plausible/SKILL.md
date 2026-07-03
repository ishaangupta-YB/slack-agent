# plausible

Query privacy-preserving website analytics through Plausible Stats API v2 directly from a Slack thread.

## When to use

Use this skill when the user asks about public web traffic:
- "How many visitors did the blog get this month?"
- "What are the top pages on our docs site?"
- "Which countries are visiting the marketing site?"

## Tool

Use the `plausible_query` tool. It requires either `PLAUSIBLE_API_KEY` (direct auth) or `PLAUSIBLE_PROXY_TOKEN` + `PLAUSIBLE_PROXY_PORT` + `PLAUSIBLE_API_KEY` (local credential proxy) to be configured.

Common parameters:
- `site_id`: the site/domain in Plausible, e.g. `example.com`.
- `metrics`: e.g. `["visitors", "pageviews", "bounce_rate", "visit_duration"]`.
- `dimensions`: e.g. `["event:page", "visit:source", "visit:country"]`.
- `date_range`: `"day"`, `"7d"`, `"30d"`, `"month"`, `"6mo"`, `"12mo"`, or `"YYYY-MM-DD,YYYY-MM-DD"`.
- `filters`: e.g. `["event:page==/docs"]`.
- `limit`: number of rows (default 100, max 1000).

## Examples

Top pages in the last 7 days:

<tool_call>
{"tool": "plausible_query", "params": {"site_id": "example.com", "metrics": ["visitors", "pageviews"], "dimensions": ["event:page"], "date_range": "7d", "limit": 10}}
</tool_call>

Traffic sources this month:

<tool_call>
{"tool": "plausible_query", "params": {"site_id": "example.com", "metrics": ["visitors"], "dimensions": ["visit:source"], "date_range": "30d", "limit": 10}}
</tool_call>

Visits to a specific page over time:

<tool_call>
{"tool": "plausible_query", "params": {"site_id": "example.com", "metrics": ["visitors", "pageviews"], "dimensions": ["event:page"], "date_range": "30d", "filters": ["event:page==/docs"], "limit": 10}}
</tool_call>

## Notes

- If neither `PLAUSIBLE_API_KEY` nor the local proxy token is configured, the tool returns a clear configuration error.
- When the local credential proxy is enabled, the upstream `PLAUSIBLE_API_KEY` is injected server-side and never reaches tool execution.
- Results are rendered as a Slack-compatible markdown table.
