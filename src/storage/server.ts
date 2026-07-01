import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

export function startBucketServer(): Promise<void> {
  return new Promise((resolveStart) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      try {
        const rawPath = req.url?.split("?")[0] || "/";
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
      resolveStart();
    });

    server.on("error", (err) => {
      console.error("Bucket server error:", err);
    });
  });
}
