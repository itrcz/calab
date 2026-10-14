---
title: Поиск
description: Единый поиск по сообщениям, задачам, встречам, файлам и расшифровкам, поиск по сообщениям пространства и упоминания бота.
order: 13
---

Бот ищет по тем же правилам, что и человек: в выдачу попадает только то, что разрешают права его ролей, — сообщения комнат с `VIEW_ROOM`, задачи досок с `VIEW_BOARD`, встречи, которые бот организует, и встречи видимых комнат. Раздел заметок для бота всегда пуст.

## Маршруты

<!-- routes:search -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/search` | Единый поиск: `?q=&scope=<id пространства>\|all&types=&type=&limit=&cursor=&sort=` → `{sections}` |
| `GET` | `/api/workspaces/{id}/messages/search` | Полнотекстовый поиск по сообщениям пространства: `?q=&room_id=&author_id=&before=&limit=` (≤ 50) → `{messages, hasMore}` |
| `GET` | `/api/me/mentions` | Сообщения, где упомянут бот (`@<id>`, `@everyone`, `@here`): `?before=&limit=&workspace_id=` → `{messages, hasMore}` |
<!-- /routes -->

Поиск внутри одной комнаты — `GET /api/rooms/{id}/messages?q=`, см. [Сообщения](./rest-messages). Поиск задач по ключу — `GET /api/workspaces/{id}/tasks/search`, см. [Доски и задачи](./rest-boards).

## Единый поиск

| Параметр | Описание |
|---|---|
| `q` | 1..200 символов. Слова ищутся по основе (русский) и как написаны; последнее слово от 2 символов — ещё и как префикс («рел» найдёт «релиз»); работают `"точная фраза"`, `-исключение` и `OR`. Короткие поля (названия задач и встреч, имена файлов) находятся и с опечатками. Ключ задачи `ABC-12` находит её первой |
| `scope` | id пространства (бот должен быть участником, иначе `404`) или `all` — все пространства бота и его личные сообщения. Обязателен |
| `types` | Через запятую: `messages`, `task_comments`, `tasks`, `events`, `files`, `transcripts` (по умолчанию все). Неизвестное имя — `400` |
| `type` | Один раздел лентой с курсором («Все результаты»); заменяет `types` |
| `limit` | Сводка — 1..20 на раздел (по умолчанию 4); лента — 1..20 (по умолчанию 20) |
| `cursor` | `nextCursor` предыдущей страницы того же `q` / `scope` / `type` / `sort` |
| `sort` | `relevance` (по умолчанию) или `new` |

Ответ — разделы в порядке типов, каждый присутствует, даже если пуст: `{type, items, totalEstimate, nextCursor, timedOut}`. `totalEstimate` считается до 1000 («1000 или больше») и только на первой странице. Элемент `SearchHit` — `snippet` (простой текст; найденные слова обёрнуты в символы U+0002 … U+0003 — замените их на свою подсветку), `title`, `workspaceId`, `at`, `authorId` и одна ссылка на объект: `message`, `taskComment`, `task`, `event`, `file` или `transcript` (с `recordingId`, `roomId`, `offsetMs`).

```sh tab="curl"
curl -s "$CALAB/api/search?q=сертификат&scope=$WS&types=messages,tasks" -H "Authorization: Bearer $TOKEN"
```

```js tab="JavaScript"
const res = await bot.rest.request('GET', '/api/search', {
  query: { q: 'сертификат', scope: wsId, types: 'messages,tasks' },
});
for (const section of res.sections) console.log(section.type, section.items.length);
```

```python tab="Python"
r = requests.get(f"{CALAB}/api/search", headers=H,
                 params={"q": "сертификат", "scope": ws_id, "types": "messages,tasks"})
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
          "snippet": "…продлить \u0002сертификат\u0003 до пятницы…",
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
> Лимит единого поиска — 30 запросов сразу и один в секунду на пользователя (`429 RATE_LIMITED`). Запрос без слов после удаления знаков препинания — `422` с `field: "q"`.

## Упоминания бота

`GET /api/me/mentions` — сообщения, где упомянут бот, новые сверху, только из комнат, которые бот видит. Удобно, если бот работает без gateway и опрашивает сервер по расписанию.

```sh tab="curl"
curl -s "$CALAB/api/me/mentions?limit=20" -H "Authorization: Bearer $TOKEN"
```

> [!TIP]
> Упоминание бота в тексте — обычное `@<id бота>`. Если бот подключён к [Gateway](./gateway) или [вебхуку](./webhooks), упоминания приходят сразу в событиях `messageCreate` — опрашивать не нужно.
