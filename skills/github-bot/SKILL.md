# GitHub bot mode

This skill is active when Ishu runs as a GitHub-only bot (`GITHUB_ONLY=true`).
In this mode the bot does not connect to Slack; it listens for GitHub webhook events
and replies by posting comments on issues and pull requests.

## How it works

1. The bot starts an HTTP server on `GITHUB_WEBHOOK_PORT` (default 3000).
2. GitHub delivers `issue_comment` and `pull_request_review_comment` events.
3. If the comment body contains `@ishu`, the mention is stripped and the remaining text is treated as a prompt.
4. The prompt is processed by the same ReAct agent used in Slack threads, but only GitHub-safe tools are available.
5. The final reply is posted back to the issue/PR as a comment using the `comment_on_issue` tool.

## Available tools in GitHub-only mode

- `read_file`, `write_file`, `edit_file` — inspect or prepare files in the workspace
- `search_code`, `clone_repo` — navigate local cloned repositories
- `memory` — recall prior interactions from the shared memory store
- `open_pr`, `commit_to_pr`, `create_issue`, `comment_on_issue` — interact with GitHub
- `system_status`, `ishu_help` — explain current configuration and capabilities

Tools that are **not** available in GitHub-only mode:
- Slack-specific tools (`search_slack`)
- Data tools that require production credentials (`es_query`, `mongo_query`, `athena_query`, `sizzle_query`, `plausible_query`)
- Bash execution and scheduled reports, because this pod is meant to be credential-poor

## Typical interactions

- `@ishu search the Hub repo for how Gitaly timeouts are handled`
- `@ishu clone huggingface/hub and explain what the repo ID validation regex allows`
- `@ishu open a PR in my-org/my-repo that adds a unit test for this function`
- `@ishu create an issue in my-org/ops to update the runbook based on this thread`

## Security

- Webhook payloads are verified with `GITHUB_WEBHOOK_SECRET` using HMAC-SHA256.
- Repository access is restricted by `GITHUB_ONLY_ALLOWED_REPOS` and `GITHUB_ONLY_ALLOWED_ORGS` when configured.
- The bot never replies to its own comments, preventing loops.
- GitHub writes use short-lived GitHub App tokens minted in-process, never exposed to tool calls.
