# Elasticsearch queries

Use the `es_query` tool to search logs, metrics, and events stored in Elasticsearch directly from a Slack thread.

## Examples

Find recent HTTP 500 errors in access logs:

```json
{
  "index": "logs-*",
  "query": "{\"query\":{\"bool\":{\"must\":[{\"match\":{\"status\":\"500\"}}]}},\"sort\":[{\"@timestamp\":{\"order\":\"desc\"}}]}",
  "size": 10,
  "source_includes": ["@timestamp", "method", "path", "status", "message"]
}
```

Get error-rate overview with an aggregation:

```json
{
  "index": "logs-*",
  "query": "{\"size\":0,\"query\":{\"range\":{\"@timestamp\":{\"gte\":\"now-1h\"}}},\"aggs\":{\"by_status\":{\"terms\":{\"field\":\"status\"}}}}",
  "size": 0
}
```

## Authentication

The tool reads from `ES_URL`. Use `ES_API_KEY` for Elastic Cloud, or `ES_USERNAME` + `ES_PASSWORD` for basic auth. If none are set, the tool reports that Elasticsearch is not configured.

## Notes

- The `query` parameter must be a valid Elasticsearch Query DSL JSON string.
- Keep `size` small for chat-friendly results; large responses are truncated to 8,000 characters.
- Use `source_includes` to limit columns in the returned markdown table.
