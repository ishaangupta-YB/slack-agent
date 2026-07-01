import { AsyncLocalStorage } from "node:async_hooks";

export interface ToolContext {
  /** Slack action_token supplied in AI/message events for Real-Time Search. */
  actionToken?: string;
  /** Slack channel where the current message originated. */
  channelId?: string;
  /** Internal thread key for the current conversation. */
  threadKey?: string;
  /** Slack user ID that sent the current message. */
  userId?: string;
}

const toolContextStore = new AsyncLocalStorage<ToolContext>();

export function getToolContext(): ToolContext {
  return toolContextStore.getStore() ?? {};
}

export function runWithToolContext<T>(context: ToolContext, fn: () => Promise<T>): Promise<T> {
  return toolContextStore.run(context, fn);
}
