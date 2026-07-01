import type { ToolCall, ToolResult } from "./types.js";

const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;

export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  text.replace(TOOL_CALL_RE, (_match, json: string) => {
    try {
      const parsed = JSON.parse(json.trim()) as unknown;
      if (isToolCallShape(parsed)) {
        calls.push({ tool: parsed.tool, params: parsed.params ?? {} });
      }
    } catch {
      // ignore malformed tool calls
    }
    return "";
  });
  return calls;
}

function isToolCallShape(value: unknown): value is { tool: string; params?: Record<string, unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "tool" in value &&
    typeof (value as Record<string, unknown>).tool === "string"
  );
}

export function hasToolCalls(text: string): boolean {
  return parseToolCalls(text).length > 0;
}

export function formatToolResult(result: ToolResult): string {
  const prefix = result.error ? "[tool error]" : "[tool result]";
  return `${prefix} ${result.tool}\n${result.result}`;
}

export function formatToolCallsForAssistant(calls: ToolCall[]): string {
  return calls
    .map((c) => `<tool_call>\n${JSON.stringify(c, null, 2)}\n</tool_call>`)
    .join("\n");
}

export function formatToolInstructions(tools: { name: string; description: string }[]): string {
  const blocks = tools.map(
    (t) => `- ${t.name}: ${t.description}`,
  );
  return (
    "\n\n## Tools\n\n" +
    "When you need to act, output one or more tool calls in this exact format:\n" +
    "<tool_call>\n{\"tool\": \"<tool_name>\", \"params\": {<args>}}\n</tool_call>\n\n" +
    "Available tools:\n" +
    blocks.join("\n") +
    "\n\nAfter receiving tool results, reply with a final answer. Do not call the same tool again with unchanged arguments."
  );
}
