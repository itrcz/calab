---
title: Профиль бота
description: Аккаунт и профиль бота — имя, аватар, описание, список команд, вебхук и подсказки команд в комнате.
order: 16
---

Бот — пользователь с флагом `isBot`. Из настроек аккаунта ему доступны только имя, аватар и описание («о боте»); всё остальное — пароль, почта, статус, часовой пояс, уведомления — бывает только у людей. Маршруты `/api/bots/me…` предназначены только для ботов: на них работает лишь токен бота.

## Маршруты

<!-- routes:profile -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/me` | Аккаунт бота: `{me: {user: {…, isBot: true}, …}}` |
| `PATCH` | `/api/me` | Только `displayName` и `avatarFileId` (`""` — убрать аватар) |
| `POST` | `/api/me/avatar` | Загрузить аватар (multipart `file`) |
| `GET` | `/api/bots/me` | Профиль бота: `username`, описание, команды, состояние вебхука → `{bot}` |
| `PATCH` | `/api/bots/me` | Изменить `{displayName?, description?}` → `{bot}` |
| `PUT` | `/api/bots/me/commands` | Заменить список команд, см. [Команды и кнопки](./commands-buttons) |
| `GET` | `/api/bots/me/webhook` | Состояние вебхука бота, см. [Вебхуки](./webhooks) |
| `PUT` | `/api/bots/me/webhook` | Включить вебхук `{url, secret}` |
| `DELETE` | `/api/bots/me/webhook` | Выключить вебхук → `204` |
| `GET` | `/api/rooms/{id}/bot-commands` | Команды ботов комнаты (подсказки на `/`) → `{bots}` (`VIEW_ROOM`) |
<!-- /routes -->

### Недоступно ботам

- Пароль, почта, подтверждение почты, сеансы, статус, никнейм-логин: `PATCH /api/me/password`, `PATCH /api/me/email`, `POST /api/auth/verify…`, `/api/me/sessions…`, `PATCH /api/me/status`, `GET /api/usernames/{name}/available`.
- Поля `PATCH /api/me`, кроме имени и аватара (`statusText`, `settings`, `timezone`, `locale`, `birthday`, `phone`, `username`, настройки уведомлений) — `403 BOT_NOT_ALLOWED`.
- Push-уведомления: `/api/me/push-capabilities`, `/api/me/push-devices…`, `/api/me/push-resolve`.
- Управление ботами — создание, токены, удаление, аватар из настроек «Боты», карточка `GET /api/bots/{ref}`: `/api/workspaces/{id}/bots…`. Этим занимаются люди — владелец бота или роль с `MANAGE_BOTS`; право `MANAGE_BOTS` у роли самого бота ничего не меняет.

## Профиль

`Bot`:

| Поле | Описание |
|---|---|
| `user` | Аккаунт бота (`isBot: true`); `user.username` — `username` бота |
| `username` | Уникальный `[a-z0-9_]{3,32}`: адресация команд `/cmd@username`, ссылка `/bots/<username>` |
| `ownerUserId` | Владелец бота |
| `workspaceId` | Домашнее пространство: здесь бот создан и управляется |
| `description` | «О боте», ≤ 512 символов |
| `commands` | Зарегистрированные команды |
| `tokenPrefix` | Первые символы секрета текущего токена — чтобы отличать токены; сам токен больше не показывается. Пусто — токен отозван |
| `createdAt`, `revokedAt` | Создание; отзыв |
| `webhook` | Состояние вебхука |

```sh tab="curl"
curl -s $CALAB/api/bots/me -H "Authorization: Bearer $TOKEN"
```

```js tab="JavaScript"
const profile = await bot.fetchMe();
await bot.updateProfile({ displayName: 'Дежурный', description: 'Напоминает о дежурствах и сроках задач' });
```

```python tab="Python"
r = requests.patch(f"{CALAB}/api/bots/me", headers=H,
                   json={"displayName": "Дежурный", "description": "Напоминает о дежурствах и сроках задач"})
```

```json
{
  "bot": {
    "user": {"id": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b", "displayName": "Дежурный", "isBot": true, "username": "duty"},
    "username": "duty",
    "ownerUserId": "0191c2d3-0000-7000-8000-000000000042",
    "workspaceId": "0191f0aa-0000-7000-8000-000000000001",
    "description": "Напоминает о дежурствах и сроках задач",
    "commands": [{"name": "duty", "description": "Кто дежурит сегодня"}],
    "tokenPrefix": "Xq3v9a",
    "createdAt": "2026-09-27T10:00:00Z",
    "webhook": {"url": "", "enabled": false}
  }
}
```

`displayName` — 1..64 символа.

## Аватар

```sh tab="curl"
curl -s -X POST $CALAB/api/me/avatar -H "Authorization: Bearer $TOKEN" -F file=@avatar.png
```

```python tab="Python"
with open("avatar.png", "rb") as f:
    requests.post(f"{CALAB}/api/me/avatar", headers=H, files={"file": ("avatar.png", f, "image/png")})
```

Аватар бота могут сменить и люди — владелец или роль с `MANAGE_BOTS` в домашнем пространстве бота, в настройках «Боты».

## Подсказки команд в комнате

`GET /api/rooms/{id}/bot-commands` → `{bots: [{botUserId, username, commands}]}` — команды всех ботов комнаты; так приложение подсказывает команды при вводе `/`. Боту этот маршрут полезен, чтобы не конфликтовать с командами соседей.

> [!NOTE]
> Бот может состоять в нескольких пространствах: администратор другого пространства добавляет его по ссылке `/bots/<username>`. Токеном, удалением и аватаром управляют только в домашнем пространстве.
