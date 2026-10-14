---
title: Node.js SDK
description: '@calaba/bot-sdk — REST, a gateway with typed events, commands, webhooks and voice; installing from the repository, the API and examples.'
order: 21
---

`@calaba/bot-sdk` is the bot SDK for TypeScript/JavaScript: the REST API, the realtime gateway with typed events, `/commands`, webhooks and voice through LiveKit. ESM, Node.js ≥ 20, a single runtime dependency (`ws`). The contract types are generated from the same protobuf schemas as the server, so fields and enums match REST one to one.

## Install

The SDK lives in the open monorepo [github.com/itrcz/calab](https://github.com/itrcz/calab) and isn't published to npm yet. Build it once from the repository root:

```sh
git clone https://github.com/itrcz/calab.git && cd calab
pnpm install
pnpm -F @calaba/bot-sdk build      # → packages/bot-sdk/dist/index.js (the contract is bundled in)
```

A project outside the monorepo depends on it by path:

```json
{
  "dependencies": {
    "@calaba/bot-sdk": "file:../calab/packages/bot-sdk"
  }
}
```

## Quick start

```js
import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, { server: 'https://app.example.com' });

await bot.commands([{ name: 'echo', description: 'Repeat the text' }]);

bot.on('message', (m) => bot.reply(m, `echo: ${m.content}`));
bot.on('command', (c) => {
  if (c.name === 'echo') return bot.reply(c, c.args || '(nothing to echo)');
});

const ready = await bot.start();
console.log(`${ready.me?.user?.displayName} is online in ${ready.workspaces.length} workspace(s)`);
```

## Constructor

`new Bot(token, options)`:

| Option | What it does |
|---|---|
| `server` | the app address, `https://app.example.com`; the gateway is `wss://<host>/gateway` |
| `webhookSecret` | the secret for `handleWebhook` |
| `receiveOwn` | `true` — also receive the bot's own messages and reactions (skipped by default) |
| `maxRetries` | retries on `429`, 3 by default |
| `log` | your own logger |

## API

| Method | What it does |
|---|---|
| `start(): Promise<Ready>` · `stop()` | connect the gateway (`IDENTIFY` → `READY`) · disconnect |
| `on(event, fn)` · `once` · `off` | typed events, see below |
| `send(roomId, text \| { text?, stickerId?, files?, replyTo?, nonce?, inlineKeyboard? })` | a message; `files` are `{ name, data }` (uploaded first) or ids of uploaded files |
| `reply(message \| command, content)` | a reply in the same room |
| `edit(id, text \| { text?, inlineKeyboard? })` · `deleteMessage(id)` | edit · delete |
| `react(id, emoji)` · `unreact(id, emoji)` | reactions |
| `forward(roomId, messageId, toRoomId)` | forward a copy to another room or DM → `Message` |
| `messages(roomId, { before?, after?, limit? })` · `message(roomId, messageId)` | history · one message |
| `transcript(roomId, recordingId)` | a recording's full transcript → `{ recordingId, language, segments }` |
| `typing(roomId)` | “is typing” |
| `upload(roomId, file)` | upload a file to the room's workspace (or the DM) → `FileMeta` |
| `dm(userId)` | open or find a DM → `DmSummary` (send to `dm.room.id`) |
| `commands([{ name, description }])` | replace the command list |
| `workspaces()` · `rooms(workspaceId?)` · `room(id)` · `members(roomId)` | what the bot can see |
| `isDm(roomId)` · `workspaceOf(roomId)` | from the gateway cache |
| `voice.join(roomId)` · `voice.leave(roomId)` · `voice.participants(roomId)` | voice: LiveKit credentials, leaving, participants |
| `webhook.get()` · `webhook.set(url, secret)` · `webhook.delete()` | the bot webhook |
| `handleWebhook(rawBody, headers)` | verify the signature, drop repeats, emit events |
| `stickers.list(wsId)` · `stickers.createPack(wsId, { name, shortName })` · `stickers.addStickers(packId, [{ emoji, data }])` · `stickers.remove(id)` | stickers; packs need `MANAGE_STICKERS` |
| `boards.list(wsId)` · `boards.get(id)` · `boards.categories.*` · `boards.setFeatures(boardId, …)` | boards |
| `tasks.list` · `search` · `get` · `create` · `update` · `setAssignees` · `comment` · `tasks.checklists.*` · `tasks.milestones.*` | tasks, checklists, milestones |
| `forms.list` · `create` · `update` · `delete` · `get` · `submit` · `preview` | board forms |
| `members.get(wsId, userId)` · `members.setNickname(wsId, userId, nick)` | a member's profile · nickname |
| `calendar.list(wsId, from, to)` · `get` · `create` · `update` · `delete` · `freebusy(wsId, users, from, to)` · `suggest(wsId, q)` | calendar |
| `invites.list` · `create` · `delete` · `email(wsId, address)` · `listEmail` · `deleteEmail` | invites |
| `badges.list` · `create` · `update` · `delete` · `set(wsId, userId, badgeId)` | badges |
| `recording.start(roomId)` · `recording.stop(roomId)` | meeting recording |
| `fetchMe()` · `updateProfile({ displayName?, description? })` | the bot's profile |
| `rest.request(method, path, { json?, query?, form? })` · `rest.call(Schema, …)` | any other allowed route |

Details for each group are in the REST chapters: [messages](./rest-messages), [boards](./rest-boards), [calendar](./rest-calendar) and the rest.

## Events

| Event | Payload |
|---|---|
| `ready` | `Ready` — the bot's account, workspaces (visible rooms, members, voice), DMs |
| `resumed` | the connection is back, missed events were replayed |
| `message` | a `Message` from someone else (not a command for this bot) |
| `command` | `{ name, args, message, workspaceId }` — `/name args` or `/name@username args` for this bot |
| `messageUpdate` · `messageDelete` | `Message` · `{ workspaceId, roomId, messageId }` |
| `reaction` | `{ type: 'add' \| 'remove', workspaceId, roomId, messageId, userId, emoji }` |
| `callback` | `BotCallback` — a button press; see [Commands and buttons](./commands-buttons) |
| `taskNotice` | `TaskNoticeRelay` — a person's task notification; see [Task notifications](./task-notices) |
| `voiceState` | `VoiceState` (empty `roomId` — left voice) |
| `dispatch` | every raw `DispatchEvent` (rooms, members, presence…) |
| `status` | `connecting` · `ready` · `reconnecting` · `resuming` · `stopped` |
| `error` | a listener threw, or the gateway gave up (`GatewayFatalError`) |

## Reliability

- **Reconnect**: exponential backoff 1 → 30 s with jitter, then `RESUME`; if that fails, `IDENTIFY` again and a new `ready` event.
- **Fatal errors** (no reconnect; `start()` rejects or an `error` event arrives with `GatewayFatalError.kind`): `auth-failed` (4004 — a wrong or reissued token), `revoked` (4010), `replaced` (another process connected with the same token).
- **`429`** is retried up to `maxRetries` times after `Retry-After`; messages keep their `nonce`, so a retry never duplicates. Other errors throw `ApiError { status, code, reason, field, used, limit, retryAfterMs }` — for example `code: 'FORBIDDEN', reason: 'BOT_NOT_ALLOWED'`.

```js
import { ApiError } from '@calaba/bot-sdk';

try {
  await bot.send(roomId, 'The report is ready');
} catch (e) {
  if (e instanceof ApiError && e.code === 'BOT_BLOCKED') return; // the person blocked the bot
  throw e;
}
```

## Webhooks

```js
import { createServer } from 'node:http';
import { Bot, verifyBoardWebhook, parseBoardWebhookEvent } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, { server: 'https://app.example.com', webhookSecret: process.env.WEBHOOK_SECRET });
await bot.webhook.set('https://bot.example.com/calab', process.env.WEBHOOK_SECRET);
```

Standalone helpers: `verifyWebhookSignature(secret, rawBody, header)`, `signWebhook`, `parseWebhookUpdate` for the bot webhook; `verifyBoardWebhook(secret, timestamp, body, signature)`, `signBoardWebhook`, `parseBoardWebhookEvent(body)` for the board webhook. Details in [Webhooks](./webhooks).

## Examples

In the repository's `examples/bots` folder:

| Example | What it does | Needs |
|---|---|---|
| `echo` | answers with the message text, `/echo <text>`, `/ping` | — |
| `voice-echo` | `/join` in a voice room's chat — joins the call and repeats every phrase it hears; `/play` plays a WAV | `@livekit/rtc-node`; `CONNECT` + `SPEAK` |
| `tts` | `/say <text>` in a voice room's chat — speaks the text (OpenAI-compatible TTS, or a tone without a key) | `@livekit/rtc-node`; `CONNECT` + `SPEAK` |
| `python/voice_listen.py` | joins a voice room, subscribes to everyone, prints their levels | `livekit` (pip); `CONNECT` |

```sh
cd examples/bots/echo
npm install
BOT_TOKEN=calab_bot_… CALAB_SERVER=https://app.example.com npm start
```

> [!TIP]
> Other languages don't need an SDK: REST is plain HTTP with JSON and the gateway accepts JSON frames (`?encoding=json`). Types for any language can be generated from the repository's `proto/` folder (`buf generate` with the plugin you need).
