import { z } from "zod";
import { cfg } from "../config.js";
import { getToolContext } from "../context.js";
import { githubApi } from "../integrations/github.js";
import { bucket } from "../storage/bucket.js";
import type { Tool } from "./types.js";

interface PrFile {
  path: string;
  content: string;
}

const openPrParams = z.object({
  title: z.string(),
  body: z.string(),
  repo: z.string(),
  branch: z.string(),
  base: z.string().default("main"),
  files: z
    .array(
      z.object({
        path: z.string(),
        content: z.string(),
      }),
    )
    .optional(),
  requestedBy: z.string().optional(),
  traceUrl: z.string().optional(),
});

const commitToPrParams = z.object({
  repo: z.string(),
  branch: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      content: z.string(),
    }),
  ),
  message: z.string(),
});

const createIssueParams = z.object({
  repo: z.string(),
  title: z.string(),
  body: z.string(),
  requestedBy: z.string().optional(),
  traceUrl: z.string().optional(),
});

const commentOnIssueParams = z.object({
  repo: z.string(),
  issue_number: z.number().int(),
  body: z.string(),
  requestedBy: z.string().optional(),
  traceUrl: z.string().optional(),
});

interface GitRef {
  object: { sha: string };
}

interface GitBlob {
  sha: string;
}

interface GitTree {
  sha: string;
}

interface GitCommit {
  sha: string;
}

interface PullRequest {
  html_url: string;
  number: number;
}

interface Issue {
  html_url: string;
  number: number;
}

async function applyContextDefaults<T extends { requestedBy?: string; traceUrl?: string }>(
  input: T,
): Promise<void> {
  const ctx = getToolContext();
  const map = cfg.integrations.githubUserMap;

  if (!input.requestedBy && ctx.userId) {
    input.requestedBy =
      map[ctx.userId] ||
      (ctx.userEmail ? map[ctx.userEmail] : undefined) ||
      `<@${ctx.userId}>`;
  }

  if (!input.traceUrl && ctx.sessionFilename) {
    input.traceUrl = bucket.readUrl(`sessions/${ctx.sessionFilename}`);
  }
}

function buildFooter(requestedBy?: string, traceUrl?: string): string {
  const lines = ["", "---", "_Created by Moon Bot_"];
  if (requestedBy) {
    lines.push(`Requested by ${requestedBy}`);
  }
  if (traceUrl) {
    lines.push(`Agent trace: ${traceUrl}`);
  }
  return lines.join("\n");
}

function parseRepo(repo: string): [string, string] {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error(`repo must be in "owner/name" format, got "${repo}".`);
  }
  return [owner, name];
}

async function createFilesCommit(
  repoPath: string,
  branch: string,
  files: PrFile[],
  message: string,
): Promise<string> {
  const baseRef = await githubApi<GitRef>(`${repoPath}/git/refs/heads/${branch}`);
  const baseSha = baseRef.object.sha;

  const fileBlobs = await Promise.all(
    files.map(async (f: PrFile) => {
      const blob = await githubApi<GitBlob>(`${repoPath}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({
          content: Buffer.from(f.content).toString("base64"),
          encoding: "base64",
        }),
      });
      return { path: f.path, sha: blob.sha };
    }),
  );

  const tree = await githubApi<GitTree>(`${repoPath}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseSha,
      tree: fileBlobs.map((b) => ({
        path: b.path,
        mode: "100644",
        type: "blob",
        sha: b.sha,
      })),
    }),
  });

  const commit = await githubApi<GitCommit>(`${repoPath}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [baseSha],
    }),
  });

  await githubApi<void>(`${repoPath}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });

  return commit.sha;
}

async function openPullRequest(input: z.infer<typeof openPrParams>): Promise<string> {
  parseRepo(input.repo);
  const repoPath = `/repos/${input.repo}`;

  await applyContextDefaults(input);

  try {
    const baseRef = await githubApi<GitRef>(`${repoPath}/git/refs/heads/${input.base}`);
    const baseSha = baseRef.object.sha;

    try {
      await githubApi<GitRef>(`${repoPath}/git/refs`, {
        method: "POST",
        body: JSON.stringify({
          ref: `refs/heads/${input.branch}`,
          sha: baseSha,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("Reference already exists")) {
        return `Error creating branch: ${message}`;
      }
    }

    let headSha = baseSha;
    if (input.files && input.files.length > 0) {
      headSha = await createFilesCommit(repoPath, input.branch, input.files, input.title);
    }

    const prBody = `${input.body}${buildFooter(input.requestedBy, input.traceUrl)}`;
    const pr = await githubApi<PullRequest>(`${repoPath}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        body: prBody,
        head: input.branch,
        base: input.base,
      }),
    });

    return `Opened PR #${pr.number}: ${pr.html_url} (head: ${input.branch} @ ${headSha.slice(0, 7)})`;
  } catch (err) {
    return `Error opening PR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function commitToPullRequest(input: z.infer<typeof commitToPrParams>): Promise<string> {
  parseRepo(input.repo);
  const repoPath = `/repos/${input.repo}`;

  try {
    const headSha = await createFilesCommit(repoPath, input.branch, input.files, input.message);
    return `Pushed commit to ${input.repo}@${input.branch}: ${headSha.slice(0, 7)}`;
  } catch (err) {
    return `Error committing to PR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function createGitHubIssue(input: z.infer<typeof createIssueParams>): Promise<string> {
  parseRepo(input.repo);
  await applyContextDefaults(input);

  try {
    const issueBody = `${input.body}${buildFooter(input.requestedBy, input.traceUrl)}`;
    const issue = await githubApi<Issue>(`/repos/${input.repo}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        body: issueBody,
      }),
    });
    return `Created issue #${issue.number}: ${issue.html_url}`;
  } catch (err) {
    return `Error creating issue: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function commentOnGitHubIssue(input: z.infer<typeof commentOnIssueParams>): Promise<string> {
  parseRepo(input.repo);
  await applyContextDefaults(input);

  try {
    const commentBody = `${input.body}${buildFooter(input.requestedBy, input.traceUrl)}`;
    const comment = await githubApi<{ html_url: string; id: number; body: string }>(
      `/repos/${input.repo}/issues/${input.issue_number}/comments`,
      {
        method: "POST",
        body: JSON.stringify({
          body: commentBody,
        }),
      },
    );
    return `Commented on issue #${input.issue_number}: ${comment.html_url}`;
  } catch (err) {
    return `Error commenting on issue: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const openPrTool: Tool = {
  name: "open_pr",
  description:
    "Open a GitHub pull request. Provide repo (owner/name), branch name, PR title/body, and optional files to commit. GitHub auth uses a short-lived GitHub App token when configured, or GITHUB_TOKEN as a fallback. The Slack requester and agent trace URL are appended automatically from the conversation context.",
  params: openPrParams,
  tier: "basic",
  githubBot: true,
  run: openPullRequest,
};

export const commitToPrTool: Tool = {
  name: "commit_to_pr",
  description:
    "Push an additional commit to an existing pull request branch. Provide repo (owner/name), branch name, commit message, and files. GitHub auth uses a short-lived GitHub App token when configured, or GITHUB_TOKEN as a fallback.",
  params: commitToPrParams,
  tier: "basic",
  githubBot: true,
  run: commitToPullRequest,
};

export const createIssueTool: Tool = {
  name: "create_issue",
  description:
    "Create a GitHub issue. Provide repo (owner/name), title, and body. GitHub auth uses a short-lived GitHub App token when configured, or GITHUB_TOKEN as a fallback. The Slack requester and agent trace URL are appended automatically from the conversation context.",
  params: createIssueParams,
  tier: "basic",
  githubBot: true,
  run: createGitHubIssue,
};

export const commentOnIssueTool: Tool = {
  name: "comment_on_issue",
  description:
    "Post a comment on an existing GitHub issue or pull request. Provide repo (owner/name), issue_number, and body. GitHub auth uses a short-lived GitHub App token when configured, or GITHUB_TOKEN as a fallback. The Slack requester and agent trace URL are appended automatically from the conversation context.",
  params: commentOnIssueParams,
  tier: "basic",
  githubBot: true,
  run: commentOnGitHubIssue,
};
