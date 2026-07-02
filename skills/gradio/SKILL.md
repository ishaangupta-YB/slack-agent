# gradio

This skill helps you build, debug, and navigate Gradio applications and the Gradio library itself from Slack.

## Repositories

Clone the following repositories into `CODE_REPOS_DIR` (default `./repos`). You can ask Moon Bot to clone a repo for you at any time:

```json
{"tool": "clone_repo", "params": {"repo": "gradio-app/gradio"}}
```

Or do it manually:

```bash
mkdir -p repos
git clone https://github.com/gradio-app/gradio repos/gradio
```

- `gradio` – the Gradio library source, including Python backend (`gradio/`), frontend (`js/`), and examples (`demo/`)

## Tools

Use the same code-navigation tools as `hub-code` and `workloads`:

- `clone_repo` to add the Gradio repository to the search index.
- `search_code` to locate files, components, examples, or tests across the Gradio codebase.
- `read_file` to inspect a file once `search_code` finds it.
- `write_file` / `edit_file` to propose changes, then `open_pr` to submit them.

## Common patterns

- Components are usually defined under `gradio/components/` (Python) or `js/` (TypeScript/Svelte).
- Demos live under `demo/` and are a great way to show how a component or feature is used end-to-end.
- The `gr.Blocks` API is the main building block for multi-tab applications; `gr.Interface` is the quick one-liner wrapper.
- Tests are under `test/` and often mirror the `demo/` structure.

## Example queries

Find the `gr.Chatbot` component implementation:

```json
{"tool": "search_code", "params": {"repo": "gradio", "query": "class Chatbot", "mode": "files", "glob": "*.py"}}
```

Look for gradio-lite / WASM-related code:

```json
{"tool": "search_code", "params": {"repo": "gradio", "query": "wasm", "mode": "content", "glob": "*.py"}}
```

Find example chatbot demos:

```json
{"tool": "search_code", "params": {"repo": "gradio", "query": "chatbot", "mode": "files", "glob": "*demo*"}}
```

Inspect frontend component rendering:

```json
{"tool": "search_code", "params": {"repo": "gradio", "query": "Chatbot.svelte", "mode": "files"}}
```

## Workflow

1. Identify whether the question is about the Gradio library, a specific component, or a user's Gradio app.
2. Search the `gradio` repo for the component, API, or error message.
3. Read the Python component file and the matching demo to understand expected usage.
4. For frontend bugs, search `js/` for the Svelte component and its tests.
5. If a change is needed, edit the relevant files and open a PR with the fix or example.
