---
title: Webhooks
description: The bot webhook with a sha256 signature and the board webhook with a v1 signature and task.* events — setup, format, signature checks, retries.
order: 19
---

Calab has two kinds of webhooks:

| | Bot webhook | Board webhook |
|---|---|---|
| Who sets it up | the bot itself, with its token | a person with `MANAGE_BOARD` on the board and `MANAGE_INTEGRATIONS` in the workspace |
| Plan | any | Business and above |
| What arrives | message, reaction, task, meeting, button and notification events — the same as on the gateway | every task change of one board: `task.*` |
| Body format | `BotWebhookUpdate` (protojson, lowerCamelCase) | `BoardWebhookEvent` (protojson with proto field names, snake_case) |
| Signature | `X-Calab-Signature: sha256=<hex>` | `X-Calab-Signature: v1=<hex>` with a timestamp |

## Bot webhook

Instead of the gateway — or together with it — the server can push events to the bot over HTTPS. Handy for serverless: the bot needs no long-running process.

### Setup

```sh tab="curl"
curl -s -X PUT $CALAB/api/bots/me/webhook \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"url\": \"https://bot.example.com/calab\", \"secret\": \"$WEBHOOK_SECRET\"}"
```

```js tab="JavaScript"
await bot.webhook.set('https://bot.example.com/calab', process.env.WEBHOOK_SECRET);
```

- `url` must be `https://` to a public address: private networks, `localhost` and private IP ranges are refused.
- `secret` is 16 to 256 characters. Keep it apart from the token.
- The response is `{ "webhook": { "url", "enabled", "disabledAt", "failingSince", "lastOkAt", "lastError", "pending" } }`.
- `GET /api/bots/me/webhook` returns the current state; `DELETE` → `204` (the queue is dropped).

### Which events arrive

- `messageCreate`, `messageUpdate`, `messageDelete`, `messageReactionAdd`, `messageReactionRemove` — of rooms the bot can see and of its DMs, **except** the bot's own messages and reactions. Commands work as on the gateway, in `message.command`.
- `taskCreate`, `taskUpdate`, `taskDelete`, `taskActivity` — of boards the bot can see.
- `eventCreate`, `eventUpdate`, `eventDelete`, `eventRsvp` — as on the gateway: outside addresses only to a bot that may change the meeting.
- `workspaceMemberUpdate`.
- `botCallback` — presses of buttons under the bot's messages (see [Commands and buttons](./commands-buttons)).
- `taskNotice` — notifications of people who chose this bot (see [Task notifications](./task-notices)).

Voice events (`voiceStateUpdate` and others) arrive **only** over the gateway.

### The request

```http
POST /calab HTTP/1.1
Host: bot.example.com
Content-Type: application/json
User-Agent: CalabBot-Webhook/1.0
X-Calab-Delivery: 0192c4a0-…
X-Calab-Signature: sha256=5d2f…c41a
```

```json
{
  "id": "0192c4a0-…",
  "botUserId": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
  "createdAt": "2026-10-14T10:05:00Z",
  "event": {
    "messageCreate": {
      "workspaceId": "0191f0c2-0000-7000-8000-00000000a001",
      "message": {
        "id": "0192c3f0-…",
        "roomId": "0191f0d4-0000-7000-8000-00000000b001",
        "authorId": "0191f0c2-7a10-7d3e-9b11-5c2f8e4a6d01",
        "content": "/ping",
        "command": { "botUserId": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b", "name": "ping", "args": "" }
      }
    }
  }
}
```

The body is `BotWebhookUpdate { id, botUserId, createdAt, event }`, where `event` is the same `DispatchEvent` as on the gateway.

### Verifying the signature

`X-Calab-Signature` = `sha256=` + hex(HMAC-SHA256(secret, body)). Compute the HMAC over the **raw bytes** of the body, not over re-serialized JSON, and compare in constant time.

```js tab="JavaScript"
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret, rawBody, header) {
  const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'));
  const got = Buffer.from(header ?? '');
  return want.length === got.length && timingSafeEqual(want, got);
}
```

```python tab="Python"
import hashlib, hmac

def verify(secret: bytes, raw_body: bytes, header: str) -> bool:
    want = "sha256=" + hmac.new(secret, raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, header or "")
```

In the SDK: `new Bot(token, { server, webhookSecret })` and `bot.handleWebhook(rawBody, headers)` — it verifies the signature, drops repeats and emits the same `message` / `command` / `reaction` / `callback` events as the gateway. Standalone: `verifyWebhookSignature(secret, rawBody, header)`.

```js tab="JavaScript"
import { createServer } from 'node:http';
import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, { server: 'https://app.example.com', webhookSecret: process.env.WEBHOOK_SECRET });
bot.on('command', (c) => bot.reply(c, 'pong'));

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => {
    res.statusCode = bot.handleWebhook(Buffer.concat(chunks), req.headers) ? 204 : 401;
    res.end();
  });
}).listen(8080);
```

### Delivery and retries

- Success is any `2xx` within 10 seconds. Redirects are not followed and count as failures.
- Retries: after 1 min, 2, 4 … up to 1 hour between attempts; a delivery lives for a day.
- A webhook that fails for a whole day is **disabled**: `webhook.disabledAt` is set, the queue is dropped, the bot's owner and managers get `botUpdate`. `PUT` enables it again.
- Order is not guaranteed and repeats are possible — dedupe by `id`. Answer fast and do the work after answering.

## Board webhook

A board POSTs JSON to your HTTPS address whenever its tasks change. It is not the bot webhook: one webhook per board, every task change, no event filter. It fits syncing with trackers, BI and CRMs.

> [!NOTE]
> The board webhook is set up **by people only**: it holds a secret and exports the board's data. A bot gets `403 BOT_NOT_ALLOWED`. It needs `MANAGE_BOARD` on the board and `MANAGE_INTEGRATIONS` in the workspace, on the Business plan or above (below it: `409 CONFLICT`, `reason: "PLAN_LIMIT"`). The webhook belongs to the board, not its creator: anyone with `MANAGE_BOARD` sees and changes it.

### Routes

| Method | Path | What it does |
|---|---|---|
| `PUT` | `/api/boards/{id}/webhook` | create, replace or re-enable a disabled one: `{url, secret?}` |
| `GET` | `/api/boards/{id}/webhook` | state: `url`, `hasSecret`, `enabled`, `disabledAt`, `failingSince`, `lastOkAt`, `lastError`, `pending`, `pausedReason` |
| `DELETE` | `/api/boards/{id}/webhook` | delete → `204`; the queue is marked `failed` |
| `POST` | `/api/boards/{id}/webhook/ping` | send a `ping` event synchronously → `{ok, status, error}`; at most once per 10 s (`429`) |

`url` is `https://` to a public address only. `secret` is 16 to 256 characters; when empty, the server generates 32 random bytes (base64url) and returns `secret` **once** in the response. The secret is never returned again.

### Events

| `type` | When |
|---|---|
| `task.created` | a task was created |
| `task.updated` | any change: fields, status, assignees, relations, attachments, approvals, checklists, milestones, Git links |
| `task.archived` · `task.restored` | archived · restored (auto-archive: `actor: null`) |
| `task.moved_in` | a task arrived from another board (it already has its new key) — to the target board |
| `task.moved_out` | a task left for another board — to the source board |
| `task.comment.created` · `task.comment.updated` · `task.comment.deleted` | comments |
| `ping` | a test event |

The changes of one transaction make one event. `changes` are the task's journal entries: `field` is the entry kind (`status`, `assignees`, `checklist`, `milestones`, `git` …), `before` / `after` are its data. Changes made by an **automation rule** arrive as a separate event of the same transaction with `"actor": null` and `"rule": {"id", "name"}`; for changes by people and bots `rule` is `null`. Git events (a task's links to branches and pull requests) are `task.updated` with `changes[field=git]` and `"actor": null`.

### The request

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Calab-Webhook/1.0` |
| `X-Calab-Webhook-Version` | `1` — the contract only grows by adding fields |
| `X-Calab-Event` | the event `type` |
| `X-Calab-Delivery` | the delivery id (= `id` in the body) |
| `X-Calab-Timestamp` | Unix time of sending, in seconds |
| `X-Calab-Signature` | `v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>` |

### Body format

`BoardWebhookEvent` in protojson, but with the **proto field names (snake_case)** instead of the lowerCamelCase of REST. Every field is present: unset ones are `null` (`actor: null` for server-made changes, `edited_at: null`), empty strings and lists as they are; `uint64` (for example an attachment's `size`) is a **string**, `sequence` is a number. `task` is the task without viewer data (`subscribed`, `muted`, `unread`, `viewer_state` are always at their defaults); `attachments` and `checklists` are always empty (the `attachment_count`, `checklist_total` / `checklist_done` counters stay); milestones (`milestones`, `milestone_progress`, `task_milestone_id`) are as they are; `comment` only for `task.comment.*`. The task link is `task_url`.

An example (fields in alphabetical order; to show both `changes` and `comment` they are put together — in a real `task.updated`, `comment` is `null`):

```json
{
  "actor": { "id": "0192a000-0000-7000-8000-0000000000cc", "is_bot": false, "name": "Anna" },
  "board": { "id": "0192a000-0000-7000-8000-0000000000bb", "key": "FIN", "name": "Finance" },
  "changes": [
    {
      "after": { "status_id": "s2", "status_type": "started" },
      "before": { "status_id": "s1", "status_type": "unstarted" },
      "field": "status"
    }
  ],
  "comment": {
    "attachments": [{ "mime": "application/pdf", "name": "a.pdf", "size": "1024" }],
    "author_id": "u1",
    "created_at": "2026-10-02T12:00:00Z",
    "edited_at": null,
    "id": "m1",
    "text": "done"
  },
  "id": "0192a000-0000-7000-8000-000000000001",
  "occurred_at": "2026-10-02T12:00:00Z",
  "rule": null,
  "sequence": 42,
  "task": {
    "approval_required": 0,
    "approval_state": "TASK_APPROVAL_STATE_UNSPECIFIED",
    "approvers": [],
    "archived_at": null,
    "assignees": [],
    "attachment_count": 0,
    "attachments": [],
    "board_id": "0192a000-0000-7000-8000-0000000000bb",
    "checklist_done": 3,
    "checklist_total": 7,
    "checklists": [],
    "comment_count": 0,
    "completed_at": null,
    "completed_by": "",
    "created_at": "2026-10-02T12:00:00Z",
    "created_by": "",
    "description": "",
    "due_on": "",
    "estimate": 3,
    "git_links": [],
    "git_links_count": 0,
    "id": "0192a000-0000-7000-8000-0000000000dd",
    "key": "FIN-12",
    "label_ids": [],
    "milestone_id": "",
    "milestone_progress": null,
    "milestones": [],
    "muted": false,
    "number": 12,
    "parent_id": "",
    "position": 0,
    "priority": "TASK_PRIORITY_HIGH",
    "relations": [],
    "room_id": "",
    "start_on": "",
    "started_at": null,
    "status_id": "s2",
    "subscribed": false,
    "subtask_count": 0,
    "subtask_done": 0,
    "task_milestone_id": "",
    "title": "Report",
    "unread": false,
    "updated_at": "2026-10-02T12:00:00Z",
    "viewer_state": false,
    "workspace_id": ""
  },
  "task_url": "https://app.example.com/t/FIN-12",
  "type": "task.updated",
  "version": 1,
  "workspace_id": "0192a000-0000-7000-8000-0000000000aa"
}
```

`task.moved_out` carries only what the source board knew: `task` holds just `id`, the old `key` and the source `board_id`, and `changes` is a single `moved_board` entry with `before`. The whole task (new key, the target's statuses and labels) arrives in the target board's `task.moved_in`.

### Verifying the signature

The HMAC is computed over `timestamp + "." + the raw body bytes`. Reject the request when `|now − timestamp| > 5 minutes` (replay protection) and compare signatures in constant time.

```js tab="JavaScript"
import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody — the raw body bytes (a Buffer); headers — request headers, lower-case
export function verifyBoardWebhook(secret, rawBody, headers, now = Date.now() / 1000) {
  const ts = headers['x-calab-timestamp'];
  if (!ts || Math.abs(now - Number(ts)) > 300) return false; // ±5 minute window
  const want = Buffer.from('v1=' + createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex'));
  const got = Buffer.from(headers['x-calab-signature'] ?? '');
  return want.length === got.length && timingSafeEqual(want, got);
}
```

```python tab="Python"
import hashlib, hmac, time

def verify_board_webhook(secret: bytes, raw_body: bytes, headers: dict, now: float | None = None) -> bool:
    ts = headers.get("X-Calab-Timestamp", "")
    if not ts.isdigit() or abs((now or time.time()) - int(ts)) > 300:  # ±5 minute window
        return False
    mac = hmac.new(secret, ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest("v1=" + mac, headers.get("X-Calab-Signature", ""))
```

In the SDK: `verifyBoardWebhook(secret, timestamp, body, signature)` checks the signature and the ±5 minute window; `parseBoardWebhookEvent(body)` parses the body.

### Delivery

- **At least once**: repeats are possible and the order of arrival is not guaranteed. Idempotency is by `id` (remember the ones you've seen); ordering is by `sequence` (monotonic per board, from 1; `ping` has 0).
- Success is any `2xx` within 10 seconds; redirects are errors. Accept bodies up to 256 KB.
- Retries: after 1 min, 2, 4 … up to 1 hour; a delivery lives for a day. A webhook that fails for a day in a row is **disabled** (`enabled: false`, the queue is dropped); `PUT` re-enables it.
- **Plan pause**: when the plan drops below Business the webhook is kept but paused (`pausedReason = PLAN`) — new events are not queued; after an upgrade delivery continues with new events.
- An archived board is read-only and produces no events; the queue already accumulated is still delivered.

> [!NOTE]
> Comment events are queued **after** the message commits: if the server process dies exactly between those two steps, the event is lost. The window is rare; task-change events are written in the same transaction and are never lost.
