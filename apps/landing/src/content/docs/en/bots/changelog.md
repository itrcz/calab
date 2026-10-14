---
title: API changelog
description: What appeared in the bot API in which server version — from the first release to forwarding task notifications.
order: 23
---

The bot API only grows: new routes, fields and events are added, existing ones keep their meaning. Check your server's version with `GET /api/version` (see [API version](../reference/version)).

| Server version | Date | What's new |
|---|---|---|
| 3.2.0 | 2026-10-12 | Forwarding task notifications to a chosen bot: the `taskNotice` event on the gateway and webhook — see [Task notifications](./task-notices) |
| 3.0.0 | 2026-10-07 | Task watchers: `PUT` / `DELETE /api/tasks/{id}/watchers` |
| 2.3.1 | 2026-10-04 | Board forms: create, edit, preview and submit over the API — see [Board forms](./rest-forms) |
| 2.3.0 | 2026-10-04 | Unified search `GET /api/search`; milestones inside a task (`/api/tasks/{id}/milestones`, `/api/task-milestones/{id}`) |
| 2.2.0 | 2026-10-03 | Board automations: reading rules and their run log; rule system messages; achievements — reading the catalog and members' achievements; card-based task access for assignees |
| 2.0.0 | 2026-10-02 | Boards 2.0: board categories, checklists, board features (`FEATURE_DISABLED`), the board webhook with a `v1=` signature |
| 1.7.0 | 2026-10-01 | Reaction authors: `GET /api/messages/{id}/reactions/{emoji}` |
| 1.5.0 | 2026-09-30 | The extended API: a bot organizes meetings, sees availability, invites members (by link and email), manages badges and sounds, admits guests and controls recording — by the permissions of its roles; a member's profile `GET /api/workspaces/{id}/members/{userId}` |
| 1.3.0 | 2026-09-30 | Telephony from a room: `POST /api/rooms/{id}/calls`, the `sipCallUpdate` event |
| 1.2.0 | 2026-09-30 | Buttons under bot messages: `inlineKeyboard`, the `botCallback` event — see [Commands and buttons](./commands-buttons) |
| 1.1.0 | 2026-09-30 | Task boards: boards, tasks, statuses, labels, milestones, views — bots work like people |
| 1.0.0 | 2026-09-29 | Calendar and meetings: reading meetings in visible rooms |
| 0.8.0 | 2026-09-28 | A recording’s full transcript: `GET /api/rooms/{id}/recordings/{rid}/transcript` |
| 0.7.4 | 2026-09-28 | Forwarding messages: `POST /api/rooms/{id}/messages/{mid}/forward` |
| 0.7.0 | 2026-09-28 | First release: a bot is a user with a token, REST and the gateway, commands, the bot webhook, voice through LiveKit, stickers |

> [!NOTE]
> **Coming soon:** bot access to the workspace Disk and Wiki — see [Disk](./rest-disk) and [Wiki](./rest-wiki).

## Compatibility

- New fields in responses and events appear without notice — skip fields you don't know.
- So do new enum values (notification kinds, event types) — treat an unknown value as “other”.
- A route closed to bots may open in a newer version; an open route is never closed without an entry in this log.
- The board webhook contract stays at version `1`: fields are only added.
