import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, join, relative, sep } from "node:path";
import { z } from "zod";
import { cfg } from "../config.js";
import type { Tool } from "./types.js";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
]);

const searchCodeSchema = z.object({
  repo: z
    .string()
    .optional()
    .describe("Optional repository subdirectory under CODE_REPOS_DIR to search."),
  query: z.string().describe("Text to match against file paths or contents."),
  mode: z
    .enum(["files", "content", "both"])
    .default("files")
    .describe("files = match paths only; content = grep contents; both = either."),
  glob: z
    .string()
    .default("*")
    .describe("File glob filter, e.g. '*.ts' or '*.py'. * matches all files."),
  max_results: z
    .number()
    .int()
    .positive()
    .default(20)
    .describe("Maximum number of file results to return."),
  context_lines: z
    .number()
    .int()
    .nonnegative()
    .default(2)
    .describe("Lines of context around each content match."),
});

function safeResolve(base: string, target: string): string {
  const resolved = resolve(base, target);
  // Ensure the resolved path stays inside the base directory.
  const baseWithSep = base.endsWith(sep) ? base : base + sep;
  if (!resolved.startsWith(baseWithSep) && resolved !== base) {
    throw new Error(`Invalid path escapes base directory: ${target}`);
  }
  return resolved;
}

function matchesGlob(fileName: string, glob: string): boolean {
  if (glob === "*") return true;
  // Very small glob matcher: only supports literal prefixes or suffixes like *.ts.
  if (glob.startsWith("*") && glob.endsWith("*")) {
    return fileName.includes(glob.slice(1, -1));
  }
  if (glob.startsWith("*")) {
    return fileName.endsWith(glob.slice(1));
  }
  if (glob.endsWith("*")) {
    return fileName.startsWith(glob.slice(0, -1));
  }
  return fileName === glob;
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function matchesQuery(filePath: string, query: string): boolean {
  return filePath.toLowerCase().includes(query.toLowerCase());
}

function extractSnippets(
  content: string,
  query: string,
  contextLines: number,
): string[] {
  const lines = content.split("\n");
  const snippets: string[] = [];
  const lowerQuery = query.toLowerCase();
  const added = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(lowerQuery)) {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length, i + contextLines + 1);
      if (!added.has(start)) {
        added.add(start);
        const block = lines
          .slice(start, end)
          .map((line, idx) => `${start + idx + 1}: ${line}`)
          .join("\n");
        snippets.push(block);
      }
    }
  }
  return snippets;
}

async function searchCode(params: z.infer<typeof searchCodeSchema>): Promise<string> {
  const baseDir = resolve(cfg.code.reposDir);
  const searchRoot = params.repo ? safeResolve(baseDir, params.repo) : baseDir;

  try {
    const rootStat = await stat(searchRoot);
    if (!rootStat.isDirectory()) {
      return `Not a directory: ${searchRoot}`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Could not access code repository directory: ${message}. Configure CODE_REPOS_DIR and clone the repositories you want to search.`;
  }

  const allFiles = await walkFiles(searchRoot);
  const matched = allFiles
    .filter((file) => matchesGlob(file.split("/").pop() || "", params.glob))
    .map((file) => ({ absolute: file, relative: relative(searchRoot, file) }))
    .filter(
      (file) =>
        params.mode === "content" || matchesQuery(file.relative, params.query),
    )
    .slice(0, params.max_results);

  if (matched.length === 0) {
    return `No matching files found in ${searchRoot} for query "${params.query}".`;
  }

  // For content/both modes, enrich files with snippet matches.
  const enriched = await Promise.all(
    matched.map(async (file) => {
      let snippets: string[] = [];
      if (params.mode === "content" || params.mode === "both") {
        try {
          const content = await readFile(file.absolute, "utf-8");
          if (content.toLowerCase().includes(params.query.toLowerCase())) {
            snippets = extractSnippets(content, params.query, params.context_lines);
          }
        } catch {
          // Binary or unreadable file — ignore content.
        }
      }
      return { ...file, snippets };
    }),
  );

  // If content mode and no snippets, show path matches anyway to avoid empty results.
  const results = enriched.filter(
    (f) => params.mode !== "content" || f.snippets.length > 0 || matchesQuery(f.relative, params.query),
  );

  if (results.length === 0) {
    return `No files contained "${params.query}" in ${searchRoot}.`;
  }

  const lines: string[] = [
    `Found ${results.length} result(s) in ${params.repo || cfg.code.reposDir} (mode: ${params.mode}):`,
    "",
  ];
  for (const r of results) {
    lines.push(`- ${r.relative}`);
    for (const snippet of r.snippets.slice(0, 3)) {
      lines.push("```");
      lines.push(snippet);
      lines.push("```");
    }
  }

  return lines.join("\n").slice(0, 8_000);
}

export const searchCodeTool: Tool = {
  name: "search_code",
  description:
    "Search across local cloned code repositories by file path or content. Use this to find symbols, implementations, or examples in codebase(s).",
  params: searchCodeSchema,
  tier: "basic",
  githubBot: true,
  run: searchCode,
};
