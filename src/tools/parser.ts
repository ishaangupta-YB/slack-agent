import type { ToolCall, ToolResult } from "./types.js";

const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;
const UNCLOSED_TAG_RE = /<tool_call>(?!.*<\/tool_call>)/s;

export interface ParsedToolCalls {
  calls: ToolCall[];
  errors: string[];
}

export function parseToolCalls(text: string): ToolCall[] {
  return parseToolCallsWithErrors(text).calls;
}

export function parseToolCallsWithErrors(text: string): ParsedToolCalls {
  const calls: ToolCall[] = [];
  const errors: string[] = [];

  text.replace(TOOL_CALL_RE, (_match, json: string) => {
    const result = parseCallJson(json);
    if (result.success) {
      calls.push({ tool: result.call.tool, params: result.call.params ?? {} });
    } else {
      errors.push(result.error);
    }
    return "";
  });

  if (calls.length === 0 && errors.length === 0 && UNCLOSED_TAG_RE.test(text)) {
    errors.push("Unclosed <tool_call> tag detected. Make sure to close each tool call with </tool_call>.");
  }

  return { calls, errors };
}

interface ParseSuccess {
  success: true;
  call: { tool: string; params?: Record<string, unknown> };
}

interface ParseFailure {
  success: false;
  error: string;
}

function parseCallJson(json: string): ParseSuccess | ParseFailure {
  const trimmed = json.trim();
  if (!trimmed) {
    return { success: false, error: "Empty <tool_call> block. Expected a JSON object with tool and params." };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isToolCallShape(parsed)) {
      return { success: false, error: `Invalid tool-call shape: ${JSON.stringify(parsed).slice(0, 200)}` };
    }
    return { success: true, call: parsed };
  } catch (err) {
    const snippet = trimmed.slice(0, 200).replace(/\s+/g, " ");
    const reason = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Malformed JSON in <tool_call>: ${reason}. Content: ${snippet}` };
  }
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
    "Example:\n" +
    '<tool_call>\n{"tool": "read_file", "params": {"path": "README.md"}}\n</tool_call>\n\n' +
    "Available tools:\n" +
    blocks.join("\n") +
    "\n\nAfter receiving tool results, reply with a final answer. Do not call the same tool again with unchanged arguments." +
    " If a tool call is malformed, you will receive a parse error and can try again with valid JSON."
  );
}

export function formatParseErrors(errors: string[]): string {
  return errors.map((e) => `[tool parse error] ${e}`).join("\n");
}
