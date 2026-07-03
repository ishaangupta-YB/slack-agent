# Social impact / Slack Agent for Good

Moon Bot is designed to help *any* team operate like a well-staffed platform team — including nonprofits, civic tech groups, open-source maintainers, and public-health organizations that do not have dedicated SREs, data engineers, or 24/7 on-call rotations.

Use Moon Bot to turn a Slack thread into an incident-response, sustainability, or accessibility workspace so under-resourced teams can keep critical services online.

## Why this matters

- **Nonprofit operations** often rely on a handful of volunteers wearing multiple hats. Moon Bot collapses log analysis, GitHub triage, Slack history search, and status monitoring into one conversation.
- **Civic tech / public infrastructure** teams need to know when external dependencies are down before citizens do. `public_status` lets them check public status pages from Slack.
- **Open-source sustainability** depends on maintainers who may be spread across time zones. Moon Bot can search code, file issues, open PRs, and generate weekly health reports so maintainers spend less time context-switching.
- **Accessibility and inclusion** improve when plain-language status updates and incident summaries can be generated on demand from the same thread where coordination is already happening.

## Common social-impact workflows

### Monitor a critical public dependency

When a civic service depends on a third-party platform (CDN, auth provider, cloud host, payment processor), volunteers can ask:

> Check the status page for status.cloudflare.com and let me know if anything is degraded.

Moon Bot should call `public_status` with the JSON endpoint, then summarize the indicator and description.

When `STATUS_MONITOR_CHANNEL` and `STATUS_MONITOR_PAGES` are configured, Moon Bot also polls those pages on a cron schedule, posts a Slack alert the first time an incident is detected, and posts a recovery notice when the service returns to an operational indicator.

### Incident response in one thread

1. A team member posts in `#incidents` that the donation portal is slow.
2. Moon Bot can:
   - Search Slack for related deployment discussions (`search_slack`).
   - Query logs for 5xx or rate-limiting errors (`es_query` / `athena_query`).
   - Search the repo for recent changes to the donation flow (`search_code` / `read_file`).
   - File a GitHub issue with the trace link and requester context (`create_issue`).
   - Open a PR with a fix or mitigation (`open_pr`).
   - Post a plain-language summary of impact and next steps back to the thread.

### Open-source sustainability health check

For maintainers of a small but critical OSS project:

> Give me a brief status of huggingface/hub: recent issues, open PRs, and anything stale we should triage.

Moon Bot can clone or search the repo, open/view issues, and summarize recent GitHub activity.

### Weekly status for a nonprofit tech team

Use the scheduled weekly report (or `/moonbot report weekly`) to summarize:
- Error rates in the donation / signup funnel.
- Rate-limiting events that could affect campaign traffic.
- Gitaly or GitHub health if the team ships open-source artifacts.

### Accessibility-first communication

After resolving an incident, Moon Bot can:
- Generate a plain-language summary for a public status page or donor newsletter.
- Avoid jargon by using the data tools to produce concrete numbers (e.g., “3 donation attempts failed between 14:02 and 14:07 UTC”) rather than vague statements.

## Tools most relevant to social impact work

- `public_status` — check external status pages.
- `search_slack` — find prior incidents and decisions.
- `es_query`, `athena_query`, `plausible_query` — understand impact from logs and analytics.
- `search_code`, `clone_repo`, `read_file` — investigate the codebase.
- `create_issue`, `open_pr` — document and fix problems transparently.
- `weekly_report` / `deploy_report` — scheduled/on-demand ops summaries.
- `system_status` — confirm which integrations are enabled in the current deployment.

## Security and ethics

- Guest users and unauthenticated channels should not have access to incident data. Moon Bot enforces tiered access and guest refusal by default.
- Avoid exposing PII, donor records, or health data in Slack threads. Use the existing data tools against aggregated logs only.
- When communicating publicly about an incident, keep the summary factual, jargon-free, and focused on user impact.
