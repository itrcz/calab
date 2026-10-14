---
title: Быстрый старт
description: Создайте бота, получите токен, сделайте первый запрос и отправьте первое сообщение — за пять минут.
order: 2
---

За пять минут вы создадите бота, найдёте комнату и отправите в неё сообщение, а затем запустите бота, который отвечает на команды.

Понадобится: пространство Calab, где вы владелец или у вас есть право «Управлять ботами» (`MANAGE_BOTS`), и подтверждённая почта.

## 1. Создайте бота

1. Откройте «Настройки пространства → Боты».
2. Нажмите «Создать бота», задайте имя, `username` (3–32 символа: `a–z`, `0–9` и `_`; по нему к боту обращаются в `/команда@username`) и описание.
3. Скопируйте токен — **он показывается один раз**. Потеряли — «Перевыпустить токен».

Бот сразу становится участником пространства с ролью участника: читает и пишет в открытых комнатах, заходит в голос. Нужно больше или меньше — выдайте роль или переопределения в комнате, как человеку (см. [Токен и права](./auth)).

> [!WARNING]
> Токен — это пароль бота. Не коммитьте его в git, не пишите в логи и не передавайте в URL: только в заголовке `Authorization`.

## 2. Первый запрос

Сохраните адрес сервера и токен в переменные окружения и спросите сервер, кто вы:

```sh tab="curl"
export CALAB=https://app.example.com
export TOKEN=calab_bot_0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b_Xq3v9aT2LmN8pR4sW7yZ1bC5dF0gH6jK3nQ9uV2xE8w

curl -s $CALAB/api/bots/me -H "Authorization: Bearer $TOKEN"
```

```js tab="JavaScript"
const CALAB = process.env.CALAB; // https://app.example.com
const headers = { Authorization: `Bearer ${process.env.TOKEN}` };

const res = await fetch(`${CALAB}/api/bots/me`, { headers });
console.log(await res.json());
```

```python tab="Python"
import os, requests

CALAB = os.environ["CALAB"]  # https://app.example.com
H = {"Authorization": f"Bearer {os.environ['TOKEN']}"}

print(requests.get(f"{CALAB}/api/bots/me", headers=H).json())
```

Ответ — профиль бота:

```json
{
  "bot": {
    "user": { "id": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b", "displayName": "Echo", "isBot": true },
    "username": "echo",
    "ownerUserId": "0191f0c2-7a10-7d3e-9b11-5c2f8e4a6d01",
    "workspaceId": "0191f0c2-0000-7000-8000-00000000a001",
    "description": "",
    "commands": [],
    "tokenPrefix": "Xq3v9a",
    "createdAt": "2026-10-14T10:00:00Z",
    "webhook": { "url": "", "enabled": false, "lastError": "", "pending": 0 }
  }
}
```

`401 UNAUTHENTICATED` — токен неверный, отозван или перевыпущен.

## 3. Найдите комнату

```sh tab="curl"
curl -s $CALAB/api/workspaces -H "Authorization: Bearer $TOKEN"
# {"workspaces": [{"id": "0191f0c2-…", "name": "Acme", …}]}

export WS=0191f0c2-0000-7000-8000-00000000a001
curl -s $CALAB/api/workspaces/$WS/rooms -H "Authorization: Bearer $TOKEN"
# {"rooms": [{"id": "0191f0d4-…", "type": "ROOM_TYPE_TEXT", "name": "general", …}]}
```

```python tab="Python"
ws = requests.get(f"{CALAB}/api/workspaces", headers=H).json()["workspaces"][0]
rooms = requests.get(f"{CALAB}/api/workspaces/{ws['id']}/rooms", headers=H).json()["rooms"]
room = next(r for r in rooms if r["type"] == "ROOM_TYPE_TEXT")
```

В списке только комнаты, которые бот видит (`VIEW_ROOM`).

## 4. Отправьте сообщение

```sh tab="curl"
export ROOM=0191f0d4-0000-7000-8000-00000000b001
curl -s -X POST $CALAB/api/rooms/$ROOM/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content": "Привет! Я бот.", "nonce": "hello-1"}'
```

```js tab="JavaScript"
const res = await fetch(`${CALAB}/api/rooms/${roomId}/messages`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: 'Привет! Я бот.', nonce: 'hello-1' }),
});
const { message } = await res.json(); // 201
```

```python tab="Python"
r = requests.post(f"{CALAB}/api/rooms/{room['id']}/messages", headers=H,
                  json={"content": "Привет! Я бот.", "nonce": "hello-1"})
message = r.json()["message"]  # 201
```

```json
{
  "message": {
    "id": "0192a1c0-…",
    "roomId": "0191f0d4-0000-7000-8000-00000000b001",
    "authorId": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
    "content": "Привет! Я бот.",
    "nonce": "hello-1",
    "attachments": [],
    "reactions": [],
    "pinnedBy": "",
    "kind": "MESSAGE_KIND_UNSPECIFIED",
    "keyboardRevision": "0",
    "createdAt": "2026-10-14T10:01:02.345Z"
  }
}
```

> [!TIP]
> `nonce` — ключ идемпотентности (до 64 символов). Повтор запроса с тем же `nonce` вернёт то же сообщение с кодом `200`, а не создаст второе. Генерируйте его один раз на сообщение и переиспользуйте при повторах.

## 5. Бот, который отвечает

Чтобы реагировать на сообщения, бот слушает события — через [gateway](./gateway) (постоянное соединение) или [вебхук](./webhooks). Проще всего — с [SDK для Node.js](./sdk), он берёт на себя переподключение и разбор команд:

```js tab="JavaScript"
import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.TOKEN, { server: 'https://app.example.com' });

await bot.commands([{ name: 'echo', description: 'Повторить текст' }]);
bot.on('message', (m) => bot.reply(m, m.content));
bot.on('command', (c) => c.name === 'echo' && bot.reply(c, c.args || 'Напишите: /echo текст'));

await bot.start();
```

Готовый пример `examples/bots/echo` из [репозитория](https://github.com/itrcz/calab) (Node ≥ 20):

```sh
pnpm install && pnpm -F @calaba/bot-sdk build
cd examples/bots/echo && npm install
BOT_TOKEN=$TOKEN CALAB_SERVER=$CALAB npm start
```

Напишите что-нибудь в комнате или `/echo привет` — бот ответит.

## Дальше

- [Токен и права](./auth) — что бот может и как выдать ему права.
- [Сообщения](./rest-messages) — ответы, вложения, реакции, редактирование.
- [Команды и кнопки](./commands-buttons) — `/команды` и кнопки под сообщениями.
- [Ошибки и лимиты](./errors-limits) — что делать с `403`, `409` и `429`.
