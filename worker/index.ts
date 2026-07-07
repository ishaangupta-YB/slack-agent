/**
 * Cloudflare Worker wrapper that runs the Ishu container.
 *
 * Ishu is a long-lived Slack Socket Mode process, not a request/response
 * Worker. This thin wrapper:
 *   1. Declares a single always-on container instance (see wrangler.jsonc,
 *      max_instances = 1 — Socket Mode requires exactly one connection).
 *   2. Keeps it alive via a cron trigger, so the outbound Slack WebSocket
 *      never idles out even though no inbound HTTP traffic reaches it.
 *   3. Optionally exposes the container's artifact/health server (port 3001)
 *      on the Worker's public URL, so Slack artifact links resolve.
 *
 * Secrets are set on the Worker (`wrangler secret put ...`) and passed into the
 * container as environment variables below.
 */

import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  ISHU_CONTAINER: DurableObjectNamespace<IshuContainer>;
  // Secrets (wrangler secret put ...). Missing ones are simply not forwarded.
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
  SLACK_USER_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_MODEL?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  R2_PREFIX?: string;
  GITHUB_TOKEN?: string;
  BUCKET_PUBLIC_URL?: string;
}

// Stable id so we always address the same single container instance.
const INSTANCE = "ishu";

export class IshuContainer extends Container<Env> {
  // The image's bucket/artifact + health server listens here.
  defaultPort = 3001;
  // Keep the process alive for a long idle window; the cron trigger re-pokes it
  // well before this, so in practice it never sleeps.
  sleepAfter = "6h";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Forward only the vars that are actually set, so unset optional
    // integrations stay unset inside the container.
    const vars: Record<string, string> = {
      NODE_ENV: "production",
      BUCKET_HTTP_HOST: "0.0.0.0",
      BUCKET_HTTP_PORT: "3001",
      CLOUDFLARE_MODEL: env.CLOUDFLARE_MODEL ?? "@cf/moonshotai/kimi-k2.7-code",
    };
    const passthrough: (keyof Env)[] = [
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "SLACK_USER_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
      "R2_PREFIX",
      "GITHUB_TOKEN",
      "BUCKET_PUBLIC_URL",
    ];
    for (const key of passthrough) {
      const value = env[key];
      if (typeof value === "string" && value.length > 0) {
        vars[key] = value;
      }
    }
    this.envVars = vars;
  }

  override onStart() {
    console.log("Ishu container started");
  }

  override onStop() {
    console.log("Ishu container stopped");
  }

  override onError(error: unknown) {
    console.error("Ishu container error:", error);
  }
}

export default {
  // Expose the container's artifact/health server on the Worker URL. Socket
  // Mode itself needs no inbound requests, so this is purely for artifact links.
  async fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.ISHU_CONTAINER, INSTANCE).fetch(request);
  },

  // Keep-alive: ensure the single always-on instance is running. start() is
  // idempotent, so this is a no-op when it is already up and a recovery when
  // it is not.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await getContainer(env.ISHU_CONTAINER, INSTANCE).start();
  },
};
