---
title: Commands and buttons
description: Bot slash commands — registration, addressing, parsing; buttons under messages — keyboards, presses, idempotency.
order: 18
---

## Slash commands

A command is an ordinary message that starts with `/name`. People see it as text, while the bot it is addressed to receives the parsed command in `message.command`.

### Registration

A bot publishes its command list — the composer suggests the commands after `/`, and people see them in the bot's profile.

```sh tab="curl"
curl -s -X PUT $CALAB/api/bots/me/commands \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"commands": [{"name": "deploy", "description": "Deploy a branch to staging"},
                    {"name": "status", "description": "Service status"}]}'
```

```js tab="JavaScript"
await bot.commands([
  { name: 'deploy', description: 'Deploy a branch to staging' },
  { name: 'status', description: 'Service status' },
]);
```

```python tab="Python"
requests.put(f"{CALAB}/api/bots/me/commands", headers=H, json={"commands": [
    {"name": "deploy", "description": "Deploy a branch to staging"},
    {"name": "status", "description": "Service status"},
]})
```

- The request **replaces** the whole list. An empty list removes every command.
- Up to 100 commands; a name is `[a-z0-9_]{1,32}` (a leading `/` is stripped), a description up to 256 characters, names are unique.
- Commands of all bots in a room: `GET /api/rooms/{id}/bot-commands` — this is how the composer builds its hints.

### Addressing

| Message | Who gets the command |
|---|---|
| `/name@username args` | the bot with that `username`, if it can see the room (the command need not be registered) |
| `/name args` in a room | the only bot in the room that registered `name`; if several did, it is not a command — use `@username` |
| `/name args` in a DM with a bot | that bot |

The name must be followed by a space or the end of the text. Messages written by bots are **never** commands — so bots can't loop on each other.

### What the bot receives

In the `messageCreate` event (gateway and webhook) the addressed bot gets `message.command` filled in:

```json
{
  "messageCreate": {
    "workspaceId": "0191f0c2-0000-7000-8000-00000000a001",
    "message": {
      "id": "0192a1d0-…",
      "roomId": "0191f0d4-0000-7000-8000-00000000b001",
      "authorId": "0191f0c2-7a10-7d3e-9b11-5c2f8e4a6d01",
      "content": "/deploy@opsbot feature/login",
      "command": { "botUserId": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b", "name": "deploy", "args": "feature/login" }
    }
  }
}
```

`name` is lower case, `args` is the rest of the text, trimmed. `command` exists only in events: REST responses and history don't carry it.

```js tab="JavaScript"
bot.on('command', async (c) => {
  if (c.name === 'roll') await bot.reply(c, String(1 + Math.floor(Math.random() * Number(c.args || 6))));
});
```

### Mentions

Mentioning a bot is an ordinary mention, `@<bot id>` in the text. `GET /api/me/mentions` returns the messages that mention the bot.

## Buttons under messages

A bot can attach a keyboard to its message — up to 5 rows of 5 buttons. A person presses a button, the bot receives a `botCallback` event and decides what to do.

### The keyboard

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$ROOM/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content": "Review this draft", "nonce": "draft-42-v3",
       "inlineKeyboard": {"allowedUserIds": ["0191f0c2-7a10-7d3e-9b11-5c2f8e4a6d01"],
         "rows": [{"buttons": [{"id": "confirm", "label": "Confirm", "data": "draft:42:v3"},
                               {"id": "reject", "label": "Reject", "data": "draft:42:v3"}]}]}}'
```

```js tab="JavaScript"
const message = await bot.send(roomId, {
  text: 'Review this draft',
  inlineKeyboard: {
    allowedUserIds: [authorId],
    rows: [{ buttons: [
      { id: 'confirm', label: 'Confirm', data: 'draft:42:v3' },
      { id: 'reject', label: 'Reject', data: 'draft:42:v3' },
    ] }],
  },
});
```

| Field | Rule |
|---|---|
| `rows[].buttons[]` | up to 5 rows of 5 buttons |
| `id` | unique within the keyboard, 1–64 characters: ASCII letters, digits, `_`, `-` |
| `label` | 1–80 characters, no control characters |
| `data` | up to 512 UTF-8 bytes — opaque data for the bot |
| `disabled` | the button can't be pressed |
| `allowedUserIds` | up to 50 ids; empty — any reader with `SEND_MESSAGES` may press |

> [!WARNING]
> Every keyboard field is public message metadata that any reader can see. Never put secrets or tokens in `data`.

Buttons call only their author bot. Forwarded copies of the message have no active buttons.

### Changing the keyboard

`PATCH /api/messages/{id}`:

- `inlineKeyboard` omitted — the keyboard stays; `{"inlineKeyboard": {}}` or empty `rows` — remove it.
- To change only the keyboard, send `"preserveContent": true` without `content`. The flag requires a keyboard in the request and rejects non-empty text.
- Without the flag, `content` keeps its usual meaning: omitted or empty means empty text (allowed only with attachments).
- Every text or keyboard edit changes the server-owned `keyboardRevision`.

```js tab="JavaScript"
await bot.edit(message.id, { inlineKeyboard: { rows: [] } });           // remove, keep the text
await bot.edit(message.id, { text: 'Draft v4', inlineKeyboard: next });  // text and keyboard at once
```

The SDK sets `preserveContent` automatically when the edit has no `text`.

### A press

When a person presses a button, the client calls `POST /api/messages/{id}/interactions` with `{buttonId, keyboardRevision, nonce}`. This route is **for people only**: a bot can't press buttons. The server checks `VIEW_ROOM` + `SEND_MESSAGES`, that the message and keyboard are current, `allowedUserIds`, that the author bot is active and reachable, blocks and cleared DM history. A stale keyboard or an unavailable button returns `409 CONFLICT` with `reason` `KEYBOARD_STALE` / `BUTTON_UNAVAILABLE`.

`200 {interactionId}` means **accepted, not completed**. Nothing is posted to the chat. The UI disables the whole keyboard after acceptance until the bot sends a new revision.

### The `botCallback` event

It reaches **only the author bot** — over its gateway and its webhook, if one is configured:

```json
{
  "botCallback": {
    "id": "0192a1e0-…",
    "botUserId": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
    "userId": "0191f0c2-7a10-7d3e-9b11-5c2f8e4a6d01",
    "workspaceId": "0191f0c2-0000-7000-8000-00000000a001",
    "roomId": "0191f0d4-0000-7000-8000-00000000b001",
    "messageId": "0192a1d0-…",
    "buttonId": "confirm",
    "data": "draft:42:v3",
    "keyboardRevision": "2",
    "createdAt": "2026-10-14T10:05:00Z"
  }
}
```

`workspaceId` is empty in a DM. `userId` and `data` come from the server — a client can't forge them.

```js tab="JavaScript"
bot.on('callback', async (c) => {
  if (await seen(c.id)) return;            // durable dedupe by c.id
  await remember(c.id);
  const draft = await loadDraft(c.data);  // check the current draft version and its author
  if (c.userId !== draft.authorId || draft.version !== 'v3') return;
  await applyOnce(draft, c.buttonId);      // the external effect, idempotently
});
```

### Delivery guarantees

- **The webhook** is reliable: the delivery is queued atomically with accepting the press and retried under the usual [webhook](./webhooks) rules. Build important actions on the webhook.
- **The gateway** is best effort after commit: an ordinary `RESUME` replays buffered events, but a fresh session can't recover missed presses.
- The same person retrying a press with the same `nonce` (1–64 bytes) gets the original `interactionId` without a second delivery — even after the keyboard was edited or removed. Reusing a `nonce` for a different press is a conflict. Receipts live until the message is physically deleted. Different `nonce`s can both be accepted.
- A bot must durably dedupe `callback.id` across transports and retries and make external effects idempotent. A press accepted before a draft changed is not cancelled — revalidate against your current version. The SDK's webhook cache is bounded and is not an exactly-once guarantee.
- A bot removed from the last shared workspace doesn't receive old DM presses.
