import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cfg } from "./config.js";

export type FeedbackKind = "helpful" | "not_helpful";

export interface FeedbackEntry {
  ts: string;
  kind: FeedbackKind;
  userId: string;
  channel: string;
  messageTs: string;
  threadKey?: string;
  sessionFilename?: string;
}

function ensureLogFile(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Record a thumbs-up/thumbs-down reaction to a Moon Bot response.
 *
 * Feedback is appended to a JSONL file under the configured SESSIONS_DIR by
 * default, so it is persisted alongside sessions, memory, and audit logs.
 */
export function recordFeedback(entry: FeedbackEntry): void {
  const path = cfg.feedback.logFile;
  ensureLogFile(path);
  appendFileSync(path, JSON.stringify(entry) + "\n");
}

/**
 * Pre-flight helper: verify the feedback log file is writable.
 */
export function feedbackLogPath(): string {
  return cfg.feedback.logFile;
}
