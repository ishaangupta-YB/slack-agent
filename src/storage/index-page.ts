import type { Metrics } from "./metrics.js";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

interface IndexPageOptions {
  metrics: Metrics;
  sessions: string[];
  responses: string[];
}

export function renderIndexPage({ metrics, sessions, responses }: IndexPageOptions): string {
  const sessionRows = sessions
    .map((filename) => {
      const encoded = encodeURIComponent(filename);
      return `<tr>
        <td><a href="/trace/${encoded}">${escapeHtml(filename)}</a></td>
        <td><a href="/sessions/${encoded}">JSONL</a></td>
      </tr>`;
    })
    .join("\n") || '<tr><td colspan="2">No session traces yet.</td></tr>';

  const responseRows = responses
    .map((filename) => {
      const encoded = encodeURIComponent(filename);
      return `<tr>
        <td><a href="/responses/${encoded}">${escapeHtml(filename)}</a></td>
      </tr>`;
    })
    .join("\n") || '<tr><td colspan="1">No response artifacts yet.</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Moon Bot Artifacts</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2rem; background: #f6f8fa; color: #1f2328; }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    .subhead { color: #656d76; margin-bottom: 1.5rem; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .card { background: #fff; border-radius: 8px; padding: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); text-align: center; }
    .card .value { font-size: 1.75rem; font-weight: 700; color: #0969da; }
    .card .label { font-size: 0.85rem; color: #656d76; margin-top: 0.25rem; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 2rem; }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #d0d7de; }
    th { background: #f3f4f6; font-weight: 600; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .links { margin-top: 1.5rem; }
    .links a { margin-right: 1rem; }
  </style>
</head>
<body>
  <h1>🌙 Moon Bot Artifacts</h1>
  <p class="subhead">Session traces, response files, and runtime metrics</p>

  <div class="cards">
    <div class="card"><div class="value">${metrics.sessions}</div><div class="label">Sessions</div></div>
    <div class="card"><div class="value">${metrics.responseArtifacts}</div><div class="label">Responses</div></div>
    <div class="card"><div class="value">${metrics.threadMapEntries}</div><div class="label">Thread Maps</div></div>
    <div class="card"><div class="value">${metrics.memoryEntries}</div><div class="label">Memory Entries</div></div>
    <div class="card"><div class="value">${metrics.feedbackEntries}</div><div class="label">Feedback Events</div></div>
    <div class="card"><div class="value">${metrics.auditEntries}</div><div class="label">Audit Events</div></div>
  </div>

  <p class="subhead">Uptime: ${formatDuration(metrics.uptimeSeconds)}</p>

  <h2>Session Traces</h2>
  <table>
    <thead><tr><th>Session</th><th>Raw</th></tr></thead>
    <tbody>${sessionRows}</tbody>
  </table>

  <h2>Response Artifacts</h2>
  <table>
    <thead><tr><th>Response</th></tr></thead>
    <tbody>${responseRows}</tbody>
  </table>

  <div class="links">
    <a href="/metrics">📊 Metrics (JSON)</a>
    <a href="/health">🏥 Health</a>
  </div>
</body>
</html>`;
}
