import { readFileSync } from "node:fs";

interface VersionInfo {
  version: string;
  node: string;
  uptimeSeconds: number;
  mode: string;
  model: string;
}

function formatDuration(seconds: number): string {
  const units: [number, string][] = [
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
    [1, "s"],
  ];

  if (seconds < 1) return "<1s";

  const parts: string[] = [];
  let remaining = Math.floor(seconds);
  for (const [size, label] of units) {
    if (remaining >= size) {
      const count = Math.floor(remaining / size);
      parts.push(`${count}${label}`);
      remaining %= size;
    }
  }
  return parts.slice(0, 2).join(" ") || "0s";
}

export function getVersionInfo(): VersionInfo {
  let version = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
      version?: string;
    };
    version = pkg.version || version;
  } catch {
    // ignore
  }

  const isGitHubOnly = process.env.GITHUB_ONLY === "true";

  return {
    version,
    node: process.version,
    uptimeSeconds: process.uptime(),
    mode: isGitHubOnly ? "GitHub-only webhook" : "Socket Mode",
    model: process.env.CLOUDFLARE_MODEL || "@cf/moonshotai/kimi-k2.7-code",
  };
}

export function formatVersionInfo(info: VersionInfo = getVersionInfo()): string {
  return (
    `*Ishu* 🌙 v${info.version}\n` +
    `• Runtime: Node.js ${info.node}\n` +
    `• Uptime: ${formatDuration(info.uptimeSeconds)}\n` +
    `• Mode: ${info.mode}\n` +
    `• Default model: \`${info.model}\``
  );
}
