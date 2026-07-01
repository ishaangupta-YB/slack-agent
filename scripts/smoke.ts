import assert from "node:assert";
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseToolCalls, formatToolResult } from "../src/tools/parser.js";
import { appendMemory, getMemoryRecent, searchMemory } from "../src/tools/memory.js";
import { initializeTools, listTools, runToolCall, shutdownTools } from "../src/tools/registry.js";
import { uploadArtifacts } from "../src/artifacts.js";
import { cfg } from "../src/config.js";
import { startScheduler, stopScheduler } from "../src/scheduler.js";

function clean() {
  if (existsSync(process.env.MEMORY_FILE!)) rmSync(process.env.MEMORY_FILE!);
  if (existsSync(process.env.BUCKET_DIR!)) rmSync(process.env.BUCKET_DIR!, { recursive: true, force: true });
  if (existsSync(process.env.SESSIONS_DIR!)) rmSync(process.env.SESSIONS_DIR!, { recursive: true, force: true });
}

async function main() {
  clean();

  // Configure and initialize a mock MCP stdio server for this test run.
  cfg.mcp.serversRaw = JSON.stringify({
    mock: {
      command: "node",
      args: ["--import=tsx", "scripts/mock-mcp-server.ts"],
    },
  });
  await initializeTools();

  // Parser
  const text =
    'Some reasoning<tool_call>\n{"tool": "read_file", "params": {"path": "package.json"}}\n</tool_call>';
  const calls = parseToolCalls(text);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].tool, "read_file");
  assert.strictEqual((calls[0].params as { path: string }).path, "package.json");

  // Memory
  appendMemory({
    id: "1",
    timestamp: new Date().toISOString(),
    threadKey: "test",
    userId: "U1",
    prompt: "hello",
    outcome: "hi",
  });
  assert.strictEqual(getMemoryRecent(10).length, 1);
  assert.strictEqual(searchMemory("hello").length, 1);

  // MCP tools are dynamically discovered and registered.
  const toolNames = listTools().map((t) => t.name);
  assert(toolNames.includes("mcp_mock_echo"), `Expected mcp_mock_echo in tools: ${toolNames.join(", ")}`);
  const echoResult = await runToolCall({
    tool: "mcp_mock_echo",
    params: { message: "hello from MCP" },
  });
  assert.strictEqual(echoResult.error, undefined);
  assert(echoResult.result.includes("hello from MCP"));

  // Real tool execution
  const result = await runToolCall({ tool: "read_file", params: { path: "package.json" } });
  assert.strictEqual(result.error, undefined);
  assert(result.result.includes('"name":'));

  const formatted = formatToolResult(result);
  assert(formatted.startsWith("[tool result] read_file"));

  // Bash disabled by default
  const bashResult = await runToolCall({ tool: "bash", params: { command: "echo hi" } });
  assert(bashResult.result.includes("disabled"));

  // GitHub tools are gated when GITHUB_TOKEN is missing
  const originalGhToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const prResult = await runToolCall({
    tool: "open_pr",
    params: {
      title: "Test PR",
      body: "Test body",
      repo: "owner/repo",
      branch: "test-branch",
    },
  });
  assert(prResult.result.includes("GITHUB_TOKEN is not configured"));
  const issueResult = await runToolCall({
    tool: "create_issue",
    params: { repo: "owner/repo", title: "Test issue", body: "Test body" },
  });
  assert(issueResult.result.includes("GITHUB_TOKEN is not configured"));
  if (originalGhToken !== undefined) process.env.GITHUB_TOKEN = originalGhToken;

  // Artifact upload
  const sessionsDir = process.env.SESSIONS_DIR || "./sessions";
  const sessionFilename = "test-session.jsonl";
  const sessionPathOriginal = join(sessionsDir, sessionFilename);
  mkdirSync(dirname(sessionPathOriginal), { recursive: true });
  writeFileSync(sessionPathOriginal, '{"role":"user","content":"hello"}\n', "utf-8");

  const urls = await uploadArtifacts(
    "C1:1776379256.075999",
    sessionFilename,
    "Hello from smoke test",
  );
  assert(urls.responseUrl.includes("responses/"));
  assert(urls.sessionUrl.includes("sessions/test-session.jsonl"));
  assert(existsSync(urls.responseUrl));
  assert(existsSync(urls.sessionUrl));
  const responseContent = readFileSync(urls.responseUrl, "utf-8");
  assert(responseContent.includes("Hello from smoke test"));

  // Scheduler
  const postedMessages: Array<Record<string, unknown>> = [];
  const deployHandlers: Array<(...args: unknown[]) => unknown> = [];
  const mockApp = {
    client: {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          postedMessages.push(args);
          return {};
        },
      },
    },
    message: (handler: (...args: unknown[]) => Promise<void>) => {
      deployHandlers.push(handler as (...args: unknown[]) => unknown);
    },
  } as unknown as Parameters<typeof startScheduler>[0];

  const scheduler = startScheduler(mockApp);
  assert.strictEqual(scheduler.cronTasks.length, 1, "Weekly report cron should be scheduled");
  assert.strictEqual(deployHandlers.length, 1, "Deploy monitor handler should be registered");

  // Simulate a deploy message in the monitored channel.
  await deployHandlers[0]({
    message: {
      channel: cfg.scheduler.deployChannel,
      text: "Deploying moon-bot v1.2.3 to prod",
      ts: "1776379256.075999",
      user: "U1",
    },
    client: mockApp.client,
    say: async () => {},
  });
  assert.strictEqual(scheduler.deployTimeouts.length, 1, "Deploy follow-up should be scheduled");

  stopScheduler();

  console.log("smoke tests passed");
  clean();
  await shutdownTools();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
