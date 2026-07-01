import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { cfg } from "../config.js";

let activeServer: Server | undefined;

const DEFAULT_UPSTREAM = "https://huggingface.co";

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain"): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function extractBearer(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

interface ProxyConfig {
  port: number;
  upstreamUrl: string;
  proxyToken: string;
  hfToken: string;
  allowedRepo: string;
}

export function getHfProxyConfig(): ProxyConfig | undefined {
  const port = cfg.integrations.hfProxyPort;
  const proxyToken = cfg.integrations.hfProxyToken;
  const hfToken = cfg.hf.token;
  const allowedRepo = cfg.integrations.hfProxyRepo || "huggingface/storage-visualization-data";
  const upstreamUrl = cfg.integrations.hfUpstreamUrl?.replace(/\/$/, "") || DEFAULT_UPSTREAM;

  if (!port || !proxyToken || !hfToken) return undefined;
  return { port, upstreamUrl, proxyToken, hfToken, allowedRepo };
}

function isAllowedPath(path: string, allowedRepo: string): boolean {
  const normalizedRepo = allowedRepo.replace(/^\/+|\/+$/, "");
  // Only permit reads under /datasets/<allowedRepo>/ so the proxy cannot be
  // abused to reach other HF namespaces or endpoints.
  return path === `/datasets/${normalizedRepo}` || path.startsWith(`/datasets/${normalizedRepo}/`);
}

export async function startHfProxy(): Promise<Server | undefined> {
  const proxyConfig = getHfProxyConfig();
  if (!proxyConfig) {
    console.log(
      "HF proxy disabled (set HF_TOKEN, HF_PROXY_PORT, and HF_PROXY_TOKEN to enable)",
    );
    return undefined;
  }

  stopHfProxy();

  const upstreamBase = proxyConfig.upstreamUrl.replace(/\/$/, "");

  return new Promise((resolveStart) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const token = extractBearer(req);
        if (!token || token !== proxyConfig.proxyToken) {
          send(res, 401, "Unauthorized: provide a valid HF_PROXY_TOKEN via Bearer header");
          return;
        }

        if (req.method !== "GET" && req.method !== "HEAD") {
          send(res, 405, "Method not allowed: only GET and HEAD are supported");
          return;
        }

        const path = req.url || "/";
        if (!isAllowedPath(path, proxyConfig.allowedRepo)) {
          send(
            res,
            403,
            `Forbidden: only paths under /datasets/${proxyConfig.allowedRepo} are allow-listed`,
          );
          return;
        }

        const upstreamUrl = `${upstreamBase}${path}`;

        const upstreamHeaders: Record<string, string> = {};
        if (req.headers.accept) {
          upstreamHeaders.Accept = req.headers.accept;
        }
        if (req.headers["if-none-match"]) {
          upstreamHeaders["If-None-Match"] = req.headers["if-none-match"] as string;
        }
        upstreamHeaders.Authorization = `Bearer ${proxyConfig.hfToken}`;

        const upstreamResp = await fetch(upstreamUrl, {
          method: req.method,
          headers: upstreamHeaders,
        });

        res.statusCode = upstreamResp.status;
        upstreamResp.headers.forEach((value, key) => {
          if (value && !["content-encoding", "transfer-encoding"].includes(key.toLowerCase())) {
            res.setHeader(key, value);
          }
        });

        const respBody = Buffer.from(await upstreamResp.arrayBuffer());
        res.end(respBody);
      } catch (err) {
        send(res, 502, `HF proxy error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    server.listen(proxyConfig.port, () => {
      console.log(
        `HF credential proxy listening on http://localhost:${proxyConfig.port} -> ${upstreamBase}/datasets/${proxyConfig.allowedRepo}`,
      );
      activeServer = server;
      resolveStart(server);
    });

    server.on("error", (err) => {
      console.error("HF proxy server error:", err);
    });
  });
}

export function stopHfProxy(): void {
  if (activeServer) {
    activeServer.close();
    activeServer = undefined;
  }
}

export function getActiveHfProxy(): Server | undefined {
  return activeServer;
}
