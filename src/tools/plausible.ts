import { z } from "zod";
import { cfg } from "../config.js";
import { truncateOutput } from "./types.js";
import type { Tool } from "./types.js";

const PLAUSIBLE_API_BASE = "https://plausible.io/api/v2";

const plausibleQueryParams = z.object({
  site_id: z.string().describe("Plausible site/domain id, e.g. huggingface.co"),
  metrics: z
    .array(z.enum(["visitors", "pageviews", "bounce_rate", "visit_duration", "views_per_visit", "events"]))
    .default(["visitors", "pageviews"])
    .describe("Metrics to query."),
  dimensions: z
    .array(z.string())
    .default([])
    .describe("Optional dimensions such as event:page or visit:source."),
  date_range: z
    .union([z.enum(["day", "7d", "30d", "month", "6mo", "12mo", "custom"]), z.string()])
    .default("30d")
    .describe("Date range preset or ISO date range 'YYYY-MM-DD,YYYY-MM-DD'."),
  filters: z
    .array(z.string())
    .default([])
    .describe("Optional filters such as 'event:page==/docs'."),
  limit: z.number().int().min(1).max(1000).default(100),
});

interface PlausibleQueryResult {
  results?: Array<Record<string, string | number>>;
  error?: { message: string };
  [key: string]: unknown;
}

function formatPlausibleResult(
  data: PlausibleQueryResult,
  metrics: string[],
  dimensions: string[],
): string {
  if (data.error) {
    return `Plausible API error: ${data.error.message ?? "unknown error"}`;
  }

  const results = data.results;
  if (!results || results.length === 0) {
    return "No results for the requested query.";
  }

  const headers = [...dimensions, ...metrics];
  const rows = results.map((row) =>
    headers.map((h) => (row[h] !== undefined ? String(row[h]) : "")).join(" | "),
  );

  const table = [headers.join(" | "), headers.map(() => "---").join(" | "), ...rows].join("\n");
  return `Plausible analytics for ${metrics.join(", ")}:\n\n${table}`;
}

function buildQueryPayload(input: z.infer<typeof plausibleQueryParams>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    site_id: input.site_id,
    metrics: input.metrics.map((m) => ({ metric: m })),
    date_range: input.date_range,
    limit: input.limit,
  };

  if (input.dimensions.length > 0) {
    payload.dimensions = input.dimensions.map((d) => ({ property: d }));
  }

  if (input.filters.length > 0) {
    payload.filters = input.filters;
  }

  return payload;
}

async function plausibleQuery(input: z.infer<typeof plausibleQueryParams>): Promise<string> {
  if (!cfg.integrations.plausibleApiKey) {
    return "Plausible is not configured. Set PLAUSIBLE_API_KEY to query analytics.";
  }

  try {
    const resp = await fetch(`${PLAUSIBLE_API_BASE}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.integrations.plausibleApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildQueryPayload(input)),
    });

    const data = (await resp.json()) as PlausibleQueryResult;

    if (!resp.ok) {
      return `Plausible request failed ${resp.status}: ${data.error?.message ?? JSON.stringify(data)}`;
    }

    const formatted = formatPlausibleResult(data, input.metrics, input.dimensions);
    return truncateOutput(formatted, 8_000);
  } catch (err) {
    return `Plausible request failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const plausibleQueryTool: Tool = {
  name: "plausible_query",
  description:
    "Query privacy-preserving web analytics from Plausible Stats API v2. Requires PLAUSIBLE_API_KEY. Common metrics: visitors, pageviews, bounce_rate, visit_duration. Common dimensions: event:page, visit:source, visit:country.",
  params: plausibleQueryParams,
  tier: "basic",
  run: plausibleQuery,
};
