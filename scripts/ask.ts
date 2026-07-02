import "dotenv/config";
import { randomUUID } from "node:crypto";
import { handleMessage } from "../src/agent.js";
import { initializeTools, shutdownTools } from "../src/tools/registry.js";
import { runWithToolContext } from "../src/context.js";

export interface AskOptions {
  /** Unique thread key used for session continuity. */
  threadKey?: string;
  /** Synthetic Slack user ID. */
  userId?: string;
  /** Optional email used for tier/GitHub handle resolution. */
  userEmail?: string;
  /** Synthetic Slack message timestamp used for duplicate suppression. */
  messageTs?: string;
}

export async function ask(query: string, options: AskOptions = {}): Promise<string> {
  const threadKey = options.threadKey ?? `cli-${process.pid}`;
  const userId = options.userId ?? "UCLI00000000";
  const messageTs = options.messageTs ?? `${Date.now()}.000000`;

  await initializeTools();
  try {
    const result = await runWithToolContext(
      {
        threadKey,
        userId,
        userEmail: options.userEmail,
        channelId: "DCLI",
      },
      () => handleMessage(threadKey, query, messageTs, userId, options.userEmail),
    );
    return result.text;
  } finally {
    await shutdownTools();
  }
}

function showUsage(): void {
  console.error("Usage:");
  console.error("  npm run ask -- <query>");
  console.error("  echo 'query' | npm run ask");
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let query: string | undefined;
  if (args.length > 0) {
    query = args.join(" ").trim();
  } else if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    query = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!query) {
    showUsage();
  }

  const threadKey = process.env.ASK_THREAD_KEY || `cli-${randomUUID()}`;
  const userId = process.env.ASK_USER_ID || "UCLI00000000";
  const userEmail = process.env.ASK_USER_EMAIL;

  const response = await ask(query, { threadKey, userId, userEmail });
  console.log(response);

  if (process.env.ASK_PRINT_THREAD_KEY) {
    console.error(`\n(thread key: ${threadKey})`);
  }
}

import { pathToFileURL } from "node:url";

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
