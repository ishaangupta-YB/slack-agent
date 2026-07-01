# github

Use this skill to inspect GitHub repositories and open pull requests or issues.

Read-only information is gathered with the `gh` CLI (the GitHub CLI). The agent runs these commands inside a sandboxed user shell, so it never has direct access to repository tokens.

Examples:
- View an issue: `gh issue view 123 --repo owner/name`
- List recent PRs: `gh pr list --repo owner/name --limit 10`
- View file content at a ref: `gh api repos/owner/contents/path?ref=main`

Opening PRs is handled by a dedicated in-process tool, not by the shell. When the user asks to open a PR, call the `open_pr` tool with a title, body, branch name, and the files changed.
