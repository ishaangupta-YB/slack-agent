# workloads

This skill helps you navigate and operate the workspaces that run user-facing HuggingFace workloads: Spaces, Endpoints, Inference Endpoints, and training Jobs.

## Repositories

Clone the following repositories (or your organization's equivalents) into `CODE_REPOS_DIR` (default `./repos`). You can ask Moon Bot to clone a repo for you at any time:

```json
{"tool": "clone_repo", "params": {"repo": "huggingface/spaces"}}
```

Or do it manually:

```bash
mkdir -p repos
git clone https://github.com/huggingface/spaces repos/spaces
git clone https://github.com/huggingface/endpoints repos/endpoints
git clone https://github.com/huggingface/jobs repos/jobs
```

- `spaces` – Hugging Face Spaces web application code, templates, and build pipeline
- `endpoints` – Inference Endpoints provisioning, routing, and scaling logic
- `jobs` – Training Jobs scheduler, runner, and lifecycle management

## Tools

Use the same code-navigation tools as `hub-code`:

- `clone_repo` to add a new repository to the search index.
- `search_code` to locate files, functions, or config across Spaces, Endpoints, and Jobs.
- `read_file` to inspect a file once `search_code` finds it.
- `write_file` / `edit_file` to propose changes, then `open_pr` to submit them.

## Common patterns

- Spaces are defined by a `README.md` with a `---` YAML frontmatter block (`title`, `emoji`, `color`, `sdk`, `app_file`, etc.).
- Endpoints configs are usually under `endpoints/` or `src/config/` and reference Docker images, instance types, and scaling policies.
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
