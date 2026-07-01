# slack-search

Use this skill to search across Slack itself with the Slack Real-Time Search API (`assistant.search.context`).

## When to use

- The user asks about something that was discussed in Slack.
- You need to find a previous decision, pinned file, channel, or user.
- The user asks "what did we decide about X?" or "find the thread about Y".

## Tool: `search_slack`

Call it with a natural-language or keyword `query`. Optional parameters:

- `limit`: maximum results (1-20, default 5)
- `channel_types`: `["public_channel", "private_channel", "mpim", "im"]`
- `content_types`: `["messages", "files", "channels", "users"]` (default messages)
- `after` / `before`: UNIX timestamp filters
- `include_context_messages`: include surrounding messages
- `sort`: `"score"` or `"timestamp"`
- `sort_dir`: `"asc"` or `"desc"`

## Authentication

If the bot was invoked through a Slack AI entry point, the `action_token` from the event is used automatically with the bot token. Otherwise the `SLACK_USER_TOKEN` environment variable is used.

Required Slack scopes depend on what you search:
- Messages: `search:read.public`, `search:read.private`, `search:read.im`, `search:read.mpim`
- Files: `search:read.files`
- Users: `search:read.users`

The search returns permalinks for every result; cite them in your answer so the user can jump to the source.
