import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { cfg } from "../config.js";

let activeServer: Server | undefined;

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain"): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function extractBearer(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function upstreamAuthHeader(): string | undefined {
  if (cfg.integrations.esApiKey) {
    return `ApiKey ${cfg.integrations.esApiKey}`;
  }
  if (cfg.integrations.esUsername && cfg.integrations.esPassword) {
    const credentials = Buffer.from(`${cfg.integrations.esUsername}:${cfg.integrations.esPassword}`).toString("base64");
    return `Basic ${credentials}`;
  }
  return undefined;
}

interface ProxyConfig {
  port: number;
  upstreamUrl: string;
  proxyToken: string;
}

export function getEsProxyConfig(): ProxyConfig | undefined {
  const port = cfg.integrations.esProxyPort;
  const upstreamUrl = cfg.integrations.esUrl;
  const proxyToken = cfg.integrations.esProxyToken;

  if (!port || !upstreamUrl || !proxyToken) return undefined;
  return { port, upstreamUrl, proxyToken };
}

export async function startEsProxy(): Promise<Server | undefined> {
  const proxyConfig = getEsProxyConfig();
  if (!proxyConfig) {
    console.log("ES proxy disabled (set ES_URL, ES_API_KEY or ES credentials, and ES_PROXY_TOKEN to enable)");
    return undefined;
  }

  stopEsProxy();

  const upstreamAuth = upstreamAuthHeader();
  if (!upstreamAuth) {
    console.warn("ES proxy enabled but no upstream credentials configured (ES_API_KEY or ES_USERNAME+ES_PASSWORD)");
  }

  const upstreamBase = proxyConfig.upstreamUrl.replace(/\/$/, "");

  return new Promise((resolveStart) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const token = extractBearer(req);
        if (!token || token !== proxyConfig.proxyToken) {
          send(res, 401, "Unauthorized: provide a valid ES_PROXY_TOKEN via Bearer header");
          return;
        }

        if (req.method && !["GET", "POST", "HEAD", "PUT"].includes(req.method)) {
          send(res, 405, "Method not allowed");
          return;
        }

        const path = req.url || "/";
        const upstreamUrl = `${upstreamBase}${path}`;

        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);

        const upstreamHeaders: Record<string, string> = {
          "Content-Type": req.headers["content-type"] || "application/json",
        };
        if (upstreamAuth) {
          upstreamHeaders.Authorization = upstreamAuth;
        }
        if (req.headers.accept) {
          upstreamHeaders.Accept = req.headers.accept;
        }

        const upstreamResp = await fetch(upstreamUrl, {
          method: req.method || "GET",
          headers: upstreamHeaders,
          body: body.length > 0 ? body : undefined,
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
        send(res, 502, `ES proxy error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    server.listen(proxyConfig.port, () => {
      console.log(`ES credential proxy listening on http://localhost:${proxyConfig.port} -> ${upstreamBase}`);
      activeServer = server;
      resolveStart(server);
    });

    server.on("error", (err) => {
      console.error("ES proxy server error:", err);
    });
  });
}

export function stopEsProxy(): void {
  if (activeServer) {
    activeServer.close();
    activeServer = undefined;
  }
}

export function getActiveEsProxy(): Server | undefined {
  return activeServer;
}
