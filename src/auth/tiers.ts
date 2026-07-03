import { cfg } from "../config.js";

export type AccessTier = "basic" | "elastic" | "privileged";

const RANK: Record<AccessTier, number> = {
  basic: 1,
  elastic: 2,
  privileged: 3,
};

export function tierRank(tier: AccessTier): number {
  return RANK[tier];
}

export function isAtLeast(candidate: AccessTier, required: AccessTier): boolean {
  return tierRank(candidate) >= tierRank(required);
}

function normalizeTier(value: string): AccessTier | undefined {
  const t = value.toLowerCase().trim() as AccessTier;
  if (t === "basic" || t === "elastic" || t === "privileged") return t;
  return undefined;
}

function tierFromEnvMapping(userId: string): AccessTier | undefined {
  if (!cfg.okta.userTiers) return undefined;
  const pairs = cfg.okta.userTiers.split(",");
  for (const pair of pairs) {
    const [id, tier] = pair.split(":");
    if (id?.trim() === userId) {
      const normalized = normalizeTier(tier ?? "");
      if (normalized) return normalized;
    }
  }
  return undefined;
}

async function resolveFromOkta(email: string): Promise<AccessTier | undefined> {
  if (!cfg.okta.domain || !cfg.okta.apiToken) return undefined;
  try {
    const url = `https://${cfg.okta.domain}/api/v1/users/${encodeURIComponent(email)}/groups`;
    const res = await fetch(url, {
      headers: {
        Authorization: `SSWS ${cfg.okta.apiToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return undefined;
    const groups = (await res.json()) as Array<{ profile?: { name?: string } }>;
    const names = groups
      .map((g) => g.profile?.name?.toLowerCase() ?? "")
      .filter(Boolean);

    const matches = (groupsRaw: string[]) => {
      const configured = new Set(
        groupsRaw.map((g) => g.toLowerCase().trim()).filter(Boolean),
      );
      return names.some((n) => configured.has(n));
    };

    if (matches(cfg.okta.privilegedGroups)) return "privileged";
    if (matches(cfg.okta.elasticGroups)) return "elastic";
    return "basic";
  } catch {
    return undefined;
  }
}

/**
 * Resolve the access tier for a Slack user.
 *
 * Order of resolution:
 *   1. Explicit USER_TIERS environment mapping (for local testing / fallback).
 *   2. Okta group membership if Okta is configured and an email is provided.
 *   3. Default tier (basic).
 */
export async function resolveAccessTier(
  userId: string,
  email?: string,
): Promise<AccessTier> {
  const fromEnv = tierFromEnvMapping(userId);
  if (fromEnv) return fromEnv;

  if (email) {
    const fromOkta = await resolveFromOkta(email);
    if (fromOkta) return fromOkta;
  }

  return cfg.okta.defaultTier;
}
