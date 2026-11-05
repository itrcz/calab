---
title: MCP server for LLM clients
description: POST /api/mcp — a Model Context Protocol endpoint — personal sign-in through OAuth without a bot, or a bot token — nine tools, the «via MCP» mark, JSON-RPC examples, errors, limits and what is not supported.
order: 21
---

## What it is

`POST /api/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server built into the Calab API. An LLM client (Claude Code, Codex, Cursor, Claude Desktop) connects to it **with your own account through OAuth** — no bot, no token in the config — or with a bot token, to find tasks and rooms, read them, create and edit tasks, assign people, comment and write to rooms.

Every tool calls the ordinary REST routes of the server **with the same identity**, so a tool gives nothing beyond what you (or the bot) already have in the app: roles, route table, limits and moderation apply exactly as to the bot's own REST call. A refusal is final: the tool returns it as an error and does not look for a way around.

## Connecting with your account (OAuth)

This is how a developer's agent connects: the server URL, then a sign-in in the browser.

1. Add the server to the client. Claude Code:

   ```sh
   claude mcp add --transport http calab https://app.calab.io/api/mcp
   ```

   Or in `.mcp.json` / `~/.claude.json`:

   ```json
   { "mcpServers": { "calab": { "type": "http", "url": "https://app.calab.io/api/mcp" } } }
   ```

2. Start the sign-in in the client (Claude Code: `/mcp` → `calab` → Authenticate). The browser opens “Connect an MCP client”: sign in to Calab if needed, check the app's name and where the code goes back (“a program on this computer”) and press “Allow”.
3. Done: the client has a token and refreshes it itself. The connection is listed in Settings → Sessions as “MCP · <client name>”, where you disconnect it.

The agent works **as you**: the author of tasks and comments, the assignee, `me` in the tools is you; rights are your roles. Everything done through MCP is marked “(via MCP)” after your name, in comments and in the task history.

- The token of an MCP connection works only on `/api/mcp`: plain REST, the gateway and the app's session refresh refuse it (`403 MCP_TOKEN`).
- Only a personal account with a password can connect; a workspace with enforced SSO does not admit such a connection.
- The client registers itself (RFC 7591); the code goes back to `http://localhost` / `127.0.0.1` / `[::1]` (any port) or to the web connectors' callbacks `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` (the exact list is `MCP_OAUTH_REDIRECT_URIS`).
- Metadata for clients: `/.well-known/oauth-protected-resource/api/mcp` and `/.well-known/oauth-authorization-server`; the endpoint's `401` carries `WWW-Authenticate` pointing to them.

## Connecting through a bot

For automations without a person (CI, integrations), a bot token:

1. Create a bot and copy its token ([Quickstart](./quickstart), [Token and permissions](./auth)): “Workspace settings → Bots”, the token is shown once.
2. Give the bot a role in the workspaces it should see ([Permissions](./auth#permissions)).
3. Point the client at `https://<your Calab host>/api/mcp` and send the header `Authorization: Bearer calab_bot_…`. The token goes only into the header, never into the URL.

### A bot on behalf of a person

When it has to be a bot but the actions must be yours (you are the author of its comments, the assignee, the creator of its tasks), create your own bot, turn on “Act on my behalf” ([Token and permissions](./auth#on-behalf-of-the-owner)) and add a second header to the client, `Calab-On-Behalf: owner`. For a member who allowed the bot to act for them, `Calab-On-Behalf: <user id>` ([On behalf of a member](./auth#on-behalf-of-a-member)). Each tool call is checked on behalf exactly like a REST request: what is closed on behalf in REST is closed here too; a switch turned off or a consent revoked gives `403` at once.

On behalf of a member only the tasks and boards **of the workspace where they consented** work: pass task or board ids (`board` + `workspace`); a task key lookup, `find` and `list_tasks` with `mine` span all workspaces and are closed on behalf of a member (`403 ON_BEHALF_ROUTE`). A board key such as `DEV` and a task key such as `DEV-12` are unique only within a workspace: if several of your workspaces have one, the tool returns an error listing them — give `workspace` or the id.

Actions through MCP are marked: messages and task journal entries carry `via` = `"mcp"`, and the app shows “(via MCP)” after the name for an OAuth connection and for the bot itself, “(via bot X · MCP)” for a person through their bot. `me` in the tools is you (or the bot itself without the header).

```json
{
  "mcpServers": {
    "calab": {
      "type": "http",
      "url": "https://app.calab.io/api/mcp",
      "headers": { "Authorization": "Bearer ${CALAB_BOT_TOKEN}", "Calab-On-Behalf": "owner" }
    }
  }
}
```

The transport is Streamable HTTP: a JSON-RPC 2.0 request in the `POST` body, one JSON object in the answer.

## Methods

| Method | What it does |
|---|---|
| `initialize` | Handshake. The answer repeats the client's `protocolVersion` if it is one of `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, otherwise the newest; capabilities — `tools` only |
| `ping` | An empty result |
| `tools/list` | The list of tools with JSON schemas |
| `tools/call` | Calls a tool: `params` = `{"name": "…", "arguments": {…}}` |
| notifications (`notifications/initialized`, …) | A request without `id`: answer `202`, no action |

## Tools

| Tool | Arguments (required in bold) | Result |
|---|---|---|
| `find` | `q` (words; for rooms and boards a name part, empty = all), `kind` (`tasks` · `messages` · `rooms` · `boards`; default all), `workspace` (id; default all the bot's workspaces), `limit` (per kind, 1–20, default 10) | Ids for the other tools: `tasks`, `messages` (including task comments), `rooms`, `boards`; nothing found — `{"found": 0}`. `q` is required for `tasks` and `messages` |
| `read` | `task` (id or key `ABC-12`) **or** `room` (id; a task's comments are in its room), `limit` (messages, 1–50, default 20), `before` (message id: older history), `full` (`true` — the whole API object) | A task with its board's statuses, subtasks, assignees and lead, labels, Git links (`git`: merge requests and branches, commits as a count) and releases; or a room and its recent messages (oldest first, `more` — there is older history) |
| `create_task` | **`board`** (id or key), **`title`** (1–200 characters), `description` (markdown), `status` (name or id; default the board's) | `id`, `key`, `room`, `status` |
| `comment_task` | **`task`** (id or key), **`text`** (markdown) | `id`, `room` of the new comment |
| `set_task_status` | **`task`**, **`status`** (a name or id of a status of **that task's board**) | `key`, `status`. An unknown status is an error listing the board's statuses |
| `send_message` | **`room`** (id; a DM works too), **`text`** (markdown, up to 4000 characters), `reply_to` (message id) | `id`, `room` |
| `list_tasks` | `board` (id or key `DEV`) or `workspace` (id), `q` (words or a key), `status` (names, comma-separated; needs `board`), `assignee` (`me`, an id, a name or a nickname), `labels` (names; needs `board`), `state` (`open` by default · `done` · `all`), `sort` (`updated` by default · `created` · `key` · `priority` · `due`, `-` for descending), `mine` (`true` without a board — my open tasks everywhere), `limit` (1–50, default 20), `cursor` | `tasks` (key, title, status, priority, assignees, labels, due, updated), `next` — the next page's cursor |
| `update_task` | **`task`** (`workspace` — where to look the key up), and only the fields to change: `title`, `description`, `priority` (`none` · `low` · `medium` · `high` · `urgent`), `due` / `start` (`YYYY-MM-DD`, empty — clear), `estimate` (0 — none), `parent` (a task, empty — clear), `labels` (the whole set by name) or `add_labels` / `remove_labels` | The task after the change |
| `assign` | **`task`**, **`users`** (`me`, ids, names or nicknames), `mode` (`add` by default · `remove` · `set`), `lead` (the lead among the assignees; by default the current one, else the first) | `key`, `assignees`, `lead`. An ambiguous name is an error listing the matches |

Answers are compact: empty fields are left out. The usual flow: `find` → ids → `read` → an action.

## Example

```sh
curl -sS https://$HOST/api/mcp \
  -H "Authorization: Bearer $CALAB_BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"set_task_status","arguments":{"task":"WEB-12","status":"Done"}}}'
```

```json
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"key\":\"WEB-12\",\"status\":\"Done\"}"}]}}
```

A tool result is a `content` array whose `text` holds a JSON string. A failed tool call is **not** a protocol error: the HTTP status is `200`, the result has `"isError": true` and the text starts with the REST status and code, for example `404 NOT_FOUND: …` — the model can fix the arguments or stop.

## Errors

| Where | What | Why |
|---|---|---|
| HTTP `401` | `UNAUTHENTICATED` + `WWW-Authenticate` | no token, a wrong one, or the connection was ended — the client starts the OAuth sign-in again |
| HTTP `403` | `FORBIDDEN` | the token of an app session (neither an MCP connection nor a bot); with `Calab-On-Behalf` — the on-behalf reason (`ON_BEHALF_DISABLED`, `ON_BEHALF_NO_CONSENT`…, see [Token and permissions](./auth#on-behalf-of-the-owner)) |
| HTTP `405` | `Allow: POST` | `GET` / `DELETE` — there is no stream and no sessions |
| HTTP `400` | JSON-RPC `-32700` / `-32600` | invalid JSON; not a JSON-RPC 2.0 request; a batch (array) |
| HTTP `413` | JSON-RPC `-32600` | body over 1 MiB |
| JSON-RPC `-32601` | `method not found` | an unknown method |
| JSON-RPC `-32602` | `unknown tool …`, `invalid params` | a wrong tool name or `params` |
| result with `isError` | `404 NOT_FOUND`, `403`, `409 PLAN_LIMIT`, `429`, validation | the REST call inside the tool was refused |

## Limits

A tool call costs one request of the bot's limit (an OAuth connection has the same limit of its own) plus its REST calls ([Errors and limits](./errors-limits#limits): 30 requests per second, 20 messages per minute). `find` without `workspace` walks all the bot's workspaces (rooms and boards), so for a bot in many workspaces name the `workspace`. When the limit is hit, the tool returns `429` as an error with `isError`.

## Not supported

- Streaming: no SSE answers, no `GET` stream, no resumption.
- Sessions (`Mcp-Session-Id`) — every request stands alone.
- JSON-RPC batches, MCP resources and prompts, `structuredContent`.
- Choosing workspaces and rights when connecting through OAuth: access is everything you can do, through the MCP tools.
- Connecting without a browser (device flow).

## Testing the endpoint

The repository has a curl script `tools/mcp-smoke.sh` (`initialize` → `tools/list` → `find`; it reads the token from `CALAB_BOT_TOKEN` and never prints it). The same by hand:

```sh
export HOST=app.example.com CALAB_BOT_TOKEN=calab_bot_…
call() { curl -sS "https://$HOST/api/mcp" -H "Authorization: Bearer $CALAB_BOT_TOKEN" -H 'Content-Type: application/json' -d "$1"; echo; }
call '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
call '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
call '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find","arguments":{"q":"","kind":"boards"}}}'
```

Expected: `initialize` returns `serverInfo.name = "calab"`, `tools/list` nine tools, `find` a `boards` list (or `{"found":0}` if the bot sees no boards). Check the refusals: without the header — `401`; with a person's token — `403`.

To connect an MCP client (MCP Inspector, Claude Desktop or another one), choose the Streamable HTTP transport (the setting is named differently in different clients), set the URL `https://<host>/api/mcp` and the header `Authorization: Bearer <bot token>`; after connecting, the client must show nine tools. Where exactly a client keeps its settings is in that client's own documentation.
