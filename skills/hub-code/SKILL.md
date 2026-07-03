# hub-code

This skill lets you navigate and understand a codebase from Slack.

## Setup

Clone the repositories you want Ishu to search into the directory configured
by `CODE_REPOS_DIR` (default `./repos`). You can ask Ishu to clone a repo for you:

```json
{"tool": "clone_repo", "params": {"repo": "huggingface/huggingface_hub"}}
```

Or do it manually:

```bash
mkdir -p repos
git clone https://github.com/huggingface/huggingface_hub repos/huggingface_hub
```

## Tools

- `clone_repo`: clone a GitHub repository into `CODE_REPOS_DIR` on demand.
- `search_code`: search across all cloned repos by file path or file content.
- `list_files`: browse the directory tree of a cloned repo.
- `read_file`: read a specific file once `search_code` or `list_files` finds it.
- `write_file` / `edit_file`: propose changes after understanding the code.

## How to use `search_code`

Find a file by path or name:

```json
{"tool": "search_code", "params": {"query": "auth", "mode": "files", "glob": "*.ts"}}
```

Grep source contents:

```json
{"tool": "search_code", "params": {"query": "class Dataset", "mode": "content", "glob": "*.py", "max_results": 10}}
```

Search within a single repo:

```json
{"tool": "search_code", "params": {"repo": "huggingface_hub", "query": "create_repo", "mode": "both"}}
```

Browse the top-level directories of a cloned repo:

```json
{"tool": "list_files", "params": {"path": "repos/huggingface_hub", "recursive": false}}
```

## Workflow tips

1. Browse the repo root with `list_files` to understand the directory layout.
2. Start broad with `search_code` (`mode: "files"`) to locate relevant files.
3. Read the most promising files with `read_file`.
4. If you need a PR, make the edit locally with `write_file`/`edit_file` and then
   call `open_pr`.

Always prefer small, focused reads over dumping whole directories.
