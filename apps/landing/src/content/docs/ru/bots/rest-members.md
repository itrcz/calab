---
title: Пространство и участники
description: Пространства бота, участники и их профили, никнеймы, роли, баны, значки, достижения, дни рождения и приглашения.
order: 6
---

Бот — участник пространства с ролью участника; дополнительные права ему дают роли, как человеку. Через эти маршруты бот читает состав пространства и профили людей, а с правами администратора — переименовывает участников, назначает роли, выдаёт значки, банит и приглашает новых людей.

| Действие | Право |
|---|---|
| пространства, участники, профиль участника, роли, значки, достижения | участник пространства |
| изменить настройки пространства | `MANAGE_WORKSPACE` |
| никнейм участника, выдать / снять значок | `MANAGE_NICKNAMES` |
| удалить участника, бан, перевести гостя в участники, встроенная роль, библиотека значков | `MANAGE_MEMBERS` |
| назначить роли участнику | `MANAGE_MEMBERS` или `MANAGE_ROLES` (только роли ниже своей) |
| создать, изменить, удалить роли, порядок ролей | `MANAGE_ROLES` |
| приглашения по ссылке и по почте | `INVITE_MEMBERS` |

## Маршруты

<!-- routes:members -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/workspaces` | Пространства бота → `{workspaces}` |
| `GET` | `/api/workspaces/{id}` | Одно пространство → `{workspace}` |
| `PATCH` | `/api/workspaces/{id}` | Изменить название, адрес, настройки медиа (`MANAGE_WORKSPACE`) |
| `GET` | `/api/workspaces/{id}/members` | Участники → `{members}` |
| `GET` | `/api/workspaces/{id}/members/{userId}` | Профиль участника и его открытые задачи → `{member, openTasks}` (`@me` — сам бот) |
| `PATCH` | `/api/workspaces/{id}/members/{userId}` | Никнейм `{nickname}` (`MANAGE_NICKNAMES`) или встроенная роль `{role}` (`MANAGE_MEMBERS`) |
| `DELETE` | `/api/workspaces/{id}/members/{userId}` | Удалить участника из пространства (`MANAGE_MEMBERS`) |
| `POST` | `/api/workspaces/{id}/members/{userId}/promote` | Перевести гостя в участники (`MANAGE_MEMBERS`) |
| `PUT` | `/api/workspaces/{id}/members/{userId}/roles` | Роли участника `{roleIds}` |
| `GET` | `/api/workspaces/{id}/roles` | Роли пространства → `{roles}` |
| `POST` | `/api/workspaces/{id}/roles` | Создать роль `{name, color, permissions, mentionable}` (`MANAGE_ROLES`) |
| `PATCH` | `/api/workspaces/{id}/roles/{roleId}` | Изменить роль (`MANAGE_ROLES`) |
| `DELETE` | `/api/workspaces/{id}/roles/{roleId}` | Удалить роль (`MANAGE_ROLES`) |
| `PUT` | `/api/workspaces/{id}/roles/order` | Порядок ролей (`MANAGE_ROLES`) |
| `GET` | `/api/workspaces/{id}/bans` | Список банов → `{bans}` (`MANAGE_MEMBERS`) |
| `POST` | `/api/workspaces/{id}/bans` | Забанить `{userId, reason}` (`MANAGE_MEMBERS`) |
| `DELETE` | `/api/workspaces/{id}/bans/{userId}` | Снять бан (`MANAGE_MEMBERS`) |
| `GET` | `/api/workspaces/{id}/badges` | Библиотека значков → `{badges}` |
| `POST` | `/api/workspaces/{id}/badges` | Создать значок `{name, fileId}` (`MANAGE_MEMBERS`) |
| `PATCH` | `/api/workspaces/{id}/badges/{badgeId}` | Изменить значок (`MANAGE_MEMBERS`) |
| `DELETE` | `/api/workspaces/{id}/badges/{badgeId}` | Удалить значок (`MANAGE_MEMBERS`) |
| `PUT` | `/api/workspaces/{id}/members/{userId}/badge` | Выдать значок `{badgeId}`, `""` — снять (`MANAGE_NICKNAMES`) |
| `GET` | `/api/workspaces/{id}/achievements` | Каталог достижений пространства → `{achievements}` |
| `GET` | `/api/workspaces/{id}/members/{userId}/achievements` | Достижения участника → `{items}` |
| `GET` | `/api/workspaces/{id}/birthdays` | Ближайшие дни рождения `?days=` (1..31, по умолчанию 7) → `{birthdays}` |
| `GET` | `/api/workspaces/{id}/invites` | Ссылки-приглашения → `{invites}` (`INVITE_MEMBERS`) |
| `POST` | `/api/workspaces/{id}/invites` | Создать ссылку `{maxUses, expiresInSeconds}` (`INVITE_MEMBERS`) |
| `DELETE` | `/api/workspaces/{id}/invites/{inviteId}` | Удалить ссылку (`INVITE_MEMBERS`) |
| `GET` | `/api/workspaces/{id}/invites/email` | Приглашения по почте → `{invites}` (`INVITE_MEMBERS`) |
| `POST` | `/api/workspaces/{id}/invites/email` | Пригласить по адресу `{email, role?}` (`INVITE_MEMBERS`) |
| `DELETE` | `/api/workspaces/{id}/invites/email/{inviteId}` | Отозвать приглашение по почте (`INVITE_MEMBERS`) |
<!-- /routes -->

### Недоступно ботам

- Создание, удаление пространства, поиск открытых пространств и вход в них: `POST /api/workspaces`, `DELETE /api/workspaces/{id}`, `GET /api/workspaces/discover`, `POST /api/workspaces/{id}/join`, `POST /api/invites/{code}/join`.
- Поиск аккаунта по адресу и добавление аккаунта без его согласия: `POST /api/workspaces/{id}/invites/lookup`, `POST /api/workspaces/{id}/members`.
- Таблица дней рождения всех участников и установка дня рождения: `GET /api/workspaces/{id}/members/birthdays`, `PATCH /api/workspaces/{id}/members/{userId}/birthday`.
- Каталог достижений и их выдача — дело людей: `POST /api/workspaces/{id}/achievements`, `PATCH · DELETE /api/achievements/{id}`, `POST /api/workspaces/{id}/members/{userId}/achievements`, `DELETE …/achievements/{grantId}`.
- Уведомления пространства (`PUT /api/workspaces/{id}/notifications`), веб-приложения пространства (`/api/workspaces/{id}/apps`, `/api/workspace-apps/…`), личные заметки о пользователях (`/api/users/{id}/note`).
- Оплата, управление ботами, настройки входа (SSO, каталог, OAuth-клиенты) — см. [Ошибки и лимиты](./errors-limits).

## Участники

`GET /api/workspaces/{id}/members` возвращает `WorkspaceMember`: `user`, `role` (встроенная роль, например `WORKSPACE_ROLE_MEMBER`), `nickname`, `joinedAt`, `roleIds`, `badgeId`, `achievementCount`. У ботов `user.isBot = true`; `user.username` — глобальный никнейм (у бота — его `username`).

> [!NOTE]
> Боты никогда не получают адрес почты и телефон людей — ни через REST, ни через gateway, ни через вебхуки.

```sh tab="curl"
curl -s $CALAB/api/workspaces -H "Authorization: Bearer $TOKEN"
curl -s $CALAB/api/workspaces/$WS/members -H "Authorization: Bearer $TOKEN"
```

```js tab="JavaScript"
const workspaces = await bot.workspaces();
const members = await bot.members(roomId);   // участники пространства этой комнаты
```

```json
{
  "members": [
    {
      "workspaceId": "0191f0aa-0000-7000-8000-000000000001",
      "user": {"id": "0191c2d3-0000-7000-8000-000000000042", "displayName": "Анна", "isBot": false, "username": "anna", "timezone": "Europe/Moscow"},
      "role": "WORKSPACE_ROLE_MEMBER",
      "nickname": "Анна (продажи)",
      "joinedAt": "2026-06-01T09:00:00Z",
      "roleIds": ["0191f0aa-0000-7000-8000-0000000000e1"],
      "badgeId": "",
      "achievementCount": 2
    }
  ]
}
```

### Профиль участника

`GET /api/workspaces/{id}/members/{userId}` (`@me` — сам бот) → `{member, openTasks}`: имя, никнейм, роли, значок, статус, часовой пояс, день рождения (скрытый не передаётся) и открытые задачи, где человек исполнитель, — только с досок, которые видит бот (≤ 50).

```js tab="JavaScript"
const { member, openTasks } = await bot.members.get(wsId, userId);
await bot.members.setNickname(wsId, userId, 'Боб (продажи)');   // '' — сбросить
```

```sh tab="curl"
curl -s $CALAB/api/workspaces/$WS/members/$USER -H "Authorization: Bearer $TOKEN"
# {"member": {…}, "openTasks": [{"key": "FNG-12", "title": "Отчёт", …}]}
curl -s -X PATCH $CALAB/api/workspaces/$WS/members/$USER -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"nickname": "Боб (продажи)"}'      # → {"member": {…}}
```

## Значки

Значок — картинка у имени участника (`WorkspaceMember.badgeId` ссылается на библиотеку). Картинка — собственная загрузка бота в это пространство: PNG, WebP или JPEG до 128 КБ. Выдать значок можно только человеку (не боту), чья высшая роль ниже высшей роли бота.

```js tab="JavaScript"
import { readFile } from 'node:fs/promises';

const badge = await bot.badges.create(wsId, 'Наставник', { name: 'mentor.webp', data: await readFile('mentor.webp') });
await bot.badges.set(wsId, userId, badge.id);   // '' — снять
```

```sh tab="curl"
curl -s -X PUT $CALAB/api/workspaces/$WS/members/$USER/badge -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"badgeId\": \"$BADGE\"}"
```

Также есть `bot.badges.list`, `bot.badges.update`, `bot.badges.delete`.

## Достижения

Бот читает каталог (`GET …/achievements`: у архивных — `archivedAt`; ответ с `ETag`; картинка 512×512 WebP — `GET /api/files/{fileId}`) и выданные участнику достижения: `{items: [{id, achievementId, note, grantedBy, grantedAt, messageId, roomId}]}`, новые сверху. Выдают и отзывают достижения только люди.

## Дни рождения

`GET /api/workspaces/{id}/birthdays?days=7` — участники, у кого день рождения в ближайшие `days` дней (1..31, по умолчанию 7), ближайшие первыми: `{birthdays: [{userId, birthday: {day, month, year?}, inDays}]}` (`inDays: 0` — сегодня). Скрытые дни рождения и боты не попадают в список. Удобно для бота-поздравлялки.

## Приглашения

Ссылка-приглашение: `{maxUses, expiresInSeconds}` (0 — без ограничений) → `201 {invite: {code, …}}`; ссылка для людей — `https://app.example.com/join/<code>`. Приглашение по почте `{email}`: письмо приходит от имени пространства с пометкой «от имени бота X»; на один адрес — не чаще раза в сутки; пригласить администратора (`role: "WORKSPACE_ROLE_ADMIN"`) может только владелец.

```js tab="JavaScript"
const invite = await bot.invites.create(wsId, { maxUses: 1, expiresInSeconds: 86400 });
await bot.invites.email(wsId, 'new.colleague@example.com');
```

```sh tab="curl"
curl -s -X POST $CALAB/api/workspaces/$WS/invites -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"maxUses": 1, "expiresInSeconds": 86400}'
# → 201 {"invite": {"id": "…", "code": "k3Zq…", "maxUses": 1, "uses": 0, "expiresAt": "…"}}
```

```python tab="Python"
r = requests.post(f"{CALAB}/api/workspaces/{ws_id}/invites/email", headers=H,
                  json={"email": "new.colleague@example.com"})
r.raise_for_status()
```

Также есть `bot.invites.list`, `bot.invites.delete`, `bot.invites.listEmail`, `bot.invites.deleteEmail`.

## Подводные камни

> [!DANGER]
> **Бот с правами администратора — администратор.** Токен, чьи роли дают `MANAGE_*`, `INVITE_*` или `VIEW_JOURNALS`, действует как администратор с этими правами: храните его как пароль администратора и перевыпускайте при сомнениях. Редактор ролей предупреждает, когда такие права получает роль, которая есть у ботов. Каждое административное действие бота пишется в журнал сервера с указанием владельца бота.

> [!NOTE]
> Права бота на изменение участников подчиняются той же иерархии, что и у людей: бот не может удалить, забанить или переименовать того, чья высшая роль не ниже его собственной.
