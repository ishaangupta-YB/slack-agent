import { execFile } from "node:child_process";
import { z } from "zod";
import { cfg } from "../config.js";
import { truncateOutput } from "./types.js";
import type { Tool } from "./types.js";

const athenaQueryParams = z.object({
  query: z.string().describe("Athena SQL query to execute."),
  database: z.string().describe("Athena database name (e.g. default)."),
  output_location: z
    .string()
    .describe("S3 location for query results, e.g. s3://my-bucket/athena-output/"),
  catalog: z.string().default("AwsDataCatalog").describe("Glue data catalog name."),
  workgroup: z.string().optional().describe("Athena workgroup (optional)."),
  max_results: z.number().int().min(1).max(1000).default(50).describe("Max result rows to return."),
  wait_timeout: z
    .number()
    .int()
    .min(5)
    .max(300)
    .default(60)
    .describe("Maximum seconds to wait for the query to complete."),
});

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface AthenaRow {
  Data?: Array<{ VarCharValue?: string }>;
}

interface AthenaColumnInfo {
  Name: string;
  Type: string;
}

export type AthenaExecutor = (command: string, args: string[]) => Promise<ExecResult>;

let executorOverride: AthenaExecutor | undefined;

export function setAthenaExecutor(fn?: AthenaExecutor): void {
  executorOverride = fn;
}

export function clearAthenaExecutor(): void {
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

function execAws(args: string[]): Promise<ExecResult> {
  return (executorOverride ?? defaultExecutor)("aws", args);
}

function isAwsConfigured(): boolean {
  return Boolean(
    cfg.integrations.awsAccessKeyId && cfg.integrations.awsSecretAccessKey,
  );
}

interface StartQueryOutput {
  QueryExecutionId?: string;
}

interface QueryExecutionOutput {
  QueryExecution?: {
    Status?: {
      State?: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
      StateChangeReason?: string;
    };
    Statistics?: {
      DataScannedInBytes?: number;
      EngineExecutionTimeInMillis?: number;
    };
  };
}

interface QueryResultsOutput {
  ResultSet?: {
    Rows?: AthenaRow[];
    ColumnInfo?: AthenaColumnInfo[];
  };
}

async function startQueryExecution(input: z.infer<typeof athenaQueryParams>): Promise<string> {
  const args = [
    "athena",
    "start-query-execution",
    "--query-string",
    input.query,
    "--query-execution-context",
    `Database=${input.database},Catalog=${input.catalog}`,
    "--result-configuration",
    `OutputLocation=${input.output_location}`,
    "--output",
    "json",
  ];
  if (input.workgroup) {
    args.push("--work-group", input.workgroup);
  }

  const result = await execAws(args);
  if (result.exitCode !== 0) {
    throw new Error(`start-query-execution failed: ${result.stderr || result.stdout}`);
  }

  const parsed = JSON.parse(result.stdout) as StartQueryOutput;
  if (!parsed.QueryExecutionId) {
    throw new Error("Athena did not return a QueryExecutionId.");
  }
  return parsed.QueryExecutionId;
}

async function waitForQuery(
  queryExecutionId: string,
  maxWaitSeconds: number,
  pollIntervalMs = 2000,
): Promise<QueryExecutionOutput["QueryExecution"]> {
  const deadline = Date.now() + maxWaitSeconds * 1000;

  while (Date.now() < deadline) {
    const result = await execAws([
      "athena",
      "get-query-execution",
      "--query-execution-id",
      queryExecutionId,
      "--output",
      "json",
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`get-query-execution failed: ${result.stderr || result.stdout}`);
    }

    const parsed = JSON.parse(result.stdout) as QueryExecutionOutput;
    const execution = parsed.QueryExecution;
    const state = execution?.Status?.State;

    if (state === "SUCCEEDED") {
      return execution;
    }
    if (state === "FAILED" || state === "CANCELLED") {
      throw new Error(
        `Athena query ${state.toLowerCase()}: ${execution?.Status?.StateChangeReason ?? "unknown reason"}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("Timed out waiting for Athena query to complete.");
}

async function fetchResults(
  queryExecutionId: string,
  maxResults: number,
): Promise<QueryResultsOutput["ResultSet"]> {
  const result = await execAws([
    "athena",
    "get-query-results",
    "--query-execution-id",
    queryExecutionId,
    "--max-results",
    String(maxResults),
    "--output",
    "json",
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`get-query-results failed: ${result.stderr || result.stdout}`);
  }

  const parsed = JSON.parse(result.stdout) as QueryResultsOutput;
  return parsed.ResultSet ?? {};
}

function cellValue(cell?: { VarCharValue?: string }): string {
  return cell?.VarCharValue ?? "";
}

function formatAthenaResult(resultSet: QueryResultsOutput["ResultSet"], queryExecutionId: string): string {
  const rows = resultSet?.Rows ?? [];
  const columns = resultSet?.ColumnInfo ?? [];
  const columnNames = columns.map((c) => c.Name);

  if (rows.length === 0) {
    return `Query completed (${queryExecutionId}) but returned no rows.`;
  }

  const rowsToUse = rows;
  const first = rowsToUse[0]?.Data?.map(cellValue) ?? [];
  const hasHeaderRow = first.length > 0 && first.every((value, idx) => value === columnNames[idx]);
  const dataRows = hasHeaderRow ? rowsToUse.slice(1) : rowsToUse;

  const headers = columnNames.length > 0 ? columnNames : first;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const headerRow = `| ${headers.join(" | ")} |`;

  const body = dataRows.map((row) => {
    const values = row.Data?.map(cellValue) ?? [];
    const padded = headers.map((_, idx) => values[idx] ?? "");
    return `| ${padded.join(" | ")} |`;
  });

  return (
    `Query completed (${queryExecutionId}). Found ${dataRows.length} row(s).\n\n` +
    `${headerRow}\n${separator}${body.length ? "\n" + body.join("\n") : ""}`
  );
}

async function athenaQuery(input: z.infer<typeof athenaQueryParams>): Promise<string> {
  if (!isAwsConfigured()) {
    return "AWS is not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to enable Athena queries.";
  }

  try {
    const queryExecutionId = await startQueryExecution(input);
    const execution = await waitForQuery(queryExecutionId, input.wait_timeout);
    const resultSet = await fetchResults(queryExecutionId, input.max_results);
    const output = formatAthenaResult(resultSet, queryExecutionId);

    const stats = execution?.Statistics;
    let statsLine = "";
    if (stats) {
      const bytes = stats.DataScannedInBytes;
      const ms = stats.EngineExecutionTimeInMillis;
      const bytesText = bytes !== undefined ? `, scanned ${(bytes / 1024 / 1024).toFixed(2)} MB` : "";
      const timeText = ms !== undefined ? `, engine time ${ms} ms` : "";
      statsLine = `${bytesText}${timeText}`;
    }

    return truncateOutput(output + statsLine, 8_000);
  } catch (err) {
    return `Athena query failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const athenaQueryTool: Tool = {
  name: "athena_query",
  description:
    "Run a SQL query against AWS Athena (ALB/WAF/CloudFront logs, etc.). Requires AWS credentials and an S3 output_location. Returns a markdown table of results.",
  params: athenaQueryParams,
  run: athenaQuery,
};
