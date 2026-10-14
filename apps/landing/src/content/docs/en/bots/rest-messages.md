---
title: Messages
description: Send, edit and delete messages, reply, forward, react, pin, move the read marker and read meeting transcripts.
order: 4
---

A bot writes to rooms and direct messages through the same routes the app uses: it sends text, files and stickers, replies to and forwards messages, reacts, pins and reads history. This page also covers fetching one message by id (handy when answering a card) and reading the full transcript of a recorded meeting.

Permissions are checked per room, exactly as for a person:

| Action | Permission |
|---|---|
| read history, one message, pins, a transcript | `VIEW_ROOM` |
| write, react | `SEND_MESSAGES` (+ `ATTACH_FILES` for attachments) |
| edit your own message | the author |
| delete others' messages, pin | `MANAGE_MESSAGES` (in a DM both participants may pin) |
| forward | `VIEW_ROOM` in the source room and `SEND_MESSAGES` in the target |

## Routes

<!-- routes:messages -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/rooms/{id}/messages` | Room history, newest first: `?before=&after=&limit=` (`limit ≤ 100`); `?q=` runs a full-text search in the room (`VIEW_ROOM`) |
| `GET` | `/api/rooms/{id}/messages/{messageId}` | One message — a bare `Message`, no wrapper (`VIEW_ROOM`) |
| `POST` | `/api/rooms/{id}/messages` | Send a message → `201 {message}` (`SEND_MESSAGES`) |
| `POST` | `/api/rooms/{id}/messages/{mid}/forward` | Forward to another room `{toRoomId}` → `201 {message}` with `forward` set |
| `PATCH` | `/api/messages/{id}` | Edit your message: text and/or inline keyboard → `{message}` |
| `DELETE` | `/api/messages/{id}` | Delete your own, or anyone's with `MANAGE_MESSAGES` → `204` |
| `GET` | `/api/messages/{id}/reactions/{emoji}` | Who reacted with an emoji: `?after=&limit=` (1..100, default 25) → `{users, hasMore}` |
| `PUT` | `/api/messages/{id}/reactions/{emoji}` | Add a reaction (URL-encoded emoji) → `204` |
| `DELETE` | `/api/messages/{id}/reactions/{emoji}` | Remove your reaction → `204` |
| `PUT` | `/api/messages/{id}/pin` | Pin → `204` (`MANAGE_MESSAGES`) |
| `DELETE` | `/api/messages/{id}/pin` | Unpin → `204` |
| `GET` | `/api/rooms/{id}/pins` | Pinned messages, most recently pinned first → `{messages}` |
| `PUT` | `/api/rooms/{id}/read` | Move the read marker `{messageId}` → `204` |
| `PUT` | `/api/messages/{id}/embeds-hidden` | Hide / show link previews `{hidden}` (author or `MANAGE_MESSAGES`) → `{message}` |
| `GET` | `/api/rooms/{id}/recordings/{rid}/transcript` | The full transcript of a meeting recording (`VIEW_ROOM`) |
<!-- /routes -->

### Not available to bots

These routes answer a bot with `403 FORBIDDEN`, `reason: "BOT_NOT_ALLOWED"`:

- `POST /api/messages/{id}/interactions` — pressing an inline button: only people press; the bot receives the result as a `botCallback` event (see [Commands and buttons](./commands-buttons));
- `GET /api/unfurl`, `GET /api/unfurl/image` — link previews are built by the app, not by bots;
- `POST /api/rooms/{id}/recordings/{rid}/recheck`, `…/reupload`, `DELETE /api/rooms/{id}/recordings/{rid}` — reprocessing, re-uploading and deleting recordings.

## Send a message

The body is a `CreateMessageRequest`:

| Field | Type | Description |
|---|---|---|
| `content` | string | Text, ≤ 4000 characters. A mention is `@<user id>` |
| `attachmentIds` | string[] | Ids of files uploaded beforehand, ≤ 20 (see [Files](./rest-files)) |
| `replyToId` | string | Id of the message this one answers |
| `nonce` | string | Idempotency key, ≤ 64 characters |
| `stickerId` | string | A sticker instead of text (see [Stickers](./rest-stickers)) |
| `inlineKeyboard` | object | Inline buttons (see [Commands and buttons](./commands-buttons)) |

`nonce` protects against duplicates: repeating a request with the same `nonce` returns the same message with `200` instead of `201`. Generate it once per message and reuse it on network errors and `429`.

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$ROOM/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content": "Hi! I am a bot.", "nonce": "hello-1"}'
```

```js tab="JavaScript"
import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, { server: 'https://app.example.com' });
const message = await bot.send(roomId, { text: 'Hi! I am a bot.', nonce: 'hello-1' });
```

```python tab="Python"
import os, requests

CALAB = "https://app.example.com"
H = {"Authorization": f"Bearer {os.environ['BOT_TOKEN']}"}
r = requests.post(f"{CALAB}/api/rooms/{room_id}/messages", headers=H,
                  json={"content": "Hi! I am a bot.", "nonce": "hello-1"})
message = r.json()["message"]
```

Response `201`:

```json
{
  "message": {
    "id": "0192a1c4-7b2e-7d10-9a51-3f2b8c0e1d77",
    "roomId": "0191f0aa-2c3d-7e4f-8a9b-1c2d3e4f5a6b",
    "authorId": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
    "content": "Hi! I am a bot.",
    "attachments": [],
    "replyToId": "",
    "nonce": "hello-1",
    "createdAt": "2026-10-14T10:01:02.345Z",
    "reactions": [],
    "kind": "MESSAGE_KIND_UNSPECIFIED",
    "embedsHidden": false
  }
}
```

Fields with default values are always present in responses; `uint64` fields (such as `keyboardRevision` or a file's `size`) are strings.

### Reply and mention

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$ROOM/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"content\": \"Done, @$USER\", \"replyToId\": \"$MSG\", \"nonce\": \"r-1\"}"
```

```js tab="JavaScript"
bot.on('message', async (m) => {
  if (m.content.includes('report')) await bot.reply(m, 'Done');   // replyToId = m.id
});
```

### Attach a file

Upload the file to the workspace (or to the DM) first, then pass its id in `attachmentIds`. The SDK does both steps for you.

```sh tab="curl"
curl -s -X POST $CALAB/api/workspaces/$WS/files -H "Authorization: Bearer $TOKEN" -F file=@report.pdf
# {"file": {"id": "0192b3…", "name": "report.pdf", "mime": "application/pdf", "size": "48213", "url": "/api/files/0192b3…", …}}
curl -s -X POST $CALAB/api/rooms/$ROOM/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content": "Report", "attachmentIds": ["0192b3…"], "nonce": "rep-1"}'
```

```js tab="JavaScript"
import { readFile } from 'node:fs/promises';

await bot.send(roomId, {
  text: 'Report',
  files: [{ name: 'report.pdf', data: await readFile('report.pdf') }],
});
```

## Edit and delete

`PATCH /api/messages/{id}` takes an `UpdateMessageRequest {content, inlineKeyboard, preserveContent}`:

- `content` replaces the whole text; empty text is allowed only when the message has attachments;
- `inlineKeyboard` omitted keeps the keyboard; `{}` or `{"rows": []}` removes it;
- `preserveContent: true` edits only the keyboard: the text stays and `content` must be omitted;
- every text or keyboard edit changes the server-owned `keyboardRevision`.

```sh tab="curl"
curl -s -X PATCH $CALAB/api/messages/$MSG \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content": "Report (fixed)"}'
curl -s -X DELETE $CALAB/api/messages/$MSG -H "Authorization: Bearer $TOKEN"   # → 204
```

```js tab="JavaScript"
await bot.edit(messageId, 'Report (fixed)');
await bot.edit(messageId, { inlineKeyboard: { rows: [] } }); // remove buttons, keep text
await bot.deleteMessage(messageId);
```

## Forward

`POST /api/rooms/{id}/messages/{mid}/forward {toRoomId}` creates a copy in the target room with a `forward` field (where the message came from and whose it was). Inline buttons are never active on forwarded copies.

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$ROOM/messages/$MSG/forward \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"toRoomId\": \"$OTHER_ROOM\"}"
```

```js tab="JavaScript"
const copy = await bot.forward(roomId, messageId, otherRoomId);
```

## Reactions

The emoji goes in the path, URL-encoded. The answer is `204`. One member can put at most 3 different reactions on a message (`409 CONFLICT`, `reason: "REACTION_LIMIT"`); a message holds up to 20 different emoji in total. A room holds up to 50 pinned messages.

```sh tab="curl"
curl -s -X PUT "$CALAB/api/messages/$MSG/reactions/%F0%9F%91%8D" -H "Authorization: Bearer $TOKEN"   # 👍 → 204
curl -s "$CALAB/api/messages/$MSG/reactions/%F0%9F%91%8D?limit=50" -H "Authorization: Bearer $TOKEN"
# {"users": [{"id": "…", "displayName": "Anna", …}], "hasMore": false}
```

```js tab="JavaScript"
await bot.react(messageId, '👍');
await bot.unreact(messageId, '👍');
```

## History and a single message

`GET /api/rooms/{id}/messages` returns `{messages, hasMore}`, newest first. Page back with `before=<oldest id>`, forward with `after=`.

`GET /api/rooms/{id}/messages/{messageId}` returns **`200` with a bare `Message`** — not `{message: …}`. Its fields and detail loading match a history item: `id`, `roomId`, `authorId`, `content`, `replyToId`, `attachments`, `reactions` (`me` is relative to the caller), timestamps, `kind`, `system`, `sticker`, `forward`. `command` is unset, as in every REST response.

```js tab="JavaScript"
const { messages, hasMore } = await bot.messages(roomId, { limit: 50 });
const one = await bot.message(roomId, messageId);
```

```sh tab="curl"
curl -s "$CALAB/api/rooms/$ROOM/messages?limit=50" -H "Authorization: Bearer $TOKEN"
curl -s $CALAB/api/rooms/$ROOM/messages/$MSG -H "Authorization: Bearer $TOKEN"
```

`404 NOT_FOUND` means one of: the room is not accessible, the message is missing or deleted, it belongs to another room, or it is at or before the caller's cleared DM history marker. The other participant of a DM keeps their own history. Reading needs neither `SEND_MESSAGES` nor a voice connection.

### System messages

Cards created by the server arrive with `kind: "MESSAGE_KIND_SYSTEM"` and a `system` field:

| `system.…` | What it is |
|---|---|
| `recording {recordingId}` | A meeting recording card: use `recordingId` in the transcript URL |
| `achievement {achievementId, grantId, note, grantedBy}` | A granted achievement; the author is the recipient |
| `automation {boardId, taskId, ruleId, ruleName, text}` | A board automation rule's message. `text` is plain text without mentions or markup and pings nobody; `authorId` is the rule's creator. Show it as “Automation: ruleName” |
| `roomIcon {fileId}` | The room picture changed (empty = removed); the author is whoever changed it. The picture itself is the room's `iconFileId` |

A command replying to a card has `replyToId` set to the card's **message** id.

## Read marker

`PUT /api/rooms/{id}/read {messageId}` only moves the marker forward. A bot never gives people's messages the “read” ✓✓ mark and gets no read receipts itself.

## Meeting transcript

`GET /api/rooms/{id}/recordings/{rid}/transcript` returns `200` with the whole saved transcript, no pagination:

```json
{
  "recordingId": "0192a100-0000-7000-8000-000000000001",
  "language": "en",
  "segments": [
    {"speaker": 0, "startMs": 480, "endMs": 6900, "text": "First segment."},
    {"speaker": -1, "startMs": 7200, "endMs": 12050, "text": "Unknown speaker."}
  ]
}
```

`startMs` / `endMs` are numbers in milliseconds from the start of the recording; `speaker` is a zero-based recognition label, or `-1` when unknown; `language` may be empty.

```js tab="JavaScript"
const t = await bot.transcript(roomId, recordingId);
for (const s of t.segments) console.log(s.speaker, s.text);
```

```sh tab="curl"
curl -s $CALAB/api/rooms/$ROOM/recordings/$REC/transcript -H "Authorization: Bearer $TOKEN"
```

`404 NOT_FOUND` means the room is not accessible, the recording is missing or deleted, no transcript is saved yet, or the room has neither the original recording nor a live forwarded copy of its card. Use the `roomId` of the card you see, a forwarded one included; deleting the only forwarded copy revokes access to the transcript.

> [!WARNING]
> `VIEW_ROOM` gives a bot the **whole** saved transcript available through that room, closed-room rules included. It does not grant recording controls (start and stop need `MANAGE_RECORDINGS`, see [Rooms and voice](./rest-rooms)).

## Gotchas

> [!TIP]
> On `429 RATE_LIMITED`, wait `Retry-After` seconds and retry **with the same `nonce`** — no duplicate appears. Limits are listed in [Errors and limits](./errors-limits).

> [!NOTE]
> Messages written by bots never become commands, so bot ↔ bot loops cannot happen. How to address a `/command` to a bot is covered in [Commands and buttons](./commands-buttons).

> [!NOTE]
> In a suspended workspace writing is refused (`403 WORKSPACE_SUSPENDED`); reading still works.
