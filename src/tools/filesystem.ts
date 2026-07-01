import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Tool } from "./types.js";

function isPathSafe(path: string): boolean {
  // Allow absolute and relative paths, but block traversal outside cwd.
  const resolved = new URL(path, "file://" + process.cwd() + "/").pathname;
  return !resolved.includes("..") && !resolved.includes("~");
}

const readParams = z.object({
  path: z.string(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(2000).default(200),
});

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a file relative to the project root. Optionally provide offset/limit for line ranges.",
  params: readParams,
  run(input) {
    if (!isPathSafe(input.path)) return "Error: unsafe path";
    if (!existsSync(input.path)) return `Error: file not found: ${input.path}`;
    const content = readFileSync(input.path, "utf-8");
    const lines = content.split("\n");
    const slice = lines.slice(input.offset, input.offset + input.limit).join("\n");
    return slice;
  },
};

const writeParams = z.object({
  path: z.string(),
  content: z.string(),
});

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Create or overwrite a file relative to the project root. Use with caution.",
  params: writeParams,
  run(input) {
    if (!isPathSafe(input.path)) return "Error: unsafe path";
    const dir = dirname(input.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(input.path, input.content, "utf-8");
    return `Wrote ${input.path}`;
  },
};

const editParams = z.object({
  path: z.string(),
  oldString: z.string(),
  newString: z.string(),
});

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace an exact string inside a file relative to the project root.",
  params: editParams,
  run(input) {
    if (!isPathSafe(input.path)) return "Error: unsafe path";
    if (!existsSync(input.path)) return `Error: file not found: ${input.path}`;
    const content = readFileSync(input.path, "utf-8");
    const occurrences = content.split(input.oldString).length - 1;
    if (occurrences === 0) return "Error: oldString not found";
    if (occurrences > 1) return `Error: oldString found ${occurrences} times; provide more context.`;
    writeFileSync(input.path, content.replace(input.oldString, input.newString), "utf-8");
    return `Edited ${input.path}`;
  },
};
