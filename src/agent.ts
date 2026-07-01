import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.js";
import { chat, type Message as LlmMessage } from "./llm/cloudflare.js";
import { loadSkills, buildSkillPrompt } from "./skills/loader.js";

interface ThreadMapEntry {
  sessionFilename: string;
  lastProcessedMessageTs: string;
}

type ThreadMap = Record<string, ThreadMapEntry>;

interface StoredMessage {
  role: "system" | "user" | "assistant";
  content: string;
  ts?: string;
}

const skills = loadSkills();

const systemPromptBase =
  "You are Moon Bot, a helpful engineering assistant that lives in Slack. " +
  "You answer questions about code, metrics, and operations. " +
  "You can use tools to read files, run shell commands (when enabled), search memory, and work with GitHub. " +
  "Be concise but thorough, defaulting to Slack-compatible markdown.";

function systemPrompt(): string {
  const sp = cfg.agent.systemPromptOverride || systemPromptBase;
  return sp + buildSkillPrompt(skills);
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function threadMapPath(): string {
  ensureDir(cfg.agent.sessionsDir);
  return cfg.agent.threadMapFile;
}

function readThreadMap(): ThreadMap {
  const path = threadMapPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeThreadMap(map: ThreadMap) {
  writeFileSync(threadMapPath(), JSON.stringify(map, null, 2));
}

function sessionFilePath(filename: string): string {
  ensureDir(cfg.agent.sessionsDir);
  return join(cfg.agent.sessionsDir, filename);
}

function readSessionMessages(filename: string): StoredMessage[] {
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

export async function handleMessage(
  threadKey: string,
  text: string,
  messageTs: string,
  _userId: string,
): Promise<string> {
  const map = readThreadMap();
  let entry = map[threadKey];
  if (!entry) {
    entry = {
      sessionFilename: `${randomUUID()}.jsonl`,
      lastProcessedMessageTs: messageTs,
    };
    map[threadKey] = entry;
    appendSessionMessage(entry.sessionFilename, {
      role: "system",
      content: systemPrompt(),
      ts: new Date().toISOString(),
    });
  }

  entry.lastProcessedMessageTs = messageTs;
  writeThreadMap(map);

  appendSessionMessage(entry.sessionFilename, {
    role: "user",
    content: text,
    ts: new Date().toISOString(),
  });

  const history = readSessionMessages(entry.sessionFilename);
  const messages: LlmMessage[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const reply = await chat(messages);

  appendSessionMessage(entry.sessionFilename, {
    role: "assistant",
    content: reply,
    ts: new Date().toISOString(),
  });

  return reply;
}
