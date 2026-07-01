import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { cfg } from "../config.js";

let activeServer: Server | undefined;

const DEFAULT_UPSTREAM = "https://plausible.io";

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
  apiKey: string;
}

export function getPlausibleProxyConfig(): ProxyConfig | undefined {
  const port = cfg.integrations.plausibleProxyPort;
  const upstreamUrl = cfg.integrations.plausibleUpstreamUrl?.replace(/\/$/, "") || DEFAULT_UPSTREAM;
  const proxyToken = cfg.integrations.plausibleProxyToken;
  const apiKey = cfg.integrations.plausibleApiKey;

  if (!port || !proxyToken || !apiKey) return undefined;
  return { port, upstreamUrl, proxyToken, apiKey };
}

export async function startPlausibleProxy(): Promise<Server | undefined> {
  const proxyConfig = getPlausibleProxyConfig();
  if (!proxyConfig) {
    console.log(
      "Plausible proxy disabled (set PLAUSIBLE_API_KEY, PLAUSIBLE_PROXY_PORT, and PLAUSIBLE_PROXY_TOKEN to enable)",
    );
    return undefined;
  }

  stopPlausibleProxy();

  return new Promise((resolveStart) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const token = extractBearer(req);
        if (!token || token !== proxyConfig.proxyToken) {
          send(res, 401, "Unauthorized: provide a valid PLAUSIBLE_PROXY_TOKEN via Bearer header");
          return;
        }

        if (req.method !== "POST") {
          send(res, 405, "Method not allowed: only POST /api/v2/query is supported");
          return;
        }

        if (req.url !== "/api/v2/query") {
          send(res, 403, "Forbidden: only /api/v2/query is allow-listed");
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);

        const upstreamHeaders: Record<string, string> = {
          "Content-Type": req.headers["content-type"] || "application/json",
          Authorization: `Bearer ${proxyConfig.apiKey}`,
        };
        if (req.headers.accept) {
          upstreamHeaders.Accept = req.headers.accept;
        }

        const upstreamResp = await fetch(`${proxyConfig.upstreamUrl}/api/v2/query`, {
          method: "POST",
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
        send(res, 502, `Plausible proxy error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    server.listen(proxyConfig.port, () => {
      console.log(`Plausible credential proxy listening on http://localhost:${proxyConfig.port} -> ${proxyConfig.upstreamUrl}/api/v2/query`);
      activeServer = server;
      resolveStart(server);
    });

    server.on("error", (err) => {
      console.error("Plausible proxy server error:", err);
    });
  });
}

export function stopPlausibleProxy(): void {
  if (activeServer) {
    activeServer.close();
    activeServer = undefined;
  }
}

export function getActivePlausibleProxy(): Server | undefined {
  return activeServer;
}
