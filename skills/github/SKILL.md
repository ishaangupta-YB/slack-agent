# github

Use this skill to inspect GitHub repositories, review pull request diffs, open PRs, add commits to PRs, and create issues, all from a Slack thread. For a full PR review workflow (diff fetch, context check, and commenting), see `skills/pr-review/SKILL.md`.

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

## Reviewing pull request diffs

Use the `get_pr_diff` tool to fetch the changed files and patch previews for a pull request. Provide:
- `repo`: owner/name
- `pull_number`: the PR number
- `max_files`: optional limit (default 10)

This is useful for summarizing changes, checking for missing tests or security issues, and deciding whether to post a review comment. Combine it with `search_code` / `read_file` to inspect related code and `comment_on_issue` to leave feedback.

Example:
- `get_pr_diff` with `repo: "huggingface/hub"`, `pull_number: 1234`, `max_files: 5`

## Searching issues and PRs

Use the `search_issues` tool to find related issues or PRs before opening a new one. Provide a GitHub search query such as `is:issue repo:owner/name label:bug keyword` and optionally `sort`, `order`, and `per_page`. This helps volunteers and engineers avoid duplicates and find existing workarounds quickly.

Examples:
- `search_issues` with `q: "is:issue repo:huggingface/hub login error"`
- `search_issues` with `q: "is:pr repo:my-org/my-repo label:documentation"`
