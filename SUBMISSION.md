# Moon Bot — Slack Agent Builder Challenge Submission

**Track:** New Slack Agent / Slack Agent for Good  
**Team:** Moon Bot  
**Repo:** `moon-bot-slack-agent`

---

## One-line pitch

Moon Bot is an always-on engineering assistant that lives in Slack, remembers every conversation, and can query code, logs, metrics, and GitHub — all from a single thread.

---

## Text description

Moon Bot collapses the daily context-switching between Elasticsearch, MongoDB, GitHub, the IDE, and analytics dashboards into one Slack conversation. Support can ask about user-facing behavior without touching a terminal. Engineers can ask whether a feature exists, how it works, or whether something is a bug — even in codebases they don't know well. It also queries logs and metrics, opens GitHub PRs and issues, searches Slack history in real time, and posts scheduled ops reports.

For the **Slack Agent for Good** track, Moon Bot is aimed at under-resourced nonprofit, civic-tech, and open-source teams that do not have dedicated SREs or 24/7 on-call. A single volunteer can check public status pages, query logs, search Slack history for prior incidents, file GitHub issues, open fixes as PRs, and post plain-language impact updates — all from the same Slack thread. This democratizes platform-engineering skills and helps small teams keep critical public services online.

The bot is built for the Slack Agent Builder Challenge and satisfies all three mandatory technology requirements: Slack AI capabilities, MCP server integration, and the Real-Time Search API. It runs in Socket Mode (no public ingress required), uses Cloudflare Workers AI with Kimi K2.7 or Kimi 2.6, persists state to a HuggingFace Bucket or local filesystem, and ships with Docker, docker-compose, and Kubernetes manifests.

---

## Core features

| Feature | What it does |
|---------|--------------|
| **Slack AI Assistant panel** | Open Moon Bot directly from Slack's native assistant UI with suggested prompts, status updates, and live progress messages while tools run. |
| **Real-Time Search API** | Answer questions about Slack history using `assistant.search.context`. |
| **MCP server integration** | Dynamically discover and invoke tools from external Model Context Protocol servers. |
| **Code Q&A** | Clone repos, search files by name or content, browse directories, read/edit code, open PRs/issues, comment on existing issues/PRs, search GitHub issues/PRs, fetch PR diffs for review, and look up HuggingFace Hub model/dataset/Space metadata. |
| **Data & ops queries** | Query Elasticsearch, MongoDB, AWS Athena, Plausible analytics, public status pages, and DuckDB/Sizzle storage stats. |
| **Resumable sessions + memory recall** | Every Slack thread is an independent, persistent session backed by a bucket; prior interactions from the same thread and related past threads are automatically recalled into the system prompt so the assistant remembers context across conversations. |
| **Auditable artifacts** | Every response uploads a markdown response, a JSONL session trace, and a rendered HTML trace viewer for step-by-step auditing. |
| **Runtime metrics** | The bucket server exposes a `/metrics` endpoint and `/moonbot metrics` reports live operational counters: messages handled, LLM calls, tool calls, tool errors, sessions, thread map entries, memory, feedback, audit events, and response artifacts. |
| **Scheduled tasks** | Weekly ops report, post-deploy impact monitor, and proactive public-status monitoring with restart-safe incident state and recovery alerts; also callable on demand via `weekly_report`/`deploy_report` tools and `/moonbot report` slash commands. |
| **Tiered access control** | Basic / elastic / privileged tiers, guest refusal, tiered Linux-user sandboxed bash, and local credential proxies. |
| **App Home + slash command** | Home tab overview and `/moonbot help | demo | tools | status | metrics | diagnose | audit | ping | whoami | thread | search | report | statuspage | impact` for quick discovery. |
| **Message shortcut** | Select any Slack message and choose *Ask Moon Bot* for a threaded, context-aware reply. |
| **File attachments** | Share text files, logs, CSVs, JSON, or code snippets in a thread; Moon Bot reads them as context (requires the `files:read` scope). |
| **Inline feedback + emoji reactions** | Every response includes 👍 / 👎 buttons so users can flag helpful/unhelpful replies; after a 👎, a *Regenerate response* button asks Moon Bot to retry with a different approach. Users can also react with emoji 👍 / 👎 / 🔄 / ❓ for feedback, reset, or help. |
| **Resilient GitHub API calls** | GitHub read/write operations retry transient 5xx / 429 errors with exponential backoff and honor GitHub's `Retry-After` header, so PR/issue writes succeed during brief GitHub outages or rate-limit windows. |
| **Self-correcting tool calls** | Malformed `<tool_call>` JSON is reported back to the model as a parse error so it can retry instead of silently failing. |
| **Start over reset** | Tapping "Start over" or reacting with 🔄 on any reply clears the thread session so the next message begins fresh. |
| **GitHub-only bot mode** | The same codebase can run as a credential-poor GitHub bot that replies to `@moon-bot` mentions on issues and PRs, with no Slack tokens or production database access. |

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
    J --> J4[open_pr / create_issue / commit_to_pr / get_pr_diff]
    J --> J5[es_query / mongo_query / athena_query / sizzle_query / plausible_query]
    J --> J6[search_code / clone_repo / list_files]
    J --> J8[hf_hub_info]
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
2. `src/slack.ts` validates the user, resolves their access tier, strips bot mentions, suppresses duplicate/out-of-order events, and routes thread follow-ups back to the active session.
3. `src/agent.ts` lazily restores the thread session from the bucket, builds the system prompt + skills, and runs a ReAct loop with the LLM.
4. Tool calls are parsed from `<tool_call>` blocks; malformed JSON is reported back to the model so it can self-correct.
5. The final response is uploaded to the bucket as markdown + JSONL, and a Slack message with Block Kit links is posted.

---

## Tech stack

- **Node.js 22+** with TypeScript and ESM
- **@slack/bolt** v4 for Socket Mode + Slack AI Assistant
- **Cloudflare Workers AI** for Kimi K2.7 (default) or Kimi 2.6
- **@modelcontextprotocol/sdk** for MCP client support
- **HuggingFace Hub buckets** (or local filesystem) for persistent artifacts
- **Docker + docker-compose** and **Kubernetes** for deployment

---

## Mandatory technology compliance

| Requirement | Implementation | File(s) |
|-------------|----------------|---------|
| **Slack AI capabilities** | Bolt `Assistant` with `threadStarted`, `threadContextChanged`, and `userMessage` handlers; native assistant panel with status and suggested prompts. | `src/slack.ts`, `manifest.json` |
| **MCP server integration** | Dynamic MCP client over stdio/SSE/Streamable HTTP; MCP tools are registered with `mcp_<server>_<tool>` names and flow through the same ReAct loop. | `src/mcp/client.ts`, `src/tools/registry.ts` |
| **Real-Time Search API** | `search_slack` tool calls `assistant.search.context` with either a Slack AI `action_token` or a configured `SLACK_USER_TOKEN`. | `src/tools/slack-search.ts`, `src/context.ts` |

---

## Getting started in a Slack sandbox

1. Create a Slack app from `manifest.json` at [api.slack.com/apps](https://api.slack.com/apps).
2. Install the app to your developer sandbox.
3. Copy the bot token (`xoxb-...`) and app-level token (`xapp-...`).
4. Configure a Cloudflare Workers AI token and account ID.
5. Run locally:

```bash
cp .env.example .env
# fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
npm install
npm run build
node dist/app.js --check
npm run diagnose
npm run verify-slack
npm start
```

`npm run verify-slack` also compares the installed bot token's actual scopes with the scopes declared in `manifest.json` and generates a Socket Mode connection URL via `apps.connections.open`, catching stale app installs or missing `connections:write` scope before the bot starts Socket Mode.

Once the bot is running, set `SLACK_E2E_CHANNEL` and run `npm run slack-e2e` to post a test message and confirm Moon Bot replies in a real workspace.

Or use Docker:

```bash
docker compose up --build
```

---

## Demo prompts (for the demo video)

Use these prompts to show off the three mandatory technologies and the agentic workflow:

1. **Slack AI Assistant + Real-Time Search:** open the Assistant panel and ask  
   `Search Slack for recent deployment discussions and summarize what changed.`
2. **MCP integration:** with an MCP filesystem server configured, ask  
   `List the files in /tmp and tell me which ones were modified today.`
3. **Code + GitHub + HuggingFace Hub:** in a channel, mention the bot:  
   `@Moon Bot what is the task for sentence-transformers/all-MiniLM-L6-v2?`  
   Search existing issues before filing a bug:  
   `@Moon Bot search issues in my-org/my-repo for "login error"`  
   Then ask it to open a draft PR:  
   `@Moon Bot open a draft PR in my-org/my-repo that adds a hello-world script.`
   Reply in the same thread without another @-mention to refine the PR, or ask it to comment on an existing issue/PR.
4. **Data query (Elasticsearch / MongoDB / Athena / Plausible):**  
   `How many 5xx errors did we see in the last hour?`
5. **File attachments:** upload a `.log` or `.txt` file to a thread and ask `@Moon Bot summarize this file` to show Slack file-reading.
6. **Message shortcut:** select any message, choose *Ask Moon Bot*, and watch it reply in the thread.
7. **Inline feedback + regenerate + emoji reactions:** after any response, click 👍 or 👎; after a 👎, tap *Regenerate response* to ask Moon Bot to retry. You can also react with 👍 / 👎 / 🔄 / ❓ for feedback, reset, or help.
8. **Scheduled reports on demand:**  
   `/moonbot report weekly` and `/moonbot report deploy`
9. **Public status page and impact monitoring on demand:**  
   `/moonbot statuspage https://status.cloudflare.com/api/v2/status.json` and `/moonbot impact`
10. **Live diagnostics, demo prompts, LLM ping, identity, audit log, and thread info:**  
    `/moonbot diagnose`, `/moonbot demo`, `/moonbot tools`, `/moonbot ping`, `/moonbot whoami`, `/moonbot audit` (privileged), and `/moonbot thread`
11. **Agent for Good — public service monitoring:**  
    `Check the status page for status.cloudflare.com and tell me if any public services nonprofits rely on are degraded.`
12. **Trace viewer:** on any Moon Bot reply, click *View trace* and show the HTML timeline of every turn, tool call, and result.
13. **Start over:** after a few turns, click *Start over* and continue with a fresh session.
14. **Cross-thread memory recall:** ask a question in one channel, then in a different channel ask something related (e.g., "What was that staging DB hostname again?") and watch the prior answer surface automatically in the system prompt.
15. **GitHub-only bot mode:** open a GitHub issue/PR, mention `@moon-bot`, and watch it reply by posting a comment — no Slack workspace needed.
16. **Status / help:**
    `/moonbot status`

---

## Demo video storyboard (suggested 3-minute flow)

| Time | Scene | What to show |
|------|-------|--------------|
| 0:00–0:20 | Intro | Show the bot in the Slack workspace, App Home tab, and assistant panel. |
| 0:20–0:50 | Slack AI Assistant | Open Moon Bot from the assistant panel, run the search prompt, and show the response + artifact buttons. Click 👎 and then *Regenerate response* to show self-improvement. |
| 0:50–1:20 | Real-Time Search API | Ask about a recent deployment in a channel; show `assistant.search.context` results and concise summary. |
| 1:20–1:50 | Code Q&A + GitHub + HuggingFace Hub | Mention `@Moon Bot` and ask it to look up a HuggingFace model, then search code and open a draft PR; show the PR with the standard footer + trace link. |
| 1:50–2:10 | Scheduled reports | Run `/moonbot report weekly` to show the ops report and `/moonbot report deploy` for the impact check. |
| 2:10–2:30 | MCP + data tools + file attachments | Demonstrate an external MCP tool, query Elasticsearch/MongoDB/Plausible, or upload a `.log`/`.txt` file and ask Moon Bot to summarize it. |
| 2:30–2:45 | Agent for Good | Show how a nonprofit/civic-tech volunteer uses `/moonbot impact` to see monitored services, checks a public status page, and files a GitHub issue from a single thread. |
| 2:45–2:55 | Security + trace viewer | Show `/moonbot diagnose`, `/moonbot audit` (privileged), `/moonbot ping`, `/moonbot status`, `/moonbot tools`, `/moonbot whoami`, `/moonbot thread`, `/moonbot demo`, tiered access explanation, and the HTML trace viewer stepping through a session. |
| 2:55–3:00 | Outro | Recap the three mandatory technologies and the value proposition. |

---

## Deployment notes

- Socket Mode means no public URL is required for Slack events.
- The artifact bucket server serves response markdown and JSONL traces on `BUCKET_HTTP_PORT`.
- A production-ready Dockerfile, `docker-compose.yml`, and `k8s/` manifests are included.
- `manifest.json` requests all required OAuth scopes and bot events.

---

## Submission checklist

- [x] Slack app created from `manifest.json`
- [x] All three mandatory technologies implemented
- [x] Code type-checks, lints, builds, and passes the smoke suite
- [x] Docker / docker-compose / Kubernetes deployment surfaces present
- [x] README with architecture diagram and quick-start
- [x] Production bundle startup check (`node dist/app.js --check`)
- [x] Pre-flight diagnostic (`npm run diagnose`)
- [x] Slack connectivity verification (`npm run verify-slack`)
- [ ] Slack developer sandbox URL (to be filled when sandbox is provisioned)
- [ ] Demo video link (to be filled before final submission)
- [ ] Slack Marketplace App ID (only required if entering the Organizations track)

---

## Devpost fields mapping

- **Text description:** this file (above) and `README.md`.
- **Architecture diagram:** Mermaid diagram above and `README.md`.
- **Demo video:** add link in the checklist above once recorded.
- **Slack sandbox URL:** add to the checklist above once the workspace is ready.
