import { execFile } from "node:child_process";
import { z } from "zod";
import { cfg } from "../config.js";
import { truncateOutput } from "./types.js";
import type { Tool } from "./types.js";

const sizzleQueryParams = z.object({
  query: z.string().describe("DuckDB SQL query to execute."),
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
      { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
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

/**
 * Renders a DuckDB SELECT as a markdown table by wrapping it in a row-limit CTE.
 * When files are provided, they are registered in DuckDB using the `read_parquet`
 * or `read_csv_auto` table functions depending on extension.
 */
function buildSql(input: z.infer<typeof sizzleQueryParams>): string {
  const query = input.query.trim();
  const sources = input.files ?? [];

  if (sources.length === 0) {
    return `WITH _query AS (${query}) SELECT * FROM _query LIMIT ${input.max_rows}`;
  }

  const sourceCtes = sources
    .map((source, idx) => {
      const path = source.replace(/'/g, "''");
      const name = `__source_${idx}`;
      if (/\.csv$/i.test(source)) {
        return `${name} AS (SELECT * FROM read_csv_auto('${path}'))`;
      }
      return `${name} AS (SELECT * FROM read_parquet('${path}'))`;
    })
    .join(", ");

  return `WITH ${sourceCtes}, _query AS (${query}) SELECT * FROM _query LIMIT ${input.max_rows}`;
}

function buildArgs(input: z.infer<typeof sizzleQueryParams>): string[] {
  const args = ["-c", buildSql(input)];
  if (input.format === "csv") {
    args.unshift("-csv");
  }
  return args;
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
    const args = buildArgs(input);
    const result = await execDuckDb(args);

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
    "Run a DuckDB SQL query against Xet storage statistics hosted in DuckLake (Parquet/CSV files). Useful for storage capacity, deduplication ratio, shard counts, and bandwidth metrics. Set SIZZLE_DATA_DIR to enable.",
  params: sizzleQueryParams,
  run: sizzleQuery,
};
