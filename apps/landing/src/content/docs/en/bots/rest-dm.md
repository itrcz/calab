---
title: Direct messages
description: How a bot opens a direct message with a member, writes to it, uploads files, and what blocking a bot means.
order: 10
---

A bot can write a direct message to any member of a shared workspace except guests. A DM is a room of type `ROOM_TYPE_DM` without a workspace: messages, reactions, pins and the read marker use the ordinary room and message routes (see [Messages](./rest-messages)); files are uploaded through a separate route.

## Routes

<!-- routes:dm -->
| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/dms` | Open (or find) the DM with a member `{userId}` → `{dm}`: `201` when created, `200` when it existed |
| `GET` | `/api/dms` | The bot's DMs, most recent first (≤ 500) → `{dms}` |
| `GET` | `/api/dms/candidates` | Whom the bot may write to: `?q=` by name or nickname (≤ 20) → `{users}` |
| `POST` | `/api/dms/{id}/files` | Upload a file into the DM (multipart `file`) → `{file}` |
<!-- /routes -->

### Not available to bots

- Archiving and “Delete chat” for yourself: `PATCH /api/dms/{id}/state`.
- One-to-one calls: `POST /api/dms/{id}/call`, `/api/calls/{id}/accept · decline · cancel · hangup` — a bot neither calls nor answers, and nobody can call a bot.
- The list of blocked bots `/api/me/blocked-bots…` — that is a person's setting.

## Open and write

`POST /api/dms {userId}` is allowed when both are full members (not guests) of a shared workspace, or when the DM already exists. A guest account on either side — `403`; yourself — `422`; an unknown user or no shared workspace — `404`. The answer is a `DmSummary {room, peer, readState, lastMessageAt}`; write to `dm.room.id`.

```sh tab="curl"
curl -s -X POST $CALAB/api/dms -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"userId\": \"$USER\"}"
# → {"dm": {"room": {"id": "0192d0…", "type": "ROOM_TYPE_DM", "workspaceId": "", …}, "peer": {"id": "…", "displayName": "Anna", …}, …}}
curl -s -X POST $CALAB/api/rooms/$DM_ROOM/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content": "Reminder: the report is due Friday", "nonce": "dm-1"}'
```

```js tab="JavaScript"
const dm = await bot.dm(userId);
await bot.send(dm.room.id, 'Reminder: the report is due Friday');
```

```python tab="Python"
dm = requests.post(f"{CALAB}/api/dms", headers=H, json={"userId": user_id}).json()["dm"]
requests.post(f"{CALAB}/api/rooms/{dm['room']['id']}/messages", headers=H,
              json={"content": "Reminder: the report is due Friday", "nonce": "dm-1"})
```

When a person opens a DM with the bot, the bot gets a `dmCreate` event, and new messages arrive as `messageCreate` (see [Gateway](./gateway)). In a DM with a bot, a `/command` is addressed to that bot — see [Commands and buttons](./commands-buttons).

## Files

A DM has no workspace, so files are uploaded into the DM itself: `POST /api/dms/{id}/files` (multipart `file`), then the id goes into `attachmentIds`. The SDK's `bot.send(roomId, {files})` picks the right route for you.

```sh tab="curl"
curl -s -X POST $CALAB/api/dms/$DM_ROOM/files -H "Authorization: Bearer $TOKEN" -F file=@invoice.pdf
```

## Blocking

A person can block a bot. From then on the bot cannot open a new DM with them or write to the existing one: `403`, code `BOT_BLOCKED`. A person who blocked a bot also stops getting their task notices forwarded to it.

## Limits

| Limit | Value |
|---|---|
| New DMs | 10 at once, 30 per hour (`429`) |
| Bot messages | 20 per minute across all rooms and DMs, plus the common 5 per 5 seconds per room |

> [!NOTE]
> A person's “Delete chat” is for themselves only: the bot keeps its history. Messages before the person's cleared marker are no longer visible to them.
