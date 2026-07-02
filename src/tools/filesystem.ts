import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, normalize, resolve, sep } from "node:path";
import { z } from "zod";
import type { Tool } from "./types.js";

const WORKSPACE_ROOT = resolve(process.cwd());

function safePath(inputPath: string): string | undefined {
  const resolved = normalize(resolve(WORKSPACE_ROOT, inputPath));
  const rootWithSep = WORKSPACE_ROOT.endsWith(sep) ? WORKSPACE_ROOT : WORKSPACE_ROOT + sep;
  // Allow paths inside the workspace root. The workspace root itself is not writable,
  // but resolving the empty/relative path should return the root, which we reject for writes.
  if (resolved === WORKSPACE_ROOT) return WORKSPACE_ROOT;
  if (resolved.startsWith(rootWithSep)) return resolved;
  return undefined;
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
  tier: "basic",
  githubBot: true,
  run(input) {
    const path = safePath(input.path);
    if (!path) return "Error: path is outside the workspace";
    if (!existsSync(path)) return `Error: file not found: ${input.path}`;
    const content = readFileSync(path, "utf-8");
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
    "Create or overwrite a file relative to the project root. Use with caution. (privileged)",
  params: writeParams,
  tier: "privileged",
  githubBot: true,
  run(input) {
    const path = safePath(input.path);
    if (!path) return "Error: path is outside the workspace";
    const dir = dirname(path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, input.content, "utf-8");
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
    "Replace an exact string inside a file relative to the project root. (privileged)",
  params: editParams,
  tier: "privileged",
  githubBot: true,
  run(input) {
    const path = safePath(input.path);
    if (!path) return "Error: path is outside the workspace";
    if (!existsSync(path)) return `Error: file not found: ${input.path}`;
    const content = readFileSync(path, "utf-8");
    const occurrences = content.split(input.oldString).length - 1;
    if (occurrences === 0) return "Error: oldString not found";
    if (occurrences > 1) return `Error: oldString found ${occurrences} times; provide more context.`;
    writeFileSync(path, content.replace(input.oldString, input.newString), "utf-8");
    return `Edited ${input.path}`;
  },
};
