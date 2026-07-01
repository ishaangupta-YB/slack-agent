import { createSign, randomUUID } from "node:crypto";
import { cfg } from "../config.js";

const GH_API_BASE = "https://api.github.com";

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | undefined;
let fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args);

export function setFetchOverride(override: typeof fetch): void {
  fetchImpl = override;
}

export function clearFetchOverride(): void {
  fetchImpl = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args);
}

export function clearGitHubTokenCache(): void {
  tokenCache = undefined;
}

function normalizePrivateKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.includes("-----BEGIN")) {
    return trimmed.replace(/\\n/g, "\n");
  }
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf-8");
    if (decoded.includes("-----BEGIN")) {
      return decoded;
    }
  } catch {
    // fall through
  }
  throw new Error("GITHUB_PRIVATE_KEY does not appear to be a valid PEM key");
}

function signAppJwt(appId: string, privateKey: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSeconds - 60,
    exp: nowSeconds + 600,
    iss: appId,
  };

  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer
    .sign(normalizePrivateKey(privateKey), "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${signingInput}.${signature}`;
}

async function exchangeForInstallationToken(jwt: string, installationId: string): Promise<TokenCache> {
  const resp = await fetchImpl(`${GH_API_BASE}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub App token exchange failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as { token: string; expires_at?: string };
  const expiresAt = data.expires_at ? Date.parse(data.expires_at) - 60000 : Date.now() + 3540000;
  return { token: data.token, expiresAt };
}

async function getAppToken(): Promise<string> {
  const { appId, privateKey, installationId } = cfg.integrations.githubApp;

  if (!appId || !privateKey || !installationId) {
    throw new Error("GitHub App credentials are incomplete (GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_INSTALLATION_ID)");
  }

  if (tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token;
  }

  const jwt = signAppJwt(appId, privateKey);
  tokenCache = await exchangeForInstallationToken(jwt, installationId);
  return tokenCache.token;
}

export async function getGitHubToken(): Promise<string> {
  const appEnabled =
    cfg.integrations.githubApp.appId &&
    cfg.integrations.githubApp.privateKey &&
    cfg.integrations.githubApp.installationId;

  if (appEnabled) {
    return getAppToken();
  }

  if (!cfg.integrations.githubToken) {
    throw new Error("GitHub is not configured. Set GITHUB_TOKEN or GITHUB_APP_ID + GITHUB_PRIVATE_KEY + GITHUB_INSTALLATION_ID.");
  }

  return cfg.integrations.githubToken;
}

export async function githubApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = path.startsWith("http") ? path : `${GH_API_BASE}${path}`;
  const token = await getGitHubToken();
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub API ${options.method || "GET"} ${path} failed (${resp.status}): ${body}`);
  }

  if (resp.status === 204) {
    return undefined as T;
  }

  return (await resp.json()) as T;
}

export function buildGitHubActionId(): string {
  return randomUUID();
}
