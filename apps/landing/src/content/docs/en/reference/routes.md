---
title: Bot routes
description: Every Calab server route with its decision for a bot token — allowed by permissions, public or closed.
order: 1
---

Every server route is explicitly classified for bots. A new route can't ship without a decision: a test fails when a route is missing from the table, and an unlisted route is closed to bots at run time.

| Decision | What it means for a bot |
|---|---|
| **Allowed** | the bot calls the route like a person; the server checks the permissions of its roles and overrides |
| **Public** | the route needs no authentication; the bot is anonymous there. Public handlers that authenticate on their own (guest links, invitation answers) refuse bot tokens |
| **Closed** | people only: `403 FORBIDDEN`, `reason: "BOT_NOT_ALLOWED"` — whatever the bot's roles |

Administrative routes marked “logged as a bot action” are written to the server log with the bot's owner: the route, the response status, the bot and the owner.

> [!NOTE]
> This page is built from the server's route table. If a route isn't listed here, it isn't available to bots.

## Allowed to bots


### Messages

Details: [Messages](../bots/rest-messages).

<!-- routes:allow:messages -->
| Method | Path | What it does |
|---|---|---|
| `DELETE` | `/api/messages/{id}` | by role permissions |
| `PATCH` | `/api/messages/{id}` | by role permissions |
| `PUT` | `/api/messages/{id}/embeds-hidden` | by role permissions |
| `DELETE` | `/api/messages/{id}/pin` | by role permissions |
| `PUT` | `/api/messages/{id}/pin` | by role permissions |
| `DELETE` | `/api/messages/{id}/reactions/{emoji}` | by role permissions |
| `GET` | `/api/messages/{id}/reactions/{emoji}` | by role permissions |
| `PUT` | `/api/messages/{id}/reactions/{emoji}` | by role permissions |
| `GET` | `/api/rooms/{id}/messages` | by role permissions |
| `POST` | `/api/rooms/{id}/messages` | by role permissions |
| `GET` | `/api/rooms/{id}/messages/{messageId}` | by role permissions |
| `POST` | `/api/rooms/{id}/messages/{mid}/forward` | by role permissions |
| `GET` | `/api/rooms/{id}/pins` | by role permissions |
| `PUT` | `/api/rooms/{id}/read` | by role permissions |
| `GET` | `/api/rooms/{id}/recordings/{rid}/transcript` | by role permissions |
<!-- /routes -->

### Rooms and voice

Details: [Rooms and voice](../bots/rest-rooms).

<!-- routes:allow:rooms -->
| Method | Path | What it does |
|---|---|---|
| `DELETE` | `/api/categories/{id}` | by role permissions |
| `PATCH` | `/api/categories/{id}` | by role permissions |
| `DELETE` | `/api/rooms/{id}` | logged as a bot action |
| `GET` | `/api/rooms/{id}` | by role permissions |
| `PATCH` | `/api/rooms/{id}` | by role permissions |
| `GET` | `/api/rooms/{id}/admissions` | by role permissions |
| `POST` | `/api/rooms/{id}/admissions/{userId}` | logged as a bot action |
| `POST` | `/api/rooms/{id}/calls` | by role permissions |
| `DELETE` | `/api/rooms/{id}/calls/{cid}` | by role permissions |
| `POST` | `/api/rooms/{id}/camera/request` | by role permissions |
| `POST` | `/api/rooms/{id}/camera/stop` | by role permissions |
| `POST` | `/api/rooms/{id}/join` | by role permissions |
| `PUT` | `/api/rooms/{id}/permissions` | logged as a bot action |
| `POST` | `/api/rooms/{id}/recording/start` | logged as a bot action |
| `POST` | `/api/rooms/{id}/recording/stop` | logged as a bot action |
| `POST` | `/api/rooms/{id}/sounds/play` | by role permissions |
| `POST` | `/api/rooms/{id}/stream/request` | by role permissions |
| `PATCH` | `/api/rooms/{id}/voice-status` | by role permissions |
| `POST` | `/api/rooms/{id}/voice/{userId}/allow-camera` | by role permissions |
| `POST` | `/api/rooms/{id}/voice/{userId}/disconnect` | by role permissions |
| `POST` | `/api/rooms/{id}/voice/{userId}/move` | by role permissions |
| `POST` | `/api/rooms/{id}/voice/{userId}/mute` | by role permissions |
| `POST` | `/api/rooms/{id}/voice/{userId}/stop-camera` | by role permissions |
| `POST` | `/api/rooms/{id}/voice/{userId}/stop-stream` | by role permissions |
| `POST` | `/api/rooms/{id}/voice/{userId}/unmute` | by role permissions |
| `POST` | `/api/rooms/{id}/voice/leave` | by role permissions |
| `PATCH` | `/api/voice/self` | by role permissions |
| `GET` | `/api/workspaces/{id}/categories` | by role permissions |
| `POST` | `/api/workspaces/{id}/categories` | by role permissions |
| `GET` | `/api/workspaces/{id}/rooms` | by role permissions |
| `POST` | `/api/workspaces/{id}/rooms` | by role permissions |
| `PUT` | `/api/workspaces/{id}/rooms/order` | by role permissions |
| `POST` | `/api/workspaces/{id}/rooms/temp` | by role permissions |
| `GET` | `/api/workspaces/{id}/sounds` | by role permissions |
| `POST` | `/api/workspaces/{id}/sounds` | logged as a bot action |
| `DELETE` | `/api/workspaces/{id}/sounds/{soundId}` | logged as a bot action |
| `PATCH` | `/api/workspaces/{id}/sounds/{soundId}` | logged as a bot action |
<!-- /routes -->

### Workspace and members

Details: [Workspace and members](../bots/rest-members).

<!-- routes:allow:members -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/workspaces` | by role permissions |
| `GET` | `/api/workspaces/{id}` | by role permissions |
| `PATCH` | `/api/workspaces/{id}` | logged as a bot action |
| `GET` | `/api/workspaces/{id}/achievements` | by role permissions |
| `GET` | `/api/workspaces/{id}/badges` | by role permissions |
| `POST` | `/api/workspaces/{id}/badges` | logged as a bot action |
| `DELETE` | `/api/workspaces/{id}/badges/{badgeId}` | logged as a bot action |
| `PATCH` | `/api/workspaces/{id}/badges/{badgeId}` | logged as a bot action |
| `GET` | `/api/workspaces/{id}/bans` | by role permissions |
| `POST` | `/api/workspaces/{id}/bans` | logged as a bot action |
| `DELETE` | `/api/workspaces/{id}/bans/{userId}` | logged as a bot action |
| `GET` | `/api/workspaces/{id}/birthdays` | by role permissions |
| `GET` | `/api/workspaces/{id}/invites` | by role permissions |
| `POST` | `/api/workspaces/{id}/invites` | logged as a bot action |
| `DELETE` | `/api/workspaces/{id}/invites/{inviteId}` | logged as a bot action |
| `GET` | `/api/workspaces/{id}/invites/email` | by role permissions |
| `POST` | `/api/workspaces/{id}/invites/email` | logged as a bot action |
| `DELETE` | `/api/workspaces/{id}/invites/email/{inviteId}` | logged as a bot action |
| `GET` | `/api/workspaces/{id}/members` | by role permissions |
| `DELETE` | `/api/workspaces/{id}/members/{userId}` | logged as a bot action |
| `GET` | `/api/workspaces/{id}/members/{userId}` | by role permissions |
| `PATCH` | `/api/workspaces/{id}/members/{userId}` | logged as a bot action |
| `GET` | `/api/workspaces/{id}/members/{userId}/achievements` | by role permissions |
| `PUT` | `/api/workspaces/{id}/members/{userId}/badge` | logged as a bot action |
| `POST` | `/api/workspaces/{id}/members/{userId}/promote` | logged as a bot action |
| `PUT` | `/api/workspaces/{id}/members/{userId}/roles` | logged as a bot action |
| `GET` | `/api/workspaces/{id}/roles` | by role permissions |
| `POST` | `/api/workspaces/{id}/roles` | logged as a bot action |
| `DELETE` | `/api/workspaces/{id}/roles/{roleId}` | logged as a bot action |
| `PATCH` | `/api/workspaces/{id}/roles/{roleId}` | logged as a bot action |
| `PUT` | `/api/workspaces/{id}/roles/order` | logged as a bot action |
<!-- /routes -->

### Boards and tasks

Details: [Boards and tasks](../bots/rest-boards).

<!-- routes:allow:boards -->
| Method | Path | What it does |
|---|---|---|
| `DELETE` | `/api/board-categories/{id}` | by role permissions |
| `PATCH` | `/api/board-categories/{id}` | by role permissions |
| `DELETE` | `/api/boards/{id}` | by role permissions |
| `GET` | `/api/boards/{id}` | by role permissions |
| `PATCH` | `/api/boards/{id}` | by role permissions |
| `GET` | `/api/boards/{id}/activity` | by role permissions |
| `POST` | `/api/boards/{id}/files` | by role permissions |
| `POST` | `/api/boards/{id}/labels` | by role permissions |
| `DELETE` | `/api/boards/{id}/labels/{sid}` | by role permissions |
| `PATCH` | `/api/boards/{id}/labels/{sid}` | by role permissions |
| `POST` | `/api/boards/{id}/milestones` | by role permissions |
| `DELETE` | `/api/boards/{id}/milestones/{sid}` | by role permissions |
| `PATCH` | `/api/boards/{id}/milestones/{sid}` | by role permissions |
| `GET` | `/api/boards/{id}/permissions` | by role permissions |
| `PUT` | `/api/boards/{id}/position` | by role permissions |
| `POST` | `/api/boards/{id}/restore` | by role permissions |
| `GET` | `/api/boards/{id}/rules` | by role permissions |
| `POST` | `/api/boards/{id}/statuses` | by role permissions |
| `DELETE` | `/api/boards/{id}/statuses/{sid}` | by role permissions |
| `PATCH` | `/api/boards/{id}/statuses/{sid}` | by role permissions |
| `GET` | `/api/boards/{id}/tasks` | by role permissions |
| `POST` | `/api/boards/{id}/tasks` | by role permissions |
| `GET` | `/api/boards/{id}/views` | by role permissions |
| `POST` | `/api/boards/{id}/views` | by role permissions |
| `DELETE` | `/api/boards/{id}/views/{sid}` | by role permissions |
| `PATCH` | `/api/boards/{id}/views/{sid}` | by role permissions |
| `DELETE` | `/api/checklist-items/{id}` | by role permissions |
| `PATCH` | `/api/checklist-items/{id}` | by role permissions |
| `POST` | `/api/checklist-items/{id}/convert` | by role permissions |
| `DELETE` | `/api/checklists/{id}` | by role permissions |
| `PATCH` | `/api/checklists/{id}` | by role permissions |
| `POST` | `/api/checklists/{id}/items` | by role permissions |
| `GET` | `/api/me/tasks` | by role permissions |
| `GET` | `/api/rules/{id}/runs` | by role permissions |
| `GET` | `/api/t/{key}` | by role permissions |
| `DELETE` | `/api/task-milestones/{id}` | by role permissions |
| `PATCH` | `/api/task-milestones/{id}` | by role permissions |
| `GET` | `/api/tasks/{id}` | by role permissions |
| `PATCH` | `/api/tasks/{id}` | by role permissions |
| `GET` | `/api/tasks/{id}/activity` | by role permissions |
| `PUT` | `/api/tasks/{id}/approvers` | by role permissions |
| `POST` | `/api/tasks/{id}/archive` | by role permissions |
| `PUT` | `/api/tasks/{id}/assignees` | by role permissions |
| `POST` | `/api/tasks/{id}/checklists` | by role permissions |
| `POST` | `/api/tasks/{id}/milestones` | by role permissions |
| `PUT` | `/api/tasks/{id}/read` | by role permissions |
| `DELETE` | `/api/tasks/{id}/relations` | by role permissions |
| `PUT` | `/api/tasks/{id}/relations` | by role permissions |
| `POST` | `/api/tasks/{id}/restore` | by role permissions |
| `PUT` | `/api/tasks/{id}/subscription` | by role permissions |
| `DELETE` | `/api/tasks/{id}/watchers` | by role permissions |
| `PUT` | `/api/tasks/{id}/watchers` | by role permissions |
| `GET` | `/api/workspaces/{id}/board-categories` | by role permissions |
| `POST` | `/api/workspaces/{id}/board-categories` | by role permissions |
| `GET` | `/api/workspaces/{id}/boards` | by role permissions |
| `POST` | `/api/workspaces/{id}/boards` | by role permissions |
| `PUT` | `/api/workspaces/{id}/boards/order` | by role permissions |
| `GET` | `/api/workspaces/{id}/tasks/search` | by role permissions |
<!-- /routes -->

### Board forms

Details: [Board forms](../bots/rest-forms).

<!-- routes:allow:forms -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/boards/{id}/forms` | by role permissions |
| `POST` | `/api/boards/{id}/forms` | by role permissions |
| `DELETE` | `/api/boards/{id}/forms/{fid}` | by role permissions |
| `PUT` | `/api/boards/{id}/forms/{fid}` | by role permissions |
| `POST` | `/api/boards/{id}/forms/preview` | by role permissions |
| `GET` | `/api/forms/{code}` | by role permissions |
| `POST` | `/api/forms/{code}/submissions` | by role permissions |
<!-- /routes -->

### Calendar

Details: [Calendar](../bots/rest-calendar).

<!-- routes:allow:calendar -->
| Method | Path | What it does |
|---|---|---|
| `DELETE` | `/api/events/{id}` | logged as a bot action |
| `GET` | `/api/events/{id}` | by role permissions |
| `PATCH` | `/api/events/{id}` | logged as a bot action |
| `GET` | `/api/workspaces/{id}/events` | by role permissions |
| `POST` | `/api/workspaces/{id}/events` | logged as a bot action |
| `GET` | `/api/workspaces/{id}/freebusy` | by role permissions |
| `POST` | `/api/workspaces/{id}/freebusy/suggest` | by role permissions |
<!-- /routes -->

### Direct messages

Details: [Direct messages](../bots/rest-dm).

<!-- routes:allow:dm -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/dms` | by role permissions |
| `POST` | `/api/dms` | by role permissions |
| `POST` | `/api/dms/{id}/files` | by role permissions |
| `GET` | `/api/dms/candidates` | by role permissions |
<!-- /routes -->

### Files

Details: [Files](../bots/rest-files).

<!-- routes:allow:files -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/files/{id}` | by role permissions |
| `GET` | `/api/files/{id}/thumbnail` | by role permissions |
| `POST` | `/api/workspaces/{id}/files` | by role permissions |
<!-- /routes -->

### Stickers

Details: [Stickers](../bots/rest-stickers).

<!-- routes:allow:stickers -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/me/sticker-packs` | by role permissions |
| `DELETE` | `/api/me/sticker-packs/{id}` | by role permissions |
| `PUT` | `/api/me/sticker-packs/{id}` | by role permissions |
| `PUT` | `/api/me/sticker-packs/order` | by role permissions |
| `DELETE` | `/api/sticker-packs/{id}` | by role permissions |
| `GET` | `/api/sticker-packs/{id}` | by role permissions |
| `PATCH` | `/api/sticker-packs/{id}` | by role permissions |
| `POST` | `/api/sticker-packs/{id}/stickers` | by role permissions |
| `PUT` | `/api/sticker-packs/{id}/stickers/{sid}` | by role permissions |
| `DELETE` | `/api/stickers/{id}` | by role permissions |
| `PATCH` | `/api/stickers/{id}` | by role permissions |
| `GET` | `/api/workspaces/{id}/sticker-packs` | by role permissions |
| `POST` | `/api/workspaces/{id}/sticker-packs` | by role permissions |
<!-- /routes -->

### Search

Details: [Search](../bots/rest-search).

<!-- routes:allow:search -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/me/mentions` | by role permissions |
| `GET` | `/api/search` | by role permissions |
| `GET` | `/api/workspaces/{id}/messages/search` | by role permissions |
<!-- /routes -->

### Bot profile

Details: [Bot profile](../bots/rest-profile).

<!-- routes:allow:profile -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/bots/me` | by role permissions |
| `PATCH` | `/api/bots/me` | by role permissions |
| `PUT` | `/api/bots/me/commands` | by role permissions |
| `DELETE` | `/api/bots/me/webhook` | by role permissions |
| `GET` | `/api/bots/me/webhook` | by role permissions |
| `PUT` | `/api/bots/me/webhook` | by role permissions |
| `GET` | `/api/me` | by role permissions |
| `PATCH` | `/api/me` | by role permissions |
| `POST` | `/api/me/avatar` | by role permissions |
| `GET` | `/api/rooms/{id}/bot-commands` | by role permissions |
<!-- /routes -->


## Public routes

Available without a token. A bot may call them, but anonymously — its permissions do not apply there.

<!-- routes:public -->
| Method | Path | What it does |
|---|---|---|
| `ANY` | `/api/` | no authentication |
| `POST` | `/api/auth/login` | no authentication |
| `POST` | `/api/auth/logout` | no authentication |
| `POST` | `/api/auth/password/forgot` | no authentication |
| `POST` | `/api/auth/password/reset` | no authentication |
| `POST` | `/api/auth/refresh` | no authentication |
| `POST` | `/api/auth/register` | no authentication |
| `GET` | `/api/billing/public/offers` | no authentication |
| `GET` | `/api/billing/return` | no authentication |
| `POST` | `/api/billing/stripe/webhook` | no authentication |
| `POST` | `/api/billing/tochka/webhook` | no authentication |
| `POST` | `/api/billing/tochkapay/webhook` | no authentication |
| `GET` | `/api/event-rsvp` | no authentication |
| `POST` | `/api/event-rsvp` | no authentication |
| `POST` | `/api/git/boards/{id}/{provider}` | no authentication |
| `GET` | `/api/invites/{code}` | no authentication |
| `GET` | `/api/public/disk/{code}` | no authentication |
| `GET` | `/api/public/disk/{code}/content` | no authentication |
| `GET` | `/api/public/disk/{code}/thumbnail` | no authentication |
| `GET` | `/api/public/forms/{code}` | no authentication |
| `POST` | `/api/public/forms/{code}/submissions` | no authentication |
| `GET` | `/api/room-invites/{code}` | no authentication |
| `POST` | `/api/room-invites/{code}/join` | no authentication |
| `POST` | `/api/rtc/webhook` | no authentication |
| `GET` | `/api/stickers/builtin/{name}` | no authentication |
| `GET` | `/api/version` | no authentication |
| `GET` | `/gateway` | no authentication |
| `GET` | `/healthz` | no authentication |
| `GET` | `/metrics` | no authentication |
| `GET` | `/readyz` | no authentication |
<!-- /routes -->


## Closed to bots

These answer a bot with `403 FORBIDDEN` and `reason: "BOT_NOT_ALLOWED"`. For the reasons, see [Token and permissions](../bots/auth#always-closed-to-bots).

<!-- routes:deny -->
| Method | Path | Area |
|---|---|---|
| `POST` | `/api/auth/verify` | Account |
| `POST` | `/api/auth/verify/send` | Account |
| `PATCH` | `/api/dms/{id}/state` | Account |
| `GET` | `/api/me/blocked-bots` | Account |
| `DELETE` | `/api/me/blocked-bots/{id}` | Account |
| `POST` | `/api/me/blocked-bots/{id}` | Account |
| `PATCH` | `/api/me/email` | Account |
| `PATCH` | `/api/me/password` | Account |
| `GET` | `/api/me/sessions` | Account |
| `DELETE` | `/api/me/sessions/{id}` | Account |
| `PATCH` | `/api/me/status` | Account |
| `GET` | `/api/usernames/{name}/available` | Account |
| `DELETE` | `/api/users/{id}/note` | Account |
| `GET` | `/api/users/{id}/note` | Account |
| `PUT` | `/api/users/{id}/note` | Account |
| `GET` | `/api/admin/billing/accounts` | Billing |
| `GET` | `/api/admin/billing/accounts/{id}` | Billing |
| `POST` | `/api/admin/billing/accounts/{id}/admin-debit` | Billing |
| `POST` | `/api/admin/billing/accounts/{id}/charges/{attemptId}/check` | Billing |
| `PUT` | `/api/admin/billing/accounts/{id}/custom-plan` | Billing |
| `PUT` | `/api/admin/billing/accounts/{id}/discount` | Billing |
| `POST` | `/api/admin/billing/accounts/{id}/hold` | Billing |
| `GET` | `/api/admin/billing/accounts/{id}/ledger` | Billing |
| `POST` | `/api/admin/billing/accounts/{id}/manual-credits` | Billing |
| `POST` | `/api/admin/billing/accounts/{id}/manual-credits/{creditId}/reverse` | Billing |
| `POST` | `/api/admin/billing/accounts/{id}/market` | Billing |
| `POST` | `/api/admin/billing/accounts/{id}/plan` | Billing |
| `POST` | `/api/admin/billing/accounts/{id}/reconcile` | Billing |
| `POST` | `/api/admin/billing/auto-topup/reconcile` | Billing |
| `GET` | `/api/admin/billing/disputes` | Billing |
| `POST` | `/api/admin/billing/disputes/{id}/close` | Billing |
| `GET` | `/api/admin/billing/events` | Billing |
| `GET` | `/api/admin/billing/issues` | Billing |
| `POST` | `/api/admin/billing/issues/{id}/dismiss` | Billing |
| `POST` | `/api/admin/billing/issues/{id}/import` | Billing |
| `GET` | `/api/admin/billing/payments` | Billing |
| `POST` | `/api/admin/billing/payments/{id}/chargebacks` | Billing |
| `POST` | `/api/admin/billing/payments/{id}/refunds` | Billing |
| `GET` | `/api/admin/billing/prices` | Billing |
| `POST` | `/api/admin/billing/prices` | Billing |
| `GET` | `/api/admin/billing/providers` | Billing |
| `PUT` | `/api/admin/billing/providers/{provider}` | Billing |
| `GET` | `/api/admin/billing/refunds` | Billing |
| `POST` | `/api/admin/billing/test-clock` | Billing |
| `POST` | `/api/admin/billing/workspaces/{id}/enable` | Billing |
| `GET` | `/api/workspaces/{id}/billing` | Billing |
| `POST` | `/api/workspaces/{id}/billing/activate` | Billing |
| `DELETE` | `/api/workspaces/{id}/billing/auto-topup` | Billing |
| `GET` | `/api/workspaces/{id}/billing/auto-topup` | Billing |
| `PUT` | `/api/workspaces/{id}/billing/auto-topup` | Billing |
| `POST` | `/api/workspaces/{id}/billing/change-plan` | Billing |
| `GET` | `/api/workspaces/{id}/billing/checkouts/{cid}` | Billing |
| `GET` | `/api/workspaces/{id}/billing/ledger` | Billing |
| `GET` | `/api/workspaces/{id}/billing/payer` | Billing |
| `PUT` | `/api/workspaces/{id}/billing/payer` | Billing |
| `GET` | `/api/workspaces/{id}/billing/payer-schema` | Billing |
| `GET` | `/api/workspaces/{id}/billing/payment-methods` | Billing |
| `DELETE` | `/api/workspaces/{id}/billing/payment-methods/{pmId}` | Billing |
| `GET` | `/api/workspaces/{id}/billing/payments` | Billing |
| `POST` | `/api/workspaces/{id}/billing/quote` | Billing |
| `POST` | `/api/workspaces/{id}/billing/resume` | Billing |
| `POST` | `/api/workspaces/{id}/billing/saved-method-topups` | Billing |
| `GET` | `/api/workspaces/{id}/billing/saved-method-topups/{tid}` | Billing |
| `POST` | `/api/workspaces/{id}/billing/stop` | Billing |
| `POST` | `/api/workspaces/{id}/billing/topups` | Billing |
| `DELETE` | `/api/boards/{id}/git` | Boards and tasks |
| `GET` | `/api/boards/{id}/git` | Boards and tasks |
| `PUT` | `/api/boards/{id}/git` | Boards and tasks |
| `PUT` | `/api/boards/{id}/permissions` | Boards and tasks |
| `POST` | `/api/boards/{id}/rules` | Boards and tasks |
| `DELETE` | `/api/boards/{id}/webhook` | Boards and tasks |
| `GET` | `/api/boards/{id}/webhook` | Boards and tasks |
| `PUT` | `/api/boards/{id}/webhook` | Boards and tasks |
| `POST` | `/api/boards/{id}/webhook/ping` | Boards and tasks |
| `DELETE` | `/api/rules/{id}` | Boards and tasks |
| `PATCH` | `/api/rules/{id}` | Boards and tasks |
| `POST` | `/api/rules/{id}/test` | Boards and tasks |
| `POST` | `/api/tasks/{id}/approval` | Boards and tasks |
| `GET` | `/api/bots/{ref}` | Bot management |
| `GET` | `/api/workspaces/{id}/bots` | Bot management |
| `POST` | `/api/workspaces/{id}/bots` | Bot management |
| `DELETE` | `/api/workspaces/{id}/bots/{botId}` | Bot management |
| `DELETE` | `/api/workspaces/{id}/bots/{botId}/avatar` | Bot management |
| `POST` | `/api/workspaces/{id}/bots/{botId}/avatar` | Bot management |
| `DELETE` | `/api/workspaces/{id}/bots/{botId}/token` | Bot management |
| `POST` | `/api/workspaces/{id}/bots/{botId}/token` | Bot management |
| `POST` | `/api/workspaces/{id}/bots/add` | Bot management |
| `PUT` | `/api/events/{id}/rsvp` | Calendar |
| `DELETE` | `/api/me/caldav` | Calendar |
| `GET` | `/api/me/caldav` | Calendar |
| `PATCH` | `/api/me/caldav` | Calendar |
| `POST` | `/api/me/caldav` | Calendar |
| `PUT` | `/api/me/caldav` | Calendar |
| `POST` | `/api/me/caldav/sync` | Calendar |
| `GET` | `/api/me/events/today` | Calendar |
| `DELETE` | `/api/me/external-events` | Calendar |
| `GET` | `/api/me/external-events` | Calendar |
| `POST` | `/api/me/external-events/rsvp` | Calendar |
| `DELETE` | `/api/disk/items/{id}` | Disk |
| `GET` | `/api/disk/items/{id}` | Disk |
| `PATCH` | `/api/disk/items/{id}` | Disk |
| `GET` | `/api/disk/items/{id}/activity` | Disk |
| `DELETE` | `/api/disk/items/{id}/link` | Disk |
| `POST` | `/api/disk/items/{id}/link` | Disk |
| `GET` | `/api/disk/items/{id}/path` | Disk |
| `GET` | `/api/disk/items/{id}/permissions` | Disk |
| `PUT` | `/api/disk/items/{id}/permissions` | Disk |
| `POST` | `/api/disk/items/{id}/restore` | Disk |
| `POST` | `/api/disk/items/{id}/trash` | Disk |
| `GET` | `/api/workspaces/{id}/disk/activity` | Disk |
| `POST` | `/api/workspaces/{id}/disk/folders` | Disk |
| `GET` | `/api/workspaces/{id}/disk/items` | Disk |
| `GET` | `/api/workspaces/{id}/disk/settings` | Disk |
| `PUT` | `/api/workspaces/{id}/disk/settings` | Disk |
| `POST` | `/api/workspaces/{id}/disk/trash/empty` | Disk |
| `POST` | `/api/workspaces/{id}/disk/upload` | Disk |
| `GET` | `/api/workspaces/{id}/disk/usage` | Disk |
| `GET` | `/.well-known/oauth-authorization-server/oidc/workspaces/{workspace}` | Identity |
| `POST` | `/api/auth/local/reauth` | Identity |
| `GET` | `/api/auth/sso/browser-start` | Identity |
| `GET` | `/api/auth/sso/callback/{connection_id}` | Identity |
| `POST` | `/api/auth/sso/exchange` | Identity |
| `POST` | `/api/auth/sso/finish` | Identity |
| `POST` | `/api/auth/sso/workspaces/{id}/logout` | Identity |
| `POST` | `/api/auth/sso/workspaces/{id}/refresh` | Identity |
| `GET` | `/api/auth/sso/workspaces/{slug}` | Identity |
| `POST` | `/api/auth/sso/workspaces/{workspace_id}/begin` | Identity |
| `POST` | `/api/auth/sso/workspaces/{workspace_id}/recover` | Identity |
| `GET` | `/api/me/oauth-grants` | Identity |
| `DELETE` | `/api/me/oauth-grants/{grant}` | Identity |
| `POST` | `/api/oauth/requests/{request}/bind` | Identity |
| `POST` | `/api/oauth/requests/{request}/decision` | Identity |
| `GET` | `/api/workspaces/{workspace_id}/identity` | Identity |
| `PUT` | `/api/workspaces/{workspace_id}/identity/connection` | Identity |
| `POST` | `/api/workspaces/{workspace_id}/identity/connections/{connection_id}/activate` | Identity |
| `GET` | `/api/workspaces/{workspace_id}/identity/directory` | Identity |
| `PUT` | `/api/workspaces/{workspace_id}/identity/directory` | Identity |
| `GET` | `/api/workspaces/{workspace_id}/identity/directory/members` | Identity |
| `PUT` | `/api/workspaces/{workspace_id}/identity/directory/members/{user_id}` | Identity |
| `POST` | `/api/workspaces/{workspace_id}/identity/directory/sync` | Identity |
| `POST` | `/api/workspaces/{workspace_id}/identity/directory/test` | Identity |
| `DELETE` | `/api/workspaces/{workspace_id}/identity/link` | Identity |
| `PUT` | `/api/workspaces/{workspace_id}/identity/policy` | Identity |
| `POST` | `/api/workspaces/{workspace_id}/identity/recovery-kit` | Identity |
| `POST` | `/api/workspaces/{workspace_id}/identity/test` | Identity |
| `GET` | `/api/workspaces/{workspace}/oauth/clients` | Identity |
| `POST` | `/api/workspaces/{workspace}/oauth/clients` | Identity |
| `DELETE` | `/api/workspaces/{workspace}/oauth/clients/{client}` | Identity |
| `GET` | `/api/workspaces/{workspace}/oauth/clients/{client}` | Identity |
| `PATCH` | `/api/workspaces/{workspace}/oauth/clients/{client}` | Identity |
| `POST` | `/api/workspaces/{workspace}/oauth/clients/{client}/rotate-secret` | Identity |
| `GET` | `/oidc/workspaces/{workspace}/.well-known/openid-configuration` | Identity |
| `OPTIONS` | `/oidc/workspaces/{workspace}/{endpoint}` | Identity |
| `GET` | `/oidc/workspaces/{workspace}/authorize` | Identity |
| `POST` | `/oidc/workspaces/{workspace}/authorize` | Identity |
| `GET` | `/oidc/workspaces/{workspace}/jwks` | Identity |
| `POST` | `/oidc/workspaces/{workspace}/revoke` | Identity |
| `POST` | `/oidc/workspaces/{workspace}/token` | Identity |
| `GET` | `/oidc/workspaces/{workspace}/userinfo` | Identity |
| `POST` | `/oidc/workspaces/{workspace}/userinfo` | Identity |
| `DELETE` | `/api/achievements/{id}` | Members |
| `PATCH` | `/api/achievements/{id}` | Members |
| `POST` | `/api/workspaces/{id}/achievements` | Members |
| `POST` | `/api/workspaces/{id}/members/{userId}/achievements` | Members |
| `DELETE` | `/api/workspaces/{id}/members/{userId}/achievements/{grantId}` | Members |
| `PATCH` | `/api/workspaces/{id}/members/{userId}/birthday` | Members |
| `GET` | `/api/workspaces/{id}/members/birthdays` | Members |
| `POST` | `/api/files/convert` | Messages and files |
| `POST` | `/api/messages/{id}/interactions` | Messages and files |
| `GET` | `/api/unfurl` | Messages and files |
| `GET` | `/api/unfurl/image` | Messages and files |
| `GET` | `/api/notes` | Notes |
| `POST` | `/api/notes` | Notes |
| `DELETE` | `/api/notes/{id}` | Notes |
| `PATCH` | `/api/notes/{id}` | Notes |
| `POST` | `/api/calls/{id}/accept` | One-to-one calls |
| `POST` | `/api/calls/{id}/cancel` | One-to-one calls |
| `POST` | `/api/calls/{id}/decline` | One-to-one calls |
| `POST` | `/api/calls/{id}/hangup` | One-to-one calls |
| `POST` | `/api/dms/{id}/call` | One-to-one calls |
| `GET` | `/api/me/push-capabilities` | Push |
| `POST` | `/api/me/push-devices` | Push |
| `DELETE` | `/api/me/push-devices/{id}` | Push |
| `POST` | `/api/me/push-resolve` | Push |
| `DELETE` | `/api/rooms/{id}/admissions/me` | Rooms |
| `GET` | `/api/rooms/{id}/invites` | Rooms |
| `POST` | `/api/rooms/{id}/invites` | Rooms |
| `DELETE` | `/api/rooms/{id}/invites/{inviteId}` | Rooms |
| `PATCH` | `/api/rooms/{id}/invites/{inviteId}` | Rooms |
| `PUT` | `/api/rooms/{id}/notifications` | Rooms |
| `GET` | `/api/admin/users/{id}/storage-quota` | Superadmin |
| `PUT` | `/api/admin/users/{id}/storage-quota` | Superadmin |
| `GET` | `/api/admin/workspaces` | Superadmin |
| `GET` | `/api/admin/workspaces/{id}` | Superadmin |
| `PUT` | `/api/admin/workspaces/{id}/plan` | Superadmin |
| `GET` | `/api/admin/workspaces/{id}/plan/log` | Superadmin |
| `PUT` | `/api/admin/workspaces/{id}/suspension` | Superadmin |
| `DELETE` | `/api/rooms/{id}/recordings/{rid}` | Telephony and recordings |
| `POST` | `/api/rooms/{id}/recordings/{rid}/recheck` | Telephony and recordings |
| `POST` | `/api/rooms/{id}/recordings/{rid}/reupload` | Telephony and recordings |
| `GET` | `/api/workspaces/{id}/calls` | Telephony and recordings |
| `DELETE` | `/api/workspaces/{id}/integrations/gptunnel` | Telephony and recordings |
| `GET` | `/api/workspaces/{id}/integrations/gptunnel` | Telephony and recordings |
| `POST` | `/api/workspaces/{id}/integrations/gptunnel` | Telephony and recordings |
| `GET` | `/api/workspaces/{id}/sip` | Telephony and recordings |
| `PUT` | `/api/workspaces/{id}/sip` | Telephony and recordings |
| `POST` | `/api/workspaces/{id}/sip/test` | Telephony and recordings |
| `DELETE` | `/api/workspace-apps/{appId}` | Web apps and backgrounds |
| `PATCH` | `/api/workspace-apps/{appId}` | Web apps and backgrounds |
| `PUT` | `/api/workspace-apps/{appId}/position` | Web apps and backgrounds |
| `GET` | `/api/workspaces/{id}/apps` | Web apps and backgrounds |
| `POST` | `/api/workspaces/{id}/apps` | Web apps and backgrounds |
| `GET` | `/api/workspaces/{id}/backgrounds` | Web apps and backgrounds |
| `POST` | `/api/workspaces/{id}/backgrounds` | Web apps and backgrounds |
| `DELETE` | `/api/workspaces/{id}/backgrounds/{bgId}` | Web apps and backgrounds |
| `PATCH` | `/api/workspaces/{id}/backgrounds/{bgId}` | Web apps and backgrounds |
| `POST` | `/api/invites/{code}/join` | Workspaces and invites |
| `POST` | `/api/workspaces` | Workspaces and invites |
| `DELETE` | `/api/workspaces/{id}` | Workspaces and invites |
| `POST` | `/api/workspaces/{id}/invites/lookup` | Workspaces and invites |
| `POST` | `/api/workspaces/{id}/join` | Workspaces and invites |
| `POST` | `/api/workspaces/{id}/members` | Workspaces and invites |
| `PUT` | `/api/workspaces/{id}/notifications` | Workspaces and invites |
| `GET` | `/api/workspaces/discover` | Workspaces and invites |
<!-- /routes -->

