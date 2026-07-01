import { z, type ZodTypeAny } from "zod";
import type { AccessTier } from "../auth/tiers.js";

export interface Tool {
  name: string;
  description: string;
  params: ZodTypeAny;
  tier?: AccessTier;
  run: (params: z.infer<ZodTypeAny>) => Promise<string> | string;
}

export interface ToolCall {
  tool: string;
  params: Record<string, unknown>;
}

export interface ToolResult {
  tool: string;
  params: Record<string, unknown>;
  result: string;
  error?: boolean;
}

export interface ToolLoopOptions {
  maxIterations?: number;
  maxToolOutputChars?: number;
}

const MAX_CHARS_DEFAULT = 8_000;

export function truncateOutput(text: string, max = MAX_CHARS_DEFAULT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n... [truncated ${text.length - max} additional characters]`;
}
