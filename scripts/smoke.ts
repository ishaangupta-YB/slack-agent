import assert from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { parseToolCalls, formatToolResult } from "../src/tools/parser.js";
import { appendMemory, getMemoryRecent, searchMemory } from "../src/tools/memory.js";
import { runToolCall } from "../src/tools/registry.js";

function clean() {
  if (existsSync(process.env.MEMORY_FILE!)) rmSync(process.env.MEMORY_FILE!);
}

async function main() {
  clean();

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

  // Real tool execution
  const result = await runToolCall({ tool: "read_file", params: { path: "package.json" } });
  assert.strictEqual(result.error, undefined);
  assert(result.result.includes('"name":'));

  const formatted = formatToolResult(result);
  assert(formatted.startsWith("[tool result] read_file"));

  // Bash disabled by default
  const bashResult = await runToolCall({ tool: "bash", params: { command: "echo hi" } });
  assert(bashResult.result.includes("disabled"));

  console.log("smoke tests passed");
  clean();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
