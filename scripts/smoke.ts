import assert from "node:assert";
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseToolCalls, formatToolResult } from "../src/tools/parser.js";
import { appendMemory, getMemoryRecent, searchMemory } from "../src/tools/memory.js";
import { initializeTools, listTools, runToolCall, shutdownTools } from "../src/tools/registry.js";
import { uploadArtifacts } from "../src/artifacts.js";
import { cfg } from "../src/config.js";
import { startScheduler, stopScheduler } from "../src/scheduler.js";
import { app } from "../src/slack.js";
import { startBucketServer } from "../src/storage/server.js";
import { HuggingFaceBucket } from "../src/storage/bucket.js";
import { handleMessage } from "../src/agent.js";
import { clearChatOverride, setChatOverride } from "../src/llm/cloudflare.js";
import { clearMongoExecutor, setMongoExecutor } from "../src/tools/mongo.js";

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

  // Slack Real-Time Search API
  const originalFetch = globalThis.fetch;
  cfg.slack.userToken = "xoxp-test";
  let capturedSearchRequest: { url?: string; body?: Record<string, unknown> } | undefined;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    capturedSearchRequest = { url, body };
    return new Response(
      JSON.stringify({
        ok: true,
        results: {
          messages: [
            {
              content: "Project Gizmo ships next week",
              permalink: "https://example.slack.com/archives/C1/p123",
              channel_name: "proj-gizmo",
              author_name: "alice",
            },
          ],
          channels: [
            {
              name: "proj-gizmo",
              permalink: "https://example.slack.com/archives/C1",
            },
          ],
        },
        response_metadata: { next_cursor: "" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const slackSearchResult = await runToolCall({
    tool: "search_slack",
    params: { query: "project gizmo", limit: 3 },
  });
  assert.strictEqual(slackSearchResult.error, undefined);
  assert(slackSearchResult.result.includes("Project Gizmo ships next week"));
  assert(capturedSearchRequest?.url?.includes("assistant.search.context"));
  assert.strictEqual(capturedSearchRequest?.body?.query, "project gizmo");
  assert.strictEqual(capturedSearchRequest?.body?.limit, 3);

  (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;

  // Plausible analytics query
  const plausibleApiKey = cfg.integrations.plausibleApiKey;
  cfg.integrations.plausibleApiKey = "plausible-test-key";
  const originalFetch2 = globalThis.fetch;
  let capturedPlausibleRequest: { url?: string; body?: Record<string, unknown> } | undefined;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    capturedPlausibleRequest = { url, body };
    return new Response(
      JSON.stringify({
        results: [
          { "event:page": "/docs", visitors: 1234, pageviews: 5678 },
          { "event:page": "/blog", visitors: 900, pageviews: 3200 },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const plausibleResult = await runToolCall({
    tool: "plausible_query",
    params: {
      site_id: "huggingface.co",
      metrics: ["visitors", "pageviews"],
      dimensions: ["event:page"],
      date_range: "7d",
      limit: 10,
    },
  });
  assert.strictEqual(plausibleResult.error, undefined);
  assert(plausibleResult.result.includes("/docs"));
  assert(plausibleResult.result.includes("1234"));
  assert(capturedPlausibleRequest?.url?.includes("plausible.io/api/v2/query"));
  assert.strictEqual((capturedPlausibleRequest?.body as { site_id?: string })?.site_id, "huggingface.co");

  (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch2;
  cfg.integrations.plausibleApiKey = plausibleApiKey;

  // Elasticsearch query tool
  const originalEsUrl = cfg.integrations.esUrl;
  const originalEsApiKey = cfg.integrations.esApiKey;
  cfg.integrations.esUrl = "http://localhost:9200";
  cfg.integrations.esApiKey = "es-test-api-key";
  const originalFetch3 = globalThis.fetch;
  let capturedEsRequest: { url?: string; body?: Record<string, unknown>; headers?: Record<string, string> } | undefined;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    capturedEsRequest = { url, body, headers };
    return new Response(
      JSON.stringify({
        took: 12,
        hits: {
          total: { value: 2, relation: "eq" },
          hits: [
            {
              _id: "1",
              _index: "logs-2026.07.01",
              _source: { "@timestamp": "2026-07-01T10:00:00Z", status: 500, message: "timeout" },
            },
            {
              _id: "2",
              _index: "logs-2026.07.01",
              _source: { "@timestamp": "2026-07-01T10:01:00Z", status: 502, message: "gateway error" },
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const esResult = await runToolCall({
    tool: "es_query",
    params: {
      index: "logs-*",
      query: '{"query":{"match_all":{}}}',
      size: 5,
      source_includes: ["@timestamp", "status", "message"],
    },
  });
  assert.strictEqual(esResult.error, undefined);
  assert(esResult.result.includes("timeout"));
  assert(esResult.result.includes("500"));
  assert(capturedEsRequest?.url?.includes("_search"));
  assert(capturedEsRequest?.url?.includes("logs-"));
  assert.strictEqual(capturedEsRequest?.headers?.Authorization, "ApiKey es-test-api-key");
  assert.strictEqual((capturedEsRequest?.body as { size?: number })?.size, 5);
  assert.deepStrictEqual((capturedEsRequest?.body as { _source?: string[] })?._source, ["@timestamp", "status", "message"]);

  cfg.integrations.esUrl = undefined;
  cfg.integrations.esApiKey = undefined;
  const esUnconfigured = await runToolCall({
    tool: "es_query",
    params: { index: "logs-*", query: "{\"query\":{\"match_all\":{}}}", size: 1 },
  });
  assert(esUnconfigured.result.includes("ES_URL"));

  (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch3;
  cfg.integrations.esUrl = originalEsUrl;
  cfg.integrations.esApiKey = originalEsApiKey;

  // MongoDB query tool
  const originalMongoUri = cfg.integrations.mongoUri;
  const originalMongoDatabase = cfg.integrations.mongoDatabase;
  cfg.integrations.mongoUri = "mongodb://localhost:27017";
  cfg.integrations.mongoDatabase = "hub";
  setMongoExecutor(async () => [
    { _id: "abc", username: "alice", plan: "pro", createdAt: "2026-07-01T00:00:00Z" },
    { _id: "def", username: "bob", plan: "basic" },
  ]);

  const mongoResult = await runToolCall({
    tool: "mongo_query",
    params: {
      collection: "users",
      filter: '{"plan": "pro"}',
      projection: ["username", "plan"],
      limit: 5,
    },
  });
  assert.strictEqual(mongoResult.error, undefined);
  assert(mongoResult.result.includes("alice"));
  assert(mongoResult.result.includes("pro"));
  console.log("MongoDB query tool passed");

  clearMongoExecutor();
  cfg.integrations.mongoUri = undefined;
  cfg.integrations.mongoDatabase = undefined;
  const mongoUnconfigured = await runToolCall({
    tool: "mongo_query",
    params: { collection: "users", limit: 1 },
  });
  assert(mongoUnconfigured.result.includes("MONGODB_URI"));

  cfg.integrations.mongoUri = originalMongoUri;
  cfg.integrations.mongoDatabase = originalMongoDatabase;

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

  // End-to-end ReAct agent loop with a mocked LLM
  setChatOverride(async (messages) => {
    const lastMessage = messages[messages.length - 1];
    const isObservation =
      lastMessage?.role === "user" &&
      typeof lastMessage?.content === "string" &&
      lastMessage.content.includes("[tool result] read_file");
    if (isObservation) {
      return "The project name is moon-bot-slack-agent (from package.json).";
    }
    return '<tool_call>\n{"tool": "read_file", "params": {"path": "package.json"}}\n</tool_call>';
  });

  const e2eThreadKey = "C1:1776379256.075999";
  const e2eMessageTs = "1776379256.075999";
  const e2eUserId = "U1";
  const e2eResult = await handleMessage(
    e2eThreadKey,
    "What is the project name in package.json?",
    e2eMessageTs,
    e2eUserId,
  );
  assert(
    e2eResult.text.includes("moon-bot-slack-agent"),
    `Expected final answer to mention project name, got: ${e2eResult.text}`,
  );

  const e2eSessionPath = join(process.env.SESSIONS_DIR!, e2eResult.sessionFilename);
  assert(existsSync(e2eSessionPath), "Session file should be written");
  const e2eSessionLines = readFileSync(e2eSessionPath, "utf-8")
    .split("\n")
    .filter(Boolean);
  const e2eSession = e2eSessionLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert(e2eSession.some((m) => m.role === "system"), "Session should contain system prompt");
  assert(e2eSession.some((m) => m.role === "user" && String(m.content).includes("project name")), "Session should contain user message");
  assert(e2eSession.some((m) => m.role === "assistant" && String(m.content).includes("tool_call")), "Session should contain assistant tool call");
  assert(e2eSession.some((m) => m.role === "assistant" && String(m.content).includes("moon-bot-slack-agent")), "Session should contain final answer");

  const e2eMemory = searchMemory("project name");
  assert(e2eMemory.length >= 1, "Memory should record the end-to-end interaction");

  clearChatOverride();
  console.log("End-to-end ReAct agent loop passed");

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

  // HuggingFace Bucket integration
  const uploaded: Array<{
    repo: string;
    files: Array<{ path: string; content: Blob }>;
    accessToken?: string;
    commitTitle?: string;
    commitDescription?: string;
  }> = [];
  const hfBucket = new HuggingFaceBucket("huggingface/moon-bot-memory", "hf-test-token", async (params) => {
    const files = params.files.map((f) => ({
      path: "path" in f ? f.path : "",
      content: f instanceof Blob ? f : (f as { content: Blob }).content,
    }));
    uploaded.push({
      repo: params.repo as string,
      files,
      accessToken: (params as { accessToken?: string }).accessToken,
      commitTitle: (params as { commitTitle?: string }).commitTitle,
      commitDescription: (params as { commitDescription?: string }).commitDescription,
    });
    return { commit: { oid: "abc123", url: "https://huggingface.co/test-commit" }, hookOutput: "" } as never;
  });
  await hfBucket.write("responses/smoke.md", "HF bucket smoke test content");
  assert.strictEqual(uploaded.length, 1);
  assert.strictEqual(uploaded[0].repo, "buckets/huggingface/moon-bot-memory");
  assert.strictEqual(uploaded[0].files[0].path, "responses/smoke.md");
  assert.strictEqual(uploaded[0].commitTitle, "Moon Bot artifact upload");
  assert.strictEqual(uploaded[0].accessToken, "hf-test-token");
  const hfReadUrl = hfBucket.readUrl("responses/smoke.md");
  assert(hfReadUrl.includes("huggingface.co/buckets/huggingface/moon-bot-memory/resolve/main/responses/smoke.md"));
  console.log("HuggingFace Bucket integration passed");

  // Bucket server health endpoint
  const bucketServer = await startBucketServer();
  try {
    const healthUrl = `http://localhost:${cfg.storage.bucketHttpPort}/health`;
    const healthRes = await fetch(healthUrl);
    assert.strictEqual(healthRes.status, 200);
    const healthBody = (await healthRes.json()) as {
      status: string;
      bucketDir: string;
      bucketReady: boolean;
    };
    assert.strictEqual(healthBody.status, "ok");
    assert(healthBody.bucketReady);
  } finally {
    bucketServer.close();
  }

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

  // Slack AI Assistant integration
  // Importing src/slack.ts already validated Assistant registration. Process a mocked
  // assistant_thread_started event to confirm our handler runs and uses Slack AI methods.
  const assistantCalls: Array<{ method: string; args: unknown[] }> = [];
  app.client.auth.test = async () => ({ ok: true });
  app.client.assistant = {
    threads: {
      setStatus: async (...args: unknown[]) => {
        assistantCalls.push({ method: "setStatus", args });
        return { ok: true };
      },
      setSuggestedPrompts: async (...args: unknown[]) => {
        assistantCalls.push({ method: "setSuggestedPrompts", args });
        return { ok: true };
      },
    },
  } as never;
  app.client.chat = { postMessage: async () => ({ ok: true }) } as never;
  (app as unknown as { authorize: () => Promise<Record<string, string>> }).authorize = async () => ({
    botId: "B123",
    botUserId: "UBOT",
    userId: "UBOT",
    teamId: "T1",
  });

  await app.processEvent({
    body: {
      type: "event_callback",
      event: {
        type: "assistant_thread_started",
        assistant_thread: {
          user_id: "U1",
          context: { channel_id: "C1", team_id: "T1" },
          channel_id: "D1",
          thread_ts: "1776379256.075999",
        },
        event_ts: "1234567890.000000",
      },
    },
    ack: async () => {},
  });
  assert(assistantCalls.some((c) => c.method === "setStatus"));
  assert(assistantCalls.some((c) => c.method === "setSuggestedPrompts"));
  console.log("Assistant threadStarted handler invoked");

  // Slack app manifest validation
  const manifestRaw = readFileSync("manifest.json", "utf-8");
  const manifest = JSON.parse(manifestRaw) as {
    oauth_config?: { scopes?: { bot?: string[] } };
    settings?: { event_subscriptions?: { bot_events?: string[] }; socket_mode_enabled?: boolean };
    features?: { assistant_view?: { name?: string } };
  };
  const botScopes = manifest.oauth_config?.scopes?.bot ?? [];
  assert(botScopes.includes("assistant:write"), "manifest must include assistant:write scope");
  assert(botScopes.includes("search:read.public"), "manifest must include search:read.public scope");
  assert(botScopes.includes("app_mentions:read"), "manifest must include app_mentions:read scope");
  assert(botScopes.includes("chat:write"), "manifest must include chat:write scope");
  assert(botScopes.includes("im:history"), "manifest must include im:history scope");

  const botEvents = manifest.settings?.event_subscriptions?.bot_events ?? [];
  assert(botEvents.includes("app_mention"), "manifest must subscribe to app_mention events");
  assert(botEvents.includes("assistant_thread_started"), "manifest must subscribe to assistant_thread_started events");
  assert(manifest.settings?.socket_mode_enabled === true, "manifest must enable Socket Mode");
  assert(manifest.features?.assistant_view?.name === "Moon Bot", "manifest must define assistant_view name");
  console.log("Slack app manifest validated");

  console.log("smoke tests passed");
  clean();
  await shutdownTools();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
