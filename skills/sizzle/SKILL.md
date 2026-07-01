# Sizzle — Xet Storage Analytics via DuckDB

Sizzle is Moon Bot's interface to Xet storage statistics stored in DuckLake (Parquet or CSV files). It uses DuckDB's fast analytical SQL engine so you can ask about storage capacity, deduplication ratios, shard counts, and bandwidth directly from a Slack thread.

## When to use

- You need to inspect Xet storage metadata, shard distribution, or capacity trends.
- You want aggregated metrics (total deduplicated bytes, hot shards, bandwidth by day) without exporting CSVs.
- The data lives in DuckLake/Parquet/CSV files rather than Elasticsearch or MongoDB.

## Tool: `sizzle_query`

Parameters:

- `query` (string, required): DuckDB SQL query to execute.
- `files` (string[], optional): File paths or globs relative to `SIZZLE_DATA_DIR` to query. Examples: `['2026/07/*.parquet', 'shards.csv']`. Omit to run a pure SQL expression.
- `format` (`"markdown"` | `"csv"`, default `"markdown"`): Output format. Markdown is best for Slack; CSV is best for copying into another tool.
- `max_rows` (number, default 50): Rows to return.

## Authentication

Requires `SIZZLE_DATA_DIR` to point at the directory containing DuckLake files. No other credentials are needed for local files.

## Examples

Total storage by day for a Parquet dataset:

```json
{
  "tool": "sizzle_query",
  "params": {
    "query": "SELECT date, SUM(bytes_deduplicated) AS dedup_bytes, COUNT(*) AS shards FROM __source_0 GROUP BY date ORDER BY date DESC",
    "files": ["2026/07/*.parquet"]
  }
}
```

Top 10 hottest shards by bandwidth:

```json
{
  "tool": "sizzle_query",
  "params": {
    "query": "SELECT shard_id, SUM(bytes_out) AS total FROM __source_0 GROUP BY shard_id ORDER BY total DESC LIMIT 10",
    "files": ["bandwidth.parquet"]
  }
}
```

Capacity summary from a CSV export:

```json
{
  "tool": "sizzle_query",
  "params": {
    "query": "SELECT SUM(raw_bytes) AS raw, SUM(dedup_bytes) AS dedup, ROUND(100.0 * (1 - SUM(dedup_bytes) / SUM(raw_bytes)), 2) AS savings_pct FROM __source_0",
    "files": ["capacity.csv"]
  }
}
```

## Notes

- The tool wraps your query in a `WITH` CTE so it can apply `max_rows`. Do not add a trailing `LIMIT` unless you want to constrain the inner set before the row cap.
- DuckDB detects file type from extension. `*.parquet` uses `read_parquet`; `*.csv` uses `read_csv_auto`.
- If `SIZZLE_DATA_DIR` is not set, the tool returns a configuration message instead of failing.
- Large result sets are truncated to keep Slack messages readable.
