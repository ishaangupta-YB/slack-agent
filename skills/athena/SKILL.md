# AWS Athena

Use `athena_query` to run SQL against AWS Athena. This is the standard way to inspect ALB, WAF, CloudFront, and other S3-based logs from a Slack thread.

## When to use

- You need to query S3-backed logs (ALB, WAF, CloudFront, VPC flow, application logs).
- You want aggregated metrics (error rates, latency percentiles, request counts) without exporting CSVs.
- Elasticsearch does not hold the data you care about.

## Tool: `athena_query`

Parameters:
- `query` (string, required): SQL to execute.
- `database` (string, required): Athena database name.
- `output_location` (string, required): S3 path for query results, e.g. `s3://my-account-athena-results/queries/`.
- `catalog` (string, default `AwsDataCatalog`): Glue data catalog name.
- `workgroup` (string, optional): Athena workgroup.
- `max_results` (number, default 50): Rows to return.
- `wait_timeout` (number, default 60): Seconds to wait for completion.

## Authentication

Requires `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (optionally `AWS_SESSION_TOKEN`).
The default region is `us-east-1`; override with `AWS_REGION`.

## Examples

Top 404s on the marketing site today:

```json
{
  "tool": "athena_query",
  "params": {
    "database": "alb_logs",
    "query": "SELECT target_url, COUNT(*) AS hits FROM alb_logs WHERE year='2026' AND month='07' AND day='01' AND elb_status_code='404' GROUP BY target_url ORDER BY hits DESC LIMIT 10",
    "output_location": "s3://my-account-athena-results/alb/"
  }
}
```

Hourly request count for an endpoint:

```json
{
  "tool": "athena_query",
  "params": {
    "database": "alb_logs",
    "query": "SELECT date_format(from_iso8601_timestamp(time), '%H') AS hour, COUNT(*) FROM alb_logs WHERE year='2026' AND month='07' AND day='01' GROUP BY hour ORDER BY hour",
    "output_location": "s3://my-account-athena-results/alb/"
  }
}
```

## Notes

- Athena queries are asynchronous. The tool polls until completion or timeout.
- Large result sets are truncated to keep Slack messages readable; increase `max_results` up to 1000 if needed.
- If AWS credentials are missing, the tool returns a configuration message instead of failing.
