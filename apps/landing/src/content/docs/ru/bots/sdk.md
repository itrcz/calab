---
title: SDK для Node.js
description: '@calaba/bot-sdk — REST, gateway с типизированными событиями, команды, вебхуки и голос; установка из репозитория, API и примеры.'
order: 21
---

`@calaba/bot-sdk` — SDK для ботов на TypeScript/JavaScript: REST API, realtime-gateway с типизированными событиями, `/команды`, вебхуки и голос через LiveKit. ESM, Node.js ≥ 20, одна зависимость времени выполнения (`ws`). Типы контракта генерируются из тех же protobuf-схем, что и сервер, поэтому поля и перечисления совпадают с REST один в один.

## Установка

SDK живёт в открытом монорепозитории [github.com/itrcz/calab](https://github.com/itrcz/calab) и пока не опубликован в npm. Соберите его один раз из корня репозитория:

```sh
git clone https://github.com/itrcz/calab.git && cd calab
pnpm install
pnpm -F @calaba/bot-sdk build      # → packages/bot-sdk/dist/index.js (контракт встроен в сборку)
```

Проект вне монорепозитория подключает его по пути:

```json
{
  "dependencies": {
    "@calaba/bot-sdk": "file:../calab/packages/bot-sdk"
  }
}
```

## Быстрый старт

```js
import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, { server: 'https://app.example.com' });

await bot.commands([{ name: 'echo', description: 'Повторить текст' }]);

bot.on('message', (m) => bot.reply(m, `echo: ${m.content}`));
bot.on('command', (c) => {
  if (c.name === 'echo') return bot.reply(c, c.args || '(нечего повторять)');
});

const ready = await bot.start();
console.log(`${ready.me?.user?.displayName} в сети, пространств: ${ready.workspaces.length}`);
```

## Конструктор

`new Bot(token, options)`:

| Опция | Что делает |
|---|---|
| `server` | адрес приложения, `https://app.example.com`; gateway — `wss://<host>/gateway` |
| `webhookSecret` | секрет для `handleWebhook` |
| `receiveOwn` | `true` — получать и свои сообщения и реакции (по умолчанию пропускаются) |
| `maxRetries` | повторы при `429`, по умолчанию 3 |
| `log` | свой логгер |

## API

| Метод | Что делает |
|---|---|
| `start(): Promise<Ready>` · `stop()` | подключить gateway (`IDENTIFY` → `READY`) · отключить |
| `on(event, fn)` · `once` · `off` | типизированные события, см. ниже |
| `send(roomId, text \| { text?, stickerId?, files?, replyTo?, nonce?, inlineKeyboard? })` | сообщение; `files` — `{ name, data }` (загрузятся заранее) или id загруженных |
| `reply(message \| command, content)` | ответ в ту же комнату |
| `edit(id, text \| { text?, inlineKeyboard? })` · `deleteMessage(id)` | правка · удаление |
| `react(id, emoji)` · `unreact(id, emoji)` | реакции |
| `forward(roomId, messageId, toRoomId)` | переслать копию в другую комнату или DM → `Message` |
| `messages(roomId, { before?, after?, limit? })` · `message(roomId, messageId)` | история · одно сообщение |
| `transcript(roomId, recordingId)` | полный транскрипт записи → `{ recordingId, language, segments }` |
| `typing(roomId)` | «печатает» |
| `upload(roomId, file)` | загрузить файл в пространство комнаты (или DM) → `FileMeta` |
| `dm(userId)` | открыть или найти DM → `DmSummary` (писать в `dm.room.id`) |
| `commands([{ name, description }])` | заменить список команд |
| `workspaces()` · `rooms(workspaceId?)` · `room(id)` · `members(roomId)` | что бот видит |
| `isDm(roomId)` · `workspaceOf(roomId)` | из кеша gateway |
| `voice.join(roomId)` · `voice.leave(roomId)` · `voice.participants(roomId)` | голос: данные LiveKit, выход, участники |
| `webhook.get()` · `webhook.set(url, secret)` · `webhook.delete()` | вебхук бота |
| `handleWebhook(rawBody, headers)` | проверить подпись, отбросить повтор, сгенерировать события |
| `stickers.list(wsId)` · `stickers.createPack(wsId, { name, shortName })` · `stickers.addStickers(packId, [{ emoji, data }])` · `stickers.remove(id)` | стикеры; паки — с `MANAGE_STICKERS` |
| `boards.list(wsId)` · `boards.get(id)` · `boards.categories.*` · `boards.setFeatures(boardId, …)` | доски |
| `tasks.list` · `search` · `get` · `create` · `update` · `setAssignees` · `comment` · `tasks.checklists.*` · `tasks.milestones.*` | задачи, чек-листы, вехи |
| `forms.list` · `create` · `update` · `delete` · `get` · `submit` · `preview` | формы досок |
| `members.get(wsId, userId)` · `members.setNickname(wsId, userId, nick)` | профиль участника · никнейм |
| `calendar.list(wsId, from, to)` · `get` · `create` · `update` · `delete` · `freebusy(wsId, users, from, to)` · `suggest(wsId, q)` | календарь |
| `invites.list` · `create` · `delete` · `email(wsId, address)` · `listEmail` · `deleteEmail` | приглашения |
| `badges.list` · `create` · `update` · `delete` · `set(wsId, userId, badgeId)` | бейджи |
| `recording.start(roomId)` · `recording.stop(roomId)` | запись встречи |
| `fetchMe()` · `updateProfile({ displayName?, description? })` | профиль бота |
| `rest.request(method, path, { json?, query?, form? })` · `rest.call(Schema, …)` | любой другой разрешённый маршрут |

Подробности по каждой группе — в главах REST: [сообщения](./rest-messages), [доски](./rest-boards), [календарь](./rest-calendar) и другие.

## События

| Событие | Данные |
|---|---|
| `ready` | `Ready` — аккаунт бота, пространства (видимые комнаты, участники, голос), DM |
| `resumed` | соединение восстановлено, пропущенное переслано |
| `message` | `Message` от кого-то другого (не команда этому боту) |
| `command` | `{ name, args, message, workspaceId }` — `/name args` или `/name@username args` этому боту |
| `messageUpdate` · `messageDelete` | `Message` · `{ workspaceId, roomId, messageId }` |
| `reaction` | `{ type: 'add' \| 'remove', workspaceId, roomId, messageId, userId, emoji }` |
| `callback` | `BotCallback` — нажатие кнопки, см. [Команды и кнопки](./commands-buttons) |
| `taskNotice` | `TaskNoticeRelay` — уведомление человека о задаче, см. [Уведомления о задачах](./task-notices) |
| `voiceState` | `VoiceState` (`roomId` пуст — вышел из голоса) |
| `dispatch` | любой сырой `DispatchEvent` (комнаты, участники, присутствие…) |
| `status` | `connecting` · `ready` · `reconnecting` · `resuming` · `stopped` |
| `error` | обработчик бросил исключение или gateway сдался (`GatewayFatalError`) |

## Надёжность

- **Переподключение**: экспоненциальная задержка 1 → 30 с со случайным разбросом, затем `RESUME`; если не вышло — снова `IDENTIFY` и новое событие `ready`.
- **Фатальные ошибки** (без переподключения; `start()` отклоняется или приходит `error` с `GatewayFatalError.kind`): `auth-failed` (4004 — неверный или перевыпущенный токен), `revoked` (4010), `replaced` (другой процесс подключился с тем же токеном).
- **`429`** повторяется до `maxRetries` раз после `Retry-After`; сообщения сохраняют `nonce`, поэтому повтор не дублирует. Остальные ошибки бросают `ApiError { status, code, reason, field, used, limit, retryAfterMs }` — например, `code: 'FORBIDDEN', reason: 'BOT_NOT_ALLOWED'`.

```js
import { ApiError } from '@calaba/bot-sdk';

try {
  await bot.send(roomId, 'Отчёт готов');
} catch (e) {
  if (e instanceof ApiError && e.code === 'BOT_BLOCKED') return; // человек заблокировал бота
  throw e;
}
```

## Вебхуки

```js
import { createServer } from 'node:http';
import { Bot, verifyBoardWebhook, parseBoardWebhookEvent } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, { server: 'https://app.example.com', webhookSecret: process.env.WEBHOOK_SECRET });
await bot.webhook.set('https://bot.example.com/calab', process.env.WEBHOOK_SECRET);
```

Отдельные функции: `verifyWebhookSignature(secret, rawBody, header)`, `signWebhook`, `parseWebhookUpdate` — для вебхука бота; `verifyBoardWebhook(secret, timestamp, body, signature)`, `signBoardWebhook`, `parseBoardWebhookEvent(body)` — для вебхука доски. Подробно — [Вебхуки](./webhooks).

## Примеры

В каталоге `examples/bots` репозитория:

| Пример | Что делает | Нужно |
|---|---|---|
| `echo` | отвечает текстом сообщения, `/echo <текст>`, `/ping` | — |
| `voice-echo` | `/join` в чате голосовой комнаты — заходит в звонок и повторяет каждую услышанную фразу; `/play` играет WAV | `@livekit/rtc-node`; `CONNECT` + `SPEAK` |
| `tts` | `/say <текст>` в чате голосовой комнаты — произносит текст (TTS, совместимый с OpenAI, или тон без ключа) | `@livekit/rtc-node`; `CONNECT` + `SPEAK` |
| `python/voice_listen.py` | заходит в голосовую комнату, подписывается на всех, печатает уровни | `livekit` (pip); `CONNECT` |

```sh
cd examples/bots/echo
npm install
BOT_TOKEN=calab_bot_… CALAB_SERVER=https://app.example.com npm start
```

> [!TIP]
> На других языках SDK не нужен: REST — обычный HTTP с JSON, gateway принимает JSON-кадры (`?encoding=json`). Типы для любого языка можно сгенерировать из `proto/` репозитория (`buf generate` с нужным плагином).
