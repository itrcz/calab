---
title: Quickstart
description: Create a bot, get its token, make the first request and send the first message — in five minutes.
order: 2
---

In five minutes you'll create a bot, find a room and post a message to it, then run a bot that answers commands.

You need a Calab workspace where you are the owner or hold the “Manage bots” permission (`MANAGE_BOTS`), and a verified email address.

## 1. Create a bot

1. Open “Workspace settings → Bots”.
2. Click “Create bot” and enter a name, a `username` (3–32 characters: `a–z`, `0–9` and `_`; people address the bot with `/command@username`) and a description.
3. Copy the token — **it is shown once**. Lost it? Use “Reissue token”.

The bot joins the workspace right away with the member role: it reads and writes in open rooms and joins voice. Need more or less? Give it a role or room overrides, as you would a person (see [Token and permissions](./auth)).

> [!WARNING]
> The token is the bot's password. Don't commit it to git, don't log it and never put it in a URL — only in the `Authorization` header.

## 2. The first request

Put the server address and the token into environment variables and ask the server who you are:

```sh tab="curl"
export CALAB=https://app.example.com
export TOKEN=calab_bot_0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b_Xq3v9aT2LmN8pR4sW7yZ1bC5dF0gH6jK3nQ9uV2xE8w

curl -s $CALAB/api/bots/me -H "Authorization: Bearer $TOKEN"
```

```js tab="JavaScript"
const CALAB = process.env.CALAB; // https://app.example.com
const headers = { Authorization: `Bearer ${process.env.TOKEN}` };

const res = await fetch(`${CALAB}/api/bots/me`, { headers });
console.log(await res.json());
```

```python tab="Python"
import os, requests

CALAB = os.environ["CALAB"]  # https://app.example.com
H = {"Authorization": f"Bearer {os.environ['TOKEN']}"}

print(requests.get(f"{CALAB}/api/bots/me", headers=H).json())
```

The response is the bot's profile:

```json
{
  "bot": {
    "user": { "id": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b", "displayName": "Echo", "isBot": true },
    "username": "echo",
    "ownerUserId": "0191f0c2-7a10-7d3e-9b11-5c2f8e4a6d01",
    "workspaceId": "0191f0c2-0000-7000-8000-00000000a001",
    "description": "",
    "commands": [],
    "tokenPrefix": "Xq3v9a",
    "createdAt": "2026-10-14T10:00:00Z",
    "webhook": { "url": "", "enabled": false, "lastError": "", "pending": 0 }
  }
}
```

`401 UNAUTHENTICATED` means the token is wrong, revoked or reissued.

## 3. Find a room

```sh tab="curl"
curl -s $CALAB/api/workspaces -H "Authorization: Bearer $TOKEN"
# {"workspaces": [{"id": "0191f0c2-…", "name": "Acme", …}]}

export WS=0191f0c2-0000-7000-8000-00000000a001
curl -s $CALAB/api/workspaces/$WS/rooms -H "Authorization: Bearer $TOKEN"
# {"rooms": [{"id": "0191f0d4-…", "type": "ROOM_TYPE_TEXT", "name": "general", …}]}
```

```python tab="Python"
ws = requests.get(f"{CALAB}/api/workspaces", headers=H).json()["workspaces"][0]
rooms = requests.get(f"{CALAB}/api/workspaces/{ws['id']}/rooms", headers=H).json()["rooms"]
room = next(r for r in rooms if r["type"] == "ROOM_TYPE_TEXT")
```

The list contains only the rooms the bot can see (`VIEW_ROOM`).

## 4. Send a message

```sh tab="curl"
export ROOM=0191f0d4-0000-7000-8000-00000000b001
curl -s -X POST $CALAB/api/rooms/$ROOM/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content": "Hi! I am a bot.", "nonce": "hello-1"}'
```

```js tab="JavaScript"
const res = await fetch(`${CALAB}/api/rooms/${roomId}/messages`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: 'Hi! I am a bot.', nonce: 'hello-1' }),
});
const { message } = await res.json(); // 201
```

```python tab="Python"
r = requests.post(f"{CALAB}/api/rooms/{room['id']}/messages", headers=H,
                  json={"content": "Hi! I am a bot.", "nonce": "hello-1"})
message = r.json()["message"]  # 201
```

```json
{
  "message": {
    "id": "0192a1c0-…",
    "roomId": "0191f0d4-0000-7000-8000-00000000b001",
    "authorId": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
    "content": "Hi! I am a bot.",
    "nonce": "hello-1",
    "attachments": [],
    "reactions": [],
    "pinnedBy": "",
    "kind": "MESSAGE_KIND_UNSPECIFIED",
    "keyboardRevision": "0",
    "createdAt": "2026-10-14T10:01:02.345Z"
  }
}
```

> [!TIP]
> `nonce` is an idempotency key (up to 64 characters). Repeating the request with the same `nonce` returns the same message with `200` instead of creating a second one. Generate it once per message and reuse it on retries.

## 5. A bot that answers

To react to messages a bot listens for events — over the [gateway](./gateway) (a persistent connection) or a [webhook](./webhooks). The easiest way is the [Node.js SDK](./sdk): it handles reconnects and command parsing for you.

```js tab="JavaScript"
import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.TOKEN, { server: 'https://app.example.com' });

await bot.commands([{ name: 'echo', description: 'Repeat the text' }]);
bot.on('message', (m) => bot.reply(m, m.content));
bot.on('command', (c) => c.name === 'echo' && bot.reply(c, c.args || 'Type: /echo text'));

await bot.start();
```

The ready-made example `examples/bots/echo` from the [repository](https://github.com/itrcz/calab) (Node ≥ 20):

```sh
pnpm install && pnpm -F @calaba/bot-sdk build
cd examples/bots/echo && npm install
BOT_TOKEN=$TOKEN CALAB_SERVER=$CALAB npm start
```

Write anything in a room, or `/echo hello` — the bot answers.

## Next

- [Token and permissions](./auth) — what a bot can do and how to grant permissions.
- [Messages](./rest-messages) — replies, attachments, reactions, edits.
- [Commands and buttons](./commands-buttons) — `/commands` and buttons under messages.
- [Errors and limits](./errors-limits) — what to do with `403`, `409` and `429`.
