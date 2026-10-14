---
title: Stickers
description: Send stickers, list workspace packs, install packs for the bot and manage packs.
order: 12
---

A bot sends stickers as ordinary messages, installs packs for itself and — with `MANAGE_STICKERS` — creates and changes the workspace's packs.

| Action | Permission |
|---|---|
| see packs, send stickers, install packs for itself | workspace member (not a guest) |
| create, change, delete packs and stickers | `MANAGE_STICKERS` |

## Routes

<!-- routes:stickers -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/workspaces/{id}/sticker-packs` | The workspace's packs → `{packs}` |
| `POST` | `/api/workspaces/{id}/sticker-packs` | Create a pack `{name, shortName}` → `201 {pack}` (`MANAGE_STICKERS`) |
| `GET` | `/api/sticker-packs/{id}` | One pack → `{pack}` |
| `PATCH` | `/api/sticker-packs/{id}` | Change a pack `{name?, shortName?, coverStickerId?, stickerIds}` |
| `DELETE` | `/api/sticker-packs/{id}` | Delete a pack |
| `POST` | `/api/sticker-packs/{id}/stickers` | Add stickers (multipart: `emoji` + `file` pairs) → `{pack, added}` |
| `PUT` | `/api/sticker-packs/{id}/stickers/{sid}` | Replace a sticker's picture and/or emoji (multipart `file`, `emoji`) |
| `PATCH` | `/api/stickers/{id}` | Change a sticker's emoji `{emoji}` |
| `DELETE` | `/api/stickers/{id}` | Delete a sticker |
| `GET` | `/api/me/sticker-packs` | The bot's installed packs and available ones → `{installed, available}` |
| `PUT` | `/api/me/sticker-packs/order` | Order of installed packs `{packIds}` |
| `PUT` | `/api/me/sticker-packs/{id}` | Install a pack for the bot |
| `DELETE` | `/api/me/sticker-packs/{id}` | Uninstall a pack |
<!-- /routes -->

Built-in sticker pictures are served by the public `GET /api/stickers/builtin/{name}`, no authentication needed.

## Send a sticker

`POST /api/rooms/{id}/messages {stickerId, nonce}` — with empty `content` and no attachments. The sticker must come from a pack of this workspace; in a DM — from a pack of a workspace where neither participant is a guest.

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$ROOM/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"stickerId\": \"$STICKER\", \"nonce\": \"st-1\"}"
```

```js tab="JavaScript"
const packs = await bot.stickers.list(wsId);
await bot.send(roomId, { stickerId: packs[0].stickers[0].id });
```

## Create a pack

```sh tab="curl"
curl -s -X POST $CALAB/api/workspaces/$WS/sticker-packs -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name": "Cats", "shortName": "cats"}'          # → 201 {"pack": {…}}
curl -s -X POST $CALAB/api/sticker-packs/$PACK/stickers -H "Authorization: Bearer $TOKEN" \
  -F emoji=😺 -F file=@cat1.webp -F emoji=😿 -F file=@cat2.webp                         # → {"pack", "added": […]}
```

```js tab="JavaScript"
import { readFile } from 'node:fs/promises';

const pack = await bot.stickers.createPack(wsId, { name: 'Cats', shortName: 'cats' });
const { added } = await bot.stickers.addStickers(pack.id, [
  { emoji: '😺', data: await readFile('cat1.webp') },
  { emoji: '😿', data: await readFile('cat2.webp') },
]);
await bot.stickers.remove(added[1].id);
```

- Each `file` is preceded by an `emoji` field (one emoji sequence — stickers are searched by it).
- The file is WebP, sides ≤ 512 px, ≤ 512 KB static or ≤ 1 MB animated.
- Up to 50 stickers per request, all or nothing: one bad file gives `422`, `field: "file[i]"`.
- ≤ 120 stickers per pack; `shortName` is `[a-z0-9_]{1,32}`, unique among the workspace's packs.
- Plan limits on packs and stickers — `409 PLAN_LIMIT` with `used`/`limit`.

## The bot's own packs

`GET /api/me/sticker-packs` returns `{installed, available}`: installed packs in their order, and live packs of the bot's workspaces it has not installed. `PUT /api/me/sticker-packs/{id}` installs a pack first in the order (at most 50 installed, else `422`); every `me/sticker-packs` route answers with the same `{installed, available}`.
