import { execFileSync } from "node:child_process";
import { z } from "zod";
import { cfg } from "../config.js";
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

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the project root. Bash is disabled unless ALLOW_BASH=true. Single commands only; compound operators are rejected.",
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
      return "Error: command blocked by safety policy.";
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
