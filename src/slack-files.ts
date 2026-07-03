import { WebClient } from "@slack/web-api";
import { cfg } from "./config.js";

export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  url_private?: string;
  size?: number;
}

interface FileContent {
  name: string;
  text: string;
  truncated: boolean;
}

const ALLOWED_FILETYPES = new Set([
  "text",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/json",
  "text/csv",
  "application/javascript",
  "text/javascript",
  "text/typescript",
  "application/typescript",
  "text/x-python",
  "text/python",
  "text/x-shellscript",
  "text/x-log",
  "log",
  "text/css",
  "text/html",
  "text/xml",
  "application/xml",
  "text/yaml",
  "application/x-yaml",
  "toml",
  "ini",
]);

function isTextLike(file: SlackFile): boolean {
  if (file.mimetype && ALLOWED_FILETYPES.has(file.mimetype.toLowerCase())) return true;
  if (file.filetype && ALLOWED_FILETYPES.has(file.filetype.toLowerCase())) return true;
  const name = file.name || "";
  const lower = name.toLowerCase();
  const textExtensions = [".txt", ".md", ".markdown", ".json", ".csv", ".log", ".ts", ".js", ".tsx", ".jsx", ".py", ".sh", ".bash", ".css", ".html", ".htm", ".xml", ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg", ".sql", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".rb", ".php", ".swift", ".kt", ".scala", ".r", ".m", ".pl"];
  return textExtensions.some((ext) => lower.endsWith(ext));
}

function clampedInt(value: number, fallback: number): number {
  return Number.isNaN(value) || value <= 0 ? fallback : value;
}

async function fetchSlackFile(url: string, token: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Slack file download failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

/**
 * Download text-like file attachments from a Slack message.
 *
 * Only files under the configured size limit and with text-like mimetypes or
 * extensions are fetched. Binary files are skipped so the LLM context stays
 * small and useful.
 */
export async function downloadSlackFiles(
  client: WebClient,
  files: SlackFile[],
): Promise<FileContent[]> {
  const maxFiles = clampedInt(cfg.slack.maxFileAttachments, 3);
  const maxFileBytes = clampedInt(cfg.slack.maxFileBytes, 1048576);
  const botToken = cfg.slack.botToken;
  const results: FileContent[] = [];

  for (const file of files.slice(0, maxFiles)) {
    try {
      if (!isTextLike(file)) continue;
      if (!file.id) continue;

      // Refresh file metadata so we have the latest size and private URL.
      const info = await client.files.info({ file: file.id });
      const metadata = (info.file as SlackFile | undefined) ?? file;
      const size = metadata.size ?? 0;
      const url = metadata.url_private;
      if (!url) continue;
      if (size > maxFileBytes) {
        results.push({
          name: metadata.name || "unknown",
          text: "",
          truncated: true,
        });
        continue;
      }

      const text = await fetchSlackFile(url, botToken);
      results.push({ name: metadata.name || "unknown", text, truncated: false });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      results.push({ name: file.name || "unknown", text: `[download failed: ${reason}]`, truncated: false });
    }
  }

  return results;
}

/**
 * Format downloaded Slack files as context appended to the user's message.
 */
export function formatSlackFiles(files: FileContent[]): string {
  if (files.length === 0) return "";
  const blocks = files.map((f) => {
    const header = `[attached file: ${f.name}${f.truncated ? " (too large to include)" : ""}]`;
    if (f.truncated) return header;
    return `${header}\n\`\`\`\n${f.text}\n\`\`\``;
  });
  return "\n\n" + blocks.join("\n\n");
}
