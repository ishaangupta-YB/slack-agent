import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { cfg } from "../config.js";

const baseDir = resolve(cfg.storage.bucketDir);

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

        if (rawPath === "/health") {
          serveJson(res, 200, healthCheck());
          return;
        }

        if (req.method !== "GET" && req.method !== "HEAD") {
          serveError(res, 405, "Method not allowed");
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
      console.log(`Bucket server listening on port ${cfg.storage.bucketHttpPort}`);
      resolveStart(server);
    });

    server.on("error", (err) => {
      console.error("Bucket server error:", err);
    });
  });
}
