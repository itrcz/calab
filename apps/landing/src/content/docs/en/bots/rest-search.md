---
title: Search
description: Unified search across messages, tasks, meetings, files and transcripts, workspace message search and the bot's mentions.
order: 13
---

A bot searches by the same rules as a person: results include only what its roles allow — messages of rooms with `VIEW_ROOM`, tasks of boards with `VIEW_BOARD`, meetings the bot organizes and meetings of rooms it sees. The notes section is always empty for a bot.

## Routes

<!-- routes:search -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/search` | Unified search: `?q=&scope=<workspace id>\|all&types=&type=&limit=&cursor=&sort=` → `{sections}` |
| `GET` | `/api/workspaces/{id}/messages/search` | Full-text search over the workspace's messages: `?q=&room_id=&author_id=&before=&limit=` (≤ 50) → `{messages, hasMore}` |
| `GET` | `/api/me/mentions` | Messages that mention the bot (`@<id>`, `@everyone`, `@here`): `?before=&limit=&workspace_id=` → `{messages, hasMore}` |
<!-- /routes -->

Search within one room is `GET /api/rooms/{id}/messages?q=`, see [Messages](./rest-messages). Task search by key is `GET /api/workspaces/{id}/tasks/search`, see [Boards and tasks](./rest-boards).

## Unified search

| Parameter | Description |
|---|---|
| `q` | 1..200 characters. Words match by stem (Russian) and as written; the last word of 2+ characters also matches as a prefix (“rel” finds “release”); `"exact phrase"`, `-excluded` and `OR` work. Short fields (task and meeting titles, file names) also match with typos. A task key `ABC-12` finds that task first |
| `scope` | A workspace id (the bot must be a member, else `404`) or `all` — every workspace of the bot and its DMs. Required |
| `types` | Comma-separated: `messages`, `task_comments`, `tasks`, `events`, `files`, `transcripts` (default: all). An unknown name is `400` |
| `type` | One section as a feed with a cursor (“All results”); overrides `types` |
| `limit` | Summary — 1..20 per section (default 4); feed — 1..20 (default 20) |
| `cursor` | `nextCursor` of the previous page of the same `q` / `scope` / `type` / `sort` |
| `sort` | `relevance` (default) or `new` |

The answer lists the sections in type order, each present even when empty: `{type, items, totalEstimate, nextCursor, timedOut}`. `totalEstimate` counts up to 1000 (“1000 or more”) and only on the first page. A `SearchHit` has `snippet` (plain text; matched words are wrapped in the characters U+0002 … U+0003 — replace them with your own highlighting), `title`, `workspaceId`, `at`, `authorId` and one reference: `message`, `taskComment`, `task`, `event`, `file` or `transcript` (with `recordingId`, `roomId`, `offsetMs`).

```sh tab="curl"
curl -s "$CALAB/api/search?q=certificate&scope=$WS&types=messages,tasks" -H "Authorization: Bearer $TOKEN"
```

```js tab="JavaScript"
const res = await bot.rest.request('GET', '/api/search', {
  query: { q: 'certificate', scope: wsId, types: 'messages,tasks' },
});
for (const section of res.sections) console.log(section.type, section.items.length);
```

```python tab="Python"
r = requests.get(f"{CALAB}/api/search", headers=H,
                 params={"q": "certificate", "scope": ws_id, "types": "messages,tasks"})
for section in r.json()["sections"]:
    print(section["type"], len(section["items"]))
```

```json
{
  "sections": [
    {
      "type": "SEARCH_TYPE_MESSAGES",
      "items": [
        {
          "snippet": "…renew the \u0002certificate\u0003 by Friday…",
          "title": "#ops",
          "workspaceId": "0191f0aa-0000-7000-8000-000000000001",
          "at": "2026-10-13T15:20:00Z",
          "authorId": "0191c2d3-0000-7000-8000-000000000042",
          "message": {"messageId": "0192a1c4-7b2e-7d10-9a51-3f2b8c0e1d77", "roomId": "0191f0aa-2c3d-7e4f-8a9b-1c2d3e4f5a6b"}
        }
      ],
      "totalEstimate": 1,
      "nextCursor": "",
      "timedOut": false
    },
    {"type": "SEARCH_TYPE_TASKS", "items": [], "totalEstimate": 0, "nextCursor": "", "timedOut": false}
  ]
}
```

> [!NOTE]
> Unified search is limited to 30 requests at once and one per second per user (`429 RATE_LIMITED`). A query with no words left after removing punctuation gives `422` with `field: "q"`.

## The bot's mentions

`GET /api/me/mentions` lists messages that mention the bot, newest first, only from rooms the bot sees. Handy for a bot that runs without the gateway and polls on a schedule.

```sh tab="curl"
curl -s "$CALAB/api/me/mentions?limit=20" -H "Authorization: Bearer $TOKEN"
```

> [!TIP]
> Mentioning a bot in text is an ordinary `@<bot id>`. A bot connected to the [gateway](./gateway) or a [webhook](./webhooks) gets mentions at once in `messageCreate` events — no polling needed.
