#!/usr/bin/env tsx
/**
 * Unified pre-flight verifier for Moon Bot.
 *
 * Runs the diagnostic, Slack, Cloudflare Workers AI, and GitHub checks in one
 * command so operators can confirm everything is ready before starting the bot
 * or recording the demo. Each section can be skipped via options for CI and
 * smoke tests.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { verifyCloudflare, type VerifyCloudflareOptions } from "./verify-cloudflare.js";
import { verifyGitHub, type VerifyGitHubOptions } from "./verify-github.js";
import { runDiagnostics, type DiagnosticCheck } from "../src/diagnostics.js";
import type { verifySlack as VerifySlackFn, VerifyClients } from "./verify-slack.js";

export interface PreflightOptions {
  /** Optional Slack WebClient mocks (bot + app) for testing. */
  slackClients?: VerifyClients;
  /** Optional overrides for the Cloudflare verification. */
  cloudflare?: VerifyCloudflareOptions;
  /** Optional overrides for the GitHub verification. */
  github?: VerifyGitHubOptions;
  skipSlack?: boolean;
  skipCloudflare?: boolean;
  skipGitHub?: boolean;
  skipDiagnostics?: boolean;
}

export interface PreflightCheck {
  name: string;
  status: "ok" | "fail" | "warn";
  message: string;
}

export interface PreflightSection {
  name: string;
  ok: boolean;
  checks: PreflightCheck[];
}

export interface PreflightResult {
  ok: boolean;
  sections: PreflightSection[];
}

function formatStatus(ok: boolean): "ok" | "fail" {
  return ok ? "ok" : "fail";
}

async function runDiagnosticsSection(): Promise<PreflightSection> {
  const result = await runDiagnostics();
  return {
    name: "diagnostics",
    ok: result.ok,
    checks: result.checks.map((c: DiagnosticCheck) => ({
      name: c.name,
      status: c.status === "ok" ? "ok" : c.status === "warn" ? "warn" : "fail",
      message: c.message,
    })),
  };
}

async function runSlackSection(options?: PreflightOptions): Promise<PreflightSection> {
  try {
    const slackMod = (await import("./verify-slack.js")) as { verifySlack: typeof VerifySlackFn };
    const result = await slackMod.verifySlack(options?.slackClients);
    return {
      name: "slack",
      ok: result.ok,
      checks: result.checks.map((c) => ({
        name: c.name,
        status: formatStatus(c.ok),
        message: c.message,
      })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: "slack",
      ok: false,
      checks: [{ name: "environment", status: "fail", message }],
    };
  }
}

async function runCloudflareSection(options?: PreflightOptions): Promise<PreflightSection> {
  const result = await verifyCloudflare(options?.cloudflare);
  return {
    name: "cloudflare",
    ok: result.ok,
    checks: result.checks.map((c) => ({
      name: c.name,
      status: formatStatus(c.ok),
      message: c.message,
    })),
  };
}

async function runGitHubSection(options?: PreflightOptions): Promise<PreflightSection> {
  const result = await verifyGitHub(options?.github);
  return {
    name: "github",
    ok: result.ok,
    checks: result.checks.map((c) => ({
      name: c.name,
      status: formatStatus(c.ok),
      message: c.message,
    })),
  };
}

/**
 * Run every configured pre-flight check and return a structured report.
 *
 * Sections are independent: a Slack token failure does not prevent the
 * Cloudflare and GitHub checks from running, giving operators a complete view
 * of what still needs configuration.
 */
export async function runAllPreflightChecks(options?: PreflightOptions): Promise<PreflightResult> {
  const sections: PreflightSection[] = [];

  if (!options?.skipDiagnostics) {
    sections.push(await runDiagnosticsSection());
  }
  if (!options?.skipSlack) {
    sections.push(await runSlackSection(options));
  }
  if (!options?.skipCloudflare) {
    sections.push(await runCloudflareSection(options));
  }
  if (!options?.skipGitHub) {
    sections.push(await runGitHubSection(options));
  }

  return { ok: sections.every((s) => s.ok), sections };
}

function formatReport(result: PreflightResult): void {
  console.log("Moon Bot unified pre-flight verification\n");
  for (const section of result.sections) {
    const sectionIcon = section.ok ? "✅" : "❌";
    console.log(`${sectionIcon} ${section.name}`);
    for (const check of section.checks) {
      const icon = check.status === "ok" ? "  ✅" : check.status === "warn" ? "  ⚠️" : "  ❌";
      console.log(`${icon} ${check.name}: ${check.message}`);
    }
    console.log("");
  }

  if (result.ok) {
    console.log("All pre-flight checks passed. Moon Bot is ready to start.");
  } else {
    console.log("Some pre-flight checks failed. Fix the issues above before starting Moon Bot.");
  }
}

async function main(): Promise<void> {
  const result = await runAllPreflightChecks();
  formatReport(result);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
