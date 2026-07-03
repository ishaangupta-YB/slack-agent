/**
 * Render a JSONL session trace as a human-readable HTML timeline.
 *
 * HuggingFace Buckets render native trace viewers for agent session files.
 * For local deployments, this lightweight renderer lets users open the
 * session link from Slack and step through every turn: user messages,
 * assistant reasoning, tool calls, tool results, and final replies.
 */

export interface TraceLine {
  role?: string;
  content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  [key: string]: unknown;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatContent(line: TraceLine): string {
  const parts: string[] = [];

  if (line.role) {
    parts.push(`<span class="role">${escapeHtml(line.role)}</span>`);
  }

  if (line.name || line.tool_call_id) {
    parts.push(
      `<span class="tool-meta">${escapeHtml(line.name || line.tool_call_id || "")}</span>`,
    );
  }

  if (line.tool_calls && line.tool_calls.length > 0) {
    parts.push('<div class="tool-calls">');
    for (const call of line.tool_calls) {
      const fn = call.function ?? {};
      parts.push(
        `<div class="tool-call"><span class="tool-name">${escapeHtml(fn.name || "tool")}</span>`,
      );
      if (fn.arguments) {
        parts.push(
          `<pre><code>${escapeHtml(fn.arguments)}</code></pre>`,
        );
      }
      parts.push("</div>");
    }
    parts.push("</div>");
  }

  if (line.content && String(line.content).trim().length > 0) {
    parts.push(
      `<pre class="content"><code>${escapeHtml(String(line.content))}</code></pre>`,
    );
  }

  return parts.join("\n");
}

export function renderSessionTrace(filename: string, jsonl: string): string {
  const lines = jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): TraceLine => {
      try {
        return JSON.parse(line) as TraceLine;
      } catch {
        return { content: line };
      }
    });

  const turnRows = lines
    .map((line, idx) => {
      const cssClass = line.role ? `turn ${line.role}` : "turn";
      const summary = line.role
        ? `Turn ${idx + 1}: ${line.role}${line.name ? ` / ${line.name}` : ""}`
        : `Turn ${idx + 1}`;
      return [
        `<tr class="${cssClass}">`,
        `  <td class="turn-number">${idx + 1}</td>`,
        `  <td class="turn-summary">${escapeHtml(summary)}</td>`,
        `  <td class="turn-detail">${formatContent(line)}</td>`,
        "</tr>",
      ].join("\n");
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ishu Trace — ${escapeHtml(filename)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2rem; background: #f6f8fa; color: #1f2328; }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    .subhead { color: #656d76; margin-bottom: 1.5rem; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    th, td { padding: 0.75rem 1rem; text-align: left; vertical-align: top; border-bottom: 1px solid #d0d7de; }
    th { background: #f3f4f6; font-weight: 600; }
    .turn-number { width: 3rem; color: #656d76; }
    .turn-summary { width: 18%; font-weight: 600; }
    .role { display: inline-block; padding: 0.15rem 0.45rem; border-radius: 999px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; background: #ddf4ff; color: #0969da; margin-bottom: 0.5rem; }
    .tool-meta { display: block; color: #656d76; font-size: 0.85rem; margin-bottom: 0.5rem; }
    .tool-calls { margin: 0.5rem 0; }
    .tool-call { margin-bottom: 0.5rem; padding: 0.5rem; border-left: 3px solid #0969da; background: #f6f8fa; border-radius: 4px; }
    .tool-name { font-weight: 600; font-size: 0.85rem; }
    pre { margin: 0.25rem 0 0; white-space: pre-wrap; word-break: break-word; font-size: 0.85rem; }
    pre.content { background: #f6f8fa; padding: 0.75rem; border-radius: 4px; }
    code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
  </style>
</head>
<body>
  <h1>🌙 Ishu Session Trace</h1>
  <p class="subhead">${escapeHtml(filename)} &middot; ${lines.length} turn${lines.length === 1 ? "" : "s"}</p>
  <table>
    <thead>
      <tr><th>#</th><th>Role</th><th>Details</th></tr>
    </thead>
    <tbody>
      ${turnRows}
    </tbody>
  </table>
</body>
</html>`;
}

export function renderTraceError(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Ishu Trace</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2rem; background: #fff0f0; color: #82071e; }
  </style>
</head>
<body>
  <h1>🌙 Ishu Trace</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}
