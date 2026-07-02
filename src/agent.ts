import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.js";
import { bucket } from "./storage/bucket.js";
import { chat, type Message as LlmMessage } from "./llm/cloudflare.js";
import { loadSkills, buildSkillPrompt } from "./skills/loader.js";
import {
  formatToolInstructions,
  formatToolResult,
  parseToolCalls,
} from "./tools/parser.js";
import { listTools, runToolCall } from "./tools/registry.js";
import { appendMemory, getMemoryByThreadKey, searchMemory, type MemoryEntry } from "./tools/memory.js";
import { resolveAccessTier, type AccessTier } from "./auth/tiers.js";
import { getToolContext } from "./context.js";

interface ThreadMapEntry {
  sessionFilename: string;
  lastProcessedMessageTs: string;
}

type ThreadMap = Record<string, ThreadMapEntry>;

export interface StoredMessage {
  role: "system" | "user" | "assistant";
  content: string;
  ts?: string;
  userId?: string;
}

const skills = loadSkills();

function formatMemoryContext(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => {
    const date = new Date(e.timestamp).toISOString();
    return `- ${date} thread=${e.threadKey}\nQ: ${e.prompt}\nA: ${e.outcome}`;
  });
  return (
    "\n\n## Memory of past conversations\n" +
    "Use the following prior interactions to answer if they are relevant.\n\n" +
    lines.join("\n\n")
  );
}

async function buildMemoryContext(threadKey: string, prompt: string): Promise<string> {
  const limit = cfg.agent.memoryContextEntries;
  if (limit <= 0) return "";

  const sameThread = await getMemoryByThreadKey(threadKey, Math.max(1, limit));
  const relevant = prompt.trim()
    ? await searchMemory(prompt, Math.max(1, limit))
    : [];

  // De-duplicate by id while preserving order (same-thread first, then related).
  const seen = new Set<string>();
  const combined: MemoryEntry[] = [];
  for (const e of [...sameThread, ...relevant]) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      combined.push(e);
      if (combined.length >= limit) break;
    }
  }
  return formatMemoryContext(combined);
}

function systemPrompt(tier: AccessTier, memoryContext = ""): string {
  if (cfg.agent.systemPromptOverride) return cfg.agent.systemPromptOverride;
  return (
    "You are Moon Bot, a helpful engineering assistant that lives in Slack. " +
    "You answer questions about code, metrics, and operations. " +
    `Your access tier is ${tier}. Only use tools available at your tier. ` +
    "You have access to tools. Use them when facts are not in your context. " +
    "Be concise but thorough, defaulting to Slack-compatible markdown." +
    memoryContext +
    formatToolInstructions(listTools(tier)) +
    buildSkillPrompt(skills)
  );
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function threadMapPath(): string {
  ensureDir(cfg.agent.sessionsDir);
  return cfg.agent.threadMapFile;
}

async function ensureThreadMap(): Promise<ThreadMap> {
  const path = threadMapPath();
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf-8")) as ThreadMap;
  }
  try {
    const content = await bucket.read("thread-map.json");
    writeFileSync(path, content);
    return JSON.parse(content.toString("utf-8")) as ThreadMap;
  } catch {
    return {};
  }
}

async function writeThreadMap(map: ThreadMap) {
  const payload = JSON.stringify(map, null, 2);
  writeFileSync(threadMapPath(), payload);
  try {
    await bucket.write("thread-map.json", payload);
  } catch (err) {
    console.warn("Failed to sync thread-map to bucket:", err instanceof Error ? err.message : String(err));
  }
}

function sessionFilePath(filename: string): string {
  ensureDir(cfg.agent.sessionsDir);
  return join(cfg.agent.sessionsDir, filename);
}

async function ensureSessionFile(filename: string): Promise<string> {
  const path = sessionFilePath(filename);
  if (existsSync(path)) return path;
  try {
    const content = await bucket.read(`sessions/${filename}`);
    writeFileSync(path, content);
    return path;
  } catch {
    return path;
  }
}

async function readSessionMessages(filename: string): Promise<StoredMessage[]> {
  await ensureSessionFile(filename);
  const path = sessionFilePath(filename);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredMessage);
}

/**
 * Group a list of LLM messages into atomic segments for context truncation.
 *
 * An assistant message that contains a <tool_call> must always be followed by
 * the user observation that contains the tool results; the pair is kept or
 * dropped together so the model never sees a dangling tool call without its
 * outcome.
 */
function groupAtomicSegments(messages: LlmMessage[]): LlmMessage[][] {
  const groups: LlmMessage[][] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (
      msg.role === "assistant" &&
      msg.content.includes("<tool_call>") &&
      i + 1 < messages.length &&
      messages[i + 1].role === "user"
    ) {
      groups.push([msg, messages[i + 1]]);
      i += 2;
    } else {
      groups.push([msg]);
      i++;
    }
  }
  return groups;
}

function flattenMessages(groups: LlmMessage[][]): LlmMessage[] {
  return groups.flat();
}

function truncateLlmMessages(messages: LlmMessage[], max: number): LlmMessage[] {
  if (max <= 0 || messages.length <= max) return messages;

  const hasSystem = messages[0]?.role === "system";
  const systemMsg = hasSystem ? messages[0] : undefined;
  const body = hasSystem ? messages.slice(1) : messages;
  const maxBody = max - (hasSystem ? 1 : 0);

  if (maxBody <= 0) {
    return systemMsg ? [systemMsg] : messages;
  }

  const groups = groupAtomicSegments(body);
  const pruned = groups;
  while (flattenMessages(pruned).length > maxBody && pruned.length > 0) {
    pruned.shift();
  }

  const result = flattenMessages(pruned);
  if (systemMsg) {
    result.unshift(systemMsg);
  }
  return result;
}

/**
 * Build the list of LLM messages for a Slack thread from persisted session
 * history. The first system message is always refreshed with the current
 * access tier and cross-thread memory context, and the result is optionally
 * truncated to keep long Slack conversations within a sensible context window.
 */
export function prepareLlmMessages(
  storedMessages: StoredMessage[],
  tier: AccessTier,
  memoryContext: string,
  maxContextMessages: number,
): LlmMessage[] {
  const messages: LlmMessage[] = storedMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  if (messages.length > 0 && messages[0].role === "system") {
    messages[0].content = systemPrompt(tier, memoryContext);
  }

  return truncateLlmMessages(messages, maxContextMessages);
}

function appendSessionMessage(filename: string, msg: StoredMessage) {
  appendFileSync(sessionFilePath(filename), JSON.stringify(msg) + "\n");
}

function appendLlmMessages(filename: string, messages: LlmMessage[], userId?: string) {
  for (const m of messages) {
    appendSessionMessage(filename, {
      role: m.role,
      content: m.content,
      ts: new Date().toISOString(),
      userId,
    });
  }
}

async function runToolLoop(
  filename: string,
  messages: LlmMessage[],
  tier: AccessTier,
  userId?: string,
): Promise<string> {
  const maxIterations = 10;

  for (let i = 0; i < maxIterations; i++) {
    const reply = await chat(messages);
    const calls = parseToolCalls(reply);

    if (calls.length === 0) {
      appendLlmMessages(filename, [
        { role: "assistant", content: reply },
      ]);
      return reply;
    }

    // Record assistant's tool-call message.
    appendLlmMessages(filename, [
      { role: "assistant", content: reply },
    ]);

    messages.push({ role: "assistant", content: reply });

    const results = await Promise.all(
      calls.map((call) =>
        runToolCall(call, cfg.agent.maxMemoryEntries > 0 ? 8_000 : 8_000, tier),
      ),
    );

    const observation = results.map(formatToolResult).join("\n\n");
    messages.push({ role: "user", content: observation });
    appendLlmMessages(filename, [{ role: "user", content: observation }], userId);
  }

  return "I reached the maximum number of tool calls for this turn. Please ask me to continue if needed.";
}

export interface HandleMessageResult {
  text: string;
  sessionFilename: string;
  /** True when the message was a duplicate/out-of-order Slack event and was ignored. */
  skipped?: boolean;
}

/**
 * Look up the persisted session filename for a Slack thread key, if any.
 * This lets non-message handlers (e.g. feedback block actions) correlate
 * a Slack message with its agent session trace.
 */
export async function getSessionFilenameByThreadKey(
  threadKey: string,
): Promise<string | undefined> {
  const map = await ensureThreadMap();
  return map[threadKey]?.sessionFilename;
}

/**
 * Returns true if the bot already has an active session for the given Slack
 * thread key. Used by the Slack routing layer to decide whether to respond to
 * thread follow-ups that do not explicitly @-mention the bot.
 */
export async function hasThreadKey(threadKey: string): Promise<boolean> {
  const map = await ensureThreadMap();
  return threadKey in map;
}

/**
 * Reset an active thread by removing its thread-map entry and deleting the
 * local session file.
 *
 * This is used by the Slack "Start over" action so users can clear a
 * conversation and begin a fresh agent session on their next message. The
 * operation is serialized on the thread key to avoid racing with an in-flight
 * message handler.
 */
export async function resetThread(threadKey: string): Promise<boolean> {
  return runLocked(threadKey, async () => {
    const map = await ensureThreadMap();
    const entry = map[threadKey];
    if (!entry) return false;

    const path = sessionFilePath(entry.sessionFilename);
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }

    delete map[threadKey];
    await writeThreadMap(map);
    return true;
  });
}

const threadLocks = new Map<string, Promise<unknown>>();

async function runLocked<T>(threadKey: string, fn: () => Promise<T>): Promise<T> {
  const current = threadLocks.get(threadKey) ?? Promise.resolve();
  const next = current.then(() => fn()).finally(() => {
    // Only delete if no newer lock was queued while we ran.
    if (threadLocks.get(threadKey) === next) {
      threadLocks.delete(threadKey);
    }
  });
  threadLocks.set(threadKey, next);
  return next;
}

export async function handleMessage(
  threadKey: string,
  text: string,
  messageTs: string,
  userId: string,
  userEmail?: string,
): Promise<HandleMessageResult> {
  return runLocked(threadKey, async () => {
    const tier = await resolveAccessTier(userId, userEmail);

    const toolCtx = getToolContext();
    toolCtx.userEmail = userEmail;
    toolCtx.tier = tier;

    const memoryContext = await buildMemoryContext(threadKey, text);

    const map = await ensureThreadMap();
    let entry = map[threadKey];

    // Duplicate or out-of-order Slack event: silently ignore.
    if (entry && messageTs <= entry.lastProcessedMessageTs) {
      return { text: "", sessionFilename: entry.sessionFilename, skipped: true };
    }

    if (!entry) {
      entry = {
        sessionFilename: `${randomUUID()}.jsonl`,
        lastProcessedMessageTs: messageTs,
      };
      map[threadKey] = entry;
      await ensureSessionFile(entry.sessionFilename);
      appendSessionMessage(entry.sessionFilename, {
        role: "system",
        content: systemPrompt(tier, memoryContext),
        ts: new Date().toISOString(),
      });
    }

    entry.lastProcessedMessageTs = messageTs;
    toolCtx.sessionFilename = entry.sessionFilename;
    await writeThreadMap(map);

    // On restarts the session file may only exist in the bucket. Download it
    // before appending so the full conversation history is available.
    await ensureSessionFile(entry.sessionFilename);
    appendSessionMessage(entry.sessionFilename, {
      role: "user",
      content: text,
      ts: new Date().toISOString(),
      userId,
    });

    const history = await readSessionMessages(entry.sessionFilename);
    const messages = prepareLlmMessages(
      history,
      tier,
      memoryContext,
      cfg.agent.maxContextMessages,
    );

    const reply = await runToolLoop(entry.sessionFilename, messages, tier, userId);

    await appendMemory({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      threadKey,
      userId,
      prompt: text,
      outcome: reply,
    });

    return { text: reply, sessionFilename: entry.sessionFilename };
  });
}
