import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
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

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const listParams = z.object({
  path: z.string().default("."),
  recursive: z.boolean().default(false),
  maxDepth: z.number().int().min(1).max(10).default(3),
  limit: z.number().int().min(1).max(1000).default(200),
});

export const listFilesTool: Tool = {
  name: "list_files",
  description:
    "List files and directories under a workspace-relative path. Useful for browsing a cloned repo before reading specific files.",
  params: listParams,
  tier: "basic",
  githubBot: true,
  run(input) {
    const base = safePath(input.path);
    if (!base) return "Error: path is outside the workspace";
    if (!existsSync(base)) return `Error: directory not found: ${input.path}`;
    const stat = statSync(base);
    if (!stat.isDirectory()) return `Error: ${input.path} is not a directory`;

    const lines: string[] = [`Listing ":${input.path || "."}"\n`];

    function addEntries(dir: string, rel: string, depth: number) {
      if (lines.length - 1 >= input.limit) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      // Directories first, then files.
      const dirs = entries.filter((e) => e.isDirectory());
      const files = entries.filter((e) => !e.isDirectory());
      for (const entry of [...dirs, ...files]) {
        if (lines.length - 1 >= input.limit) break;
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          lines.push(`- ${entryRel}/`);
          if (input.recursive && depth < input.maxDepth) {
            addEntries(join(dir, entry.name), entryRel, depth + 1);
          }
        } else {
          try {
            const size = humanSize(statSync(join(dir, entry.name)).size);
            lines.push(`- ${entryRel} (${size})`);
          } catch {
            lines.push(`- ${entryRel}`);
          }
        }
      }
    }

    addEntries(base, "", 1);
    const count = lines.length - 1;
    if (count === 0) return `Directory ":${input.path || "."}" is empty.`;
    if (lines.length - 1 >= input.limit) {
      lines.push(`\n... (listing truncated to ${input.limit} entries)`);
    }
    return lines.join("\n");
  },
};
