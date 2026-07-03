# ishu

Use this skill when the user asks about Ishu itself: how it is built, where a feature lives, how configuration works, or how to understand its source code.

## Architecture overview

Ishu is a Slack-native engineering agent written in Node.js 22+/TypeScript (ESM). The high-level flow is:

1. Slack events arrive via Socket Mode in `src/slack.ts`.
2. `src/slack.ts` validates the user, resolves their access tier, strips bot mentions, suppresses duplicate/out-of-order events, and routes the message.
3. `src/agent.ts` lazily restores the thread session from the bucket and runs a ReAct loop against Cloudflare Workers AI using Kimi K2.7 (default) or Kimi 2.6 (fallback).
4. Tool calls are parsed from `<tool_call>` blocks and executed through `src/tools/registry.ts`.
5. The final response is saved to a HuggingFace Bucket (or local filesystem) as markdown + JSONL, and a Slack message with artifact buttons is posted.

## Key files and what they do

| File / directory | Responsibility |
|------------------|----------------|
| `src/slack.ts` | Slack Socket Mode routing, Assistant panel, slash commands, shortcuts, block actions, emoji reactions, tier resolution, and user/guest validation. |
| `src/agent.ts` | ReAct loop, session JSONL persistence, memory-context injection, context-window truncation, and thread-map management. |
| `src/tools/registry.ts` | Static tool registry, MCP tool discovery, tier/environment filtering, and tool execution. |
| `src/tools/*.ts` | Individual tools (GitHub, Elasticsearch, MongoDB, Athena, Sizzle, Plausible, bash, filesystem, memory, slack search, etc.). |
| `src/llm/cloudflare.ts` | Cloudflare Workers AI chat client with timeout, retry, and fallback-model support for Kimi 2.7 / 2.6. |
| `src/storage/bucket.ts` | HuggingFace Bucket or local filesystem persistence for sessions, memory, thread map, and artifacts. |
| `src/storage/server.ts` | Local HTTP artifact server serving responses, JSONL traces, an HTML trace viewer, runtime metrics, and a health check. |
| `src/proxy/es.ts`, `src/proxy/plausible.ts`, `src/proxy/hf.ts` | Local credential proxies that inject upstream secrets server-side so sandboxed tools never see raw credentials. |
| `src/integrations/github.ts` | GitHub App JWT auth, installation-token minting, and GitHub API retry logic. |
| `src/integrations/es.ts` | Shared Elasticsearch query helper used by the `es_query` tool and scheduled reports. |
| `src/auth/tiers.ts` | Basic / elastic / privileged access-tier resolution from `USER_TIERS` or Okta group membership. |
| `src/scheduler.ts` | Weekly ops report, post-deploy impact monitor, and public-status monitor with restart-safe state. |
| `src/github-bot.ts` | Optional GitHub-only mode that replies to `@ishu` mentions on issues/PRs without any Slack credentials. |
| `src/skills/loader.ts` | Loads every `skills/<name>/SKILL.md` file into the system prompt (including this one). |
| `src/diagnostics.ts` | Pre-flight configuration checks used by `npm run diagnose` and `/ishu diagnose`. |

## How to answer questions about Ishu

Use these tools, in order:

1. `system_status` to report current configuration and enabled integrations.
2. `search_code` against `src/` to locate the implementation of a feature. Example:
   ```json
   {"tool": "search_code", "params": {"repo": "src", "query": "safeSay", "mode": "content"}}
   ```
3. `list_files` to browse directory layout.
4. `read_file` to inspect the relevant source file.
5. `help` with topics like `slack`, `code`, or `data` for capability overviews.

Always keep answers grounded in the actual source code rather than guessing.

## Security model

- Access tiers are enforced in both the LLM system prompt (tool visibility) and `runToolCall` (execution gating).
- Guest accounts are refused.
- Bash commands can run under tier-specific Linux users via `su -l` when `BASH_TIER_USERS` is configured.
- Upstream credentials are served through local proxies (`ES_PROXY_PORT`, `PLAUSIBLE_PROXY_PORT`, `HF_PROXY_PORT`) so tools only see proxy tokens, not real API keys.
- GitHub writes use short-lived GitHub App installation tokens minted in `src/integrations/github.ts`, not personal tokens exposed to tools.

## Useful configuration paths

- Environment reference: `.env.example`
- Slack app manifest: `manifest.json`
- Deployment manifests: `Dockerfile`, `docker-compose.yml`, and `k8s/`
- Submission packaging: `SUBMISSION.md` and `scripts/prepare-submission.ts`
