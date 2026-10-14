---
title: Календарь
description: Встречи пространства — чтение, создание, изменение и отмена от имени бота, занятость участников и подбор времени.
order: 9
---

Бот читает календарь пространства, назначает встречи, меняет и отменяет их, смотрит занятость людей и подбирает общее свободное время. Бот **организует встречи, но никогда в них не участвует**: он не отвечает на приглашения и не имеет своего «сегодня» и внешнего календаря.

| Действие | Право |
|---|---|
| видеть встречи | свои (бот — организатор) и встречи комнат, где есть `VIEW_ROOM` |
| создать встречу | не гость; комната встречи, если указана, — голосовая комната, которую видит бот |
| изменить, отменить | свою; чужую — `MANAGE_ROOM` в её комнате или `MANAGE_EVENTS` |
| занятость, подбор времени | не гость |

## Маршруты

<!-- routes:calendar -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/workspaces/{id}/events` | Встречи в окне `?from=&to=` (RFC 3339, окно ≤ 62 дней) → `{events}` |
| `POST` | `/api/workspaces/{id}/events` | Создать встречу → `201 {event}` |
| `GET` | `/api/events/{id}` | Одна встреча → `{event}` |
| `PATCH` | `/api/events/{id}` | Изменить встречу или одно повторение `?occurrence=` |
| `DELETE` | `/api/events/{id}` | Отменить встречу или одно повторение `?occurrence=` |
| `GET` | `/api/workspaces/{id}/freebusy` | Занятость `?users=<id,id,…>&from=&to=` (≤ 20 человек, окно ≤ 14 дней) → `{users}` |
| `POST` | `/api/workspaces/{id}/freebusy/suggest` | Подобрать общее свободное окно → `{slots}` |
<!-- /routes -->

### Недоступно ботам

`403 BOT_NOT_ALLOWED`: ответ на приглашение `PUT /api/events/{id}/rsvp`, «сегодня» `GET /api/me/events/today`, внешние календари CalDAV (`/api/me/caldav…`, `/api/me/external-events…`). Бот не участник встреч и не подключает внешний календарь.

## Создать встречу

`CreateCalendarEventRequest`: `title` (1..120), `description` (≤ 4000), `roomId` (голосовая комната, пусто — без комнаты), `startsAt`, `endsAt` (позже начала, не дальше 7 дней), `allDay`, `tz` (IANA; пусто — пояс профиля, иначе UTC), `record`, `repeat` (`EVENT_REPEAT_DAILY`, `…_WEEKLY`, `…_BIWEEKLY`, `…_MONTHLY`), `repeatUntil`, `attendees: [{userId, required} | {email}]`.

- Бот — организатор (`organizerId` = id бота), но не участник: указать себя в `attendees` — `422`. Боты и гости участниками встреч не бывают.
- Приглашения и `invite.ics` уходят с системного адреса как «Пространство (от имени бота X)», без `Reply-To` и без гостевых ссылок на комнату: внешние участники получают ссылку на страницу встречи.
- Адреса внешних участников видны боту, только если он может менять встречу.

```sh tab="curl"
curl -s -X POST $CALAB/api/workspaces/$WS/events \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"title\": \"Стендап\", \"roomId\": \"$VOICE\",
       \"startsAt\": \"2026-10-20T09:00:00Z\", \"endsAt\": \"2026-10-20T09:30:00Z\",
       \"tz\": \"Europe/Moscow\", \"repeat\": \"EVENT_REPEAT_WEEKLY\",
       \"attendees\": [{\"userId\": \"$USER\", \"required\": true}, {\"email\": \"partner@example.com\"}]}"
```

```js tab="JavaScript"
import { timestampFromDate } from '@bufbuild/protobuf/wkt';

const ev = await bot.calendar.create(wsId, {
  title: 'Стендап',
  roomId,
  startsAt: timestampFromDate(new Date('2026-10-20T09:00:00Z')),
  endsAt: timestampFromDate(new Date('2026-10-20T09:30:00Z')),
  tz: 'Europe/Moscow',
  attendees: [{ userId, required: true }],
});
```

```python tab="Python"
r = requests.post(f"{CALAB}/api/workspaces/{ws_id}/events", headers=H, json={
    "title": "Стендап", "roomId": voice_id,
    "startsAt": "2026-10-20T09:00:00Z", "endsAt": "2026-10-20T09:30:00Z",
    "tz": "Europe/Moscow", "attendees": [{"userId": user_id, "required": True}],
})
event = r.json()["event"]
```

Ответ `201`:

```json
{
  "event": {
    "id": "0192c0e1-0000-7000-8000-0000000000e7",
    "workspaceId": "0191f0aa-0000-7000-8000-000000000001",
    "roomId": "0192a2d0-1111-7000-8000-00000000a001",
    "title": "Стендап",
    "startsAt": "2026-10-20T09:00:00Z",
    "endsAt": "2026-10-20T09:30:00Z",
    "allDay": false,
    "tz": "Europe/Moscow",
    "organizerId": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
    "repeat": "EVENT_REPEAT_WEEKLY",
    "canEdit": true,
    "attendees": [],
    "sequence": 0
  }
}
```

## Читать, менять, отменять

```js tab="JavaScript"
const events = await bot.calendar.list(wsId, new Date('2026-10-20'), new Date('2026-10-27'));
await bot.calendar.update(ev.id, { title: 'Стендап (перенос)' });
await bot.calendar.delete(ev.id, new Date('2026-10-27T09:00:00Z'));   // одно повторение
await bot.calendar.delete(ev.id);                                     // всю серию
```

```sh tab="curl"
curl -s "$CALAB/api/workspaces/$WS/events?from=2026-10-20T00:00:00Z&to=2026-10-27T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN"
curl -s -X DELETE "$CALAB/api/events/$EVENT?occurrence=2026-10-27T09:00:00Z" -H "Authorization: Bearer $TOKEN"
```

В списке каждое повторение серии приходит отдельной записью с `occurrenceAt`. Изменения рассылаются участникам (поле `sequence` растёт). Внешние адреса в чужих встречах боту менять нельзя (`403`).

## Занятость и подбор времени

`GET /api/workspaces/{id}/freebusy?users=&from=&to=` — интервалы занятости до 20 участников (не гостей и не ботов) в окне до 14 дней; учитываются встречи всех пространств человека. Бот видит **только занятость**: без названий и участников внешних событий. Ответ — `{users: [{userId, timezone, workHours, busy: [{startsAt, endsAt, kind}]}]}`. Лимит — 60 запросов в минуту.

`POST /api/workspaces/{id}/freebusy/suggest {users, durationMin, from, to, withinWorkHours, roomId}` возвращает до 10 самых ранних окон на сетке 15 минут, где свободны все (и комната, если указана). `withinWorkHours` и рабочие часы не пересекаются — `409 NO_COMMON_HOURS`. Лимит — 30 запросов в минуту.

```js tab="JavaScript"
const busy = await bot.calendar.freebusy(wsId, [userA, userB], from, to);
const slots = await bot.calendar.suggest(wsId, {
  users: [userA, userB], durationMin: 30,
  from: timestampFromDate(from), to: timestampFromDate(to), withinWorkHours: true,
});
```

```sh tab="curl"
curl -s "$CALAB/api/workspaces/$WS/freebusy?users=$USER_A,$USER_B&from=2026-10-20T00:00:00Z&to=2026-10-21T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN"
```

> [!TIP]
> События `eventCreate`, `eventUpdate`, `eventDelete` и `eventRsvp` приходят через [Gateway](./gateway) и [Вебхуки](./webhooks) — для встреч, которые организует бот, и встреч комнат, которые он видит.
