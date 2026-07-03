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

const searchIssuesParams = z.object({
  q: z.string().describe("GitHub search query, e.g. is:issue repo:owner/name label:bug"),
  sort: z.enum(["created", "updated", "comments"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  per_page: z.number().int().min(1).max(100).optional().default(10),
  page: z.number().int().min(1).optional().default(1),
});

const getPrDiffParams = z.object({
  repo: z.string().describe("Repository in owner/name format."),
  pull_number: z.number().int().describe("Pull request number."),
  max_files: z.number().int().min(1).max(100).optional().default(10),
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

interface SearchIssueItem {
  html_url: string;
  number: number;
  title: string;
  state: string;
  state_reason?: string | null;
  user: { login: string };
  labels: Array<{ name: string }>;
  comments: number;
  created_at: string;
  updated_at: string;
}

interface SearchIssuesResponse {
  total_count: number;
  incomplete_results: boolean;
  items: SearchIssueItem[];
}

interface PrDiffFile {
  sha: string;
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
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
  const lines = ["", "---", "_Created by Ishu_"];
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

async function searchGitHubIssues(input: z.infer<typeof searchIssuesParams>): Promise<string> {
  try {
    const params = new URLSearchParams();
    params.set("q", input.q);
    if (input.sort) params.set("sort", input.sort);
    if (input.order) params.set("order", input.order);
    params.set("per_page", String(input.per_page));
    params.set("page", String(input.page));

    const result = await githubApi<SearchIssuesResponse>(`/search/issues?${params.toString()}`);

    if (!result.items || result.items.length === 0) {
      return `No issues found for query "${input.q}".`;
    }

    const lines = [`Found ${result.total_count} result(s) for "${input.q}":\n`];
    for (const item of result.items) {
      const labels = item.labels.map((l) => l.name).join(", ") || "none";
      lines.push(
        `• #${item.number} [${item.state}] ${item.title}`,
        `  ${item.html_url}`,
        `  by ${item.user.login} · ${item.comments} comment(s) · labels: ${labels} · updated ${item.updated_at.slice(0, 10)}`,
      );
    }

    if (result.incomplete_results) {
      lines.push("\n_Results may be incomplete (GitHub rate-limit/time-out). Try narrowing the query._");
    }

    return lines.join("\n");
  } catch (err) {
    return `Error searching issues: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function getPrDiff(input: z.infer<typeof getPrDiffParams>): Promise<string> {
  parseRepo(input.repo);
  try {
    const files = await githubApi<PrDiffFile[]>(
      `/repos/${input.repo}/pulls/${input.pull_number}/files?per_page=${input.max_files}`,
    );

    if (!files || files.length === 0) {
      return `No files found for PR #${input.pull_number} in ${input.repo}.`;
    }

    const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
    const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

    const lines = [
      `PR #${input.pull_number} in ${input.repo}: ${files.length} file(s), +${totalAdditions}/-${totalDeletions}`,
      "",
    ];

    for (const file of files) {
      const patchPreview = file.patch ? `\n\`\`\`diff\n${file.patch.slice(0, 800)}${file.patch.length > 800 ? "\n... (truncated)" : ""}\n\`\`\`` : "";
      const renameInfo = file.previous_filename && file.status === "renamed" ? ` (from ${file.previous_filename})` : "";
      lines.push(
        `• *${file.filename}* — ${file.status}${renameInfo} (+${file.additions}/-${file.deletions})${patchPreview}`,
      );
    }

    return lines.join("\n");
  } catch (err) {
    return `Error fetching PR diff: ${err instanceof Error ? err.message : String(err)}`;
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

export const searchIssuesTool: Tool = {
  name: "search_issues",
  description:
    "Search GitHub issues and pull requests using the GitHub Search API. Provide a query (e.g. is:issue repo:owner/name label:bug) and optional sort, order, per_page, and page. Useful for avoiding duplicate reports and finding related work before creating a new issue or PR.",
  params: searchIssuesParams,
  tier: "basic",
  githubBot: true,
  run: searchGitHubIssues,
};

export const getPrDiffTool: Tool = {
  name: "get_pr_diff",
  description:
    "Fetch the changed files and diff patch for a GitHub pull request. Provide repo (owner/name) and pull_number. Optionally limit the number of files returned with max_files (default 10). Useful for reviewing PRs, summarizing changes, or deciding whether to comment.",
  params: getPrDiffParams,
  tier: "basic",
  githubBot: true,
  run: getPrDiff,
};
