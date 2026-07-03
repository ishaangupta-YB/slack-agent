# workloads

This skill helps you navigate and operate the workspaces that run user-facing deployment workloads: hosted app spaces, inference endpoints, and training jobs.

## Repositories

Clone the following repositories (or your organization's equivalents) into `CODE_REPOS_DIR` (default `./repos`). You can ask Ishu to clone a repo for you at any time:

```json
{"tool": "clone_repo", "params": {"repo": "your-org/spaces"}}
```

Or do it manually:

```bash
mkdir -p repos
git clone https://github.com/your-org/spaces repos/spaces
git clone https://github.com/your-org/endpoints repos/endpoints
git clone https://github.com/your-org/jobs repos/jobs
```

- `spaces` – hosted app spaces web application code, templates, and build pipeline
- `endpoints` – inference endpoint provisioning, routing, and scaling logic
- `jobs` – training job scheduler, runner, and lifecycle management

## Tools

Use the same code-navigation tools as `hub-code`:

- `clone_repo` to add a new repository to the search index.
- `search_code` to locate files, functions, or config across Spaces, Endpoints, and Jobs.
- `list_files` to browse the directory tree of a cloned repo.
- `read_file` to inspect a file once `search_code` or `list_files` finds it.
- `write_file` / `edit_file` to propose changes, then `open_pr` to submit them.

## Common patterns

- Hosted app spaces are often defined by a `README.md` with a `---` YAML frontmatter block (`title`, `emoji`, `color`, `sdk`, `app_file`, etc.).
- Endpoint configs are usually under `endpoints/` or `src/config/` and reference Docker images, instance types, and scaling policies.
- Jobs are typically defined by YAML/JSON specs with fields like `image`, `command`, `dataset`, `instance`, and `timeout`.

## Example queries

Find the Spaces build pipeline:

```json
{"tool": "search_code", "params": {"repo": "spaces", "query": "build_image", "mode": "files"}}
```

Inspect endpoint routing logic:

```json
{"tool": "search_code", "params": {"repo": "endpoints", "query": "router", "mode": "content", "glob": "*.py"}}
```

Look for job scheduler retry behavior:

```json
{"tool": "search_code", "params": {"repo": "jobs", "query": "retry_policy", "mode": "both"}}
```

## Workflow

1. Identify which workload domain the question is about (Spaces, Endpoints, or Jobs).
2. Search within that repo first with `repo` set.
3. If nothing is found, search across all repos with `repo` omitted.
4. Read the relevant files and answer with file paths and concise explanations.
