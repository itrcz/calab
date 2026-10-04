# 19 — Bot API

Public documentation for developers of Calab bots. Русский: [`19-bot-api.md`](19-bot-api.md).
Decision and scope — [ADR-0031](adr/0031-bots.md); the full protocol — [`05-realtime-protocol.md`](05-realtime-protocol.md);
the contract — `proto/calaba/v1/*.proto` (the source of truth: field and event names below come from it).

A Calab bot is a **user** with the `is_bot` flag: it uses the same REST API and realtime gateway as the app, and
its rights are only what its roles and room overrides give it, exactly as for people. There is no separate
"Bot API": a bot does what a person can, within its rights. Voice goes through LiveKit: the bot gets a `url` +
`token` and connects with a LiveKit client as an ordinary participant.

- [Bots in 5 minutes](#bots-in-5-minutes)
- [Token and security](#token-and-security)
- [REST](#rest)
- [Gateway: realtime events](#gateway-realtime-events)
- [Commands](#commands)
- [Webhook](#webhook)
- [Board webhook](#board-webhook)
- [Voice through LiveKit](#voice-through-livekit)
- [Stickers over the API](#stickers-over-the-api)
- [Limits and errors](#limits-and-errors)
- [FAQ](#faq)

## Bots in 5 minutes

1. **Create a bot.** "Workspace settings → Bots → Create bot" (the workspace owner or a role with
   `MANAGE_BOTS`, verified email): name, `username` (`[a-z0-9_]{3,32}`, used in `/cmd@username`), description.
   The token is shown **once** — copy it. The bot joins the workspace right away with the member role.
2. **Grant rights.** By default the bot has the member role's rights (read and write in open rooms, join voice).
   Need more or less — give it a role or room overrides, as you would a person.
3. **Run an example** (Node ≥ 20, from the repository root):
   ```sh
   pnpm install && pnpm -F @calaba/bot-sdk build
   cd examples/bots/echo && npm install
   BOT_TOKEN=calab_bot_… CALAB_SERVER=https://app.calab.io npm start
   ```
   Write anything in a room, or `/echo hello` — the bot answers.

A minimal bot with the SDK ([`packages/bot-sdk`](../packages/bot-sdk/README.md)):

```js
import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, { server: 'https://app.calab.io' });
await bot.commands([{ name: 'echo', description: 'Repeat the text' }]);
bot.on('message', (m) => bot.reply(m, m.content));
bot.on('command', (c) => c.name === 'echo' && bot.reply(c, c.args || 'Type: /echo text'));
await bot.start();
```

Without the SDK — any language with HTTP and WebSocket: REST below, the gateway speaks protobuf or JSON frames.

## Token and security

- Format: `calab_bot_<bot id>_<43-character base64url secret>`. The `calab_bot_` prefix lets secret scanners
  recognise leaked tokens.
- Sent **only** in the `Authorization: Bearer <token>` header (REST) and in `IDENTIFY` (gateway). Never in a URL.
- The server stores only the secret's `sha256`; a token cannot be shown again. "Reissue token" (the bot's owner or
  `MANAGE_BOTS` of its home workspace) returns a new one and kills the old one at once; "Revoke" kills it
  without a new one. A revoked / reissued token: REST → `401`, the gateway closes with `4010`, the bot leaves calls.
- One token is one gateway "device": a second process with the same token pushes the first one out (its socket is
  closed with `4000 replaced by a new session`). Run one process per token.
- Endpoints for people are **closed** to bots (`403 FORBIDDEN`, `reason: "BOT_NOT_ALLOWED"`): sessions, password,
  email, verification, status and profile settings, notes, creating / discovering / joining workspaces, account
  lookup by address and adding an account directly, room guest links, notification settings, DM archive, link
  previews, recording retry / delete, superadmin, bot management, workspace camera backgrounds
  (`/api/workspaces/{id}/backgrounds…`, ADR-0035 — bots have no camera). Workspace invitations, the calendar, badges,
  sounds, guest admission and recording start / stop are open since ADR-0051 by the same bits as for people (see the
  table below).
- A bot sees only what `VIEW_ROOM` / `VIEW_BOARD` allow; closed (restricted) rooms and boards (ADR-0029, ADR-0048)
  apply to bots too: a bot gets in only through an override on the object itself (personal or by role), otherwise 404,
  as for people.
- The workspace bits of ADR-0048 reach a bot, as a person, through its roles: `MANAGE_MEMBERS` — remove and ban,
  `CREATE_BOARDS` — create boards, `VIEW_JOURNALS` — a board's journal, `MANAGE_EVENTS` — others' meetings,
  `MANAGE_RECORDINGS` — meeting recording; bot management, telephony settings, GPTunneL
  and the call journal stay closed to bots (`403 BOT_NOT_ALLOWED`) even with `MANAGE_BOTS` / `MANAGE_INTEGRATIONS` /
  `VIEW_JOURNALS`.
- A person can "Block bot" — the bot then cannot write to them in DMs (`403 BOT_BLOCKED`).
- One-to-one calls (ADR-0034) are not for bots: a bot neither calls nor answers (`POST /api/dms/{id}/call`, `/api/calls/…` — `403 BOT_NOT_ALLOWED`), and a bot cannot be called.
- Notes shelves (personal rooms, ADR-0039) are not for bots: `/api/notes*` — `403 BOT_NOT_ALLOWED`; a bot never sees someone's shelf (`404`).
- Keep the webhook secret apart from the token; verify the signature of every delivery (see [Webhook](#webhook)).

## REST

The base is the app address (`https://app.calab.io` or your `https://<APP_HOST>`). Request and response bodies are
proto messages as JSON (protojson): lowerCamelCase fields, enums by full name (`"ROOM_TYPE_VOICE"`), `uint64` as
strings, times in RFC 3339; fields with default values are present in responses, unknown request fields are
ignored. An error is `ApiError { code, message, field?, reason?, used?, limit? }`.

```sh
export CALAB=https://app.calab.io
export TOKEN=calab_bot_…
curl -s $CALAB/api/bots/me -H "Authorization: Bearer $TOKEN"
```
```json
{"bot": {"user": {"id": "0192…", "displayName": "Echo", "isBot": true, "…": "…"},
         "username": "echo", "ownerUserId": "0191…", "workspaceId": "0191…", "description": "",
         "commands": [{"name": "echo", "description": "Repeat the text"}], "tokenPrefix": "Qx3v9a",
         "createdAt": "2026-09-27T10:00:00Z", "webhook": {"url": "", "enabled": false, "…": "…"}}}
```

### Endpoints open to bots

Everything below is "by rights": the server checks the bot's rights exactly as a person's. The full route table
with the decision for bots is `apps/server/internal/app/botroutes.go`.

| Method and path | What it does | Rights |
|---|---|---|
| `GET /api/me` | the bot's account (`me.user.isBot = true`) | — |
| `PATCH /api/me` | only `displayName`, `avatarFileId` | — |
| `POST /api/me/avatar` | avatar (multipart `file`) | — |
| `POST /api/workspaces/{id}/bots/{botId}/avatar` | the bot's avatar from the «Bots» UI (docs/09 #87): multipart `file`, like `POST /api/me/avatar` (not an image — 422) → `{bot}`; a bot gets 403 `BOT_NOT_ALLOWED` | people: the bot's owner or `MANAGE_BOTS` of its home workspace |
| `DELETE /api/workspaces/{id}/bots/{botId}/avatar` | remove the bot's avatar → `{bot}`; the bot not a member of `{id}` — 404, not its home workspace — 403 | same |
| `GET /api/bots/me` · `PATCH /api/bots/me` | the bot's profile: `{displayName?, description?}` | bots only |
| `PUT /api/bots/me/commands` | replace the command list `{commands: [{name, description}]}` | bots only |
| `GET · PUT · DELETE /api/bots/me/webhook` | webhook `{url, secret}` | bots only |
| `GET /api/workspaces` · `GET /api/workspaces/{id}` | the bot's workspaces | member |
| `GET /api/workspaces/{id}/members` | members (`WorkspaceMember`; bots have `user.isBot`) | member |
| `GET /api/workspaces/{id}/members/{userId}` | a member's profile (ADR-0051; `@me` = the bot) → `{member, openTasks}`: name, nickname, roles, badge, status, time zone, birthday (a hidden one is not sent), open tasks they are assigned to — only from boards the bot sees (≤ 50). SDK `bot.members.get` | member |
| `PATCH /api/workspaces/{id}/members/{userId} {nickname}` | rename a member (workspace nickname; `""` clears it). SDK `bot.members.setNickname` | `MANAGE_NICKNAMES` |
| `GET /api/workspaces/{id}/badges` | member badges: `WorkspaceMember.badge_id` refers to them | member |
| `POST /api/workspaces/{id}/badges {name, fileId}` · `PATCH · DELETE …/badges/{badgeId}` | the badge library; the picture is the bot's own upload to this workspace (PNG/WebP/JPEG ≤ 128 KB). SDK `bot.badges.create/update/delete` | `MANAGE_MEMBERS` |
| `PUT /api/workspaces/{id}/members/{userId}/badge {badgeId}` | give / take (`""`) a badge; the target is not a bot and is below the bot's top role. SDK `bot.badges.set` | `MANAGE_NICKNAMES` |
| `GET /api/workspaces/{id}/achievements` | the workspace's achievement catalog (ADR-0061; archived ones carry `archivedAt`, `ETag`); the picture is `GET /api/files/{fileId}` (512×512 WebP). Changing the catalog (`POST …/achievements`, `PATCH · DELETE /api/achievements/{id}`) is for people only: 403 `BOT_NOT_ALLOWED` | member |
| `GET /api/workspaces/{id}/members/{userId}/achievements` | a member's live achievements `{items: [{id, achievementId, note, grantedBy, grantedAt, messageId, roomId}]}`, newest first. Granting / revoking (`POST …/achievements`, `DELETE …/achievements/{grantId}`) is 403 `BOT_NOT_ALLOWED`: people grant them | member |
| `GET · POST /api/workspaces/{id}/invites` · `DELETE …/invites/{inviteId}` | workspace invite links `{maxUses, expiresInSeconds}`. SDK `bot.invites.list/create/delete` | `INVITE_MEMBERS` |
| `GET · POST /api/workspaces/{id}/invites/email` · `DELETE …/invites/email/{inviteId}` | an invitation by mail `{email}`: the mail says "Workspace (on behalf of bot X)", the same address at most once a day; inviting an admin — the owner only. SDK `bot.invites.email/listEmail/deleteEmail` | `INVITE_MEMBERS` |
| `GET /api/workspaces/{id}/rooms` · `GET /api/rooms/{id}` | rooms the bot can see | `VIEW_ROOM` |
| `GET /api/workspaces/{id}/categories` | room categories | member |
| `GET /api/rooms/{id}/messages?before=&after=&limit=` | history (newest first, `limit ≤ 100`) | `VIEW_ROOM` |
| `GET /api/rooms/{id}/messages/{messageId}` | one message, bare `Message` (no wrapper; SDK `message(roomId, messageId)`) | `VIEW_ROOM` |
| `GET /api/rooms/{id}/recordings/{rid}/transcript` | full saved transcript (SDK `transcript(roomId, recordingId)`) | `VIEW_ROOM` |
| `POST /api/rooms/{id}/messages` | a message `{content, attachmentIds, replyToId, nonce, stickerId}` → 201 | `SEND_MESSAGES` (+ `ATTACH_FILES`) |
| `PATCH /api/messages/{id}` · `DELETE /api/messages/{id}` | edit own / delete | author or `MANAGE_MESSAGES` |
| `POST /api/rooms/{id}/messages/{mid}/forward` | forward `{toRoomId}` → 201 `{message}` with `forward` (ADR-0033; SDK `forward(roomId, messageId, toRoomId)`) | `VIEW_ROOM` in the source, `SEND_MESSAGES` in the target |
| `PUT · DELETE /api/messages/{id}/reactions/{emoji}` | reaction (URL-encoded emoji) → 204 | `SEND_MESSAGES` |
| `PUT · DELETE /api/messages/{id}/pin` · `GET /api/rooms/{id}/pins` | pins | `MANAGE_MESSAGES` / `VIEW_ROOM` |
| `PUT /api/rooms/{id}/read` | read marker (does not give people's messages the ✓✓ «read» mark; bots get no `READ_RECEIPT`) | `VIEW_ROOM` |
| `GET /api/workspaces/{id}/messages/search?q=` · `GET /api/me/mentions` | search, mentions of the bot | `VIEW_ROOM` |
| `GET /api/search?q=&scope=<workspace_id>\|all&types=&type=&cursor=` (ADR-0062) | unified search: messages, task comments and tasks, events, files, transcripts — by the same rules as people (the bits of the bot's roles; events it organizes and those of rooms it views); the notes section is always empty for bots | each section's rights |
| `POST /api/workspaces/{id}/files` · `POST /api/dms/{id}/files` | upload a file (multipart `file`) → `{file}` | `ATTACH_FILES` |
| `GET /api/files/{id}` · `GET /api/files/{id}/thumbnail` | download a file | access to the room |
| `POST /api/dms {userId}` · `GET /api/dms` · `GET /api/dms/candidates` | DM with a member of a shared workspace | not blocked |
| `GET /api/rooms/{id}/bot-commands` | commands of the room's bots | `VIEW_ROOM` |
| `POST /api/rooms/{id}/join` · `POST /api/rooms/{id}/voice/leave` | voice: `{url, token, …}` / leave | `CONNECT` |
| `POST /api/rooms/{id}/stream/request` · `…/camera/request` · `…/camera/stop` | screen share, camera | `STREAM` / `VIDEO` |
| `PATCH /api/voice/self` · `PATCH /api/rooms/{id}/voice-status` | own mute/deafen, call status | in the call |
| `POST /api/rooms/{id}/voice/{userId}/mute · unmute · disconnect · move · stop-stream · stop-camera · allow-camera` | voice moderation | `MUTE_MEMBERS` / `MOVE_MEMBERS` |
| `GET /api/rooms/{id}/admissions` · `POST /api/rooms/{id}/admissions/{userId} {status, displayName?, badgeId?}` | guests waiting for approval to enter (ADR-0040) and the decision: `ROOM_ADMISSION_STATUS_ADMITTED` / `…_DECLINED` (ADR-0051) | `INVITE_GUESTS` in the room |
| `POST /api/rooms/{id}/recording/start` · `…/recording/stop` | meeting recording (ADR-0025): someone is in the room's call, `allowRecording`, the workspace is paired with GPTunneL. SDK `bot.recording.start/stop` | `VIEW_ROOM` + `CONNECT` and **`MANAGE_RECORDINGS`** (for bots, ADR-0051) |
| `POST /api/rooms/{id}/calls {number}` · `DELETE /api/rooms/{id}/calls/{callId}` | telephony (ADR-0046): call a phone number from the room's call — the callee joins the room as participant `sip:<callId>`; hang up your own line (someone else's with `MUTE_MEMBERS`). Statuses come as the `sipCallUpdate` event. Limit: 20 calls per hour per workspace (`429 SIP_RATE_LIMITED`). SIP settings and the journal — 403 `BOT_NOT_ALLOWED`. Business plan only: below it — `409 PLAN_LIMIT` (hanging up always works) | `PLACE_CALLS`, the bot is in the room's call, telephony is on |
| `GET /api/workspaces/{id}/events?from=&to=` · `GET /api/events/{id}` | calendar (ADR-0038): meetings the bot organizes and meetings of rooms it sees; external attendees' addresses only when the bot may change the meeting. SDK `bot.calendar.list/get` | `VIEW_ROOM` |
| `POST /api/workspaces/{id}/events` | create a meeting (ADR-0051): **the bot organizes it but never attends** (listing itself in `attendees` — 422); invitations and `invite.ics` go from the system address as "Workspace (on behalf of bot X)", without `Reply-To` and without room guest links — outside attendees get the meeting page link. SDK `bot.calendar.create` | not a guest; the room is a visible voice room |
| `PATCH · DELETE /api/events/{id}[?occurrence=]` | change / cancel a meeting (or one occurrence of a series). SDK `bot.calendar.update/delete` | its own; others' — `MANAGE_ROOM` in its room or `MANAGE_EVENTS` (outside addresses on others' meetings — 403) |
| `GET /api/workspaces/{id}/freebusy?users=&from=&to=` · `POST …/freebusy/suggest` | free/busy and finding a time (ADR-0041): a bot gets the busy time only (no titles or attendees of external events). SDK `bot.calendar.freebusy/suggest` | not a guest |
| `PUT /api/events/{id}/rsvp`, `GET /api/me/events/today`, CalDAV (`/api/me/caldav…`, `/api/me/external-events`) | 403 `BOT_NOT_ALLOWED`: a bot attends no meetings and has no external calendar | — |
| task boards (ADR-0042): `GET /api/workspaces/{id}/boards`, `GET /api/boards/{id}`, `GET/POST /api/boards/{id}/tasks`, `GET/PATCH /api/tasks/{id}`, `PUT /api/tasks/{id}/assignees`, `GET /api/workspaces/{id}/tasks/search?q=`, `GET /api/t/{KEY-N}`, `GET /api/me/tasks`, statuses/labels/milestones/views, task archive | the bot works like a person, within the board bits of its roles and overrides (it can be an assignee and be let into a private board personally); a comment is a message in `task.roomId`. Assignees / approvers (ADR-0059): any human member who is not a guest — even without access to the board, unless it is restricted (they then see the board through their tasks only: `Board.taskScoped`); a bot only if it sees the board, never as an approver; otherwise `422`. A bot never sees a board through its tasks — it needs `VIEW_BOARD`. Board access (`PUT …/permissions`) and the final delete (`DELETE …?purge=1`) — 403 `BOT_NOT_ALLOWED`. SDK: `bot.boards.list/get`, `bot.tasks.list/search/get/create/update/setAssignees/comment` | `VIEW_BOARD` / `CREATE_TASKS` / `EDIT_TASKS` / `MANAGE_BOARD` |
| boards 2.0 (ADR-0058): `GET/POST /api/workspaces/{id}/board-categories`, `PATCH/DELETE /api/board-categories/{id}`, `PUT /api/workspaces/{id}/boards/order`, `PATCH /api/boards/{id} {setDisabledFeatures, disabledFeatures, estimateScale}`, checklists: `POST /api/tasks/{id}/checklists`, `PATCH/DELETE /api/checklists/{id}`, `POST /api/checklists/{id}/items`, `PATCH/DELETE /api/checklist-items/{id}`, `POST /api/checklist-items/{id}/convert` | categories — `CREATE_BOARDS`, placing a board and features — `MANAGE_BOARD`, checklists — like task fields (`EDIT_TASKS`; `CREATE_TASKS` — its own and assigned); checklists need the Team plan (`409 PLAN_LIMIT`). A board feature is off → a request that **changes** its field to a non-empty value is `409 CONFLICT`, `reason FEATURE_DISABLED`, `field` = the field name (`estimate`, `dueOn`, `approverIds`…); clearing it and repeating the current value pass. The board webhook (`/api/boards/{id}/webhook*`) is for people only, a bot gets `403 BOT_NOT_ALLOWED`. SDK: `bot.boards.categories.*`, `bot.boards.setFeatures`, `bot.tasks.checklists.*` | see left |
| milestones inside a task (ADR-0063): `POST /api/tasks/{id}/milestones {name, dueOn?}`, `PATCH /api/task-milestones/{id} {name?, dueOn?, position?, completed?}`, `DELETE /api/task-milestones/{id}`; a subtask — `PATCH /api/tasks/{id} {taskMilestoneId}` | like task fields (`EDIT_TASKS`; `CREATE_TASKS` — its own and assigned); ≤ 20 milestones per task (`409 TASK_MILESTONE_LIMIT`), subtasks have none (`422`), a subtask links only its parent's milestone (`422`). While subtasks are linked the server keeps the milestone's completion — a manual `completed` is `409 TASK_MILESTONE_AUTO`. The `MILESTONES` feature off — `409 FEATURE_DISABLED`. The answer is `{milestone, task}`; milestones and progress (`milestones`, `milestoneProgress`, `taskMilestoneId`) are in every task and in `TASK_UPDATE`. SDK: `bot.tasks.milestones.*` | see left |
| board automations (ADR-0060): `GET /api/boards/{id}/rules`, `GET /api/rules/{id}/runs` | a bot **reads** the board's rules and their run log; creating / changing / deleting / testing a rule (`POST /api/boards/{id}/rules`, `PATCH/DELETE /api/rules/{id}`, `POST /api/rules/{id}/test`) and the board's Git webhook (`/api/boards/{id}/git`) — 403 `BOT_NOT_ALLOWED`. Task changes made by a bot run the board's rules like people's; changes made by rules show in the journal with an empty `actorId` and a `ruleId` | reading — `VIEW_BOARD`, the log — `MANAGE_BOARD` |
| `GET /api/workspaces/{id}/sounds` · `POST /api/rooms/{id}/sounds/play {soundId}` | soundboard (ADR-0036): the workspace's sounds; play one to everyone in the call (`builtin:<name>` or a sound id; 1 per 2 s per bot, 5 per 10 s per room) | the bot is in the room's call |
| `POST /api/workspaces/{id}/sounds` · `PATCH · DELETE …/sounds/{soundId}` | the sound library (ADR-0051): the clip is the bot's own upload to this workspace | `MANAGE_STICKERS` |
| stickers: `GET/POST /api/workspaces/{id}/sticker-packs`, `/api/sticker-packs/{id}…`, `/api/stickers/{id}`, `/api/me/sticker-packs…` | see [Stickers](#stickers-over-the-api) | member / `MANAGE_STICKERS` |
| rooms, categories, roles, members, bans (`POST/PATCH/DELETE …`) | workspace management | `MANAGE_ROOM`, `MANAGE_ROLES`, `MANAGE_MEMBERS` (remove, ban, built-in role, assign roles — ADR-0048), `MANAGE_WORKSPACE` (settings), … |

**Still for people only** (403 `BOT_NOT_ALLOWED`, ADR-0051): deleting a workspace; bot management (create, tokens,
avatar — whatever bit the bot has); SIP settings, GPTunneL, workspace web apps; superadmin; voting in task approvals;
granting and revoking achievements; RSVP, CalDAV, "today"; account lookup by address and adding an account directly (`invites/lookup`, `POST …/members`);
room guest links; the birthday table and setting birthdays; board access; deleting and re-uploading recordings;
camera backgrounds, notes, DM calls, password, email, sessions.

**A bot with admin permissions is an admin.** A bot token whose roles give `MANAGE_*`, `INVITE_*` or `VIEW_JOURNALS`
acts as an admin with those permissions: keep it like an admin's password and reissue it when in doubt. The role
editor warns when such permissions go to a role bots hold. The server logs every administrative bot action
(`bot action`: route, status, the bot and its owner). Closed rooms and boards (ADR-0048 "without admins") are visible
to a bot only through an override on them.

### Reply targets and meeting transcripts

`GET /api/rooms/{id}/messages/{messageId}` returns **HTTP 200 with the bare `calaba.v1.Message`**,
not `{message: …}` or `{messages: […]}`. Its fields and detail loading match a history item:
`id`, `roomId`, `authorId`, `content`, `replyToId`, `attachments`, `reactions` (`me` relative to the
caller), timestamps, `kind`, `system`, `sticker` and `forward`. `command` is unset, as in all REST responses.
A recording card has `kind: "MESSAGE_KIND_SYSTEM"` and `system.recording.recordingId`; use that id
in the transcript URL. An achievement card (ADR-0061) is `MESSAGE_KIND_SYSTEM` too: `system.achievement
{achievementId, grantId, note, grantedBy}`, authored by the recipient. A message of a board automation rule (ADR-0060) is a system message too:
`system.automation {boardId, taskId, ruleId, ruleName, text}` (`text` is plain text: no mentions or markup, it pings nobody); `authorId` is the rule's creator — show it as
"Automation: ruleName". A command replying to a card has `replyToId` pointing to the card's **message** id.

The lookup returns `404 NOT_FOUND` for inaccessible rooms, a missing/deleted message, a message
from another room, or a message at/before the caller's cleared DM history marker. A DM's other
participant keeps their own history. No `SEND_MESSAGES` or voice connection is required to read.

`GET /api/rooms/{id}/recordings/{rid}/transcript` returns **HTTP 200** with the existing
`GetRecordingTranscriptResponse` shape, in full, without pagination:

```json
{"recordingId":"0192a100-0000-7000-8000-000000000001","language":"en","segments":[{"speaker":0,"startMs":480,"endMs":6900,"text":"First segment."},{"speaker":-1,"startMs":7200,"endMs":12050,"text":"Unknown speaker."}]}
```

`startMs` / `endMs` are JSON numbers in milliseconds from the recording start; `speaker` is a
zero-based recognition label, or `-1` if unknown. `language` can be empty. `404 NOT_FOUND` means
the room is inaccessible, the recording is missing/deleted, no transcript is saved yet, or the
room has neither the original recording nor a live forwarded copy of its card (ADR-0033).
Use the visible card's `roomId` in the URL, including for a forwarded card. Removing the only
forwarded copy revokes its transcript access. Granting a bot `VIEW_ROOM` exposes the **whole**
saved transcript available through that room, including restricted-room access rules; it does
not grant recording controls (start / stop need `MANAGE_RECORDINGS`, ADR-0051).

### Examples

Send a message (`nonce` is an idempotency key: a retry with the same `nonce` returns the same message with `200`):

```sh
curl -s -X POST $CALAB/api/rooms/$ROOM/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content": "Hi! I am a bot.", "nonce": "hello-1"}'
```
```json
{"message": {"id": "0192a1…", "roomId": "0191f0…", "authorId": "0192…", "content": "Hi! I am a bot.",
             "attachments": [], "replyToId": "", "nonce": "hello-1", "createdAt": "2026-09-27T10:01:02.345Z",
             "reactions": [], "kind": "MESSAGE_KIND_UNSPECIFIED", "…": "…"}}
```

A file: upload first, then attach its id in `attachmentIds`:

```sh
curl -s -X POST $CALAB/api/workspaces/$WS/files -H "Authorization: Bearer $TOKEN" -F file=@report.pdf
# {"file": {"id": "0192b3…", "name": "report.pdf", "mime": "application/pdf", "size": "48213", "url": "/api/files/0192b3…", …}}
curl -s -X POST $CALAB/api/rooms/$ROOM/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content": "Report", "attachmentIds": ["0192b3…"], "nonce": "rep-1"}'
```

A reaction, a reply, a DM:

```sh
curl -s -X PUT "$CALAB/api/messages/$MSG/reactions/%F0%9F%91%8D" -H "Authorization: Bearer $TOKEN"   # 👍 → 204
curl -s -X POST $CALAB/api/rooms/$ROOM/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"content\": \"Done\", \"replyToId\": \"$MSG\", \"nonce\": \"r-1\"}"
curl -s -X POST $CALAB/api/dms -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"userId\": \"$USER\"}"      # → {"dm": {"room": {"id": "…", "type": "ROOM_TYPE_DM", …}, "peer": {…}}}
```

Rooms and members:

```sh
curl -s $CALAB/api/workspaces -H "Authorization: Bearer $TOKEN"              # {"workspaces": [{"id", "name", …}]}
curl -s $CALAB/api/workspaces/$WS/rooms -H "Authorization: Bearer $TOKEN"    # {"rooms": [{"id", "type": "ROOM_TYPE_TEXT", "name", …}]}
curl -s $CALAB/api/workspaces/$WS/members -H "Authorization: Bearer $TOKEN"  # {"members": [{"user": {…}, "role": "WORKSPACE_ROLE_MEMBER", "roleIds": […]}]}
curl -s $CALAB/api/workspaces/$WS/members/$USER -H "Authorization: Bearer $TOKEN"  # {"member": {…}, "openTasks": [{"key": "FNG-12", …}]}
curl -s -X PATCH $CALAB/api/workspaces/$WS/members/$USER -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"nickname": "Bob (sales)"}'      # MANAGE_NICKNAMES → {"member": {…}}
```

Calendar and invitations (ADR-0051):

```sh
# a meeting in a voice room: the bot organizes, Bob and an outside address attend
curl -s -X POST $CALAB/api/workspaces/$WS/events -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"title\": \"Stand-up\", \"roomId\": \"$VOICE\", \"startsAt\": \"2026-10-02T09:00:00Z\", \"endsAt\": \"2026-10-02T09:30:00Z\",
       \"tz\": \"Europe/London\", \"attendees\": [{\"userId\": \"$USER\", \"required\": true}, {\"email\": \"partner@example.com\"}]}"
# → 201 {"event": {"id": "…", "organizerId": "<bot id>", "canEdit": true, "attendees": [...], …}}
curl -s "$CALAB/api/workspaces/$WS/freebusy?users=$USER&from=2026-10-02T00:00:00Z&to=2026-10-03T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN"   # {"users": [{"userId", "timezone", "workHours", "busy": [{"startsAt", "endsAt", "kind"}]}]}
curl -s -X POST $CALAB/api/workspaces/$WS/invites -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"maxUses": 1, "expiresInSeconds": 86400}'   # INVITE_MEMBERS → 201 {"invite": {"code": "…"}}; link https://<APP_HOST>/join/<code>
```

```js
const ev = await bot.calendar.create(wsId, { title: 'Stand-up', roomId, startsAt: timestampFromDate(start), endsAt: timestampFromDate(end),
  attendees: [{ userId, required: true }] });          // import { timestampFromDate } from '@bufbuild/protobuf/wkt'
const { member, openTasks } = await bot.members.get(wsId, userId);
await bot.members.setNickname(wsId, userId, 'Bob');
const invite = await bot.invites.create(wsId, { maxUses: 1 });
```

## Gateway: realtime events

`wss://<APP_HOST>/gateway?v=1` — one socket per bot. Frames are `GatewayFrame { op, seq, oneof payload }`: binary
protobuf by default; with `?encoding=json` — protojson text frames (handy without a protobuf library).

1. Server: `HELLO { heartbeatIntervalMs }` (~41 s).
2. Bot: `IDENTIFY { token: "<bot token>", device: {name, platform, appVersion} }`.
3. Server: `DISPATCH READY` (`seq = 1`): `sessionId`, `me`, `workspaces[]` (each: the workspace, visible rooms,
   members, roles, voice states, presences, the bot's rights per room), `dms[]`, `readStates`.
4. Then `DISPATCH` frames with events and a growing `seq`; the bot sends `HEARTBEAT { lastSeq }` every
   `heartbeatIntervalMs` (the server answers `HEARTBEAT_ACK`). No heartbeat for 2 × interval + 10 s → `4009`.

JSON frames (`?encoding=json`):

```json
→ {"op": "GATEWAY_OPCODE_IDENTIFY", "identify": {"token": "calab_bot_…", "device": {"name": "my-bot", "platform": "linux", "appVersion": "1.0"}}}
← {"op": "GATEWAY_OPCODE_DISPATCH", "seq": "1", "dispatch": {"ready": {"sessionId": "…", "me": {"user": {"id": "…", "isBot": true, …}}, "workspaces": […], "dms": […]}}}
← {"op": "GATEWAY_OPCODE_DISPATCH", "seq": "2", "dispatch": {"messageCreate": {"workspaceId": "…", "message": {"id": "…", "content": "/echo hi", "command": {"botUserId": "…", "name": "echo", "args": "hi"}, …}}}}
→ {"op": "GATEWAY_OPCODE_HEARTBEAT", "heartbeat": {"lastSeq": "2"}}
```

**Events** (the `DispatchEvent.event` field; a bot gets only what it can see through `VIEW_ROOM`):

| Event | When |
|---|---|
| `ready` · `resumed` | after IDENTIFY · after a successful RESUME |
| `messageCreate` · `messageUpdate` · `messageDelete` | messages of rooms and of the bot's DMs (its own included) |
| `messageReactionAdd` · `messageReactionRemove` | reactions |
| `voiceStateUpdate` · `voiceStreamStart/Stop` · `voiceCameraStop` · `voiceMoved` | voice: who is in which room, mute, streams |
| `presenceUpdate` · `userUpdate` | presence and profiles |
| `roomCreate/Update/Delete` · `roomPermissionsUpdate` · `categoryCreate/Update/Delete` | rooms |
| `workspaceCreate/Update/Delete` · `workspaceMemberAdd/Update/Remove` · `roleCreate/Update/Delete` | workspaces, members, roles |
| `dmCreate` | a new DM with the bot |
| `typingStart` | "is typing" — only for rooms in `SUBSCRIBE { roomIds }` |
| `stickerPackCreate/Update/Delete` | the workspace's sticker packs |
| `soundCreate/Update/Delete` · `soundPlay` | the workspace's soundboard; `soundPlay` only while the bot is in the room's call |
| `botCreate/Update/Delete` | the workspace's bots — only with `MANAGE_BOTS` (ADR-0048) |
| `sipCallUpdate` | a room's phone call was placed or changed status (ADR-0046) |
| `eventCreate/Update/Delete` · `eventRsvp` | meetings: its own (the bot organizes) and those of rooms it sees; outside addresses only when the bot may change the meeting |
| `boardCreate/Update/Delete` · `taskCreate/Update/Delete` · `taskActivity` | boards and tasks — by the bot's `VIEW_BOARD` |

A bot can also send `TYPING { roomId }` ("is typing", at most once per 3 s per room), `SUBSCRIBE { roomIds }`
(≤ 100) and `PRESENCE_UPDATE`.

**Reconnect and resume.** On a drop, reconnect with exponential backoff (1 → 30 s, with jitter) and send
`RESUME { token, sessionId, seq }` (the last `seq` processed). The server replays what was missed (buffer ≈ 5 min /
1000 events), then `RESUMED { replayed }`. If the session cannot be resumed — `INVALID_SESSION { resumable: false }`:
send `IDENTIFY` on the same socket after 1–5 s and get a new `READY`. `RECONNECT` — the server asks you to reconnect
(deploy). Skip events with `seq ≤` the last processed one.

| Close | What to do |
|---|---|
| `4000` (except `replaced by a new session`), `4001`, `4002`, `1006` | reconnect, `RESUME` |
| `4000 replaced by a new session` | another process connected with the same token — do not reconnect |
| `4003`, `4007`, `4009` | reconnect, new `IDENTIFY` |
| `4004` | invalid token — do not reconnect |
| `4008` | limited (flood, a send queue of 256 frames overflowed) — back off, `RESUME` |
| `4010` | token revoked / bot deleted — do not reconnect |

Socket limits: frame ≤ 64 KiB; inbound `TYPING` / `SUBSCRIBE` / `PRESENCE_UPDATE` — at most 10 in a row and 2/s
(extras are dropped), > 50 frames/s sustained → `4008`. The SDK does all of this for you.

## Commands

- A bot registers its commands: `PUT /api/bots/me/commands` `{commands: [{name, description}]}` — a full
  replacement, ≤ 100, name `[a-z0-9_]{1,32}` (a leading `/` is stripped), description ≤ 256 characters. The composer
  suggests them on `/` (`GET /api/rooms/{id}/bot-commands`); people see them in the bot's profile.
- A message that starts with `/name` or `/name@username` (followed by a space or the end of the text) reaches
  everyone as a plain message, while the addressed bot's `messageCreate` carries `message.command
  { botUserId, name, args }` (`name` in lower case, `args` — the rest of the text, trimmed).
- `/name@username` — to that bot, if it can see the room (the command need not be registered). `/name` — to the only
  bot of the room that registered `name`; if several did, it is not a command (use `@username`).
- In a DM with a bot, `/name` is addressed to it. Messages written by bots are never commands (no bot ↔ bot loops).
- `command` exists only in events (gateway, webhook); REST responses and history do not have it.
- Mentioning a bot is an ordinary mention: `@<bot id>` in the text; `GET /api/me/mentions` lists messages that
  mention the bot.

```js
bot.on('command', async (c) => {
  if (c.name === 'roll') await bot.reply(c, String(1 + Math.floor(Math.random() * Number(c.args || 6))));
});
```

## Webhook

Instead of (or together with) the gateway, the server can push events to the bot over HTTPS — handy for serverless.

- Enable: `PUT /api/bots/me/webhook {url, secret}` — `url` must be `https://` to a public address (private networks,
  `localhost`, private IP ranges are refused), `secret` 16..256 characters. The response is `BotWebhookResponse
  { webhook: {url, enabled, disabledAt, failingSince, lastOkAt, lastError, pending} }`; `GET` — the current state,
  `DELETE` → 204 (the queue is dropped).
- Delivered: `messageCreate/Update/Delete` and `messageReactionAdd/Remove` of rooms the bot can see and of its DMs —
  except its own messages and reactions. Commands work as on the gateway (`message.command`). Since ADR-0051 also
  `taskCreate/Update/Delete` and `taskActivity` of boards it sees, `eventCreate/Update/Delete` and `eventRsvp` (as on
  the gateway: outside addresses only to a bot that may change the meeting) and `workspaceMemberUpdate`.
- Request: `POST <url>`, `Content-Type: application/json`, `User-Agent: CalabBot-Webhook/1.0`, the body is
  `BotWebhookUpdate { id, botUserId, createdAt, event: DispatchEvent }` (protojson), headers
  `X-Calab-Delivery: <id>` and `X-Calab-Signature: sha256=<hex HMAC-SHA256(secret, body)>`.
- Success is any `2xx` within 10 s; redirects are not followed (they count as failures). Retries: 1 min, 2, 4 … up
  to 1 h between attempts; a delivery lives for a day. A webhook failing for a whole day is **disabled**
  (`webhook.disabledAt`, the queue is dropped, the bot's owner and managers get `BOT_UPDATE`); `PUT` enables it again.
- Order is not guaranteed and repeats are possible — dedupe by `id`. Answer fast, do the work after answering.

```json
{"id": "0192c4…", "botUserId": "0192…", "createdAt": "2026-09-27T10:05:00Z",
 "event": {"messageCreate": {"workspaceId": "0191…", "message": {"id": "0192c3…", "roomId": "…", "authorId": "…",
   "content": "/ping", "command": {"botUserId": "0192…", "name": "ping", "args": ""}, "…": "…"}}}}
```

Verifying the signature (compute the HMAC over the **raw bytes** of the body, not over re-serialized JSON):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
const ok = (secret, rawBody, header) => {
  const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'));
  const got = Buffer.from(header ?? '');
  return want.length === got.length && timingSafeEqual(want, got);
};
```

```python
import hmac, hashlib
def ok(secret: bytes, raw_body: bytes, header: str) -> bool:
    return hmac.compare_digest("sha256=" + hmac.new(secret, raw_body, hashlib.sha256).hexdigest(), header or "")
```

In the SDK: `new Bot(token, { server, webhookSecret })` and `bot.handleWebhook(rawBody, headers)` — it verifies the
signature, drops repeats and emits the same `message` / `command` / `reaction` events as the gateway.

## Board webhook

(ADR-0058.) A board POSTs JSON to your HTTPS address whenever something changes in its tasks. It is separate from the
[bot webhook](#webhook): one webhook per board, every task change, no event filter.

- **Who configures it.** People only (a bot gets `403 BOT_NOT_ALLOWED`: it holds a secret and exports data): `MANAGE_BOARD`
  on the board **and** `MANAGE_INTEGRATIONS` of the workspace, **Business** plan (below it: `409 CONFLICT`, `reason PLAN_LIMIT`).
  The webhook belongs to the board, not its creator: anyone with `MANAGE_BOARD` sees and changes it.
- **Routes.** `PUT /api/boards/{id}/webhook {url, secret?}` — create, replace, or re-enable a disabled one; `url` is
  `https://` to a public address only, `secret` 16..256 characters; empty — the server generates 32 random bytes (base64url)
  and returns `secret` **once** in the response. `GET` — the state (`url`, `hasSecret`, `enabled`, `disabledAt`,
  `failingSince`, `lastOkAt`, `lastError`, `pending`, `pausedReason`); the secret is never returned. `DELETE` → 204 (the
  queue is marked `failed`). `POST …/webhook/ping` — synchronously sends a `ping` event the same way →
  `{ok, status, error}`, at most once per 10 s (`429`).
- **Events** (`type`): `task.created`, `task.updated` (any change: fields, status, assignees, relations, attachments,
  approvals, checklists), `task.archived`, `task.restored` (auto-archive — `actor: null`), `task.moved_in` (the target
  board; the task already has its new key), `task.moved_out` (the source board), `task.comment.created`,
  `task.comment.updated`, `task.comment.deleted`, `ping`. The changes of one transaction make one event; `changes` are the
  task's journal entries (`field` = the journal `kind`: `status`, `assignees`, `checklist`, `milestones`, `git` …; `before` / `after` —
  their data). Changes made by an **automation rule** (ADR-0060) come as their own event of the same transaction with
  `"actor": null` and `"rule": {"id", "name"}`; for changes by people and bots `rule` is `null`. Git events (a task's
  links to branches and pull requests) are `task.updated` with `changes[field=git]` and `"actor": null`. The webhook
  version stays `1`: fields were only added.
- **Request.** `POST <url>`, `Content-Type: application/json`, `User-Agent: Calab-Webhook/1.0`, headers:

  | Header | Value |
  |---|---|
  | `X-Calab-Webhook-Version` | `1` (the contract only grows by adding fields) |
  | `X-Calab-Event` | the event `type` |
  | `X-Calab-Delivery` | the delivery id (= `id` in the body) |
  | `X-Calab-Timestamp` | unix seconds of sending |
  | `X-Calab-Signature` | `v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>` |

- **Signature.** The HMAC is computed over `timestamp + "." + the raw body bytes`. Reject the request when
  `|now − timestamp| > 5 minutes` (replay protection) and compare signatures in constant time. Bots stay on `sha256=…`
  without a timestamp.
- **Delivery.** At-least-once: repeats are possible and the order of arrival is not guaranteed. **Idempotency** — by `id`
  (remember the ones you saw); **ordering** — by `sequence` (monotonic per board, from 1; `ping` has 0). Success is any
  `2xx` within 10 s, redirects are errors. Retries: 1 min, 2, 4 … up to 1 h, a delivery lives a day; a webhook failing for
  a day in a row is **disabled** (`enabled: false`, the queue is dropped; `PUT` re-enables it). Accept bodies up to 256 KB.
- **Pauses.** When the plan drops below Business the webhook is kept but paused (`pausedReason = PLAN`): new events are not
  queued, after an upgrade delivery continues with new events. An archived board is read-only and produces no events; the
  queue already accumulated is still delivered.
- **Known gap.** Comment events are queued **after** the message commits: if the process dies exactly between the two the
  event is lost (a rare window; task-change events are written in the same transaction and are not lost).

### Body format

`BoardWebhookEvent` in protojson, but with the **proto field names (snake_case)**, not the lowerCamelCase of REST. Every
field is present: unset ones are `null` (`actor: null` for server-made changes, `edited_at: null`), empty strings and lists
as they are; `uint64` (e.g. an attachment `size`) is a **string**, `sequence` is a number. `task` is the task without any
viewer data (`subscribed`, `muted`, `unread`, `viewer_state` are always at their defaults), `attachments` and `checklists`
are always empty (the `attachment_count`, `checklist_total/done` counters stay); milestones (`milestones`,
`milestone_progress`, `task_milestone_id`, ADR-0063) are as they are; `comment` only for `task.comment.*`. The task link is `task_url`. A real example (the
golden fixture `apps/server/internal/boards/testdata/webhook_event.json`, fields in alphabetical order; to show both
`changes` and `comment` it is assembled together — in a real `task.updated`, `comment` is `null`):

```json
{
  "actor": {
    "id": "0192a000-0000-7000-8000-0000000000cc",
    "is_bot": false,
    "name": "Анна"
  },
  "board": {
    "id": "0192a000-0000-7000-8000-0000000000bb",
    "key": "FNG",
    "name": "Финансы"
  },
  "changes": [
    {
      "after": {
        "status_id": "s2",
        "status_type": "started"
      },
      "before": {
        "status_id": "s1",
        "status_type": "unstarted"
      },
      "field": "status"
    }
  ],
  "comment": {
    "attachments": [
      {
        "mime": "application/pdf",
        "name": "a.pdf",
        "size": "1024"
      }
    ],
    "author_id": "u1",
    "created_at": "2026-10-02T12:00:00Z",
    "edited_at": null,
    "id": "m1",
    "text": "готово"
  },
  "id": "0192a000-0000-7000-8000-000000000001",
  "occurred_at": "2026-10-02T12:00:00Z",
  "rule": null,
  "sequence": 42,
  "task": {
    "approval_required": 0,
    "approval_state": "TASK_APPROVAL_STATE_UNSPECIFIED",
    "approvers": [],
    "archived_at": null,
    "assignees": [],
    "attachment_count": 0,
    "attachments": [],
    "board_id": "0192a000-0000-7000-8000-0000000000bb",
    "checklist_done": 3,
    "checklist_total": 7,
    "checklists": [],
    "comment_count": 0,
    "completed_at": null,
    "completed_by": "",
    "created_at": "2026-10-02T12:00:00Z",
    "created_by": "",
    "description": "",
    "due_on": "",
    "estimate": 3,
    "git_links": [],
    "git_links_count": 0,
    "id": "0192a000-0000-7000-8000-0000000000dd",
    "key": "FNG-12",
    "label_ids": [],
    "milestone_id": "",
    "milestone_progress": null,
    "milestones": [],
    "muted": false,
    "number": 12,
    "parent_id": "",
    "position": 0,
    "priority": "TASK_PRIORITY_HIGH",
    "relations": [],
    "room_id": "",
    "start_on": "",
    "started_at": null,
    "status_id": "s2",
    "subscribed": false,
    "subtask_count": 0,
    "subtask_done": 0,
    "task_milestone_id": "",
    "title": "Отчёт",
    "unread": false,
    "updated_at": "2026-10-02T12:00:00Z",
    "viewer_state": false,
    "workspace_id": ""
  },
  "task_url": "https://app.example.com/t/FNG-12",
  "type": "task.updated",
  "version": 1,
  "workspace_id": "0192a000-0000-7000-8000-0000000000aa"
}
```

`task.moved_out` carries only what the source board knew: `task` holds just `id`, the old `key` and the source `board_id`,
`changes` is a single `moved_board` entry with `before`; the whole task (new key, the target's statuses and labels) arrives
in the target board's `task.moved_in`.

### Verifying the signature

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody — the raw body bytes (a Buffer), not re-serialized JSON; headers — request headers, lower-case
export function verifyBoardWebhook(secret, rawBody, headers, now = Date.now() / 1000) {
  const ts = headers['x-calab-timestamp'];
  if (!ts || Math.abs(now - Number(ts)) > 300) return false; // replay: ±5 minute window
  const want = Buffer.from('v1=' + createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex'));
  const got = Buffer.from(headers['x-calab-signature'] ?? '');
  return want.length === got.length && timingSafeEqual(want, got);
}
```

```python
import hashlib, hmac, time

def verify_board_webhook(secret: bytes, raw_body: bytes, headers: dict, now: float | None = None) -> bool:
    ts = headers.get("X-Calab-Timestamp", "")
    if not ts.isdigit() or abs((now or time.time()) - int(ts)) > 300:  # replay: ±5 minute window
        return False
    mac = hmac.new(secret, ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest("v1=" + mac, headers.get("X-Calab-Signature", ""))
```

In the SDK: `verifyBoardWebhook(secret, timestamp, body, signature)` from `@calaba/bot-sdk` (checks the signature and the
±5 minute window; `parseBoardWebhookEvent(body)` parses the body).

## Voice through LiveKit

Media flows directly through LiveKit (the SFU) — our REST API does not proxy it. A bot in a call is an ordinary
participant: a row in the list with a "BOT" badge, a speaking indicator; server mute / kick act on it as on a
person; it takes a place in the room.

1. `POST /api/rooms/{id}/join` (a voice room, `CONNECT` right) →
   `JoinVoiceResponse { url, token, identity, media, canSpeak, canStream, canVideo, pending }`.
   `token` is a 10-minute LiveKit JWT whose grant follows the bot's rights: `SPEAK` → publish a microphone, `STREAM`
   → screen share (if a slot is free), `VIDEO` → camera (call `POST /api/rooms/{id}/camera/request` before
   publishing). Connect right away: without a connection within 15 s the place is freed.
2. Connect a LiveKit client with `url` + `token`: subscribe to participants' audio tracks, publish your own audio
   track (Opus 48 kHz, "microphone" source).
3. Leave: disconnect from LiveKit and call `POST /api/rooms/{id}/voice/leave` (→ 204) — the place is freed at once.

Who is in the room: `voiceStates` in `READY` and `voiceStateUpdate` events (empty `roomId` = left).

**Node** (`@livekit/rtc-node`, full example — [`examples/bots/voice-echo`](../examples/bots/voice-echo)):

```js
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind,
  TrackPublishOptions, TrackSource } from '@livekit/rtc-node';

const { url, token, canSpeak } = await bot.voice.join(roomId);
const room = new Room();
await room.connect(url, token, { autoSubscribe: true });
room.on(RoomEvent.TrackSubscribed, async (track, _pub, participant) => {
  if (track.kind !== TrackKind.KIND_AUDIO) return;
  for await (const frame of new AudioStream(track, 48000, 1)) {
    // frame.data is an Int16Array: 10 ms of PCM from participant.identity
  }
});
const source = new AudioSource(48000, 1);
if (canSpeak) {
  await room.localParticipant.publishTrack(LocalAudioTrack.createAudioTrack('bot', source),
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  await source.captureFrame(new AudioFrame(pcm480, 48000, 1, 480)); // 10 ms at a time
}
// …
await room.disconnect();
await bot.voice.leave(roomId);
```

**Python** (`pip install livekit`, full example — [`examples/bots/python/voice_listen.py`](../examples/bots/python/voice_listen.py)):

```python
from livekit import rtc
join = api("POST", f"/api/rooms/{room_id}/join")          # {"url", "token", …}
room = rtc.Room()

@room.on("track_subscribed")
def on_track(track, publication, participant):
    if track.kind == rtc.TrackKind.KIND_AUDIO:
        asyncio.create_task(listen(track, participant.identity))

async def listen(track, who):
    async for ev in rtc.AudioStream(track, sample_rate=48000, num_channels=1):
        pcm = ev.frame.data            # memoryview of int16

await room.connect(join["url"], join["token"])
# to speak: source = rtc.AudioSource(48000, 1); track = rtc.LocalAudioTrack.create_audio_track("bot", source)
# await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
```

Go: `livekit/server-sdk-go` (`lksdk.ConnectToRoomWithToken(url, token, callbacks)`). Text to speech —
[`examples/bots/tts`](../examples/bots/tts).

## Stickers over the API

- Send a sticker: `POST /api/rooms/{id}/messages {stickerId, nonce}` (empty `content`, no attachments). The sticker
  must come from a pack of this workspace (in a DM — of a workspace where both participants are not guests).
- Packs: `GET /api/workspaces/{id}/sticker-packs` → `{packs}`; `GET /api/me/sticker-packs` → `{installed, available}`;
  `PUT/DELETE /api/me/sticker-packs/{id}` — install for the bot / remove.
- Creating and changing packs needs `MANAGE_STICKERS` for the bot:
  ```sh
  curl -s -X POST $CALAB/api/workspaces/$WS/sticker-packs -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d '{"name": "Cats", "shortName": "cats"}'        # → 201 {"pack": {…}}
  curl -s -X POST $CALAB/api/sticker-packs/$PACK/stickers -H "Authorization: Bearer $TOKEN" \
    -F emoji=😺 -F file=@cat1.webp -F emoji=😿 -F file=@cat2.webp                        # → {"pack", "added": […]}
  ```
  Each `file` (WebP, sides ≤ 512, ≤ 512 KB static / ≤ 1 MB animated) is preceded by an `emoji` field; up to 50 per
  request, all or nothing (`422`, `field: "file[i]"`), ≤ 120 per pack, plan limits `sticker_packs` / `stickers`
  (`409 PLAN_LIMIT`). `PATCH /api/sticker-packs/{id} {name?, shortName?, coverStickerId?, stickerIds}`,
  `PATCH /api/stickers/{id} {emoji}`, `DELETE /api/stickers/{id}`, `DELETE /api/sticker-packs/{id}`.

## Limits and errors

| Limit | Value |
|---|---|
| Bot requests | 30/s (burst 30), env `BOT_RATE_PER_SEC` |
| Bot messages | 20/min across all rooms and DMs, env `BOT_MESSAGES_PER_MIN`; plus the common 5 per 5 s per room |
| New DMs | 10 at once, 30/h |
| File uploads | 30 at once, 120/h; size and quota per plan |
| Message | ≤ 4000 characters, ≤ 20 attachments, `nonce` ≤ 64 |
| Commands | ≤ 100, name ≤ 32, description ≤ 256 |
| Bots per workspace | plan key `bots` (free 1, team 20); a bot also takes a member seat (`members`, free 50) |
| Gateway | 1 socket per token, frame ≤ 64 KiB |

Every error is an `ApiError`. `code` comes from `ErrorCode` (`ERROR_CODE_…`):

| HTTP | `code` / `reason` | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | malformed JSON / parameters |
| 401 | `UNAUTHENTICATED` | no token, wrong, revoked or reissued |
| 403 | `FORBIDDEN`, `reason: "BOT_NOT_ALLOWED"` | an endpoint for people only |
| 403 | `FORBIDDEN` | a missing right (`message` names it) |
| 403 | `BOT_BLOCKED` | the person blocked the bot: new DMs and messages in the DM with them are refused |
| 403 | `WORKSPACE_SUSPENDED` | the workspace is suspended: writing is refused, reading works |
| 404 | `NOT_FOUND` | no such object, or it is hidden from the bot |
| 409 | `CONFLICT`, `reason: "PLAN_LIMIT"` (`used`/`limit`) | a plan limit (bots, packs, stickers) |
| 409 | `CONFLICT`, `reason: "REACTION_LIMIT"` | at most 3 different reactions per message |
| 409 | `CONFLICT`, `reason: "FEATURE_DISABLED"` (`field`) | the board feature is switched off and the request sets its field to a non-empty value |
| 409 | `CONFLICT`, `reason: "CHECKLIST_LIMIT"` / `"CHECKLIST_ITEM_LIMIT"` / `"BOARD_CATEGORY_LIMIT"` (`used`/`limit`) | ≤ 10 checklists per task, ≤ 100 items per checklist, ≤ 50 board categories per workspace |
| 409 | `ROOM_FULL` | the voice room is full |
| 413 | `FILE_TOO_LARGE`, `FILE_QUOTA_EXCEEDED`, `PAYLOAD_TOO_LARGE` | size / quota |
| 422 | `VALIDATION` (`field`) | an invalid field value |
| 429 | `RATE_LIMITED` + `Retry-After` header (s) | wait and retry (with the same `nonce`) |
| 503 | `UNAVAILABLE` | a temporary failure — retry later |

## FAQ

**The bot does not see a room / messages.** No `VIEW_ROOM`: a private room, a closed one (only through an override on it, ADR-0048), or
the bot's role gives no access. Check the roles and the room's overrides.

**The bot does not answer `/cmd`.** Nobody registered the command, or several bots of the room did — write
`/cmd@username`. Messages written by bots are never commands.

**Can a bot join another workspace?** Yes: an admin of that workspace adds it ("Add bot" via the `/bots/<username>`
link). The bot is managed (token, deletion) in its home workspace.

**Do I need the gateway if I have a webhook?** No. A webhook bot works through REST and the webhook only and counts as
online while it makes requests. Voice events (`voiceStateUpdate`) come only through the gateway.

**Two processes with one token?** No — the second pushes the first out. To scale, use the webhook (idempotent
processing by `id`) or several bots.

**Does the bot hear itself?** No: LiveKit never sends a participant its own tracks. The SDK skips the bot's own
messages and reactions by default (`receiveOwn: true` delivers them).

**Where are the types?** `proto/calaba/v1/*.proto` is the source of truth; `@calaba/protocol` (TS, protobuf-es) and the
Go code are generated from it. For other languages — `buf generate` with the plugin you need, or protojson by hand.

## Inline buttons (ADR-0047)

Attach `inlineKeyboard` to an ordinary bot message. Buttons call only their author bot;
forwarded copies have no active buttons. A keyboard has at most 5 rows of 5 buttons,
50 `allowedUserIds`, unique button ids (1–64 ASCII letters/digits/`_`/`-`), labels of
1–80 characters without controls, and `data` of at most 512 UTF-8 bytes. `disabled`
prevents a press. All keyboard fields are public message metadata, never secrets.

```ts
const message = await bot.send(roomId, {
  text: 'Review this draft',
  inlineKeyboard: {
    allowedUserIds: [authorId],
    rows: [{ buttons: [{ id: 'confirm', label: 'Confirm', data: 'draft:42:v3' }] }],
  },
});
await bot.edit(message.id, { inlineKeyboard: { rows: [] } }); // remove, keep text
// bot.edit(message.id, { text: 'Revised draft', inlineKeyboard: nextKeyboard });
bot.on('callback', (callback) => {
  // Persist callback.id in your inbox; verify callback.userId against the draft author,
  // messageId and your CURRENT draft version before applying any external effect.
});
```

REST `PATCH /api/messages/{id}`: omitted `inlineKeyboard` keeps it; `{}` removes it.
For a keyboard-only edit, send `preserveContent:true` and omit `content`. This flag
requires a supplied keyboard and rejects nonempty replacement text. Without it,
`content` keeps its previous semantics (omitted/empty = empty text, allowed only with
attachments). The SDK sets the flag automatically when edit options omit `text`.
Every text/keyboard edit changes server-owned `keyboardRevision`.

People press with `POST /api/messages/{id}/interactions`:
`{buttonId, keyboardRevision, nonce}`. The server requires VIEW_ROOM + SEND_MESSAGES,
checks the live message, current keyboard, allowed user, active accessible author bot,
blocks and cleared DM history. A bot removed from the last shared workspace cannot
receive old DM actions. `KEYBOARD_STALE` / `BUTTON_UNAVAILABLE` return 409. Actor and
callback data come from the server. The route is denied to bots.

200 `{interactionId}` means **accepted, not completed**. `botCallback` contains `id`,
`botUserId`, `userId`, `workspaceId` (empty in DM), `roomId`, `messageId`, `buttonId`,
`data`, `keyboardRevision`, `createdAt`. Only the author bot gets it via its gateway
user channel and configured signed webhook. An enabled webhook is queued atomically
with the receipt and uses existing retry/expiry rules. Gateway is best effort after
commit: ordinary RESUME can replay buffered events, but a fresh session cannot recover
missed callbacks; important actions should use webhook. No chat message is posted.

Retry the same actor's `nonce` (1–64 bytes) for the same press: the original id returns
without redelivery, including after a keyboard edit/removal, subject to current access
and message/bot existence. Reusing it for different inputs conflicts. Receipts last
until the message is physically deleted. Separate nonces can both be accepted.
Bots must durably dedupe `callback.id` across transports and retries and use idempotency
for external effects. A callback accepted before a draft changes is not cancelled:
revalidate your own current draft/version. The SDK's bounded webhook cache is not an
exactly-once guarantee. The UI disables the whole keyboard after acceptance until the
bot sends a new revision; stale clicks refresh the message without executing a new action.

## Board forms (ADR-0064)

Team allows 5 forms per board, Business 20, Custom/on-prem follows configured limits
(0 is unlimited). Management requires `VIEW_BOARD | MANAGE_BOARD`, using the normal bot
Bearer token: `GET/POST /api/boards/{id}/forms`, `PUT/DELETE /api/boards/{id}/forms/{fid}`.
PUT replaces `definition` and requires its current `revision`. SDK: `bot.forms.list/create/update/delete`.

`BoardFormDefinition` contains title, description, fields (UUID id, type, label, hint,
placeholder, required, options), titleFieldId (optional single-value title source, excluding CHECKBOX/MULTISELECT), statusId,
priority, isPrivate and allowedUserIds. Field types: TEXT, PARAGRAPH, EMAIL, NUMBER,
DATE, SELECT, CHECKBOX, PHONE, URL, MULTISELECT, with the `BOARD_FORM_FIELD_TYPE_` JSON enum prefix.
Management does not bypass a private form's allowlist: include the bot's user ID explicitly.

`GET /api/forms/{code}` returns the respondent view; `POST …/submissions` accepts
`{revision,nonce,answers:[{fieldId,value}]}` and returns `{receiptId}` without task details.
Keep the same UUID nonce when retrying: identical submissions create one task. Values are
strings; checkboxes use `"true"` or `"false"`. SDK: `bot.forms.get/submit`.
`POST /api/boards/{id}/forms/preview {definition,answers}` (`bot.forms.preview`) validates
an unsaved definition and answers without creating tasks, numbers or webhook deliveries.
Request/response types come from `@calaba/protocol`.

Errors: FORM_CHANGED (reload revision), NONCE_CONFLICT (nonce reused for other content),
FORM_TARGET_UNAVAILABLE (status removed), PLAN_LIMIT, FEATURE_DISABLED. Deleting a form
revokes its link and preserves tasks. Anonymous `/api/public/forms/{code}` is a public
capability blocked by enforced SSO; bots use authenticated `/api/forms/{code}`.

PHONE preserves formatting and leading zeroes (7–15 digits, up to 64 characters; optional
leading `+`, spaces, parentheses, dots and hyphens). URL accepts absolute HTTP/HTTPS without
credentials or whitespace; no URL fetching occurs. MULTISELECT uses
`{fieldId, values:["Design","Support"]}` with no `value`; other types use only `value`.
Unknown/duplicate options are rejected; choice order does not affect nonce idempotency.
Missing/unanswered `titleFieldId` uses the form title. A title-source answer is collapsed to
one line and truncated to 200 characters; its full value is retained in the task description.
