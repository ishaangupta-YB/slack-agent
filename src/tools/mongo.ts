import { z } from "zod";
import { MongoClient, type Document } from "mongodb";
import { cfg } from "../config.js";
import { truncateOutput } from "./types.js";
import type { Tool } from "./types.js";

const mongoQueryParams = z.object({
  database: z
    .string()
    .optional()
    .describe("MongoDB database name. Falls back to MONGODB_DATABASE env variable."),
  collection: z.string().describe("Collection name to query."),
  filter: z
    .string()
    .default("{}")
    .describe("MongoDB find filter as a JSON string."),
  projection: z
    .array(z.string())
    .default([])
    .describe('Optional list of fields to include in each document (e.g. ["name", "email"]).'),
  sort: z
    .string()
    .default("{}")
    .describe("MongoDB sort as a JSON object string, e.g. {\"created_at\": -1}."),
  limit: z.number().int().min(1).max(1000).default(10).describe("Maximum documents to return."),
  skip: z.number().int().min(0).default(0).describe("Number of documents to skip."),
});

export type MongoExecutor = (opts: {
  uri: string;
  database: string;
  collection: string;
  filter: Document;
  projection?: Record<string, number>;
  sort?: Record<string, 1 | -1>;
  limit: number;
  skip: number;
}) => Promise<Document[]>;

let executorOverride: MongoExecutor | undefined;

export function setMongoExecutor(fn?: MongoExecutor): void {
  executorOverride = fn;
}

export function clearMongoExecutor(): void {
  executorOverride = undefined;
}

async function defaultExecutor(opts: Parameters<MongoExecutor>[0]): Promise<Document[]> {
  const client = new MongoClient(opts.uri);
  try {
    await client.connect();
    const coll = client.db(opts.database).collection(opts.collection);
    let cursor = coll.find(opts.filter);
    if (opts.projection) cursor = cursor.project(opts.projection);
    if (opts.sort) cursor = cursor.sort(opts.sort);
    cursor = cursor.skip(opts.skip).limit(opts.limit);
    return await cursor.toArray();
  } finally {
    await client.close();
  }
}

function parseJsonObject(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${field} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid ${field}: must be valid JSON`);
  }
}

function normalizeSort(sort: Record<string, unknown>): Record<string, 1 | -1> {
  const out: Record<string, 1 | -1> = {};
  for (const [key, value] of Object.entries(sort)) {
    if (value === 1 || value === -1 || value === "asc" || value === "desc") {
      out[key] = value === -1 || value === "desc" ? -1 : 1;
    } else {
      out[key] = Number(value) < 0 ? -1 : 1;
    }
  }
  return out;
}

function formatDocument(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatMongoResult(docs: Document[]): string {
  if (docs.length === 0) {
    return "No documents found.";
  }

  const keys = Array.from(new Set(docs.flatMap((d) => (d && typeof d === "object" ? Object.keys(d) : []))));
  const header = `| ${keys.join(" | ")} |`;
  const separator = `| ${keys.map(() => "---").join(" | ")} |`;
  const rows = docs.map((d) => `| ${keys.map((k) => formatDocument(d[k])).join(" | ")} |`);

  return `Found ${docs.length} document(s)\n\n${header}\n${separator}\n${rows.join("\n")}`;
}

async function mongoQuery(input: z.infer<typeof mongoQueryParams>): Promise<string> {
  const uri = cfg.integrations.mongoUri;
  const database = input.database || cfg.integrations.mongoDatabase;

  if (!uri) {
    return "MongoDB is not configured. Set MONGODB_URI to enable queries.";
  }
  if (!database) {
    return "MongoDB database is not configured. Set MONGODB_DATABASE or pass the database parameter.";
  }

  let filter: Document;
  let sort: Record<string, 1 | -1>;
  try {
    filter = parseJsonObject(input.filter, "filter");
    sort = normalizeSort(parseJsonObject(input.sort, "sort"));
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  const projection: Record<string, number> | undefined =
    input.projection.length > 0
      ? Object.fromEntries(input.projection.map((field) => [field, 1]))
      : undefined;

  try {
    const docs = await (executorOverride ?? defaultExecutor)({
      uri,
      database,
      collection: input.collection,
      filter,
      projection,
      sort,
      limit: input.limit,
      skip: input.skip,
    });

    return truncateOutput(formatMongoResult(docs), 8_000);
  } catch (err) {
    return `MongoDB query failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const mongoQueryTool: Tool = {
  name: "mongo_query",
  description:
    "Query a MongoDB collection using the find API. Requires MONGODB_URI and either MONGODB_DATABASE or a database parameter. Returns a markdown table of documents. (privileged tier)",
  params: mongoQueryParams,
  tier: "privileged",
  run: mongoQuery,
};
