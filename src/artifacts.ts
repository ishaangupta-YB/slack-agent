import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.js";
import { bucket } from "./storage/bucket.js";

export interface ArtifactUrls {
  responseUrl: string;
  sessionUrl: string;
  traceUrl: string;
}

function sanitizeFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export async function uploadArtifacts(
  threadKey: string,
  sessionFilename: string,
  responseText: string,
): Promise<ArtifactUrls> {
  const now = new Date().toISOString();
  const responsePath = `responses/${sanitizeFilename(threadKey)}_${sanitizeFilename(now)}_${randomUUID().slice(0, 8)}.md`;

  const responseMarkdown = [
    `# Moon Bot response`,
    "",
    `- Thread: ${threadKey}`,
    `- Time: ${now}`,
    "",
    responseText,
  ].join("\n");

  await bucket.write(responsePath, responseMarkdown, "text/markdown; charset=utf-8");

  const sessionLocalPath = join(cfg.agent.sessionsDir, sessionFilename);
  const sessionContent = readFileSync(sessionLocalPath, "utf-8");
  const sessionPath = `sessions/${sanitizeFilename(sessionFilename)}`;
  await bucket.write(sessionPath, sessionContent, "application/jsonl; charset=utf-8");

  const publicBase =
    cfg.storage.bucketPublicUrl || `http://localhost:${cfg.storage.bucketHttpPort}`;
  const traceUrl = `${publicBase}/trace/${sanitizeFilename(sessionFilename)}`;

  return {
    responseUrl: bucket.readUrl(responsePath),
    sessionUrl: bucket.readUrl(sessionPath),
    traceUrl,
  };
}
