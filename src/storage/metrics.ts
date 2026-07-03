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
  messagesHandled: number;
  llmCalls: number;
  toolCalls: number;
  toolErrors: number;
}

export type CounterName = "messagesHandled" | "llmCalls" | "toolCalls" | "toolErrors";

const counters: Record<CounterName, number> = {
  messagesHandled: 0,
  llmCalls: 0,
  toolCalls: 0,
  toolErrors: 0,
};

export function incrementMetrics(name: CounterName, delta = 1): void {
  counters[name] += delta;
}

export function getCounter(name: CounterName): number {
  return counters[name];
}

export function resetMetricsCounters(): void {
  counters.messagesHandled = 0;
  counters.llmCalls = 0;
  counters.toolCalls = 0;
  counters.toolErrors = 0;
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
    messagesHandled: counters.messagesHandled,
    llmCalls: counters.llmCalls,
    toolCalls: counters.toolCalls,
    toolErrors: counters.toolErrors,
  };
}
