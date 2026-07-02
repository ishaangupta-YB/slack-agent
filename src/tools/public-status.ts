import { z } from "zod";
import type { Tool } from "./types.js";

const params = z.object({
  status_page_url: z
    .string()
    .describe(
      "URL of a public status page JSON endpoint. Common formats: https://status.example.com/api/v2/status.json or https://status.example.com/index.json",
    ),
});

/**
 * Fetch a public status-page JSON endpoint and return a concise summary.
 * Supports the common statuspage.io /api/v2/status.json shape as well as
 * generic JSON endpoints that expose status, indicator, or description fields.
 *
 * This is useful for under-resourced nonprofit / civic-tech teams that need to
 * monitor public infrastructure dependencies from Slack without writing custom
 * dashboards or alerting.
 */
export const publicStatusTool: Tool = {
  name: "public_status",
  description:
    "Check the public status page of an external service. Useful for monitoring civic, nonprofit, or public-infrastructure dependencies from a Slack thread.",
  params,
  tier: "basic",
  async run(input) {
    const url = input.status_page_url;
    if (!URL.canParse(url)) {
      return `Invalid status page URL: ${url}`;
    }

    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return `Unsupported protocol: ${parsed.protocol}. Only HTTP/HTTPS status pages are supported.`;
    }

    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return `Status page returned HTTP ${response.status}: ${response.statusText}`;
    }

    const body = await response.json();

    // statuspage.io v2 shape
    if (body && typeof body === "object" && "page" in body && "status" in body) {
      const status = (body as { status?: { indicator?: string; description?: string } }).status;
      const pageName = (body as { page?: { name?: string } }).page?.name ?? "Service";
      const indicator = status?.indicator ?? "unknown";
      const description = status?.description ?? "No status description provided.";
      const updatedAt = (body as { page?: { updated_at?: string } }).page?.updated_at;
      const updatedLine = updatedAt ? `\n_Updated ${updatedAt}_` : "";
      return `**${pageName}** status: *${indicator}*\n${description}${updatedLine}`;
    }

    // Generic JSON shape
    if (body && typeof body === "object") {
      const indicator =
        (body as Record<string, unknown>).indicator ??
        (body as Record<string, unknown>).status ??
        "unknown";
      const description =
        (body as Record<string, unknown>).description ??
        (body as Record<string, unknown>).message ??
        "No status description provided.";
      const name = (body as Record<string, unknown>).name ?? "Service";
      const updatedAt = (body as Record<string, unknown>).updated_at ?? (body as Record<string, unknown>).updated;
      const updatedLine = updatedAt ? `\n_Updated ${updatedAt}_` : "";
      return `**${name}** status: *${String(indicator)}*\n${String(description)}${updatedLine}`;
    }

    return "Status page returned an unrecognized JSON shape.";
  },
};
