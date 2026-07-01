import { z } from "zod";
import { cfg } from "../config.js";
import type { Tool } from "./types.js";

interface PrFile {
  path: string;
  content: string;
}

const params = z.object({
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
});

export const openPrTool: Tool = {
  name: "open_pr",
  description:
    "Open a GitHub pull request. Provide repo (owner/name), branch name, PR title/body, and optional files to commit. Requires GITHUB_TOKEN.",
  params,
  async run(input) {
    if (!cfg.integrations.githubToken) {
      return "Error: GITHUB_TOKEN is not configured.";
    }

    // This is a placeholder for the in-process PR workflow described in WRITEUP.md.
    // A full implementation would mint a GitHub App token and push commits outside the sandbox.
    // For hackathon testing, we verify the caller has provided the required fields and return a structured plan.
    const summary = [
      `PR ready to be opened:`,
      `repo: ${input.repo}`,
      `base: ${input.base}`,
      `branch: ${input.branch}`,
      `title: ${input.title}`,
      `body: ${input.body.slice(0, 200)}${input.body.length > 200 ? "..." : ""}`,
      input.files && input.files.length > 0
        ? `files:\n${input.files.map((f: PrFile) => `- ${f.path}`).join("\n")}`
        : "no files included",
    ].join("\n");

    return `${summary}\n\nNote: full GitHub App commit/push workflow is not yet implemented. Configure GITHUB_TOKEN and implement the in-process PR flow to make this live.`;
  },
};
