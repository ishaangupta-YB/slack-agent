import { z } from "zod";
import { cfg } from "../config.js";
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

const createIssueParams = z.object({
  repo: z.string(),
  title: z.string(),
  body: z.string(),
});

const GH_API_BASE = "https://api.github.com";

function authHeaders(): Record<string, string> {
  const token = cfg.integrations.githubToken;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not configured");
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = path.startsWith("http") ? path : `${GH_API_BASE}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub API ${options.method || "GET"} ${path} failed (${resp.status}): ${body}`);
  }

  if (resp.status === 204) {
    return undefined as T;
  }
  return (await resp.json()) as T;
}

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

async function openPullRequest(input: z.infer<typeof openPrParams>): Promise<string> {
  if (!cfg.integrations.githubToken) {
    return "Error: GITHUB_TOKEN is not configured.";
  }

  const [owner, repo] = input.repo.split("/");
  if (!owner || !repo) {
    return `Error: repo must be in "owner/name" format, got "${input.repo}".`;
  }

  const repoPath = `/repos/${input.repo}`;

  try {
    // 1. Resolve base branch SHA.
    const baseRef = await api<GitRef>(`${repoPath}/git/refs/heads/${input.base}`);
    const baseSha = baseRef.object.sha;

    // 2. Create (or reuse) the head branch.
    try {
      await api<GitRef>(`${repoPath}/git/refs`, {
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

    // 3. If files are provided, build a commit; otherwise the branch already points at base.
    let headSha = baseSha;
    if (input.files && input.files.length > 0) {
      const fileBlobs = await Promise.all(
        input.files.map(async (f: PrFile) => {
          const blob = await api<GitBlob>(`${repoPath}/git/blobs`, {
            method: "POST",
            body: JSON.stringify({
              content: Buffer.from(f.content).toString("base64"),
              encoding: "base64",
            }),
          });
          return { path: f.path, sha: blob.sha };
        }),
      );

      const tree = await api<GitTree>(`${repoPath}/git/trees`, {
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

      const commit = await api<GitCommit>(`${repoPath}/git/commits`, {
        method: "POST",
        body: JSON.stringify({
          message: input.title,
          tree: tree.sha,
          parents: [baseSha],
        }),
      });

      await api<void>(`${repoPath}/git/refs/heads/${input.branch}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha }),
      });
      headSha = commit.sha;
    }

    // 4. Open the pull request.
    const prBody = `${input.body}${buildFooter(input.requestedBy, input.traceUrl)}`;
    const pr = await api<PullRequest>(`${repoPath}/pulls`, {
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

async function createGitHubIssue(input: z.infer<typeof createIssueParams>): Promise<string> {
  if (!cfg.integrations.githubToken) {
    return "Error: GITHUB_TOKEN is not configured.";
  }

  const [owner, repo] = input.repo.split("/");
  if (!owner || !repo) {
    return `Error: repo must be in "owner/name" format, got "${input.repo}".`;
  }

  try {
    const issue = await api<Issue>(`/repos/${input.repo}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        body: input.body,
      }),
    });
    return `Created issue #${issue.number}: ${issue.html_url}`;
  } catch (err) {
    return `Error creating issue: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const openPrTool: Tool = {
  name: "open_pr",
  description:
    "Open a GitHub pull request. Provide repo (owner/name), branch name, PR title/body, and optional files to commit. Requires GITHUB_TOKEN. Optionally include requestedBy (Slack user mention) and traceUrl.",
  params: openPrParams,
  tier: "privileged",
  run: openPullRequest,
};

export const createIssueTool: Tool = {
  name: "create_issue",
  description: "Create a GitHub issue. Provide repo (owner/name), title, and body. Requires GITHUB_TOKEN.",
  params: createIssueParams,
  tier: "privileged",
  run: createGitHubIssue,
};
