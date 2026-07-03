# Scheduled reports

Use these tools when a user asks for an ops check, weekly summary, or deploy impact analysis.

## Tools

- `weekly_report` — generates the Ishu weekly ops report. It queries Elasticsearch for 7-day log volume, error rate, rate-limiting mentions, and Gitaly-related logs. If Elasticsearch is not configured, it returns a helpful fallback template.
- `deploy_report` — compares the 10-minute windows before and after a deploy Slack message timestamp. Provide the Slack `ts` of the deploy message as `deployTs`.

## Examples

User: "Run the weekly report."
→ Call `weekly_report` and return the formatted report.

User: "Did the deploy at 1776379256.075999 cause any regressions?"
→ Call `deploy_report` with `{"deployTs": "1776379256.075999"}`.

User: "How are things looking this week?"
→ If it's early in the week, call `weekly_report`.

You can also use the `/ishu report weekly` and `/ishu report deploy <ts>` slash commands for the same output.
