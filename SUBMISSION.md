# Moon Bot — Slack Agent Builder Challenge Submission

**Track:** New Slack Agent  
**Team:** Moon Bot  
**Repo:** `moon-bot-slack-agent`

---

## One-line pitch

Moon Bot is an always-on engineering assistant that lives in Slack, remembers every conversation, and can query code, logs, metrics, and GitHub — all from a single thread.

---

## Text description

Moon Bot collapses the daily context-switching between Elasticsearch, MongoDB, GitHub, the IDE, and analytics dashboards into one Slack conversation. Support can ask about user-facing behavior without touching a terminal. Engineers can ask whether a feature exists, how it works, or whether something is a bug — even in codebases they don't know well. It also queries logs and metrics, opens GitHub PRs and issues, searches Slack history in real time, and posts scheduled ops reports.

The bot is built for the Slack Agent Builder Challenge and satisfies all three mandatory technology requirements: Slack AI capabilities, MCP server integration, and the Real-Time Search API. It runs in Socket Mode (no public ingress required), uses Cloudflare Workers AI with Kimi K2.7 or Kimi 2.6, persists state to a HuggingFace Bucket or local filesystem, and ships with Docker, docker-compose, and Kubernetes manifests.

---

## Core features

| Feature | What it does |
|---------|--------------|
| **Slack AI Assistant panel** | Open Moon Bot directly from Slack's native assistant UI with suggested prompts and status updates. |
| **Real-Time Search API** | Answer questions about Slack history using `assistant.search.context`. |
| **MCP server integration** | Dynamically discover and invoke tools from external Model Context Protocol servers. |
| **Code Q&A** | Clone repos, search files by name or content, read/edit code, and open PRs. |
| **Data & ops queries** | Query Elasticsearch, MongoDB, AWS Athena, Plausible analytics, and DuckDB/Sizzle storage stats. |
| **Resumable sessions** | Every Slack thread is an independent, persistent session backed by a bucket; conversations survive restarts. |
| **Auditable artifacts** | Every response uploads a markdown response, a JSONL session trace, and a rendered HTML trace viewer for step-by-step auditing. |
| **Runtime metrics** | The bucket server exposes a `/metrics` endpoint with live counts for sessions, thread map entries, memory, feedback, audit events, and response artifacts. |
| **Scheduled tasks** | Weekly ops report and post-deploy impact monitor backed by Elasticsearch; also callable on demand via `weekly_report`/`deploy_report` tools and `/moonbot report` slash commands. |
| **Tiered access control** | Basic / elastic / privileged tiers, guest refusal, tiered Linux-user sandboxed bash, and local credential proxies. |
| **App Home + slash command** | Home tab overview and `/moonbot help | status | diagnose | ping | whoami | report` for quick discovery. |
| **Message shortcut** | Select any Slack message and choose *Ask Moon Bot* for a threaded, context-aware reply. |
| **Inline feedback** | Every response includes 👍 / 👎 buttons so users can flag helpful/unhelpful replies. |
| **Start over reset** | Tapping "Start over" on any reply clears the thread session so the next message begins fresh. |

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
2. `src/slack.ts` validates the user, resolves their access tier, strips bot mentions, suppresses duplicate/out-of-order events, and routes thread follow-ups back to the active session.
3. `src/agent.ts` lazily restores the thread session from the bucket, builds the system prompt + skills, and runs a ReAct loop with the LLM.
4. Tool calls are parsed from `<tool_call>` blocks, validated, and executed.
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
3. **Code + GitHub:** in a channel, mention the bot:  
   `@Moon Bot open a draft PR in my-org/my-repo that adds a hello-world script.`
   Then reply in the same thread without another @-mention to refine the PR.
4. **Data query (Elasticsearch / MongoDB / Athena / Plausible):**  
   `How many 5xx errors did we see in the last hour?`
5. **Message shortcut:** select any message, choose *Ask Moon Bot*, and watch it reply in the thread.
6. **Inline feedback:** after any response, click 👍 or 👎 and confirm the ephemeral thank-you.
7. **Scheduled reports on demand:**  
   `/moonbot report weekly` and `/moonbot report deploy`
8. **Live diagnostics, LLM ping, and identity:**  
   `/moonbot diagnose`, `/moonbot ping`, and `/moonbot whoami`
9. **Trace viewer:** on any Moon Bot reply, click *View trace* and show the HTML timeline of every turn, tool call, and result.
10. **Start over:** after a few turns, click *Start over* and continue with a fresh session.
11. **Status / help:**  
   `/moonbot status`

---

## Demo video storyboard (suggested 3-minute flow)

| Time | Scene | What to show |
|------|-------|--------------|
| 0:00–0:20 | Intro | Show the bot in the Slack workspace, App Home tab, and assistant panel. |
| 0:20–0:50 | Slack AI Assistant | Open Moon Bot from the assistant panel, run the search prompt, and show the response + artifact buttons. |
| 0:50–1:20 | Real-Time Search API | Ask about a recent deployment in a channel; show `assistant.search.context` results and concise summary. |
| 1:20–1:50 | Code Q&A + GitHub | Mention `@Moon Bot` and ask it to search code and open a draft PR; show the PR with the standard footer + trace link. |
| 1:50–2:10 | Scheduled reports | Run `/moonbot report weekly` to show the ops report and `/moonbot report deploy` for the impact check. |
| 2:10–2:30 | MCP + data tools | Demonstrate an external MCP tool or query Elasticsearch/MongoDB/Plausible from a Slack thread. |
| 2:30–2:50 | Security + trace viewer | Show `/moonbot diagnose`, `/moonbot ping`, `/moonbot status`, `/moonbot whoami`, tiered access explanation, and the HTML trace viewer stepping through a session. |
| 2:50–3:00 | Outro | Recap the three mandatory technologies and the value proposition. |

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
