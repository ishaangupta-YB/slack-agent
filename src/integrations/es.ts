import { cfg } from "../config.js";

export interface EsHit {
  _id: string;
  _index: string;
  _score?: number;
  _source?: Record<string, unknown>;
}

export interface EsSearchResponse {
  took?: number;
  hits?: {
    total?: number | { value: number; relation: string };
    hits?: EsHit[];
  };
  aggregations?: Record<string, unknown>;
  error?: { reason?: string; type?: string };
  status?: number;
}

export interface EsSearchInput {
  index: string;
  query: Record<string, unknown>;
  size?: number;
  _source?: string[];
}

export interface EsSearchResult {
  ok: boolean;
  data?: EsSearchResponse;
  status?: number;
  error?: string;
}

/**
 * Raw Elasticsearch _search query. Handles direct auth and the local credential
 * proxy so callers never have to repeat credential resolution logic.
 */
export async function esSearch(input: EsSearchInput): Promise<EsSearchResult> {
  if (!cfg.integrations.esUrl) {
    return { ok: false, error: "Elasticsearch is not configured. Set ES_URL to enable queries." };
  }

  const body: Record<string, unknown> = { ...input.query };
  body.size = Math.min(Math.max(input.size ?? 10, 1), 1000);
  if (input._source && input._source.length > 0) {
    body._source = input._source;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let baseUrl = cfg.integrations.esUrl.replace(/\/$/, "");

  if (cfg.integrations.esProxyToken && cfg.integrations.esProxyPort) {
    baseUrl = `http://127.0.0.1:${cfg.integrations.esProxyPort}`;
    headers.Authorization = `Bearer ${cfg.integrations.esProxyToken}`;
  } else if (cfg.integrations.esApiKey) {
    headers.Authorization = `ApiKey ${cfg.integrations.esApiKey}`;
  } else if (cfg.integrations.esUsername && cfg.integrations.esPassword) {
    const credentials = Buffer.from(`${cfg.integrations.esUsername}:${cfg.integrations.esPassword}`).toString("base64");
    headers.Authorization = `Basic ${credentials}`;
  }

  try {
    const url = `${baseUrl}/${encodeURIComponent(input.index)}/_search`;
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const data = (await resp.json()) as EsSearchResponse;

    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        error: data.error?.reason ?? `Elasticsearch request failed ${resp.status}`,
      };
    }

    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: `Elasticsearch request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function totalHits(data: EsSearchResponse): number {
  const raw = data.hits?.total;
  if (typeof raw === "number") return raw;
  return (raw as { value?: number } | undefined)?.value ?? data.hits?.hits?.length ?? 0;
}
