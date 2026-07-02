import { AsyncLocalStorage } from "node:async_hooks";
import type { AccessTier } from "./auth/tiers.js";

export interface ToolContext {
  /** Slack action_token supplied in AI/message events for Real-Time Search. */
  actionToken?: string;
  /** Slack channel where the current message originated. */
  channelId?: string;
  /** Internal thread key for the current conversation. */
  threadKey?: string;
  /** Slack user ID that sent the current message. */
  userId?: string;
  /** Slack user email for the current message (used for tier / GitHub mapping). */
  userEmail?: string;
  /** Current session filename (used to link to the agent trace artifact). */
  sessionFilename?: string;
  /** Access tier of the current user. */
  tier?: AccessTier;
}

const toolContextStore = new AsyncLocalStorage<ToolContext>();

export function getToolContext(): ToolContext {
  return toolContextStore.getStore() ?? {};
}

export function runWithToolContext<T>(context: ToolContext, fn: () => Promise<T>): Promise<T> {
  return toolContextStore.run(context, fn);
}
