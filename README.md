# Moon Bot — Slack-Native Engineering Agent

**Moon Bot** is an always-on engineering assistant that lives in Slack. It can answer questions about code, query logs and metrics, search Slack history in real time, open GitHub PRs, and run scheduled ops reports — all from a single thread.

Built for the **Slack Agent Builder Challenge** (New Slack Agent or Slack Agent for Good track), Moon Bot combines three hackathon-mandatory technologies:

- **Slack AI capabilities** — native assistant panel integration with suggested prompts and contextual status.
- **MCP server integration** — dynamically discovers and invokes tools from external Model Context Protocol servers.
- **Real-Time Search API** — searches Slack conversation history on demand via `assistant.search.context`.

---

## What it does

- **Code Q&A** — clone repos, search files by name or content, read and edit code, open PRs.
- **Data & ops** — query Elasticsearch, MongoDB, AWS Athena, Plausible analytics, public status pages, and DuckDB/Sizzle storage stats.
- **Slack-aware search** — ask about past conversations or decisions without leaving the thread.
- **Agent for Good** — designed for under-resourced nonprofit, civic-tech, and open-source teams that need to monitor public services, respond to incidents, and communicate impact without dedicated SREs.
- **Memory & continuity** — every thread is a resumable session backed by a bucket; prior interactions from the same thread and related past threads are automatically recalled into the system prompt so the assistant truly remembers context.
- **Auditable artifacts** — every response links to the full markdown response, a JSONL session trace, and a rendered HTML trace viewer.
- **Runtime metrics** — the bucket server exposes a `/metrics` endpoint with live counts for sessions, thread map entries, memory, feedback, audit events, and response artifacts.
- **Scheduled reports** — weekly ops report, post-deploy impact monitor, and proactive public-status monitoring with restart-safe incident state; also available on demand via `weekly_report`/`deploy_report` tools and `/moonbot report` slash commands.
- **Tiered access** — basic, elastic, and privileged tiers (Okta or env-driven) gate which tools a user can invoke.
- **Defense in depth** — sandboxed bash, suspicious-command blocking, prompt-injection reporting, and local credential proxies for Elasticsearch, HuggingFace, and Plausible.
- **Message shortcut** — select any Slack message and choose *Ask Moon Bot* to get a threaded, context-aware reply.
- **Inline feedback + reset** — every response includes 👍 / 👎 buttons and a *Start over* button; feedback is logged and reset clears the thread session.

---

## Architecture

```mermaid
flowchart TD
    subgraph Slack
        A[App Home]
        B[Assistant Panel]
        C[@-mentions / DMs]
        D[Slash /moonbot]
    end

    A --> E[src/slack.ts]
    B --> E
    C --> E
    D --> E

    E --> F[src/agent.ts]
    F --> G[Cloudflare Workers AI]
    F --> H[Skills Markdown]
    F --> I[Tool Registry]

    I --> J[Built-in tools]
    I --> K[MCP servers]

    J --> J1[read/write/edit]
    J --> J2[bash]
    J --> J3[memory]
    J --> J4[open_pr / create_issue / commit_to_pr]
    J --> J5[es_query / mongo_query / athena_query / sizzle_query / plausible_query]
    J --> J6[search_code / clone_repo]
    J --> J7[search_slack]

    F --> L[Bucket storage]
    L --> M[session JSONL]
    L --> N[thread-map.json]
    L --> O[memory.json]
    L --> P[response artifacts]

    F --> Q[Credential proxies]
    Q --> R[ES proxy :9201]
    Q --> S[HF proxy :9202]
    Q --> T[Plausible proxy :9203]

    F --> U[Scheduled tasks]
    U --> V[Weekly report]
    U --> W[Deploy monitor]
```

Runtime flow:

1. A Slack message arrives via Socket Mode (`app_mention`, DM, channel/group/MPIM mention, or `assistant_thread_started`).
2. `src/slack.ts` validates the user, resolves their access tier, strips bot mentions, and routes thread follow-ups back to the active session.
3. `src/agent.ts` lazily restores the thread session from the bucket, builds the system prompt + skills, and runs a ReAct loop with the LLM.
4. Tool calls are parsed from `<tool_call>` blocks, validated, and executed.
5. The final response is uploaded to the bucket as markdown + JSONL, and a Slack message with Block Kit links is posted.
6. The **trace viewer** (`/trace/<session>.jsonl` on the bucket server) renders the JSONL session as a readable HTML timeline for auditing and demos.

---

## Tech stack

- **Node.js 22+** with TypeScript and ESM
- **@slack/bolt** v4 for Socket Mode + Slack AI Assistant
- **Cloudflare Workers AI** for Kimi K2.7 (default) or Kimi 2.6
- **@modelcontextprotocol/sdk** for MCP client support
- **HuggingFace Hub buckets** (or local filesystem) for persistent artifacts
- **Docker + docker-compose** for deployment

---

## Quick start

### 1. Create the Slack app

The easiest path is to import `manifest.json` from this repo:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From manifest**.
2. Paste the contents of `manifest.json`.
3. Install the app to your developer sandbox workspace.
4. Copy the **Bot User OAuth Token** (`xoxb-...`) and **App-Level Token** (`xapp-...`).

### 2. Configure environment variables

```bash
cp .env.example .env
# Edit .env and fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
```

### 3. Install dependencies and run

```bash
npm install
npm run build
npm start
```

Or use Docker:

```bash
docker compose up --build
```

### 4. Pre-flight checks

```bash
npm run build                  # compile the production bundle
node dist/app.js --check       # validate startup without connecting to Slack
npm run diagnose               # validate env vars and local directories
npm run verify-slack           # validate Slack token scopes and connectivity
```

`--check` starts the bucket server, credential proxies, and tool registry, then exits cleanly — a quick way to confirm the production build loads correctly before connecting to Slack. `diagnose` validates required tokens, optional integrations, writable runtime directories, and security flags. `verify-slack` calls the Slack Web API to confirm the bot token, required scopes, and optional user token are ready before starting Socket Mode.

### 5. Talk to Moon Bot

- In a channel, private group, or MPIM: `@Moon Bot summarize the latest deploy discussion`
- Reply in any thread Moon Bot has joined without @-mentioning it again.
- In DMs: just send a message — the whole DM history shares one continuous session.
- Open the Slack AI Assistant panel and select **Moon Bot**.
- Use `/moonbot help`, `/moonbot status`, `/moonbot diagnose`, `/moonbot ping`, `/moonbot whoami`, `/moonbot search <query>`, `/moonbot report weekly`, `/moonbot report deploy`, or `/moonbot statuspage <url>`.

---

## Environment variables

| Variable | Required? | Purpose |
|----------|-----------|---------|
| `SLACK_BOT_TOKEN` | yes | Bot user OAuth token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | yes | App-level token for Socket Mode (`xapp-...`) |
| `CLOUDFLARE_ACCOUNT_ID` | yes | Cloudflare account for Workers AI |
| `CLOUDFLARE_API_TOKEN` | yes | Cloudflare API token with Workers AI permission |
| `CLOUDFLARE_MODEL` | no | Workers AI model (default: `@cf/moonshotai/kimi-k2.7-code`) |
| `CLOUDFLARE_FALLBACK_MODEL` | no | Fallback model used when the primary model is unavailable |
| `SLACK_USER_TOKEN` | no | User token (`xoxp-...`) for Real-Time Search without an action_token |
| `SLACK_SAY_RETRIES` | no | Retries for transient Slack API errors when posting messages (default: 2) |
| `SLACK_SAY_RETRY_BASE_MS` | no | Base backoff for Slack message retries in ms (default: 1000) |
| `AGENT_MAX_CONTEXT_MESSAGES` | no | Max messages sent to the LLM per turn (default: `0` = unlimited); system prompt is always preserved and tool-call/observation pairs are never split |
| `GITHUB_TOKEN` / `GITHUB_APP_*` | no | GitHub read/write; App auth recommended for PRs |
| `PLAUSIBLE_API_KEY` | no | Plausible analytics |
| `ES_URL` / `ES_API_KEY` / `ES_USERNAME` / `ES_PASSWORD` | no | Elasticsearch logs |
| `MONGODB_URI` / `MONGODB_DATABASE` | no | MongoDB queries |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | no | AWS Athena |
| `SIZZLE_DATA_DIR` | no | DuckDB/Sizzle data |
| `HF_TOKEN` / `HF_BUCKET_REPO` | no | Use HuggingFace Bucket for artifacts |
| `MCP_SERVERS` | no | JSON map of MCP servers |
| `USER_TIERS` / `OKTA_*` | no | Access-tier resolution |

See `.env.example` for the full list.

---

## Development & testing

```bash
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint
npm run build        # Compile TypeScript to dist/
node dist/app.js --check  # Validate production bundle startup
npm run smoke        # Full integration smoke suite
npm run diagnose     # Pre-flight config validation
npm run verify-slack # Pre-flight Slack connectivity validation
npm run dev          # Run with tsx (no build step)
```

The smoke suite covers the ReAct loop, tool execution, tier gating, credential proxies, session restore from bucket, Slack event routing, assistant integration, and more.

---

## Security model

- **Access tiers** resolve from Okta group membership or `USER_TIERS` mapping. Guests are refused by default.
- **Tier-gated tools** are filtered from the system prompt and rejected at execution time.
- **Bash is opt-in** (`ALLOW_BASH=true`), blocks suspicious patterns, and can be sandboxed per access tier via `BASH_TIER_USERS` so lower-tier Linux users do not inherit higher-tier environment credentials.
- **Credential proxies** keep upstream secrets out of tool calls.
- **GitHub writes** use short-lived GitHub App installation tokens in the bot process, not in the sandbox.
- **Prompt-injection self-reporting** lets the agent log suspected injection attempts.

---

## Demo prompts

Try these in Slack to show off the core tracks:

- `Search Slack for recent deployment discussions` — demonstrates Real-Time Search API.
- `Open a draft PR in my-org/my-repo that adds a hello-world script` — demonstrates code + GitHub + AI.
- `What is my current access tier and which integrations are enabled?` — demonstrates status + tiering.
- `What skills do you have?` — demonstrates discoverability + help system.

---

## Deployment

A production-ready Dockerfile and `docker-compose.yml` are included. The container exposes the artifact bucket server on `BUCKET_HTTP_PORT` and runs in Socket Mode — no public ingress URL is required for Slack events.

```bash
docker compose pull
docker compose up -d
```

### Kubernetes

For production deployments that match the architecture described in the write-up, use the manifests under `k8s/`:

```bash
cp k8s/secret.example.yaml k8s/secret.yaml
# edit k8s/secret.yaml with real tokens
kubectl apply -k k8s/
```

The manifests deploy a single-replica Deployment (required by Socket Mode), a Service for the bucket/health endpoint, and an optional Ingress for artifact links. See `k8s/README.md` for details.

---

## Project track

Submitted to the **New Slack Agent** track. Moon Bot qualifies for all three mandatory technology criteria: Slack AI capabilities, MCP server integration, and Real-Time Search API.
