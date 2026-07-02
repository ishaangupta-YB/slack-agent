import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { cfg } from "../config.js";
import { getGitHubToken } from "../integrations/github.js";
import type { Tool } from "./types.js";

export type CloneExecutor = (
  args: string[],
  cwd?: string,
) => { stdout: string; stderr: string; exitCode: number };

let cloneExecutor: CloneExecutor | undefined;

export function setCloneExecutor(fn: CloneExecutor): void {
  cloneExecutor = fn;
}

export function clearCloneExecutor(): void {
  cloneExecutor = undefined;
}

function runGit(
  args: string[],
  cwd?: string,
): { stdout: string; stderr: string; exitCode: number } {
  if (cloneExecutor) {
    return cloneExecutor(args, cwd);
  }

  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

function parseRepoName(input: string): { owner: string; repo: string } | undefined {
  const trimmed = input.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return undefined;
  }

  const [owner, repo] = trimmed.split("/") as [string, string];
  return { owner, repo };
}

const cloneRepoParams = z.object({
  repo: z.string().describe("GitHub repository in owner/name format."),
  branch: z.string().optional().describe("Branch to clone. Defaults to the repository default branch."),
});

export const cloneRepoTool: Tool = {
  name: "clone_repo",
  description:
    "Clone a GitHub repository into CODE_REPOS_DIR so search_code can navigate it. Provide repo as owner/name. Optional branch.",
  params: cloneRepoParams,
  tier: "basic",
  githubBot: true,
  async run(input) {
    const parsed = parseRepoName(input.repo);
    if (!parsed) {
      return `Error: invalid repo format "${input.repo}". Expected owner/name.`;
    }

    const { owner, repo } = parsed;
    const reposDir = cfg.code.reposDir;
    if (!existsSync(reposDir)) {
      mkdirSync(reposDir, { recursive: true });
    }

    const targetDir = join(reposDir, repo);
    if (existsSync(targetDir)) {
      return `Directory ${targetDir} already exists. Use search_code to explore it, or delete it manually to re-clone.`;
    }

    let token: string;
    try {
      token = await getGitHubToken();
    } catch {
      return `Error: GitHub is not configured. Set GITHUB_TOKEN or GITHUB_APP_ID + GITHUB_PRIVATE_KEY + GITHUB_INSTALLATION_ID.`;
    }

    const url = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    const args = ["clone", "--depth", "1"];
    if (input.branch) {
      args.push("--branch", input.branch);
    }

    args.push(url, targetDir);

    const result = runGit(args, reposDir);
    if (result.exitCode !== 0) {
      const details = result.stderr || result.stdout || "unknown git error";
      return `Error cloning ${input.repo}:\n${details}`;
    }

    return `Cloned ${input.repo} into ${targetDir}`;
  },
};
