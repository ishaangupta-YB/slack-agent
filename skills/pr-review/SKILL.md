# Pull Request Review

Use this skill when a user asks you to review a GitHub pull request, summarize its changes, or comment on a PR.

## Workflow

1. **Fetch the diff** with `get_pr_diff`:
   - Provide `repo` as `owner/name`
   - Provide `pull_number`
   - Keep `max_files` small (5-10) unless the user asks for the full diff

2. **Read related context** when needed:
   - Use `search_code` to find related tests, docs, or implementation files in cloned repos
   - Use `read_file` to inspect specific files mentioned in the diff

3. **Decide whether to comment**:
   - If the user asked for a review summary, synthesize findings and post them in the thread
   - If the user asked you to comment on the PR, use `comment_on_issue` with `issue_number` set to the PR number (GitHub treats PRs as issues for comments)

## What to look for

- Missing tests for new behavior
- Breaking changes without migration notes
- Security issues (secrets, unsafe exec, injection points)
- Performance concerns (N+1 queries, large allocations)
- Typos or unclear naming in user-facing APIs
- Consistency with the repo's existing patterns

## Example prompts

- "Review the diff for huggingface/hub#1234."
- "Summarize the changes in my-org/my-repo#42."
- "Check huggingface/transformers#5678 for missing tests and comment on the PR."

## Note

`get_pr_diff` returns file-level patches (not the full raw diff). For very large PRs, focus on the most important files and ask the user if they want a deeper dive into specific areas.
