---
title: MCP server for LLM clients
description: POST /api/mcp — a Model Context Protocol endpoint on a bot token — nine tools, acting on behalf of a person, the «via MCP» mark, JSON-RPC examples, errors, limits and what is not supported.
order: 21
---

## What it is

`POST /api/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server built into the Calab API. An LLM client (an assistant, an IDE agent) needs only a URL and a bot token to find tasks and rooms, read them, create tasks, comment and write to rooms.

Every tool calls the ordinary REST routes of the server with the **same token**, so a tool gives the bot nothing its token does not already give: roles, route table, limits and moderation apply exactly as to the bot's own REST call. A refusal is final: the tool returns it as an error and does not look for a way around.

## Connecting

1. Create a bot and copy its token ([Quickstart](./quickstart), [Token and permissions](./auth)): “Workspace settings → Bots”, the token is shown once.
2. Give the bot a role in the workspaces it should see ([Permissions](./auth#permissions)).
3. Point the client at `https://<your Calab host>/api/mcp` and send the header `Authorization: Bearer calab_bot_…`. The token goes only into the header, never into the URL.

### On behalf of a person

For an agent that works on tasks **as you** (you are the author of its comments, the assignee, the creator of its tasks), create your own bot, turn on “Act on my behalf” ([Token and permissions](./auth#on-behalf-of-the-owner)) and add a second header to the client, `Calab-On-Behalf: owner`. For a member who allowed the bot to act for them, `Calab-On-Behalf: <user id>` ([On behalf of a member](./auth#on-behalf-of-a-member)). Each tool call is checked on behalf exactly like a REST request: what is closed on behalf in REST is closed here too; a switch turned off or a consent revoked gives `403` at once.

On behalf of a member only the tasks and boards **of the workspace where they consented** work: pass task or board ids (`board` + `workspace`); a task key lookup, `find` and `list_tasks` with `mine` span all workspaces and are closed on behalf of a member (`403 ON_BEHALF_ROUTE`). A board key such as `DEV` and a task key such as `DEV-12` are unique only within a workspace: if several of your workspaces have one, the tool returns an error listing them — give `workspace` or the id.

Actions through MCP are marked: messages and task journal entries carry `via` = `"mcp"`, and the app shows “(via bot X · MCP)” after the name, or “(via MCP)” for the bot itself. `me` in the tools is you (or the bot itself without the header).

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
| HTTP `401` | `UNAUTHENTICATED` | no or wrong token |
| HTTP `403` | `FORBIDDEN` | the token is a person's or a session; with `Calab-On-Behalf` — the on-behalf reason (`ON_BEHALF_DISABLED`, `ON_BEHALF_NO_CONSENT`…, see [Token and permissions](./auth#on-behalf-of-the-owner)) |
| HTTP `405` | `Allow: POST` | `GET` / `DELETE` — there is no stream and no sessions |
| HTTP `400` | JSON-RPC `-32700` / `-32600` | invalid JSON; not a JSON-RPC 2.0 request; a batch (array) |
| HTTP `413` | JSON-RPC `-32600` | body over 1 MiB |
| JSON-RPC `-32601` | `method not found` | an unknown method |
| JSON-RPC `-32602` | `unknown tool …`, `invalid params` | a wrong tool name or `params` |
| result with `isError` | `404 NOT_FOUND`, `403`, `409 PLAN_LIMIT`, `429`, validation | the REST call inside the tool was refused |

## Limits

A tool call costs one request of the bot's limit plus its REST calls ([Errors and limits](./errors-limits#limits): 30 requests per second, 20 messages per minute). `find` without `workspace` walks all the bot's workspaces (rooms and boards), so for a bot in many workspaces name the `workspace`. When the limit is hit, the tool returns `429` as an error with `isError`.

## Not supported

- Streaming: no SSE answers, no `GET` stream, no resumption.
- Sessions (`Mcp-Session-Id`) — every request stands alone.
- JSON-RPC batches, MCP resources and prompts, `structuredContent`.
- OAuth authorization of MCP: the bot token is set statically in the client.

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
