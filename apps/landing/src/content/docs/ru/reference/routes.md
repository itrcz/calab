---
title: Маршруты ботов
description: Все маршруты сервера Calab с решением для токена бота — доступно по правам, публично или закрыто.
order: 1
---

Каждый маршрут сервера явно классифицирован для ботов. Новый маршрут не попадёт в сервер без решения: тест падает, если маршрут не указан в таблице, а неуказанный маршрут во время работы закрыт для ботов.

| Решение | Что значит для бота |
|---|---|
| **Доступно** | бот вызывает маршрут как человек; сервер проверяет права его ролей и переопределения |
| **Публично** | маршрут без авторизации; бот там анонимен. Публичные обработчики, которые сами проверяют вход (гостевые ссылки, ответы на приглашения), токен бота отклоняют |
| **Закрыто** | только для людей: `403 FORBIDDEN`, `reason: "BOT_NOT_ALLOWED"` — какие бы роли ни были у бота |

Административные маршруты, помеченные «журналируется как действие бота», сервер записывает в журнал с владельцем бота: маршрут, статус ответа, бот, владелец.

> [!NOTE]
> Эта страница собирается из таблицы маршрутов сервера. Если маршрута здесь нет — боту он недоступен.

## Доступно ботам


### Сообщения

Подробно — [Сообщения](../bots/rest-messages).

<!-- routes:allow:messages -->
| Метод | Путь | Что делает |
|---|---|---|
| `DELETE` | `/api/messages/{id}` | по правам ролей |
| `PATCH` | `/api/messages/{id}` | по правам ролей |
| `PUT` | `/api/messages/{id}/embeds-hidden` | по правам ролей |
| `DELETE` | `/api/messages/{id}/pin` | по правам ролей |
| `PUT` | `/api/messages/{id}/pin` | по правам ролей |
| `DELETE` | `/api/messages/{id}/reactions/{emoji}` | по правам ролей |
| `GET` | `/api/messages/{id}/reactions/{emoji}` | по правам ролей |
| `PUT` | `/api/messages/{id}/reactions/{emoji}` | по правам ролей |
| `GET` | `/api/rooms/{id}/messages` | по правам ролей |
| `POST` | `/api/rooms/{id}/messages` | по правам ролей |
| `GET` | `/api/rooms/{id}/messages/{messageId}` | по правам ролей |
| `POST` | `/api/rooms/{id}/messages/{mid}/forward` | по правам ролей |
| `GET` | `/api/rooms/{id}/pins` | по правам ролей |
| `PUT` | `/api/rooms/{id}/read` | по правам ролей |
| `GET` | `/api/rooms/{id}/recordings/{rid}/transcript` | по правам ролей |
<!-- /routes -->

### Комнаты и голос

Подробно — [Комнаты и голос](../bots/rest-rooms).

<!-- routes:allow:rooms -->
| Метод | Путь | Что делает |
|---|---|---|
| `DELETE` | `/api/categories/{id}` | по правам ролей |
| `PATCH` | `/api/categories/{id}` | по правам ролей |
| `DELETE` | `/api/rooms/{id}` | журналируется как действие бота |
| `GET` | `/api/rooms/{id}` | по правам ролей |
| `PATCH` | `/api/rooms/{id}` | по правам ролей |
| `GET` | `/api/rooms/{id}/admissions` | по правам ролей |
| `POST` | `/api/rooms/{id}/admissions/{userId}` | журналируется как действие бота |
| `POST` | `/api/rooms/{id}/calls` | по правам ролей |
| `DELETE` | `/api/rooms/{id}/calls/{cid}` | по правам ролей |
| `POST` | `/api/rooms/{id}/camera/request` | по правам ролей |
| `POST` | `/api/rooms/{id}/camera/stop` | по правам ролей |
| `POST` | `/api/rooms/{id}/join` | по правам ролей |
| `PUT` | `/api/rooms/{id}/permissions` | журналируется как действие бота |
| `POST` | `/api/rooms/{id}/recording/start` | журналируется как действие бота |
| `POST` | `/api/rooms/{id}/recording/stop` | журналируется как действие бота |
| `POST` | `/api/rooms/{id}/sounds/play` | по правам ролей |
| `POST` | `/api/rooms/{id}/stream/request` | по правам ролей |
| `PATCH` | `/api/rooms/{id}/voice-status` | по правам ролей |
| `POST` | `/api/rooms/{id}/voice/{userId}/allow-camera` | по правам ролей |
| `POST` | `/api/rooms/{id}/voice/{userId}/disconnect` | по правам ролей |
| `POST` | `/api/rooms/{id}/voice/{userId}/move` | по правам ролей |
| `POST` | `/api/rooms/{id}/voice/{userId}/mute` | по правам ролей |
| `POST` | `/api/rooms/{id}/voice/{userId}/stop-camera` | по правам ролей |
| `POST` | `/api/rooms/{id}/voice/{userId}/stop-stream` | по правам ролей |
| `POST` | `/api/rooms/{id}/voice/{userId}/unmute` | по правам ролей |
| `POST` | `/api/rooms/{id}/voice/leave` | по правам ролей |
| `PATCH` | `/api/voice/self` | по правам ролей |
| `GET` | `/api/workspaces/{id}/categories` | по правам ролей |
| `POST` | `/api/workspaces/{id}/categories` | по правам ролей |
| `GET` | `/api/workspaces/{id}/rooms` | по правам ролей |
| `POST` | `/api/workspaces/{id}/rooms` | по правам ролей |
| `PUT` | `/api/workspaces/{id}/rooms/order` | по правам ролей |
| `POST` | `/api/workspaces/{id}/rooms/temp` | по правам ролей |
| `GET` | `/api/workspaces/{id}/sounds` | по правам ролей |
| `POST` | `/api/workspaces/{id}/sounds` | журналируется как действие бота |
| `DELETE` | `/api/workspaces/{id}/sounds/{soundId}` | журналируется как действие бота |
| `PATCH` | `/api/workspaces/{id}/sounds/{soundId}` | журналируется как действие бота |
<!-- /routes -->

### Пространство и участники

Подробно — [Пространство и участники](../bots/rest-members).

<!-- routes:allow:members -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/workspaces` | по правам ролей |
| `GET` | `/api/workspaces/{id}` | по правам ролей |
| `PATCH` | `/api/workspaces/{id}` | журналируется как действие бота |
| `GET` | `/api/workspaces/{id}/achievements` | по правам ролей |
| `GET` | `/api/workspaces/{id}/badges` | по правам ролей |
| `POST` | `/api/workspaces/{id}/badges` | журналируется как действие бота |
| `DELETE` | `/api/workspaces/{id}/badges/{badgeId}` | журналируется как действие бота |
| `PATCH` | `/api/workspaces/{id}/badges/{badgeId}` | журналируется как действие бота |
| `GET` | `/api/workspaces/{id}/bans` | по правам ролей |
| `POST` | `/api/workspaces/{id}/bans` | журналируется как действие бота |
| `DELETE` | `/api/workspaces/{id}/bans/{userId}` | журналируется как действие бота |
| `GET` | `/api/workspaces/{id}/birthdays` | по правам ролей |
| `GET` | `/api/workspaces/{id}/invites` | по правам ролей |
| `POST` | `/api/workspaces/{id}/invites` | журналируется как действие бота |
| `DELETE` | `/api/workspaces/{id}/invites/{inviteId}` | журналируется как действие бота |
| `GET` | `/api/workspaces/{id}/invites/email` | по правам ролей |
| `POST` | `/api/workspaces/{id}/invites/email` | журналируется как действие бота |
| `DELETE` | `/api/workspaces/{id}/invites/email/{inviteId}` | журналируется как действие бота |
| `GET` | `/api/workspaces/{id}/members` | по правам ролей |
| `DELETE` | `/api/workspaces/{id}/members/{userId}` | журналируется как действие бота |
| `GET` | `/api/workspaces/{id}/members/{userId}` | по правам ролей |
| `PATCH` | `/api/workspaces/{id}/members/{userId}` | журналируется как действие бота |
| `GET` | `/api/workspaces/{id}/members/{userId}/achievements` | по правам ролей |
| `PUT` | `/api/workspaces/{id}/members/{userId}/badge` | журналируется как действие бота |
| `POST` | `/api/workspaces/{id}/members/{userId}/promote` | журналируется как действие бота |
| `PUT` | `/api/workspaces/{id}/members/{userId}/roles` | журналируется как действие бота |
| `GET` | `/api/workspaces/{id}/roles` | по правам ролей |
| `POST` | `/api/workspaces/{id}/roles` | журналируется как действие бота |
| `DELETE` | `/api/workspaces/{id}/roles/{roleId}` | журналируется как действие бота |
| `PATCH` | `/api/workspaces/{id}/roles/{roleId}` | журналируется как действие бота |
| `PUT` | `/api/workspaces/{id}/roles/order` | журналируется как действие бота |
<!-- /routes -->

### Доски и задачи

Подробно — [Доски и задачи](../bots/rest-boards).

<!-- routes:allow:boards -->
| Метод | Путь | Что делает |
|---|---|---|
| `DELETE` | `/api/board-categories/{id}` | по правам ролей |
| `PATCH` | `/api/board-categories/{id}` | по правам ролей |
| `DELETE` | `/api/boards/{id}` | по правам ролей |
| `GET` | `/api/boards/{id}` | по правам ролей |
| `PATCH` | `/api/boards/{id}` | по правам ролей |
| `GET` | `/api/boards/{id}/activity` | по правам ролей |
| `POST` | `/api/boards/{id}/files` | по правам ролей |
| `POST` | `/api/boards/{id}/labels` | по правам ролей |
| `DELETE` | `/api/boards/{id}/labels/{sid}` | по правам ролей |
| `PATCH` | `/api/boards/{id}/labels/{sid}` | по правам ролей |
| `POST` | `/api/boards/{id}/milestones` | по правам ролей |
| `DELETE` | `/api/boards/{id}/milestones/{sid}` | по правам ролей |
| `PATCH` | `/api/boards/{id}/milestones/{sid}` | по правам ролей |
| `GET` | `/api/boards/{id}/permissions` | по правам ролей |
| `PUT` | `/api/boards/{id}/position` | по правам ролей |
| `POST` | `/api/boards/{id}/restore` | по правам ролей |
| `GET` | `/api/boards/{id}/rules` | по правам ролей |
| `POST` | `/api/boards/{id}/statuses` | по правам ролей |
| `DELETE` | `/api/boards/{id}/statuses/{sid}` | по правам ролей |
| `PATCH` | `/api/boards/{id}/statuses/{sid}` | по правам ролей |
| `GET` | `/api/boards/{id}/tasks` | по правам ролей |
| `POST` | `/api/boards/{id}/tasks` | по правам ролей |
| `GET` | `/api/boards/{id}/views` | по правам ролей |
| `POST` | `/api/boards/{id}/views` | по правам ролей |
| `DELETE` | `/api/boards/{id}/views/{sid}` | по правам ролей |
| `PATCH` | `/api/boards/{id}/views/{sid}` | по правам ролей |
| `DELETE` | `/api/checklist-items/{id}` | по правам ролей |
| `PATCH` | `/api/checklist-items/{id}` | по правам ролей |
| `POST` | `/api/checklist-items/{id}/convert` | по правам ролей |
| `DELETE` | `/api/checklists/{id}` | по правам ролей |
| `PATCH` | `/api/checklists/{id}` | по правам ролей |
| `POST` | `/api/checklists/{id}/items` | по правам ролей |
| `GET` | `/api/me/tasks` | по правам ролей |
| `GET` | `/api/rules/{id}/runs` | по правам ролей |
| `GET` | `/api/t/{key}` | по правам ролей |
| `DELETE` | `/api/task-milestones/{id}` | по правам ролей |
| `PATCH` | `/api/task-milestones/{id}` | по правам ролей |
| `GET` | `/api/tasks/{id}` | по правам ролей |
| `PATCH` | `/api/tasks/{id}` | по правам ролей |
| `GET` | `/api/tasks/{id}/activity` | по правам ролей |
| `PUT` | `/api/tasks/{id}/approvers` | по правам ролей |
| `POST` | `/api/tasks/{id}/archive` | по правам ролей |
| `PUT` | `/api/tasks/{id}/assignees` | по правам ролей |
| `POST` | `/api/tasks/{id}/checklists` | по правам ролей |
| `POST` | `/api/tasks/{id}/milestones` | по правам ролей |
| `PUT` | `/api/tasks/{id}/read` | по правам ролей |
| `DELETE` | `/api/tasks/{id}/relations` | по правам ролей |
| `PUT` | `/api/tasks/{id}/relations` | по правам ролей |
| `POST` | `/api/tasks/{id}/restore` | по правам ролей |
| `PUT` | `/api/tasks/{id}/subscription` | по правам ролей |
| `DELETE` | `/api/tasks/{id}/watchers` | по правам ролей |
| `PUT` | `/api/tasks/{id}/watchers` | по правам ролей |
| `GET` | `/api/workspaces/{id}/board-categories` | по правам ролей |
| `POST` | `/api/workspaces/{id}/board-categories` | по правам ролей |
| `GET` | `/api/workspaces/{id}/boards` | по правам ролей |
| `POST` | `/api/workspaces/{id}/boards` | по правам ролей |
| `PUT` | `/api/workspaces/{id}/boards/order` | по правам ролей |
| `GET` | `/api/workspaces/{id}/tasks/search` | по правам ролей |
<!-- /routes -->

### Формы досок

Подробно — [Формы досок](../bots/rest-forms).

<!-- routes:allow:forms -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/boards/{id}/forms` | по правам ролей |
| `POST` | `/api/boards/{id}/forms` | по правам ролей |
| `DELETE` | `/api/boards/{id}/forms/{fid}` | по правам ролей |
| `PUT` | `/api/boards/{id}/forms/{fid}` | по правам ролей |
| `POST` | `/api/boards/{id}/forms/preview` | по правам ролей |
| `GET` | `/api/forms/{code}` | по правам ролей |
| `POST` | `/api/forms/{code}/submissions` | по правам ролей |
<!-- /routes -->

### Календарь

Подробно — [Календарь](../bots/rest-calendar).

<!-- routes:allow:calendar -->
| Метод | Путь | Что делает |
|---|---|---|
| `DELETE` | `/api/events/{id}` | журналируется как действие бота |
| `GET` | `/api/events/{id}` | по правам ролей |
| `PATCH` | `/api/events/{id}` | журналируется как действие бота |
| `GET` | `/api/workspaces/{id}/events` | по правам ролей |
| `POST` | `/api/workspaces/{id}/events` | журналируется как действие бота |
| `GET` | `/api/workspaces/{id}/freebusy` | по правам ролей |
| `POST` | `/api/workspaces/{id}/freebusy/suggest` | по правам ролей |
<!-- /routes -->

### Личные сообщения

Подробно — [Личные сообщения](../bots/rest-dm).

<!-- routes:allow:dm -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/dms` | по правам ролей |
| `POST` | `/api/dms` | по правам ролей |
| `POST` | `/api/dms/{id}/files` | по правам ролей |
| `GET` | `/api/dms/candidates` | по правам ролей |
<!-- /routes -->

### Файлы

Подробно — [Файлы](../bots/rest-files).

<!-- routes:allow:files -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/files/{id}` | по правам ролей |
| `GET` | `/api/files/{id}/thumbnail` | по правам ролей |
| `POST` | `/api/workspaces/{id}/files` | по правам ролей |
<!-- /routes -->

### Стикеры

Подробно — [Стикеры](../bots/rest-stickers).

<!-- routes:allow:stickers -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/me/sticker-packs` | по правам ролей |
| `DELETE` | `/api/me/sticker-packs/{id}` | по правам ролей |
| `PUT` | `/api/me/sticker-packs/{id}` | по правам ролей |
| `PUT` | `/api/me/sticker-packs/order` | по правам ролей |
| `DELETE` | `/api/sticker-packs/{id}` | по правам ролей |
| `GET` | `/api/sticker-packs/{id}` | по правам ролей |
| `PATCH` | `/api/sticker-packs/{id}` | по правам ролей |
| `POST` | `/api/sticker-packs/{id}/stickers` | по правам ролей |
| `PUT` | `/api/sticker-packs/{id}/stickers/{sid}` | по правам ролей |
| `DELETE` | `/api/stickers/{id}` | по правам ролей |
| `PATCH` | `/api/stickers/{id}` | по правам ролей |
| `GET` | `/api/workspaces/{id}/sticker-packs` | по правам ролей |
| `POST` | `/api/workspaces/{id}/sticker-packs` | по правам ролей |
<!-- /routes -->

### Поиск

Подробно — [Поиск](../bots/rest-search).

<!-- routes:allow:search -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/me/mentions` | по правам ролей |
| `GET` | `/api/search` | по правам ролей |
| `GET` | `/api/workspaces/{id}/messages/search` | по правам ролей |
<!-- /routes -->

### Профиль бота

Подробно — [Профиль бота](../bots/rest-profile).

<!-- routes:allow:profile -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/bots/me` | по правам ролей |
| `PATCH` | `/api/bots/me` | по правам ролей |
| `PUT` | `/api/bots/me/commands` | по правам ролей |
| `DELETE` | `/api/bots/me/webhook` | по правам ролей |
| `GET` | `/api/bots/me/webhook` | по правам ролей |
| `PUT` | `/api/bots/me/webhook` | по правам ролей |
| `GET` | `/api/me` | по правам ролей |
| `PATCH` | `/api/me` | по правам ролей |
| `POST` | `/api/me/avatar` | по правам ролей |
| `GET` | `/api/rooms/{id}/bot-commands` | по правам ролей |
<!-- /routes -->


## Публичные маршруты

Доступны без токена. Бот может их вызывать, но анонимно — его права там не действуют.

<!-- routes:public -->
| Метод | Путь | Что делает |
|---|---|---|
| `ANY` | `/api/` | без авторизации |
| `POST` | `/api/auth/login` | без авторизации |
| `POST` | `/api/auth/logout` | без авторизации |
| `POST` | `/api/auth/password/forgot` | без авторизации |
| `POST` | `/api/auth/password/reset` | без авторизации |
| `POST` | `/api/auth/refresh` | без авторизации |
| `POST` | `/api/auth/register` | без авторизации |
| `GET` | `/api/billing/public/offers` | без авторизации |
| `GET` | `/api/billing/return` | без авторизации |
| `POST` | `/api/billing/stripe/webhook` | без авторизации |
| `POST` | `/api/billing/tochka/webhook` | без авторизации |
| `POST` | `/api/billing/tochkapay/webhook` | без авторизации |
| `GET` | `/api/event-rsvp` | без авторизации |
| `POST` | `/api/event-rsvp` | без авторизации |
| `POST` | `/api/git/boards/{id}/{provider}` | без авторизации |
| `GET` | `/api/invites/{code}` | без авторизации |
| `GET` | `/api/public/disk/{code}` | без авторизации |
| `GET` | `/api/public/disk/{code}/content` | без авторизации |
| `GET` | `/api/public/disk/{code}/thumbnail` | без авторизации |
| `GET` | `/api/public/forms/{code}` | без авторизации |
| `POST` | `/api/public/forms/{code}/submissions` | без авторизации |
| `GET` | `/api/room-invites/{code}` | без авторизации |
| `POST` | `/api/room-invites/{code}/join` | без авторизации |
| `POST` | `/api/rtc/webhook` | без авторизации |
| `GET` | `/api/stickers/builtin/{name}` | без авторизации |
| `GET` | `/api/version` | без авторизации |
| `GET` | `/gateway` | без авторизации |
| `GET` | `/healthz` | без авторизации |
| `GET` | `/metrics` | без авторизации |
| `GET` | `/readyz` | без авторизации |
<!-- /routes -->


## Закрыто для ботов

Отвечают боту `403 FORBIDDEN` с `reason: "BOT_NOT_ALLOWED"`. Почему так — см. [Токен и права](../bots/auth#что-закрыто-для-ботов-всегда).

<!-- routes:deny -->
| Метод | Путь | Область |
|---|---|---|
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
| `GET` | `/api/me/push-capabilities` | Push |
| `POST` | `/api/me/push-devices` | Push |
| `DELETE` | `/api/me/push-devices/{id}` | Push |
| `POST` | `/api/me/push-resolve` | Push |
| `POST` | `/api/auth/verify` | Аккаунт |
| `POST` | `/api/auth/verify/send` | Аккаунт |
| `PATCH` | `/api/dms/{id}/state` | Аккаунт |
| `GET` | `/api/me/blocked-bots` | Аккаунт |
| `DELETE` | `/api/me/blocked-bots/{id}` | Аккаунт |
| `POST` | `/api/me/blocked-bots/{id}` | Аккаунт |
| `PATCH` | `/api/me/email` | Аккаунт |
| `PATCH` | `/api/me/password` | Аккаунт |
| `GET` | `/api/me/sessions` | Аккаунт |
| `DELETE` | `/api/me/sessions/{id}` | Аккаунт |
| `PATCH` | `/api/me/status` | Аккаунт |
| `GET` | `/api/usernames/{name}/available` | Аккаунт |
| `DELETE` | `/api/users/{id}/note` | Аккаунт |
| `GET` | `/api/users/{id}/note` | Аккаунт |
| `PUT` | `/api/users/{id}/note` | Аккаунт |
| `DELETE` | `/api/workspace-apps/{appId}` | Веб-приложения и фоны |
| `PATCH` | `/api/workspace-apps/{appId}` | Веб-приложения и фоны |
| `PUT` | `/api/workspace-apps/{appId}/position` | Веб-приложения и фоны |
| `GET` | `/api/workspaces/{id}/apps` | Веб-приложения и фоны |
| `POST` | `/api/workspaces/{id}/apps` | Веб-приложения и фоны |
| `GET` | `/api/workspaces/{id}/backgrounds` | Веб-приложения и фоны |
| `POST` | `/api/workspaces/{id}/backgrounds` | Веб-приложения и фоны |
| `DELETE` | `/api/workspaces/{id}/backgrounds/{bgId}` | Веб-приложения и фоны |
| `PATCH` | `/api/workspaces/{id}/backgrounds/{bgId}` | Веб-приложения и фоны |
| `DELETE` | `/api/disk/items/{id}` | Диск |
| `GET` | `/api/disk/items/{id}` | Диск |
| `PATCH` | `/api/disk/items/{id}` | Диск |
| `GET` | `/api/disk/items/{id}/activity` | Диск |
| `DELETE` | `/api/disk/items/{id}/link` | Диск |
| `POST` | `/api/disk/items/{id}/link` | Диск |
| `GET` | `/api/disk/items/{id}/path` | Диск |
| `GET` | `/api/disk/items/{id}/permissions` | Диск |
| `PUT` | `/api/disk/items/{id}/permissions` | Диск |
| `POST` | `/api/disk/items/{id}/restore` | Диск |
| `POST` | `/api/disk/items/{id}/trash` | Диск |
| `GET` | `/api/workspaces/{id}/disk/activity` | Диск |
| `POST` | `/api/workspaces/{id}/disk/folders` | Диск |
| `GET` | `/api/workspaces/{id}/disk/items` | Диск |
| `GET` | `/api/workspaces/{id}/disk/settings` | Диск |
| `PUT` | `/api/workspaces/{id}/disk/settings` | Диск |
| `POST` | `/api/workspaces/{id}/disk/trash/empty` | Диск |
| `POST` | `/api/workspaces/{id}/disk/upload` | Диск |
| `GET` | `/api/workspaces/{id}/disk/usage` | Диск |
| `DELETE` | `/api/boards/{id}/git` | Доски и задачи |
| `GET` | `/api/boards/{id}/git` | Доски и задачи |
| `PUT` | `/api/boards/{id}/git` | Доски и задачи |
| `PUT` | `/api/boards/{id}/permissions` | Доски и задачи |
| `POST` | `/api/boards/{id}/rules` | Доски и задачи |
| `DELETE` | `/api/boards/{id}/webhook` | Доски и задачи |
| `GET` | `/api/boards/{id}/webhook` | Доски и задачи |
| `PUT` | `/api/boards/{id}/webhook` | Доски и задачи |
| `POST` | `/api/boards/{id}/webhook/ping` | Доски и задачи |
| `DELETE` | `/api/rules/{id}` | Доски и задачи |
| `PATCH` | `/api/rules/{id}` | Доски и задачи |
| `POST` | `/api/rules/{id}/test` | Доски и задачи |
| `POST` | `/api/tasks/{id}/approval` | Доски и задачи |
| `GET` | `/api/notes` | Заметки |
| `POST` | `/api/notes` | Заметки |
| `DELETE` | `/api/notes/{id}` | Заметки |
| `PATCH` | `/api/notes/{id}` | Заметки |
| `POST` | `/api/calls/{id}/accept` | Звонки один на один |
| `POST` | `/api/calls/{id}/cancel` | Звонки один на один |
| `POST` | `/api/calls/{id}/decline` | Звонки один на один |
| `POST` | `/api/calls/{id}/hangup` | Звонки один на один |
| `POST` | `/api/dms/{id}/call` | Звонки один на один |
| `PUT` | `/api/events/{id}/rsvp` | Календарь |
| `DELETE` | `/api/me/caldav` | Календарь |
| `GET` | `/api/me/caldav` | Календарь |
| `PATCH` | `/api/me/caldav` | Календарь |
| `POST` | `/api/me/caldav` | Календарь |
| `PUT` | `/api/me/caldav` | Календарь |
| `POST` | `/api/me/caldav/sync` | Календарь |
| `GET` | `/api/me/events/today` | Календарь |
| `DELETE` | `/api/me/external-events` | Календарь |
| `GET` | `/api/me/external-events` | Календарь |
| `POST` | `/api/me/external-events/rsvp` | Календарь |
| `DELETE` | `/api/rooms/{id}/admissions/me` | Комнаты |
| `GET` | `/api/rooms/{id}/invites` | Комнаты |
| `POST` | `/api/rooms/{id}/invites` | Комнаты |
| `DELETE` | `/api/rooms/{id}/invites/{inviteId}` | Комнаты |
| `PATCH` | `/api/rooms/{id}/invites/{inviteId}` | Комнаты |
| `PUT` | `/api/rooms/{id}/notifications` | Комнаты |
| `GET` | `/api/admin/billing/accounts` | Оплата |
| `GET` | `/api/admin/billing/accounts/{id}` | Оплата |
| `POST` | `/api/admin/billing/accounts/{id}/admin-debit` | Оплата |
| `POST` | `/api/admin/billing/accounts/{id}/charges/{attemptId}/check` | Оплата |
| `PUT` | `/api/admin/billing/accounts/{id}/custom-plan` | Оплата |
| `PUT` | `/api/admin/billing/accounts/{id}/discount` | Оплата |
| `POST` | `/api/admin/billing/accounts/{id}/hold` | Оплата |
| `GET` | `/api/admin/billing/accounts/{id}/ledger` | Оплата |
| `POST` | `/api/admin/billing/accounts/{id}/manual-credits` | Оплата |
| `POST` | `/api/admin/billing/accounts/{id}/manual-credits/{creditId}/reverse` | Оплата |
| `POST` | `/api/admin/billing/accounts/{id}/market` | Оплата |
| `POST` | `/api/admin/billing/accounts/{id}/plan` | Оплата |
| `POST` | `/api/admin/billing/accounts/{id}/reconcile` | Оплата |
| `POST` | `/api/admin/billing/auto-topup/reconcile` | Оплата |
| `GET` | `/api/admin/billing/disputes` | Оплата |
| `POST` | `/api/admin/billing/disputes/{id}/close` | Оплата |
| `GET` | `/api/admin/billing/events` | Оплата |
| `GET` | `/api/admin/billing/issues` | Оплата |
| `POST` | `/api/admin/billing/issues/{id}/dismiss` | Оплата |
| `POST` | `/api/admin/billing/issues/{id}/import` | Оплата |
| `GET` | `/api/admin/billing/payments` | Оплата |
| `POST` | `/api/admin/billing/payments/{id}/chargebacks` | Оплата |
| `POST` | `/api/admin/billing/payments/{id}/refunds` | Оплата |
| `GET` | `/api/admin/billing/prices` | Оплата |
| `POST` | `/api/admin/billing/prices` | Оплата |
| `GET` | `/api/admin/billing/providers` | Оплата |
| `PUT` | `/api/admin/billing/providers/{provider}` | Оплата |
| `GET` | `/api/admin/billing/refunds` | Оплата |
| `POST` | `/api/admin/billing/test-clock` | Оплата |
| `POST` | `/api/admin/billing/workspaces/{id}/enable` | Оплата |
| `GET` | `/api/workspaces/{id}/billing` | Оплата |
| `POST` | `/api/workspaces/{id}/billing/activate` | Оплата |
| `DELETE` | `/api/workspaces/{id}/billing/auto-topup` | Оплата |
| `GET` | `/api/workspaces/{id}/billing/auto-topup` | Оплата |
| `PUT` | `/api/workspaces/{id}/billing/auto-topup` | Оплата |
| `POST` | `/api/workspaces/{id}/billing/change-plan` | Оплата |
| `GET` | `/api/workspaces/{id}/billing/checkouts/{cid}` | Оплата |
| `GET` | `/api/workspaces/{id}/billing/ledger` | Оплата |
| `GET` | `/api/workspaces/{id}/billing/payer` | Оплата |
| `PUT` | `/api/workspaces/{id}/billing/payer` | Оплата |
| `GET` | `/api/workspaces/{id}/billing/payer-schema` | Оплата |
| `GET` | `/api/workspaces/{id}/billing/payment-methods` | Оплата |
| `DELETE` | `/api/workspaces/{id}/billing/payment-methods/{pmId}` | Оплата |
| `GET` | `/api/workspaces/{id}/billing/payments` | Оплата |
| `POST` | `/api/workspaces/{id}/billing/quote` | Оплата |
| `POST` | `/api/workspaces/{id}/billing/resume` | Оплата |
| `POST` | `/api/workspaces/{id}/billing/saved-method-topups` | Оплата |
| `GET` | `/api/workspaces/{id}/billing/saved-method-topups/{tid}` | Оплата |
| `POST` | `/api/workspaces/{id}/billing/stop` | Оплата |
| `POST` | `/api/workspaces/{id}/billing/topups` | Оплата |
| `POST` | `/api/invites/{code}/join` | Пространства и приглашения |
| `POST` | `/api/workspaces` | Пространства и приглашения |
| `DELETE` | `/api/workspaces/{id}` | Пространства и приглашения |
| `POST` | `/api/workspaces/{id}/invites/lookup` | Пространства и приглашения |
| `POST` | `/api/workspaces/{id}/join` | Пространства и приглашения |
| `POST` | `/api/workspaces/{id}/members` | Пространства и приглашения |
| `PUT` | `/api/workspaces/{id}/notifications` | Пространства и приглашения |
| `GET` | `/api/workspaces/discover` | Пространства и приглашения |
| `POST` | `/api/files/convert` | Сообщения и файлы |
| `POST` | `/api/messages/{id}/interactions` | Сообщения и файлы |
| `GET` | `/api/unfurl` | Сообщения и файлы |
| `GET` | `/api/unfurl/image` | Сообщения и файлы |
| `GET` | `/api/admin/users/{id}/storage-quota` | Суперадминка |
| `PUT` | `/api/admin/users/{id}/storage-quota` | Суперадминка |
| `GET` | `/api/admin/workspaces` | Суперадминка |
| `GET` | `/api/admin/workspaces/{id}` | Суперадминка |
| `PUT` | `/api/admin/workspaces/{id}/plan` | Суперадминка |
| `GET` | `/api/admin/workspaces/{id}/plan/log` | Суперадминка |
| `PUT` | `/api/admin/workspaces/{id}/suspension` | Суперадминка |
| `DELETE` | `/api/rooms/{id}/recordings/{rid}` | Телефония и записи |
| `POST` | `/api/rooms/{id}/recordings/{rid}/recheck` | Телефония и записи |
| `POST` | `/api/rooms/{id}/recordings/{rid}/reupload` | Телефония и записи |
| `GET` | `/api/workspaces/{id}/calls` | Телефония и записи |
| `DELETE` | `/api/workspaces/{id}/integrations/gptunnel` | Телефония и записи |
| `GET` | `/api/workspaces/{id}/integrations/gptunnel` | Телефония и записи |
| `POST` | `/api/workspaces/{id}/integrations/gptunnel` | Телефония и записи |
| `GET` | `/api/workspaces/{id}/sip` | Телефония и записи |
| `PUT` | `/api/workspaces/{id}/sip` | Телефония и записи |
| `POST` | `/api/workspaces/{id}/sip/test` | Телефония и записи |
| `GET` | `/api/bots/{ref}` | Управление ботами |
| `GET` | `/api/workspaces/{id}/bots` | Управление ботами |
| `POST` | `/api/workspaces/{id}/bots` | Управление ботами |
| `DELETE` | `/api/workspaces/{id}/bots/{botId}` | Управление ботами |
| `DELETE` | `/api/workspaces/{id}/bots/{botId}/avatar` | Управление ботами |
| `POST` | `/api/workspaces/{id}/bots/{botId}/avatar` | Управление ботами |
| `DELETE` | `/api/workspaces/{id}/bots/{botId}/token` | Управление ботами |
| `POST` | `/api/workspaces/{id}/bots/{botId}/token` | Управление ботами |
| `POST` | `/api/workspaces/{id}/bots/add` | Управление ботами |
| `DELETE` | `/api/achievements/{id}` | Участники |
| `PATCH` | `/api/achievements/{id}` | Участники |
| `POST` | `/api/workspaces/{id}/achievements` | Участники |
| `POST` | `/api/workspaces/{id}/members/{userId}/achievements` | Участники |
| `DELETE` | `/api/workspaces/{id}/members/{userId}/achievements/{grantId}` | Участники |
| `PATCH` | `/api/workspaces/{id}/members/{userId}/birthday` | Участники |
| `GET` | `/api/workspaces/{id}/members/birthdays` | Участники |
<!-- /routes -->

