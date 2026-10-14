---
title: Gateway events
description: Every opcode, close code and DispatchEvent event of the gateway protocol, marked with which ones bots receive.
order: 2
---

The reference for gateway protocol version `v=1`. How to connect and handle events is in the [Gateway](../bots/gateway) chapter.

## Opcodes

The `op` field of a `GatewayFrame`. In JSON it is the full name, e.g. `"GATEWAY_OPCODE_DISPATCH"`.

| Opcode | Number | Direction | Frame field |
|---|---|---|---|
| `GATEWAY_OPCODE_HEARTBEAT` | 1 | bot → server | `heartbeat { lastSeq }` |
| `GATEWAY_OPCODE_IDENTIFY` | 2 | bot → server | `identify { token, device, capabilities }` |
| `GATEWAY_OPCODE_RESUME` | 3 | bot → server | `resume { token, sessionId, seq }` |
| `GATEWAY_OPCODE_PRESENCE_UPDATE` | 4 | bot → server | `setPresence { status, until }` |
| `GATEWAY_OPCODE_TYPING` | 5 | bot → server | `typing { roomId }` |
| `GATEWAY_OPCODE_SUBSCRIBE` | 6 | bot → server | `subscribe { roomIds }` |
| `GATEWAY_OPCODE_RECONNECT` | 7 | server → bot | `reconnect {}` |
| `GATEWAY_OPCODE_DISPATCH` | 8 | server → bot | `dispatch { <event> }` |
| `GATEWAY_OPCODE_INVALID_SESSION` | 9 | server → bot | `invalidSession { resumable }` |
| `GATEWAY_OPCODE_HELLO` | 10 | server → bot | `hello { heartbeatIntervalMs }` |
| `GATEWAY_OPCODE_HEARTBEAT_ACK` | 11 | server → bot | `heartbeatAck {}` |

## Close codes

| Code | Name | What a bot should do |
|---|---|---|
| `4000` | `UNKNOWN_ERROR` | reconnect, `RESUME`; with the reason `replaced by a new session` — don't reconnect |
| `4001` | `UNKNOWN_OPCODE` | reconnect, `RESUME` |
| `4002` | `DECODE_ERROR` | reconnect, `RESUME` |
| `4003` | `NOT_AUTHENTICATED` | reconnect, new `IDENTIFY` |
| `4004` | `AUTHENTICATION_FAILED` | don't reconnect: the token is wrong |
| `4007` | `INVALID_SEQ` | reconnect, new `IDENTIFY` |
| `4008` | `RATE_LIMITED` | back off, `RESUME` |
| `4009` | `SESSION_TIMED_OUT` | reconnect, new `IDENTIFY` |
| `4010` | `SESSION_REVOKED` | don't reconnect: the token was revoked or the bot deleted |
| `4011` | `SESSION_EVICTED` | concerns browser tabs; bots never see it |

## Events

An event is one of the `DispatchEvent` fields, lowerCamelCase in JSON. The “Bots” column: **yes** — delivered to a bot by its permissions; **conditional** — only under the condition described; **no** — never sent to bots.

### Session

| Event | Bots | Description |
|---|---|---|
| `ready` | yes | the answer to `IDENTIFY`: `sessionId`, `me`, `workspaces[]`, `dms[]`, `readStates` |
| `resumed` | yes | the answer to a successful `RESUME`: `replayed` — how many events were replayed |
| `readStateUpdate` | yes | the bot's own read marker changed (from another device or via `PUT /api/rooms/{id}/read`) |

### Workspaces, members, roles

| Event | Bots | Description |
|---|---|---|
| `workspaceCreate` · `workspaceUpdate` · `workspaceDelete` | yes | the bot joined a workspace · settings changed · the workspace was deleted or the bot removed |
| `workspaceMemberAdd` · `workspaceMemberUpdate` · `workspaceMemberRemove` | yes | members: joined, roles or nickname changed, left |
| `workspaceBanAdd` · `workspaceBanRemove` | conditional | bans — only with `MANAGE_MEMBERS` |
| `roleCreate` · `roleUpdate` · `roleDelete` | yes | the workspace's roles |
| `badgeCreate` · `badgeUpdate` · `badgeDelete` | yes | the badge library |
| `workspaceAchievementsUpdate` | yes | the workspace's achievement catalog changed |
| `userUpdate` · `presenceUpdate` | yes | a member's profile and presence |
| `botCreate` · `botUpdate` · `botDelete` | conditional | the workspace's bots — only with `MANAGE_BOTS` (or to the bot's owner) |
| `workspaceAppUpsert` · `workspaceAppDelete` | no | workspace web apps — people only |
| `workspaceIdentityAccessUpdate` | — | an internal SSO event for people’s sessions; ignore it if it arrives |
| `billingUpdate` | no | billing — the workspace owner only |

### Rooms and messages

| Event | Bots | Description |
|---|---|---|
| `roomCreate` · `roomUpdate` · `roomDelete` · `roomPermissionsUpdate` | yes | rooms the bot can see (or stopped seeing) |
| `categoryCreate` · `categoryUpdate` · `categoryDelete` | yes | room categories |
| `messageCreate` · `messageUpdate` · `messageDelete` | yes | messages of visible rooms and the bot's DMs; a command for the bot carries `message.command` |
| `messageReactionAdd` · `messageReactionRemove` | yes | reactions |
| `typingStart` | conditional | “is typing” — only in rooms from `SUBSCRIBE` |
| `botCallback` | conditional | a button press — only to the message's author bot |
| `dmCreate` | yes | a new DM with the bot |
| `stickerPackCreate` · `stickerPackUpdate` · `stickerPackDelete` | yes | the workspace's sticker packs |
| `readReceipt` | no | people's “read” marks — never sent to bots |
| `roomNotificationUpdate` · `workspaceNotificationUpdate` · `dmStateUpdate` | no | notification settings and DM archive — bots have none |

### Voice and calls

| Event | Bots | Description |
|---|---|---|
| `voiceStateUpdate` | yes | who is in which voice room; empty `roomId` — left |
| `voiceStreamStart` · `voiceStreamStop` · `voiceCameraStop` · `voiceMoved` | yes | streams, camera, a member moved |
| `voiceDisconnected` | yes | the bot was disconnected from voice |
| `roomRecording` | yes | a meeting recording in the room started or stopped |
| `soundCreate` · `soundUpdate` · `soundDelete` | yes | the workspace's sounds |
| `soundPlay` | conditional | only while the bot is in the room's call |
| `sipCallUpdate` | yes | a phone call from the room was placed or changed status |
| `roomAdmissionRequest` · `roomAdmissionDecided` | conditional | a guest waits for admission · a decision was made — to those who decide (`INVITE_GUESTS` in the room) |
| `callRing` · `callState` | no | one-to-one calls — not for bots |
| `backgroundCreate` · `backgroundUpdate` · `backgroundDelete` | no* | camera backgrounds; bots have no camera — ignore them |

\* The event is broadcast to the whole workspace and may arrive, but a bot has no use for it.

### Calendar

| Event | Bots | Description |
|---|---|---|
| `eventCreate` · `eventUpdate` · `eventDelete` · `eventRsvp` | yes | meetings the bot organizes and those of visible rooms; outside addresses only if the bot may change the meeting |
| `roomEventActive` · `roomEventEnded` | yes | a meeting in a room started · ended |
| `eventReminder` | no | a reminder to an attendee — a bot never attends meetings |

### Boards and tasks

| Event | Bots | Description |
|---|---|---|
| `boardCreate` · `boardUpdate` · `boardDelete` | yes | boards — by `VIEW_BOARD` |
| `boardCategoryCreate` · `boardCategoryUpdate` · `boardCategoryDelete` | yes | board categories |
| `taskCreate` · `taskUpdate` · `taskDelete` · `taskActivity` | yes | tasks and their journal entries |
| `taskChecklistUpdate` · `taskChecklistDelete` | yes | task checklists |
| `boardRuleUpdate` · `boardRuleDelete` | yes | the board's automation rules |
| `taskGitLinksUpdate` | yes | a task's Git links |
| `taskNotice` | conditional | a person's task notification — only to the bot they chose |

### Other

| Event | Bots | Description |
|---|---|---|
| `notesCreate` · `notesUpdate` · `notesDelete` | no | notes shelves — people only |
| `diskItemUpsert` · `diskItemRemove` | no | Disk — bots have no access yet |

> [!TIP]
> New events appear without a protocol version change. Skip an unknown `dispatch` field — that way your bot won't break when the server is updated.
