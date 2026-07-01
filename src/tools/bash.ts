import { execFileSync } from "node:child_process";
import { z } from "zod";
import { cfg } from "../config.js";
import { logSecurityEvent } from "./security.js";
import type { Tool } from "./types.js";

const params = z.object({
  command: z.string(),
  timeout: z.number().int().min(1).max(300).default(30),
});

const BLOCKED_COMMANDS = [
  /rm\s+-rf\s*\/+/,
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

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the project root. Bash is disabled unless ALLOW_BASH=true. Single commands only; compound operators are rejected. Suspicious commands are blocked and logged.",
  params,
  run(input) {
    if (!cfg.security.allowBash) {
      return "Error: bash execution is disabled. Set ALLOW_BASH=true to enable it.";
    }

    const command = input.command.trim();
    if (command.includes("&&") || command.includes("||") || command.includes(";")) {
      return "Error: compound commands are not allowed. Run one command at a time.";
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

    const [shell, flag] = ["/bin/sh", "-c"];
    try {
      const output = execFileSync(shell, [flag, command], {
        cwd: process.cwd(),
        encoding: "utf-8",
        timeout: input.timeout * 1000,
        maxBuffer: 1024 * 1024,
      });
      return output || "(no output)";
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
