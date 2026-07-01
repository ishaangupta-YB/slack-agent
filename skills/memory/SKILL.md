# memory

The memory tool keeps a rolling, searchable log of past interactions across all Slack threads.

Two modes:
- `memory({ mode: "recent", limit: 20 })` returns the most recent interactions.
- `memory({ mode: "search", query: "gradio PR" })` searches past interactions for a query.

Use memory when a user refers to something from earlier, asks for a status update, or when context from another thread would help.
