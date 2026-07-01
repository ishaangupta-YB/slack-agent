import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
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
import { appendMemory } from "./tools/memory.js";
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

function systemPrompt(tier: AccessTier): string {
  if (cfg.agent.systemPromptOverride) return cfg.agent.systemPromptOverride;
  return (
    "You are Moon Bot, a helpful engineering assistant that lives in Slack. " +
    "You answer questions about code, metrics, and operations. " +
    `Your access tier is ${tier}. Only use tools available at your tier. ` +
    "You have access to tools. Use them when facts are not in your context. " +
    "Be concise but thorough, defaulting to Slack-compatible markdown." +
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
}

export async function handleMessage(
  threadKey: string,
  text: string,
  messageTs: string,
  userId: string,
  userEmail?: string,
): Promise<HandleMessageResult> {
  const tier = await resolveAccessTier(userId, userEmail);

  const toolCtx = getToolContext();
  toolCtx.userEmail = userEmail;

  const map = await ensureThreadMap();
  let entry = map[threadKey];
  if (!entry) {
    entry = {
      sessionFilename: `${randomUUID()}.jsonl`,
      lastProcessedMessageTs: messageTs,
    };
    map[threadKey] = entry;
    await ensureSessionFile(entry.sessionFilename);
    appendSessionMessage(entry.sessionFilename, {
      role: "system",
      content: systemPrompt(tier),
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
  const messages: LlmMessage[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // Ensure the first system message always reflects the user's current tier.
  if (messages.length > 0 && messages[0].role === "system") {
    messages[0].content = systemPrompt(tier);
  }

  const reply = await runToolLoop(entry.sessionFilename, messages, tier, userId);

  appendMemory({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    threadKey,
    userId,
    prompt: text,
    outcome: reply,
  });

  return { text: reply, sessionFilename: entry.sessionFilename };
}
