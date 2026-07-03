import { execFile } from "node:child_process";
import { normalize, resolve, sep } from "node:path";
import { z } from "zod";
import { cfg } from "../config.js";
import { truncateOutput } from "./types.js";
import type { Tool } from "./types.js";

const sizzleQueryParams = z.object({
  query: z.string().describe("DuckDB SQL query to execute. Only SELECT/WITH statements are allowed."),
  files: z
    .array(z.string())
    .optional()
    .describe(
      "Optional file paths or globs (relative to SIZZLE_DATA_DIR) to include as sources. Examples: ['2026/07/*.parquet', 'storage_stats.csv'].",
    ),
  format: z
    .enum(["markdown", "csv"])
    .default("markdown")
    .describe("Output format. 'markdown' returns a Slack-friendly table; 'csv' returns raw CSV."),
  max_rows: z.number().int().min(1).max(1000).default(50).describe("Max result rows to return."),
});

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type SizzleExecutor = (command: string, args: string[]) => Promise<ExecResult>;

let executorOverride: SizzleExecutor | undefined;

export function setSizzleExecutor(fn?: SizzleExecutor): void {
  executorOverride = fn;
}

export function clearSizzleExecutor(): void {
  executorOverride = undefined;
}

function defaultExecutor(command: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf-8",
        maxBuffer: 8 * 1024 * 1024,
        cwd: getDataDir() ?? process.cwd(),
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
        });
      },
    );
  });
}

function execDuckDb(args: string[]): Promise<ExecResult> {
  return (executorOverride ?? defaultExecutor)("duckdb", args);
}

function isSizzleConfigured(): boolean {
  return Boolean(cfg.integrations.sizzleDataDir);
}

function getDataDir(): string | undefined {
  return cfg.integrations.sizzleDataDir ? resolve(cfg.integrations.sizzleDataDir) : undefined;
}

function safeDataPath(inputPath: string): string | undefined {
  const dataDir = getDataDir();
  if (!dataDir) return undefined;
  const resolved = normalize(resolve(dataDir, inputPath));
  const rootWithSep = dataDir.endsWith(sep) ? dataDir : dataDir + sep;
  if (resolved === dataDir) return dataDir;
  if (resolved.startsWith(rootWithSep)) return resolved;
  return undefined;
}

function validateQuery(query: string): string | undefined {
  const q = query.trim();
  if (!/^[\s(]*(SELECT|WITH)\b/i.test(q)) {
    return "Error: only SELECT or WITH queries are allowed.";
  }
  if (/;/u.test(q)) {
    return "Error: semicolons are not allowed in Sizzle queries.";
  }
  if (/\b(ATTACH|COPY|EXPORT|IMPORT|PRAGMA|CALL|LOAD|INSTALL|CREATE|DROP|INSERT|UPDATE|DELETE|ALTER|BEGIN|COMMIT|ROLLBACK|CHECKPOINT|VACUUM)\b/giu.test(q)) {
    return "Error: disallowed SQL keyword detected.";
  }
  // Block any file-reading or file-scanning table functions inside the
  // user-supplied query. File access is only allowed through the `files`
  // parameter, which the wrapper resolves under SIZZLE_DATA_DIR and injects
  // as CTEs. This prevents sandbox escapes via DuckDB functions such as
  // read_text, read_json, parquet_scan, csv_scan, glob, etc.
  if (/\b(read_[a-z0-9_]+|parquet_scan|parquet_metadata|csv_scan|json_scan|glob|sniff_csv)\s*\(/giu.test(q)) {
    return "Error: file sources must be provided via the files parameter.";
  }
  if (/'[^']*[\\/][^']*'/u.test(q)) {
    return "Error: path-like string literals are not allowed in queries.";
  }
  if (/--|\/\*/u.test(q)) {
    return "Error: comments are not allowed in Sizzle queries.";
  }
  return undefined;
}

/**
 * Renders a DuckDB SELECT as a markdown table by wrapping it in a row-limit CTE.
 * When files are provided, they are resolved under SIZZLE_DATA_DIR and registered
 * using the `read_parquet` or `read_csv_auto` table functions depending on extension.
 */
function buildSql(input: z.infer<typeof sizzleQueryParams>, resolvedSources: string[]): string {
  const query = input.query.trim();

  if (resolvedSources.length === 0) {
    return `WITH _query AS (${query}) SELECT * FROM _query LIMIT ${input.max_rows}`;
  }

  const sourceCtes = resolvedSources
    .map((sourcePath, idx) => {
      const escaped = sourcePath.replace(/'/g, "''");
      const name = `__source_${idx}`;
      if (/\.csv$/i.test(sourcePath)) {
        return `${name} AS (SELECT * FROM read_csv_auto('${escaped}'))`;
      }
      return `${name} AS (SELECT * FROM read_parquet('${escaped}'))`;
    })
    .join(", ");

  return `WITH ${sourceCtes}, _query AS (${query}) SELECT * FROM _query LIMIT ${input.max_rows}`;
}

function buildArgs(input: z.infer<typeof sizzleQueryParams>): string | string[] {
  const queryError = validateQuery(input.query);
  if (queryError) return queryError;

  const resolvedSources: string[] = [];
  for (const source of input.files ?? []) {
    const safe = safeDataPath(source);
    if (!safe) {
      return `Error: file path is outside SIZZLE_DATA_DIR: ${source}`;
    }
    resolvedSources.push(safe);
  }

  return ["-c", buildSql(input, resolvedSources)];
}

function csvToMarkdown(stdout: string): string {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    return "Query completed but returned no rows.";
  }

  const rows = lines.map((line) => {
    // Very simple CSV split; DuckDB CSV output does not quote simple values.
    return line.split(",").map((cell) => cell.trim());
  });

  const headers = rows[0];
  if (rows.length === 1) {
    return `Query returned headers only: ${headers.join(", ")}`;
  }

  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const headerRow = `| ${headers.join(" | ")} |`;
  const body = rows.slice(1).map((cells) => `| ${headers.map((_, idx) => cells[idx] ?? "").join(" | ")} |`);

  return `${headerRow}\n${separator}\n${body.join("\n")}`;
}

function formatOutput(input: z.infer<typeof sizzleQueryParams>, stdout: string): string {
  if (input.format === "csv") {
    return stdout.trim();
  }
  return csvToMarkdown(stdout);
}

async function sizzleQuery(input: z.infer<typeof sizzleQueryParams>): Promise<string> {
  if (!isSizzleConfigured()) {
    return "Sizzle/DuckDB is not configured. Set SIZZLE_DATA_DIR to the directory containing DuckLake/Parquet/CSV files to enable Xet storage analytics.";
  }

  try {
    const argsOrError = buildArgs(input);
    if (typeof argsOrError === "string") {
      return argsOrError;
    }

    const result = await execDuckDb(argsOrError);

    if (result.exitCode !== 0) {
      const detail = result.stderr || result.stdout;
      return `DuckDB query failed: ${detail}`;
    }

    const output = formatOutput(input, result.stdout);
    return truncateOutput(output, 8_000);
  } catch (err) {
    return `Sizzle query error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const sizzleQueryTool: Tool = {
  name: "sizzle_query",
  description:
    "Run a SELECT/WITH DuckDB SQL query against Xet storage statistics hosted in DuckLake (Parquet/CSV files). Files are resolved under SIZZLE_DATA_DIR; only the provided sources may be queried, and file paths cannot escape the data directory. Useful for storage capacity, deduplication ratio, shard counts, and bandwidth metrics. (elastic tier)",
  params: sizzleQueryParams,
  tier: "elastic",
  run: sizzleQuery,
};
