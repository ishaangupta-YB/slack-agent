import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { cfg } from "../config.js";
import { bucket } from "../storage/bucket.js";
import type { Tool } from "./types.js";

export interface MemoryEntry {
  id: string;
  timestamp: string;
  threadKey: string;
  userId: string;
  prompt: string;
  outcome: string;
}

interface MemoryStore {
  entries: MemoryEntry[];
}

function ensureStorage() {
  const dir = dirname(cfg.agent.memoryFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function readStore(): Promise<MemoryStore> {
  ensureStorage();

  if (!existsSync(cfg.agent.memoryFile)) {
    // On a fresh pod (or after local storage loss), try to restore memory.json
    // from the bucket so the agent keeps its cross-thread history.
    try {
      const remote = await bucket.read("memory.json");
      writeFileSync(cfg.agent.memoryFile, remote);
    } catch {
      // No remote memory yet; that's fine.
    }
  }

  if (!existsSync(cfg.agent.memoryFile)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(cfg.agent.memoryFile, "utf-8")) as MemoryStore;
  } catch {
    return { entries: [] };
  }
}

async function writeStore(store: MemoryStore): Promise<void> {
  ensureStorage();
  const payload = JSON.stringify(store, null, 2);
  writeFileSync(cfg.agent.memoryFile, payload);
  try {
    await bucket.write("memory.json", payload, "application/json; charset=utf-8");
  } catch (err) {
    console.warn("Failed to sync memory.json to bucket:", err instanceof Error ? err.message : String(err));
  }
}

// Serialize read/write operations so concurrent Slack events don't race on the
// shared memory file and drop entries.
let memoryQueue: Promise<unknown> = Promise.resolve();

function queueMemoryOp<T>(fn: () => Promise<T>): Promise<T> {
  const next = memoryQueue.then(() => fn(), () => fn());
  memoryQueue = next;
  return next as Promise<T>;
}

export async function getMemoryRecent(limit: number): Promise<MemoryEntry[]> {
  return queueMemoryOp(async () => {
    const store = await readStore();
    return store.entries.slice(-Math.max(0, limit)).reverse();
  });
}

export async function searchMemory(query: string, limit = 20): Promise<MemoryEntry[]> {
  return queueMemoryOp(async () => {
    const q = query.toLowerCase();
    const store = await readStore();
    return store.entries
      .filter(
        (e) =>
          e.prompt.toLowerCase().includes(q) ||
          e.outcome.toLowerCase().includes(q) ||
          e.threadKey.toLowerCase().includes(q),
      )
      .slice(-Math.max(0, limit))
      .reverse();
  });
}

/** Return the most recent memory entries for a specific Slack thread key. */
export async function getMemoryByThreadKey(threadKey: string, limit = 10): Promise<MemoryEntry[]> {
  return queueMemoryOp(async () => {
    const store = await readStore();
    return store.entries
      .filter((e) => e.threadKey === threadKey)
      .slice(-Math.max(0, limit))
      .reverse();
  });
}

export async function appendMemory(entry: MemoryEntry): Promise<void> {
  return queueMemoryOp(async () => {
    const store = await readStore();
    store.entries.push(entry);
    if (store.entries.length > cfg.agent.maxMemoryEntries) {
      store.entries = store.entries.slice(-cfg.agent.maxMemoryEntries);
    }
    await writeStore(store);
  });
}

const params = z.object({
  mode: z.enum(["recent", "search"]),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(10),
});

export const memoryTool: Tool = {
  name: "memory",
  description:
    "Read the shared memory store. mode=recent returns recent interactions; mode=search filters by query.",
  params,
  tier: "basic",
  async run(input) {
    const limit = input.limit ?? 10;
    let entries: MemoryEntry[];
    if (input.mode === "search") {
      if (!input.query) return "Error: mode=search requires a query";
      entries = await searchMemory(input.query, limit);
    } else {
      entries = await getMemoryRecent(limit);
    }
    if (entries.length === 0) return "No matching memory entries found.";
    return entries
      .map(
        (e) =>
          `[${new Date(e.timestamp).toISOString()}] thread=${e.threadKey}\nQ: ${e.prompt}\nA: ${e.outcome}`,
      )
      .join("\n\n---\n\n");
  },
};
