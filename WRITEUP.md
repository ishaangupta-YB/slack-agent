Building Moon Bot: A Slack-Native Coding Agent Backed by HuggingFace Buckets
Community Article
Published June 24, 2026
Eliott Coyac's avatar
Eliott Coyac
coyotte508

Follow
huggingface
Caleb Fahlgren's avatar
Caleb Fahlgren
cfahlgren1

Follow
huggingface
Franck Abgrall's avatar
Franck Abgrall
FranckAbgrall

Follow
huggingface

How we built an always-on engineering assistant that lives in Slack, remembers everything, and uses HuggingFace's own infrastructure to do it.
The problem
The HuggingFace team lives in Slack. But answering a question often means context-switching: Elasticsearch for access logs, MongoDB for user data, the IDE for code, each with its own interface and SSO flow. And no single person has the full picture of every codebase — Hub, Xet storage, Spaces, and Endpoints each have their own complexity.

Moon Bot collapses all of that into a single Slack thread. Support can ask about user-facing behaviour without touching a terminal. Engineers can ask whether a feature exists, how it works, or whether something is a bug — even in codebases they don't know well.

It turned out to be just as useful for metrics and analytics. Because Moon Bot already holds the Elasticsearch and MongoDB connections, asking "how many Pro users signed up last month?" is a one-line Slack message — no juggling authentication across half a dozen tools, no exporting CSVs, no remembering which dashboard has which metric. It's fast, and it meets you where you already are.

We wanted an agent that could:

Query Elasticsearch logs and MongoDB directly from a Slack thread
Pull quick metrics and stats without juggling auth across tools
Browse and understand the Hub codebase
Open GitHub PRs with context from the conversation
Remember what it helped with last week
Run continuously, resuming conversations across days and restarts
The result is Moon Bot — a Slack bot powered by the Pi coding agent SDK, running in a Kubernetes pod with privileged internal network access, and using HuggingFace Buckets as its persistent memory store.

Architecture
Slack (Socket Mode)
  → src/slack.ts
      → src/agent.ts  (createBotSession)
          → Pi SDK  (createAgentSession)
              → LLM (Kimi K2, Claude, etc.)
              → Skills: es-cli, mongo, github, hub-code, plausible, …
              → Tools: bash, read, write, edit, memory, open_pr, …
          Sessions + memory persisted to HF Bucket

Each Slack thread gets its own independent Pi agent session, a stateful conversation with the LLM that includes full tool-call history. Multiple threads run in parallel. The bot responds to @Moon Bot mentions in channels or to direct messages without any mention needed.

HF Buckets as a session store
When the bot restarts (daily rolling deploy, or a crash), it needs to pick up exactly where it left off in every active thread. We solved this with three files in a private HuggingFace Bucket (huggingface/moon-bot-memory):

sessions/<id>.jsonl
Each Pi agent session serializes its full message history — including all tool calls and results — as an append-only JSONL file. On first message in a thread, a new file is created. On follow-ups (even days later, even after a pod restart), it's downloaded on-demand and the session is resumed.

// On startup: lazy download from bucket when thread resumes
export async function ensureSessionFile(filename: string): Promise<string | undefined> {
  const localPath = join(LOCAL_SESSIONS_DIR, filename);
  if (existsSync(localPath)) return localPath; // already cached

  const blob = await downloadFile({ repo: REPO, path: `sessions/${filename}`, ...credentials() });
  writeFileSync(localPath, Buffer.from(await blob.arrayBuffer()));
  return localPath;
}

thread-map.json
Maps Slack thread_ts timestamps to session filenames. This is how we reconnect a new Slack message to the right .jsonl file:

{
  "1776379256.075999": {
    "sessionFilename": "abc123.jsonl",
    "lastProcessedMessageTs": "1776381044.000200"
  }
}

memory.json
A rolling log of the last 200 interactions across all threads — prompt + outcome, timestamped. This is exposed to the LLM as a memory tool with two modes:

// Search across all past threads
memory({ mode: "search", query: "gradio PR" })

// Or just get recent history
memory({ mode: "recent", limit: 20 })

This is what lets Moon Bot say things like "last week you asked me to investigate Gitaly timeouts — here's what we found."

Observability: every response links back to the Hub
After each response, Moon Bot uploads two artifacts to the huggingface/moon-bot-memory bucket and appends clickable buttons to the Slack message:

Response — the full markdown response as a .md file (useful when the message is too long for Slack, but always uploaded regardless)
Session — a direct link to the .jsonl session file in the bucket
The session file is an append-only JSONL trace of every turn: user messages, thinking blocks, tool calls, tool results, and assistant replies. HuggingFace renders these files natively as an agent trace viewer — just open the link and you can step through the full session turn by turn, seeing exactly what the model did, which tools it called, what they returned, and how it reasoned to its answer.

This makes every Moon Bot interaction fully auditable directly from Slack.

Skills: pluggable domain knowledge
Skills are Markdown files in skills/<name>/SKILL.md following the Agent Skills standard. They're injected into the system prompt and tell the LLM how to use specific tools or navigate specific codebases.

A key design principle: every skill uses a CLI tool as its interface. The LLM never speaks directly to APIs or databases — it runs a command-line tool via bash, reads stdout, and iterates. This keeps skills simple, testable independently, and easy to swap out.

Skill	CLI tool	What it does
es-cli	es-cli — a Rust CLI by @XciD	Query Elasticsearch (Hub access logs, Gitaly logs, debug logs)
mongo	mongosh	Query the Hub's MongoDB with schema reference
github	gh (GitHub CLI) + in-process PR tools	Browse repos read-only; open PRs / issues via dedicated tools
hub-code	gh, grep, find	Navigate the Hub codebase
workloads	gh, grep, find	Navigate the Spaces/Endpoints/Jobs codebase
athena	athena-query — a bash wrapper around the AWS CLI	Query ALB/WAF/CloudFront logs via AWS Athena
sizzle	sizzle-query — a bash wrapper around DuckDB	Query Xet storage statistics via DuckLake
plausible	plausible-query — a bash wrapper around the Plausible Stats API	Privacy-preserving traffic analytics for public marketing / blog / docs pages
Adding a new skill — say, for gradio — is as simple as dropping a SKILL.md into skills/gradio/ describing where the repo is, how to clone it, and any domain conventions.

Security: tiered access, sandboxed execution, and local credential proxies
Moon Bot can read production databases and logs, so access control is central. Three things need protecting: who gets to reach which data, the host credentials, and the runner process itself.

Access tiers from Okta
Not everyone who can talk to the bot should be able to query the production user database. So Moon Bot resolves an access tier for each Slack user from their Okta group membership — the same groups that already gate access to the real tools, matched by the user's email:

basic — any HuggingFace employee. Code Q&A across the cloned repos, shell, read-only GitHub, and privacy-preserving traffic analytics.
elastic — people with Elasticsearch access in Okta. Adds the es-cli, athena, and sizzle skills (logs + storage metadata).
privileged — people with database access in Okta. Everything, including MongoDB and AWS.
Guests (Slack single/multi-channel accounts) are refused outright. The tiers aren't just prompt instructions: each is backed by a separate Linux user with a different set of credentials in its environment, so the lower tiers physically don't have the secrets to reach Mongo or AWS even if something went wrong higher up. Tier resolution fails closed — if the Okta config can't be read, everyone drops to basic and the bot says so on every reply.

Sandboxed bash
All tool calls are executed under the tier's restricted runner user via su -l, which has no access to /root/ (where the real secrets live) and inherits a clean login environment. Suspicious commands fire a Slack alert before executing. The LLM also has a report_injection tool to self-report prompt injection attempts.

Local reverse proxies
Even a sandboxed runner never gets raw credentials for external services. Instead, the bot process (running as root) starts local HTTP proxies at startup, each gated by a per-tier token:

ES proxy (localhost:9201): forwards to Elastic Cloud, injecting the real API key server-side. The runner hits http://localhost:9201 and never sees the key.
HF proxy (localhost:9202): forwards GET requests to huggingface.co for Sizzle DuckLake catalog files, injecting the HF token. Path-restricted to the storage-visualization-data dataset.
Plausible proxy (localhost:9203): forwards to the Plausible Stats API, hard-allowlisted to a single POST /api/v2/query endpoint. Because it has its own token — handed to every tier including basic — anyone can pull public-traffic analytics without that also unlocking the ES or Sizzle proxies.
A compromised or prompt-injected tool call can query the data its tier is allowed to, but cannot exfiltrate the credentials used to do so.

Opening PRs without handing out write access
Moon Bot can open pull requests and file issues — but the agent's sandboxed gh is read-only for almost everyone. Writes go through dedicated in-process tools (open_pr, commit_to_pr, create_issue) that run in the bot process, not the sandbox: they mint a short-lived, narrowly-scoped GitHub App token, do the commit/push/PR entirely outside the agent's reach, and never expose the token to a tool call.

Two nice properties fall out of this:

Anyone can open a draft PR. Because the privileged write token lives in the bot process and never touches the sandbox, even a basic-tier user can ask Moon Bot to open a draft PR from a change it just made — no personal write access required.
PR descriptions are standardized. The PR/issue body is assembled in code, not by the model, so every Moon Bot PR ends with a consistent footer: who requested it (resolved to their GitHub handle), a link back to the Slack thread, and a link to the agent trace. The model only writes the substance.
A second, locked-down pod for GitHub
Moon Bot also runs as a GitHub bot on a separate, far less privileged pod: it replies to @moon-bot mentions on issues and PRs in our internal repos. That pod has no Slack token, no Mongo/Elasticsearch/AWS credentials — only what it needs to read code and post comments. It's the same codebase and the same in-process PR tools, just deployed with a credential-poor environment and scoped to internal repos. Defense in depth: even a hypothetical sandbox escape there has nothing valuable to escalate to.

Scheduled tasks
Beyond reactive Slack responses, Moon Bot runs two scheduled tasks:

Weekly report (Monday 09:00 UTC): queries Elasticsearch for error rates, latency percentiles, rate-limiting patterns, and Gitaly health — posts a structured ops report to a channel
Deploy monitor: watches the deploy channel for deploy messages, waits 15 minutes, then compares 10 minutes before vs. after in Elasticsearch — only posts if it detects regressions
What's next
The pattern — LLM agent + file-based sessions in a Bucket + skill Markdown files — is simple enough to replicate for any team. You need:

A HuggingFace Bucket (or any object store)
The Pi SDK for session management
Skill files describing your domain
A Slack app in Socket Mode
The hardest part is writing good skills :). The infrastructure to get started is surprisingly thin, and buckets make it easy to audit sessions or finetune later on.

Moon Bot is an internal tool at HuggingFace. The Pi coding agent SDK is open source. Huge thanks to Mario Zechner for Pi.
