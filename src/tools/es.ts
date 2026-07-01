import { z } from "zod";
import { truncateOutput } from "./types.js";
import type { Tool } from "./types.js";
import { esSearch, type EsSearchResponse, totalHits } from "../integrations/es.js";

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

function formatEsResult(data: EsSearchResponse, sourceIncludes: string[]): string {
  if (data.error) {
    return `Elasticsearch error: ${data.error.reason ?? data.error.type ?? JSON.stringify(data.error)}`;
  }

  const hits = data.hits?.hits ?? [];
  const total = totalHits(data);

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
  let query: Record<string, unknown>;
  try {
    query = JSON.parse(input.query) as Record<string, unknown>;
  } catch {
    return "Invalid Elasticsearch query: the query parameter must be valid JSON.";
  }

  const result = await esSearch({
    index: input.index,
    query,
    size: input.size,
    _source: input.source_includes.length > 0 ? input.source_includes : undefined,
  });

  if (!result.ok) {
    return result.error ?? "Elasticsearch request failed.";
  }

  return truncateOutput(formatEsResult(result.data!, input.source_includes), 8_000);
}

export const esQueryTool: Tool = {
  name: "es_query",
  description:
    "Query an Elasticsearch cluster using the Query DSL. Requires ES_URL. When ES_PROXY_TOKEN and ES_PROXY_PORT are set, queries are routed through the local credential proxy so the upstream key never reaches tool execution. Optional direct auth: ES_API_KEY or ES_USERNAME + ES_PASSWORD. Returns a markdown table of hits. (elastic tier)",
  params: esQueryParams,
  tier: "elastic",
  run: esQuery,
};
