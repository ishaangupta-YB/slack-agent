import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.js";
import { bucket } from "./storage/bucket.js";
import { renderSessionTrace } from "./storage/trace-viewer.js";

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
    `# Ishu response`,
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

  // For HuggingFace Buckets, render the session as a static HTML file and store
  // it in the bucket so the trace viewer works without the local bucket server.
  // For local filesystem buckets, keep using the local /trace endpoint.
  let traceUrl = bucket.readUrl(`trace/${sanitizeFilename(sessionFilename)}`);
  if (cfg.hf.bucketRepo && cfg.hf.token) {
    const tracePath = `trace/${sanitizeFilename(sessionFilename)}.html`;
    const traceHtml = renderSessionTrace(sessionFilename, sessionContent);
    await bucket.write(tracePath, traceHtml, "text/html; charset=utf-8");
    traceUrl = bucket.readUrl(tracePath);
  }

  return {
    responseUrl: bucket.readUrl(responsePath),
    sessionUrl: bucket.readUrl(sessionPath),
    traceUrl,
  };
}
