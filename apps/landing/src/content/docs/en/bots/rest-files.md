---
title: Files
description: Upload files to a workspace, a DM or a task, download them and fetch thumbnails.
order: 11
---

In Calab, files are uploaded separately from messages: first the file, then its id in a message's or task's `attachmentIds`. Downloads and thumbnails need the same `Authorization` header as the rest of the API — there are no public file links.

| Action | Permission |
|---|---|
| upload to a workspace or a DM | `ATTACH_FILES` |
| upload for a task | the task permissions (`CREATE_TASKS` / `EDIT_TASKS`) |
| download, thumbnail | access to the room, task or object that uses the file |

## Routes

<!-- routes:files -->
| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/workspaces/{id}/files` | Upload a file to the workspace (multipart `file`) → `{file}` |
| `POST` | `/api/dms/{id}/files` | Upload a file into a DM → `{file}` |
| `POST` | `/api/boards/{id}/files` | Upload a file for a task description or comment → `{file}` |
| `GET` | `/api/files/{id}` | Download a file |
| `GET` | `/api/files/{id}/thumbnail` | An image thumbnail |
<!-- /routes -->

### Not available to bots

`POST /api/files/convert` — HEIC to JPEG conversion for clients without a HEIF decoder; an app helper route, not part of the bot API.

## Upload

The answer is a `FileMeta`:

| Field | Description |
|---|---|
| `id` | The file id — pass it in `attachmentIds` |
| `name`, `mime` | Name and type (the server detects the type from the content) |
| `size` | Size in bytes — a **string** (`uint64`) |
| `width`, `height` | For images, `0` otherwise |
| `sha256` | Hash computed by the server while receiving |
| `url`, `thumbnailUrl` | `/api/files/{id}` and `/api/files/{id}/thumbnail` (images only) |

```sh tab="curl"
curl -s -X POST $CALAB/api/workspaces/$WS/files -H "Authorization: Bearer $TOKEN" -F file=@chart.png
```

```js tab="JavaScript"
import { readFile } from 'node:fs/promises';

// upload to the room's workspace (or the DM) and send in one call
await bot.send(roomId, { text: 'Weekly chart', files: [{ name: 'chart.png', data: await readFile('chart.png') }] });
// or upload only
const meta = await bot.upload(roomId, { name: 'chart.png', data: await readFile('chart.png'), type: 'image/png' });
```

```python tab="Python"
with open("chart.png", "rb") as f:
    r = requests.post(f"{CALAB}/api/workspaces/{ws_id}/files", headers=H,
                      files={"file": ("chart.png", f, "image/png")})
file_id = r.json()["file"]["id"]
```

```json
{
  "file": {
    "id": "0192b3f0-0000-7000-8000-0000000000f1",
    "workspaceId": "0191f0aa-0000-7000-8000-000000000001",
    "uploaderId": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
    "name": "chart.png",
    "mime": "image/png",
    "size": "48213",
    "width": 1200,
    "height": 800,
    "sha256": "9f2c…",
    "url": "/api/files/0192b3f0-0000-7000-8000-0000000000f1",
    "thumbnailUrl": "/api/files/0192b3f0-0000-7000-8000-0000000000f1/thumbnail",
    "createdAt": "2026-10-14T10:00:00Z"
  }
}
```

## Download

```sh tab="curl"
curl -s -L -o chart.png $CALAB/api/files/$FILE -H "Authorization: Bearer $TOKEN"
```

```python tab="Python"
data = requests.get(f"{CALAB}/api/files/{file_id}", headers=H).content
```

## Limits

| Limit | Value |
|---|---|
| Bot uploads | 30 at once, 120 per hour |
| File size and storage quota | by the workspace plan (`413 FILE_TOO_LARGE`, `413 FILE_QUOTA_EXCEEDED`) |
| Attachments per message | ≤ 20 |

> [!NOTE]
> Files for badges and sounds are ordinary bot uploads to the same workspace: `POST /api/workspaces/{id}/files` first, then `fileId` in the request. Sticker images are uploaded straight into a pack — see [Stickers](./rest-stickers).
