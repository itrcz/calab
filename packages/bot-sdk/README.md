# @calaba/bot-sdk

TypeScript SDK for **Calab bots** (ADR-0031): the REST API, the realtime gateway with typed events,
`/commands`, webhooks and voice through LiveKit. ESM, Node ≥ 20, one runtime dependency (`ws`).

Full API reference (endpoints, events, limits, errors): [`docs/19-bot-api.en.md`](../../docs/19-bot-api.en.md)
(Russian: [`docs/19-bot-api.md`](../../docs/19-bot-api.md)).

## Install / build

The SDK lives in this monorepo. From the repository root:

```sh
pnpm install
pnpm -F @calaba/bot-sdk build      # → packages/bot-sdk/dist/index.js (the contract is bundled in)
```

A project outside the workspace can depend on it with `"@calaba/bot-sdk": "file:<repo>/packages/bot-sdk"`
(see `examples/bots/*`).

## Quick start

Create a bot in **Workspace settings → Bots**, copy the token (it is shown once), then:

```js
import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, { server: 'https://app.calab.io' });

await bot.commands([{ name: 'echo', description: 'Repeat the text' }]);

bot.on('message', (m) => bot.reply(m, `echo: ${m.content}`));
bot.on('command', (c) => {
  if (c.name === 'echo') return bot.reply(c, c.args || '(nothing to echo)');
});

const ready = await bot.start();
console.log(`${ready.me?.user?.displayName} is online in ${ready.workspaces.length} workspace(s)`);
```

## API

| | |
|---|---|
| `new Bot(token, { server, webhookSecret?, receiveOwn?, maxRetries?, log? })` | `server` is the app origin; the gateway is `wss://<host>/gateway` |
| `start(): Promise<Ready>` / `stop()` | connect the gateway (IDENTIFY with the token → READY) / disconnect |
| `on(event, fn)`, `once`, `off` | typed events, see below |
| `send(roomId, text \| { text?, stickerId?, files?, replyTo?, nonce? })` | `files`: `{ name, data }` (uploaded first) or ids of uploaded files |
| `reply(message \| command, content)` | answers in the same room as a reply |
| `edit(id, text)`, `deleteMessage(id)`, `react(id, emoji)`, `unreact(id, emoji)` | |
| `forward(roomId, messageId, toRoomId)` | a copy into another room or DM with `forward` (ADR-0033) → `Message` |
| `messages(roomId, { before?, after?, limit? })`, `typing(roomId)` | history; «is typing» |
| `message(roomId, messageId)` | one message by id (e.g. a `replyToId` target) with history access → `Message` |
| `transcript(roomId, recordingId)` | full saved transcript of a recording card visible in the room (incl. a forwarded copy) → `{ recordingId, language, segments }` |
| `upload(roomId, file)` | into the room's workspace (or the DM) → `FileMeta` |
| `dm(userId)` | open / find a DM with a member of a shared workspace → `DmSummary` (send to `dm.room.id`) |
| `commands([{ name, description }])` | replaces the bot's commands (composer hints on `/`) |
| `workspaces()`, `rooms(workspaceId?)`, `room(id)`, `members(roomId)` | what the bot can see (by its roles) |
| `isDm(roomId)`, `workspaceOf(roomId)` | from the gateway cache (READY, ROOM_*, DM_CREATE) |
| `voice.join(roomId)` → `{ url, token, identity, canSpeak, … }`, `voice.leave(roomId)` | LiveKit credentials; see `examples/bots/voice-echo` |
| `voice.participants(roomId)` | voice states of a room, from the gateway |
| `webhook.get()`, `webhook.set(url, secret)`, `webhook.delete()` | https webhook instead of (or with) the gateway |
| `handleWebhook(rawBody, headers)` | verifies `X-Calab-Signature`, dedupes by delivery id, emits the same events |
| `stickers.list(wsId)`, `stickers.createPack(wsId, { name, shortName })`, `stickers.addStickers(packId, [{ emoji, data }])`, `stickers.remove(id)` | packs need `MANAGE_STICKERS` |
| `boards.list(wsId)`, `boards.get(id)`, `tasks.list/search/get/create/update/setAssignees/comment` | within the board bits of the bot's roles (ADR-0042) |
| `members.get(wsId, userId)`, `members.setNickname(wsId, userId, nick)` | profile with open tasks of visible boards; nickname needs `MANAGE_NICKNAMES` (ADR-0051) |
| `calendar.list(wsId, from, to)`, `calendar.get/create/update/delete`, `calendar.freebusy(wsId, users, from, to)`, `calendar.suggest(wsId, q)` | the bot organizes, never attends; others' meetings need `MANAGE_EVENTS`; busy time only (ADR-0051) |
| `invites.list/create/delete(wsId, …)`, `invites.email(wsId, address)`, `invites.listEmail/deleteEmail` | `INVITE_MEMBERS`; mail goes «on behalf of bot X» |
| `badges.list/create/update/delete(wsId, …)`, `badges.set(wsId, userId, badgeId)` | library: `MANAGE_MEMBERS`; a member's badge: `MANAGE_NICKNAMES` |
| `recording.start(roomId)`, `recording.stop(roomId)` | `MANAGE_RECORDINGS` for bots, plus the room's `allow_recording` |
| `fetchMe()`, `updateProfile({ displayName?, description? })` | `/api/bots/me` |
| `rest.request(method, path, { json?, query?, form? })`, `rest.call(Schema, …)` | any other endpoint the bot may use |

### Events

| event | payload |
|---|---|
| `ready` | `Ready` — the bot's account, workspaces (rooms it can view, members, voice states), DMs |
| `resumed` | the connection came back, missed events were replayed |
| `message` | `Message` from someone else (not a command addressed to this bot) |
| `command` | `{ name, args, message, workspaceId }` — `/name args` or `/name@username args` for this bot |
| `messageUpdate`, `messageDelete` | `Message` / `{ workspaceId, roomId, messageId }` |
| `reaction` | `{ type: 'add' \| 'remove', workspaceId, roomId, messageId, userId, emoji }` |
| `voiceState` | `VoiceState` (`roomId` empty = left voice) |
| `dispatch` | every raw `DispatchEvent` (rooms, members, presence, …) |
| `status` | `connecting` · `ready` · `reconnecting` · `resuming` · `stopped` |
| `error` | a listener threw, or the gateway gave up (`GatewayFatalError`) |

The bot's own messages and reactions are skipped unless `receiveOwn: true`.

### Reliability

- **Reconnect**: exponential backoff 1 s → 30 s with jitter, then `RESUME` — the server replays what was
  missed (≈ 5 min buffer); if it cannot, the SDK sends `IDENTIFY` again and you get a new `ready`.
- **Fatal** (no reconnect; `start()` rejects or an `error` event with `GatewayFatalError.kind`):
  `auth-failed` (4004: wrong or re-issued token), `revoked` (4010), `replaced` (another process connected
  with the same token — run one process per token).
- **429**: retried up to `maxRetries` (3) times after `Retry-After`; messages keep their `nonce`, so a retry
  never duplicates. Other errors throw `ApiError { status, code, reason, field, used, limit, retryAfterMs }`
  — e.g. `code: 'FORBIDDEN', reason: 'BOT_NOT_ALLOWED'`, `code: 'BOT_BLOCKED'`, `reason: 'PLAN_LIMIT'`.

### Webhook

```js
import { createServer } from 'node:http';
const bot = new Bot(process.env.BOT_TOKEN, { server, webhookSecret: process.env.WEBHOOK_SECRET });
bot.on('command', (c) => bot.reply(c, 'pong'));
await bot.webhook.set('https://bot.example.com/calab', process.env.WEBHOOK_SECRET);
createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => {
    res.statusCode = bot.handleWebhook(Buffer.concat(chunks), req.headers) ? 204 : 401;
    res.end();
  });
}).listen(8080);
```

Standalone helpers: `verifyWebhookSignature(secret, rawBody, header)`, `signWebhook`, `parseWebhookUpdate`.

## Tests

`pnpm -F @calaba/bot-sdk test` — against an in-process fake server (`test/fake-server.ts`: REST table +
the real binary gateway protocol on loopback), no network.


### Inline buttons

`send(roomId, { text, inlineKeyboard: { rows: [{ buttons: [{ id: 'confirm', label: 'Confirm', data: 'draft:42:v3' }] }], allowedUserIds: [authorId] } })`
attaches an author-bound keyboard. `edit(messageId, { inlineKeyboard: { rows: [] } })`
removes it without changing text. `edit(messageId, { text, inlineKeyboard })` updates
both atomically; a text-only edit preserves the keyboard and changes its revision. `bot.on('callback', c => …)`
receives the generated `BotCallback` type over gateway or webhook. Persist and dedupe `c.id`
and revalidate your current draft version and author before external effects. Data is public,
never a secret; acceptance is not completion. For delivery guarantees and REST fields see
[Bot API](../../docs/19-bot-api.en.md#inline-buttons-adr-0047).

## Boards 2.0 (ADR-0058)

```ts
await bot.boards.categories.create(wsId, 'Dev');
await bot.boards.setFeatures(boardId, { disabledFeatures: [BoardFeature.ESTIMATE] });
const { checklist } = await bot.tasks.checklists.create(taskId, 'QA');
await bot.tasks.checklists.addItem(checklist!.id, 'Smoke test');

// board webhook receiver (people configure it in the board settings, Business plan):
if (!verifyBoardWebhook(secret, headers['x-calab-timestamp'], rawBody, headers['x-calab-signature'])) return res.writeHead(401).end();
const event = parseBoardWebhookEvent(rawBody); // dedupe by event.id, order by event.sequence
```

Board intake forms: `bot.forms.list(boardId)`, `create(boardId, { definition })`,
`update(boardId, formId, { definition, revision })`, `delete(boardId, formId)`,
`get(code)`, `submit(code, { revision, nonce, answers })`, and
`preview(boardId, { definition, answers })`. Use a stable UUID nonce when retrying
submission. Management needs MANAGE_BOARD; private submission requires the bot in
the form allowlist. See [the form API](../../docs/19-bot-api.en.md#board-forms-adr-0059).

Form answers use `{fieldId, value}` for scalar fields (including PHONE and URL) and
`{fieldId, values: ['Design', 'Support']}` for MULTISELECT. Do not send both value shapes.
`titleFieldId` is optional: an absent or unanswered source uses the form title.
