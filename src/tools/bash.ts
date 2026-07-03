import { execFileSync } from "node:child_process";
import { z } from "zod";
import { cfg } from "../config.js";
import { getToolContext } from "../context.js";
import type { AccessTier } from "../auth/tiers.js";
import { logSecurityEvent } from "./security.js";
import type { Tool } from "./types.js";

const params = z.object({
  command: z.string(),
  timeout: z.number().int().min(1).max(300).default(30),
});

const BLOCKED_COMMANDS = [
  /rm\s+-rf\s*\/*/,
  />\s*\/etc\/passwd/,
  /mkfs/,
  /dd\s+if=/,
  /:\(\)\{\s*:\|:\s*&\s*\};/,
];

const SUSPICIOUS_COMMANDS = [
  /curl\s+.*\|.*sh/i,
  /curl\s+.*\|.*bash/i,
  /wget\s+.*\|.*sh/i,
  /base64\s+--decode/i,
  /base64\s+-d/i,
  /curl\s+.*-d\s+.*/i,
  /wget\s+.*--post-data/i,
  /nc\s+.*-e\s+/i,
  /netcat\s+.*-e\s+/i,
  /python\s+.*http\.server/i,
];

function isSuspicious(command: string): boolean {
  return SUSPICIOUS_COMMANDS.some((re) => re.test(command));
}

function containsShellControlCharacters(command: string): boolean {
  return (
    command.includes("&&") ||
    command.includes("||") ||
    command.includes(";") ||
    command.includes("\n") ||
    command.includes("\r") ||
    command.includes("`") ||
    command.includes("$(")
  );
}

export type BashExecutor = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => string;

let executorOverride: BashExecutor | undefined;

/** Replace the default process-spawning executor (for tests). */
export function setBashExecutor(fn: BashExecutor): void {
  executorOverride = fn;
}

/** Restore the default process-spawning executor. */
export function clearBashExecutor(): void {
  executorOverride = undefined;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildSandboxCommand(
  command: string,
  cwd: string,
  tier: AccessTier,
): { command: string; args: string[] } {
  const user = cfg.bash.tierUsers[tier];
  if (!user) {
    return { command: "/bin/sh", args: ["-c", command] };
  }

  if (cfg.bash.requireRootForSu && process.getuid?.() !== 0) {
    throw new Error(`Bash sandboxing configured for tier ${tier} (user ${user}) but the process is not running as root.`);
  }

  const wrapped = `cd ${shellEscape(cwd)} && ${command}`;
  return { command: "su", args: ["-", user, "-c", wrapped] };
}

function getCurrentTier(): AccessTier {
  return getToolContext().tier ?? "basic";
}

function runCommand(command: string, args: string[], options: { cwd: string; timeoutMs: number }): string {
  if (executorOverride) {
    return executorOverride(command, args, options);
  }
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    timeout: options.timeoutMs,
    maxBuffer: 1024 * 1024,
  });
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the project root. Bash is disabled unless ALLOW_BASH=true. Single simple commands only; compound operators, command substitution (`...` or $(...)), and newlines are rejected. Suspicious commands are blocked and logged. When BASH_TIER_USERS is configured, commands run under the Linux user assigned to the caller's access tier via su -l.",
  params,
  tier: "basic",
  run(input) {
    if (!cfg.security.allowBash) {
      return "Error: bash execution is disabled. Set ALLOW_BASH=true to enable it.";
    }

    const command = input.command.trim();
    if (containsShellControlCharacters(command)) {
      return "Error: compound commands, command substitution, or multiline input are not allowed. Run one simple command at a time.";
    }
    if (BLOCKED_COMMANDS.some((re) => re.test(command))) {
      logSecurityEvent({
        type: "suspicious_command_blocked",
        details: { command, reason: "matches destructive command blocklist" },
      });
      return "Error: command blocked by safety policy.";
    }
    if (isSuspicious(command)) {
      logSecurityEvent({
        type: "suspicious_command_blocked",
        details: { command, reason: "matches suspicious command pattern" },
      });
      return "Error: this command looks potentially unsafe (exfiltration, remote execution, or decoding) and was blocked.";
    }

    try {
      const tier = getCurrentTier();
      const spawnSpec = buildSandboxCommand(command, process.cwd(), tier);
      const output = runCommand(spawnSpec.command, spawnSpec.args, {
        cwd: process.cwd(),
        timeoutMs: input.timeout * 1000,
      });
      return output || "(no output)";
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
