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
        const rawPath = req.url?.split("?")[0] || "/";

        if (rawPath === "/health") {
          serveJson(res, 200, healthCheck());
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
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
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
