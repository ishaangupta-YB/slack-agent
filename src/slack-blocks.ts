import type { KnownBlock } from "@slack/types";

const MAX_RESPONSE_CHARS = 2900;
const MAX_FALLBACK_CHARS = 39900;

export function buildResponseBlocks(
  text: string,
  responseUrl: string,
  sessionUrl: string,
): KnownBlock[] {
  const displayText = text.trim() || "_No response generated._";
  const truncated = displayText.length > MAX_RESPONSE_CHARS
    ? displayText.slice(0, MAX_RESPONSE_CHARS) + "\n\n_(truncated — see full response below)_"
    : displayText;

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: truncated },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: ":page_facing_up: Response markdown", emoji: true },
          url: responseUrl,
          action_id: "open_response_markdown",
        },
        {
          type: "button",
          text: { type: "plain_text", text: ":spiral_note_pad: Session trace", emoji: true },
          url: sessionUrl,
          action_id: "open_session_trace",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "👍 Helpful", emoji: true },
          action_id: "feedback_helpful",
          value: "helpful",
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "👎 Not helpful", emoji: true },
          action_id: "feedback_not_helpful",
          value: "not_helpful",
        },
      ],
    },
  ] as unknown as KnownBlock[];
}

export function prepareSlackMessage(
  text: string,
  responseUrl: string,
  sessionUrl: string,
): { text: string; blocks: KnownBlock[] } {
  const blocks = buildResponseBlocks(text, responseUrl, sessionUrl);
  let fallbackText = text.trim() || "_No response generated._";
  if (fallbackText.length > MAX_FALLBACK_CHARS) {
    fallbackText = fallbackText.slice(0, MAX_FALLBACK_CHARS) + "\n\n_(truncated — see full response in thread)_";
  }
  return { text: fallbackText, blocks };
}
