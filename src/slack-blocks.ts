import type { KnownBlock } from "@slack/types";

const MAX_RESPONSE_CHARS = 2900;
const MAX_FALLBACK_CHARS = 39900;

function isValidButtonUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

interface ButtonElement {
  type: "button";
  text: { type: "plain_text"; text: string; emoji?: boolean };
  action_id: string;
  url?: string;
  value?: string;
  style?: "primary" | "danger";
}

export function buildResponseBlocks(
  text: string,
  responseUrl: string,
  sessionUrl: string,
  traceUrl: string,
  threadKey: string,
): KnownBlock[] {
  const displayText = text.trim() || "_No response generated._";
  const truncated = displayText.length > MAX_RESPONSE_CHARS
    ? displayText.slice(0, MAX_RESPONSE_CHARS) + "\n\n_(truncated — see full response below)_"
    : displayText;

  const artifactButtons = ([
    {
      type: "button" as const,
      text: { type: "plain_text" as const, text: ":page_facing_up: Response markdown", emoji: true },
      url: responseUrl,
      action_id: "open_response_markdown",
    },
    {
      type: "button" as const,
      text: { type: "plain_text" as const, text: ":spiral_note_pad: Session trace", emoji: true },
      url: sessionUrl,
      action_id: "open_session_trace",
    },
    {
      type: "button" as const,
      text: { type: "plain_text" as const, text: ":magnifying_glass_tilted_left: View trace", emoji: true },
      url: traceUrl,
      action_id: "open_trace_viewer",
    },
  ] as ButtonElement[]).filter((b) => isValidButtonUrl(b.url ?? ""));

  const actionElements: ButtonElement[] = [
    ...artifactButtons,
    {
      type: "button",
      text: { type: "plain_text", text: "👍 Helpful", emoji: true },
      action_id: "feedback_helpful",
      value: threadKey,
      style: "primary",
    },
    {
      type: "button",
      text: { type: "plain_text", text: "👎 Not helpful", emoji: true },
      action_id: "feedback_not_helpful",
      value: threadKey,
    },
  ];

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: truncated },
    },
    {
      type: "actions",
      elements: actionElements,
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🔄 Start over", emoji: true },
          action_id: "reset_thread",
          value: threadKey,
        },
      ],
    },
  ] as unknown as KnownBlock[];
}

export function prepareSlackMessage(
  text: string,
  responseUrl: string,
  sessionUrl: string,
  traceUrl: string,
  threadKey: string,
): { text: string; blocks: KnownBlock[] } {
  const blocks = buildResponseBlocks(text, responseUrl, sessionUrl, traceUrl, threadKey);
  let fallbackText = text.trim() || "_No response generated._";
  if (fallbackText.length > MAX_FALLBACK_CHARS) {
    fallbackText = fallbackText.slice(0, MAX_FALLBACK_CHARS) + "\n\n_(truncated — see full response in thread)_";
  }
  return { text: fallbackText, blocks };
}
