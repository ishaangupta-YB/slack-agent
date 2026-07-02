# github

Use this skill to inspect GitHub repositories, open pull requests, add commits to PRs, and create issues, all from a Slack thread.

All GitHub write tools use short-lived, narrowly-scoped GitHub App tokens when configured; otherwise they fall back to a static `GITHUB_TOKEN`. In either case the actual credential never enters the sandboxed shell.

## Read-only browsing

Read-only information is gathered with the `gh` CLI via the `bash` tool (or manual `curl` calls). The agent runs these commands inside a sandboxed user shell, so it never has direct access to repository tokens.

Examples:
- View an issue: `gh issue view 123 --repo owner/name`
- List recent PRs: `gh pr list --repo owner/name --limit 10`
- View file content at a ref: `gh api repos/owner/repo/contents/path?ref=main`

## Opening PRs

Writes go through dedicated in-process tools, not the sandboxed shell, so any user can ask Moon Bot to open a pull request — no personal write access required. When the user asks to open a PR, call the `open_pr` tool with:
- `repo`: owner/name
- `branch`: the new branch name to create
- `base`: the base branch (defaults to `main`)
- `title`: PR title (also used as the commit message)
- `body`: PR description
- `files`: optional array of `{ path, content }` objects to commit

The Slack requester and a link to the agent session trace are appended automatically from the conversation context (override with `requestedBy` / `traceUrl` if needed).

## Adding commits to an existing PR

Use the `commit_to_pr` tool to push more changes to a PR branch that already exists:
- `repo`: owner/name
- `branch`: the existing PR branch
- `message`: commit message
- `files`: array of `{ path, content }` objects

## Creating issues

Use the `create_issue` tool with `repo`, `title`, and `body`. Like `open_pr`, the requester and trace URL are filled in automatically.

## Commenting on issues

Use the `comment_on_issue` tool to post an update on an existing issue or pull request:
- `repo`: owner/name
- `issue_number`: the issue or PR number
- `body`: the comment text

The Slack requester and agent trace URL are appended automatically, so every Moon Bot comment is auditable and attributed.
