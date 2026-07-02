import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

let activeServer: Server | undefined;
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { cfg } from "../config.js";
import { renderSessionTrace, renderTraceError } from "./trace-viewer.js";
import { getMetrics } from "./metrics.js";
import { renderIndexPage } from "./index-page.js";

const baseDir = resolve(cfg.storage.bucketDir);
const sessionsDir = resolve(cfg.agent.sessionsDir);

function notFound(res: ServerResponse, message: string) {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end(message);
}

function serveError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(message);
}

function serveJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload, null, 2));
}

function addCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function getContentType(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop();
  switch (ext) {
    case "md":
      return "text/markdown; charset=utf-8";
    case "html":
      return "text/html; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "jsonl":
      return "application/jsonlines; charset=utf-8";
    case "js":
      return "application/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    default:
      return "text/plain; charset=utf-8";
  }
}

function healthCheck(): { status: string; bucketDir: string; bucketReady: boolean } {
  return {
    status: "ok",
    bucketDir: baseDir,
    bucketReady: existsSync(baseDir),
  };
}

function listArtifacts(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(ext))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

function serveIndexPage(res: ServerResponse): void {
  const metrics = getMetrics();
  const sessions = listArtifacts(join(sessionsDir), ".jsonl");
  const responses = listArtifacts(join(baseDir, "responses"), ".md");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderIndexPage({ metrics, sessions, responses }));
}

export function startBucketServer(): Promise<Server> {
  return new Promise((resolveStart) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      try {
        addCorsHeaders(res);
        const rawPath = req.url?.split("?")[0] || "/";

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (rawPath === "/") {
          serveIndexPage(res);
          return;
        }

        if (rawPath === "/health") {
          serveJson(res, 200, healthCheck());
          return;
        }

        if (rawPath === "/metrics") {
          serveJson(res, 200, getMetrics());
          return;
        }

        if (req.method !== "GET" && req.method !== "HEAD") {
          serveError(res, 405, "Method not allowed");
          return;
        }

        if (rawPath.startsWith("/trace/")) {
          const filename = rawPath.slice("/trace/".length).replace(/[^a-zA-Z0-9_.-]/g, "_");
          if (!filename) {
            serveError(res, 400, "Missing trace filename");
            return;
          }
          const sessionPath = join(sessionsDir, filename);
          const safePath = normalize(sessionPath);
          if (!safePath.startsWith(sessionsDir)) {
            serveError(res, 403, "Forbidden");
            return;
          }
          if (!existsSync(safePath)) {
            res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderTraceError(`Session not found: ${filename}`));
            return;
          }
          const jsonl = readFileSync(safePath, "utf-8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderSessionTrace(filename, jsonl));
          return;
        }

        const safePath = normalize(join(baseDir, rawPath));
        if (!safePath.startsWith(baseDir)) {
          serveError(res, 403, "Forbidden");
          return;
        }
        if (!existsSync(safePath)) {
          notFound(res, "Not found");
          return;
        }
        const content = readFileSync(safePath);
        res.writeHead(200, { "Content-Type": getContentType(safePath) });
        res.end(content);
      } catch (err) {
        serveError(res, 500, err instanceof Error ? err.message : "Internal error");
      }
    });

    server.listen(cfg.storage.bucketHttpPort, () => {
      activeServer = server;
      console.log(`Bucket server listening on port ${cfg.storage.bucketHttpPort}`);
      resolveStart(server);
    });

    server.on("close", () => {
      activeServer = undefined;
    });

    server.on("error", (err) => {
      console.error("Bucket server error:", err);
    });
  });
}

export function stopBucketServer(): void {
  if (activeServer) {
    activeServer.close();
    activeServer = undefined;
  }
}

export function getActiveBucketServer(): Server | undefined {
  return activeServer;
}
