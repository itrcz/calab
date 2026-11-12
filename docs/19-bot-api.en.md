# 19 — Bot API (moved)

The documentation for bot developers moved to the website (ADR-0099): the “Bots and integration API” section —
`/en/docs/bots` (Russian: `/ru/docs/bots`), the route reference — `/en/docs/reference/routes`.

The sources live in the repository; edit them, not this file:

- `apps/landing/src/content/docs/en/bots/*.md` and `apps/landing/src/content/docs/ru/bots/*.md` — the chapters (quickstart,
  token and permissions, REST by group, gateway, commands and buttons, webhooks, task notifications, SDK, errors and
  limits, changelog);
- `apps/landing/src/content/docs/{ru,en}/reference/*.md` — routes, gateway events, error codes, limits, tokens, version;
- `apps/landing/src/content/docs/nav.ts` — the navigation.

For LLM clients there is an MCP server, `POST /api/mcp` (short address `https://app.calab.io/mcp`, CBF-183), on the same bot token (ADR-0114; a person connects without a bot through OAuth — ADR-0158): the chapter `.../bots/mcp.md`
(`/en/docs/bots/mcp`); the Node.js SDK is `.../bots/sdk.md`; to check MCP use `tools/mcp-smoke.sh` and `TESTING.md`.

The source of truth is still the code: `apps/server/internal/app/botroutes.go` (the bot decision for every route) and
`proto/calaba/v1/*.proto` (fields and events).
