import type { KnownBlock } from "@slack/types";

const MAX_RESPONSE_CHARS = 2900;

export function buildResponseBlocks(
  text: string,
  responseUrl: string,
  sessionUrl: string,
): KnownBlock[] {
  const truncated = text.length > MAX_RESPONSE_CHARS
    ? text.slice(0, MAX_RESPONSE_CHARS) + "\n\n_(truncated — see full response below)_"
    : text;

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
      ],
    },
  ] as unknown as KnownBlock[];
}
