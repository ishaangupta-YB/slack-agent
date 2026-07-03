#!/usr/bin/env tsx
/**
 * Pre-submission readiness checker for the Slack Agent Builder Challenge.
 *
 * Verifies that required deliverable files exist, that forbidden files
 * (WRITEUP.md, .env, k8s/secret.yaml) are not tracked by git, and that
 * SUBMISSION.md has no unchecked checklist items or placeholders.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

export interface SubmissionIssue {
  check: string;
  message: string;
}

const requiredFiles = [
  "README.md",
  "SUBMISSION.md",
  "HACKATHON.md",
  "manifest.json",
  "Dockerfile",
  "docker-compose.yml",
  ".env.example",
  "k8s/deployment.yaml",
  "k8s/kustomization.yaml",
  "k8s/secret.example.yaml",
  "k8s/github-only/deployment.yaml",
  "k8s/github-only/kustomization.yaml",
  "k8s/github-only/secret.example.yaml",
  "k8s/github-only/service.yaml",
];

const forbiddenTrackedFiles = ["WRITEUP.md", ".env", "k8s/secret.yaml", "k8s/github-only/secret.yaml"];

const placeholderMarkers = ["(to be filled", "<fill", "TODO:", "FIXME:"];

export function checkSubmission(): { ok: boolean; issues: SubmissionIssue[] } {
  const issues: SubmissionIssue[] = [];

  for (const file of requiredFiles) {
    try {
      readFileSync(file);
    } catch {
      issues.push({ check: "required-file", message: `Missing required file: ${file}` });
    }
  }

  for (const file of forbiddenTrackedFiles) {
    try {
      execSync(`git ls-files --error-unmatch ${file}`, { stdio: "ignore" });
      issues.push({ check: "forbidden-tracked-file", message: `${file} is tracked by git and must not be committed` });
    } catch {
      // not tracked, ok
    }
  }

  let submission = "";
  try {
    submission = readFileSync("SUBMISSION.md", "utf8");
  } catch {
    issues.push({ check: "submission-file", message: "SUBMISSION.md is missing" });
  }

  const unchecked = submission.match(/^-\s*\[\s\]\s+.+/gm) ?? [];
  for (const item of unchecked) {
    issues.push({ check: "unchecked-submission-item", message: `Submission checklist item is unchecked: ${item}` });
  }

  for (const marker of placeholderMarkers) {
    if (submission.toLowerCase().includes(marker.toLowerCase())) {
      issues.push({ check: "placeholder-in-submission", message: `SUBMISSION.md still contains placeholder: ${marker}` });
    }
  }

  return { ok: issues.length === 0, issues };
}

function main() {
  const { ok, issues } = checkSubmission();
  console.log(`Submission readiness: ${ok ? "READY" : "NOT READY"}`);
  if (issues.length > 0) {
    console.log("\nIssues found:");
    for (const issue of issues) {
      console.log(`  [${issue.check}] ${issue.message}`);
    }
    process.exit(1);
  } else {
    console.log("\nAll submission checks passed.");
    console.log(`Required files present: ${requiredFiles.length}`);
    console.log("Forbidden files not tracked: ok");
    console.log("Submission checklist complete: ok");
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main();
}
