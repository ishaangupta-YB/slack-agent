# MongoDB queries

Use the `mongo_query` tool to inspect documents in a MongoDB database directly from a Slack thread.

## Examples

Find the 10 most recent users who signed up for a Pro plan:

```json
{
  "database": "hub",
  "collection": "users",
  "filter": "{\"plan\": \"pro\"}",
  "sort": "{\"createdAt\": -1}",
  "limit": 10,
  "projection": ["username", "email", "plan", "createdAt"]
}
```

Count recent sign-ups by omitting a limit and letting the model summarize the results:

```json
{
  "collection": "users",
  "filter": "{\"createdAt\": {\"$gte\": \"2026-06-01T00:00:00Z\"}}",
  "projection": ["username", "plan"],
  "limit": 100
}
```

## Authentication

The tool reads from `MONGODB_URI` and a default `MONGODB_DATABASE`. You can override the database per query with the `database` parameter. If the URI is not set, the tool reports that MongoDB is not configured.

## Notes

- `filter` and `sort` must be valid JSON object strings.
- `projection` is an array of field names to include; `_id` is still returned by default unless excluded.
- Keep `limit` small for chat-friendly results; large responses are truncated to 8,000 characters.
- `sort` supports `1` / `-1` or `"asc"` / `"desc"` values.
