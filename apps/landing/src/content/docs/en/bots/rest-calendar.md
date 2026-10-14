---
title: Calendar
description: Workspace meetings — read, create, change and cancel them as a bot, check members' free/busy time and find a slot.
order: 9
---

A bot reads the workspace calendar, books meetings, changes and cancels them, checks people's busy time and finds a common free slot. A bot **organizes meetings but never attends them**: it does not answer invitations and has no “today” view or external calendar of its own.

| Action | Permission |
|---|---|
| see meetings | its own (the bot organizes them) and meetings of rooms where it has `VIEW_ROOM` |
| create a meeting | not a guest; the meeting room, if set, is a voice room the bot sees |
| change, cancel | its own; someone else's — `MANAGE_ROOM` in the meeting's room or `MANAGE_EVENTS` |
| free/busy, find a time | not a guest |

## Routes

<!-- routes:calendar -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/workspaces/{id}/events` | Meetings in a window `?from=&to=` (RFC 3339, window ≤ 62 days) → `{events}` |
| `POST` | `/api/workspaces/{id}/events` | Create a meeting → `201 {event}` |
| `GET` | `/api/events/{id}` | One meeting → `{event}` |
| `PATCH` | `/api/events/{id}` | Change a meeting or one occurrence `?occurrence=` |
| `DELETE` | `/api/events/{id}` | Cancel a meeting or one occurrence `?occurrence=` |
| `GET` | `/api/workspaces/{id}/freebusy` | Busy time `?users=<id,id,…>&from=&to=` (≤ 20 people, window ≤ 14 days) → `{users}` |
| `POST` | `/api/workspaces/{id}/freebusy/suggest` | Find a common free window → `{slots}` |
<!-- /routes -->

### Not available to bots

`403 BOT_NOT_ALLOWED`: answering an invitation `PUT /api/events/{id}/rsvp`, “today” `GET /api/me/events/today`, external CalDAV calendars (`/api/me/caldav…`, `/api/me/external-events…`). A bot is never an attendee and connects no external calendar.

## Create a meeting

`CreateCalendarEventRequest`: `title` (1..120), `description` (≤ 4000), `roomId` (a voice room; empty = none), `startsAt`, `endsAt` (after the start, at most 7 days later), `allDay`, `tz` (IANA; empty = the profile's zone, else UTC), `record`, `repeat` (`EVENT_REPEAT_DAILY`, `…_WEEKLY`, `…_BIWEEKLY`, `…_MONTHLY`), `repeatUntil`, `attendees: [{userId, required} | {email}]`.

- The bot is the organizer (`organizerId` = the bot's id) but not an attendee: listing itself in `attendees` gives `422`. Bots and guests are never attendees.
- Invitations and `invite.ics` go out from the system address as “Workspace (on behalf of bot X)”, without `Reply-To` and without room guest links: outside attendees get a link to the meeting page.
- Outside attendees' addresses are visible to the bot only when it may change the meeting.

```sh tab="curl"
curl -s -X POST $CALAB/api/workspaces/$WS/events \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"title\": \"Stand-up\", \"roomId\": \"$VOICE\",
       \"startsAt\": \"2026-10-20T09:00:00Z\", \"endsAt\": \"2026-10-20T09:30:00Z\",
       \"tz\": \"Europe/London\", \"repeat\": \"EVENT_REPEAT_WEEKLY\",
       \"attendees\": [{\"userId\": \"$USER\", \"required\": true}, {\"email\": \"partner@example.com\"}]}"
```

```js tab="JavaScript"
import { timestampFromDate } from '@bufbuild/protobuf/wkt';

const ev = await bot.calendar.create(wsId, {
  title: 'Stand-up',
  roomId,
  startsAt: timestampFromDate(new Date('2026-10-20T09:00:00Z')),
  endsAt: timestampFromDate(new Date('2026-10-20T09:30:00Z')),
  tz: 'Europe/London',
  attendees: [{ userId, required: true }],
});
```

```python tab="Python"
r = requests.post(f"{CALAB}/api/workspaces/{ws_id}/events", headers=H, json={
    "title": "Stand-up", "roomId": voice_id,
    "startsAt": "2026-10-20T09:00:00Z", "endsAt": "2026-10-20T09:30:00Z",
    "tz": "Europe/London", "attendees": [{"userId": user_id, "required": True}],
})
event = r.json()["event"]
```

Response `201`:

```json
{
  "event": {
    "id": "0192c0e1-0000-7000-8000-0000000000e7",
    "workspaceId": "0191f0aa-0000-7000-8000-000000000001",
    "roomId": "0192a2d0-1111-7000-8000-00000000a001",
    "title": "Stand-up",
    "startsAt": "2026-10-20T09:00:00Z",
    "endsAt": "2026-10-20T09:30:00Z",
    "allDay": false,
    "tz": "Europe/London",
    "organizerId": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
    "repeat": "EVENT_REPEAT_WEEKLY",
    "canEdit": true,
    "attendees": [],
    "sequence": 0
  }
}
```

## Read, change, cancel

```js tab="JavaScript"
const events = await bot.calendar.list(wsId, new Date('2026-10-20'), new Date('2026-10-27'));
await bot.calendar.update(ev.id, { title: 'Stand-up (moved)' });
await bot.calendar.delete(ev.id, new Date('2026-10-27T09:00:00Z'));   // one occurrence
await bot.calendar.delete(ev.id);                                     // the whole series
```

```sh tab="curl"
curl -s "$CALAB/api/workspaces/$WS/events?from=2026-10-20T00:00:00Z&to=2026-10-27T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN"
curl -s -X DELETE "$CALAB/api/events/$EVENT?occurrence=2026-10-27T09:00:00Z" -H "Authorization: Bearer $TOKEN"
```

In a list, each occurrence of a series is a separate item with `occurrenceAt`. Changes are mailed to the attendees (`sequence` grows). A bot cannot change outside addresses on someone else's meeting (`403`).

## Free/busy and finding a time

`GET /api/workspaces/{id}/freebusy?users=&from=&to=` returns the busy intervals of up to 20 members (not guests or bots) in a window of up to 14 days; meetings of all of the person's workspaces count. A bot sees **busy time only**: no titles or attendees of external events. The answer is `{users: [{userId, timezone, workHours, busy: [{startsAt, endsAt, kind}]}]}`. Limit: 60 requests per minute.

`POST /api/workspaces/{id}/freebusy/suggest {users, durationMin, from, to, withinWorkHours, roomId}` returns up to 10 earliest windows on a 15-minute grid where everyone (and the room, if set) is free. With `withinWorkHours` and no overlap of working hours — `409 NO_COMMON_HOURS`. Limit: 30 requests per minute.

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
> The `eventCreate`, `eventUpdate`, `eventDelete` and `eventRsvp` events arrive over the [gateway](./gateway) and [webhooks](./webhooks) — for meetings the bot organizes and meetings of rooms it sees.
