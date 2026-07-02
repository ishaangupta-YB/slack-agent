import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "../config.js";

export interface Metrics {
  uptimeSeconds: number;
  sessions: number;
  threadMapEntries: number;
  memoryEntries: number;
  feedbackEntries: number;
  auditEntries: number;
  responseArtifacts: number;
}

function countFiles(dir: string, ext: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext)).length;
  } catch {
    return 0;
  }
}

function countJsonlLines(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const content = readFileSync(path, "utf-8").trim();
    if (!content) return 0;
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

function readJsonArrayCount(path: string, field: string): number {
  if (!existsSync(path)) return 0;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const arr = data[field];
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

function countThreadMapEntries(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return Object.keys(data).length;
  } catch {
    return 0;
  }
}

export function getMetrics(): Metrics {
  return {
    uptimeSeconds: Math.floor(process.uptime()),
    sessions: countFiles(join(cfg.storage.bucketDir, "sessions"), ".jsonl"),
    threadMapEntries: countThreadMapEntries(cfg.agent.threadMapFile),
    memoryEntries: readJsonArrayCount(cfg.agent.memoryFile, "entries"),
    feedbackEntries: countJsonlLines(cfg.feedback.logFile),
    auditEntries: countJsonlLines(cfg.security.auditLogFile),
    responseArtifacts: countFiles(join(cfg.storage.bucketDir, "responses"), ".md"),
  };
}
