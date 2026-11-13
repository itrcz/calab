---
title: MCP server for LLM clients
description: https://app.calab.io/mcp (the same as POST /api/mcp) — a Model Context Protocol endpoint — personal sign-in through OAuth without a bot, or a bot token — nineteen tools, the «via MCP» mark, JSON-RPC examples, errors, limits and what is not supported.
order: 21
---

## What it is

`https://app.calab.io/mcp` (the same server as `POST /api/mcp`) is a [Model Context Protocol](https://modelcontextprotocol.io) server built into the Calab API. An LLM client (Claude Code, Codex, Cursor, Claude Desktop) connects to it **with your own account through OAuth** — no bot, no token in the config — or with a bot token, to find tasks and rooms, read them, create and edit tasks, assign people, comment, get task files, write to rooms and people, keep the calendar, tick checklists, link tasks and vote on approvals.

Every tool calls the ordinary REST routes of the server **with the same identity**, so a tool gives nothing beyond what you (or the bot) already have in the app: roles, route table, limits and moderation apply exactly as to the bot's own REST call. A refusal is final: the tool returns it as an error and does not look for a way around.

## Connecting with your account (OAuth)

This is how a developer's agent connects: the server URL, then a sign-in in the browser. The URL and ready commands for your server are in the app: Settings → MCP.

1. Add the server to the client. Claude Code:

   ```sh
   claude mcp add --transport http calab https://app.calab.io/mcp
   ```

   Or in `.mcp.json` / `~/.claude.json`:

   ```json
   { "mcpServers": { "calab": { "type": "http", "url": "https://app.calab.io/mcp" } } }
   ```

   Claude Desktop and claude.ai: Settings → Connectors → Add custom connector, URL `https://app.calab.io/mcp`. Codex: `codex mcp add calab --url https://app.calab.io/mcp`, then `codex mcp login calab`. Cursor: `~/.cursor/mcp.json` — `{"mcpServers":{"calab":{"url":"https://app.calab.io/mcp"}}}`.

2. Start the sign-in in the client (Claude Code: `/mcp` → `calab` → Authenticate). The browser opens “Connect an MCP client”: sign in to Calab if needed, check the app's name and where the code goes back (“a program on this computer”) and press “Allow”.
3. Done: the client has a token and refreshes it itself. The connection is listed in Settings → Sessions as “MCP · <client name>”, where you disconnect it.

The agent works **as you**: the author of tasks and comments, the assignee, `me` in the tools is you; rights are your roles. Everything done through MCP is marked “(via MCP)” after your name, in comments and in the task history.

- The token of an MCP connection works only on `/mcp` and `/api/mcp`: plain REST, the gateway and the app's session refresh refuse it (`403 MCP_TOKEN`).
- Only a personal account with a password can connect; a workspace with enforced SSO does not admit such a connection.
- The client registers itself (RFC 7591); the code goes back to `http://localhost` / `127.0.0.1` / `[::1]` (any port) or to the web connectors' callbacks `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` (the exact list is `MCP_OAUTH_REDIRECT_URIS`).
- Metadata for clients: `/.well-known/oauth-protected-resource/mcp` (for `/mcp`), `/.well-known/oauth-protected-resource/api/mcp` (for `/api/mcp`) and `/.well-known/oauth-authorization-server`; the endpoint's `401` carries `WWW-Authenticate` pointing to the metadata of the address used. An authorization code is exchanged only for the address (`resource`) it was issued for; the token works on both.
- `https://app.calab.io/mcp` opened in a browser leads to Settings → MCP.

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
| `find` | `q` (words; for rooms, boards and people a name part, empty = all), `kind` (`tasks` · `messages` · `rooms` · `boards` · `people`; default all, `people` only with `q`), `workspace` (id; default all the bot's workspaces), `limit` (per kind, 1–20, default 10) | Ids for the other tools: `tasks`, `messages` (including task comments), `rooms`, `boards`, `people` (id, name, nickname); nothing found — `{"found": 0}`. `q` is required for `tasks` and `messages` |
| `read` | `task` (id or key `ABC-12`) **or** `room` (id; a task's comments are in its room; `members: true` — who can see the room) **or** `person` (`me`, an id, a name or a nickname; `workspace` — where to look), `limit` (messages, 1–50, default 20), `before` (message id: older history), `full` (`true` — the whole API object), `comments` (with a task: its latest comments, 1–50) | A task with its board's statuses, subtasks, assignees and lead, labels, checklists, files (`files`: id, name, type, size), Git links (`git`: merge requests and branches, commits as a count), releases, approval (`approval`: its state, `required`, the votes, `pending` — whose decision is awaited) and links (`links`), with `comments` — `recent_comments`; messages carry `files` with ids; or a room and its recent messages (oldest first, `more` — there is older history; with `members` — `members`, up to 100); or a person's profile |
| `create_task` | **`board`** (id or key), **`title`** (1–200 characters), `description` (markdown), `status` (name or id; default the board's) | `id`, `key`, `room`, `status` |
| `comment_task` | **`task`** (id or key), `text` (markdown), `files` (file ids from `upload_attachment`; with them `text` may be empty) | `id`, `room` of the new comment, `files`. One bad id and nothing is posted |
| `set_task_status` | **`task`**, **`status`** (a name or id of a status of **that task's board**) | `key`, `status`. An unknown status is an error listing the board's statuses |
| `send_message` | **`room`** (id; a DM works too) **or** `to` (a person: an id, a name or a nickname — writes to their DM; `workspace` — where to look), `text` (markdown, up to 4000 characters), `reply_to` (message id), `files` (file ids from `upload_attachment`) | `id`, `room`, `files`. One bad id and nothing is sent |
| `list_tasks` | `board` (id or key `DEV`) or `workspace` (id), `q` (words or a key), `status` (names, comma-separated; needs `board`), `assignee` (`me`, an id, a name or a nickname), `labels` (names; needs `board`), `state` (`open` by default · `done` · `all`), `sort` (`updated` by default · `created` · `key` · `priority` · `due`, `-` for descending), `mine` (`true` without a board — my open tasks everywhere), `limit` (1–50, default 20), `cursor` | `tasks` (key, title, status, priority, assignees, labels, due, updated), `next` — the next page's cursor |
| `update_task` | **`task`** (`workspace` — where to look the key up), and only the fields to change: `title`, `description`, `priority` (`none` · `low` · `medium` · `high` · `urgent`), `due` / `start` (`YYYY-MM-DD`, empty — clear), `estimate` (0 — none), `parent` (a task, empty — clear), `labels` (the whole set by name) or `add_labels` / `remove_labels` | The task after the change |
| `assign` | **`task`**, **`users`** (`me`, ids, names or nicknames), `mode` (`add` by default · `remove` · `set`), `lead` (the lead among the assignees; by default the current one, else the first) | `key`, `assignees`, `lead`. An ambiguous name is an error listing the matches |
| `get_task_attachment` | **`task`**, **`file`** (an id from `read` or the exact name), `comment` (the comment's message id; by default the task's files, then those of its latest 100 comments) | The file's description with `download_url`, a signed URL valid for 10 minutes (see [Attachments](#attachments)); text up to 256 KiB and images up to 3 MiB (larger: the 1024 px preview) also inline. Rights are those of a download in the app; a file of another task is an error |
| `upload_attachment` | **`task`** (id or key) **or** **`room`** (id), `workspace` | `upload_url` (single use, 10 minutes), the `curl` command, `max_size`. Attach the uploaded file with `files` of `comment_task` / `send_message` |
| `edit_message` | **`message`** (id), **`text`** (markdown) | `id`, `room`, `edited`. Only your own message |
| `calendar` | `action` (`list` by default · `event` · `freebusy` · `suggest`), `from` / `to` (ISO 8601: with an offset, without one — in your timezone; a date is the whole day; by default from the start of today for 7 days, `freebusy` — for a day), `workspace` (default all), `all` (`list`: every meeting I can see, not only mine), `event` (a meeting id for `event`), `users` (`freebusy` / `suggest`: `me`, ids, names or nicknames, up to 20), `duration` (`suggest`: minutes, default 30), `work_hours` (`suggest`: only within the common working hours, default `true`), `room` (`suggest`: a voice room that must be free too), `limit` (`list`: 1–100, default 50) | `tz` — your timezone (from the profile, else UTC), every time is in it (`when`: `2026-11-16 10:00–10:45`). `list` — my meetings (`id`, `title`, `when`, `room`, `organizer`, `me` — my answer, `repeat`, a series' `occurrence`, `people`, `comments`); `event` — a meeting with its attendees and latest comments; `freebusy` — everyone's busy time and working hours; `suggest` — up to 10 earliest common windows |
| `event` | **`action`** (`create` · `update` · `cancel` · `comment`), `event` (meeting id, except `create`), `title`, `description`, `start` / `end` (ISO 8601) or `duration` (minutes, default 30), `all_day`, `users` (attendees; in `update` with `mode`: `add` by default · `remove` · `set`), `room` (a voice room: id or name; in `update` `none` — no room), `repeat` (`none` · `daily` · `weekly` · `biweekly` · `monthly` · `workdays`), `occurrence` and `scope` (`this` by default · `following` · `all`) — one meeting of a series, `text` (a comment), `workspace` (`create`, when you are in several) | The meeting after the change; `update` with `start` alone keeps the length. `cancel` — what was cancelled, `comment` — the comment's id |
| `inbox` | `workspace` (mentions of one workspace), `limit` (1–50, default 20), `before` (message id: older mentions) | `dms` — unread direct messages (`room`, `from`, `unread`, `last`), `mentions` — messages mentioning me, newest first (`more` — there are older ones) |
| `react` | **`message`** (id), **`emoji`** (e.g. `👍`), `mode` (`add` by default · `remove`) | `message`, `emoji`, `reacted` |
| `checklist` | **`task`**, `action` (`check` by default · `uncheck` · `toggle` · `add`), `item` (the item: its number as in `read`, its text or id; in `add` — the new item's text), `items` (`add`: several), `checklist` (a checklist's title or id; `add` — the first one by default, created when there is none) | The checklist after the change (`[x]` / `[ ]`), `done` — "done/total" of the task |
| `link_tasks` | **`task`**, **`related`** (another task of the same workspace: id or key), `kind` (`relates` by default · `blocks` · `blocked_by` · `duplicates` — "`task` blocks / is blocked by / relates to / duplicates `related`"), `mode` (`add` by default · `remove`) | `key`, the task's `links` |
| `approve` | **`task`**, **`decision`** (`approve` · `reject` · `withdraw` — take the vote back), `reason` (required for `reject`, up to 500 characters) | `key`, `approval` after the vote. Only an approver of the task votes; the vote is yours |

Answers are compact: empty fields are left out. The usual flow: `find` → ids → `read` → an action.

## Attachments

Files never pass through the model's context: the agent (Codex, Claude Code) downloads and uploads them **in its shell** with `curl`, by short-lived signed URLs a tool returns. A URL works for **10 minutes**, is bound to the tool's caller (the bot and its token, the MCP connection, on behalf) and to one file (download) or one target (upload). No token header is needed: on every request the server checks again that the connection is alive and that the caller may still read the file (as `GET /api/files/{id}` does). These are not Disk public links.

Supported: text (TXT, CSV, TSV, JSON, XML, MD, SQL, YAML, logs, code), XLSX, DOCX, PPTX, PDF, ZIP, OGG/Opus, MP3, WAV, M4A — up to 3 MiB (3 145 728 bytes); PNG, JPEG, WEBP, GIF — up to 5 MiB (5 242 880 bytes). A file exactly at the limit passes. OOXML stored as `application/zip` gets its proper MIME by extension. Video and other types: `unsupported_file_type`. Without a URL the agent still gets what fits the chat: an image of another type (HEIC and the like) or over the limit comes as its 1024 px preview, a text file over the limit as its first 256 KiB, with `no_download` (the reason) instead of `download_url`.

`get_task_attachment` answers with JSON: `file`, `name`, `mime`, `size`, `sha256`, `task`, `comment` (a comment's file only), `download_url`, `expires_in` (600).

```sh
curl -fsSL -o "report.xlsx" "$DOWNLOAD_URL"
shasum -a 256 report.xlsx   # equals sha256
```

Upload: `upload_attachment {"task":"WEB-12"}` (or `room`) → `curl -fsS -F file=@./report.xlsx "$UPLOAD_URL"` → `{"file","name","mime","size","sha256"}` → `comment_task {"task":"WEB-12","text":"Weekly report","files":["<file>"]}`. An upload URL works once, also when the upload fails (call `upload_attachment` again), the file is up to 3 MiB; only your own unattached upload can be attached.

Errors: the tool answers `{"error":"file_too_large","size":…,"limit":…}` or `{"error":"unsupported_file_type","supported":[…]}` with `isError`; a URL answers `404` (bad, changed or expired URL, or access lost), `401` (bot token replaced, MCP connection ended), `403` (no right, on behalf off), `413` `FILE_TOO_LARGE` with `reason: file_too_large`, `used`, `limit` (upload over 3 MiB), `410` `reason: upload_url_used` (reused upload URL).

## Calendar, people, messages and approvals

### Calendar

Times in the arguments are ISO 8601: `2026-11-16T10:00+03:00` or `…Z`; without an offset (`2026-11-16T10:00`, `2026-11-16`) — in your profile's timezone. Answers are in it too, `tz` names it once. Rights are those of the app's calendar: you see the meetings of your rooms and those you organize or attend; the organizer, or whoever the roles allow, changes them.

```json
{"name":"calendar","arguments":{"from":"2026-11-16","to":"2026-11-20"}}
{"name":"calendar","arguments":{"action":"suggest","users":["me","Anna"],"duration":45,"from":"2026-11-16"}}
{"name":"event","arguments":{"action":"create","title":"Sync","start":"2026-11-16T10:00","duration":45,"users":["Anna","bob"],"room":"Meeting room"}}
{"name":"event","arguments":{"action":"update","event":"<id>","start":"2026-11-16T15:00"}}
```

For a repeating meeting `calendar` gives each occurrence's `occurrence`: pass it to `event` with `scope` `this` (that one), `following` (that one and the next) or leave `occurrence` out — the whole series.

### People

`read` with `person` — a profile: the workspace role and roles, status, timezone and local time, nickname, open tasks. `read` with `room` and `members: true` — who can see the room (by the same rights as the app; a DM — its two people). All members of a workspace — `find` with `kind: "people"` and `workspace`.

```json
{"name":"read","arguments":{"person":"Anna"}}
{"name":"read","arguments":{"room":"<id>","members":true,"limit":1}}
```

### Messages

`send_message` with `to` writes to a person's DM (opened if there was none). `inbox` — what was written to me: unread DMs and mentions. `react` adds and removes a reaction.

```json
{"name":"send_message","arguments":{"to":"Anna","text":"Please look at DEV-12"}}
{"name":"inbox","arguments":{}}
{"name":"react","arguments":{"message":"<id>","emoji":"👍"}}
```

### Checklists, links and approvals of tasks

`read` of a task shows `approval`: its state, how many approvals are needed (`required`), each approver's vote and `pending` — whose decision is awaited; and `links` — the relations to other tasks.

```json
{"name":"checklist","arguments":{"task":"DEV-12","item":"Tests"}}
{"name":"checklist","arguments":{"task":"DEV-12","action":"add","items":["Changelog","Announcement"]}}
{"name":"link_tasks","arguments":{"task":"DEV-12","related":"DEV-9","kind":"blocked_by"}}
{"name":"approve","arguments":{"task":"DEV-12","decision":"reject","reason":"No tests for the migration"}}
```

### What a bot cannot do without "on behalf"

- **Vote on an approval.** The vote is a person's decision: `approve` by the bot itself answers `403 BOT_NOT_ALLOWED` with a hint. Through OAuth or with `Calab-On-Behalf` the vote counts as the person's it acts for.
- **Attend meetings.** A bot only organizes them; `calendar` without `all` for a bot — the meetings it created. In `freebusy` a bot sees only busy time, without the titles of external events.
- A bot's `inbox` and `me` are its own: the bot's own direct messages and mentions.

The other way round: meeting comments (`event` with `comment`) are closed to a bot **on behalf** (`403 ON_BEHALF_ROUTE`); through OAuth and to the bot itself they are open.

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

Expected: `initialize` returns `serverInfo.name = "calab"`, `tools/list` nineteen tools, `find` a `boards` list (or `{"found":0}` if the bot sees no boards). Check the refusals: without the header — `401`; with a person's token — `403`.

To connect an MCP client (MCP Inspector, Claude Desktop or another one), choose the Streamable HTTP transport (the setting is named differently in different clients), set the URL `https://<host>/api/mcp` and the header `Authorization: Bearer <bot token>`; after connecting, the client must show nineteen tools. Where exactly a client keeps its settings is in that client's own documentation.
