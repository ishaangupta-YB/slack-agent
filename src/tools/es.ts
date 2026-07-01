import { z } from "zod";
import { cfg } from "../config.js";
import { truncateOutput } from "./types.js";
import type { Tool } from "./types.js";

const esQueryParams = z.object({
  index: z.string().describe("Elasticsearch index name or wildcard pattern, e.g. logs-*"),
  query: z
    .string()
    .default('{"query":{"match_all":{}}}')
    .describe("Query DSL as a JSON string. Must be a valid Elasticsearch _search request body."),
  size: z.number().int().min(1).max(1000).default(10).describe("Maximum hits to return."),
  source_includes: z
    .array(z.string())
    .default([])
    .describe("Optional list of fields to include in _source (e.g. [\"timestamp\", \"message\"])."),
});

interface EsHit {
  _id: string;
  _index: string;
  _score?: number;
  _source?: Record<string, unknown>;
}

interface EsSearchResponse {
  took?: number;
  hits?: {
    total?: number | { value: number; relation: string };
    hits?: EsHit[];
  };
  error?: { reason?: string; type?: string };
  status?: number;
}

function formatEsResult(data: EsSearchResponse, sourceIncludes: string[]): string {
  if (data.error) {
    return `Elasticsearch error: ${data.error.reason ?? data.error.type ?? JSON.stringify(data.error)}`;
  }

  const hits = data.hits?.hits ?? [];
  const totalRaw = data.hits?.total;
  const total =
    typeof totalRaw === "number"
      ? totalRaw
      : (totalRaw as { value?: number } | undefined)?.value ?? hits.length;

  if (hits.length === 0) {
    return `No hits found (total: ${total}, took: ${data.took ?? "?"}ms).`;
  }

  const keys =
    sourceIncludes.length > 0
      ? sourceIncludes
      : Array.from(new Set(hits.flatMap((h) => (h._source ? Object.keys(h._source) : []))));

  const rows = hits.map((hit) => {
    const cells = keys.map((k) => {
      const value = hit._source?.[k];
      if (value === undefined) return "";
      if (typeof value === "object" && value !== null) return JSON.stringify(value);
      return String(value);
    });
    return `| ${hit._id} | ${cells.join(" | ")} |`;
  });

  const header = `| _id | ${keys.join(" | ")} |`;
  const separator = `| --- | ${keys.map(() => "---").join(" | ")} |`;

  return (
    `Found ${total} hits (returned ${hits.length}, took: ${data.took ?? "?"}ms)\n\n` +
    `${header}\n${separator}\n${rows.join("\n")}`
  );
}

async function esQuery(input: z.infer<typeof esQueryParams>): Promise<string> {
  if (!cfg.integrations.esUrl) {
    return "Elasticsearch is not configured. Set ES_URL to enable queries.";
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(input.query) as Record<string, unknown>;
  } catch {
    return "Invalid Elasticsearch query: the query parameter must be valid JSON.";
  }

  body.size = input.size;
  if (input.source_includes.length > 0) {
    body._source = input.source_includes;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.integrations.esApiKey) {
    headers.Authorization = `ApiKey ${cfg.integrations.esApiKey}`;
  } else if (cfg.integrations.esUsername && cfg.integrations.esPassword) {
    const credentials = Buffer.from(`${cfg.integrations.esUsername}:${cfg.integrations.esPassword}`).toString("base64");
    headers.Authorization = `Basic ${credentials}`;
  }

  try {
    const url = `${cfg.integrations.esUrl.replace(/\/$/, "")}/${encodeURIComponent(input.index)}/_search`;
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const data = (await resp.json()) as EsSearchResponse;

    if (!resp.ok) {
      return `Elasticsearch request failed ${resp.status}: ${data.error?.reason ?? JSON.stringify(data)}`;
    }

    return truncateOutput(formatEsResult(data, input.source_includes), 8_000);
  } catch (err) {
    return `Elasticsearch request failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const esQueryTool: Tool = {
  name: "es_query",
  description:
    "Query an Elasticsearch cluster using the Query DSL. Requires ES_URL. Optional ES_API_KEY or ES_USERNAME + ES_PASSWORD. Returns a markdown table of hits.",
  params: esQueryParams,
  run: esQuery,
};
