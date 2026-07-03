import "dotenv/config";
import { createSign } from "node:crypto";
import { pathToFileURL } from "node:url";

export interface GitHubVerifyCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface GitHubVerifyResult {
  ok: boolean;
  checks: GitHubVerifyCheck[];
  mode: "token" | "app" | "none";
}

export interface VerifyGitHubOptions {
  token?: string;
  appId?: string;
  privateKey?: string;
  installationId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const GH_API_BASE = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 30_000;

function looksLikeToken(token: string): boolean {
  return token.startsWith("ghp_") || token.startsWith("github_pat_");
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

async function exchangeForInstallationToken(
  jwt: string,
  installationId: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  const resp = await fetchImpl(`${GH_API_BASE}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
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

  const data = (await resp.json()) as { token: string };
  return data.token;
}

async function fetchWithAuth(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  return fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ishu-verify",
    },
  });
}

/**
 * Verify that GitHub is reachable and that the configured credentials are
 * valid. Supports both personal access tokens (GITHUB_TOKEN) and GitHub App
 * installations (GITHUB_APP_ID + GITHUB_PRIVATE_KEY + GITHUB_INSTALLATION_ID).
 */
export async function verifyGitHub(options?: VerifyGitHubOptions): Promise<GitHubVerifyResult> {
  const token = options?.token ?? process.env.GITHUB_TOKEN ?? "";
  const appId = options?.appId ?? process.env.GITHUB_APP_ID ?? "";
  const privateKey = options?.privateKey ?? process.env.GITHUB_PRIVATE_KEY ?? "";
  const installationId = options?.installationId ?? process.env.GITHUB_INSTALLATION_ID ?? "";
  const timeoutMs = options?.timeoutMs ?? Number.parseInt(process.env.GITHUB_API_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10);
  const fetchImpl = options?.fetchImpl ?? fetch;

  const checks: GitHubVerifyCheck[] = [];

  const appEnabled = Boolean(appId) && Boolean(privateKey) && Boolean(installationId);
  const tokenEnabled = Boolean(token);

  if (!tokenEnabled && !appEnabled) {
    checks.push({
      name: "env_credentials",
      ok: false,
      message:
        "GitHub is not configured. Set GITHUB_TOKEN, or GITHUB_APP_ID + GITHUB_PRIVATE_KEY + GITHUB_INSTALLATION_ID.",
    });
    return { ok: false, checks, mode: "none" };
  }

  const mode = appEnabled ? "app" : "token";

  checks.push({
    name: "env_credentials",
    ok: true,
    message: appEnabled
      ? `GitHub App ${appId} configured for installation ${installationId}.`
      : looksLikeToken(token)
        ? "GITHUB_TOKEN is set and looks like a PAT."
        : "GITHUB_TOKEN is set.",
  });

  if (mode === "app") {
    let appToken: string;
    try {
      appToken = await exchangeForInstallationToken(
        signAppJwt(appId, privateKey),
        installationId,
        fetchImpl,
        timeoutMs,
      );
      checks.push({
        name: "app_installation_token",
        ok: true,
        message: "GitHub App installation token exchanged successfully.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checks.push({
        name: "app_installation_token",
        ok: false,
        message,
      });
      return { ok: false, checks, mode };
    }

    try {
      const resp = await fetchWithAuth(`${GH_API_BASE}/app`, appToken, fetchImpl, timeoutMs);
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`GitHub App metadata fetch failed (${resp.status}): ${body}`);
      }
      const data = (await resp.json()) as { slug?: string; name?: string };
      checks.push({
        name: "api_reachable",
        ok: true,
        message: `GitHub API reachable as App "${data.name ?? data.slug ?? "unknown"}".`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checks.push({
        name: "api_reachable",
        ok: false,
        message,
      });
      return { ok: false, checks, mode };
    }
  } else {
    try {
      const resp = await fetchWithAuth(`${GH_API_BASE}/user`, token, fetchImpl, timeoutMs);
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`GitHub user fetch failed (${resp.status}): ${body}`);
      }
      const data = (await resp.json()) as { login: string; name?: string };
      const scopesHeader = resp.headers.get("X-OAuth-Scopes") ?? "";
      const scopes = scopesHeader.split(",").map((s) => s.trim()).filter(Boolean);
      checks.push({
        name: "api_reachable",
        ok: true,
        message: `GitHub API reachable as ${data.name ?? data.login} (@${data.login}).`,
      });
      checks.push({
        name: "token_scopes",
        ok: scopes.length > 0,
        message:
          scopes.length > 0
            ? `Token scopes: ${scopes.join(", ")}`
            : "No X-OAuth-Scopes header returned (token may be a fine-grained PAT or scope header is hidden).",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checks.push({
        name: "api_reachable",
        ok: false,
        message,
      });
      return { ok: false, checks, mode };
    }
  }

  try {
    const rateToken = mode === "app" ? signAppJwt(appId, privateKey) : token;
    const resp = await fetchWithAuth(`${GH_API_BASE}/rate_limit`, rateToken, fetchImpl, timeoutMs);
    if (resp.ok) {
      const data = (await resp.json()) as {
        resources?: { core?: { remaining?: number; limit?: number } };
      };
      const core = data.resources?.core;
      checks.push({
        name: "rate_limit",
        ok: true,
        message: core
          ? `Core API rate limit: ${core.remaining ?? "?"}/${core.limit ?? "?"} remaining.`
          : "Rate limit endpoint reachable.",
      });
    } else {
      checks.push({
        name: "rate_limit",
        ok: true,
        message: `Rate limit endpoint returned ${resp.status}; API auth is working.`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push({
      name: "rate_limit",
      ok: false,
      message,
    });
  }

  return { ok: checks.every((c) => c.ok), checks, mode };
}

function formatReport(result: GitHubVerifyResult): void {
  console.log("Ishu GitHub connectivity verification\n");
  for (const check of result.checks) {
    const icon = check.ok ? "✅" : "❌";
    console.log(`${icon} ${check.name}: ${check.message}`);
  }
  console.log("");
  if (result.ok) {
    console.log("All GitHub checks passed. GitHub tools should work in Slack threads.");
  } else {
    console.log("Some GitHub checks failed. Fix the issues above before using GitHub tools.");
  }
}

async function main(): Promise<void> {
  const result = await verifyGitHub();
  formatReport(result);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
