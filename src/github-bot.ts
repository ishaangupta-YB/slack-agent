import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { cfg } from "./config.js";
import { getToolContext, runWithToolContext } from "./context.js";
import { handleMessage } from "./agent.js";
import { runToolCall } from "./tools/registry.js";
import type { Server } from "node:http";

interface GitHubRepository {
  full_name: string;
  owner: { login: string };
}

interface GitHubIssue {
  number: number;
  user?: { login: string };
}

interface GitHubComment {
  body: string;
  user: { login: string };
  id: number;
}

interface GitHubWebhookPayload {
  action?: string;
  repository?: GitHubRepository;
  issue?: GitHubIssue;
  pull_request?: GitHubIssue;
  comment?: GitHubComment;
  sender?: { login: string };
}

let activeServer: Server | undefined;

function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return timingSafeEqual(aBuf, bBuf);
}

function verifySignature(payload: string, signature: string | undefined, secret: string): boolean {
  if (!secret) return true;
  if (!signature || !signature.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  return timingSafeCompare(signature.slice("sha256=".length), expected);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function isMentioned(body: string): boolean {
  return /(^|\s)@moon[-_]?bot(\b|$)/i.test(body);
}

function stripMention(body: string): string {
  return body.replace(/(^|\s)@moon[-_]?bot(\b|$)/gi, " ").trim();
}

function isAllowedRepo(repoFullName: string): boolean {
  if (cfg.githubBot.allowedRepos.length > 0 && !cfg.githubBot.allowedRepos.includes(repoFullName)) {
    return false;
  }
  if (cfg.githubBot.allowedOrgs.length > 0) {
    const org = repoFullName.split("/")[0];
    if (!org || !cfg.githubBot.allowedOrgs.includes(org)) return false;
  }
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleIssueComment(payload: GitHubWebhookPayload): Promise<string | undefined> {
  const repo = payload.repository?.full_name;
  const issue = payload.issue;
  const comment = payload.comment;
  const sender = payload.sender?.login;

  if (!repo || !issue || !comment || !sender) return "ignored: missing payload fields";

  if (payload.action !== "created") return `ignored: issue_comment action is ${payload.action ?? "unknown"}`;

  if (!isMentioned(comment.body)) return "ignored: no @moon-bot mention";

  if (!isAllowedRepo(repo)) return `ignored: ${repo} is not in the allowlist`;

  const cleaned = stripMention(comment.body);
  if (!cleaned) return "ignored: empty message after stripping mention";

  const threadKey = `github:${repo}:issue:${issue.number}`;
  const messageTs = `${comment.id}`;

  return runWithToolContext({ userId: sender, userEmail: "", channelId: "", threadKey }, async () => {
    const ctx = getToolContext();
    const { text, sessionFilename } = await handleMessage(
      threadKey,
      cleaned,
      messageTs,
      sender,
      "",
      "github",
    );

    ctx.sessionFilename = sessionFilename;

    const result = await runToolCall(
      {
        tool: "comment_on_issue",
        params: { repo, issue_number: issue.number, body: text },
      },
      8_000,
      "basic",
      "github",
    );

    if (result.error) {
      console.error("Failed to post GitHub comment:", result.result);
      return "replied but failed to post GitHub comment";
    }
    return "replied";
  });
}

async function handlePullRequestReviewComment(
  payload: GitHubWebhookPayload,
): Promise<string | undefined> {
  const repo = payload.repository?.full_name;
  const pr = payload.pull_request;
  const comment = payload.comment;
  const sender = payload.sender?.login;

  if (!repo || !pr || !comment || !sender) return "ignored: missing payload fields";

  if (payload.action !== "created") return `ignored: pull_request_review_comment action is ${payload.action ?? "unknown"}`;

  if (!isMentioned(comment.body)) return "ignored: no @moon-bot mention";
  if (!isAllowedRepo(repo)) return `ignored: ${repo} is not in the allowlist`;

  const cleaned = stripMention(comment.body);
  if (!cleaned) return "ignored: empty message after stripping mention";

  const threadKey = `github:${repo}:pr:${pr.number}`;
  const messageTs = `${comment.id}`;

  return runWithToolContext({ userId: sender, userEmail: "", channelId: "", threadKey }, async () => {
    const ctx = getToolContext();
    const { text, sessionFilename } = await handleMessage(
      threadKey,
      cleaned,
      messageTs,
      sender,
      "",
      "github",
    );

    ctx.sessionFilename = sessionFilename;

    const result = await runToolCall(
      {
        tool: "comment_on_issue",
        params: { repo, issue_number: pr.number, body: text },
      },
      8_000,
      "basic",
      "github",
    );

    if (result.error) {
      console.error("Failed to post GitHub comment:", result.result);
      return "replied but failed to post GitHub comment";
    }
    return "replied";
  });
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { status: "ok", mode: "github-only" });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  const event = req.headers["x-github-event"] as string | undefined;
  const delivery = req.headers["x-github-delivery"] as string | undefined;

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { error: "failed to read body" });
    return;
  }

  if (!verifySignature(body, signature, cfg.githubBot.webhookSecret)) {
    sendJson(res, 401, { error: "signature verification failed" });
    return;
  }

  let payload: GitHubWebhookPayload;
  try {
    payload = JSON.parse(body) as GitHubWebhookPayload;
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }

  console.log(`GitHub webhook received: event=${event} delivery=${delivery ?? "unknown"}`);

  let result: string | undefined;
  try {
    if (event === "issue_comment") {
      result = await handleIssueComment(payload);
    } else if (event === "pull_request_review_comment") {
      result = await handlePullRequestReviewComment(payload);
    } else {
      result = `ignored: unsupported event ${event}`;
    }
  } catch (err) {
    console.error("Error handling GitHub webhook:", err instanceof Error ? err.message : String(err));
    sendJson(res, 500, { error: "internal error" });
    return;
  }

  sendJson(res, 200, { ok: true, result });
}

export function startGitHubBotServer(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      void handleWebhook(req, res);
    });
    activeServer = server;
    server.listen(cfg.githubBot.webhookPort, () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : cfg.githubBot.webhookPort;
      console.log(`GitHub-only Moon Bot listening for webhooks on port ${port}`);
      resolve(server);
    });
  });
}

export function stopGitHubBotServer(): void {
  if (activeServer) {
    activeServer.close();
    activeServer = undefined;
  }
}

export function getActiveGitHubBotServer(): Server | undefined {
  return activeServer;
}
