#!/usr/bin/env tsx
/**
 * Fill SUBMISSION.md placeholders from environment variables before the final
 * Devpost/hackathon submission. This is a one-way, manual step; run it only
 * after the Slack sandbox, demo video, and (optionally) Marketplace App ID are
 * available.
 */
import { readFileSync, writeFileSync } from "node:fs";

export interface FillableField {
  envKey: string;
  label: string;
  /** The exact tail of the checklist item that identifies the unfilled placeholder. */
  placeholderTail: string;
}

export const fillableFields: FillableField[] = [
  {
    envKey: "SLACK_SANDBOX_URL",
    label: "Slack developer sandbox URL",
    placeholderTail: "(to be filled when sandbox is provisioned)",
  },
  {
    envKey: "DEMO_VIDEO_URL",
    label: "Demo video link",
    placeholderTail: "(to be filled before final submission)",
  },
  {
    envKey: "SLACK_MARKETPLACE_APP_ID",
    label: "Slack Marketplace App ID",
    placeholderTail: "(only required if entering the Organizations track)",
  },
];

/**
 * Replace unfilled placeholder checklist items in `content` with checked items
 * whose values come from `env`. Unknown / empty env values leave the original
 * placeholder untouched.
 */
export function fillSubmission(
  content: string,
  env: Record<string, string | undefined>,
): string {
  let filled = content;
  for (const { envKey, label, placeholderTail } of fillableFields) {
    const value = env[envKey]?.trim();
    if (!value) continue;
    // Match an unchecked checklist item such as:
    // - [ ] Slack developer sandbox URL (to be filled when sandbox is provisioned)
    const pattern = new RegExp(
      `^- \\[ \\] ${escapeRegExp(label)} ${escapeRegExp(placeholderTail)}`,
      "gm",
    );
    filled = filled.replace(pattern, `- [x] ${label}: ${value}`);
  }
  return filled;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function fillSubmissionFromEnv(content: string): string {
  return fillSubmission(content, {
    SLACK_SANDBOX_URL: process.env.SLACK_SANDBOX_URL,
    DEMO_VIDEO_URL: process.env.DEMO_VIDEO_URL,
    SLACK_MARKETPLACE_APP_ID: process.env.SLACK_MARKETPLACE_APP_ID,
  });
}

function main() {
  const filePath = process.argv[2] || "SUBMISSION.md";
  const original = readFileSync(filePath, "utf8");
  const filled = fillSubmissionFromEnv(original);
  if (filled === original) {
    console.log("No submission placeholders were filled (set SLACK_SANDBOX_URL, DEMO_VIDEO_URL, and/or SLACK_MARKETPLACE_APP_ID to fill them).");
    return;
  }
  writeFileSync(filePath, filled);
  const filledCount = fillableFields.filter((f) => process.env[f.envKey]?.trim()).length;
  console.log(`Filled ${filledCount} submission placeholder(s) in ${filePath}.`);
  console.log("Run `npm run prepare-submission` to confirm everything is ready.");
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main();
}
