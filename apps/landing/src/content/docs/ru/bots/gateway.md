---
title: 'Gateway: события в реальном времени'
description: Подключение к gateway по WebSocket, IDENTIFY и READY, heartbeat, события, RESUME после обрыва и коды закрытия.
order: 17
---

Gateway — постоянное WebSocket-соединение, по которому сервер присылает боту события: новые сообщения, реакции, изменения в голосе, задачи. Один сокет на бота. Если постоянное соединение неудобно (serverless), события сообщений и задач можно получать [вебхуком](./webhooks).

## Подключение

```text
wss://app.example.com/gateway?v=1                  # бинарный protobuf (по умолчанию)
wss://app.example.com/gateway?v=1&encoding=json    # текстовые кадры protojson
```

Каждый кадр — `GatewayFrame { op, seq, <payload> }`. По умолчанию кадры — бинарный protobuf; с `encoding=json` — текстовые JSON-кадры в том же формате, что REST (поля lowerCamelCase, перечисления полным именем, `uint64` строками). JSON удобен, если в вашем языке нет библиотеки protobuf.

## Жизненный цикл

1. **Сервер → `HELLO`** `{ heartbeatIntervalMs }` — интервал heartbeat, около 41 секунды.
2. **Бот → `IDENTIFY`** `{ token, device: { name, platform, appVersion } }` — токен бота и описание процесса.
3. **Сервер → `DISPATCH ready`** с `seq = 1`: `sessionId`, `me`, `workspaces[]` (для каждого пространства — видимые комнаты, участники, роли, голосовые состояния, присутствие, права бота по комнатам), `dms[]`, `readStates`.
4. Дальше — кадры **`DISPATCH`** с событиями и растущим `seq`.
5. Каждые `heartbeatIntervalMs` бот шлёт **`HEARTBEAT`** `{ lastSeq }`, сервер отвечает `HEARTBEAT_ACK`. Нет heartbeat дольше 2 × интервал + 10 с — сокет закрывается с кодом `4009`.

Кадры в режиме JSON:

```json
→ {"op": "GATEWAY_OPCODE_IDENTIFY", "identify": {"token": "calab_bot_0192a1b2-…", "device": {"name": "my-bot", "platform": "linux", "appVersion": "1.0"}}}
← {"op": "GATEWAY_OPCODE_HELLO", "hello": {"heartbeatIntervalMs": 41000}}
← {"op": "GATEWAY_OPCODE_DISPATCH", "seq": "1", "dispatch": {"ready": {"sessionId": "…", "me": {"user": {"id": "…", "isBot": true}}, "workspaces": […], "dms": […]}}}
← {"op": "GATEWAY_OPCODE_DISPATCH", "seq": "2", "dispatch": {"messageCreate": {"workspaceId": "…", "message": {"id": "…", "content": "/echo hi", "command": {"botUserId": "…", "name": "echo", "args": "hi"}}}}}
→ {"op": "GATEWAY_OPCODE_HEARTBEAT", "heartbeat": {"lastSeq": "2"}}
← {"op": "GATEWAY_OPCODE_HEARTBEAT_ACK", "heartbeatAck": {}}
```

## Минимальный клиент

```js tab="JavaScript"
import WebSocket from 'ws';

const ws = new WebSocket('wss://app.example.com/gateway?v=1&encoding=json');
let lastSeq = '0';
let timer;

ws.on('message', (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.seq) lastSeq = f.seq;
  switch (f.op) {
    case 'GATEWAY_OPCODE_HELLO':
      ws.send(JSON.stringify({ op: 'GATEWAY_OPCODE_IDENTIFY',
        identify: { token: process.env.TOKEN, device: { name: 'my-bot', platform: 'linux', appVersion: '1.0' } } }));
      timer = setInterval(() => ws.send(JSON.stringify({ op: 'GATEWAY_OPCODE_HEARTBEAT', heartbeat: { lastSeq } })),
        f.hello.heartbeatIntervalMs);
      break;
    case 'GATEWAY_OPCODE_DISPATCH':
      if (f.dispatch.messageCreate) console.log('message:', f.dispatch.messageCreate.message.content);
      break;
  }
});
ws.on('close', (code, reason) => { clearInterval(timer); console.log('closed', code, reason.toString()); });
```

```python tab="Python"
import asyncio, json, os, websockets

async def main():
    async with websockets.connect("wss://app.example.com/gateway?v=1&encoding=json") as ws:
        hello = json.loads(await ws.recv())
        interval = hello["hello"]["heartbeatIntervalMs"] / 1000
        await ws.send(json.dumps({"op": "GATEWAY_OPCODE_IDENTIFY", "identify": {
            "token": os.environ["TOKEN"], "device": {"name": "my-bot", "platform": "linux", "appVersion": "1.0"}}}))
        last_seq = "0"

        async def heartbeat():
            while True:
                await asyncio.sleep(interval)
                await ws.send(json.dumps({"op": "GATEWAY_OPCODE_HEARTBEAT", "heartbeat": {"lastSeq": last_seq}}))

        hb = asyncio.create_task(heartbeat())
        async for raw in ws:
            f = json.loads(raw)
            last_seq = f.get("seq", last_seq)
            ev = f.get("dispatch", {})
            if "messageCreate" in ev:
                print("message:", ev["messageCreate"]["message"]["content"])
        hb.cancel()

asyncio.run(main())
```

Это скелет: в настоящем боте нужно ещё переподключение и `RESUME` (ниже). [SDK для Node.js](./sdk) делает всё это сам.

## События

Событие — поле `dispatch` кадра `DISPATCH` (ровно одно на кадр). Бот получает только то, что видит по своим правам (`VIEW_ROOM`, `VIEW_BOARD`).

| Событие | Когда |
|---|---|
| `ready` · `resumed` | после `IDENTIFY` · после успешного `RESUME` |
| `messageCreate` · `messageUpdate` · `messageDelete` | сообщения комнат и личных сообщений бота (свои тоже) |
| `messageReactionAdd` · `messageReactionRemove` | реакции |
| `botCallback` | человек нажал кнопку под сообщением бота — только этому боту, см. [Команды и кнопки](./commands-buttons) |
| `voiceStateUpdate` · `voiceStreamStart` / `voiceStreamStop` · `voiceCameraStop` · `voiceMoved` | голос: кто в какой комнате, микрофон, стримы |
| `presenceUpdate` · `userUpdate` | присутствие и профили |
| `roomCreate` / `roomUpdate` / `roomDelete` · `roomPermissionsUpdate` · `categoryCreate` / `categoryUpdate` / `categoryDelete` | комнаты и категории |
| `workspaceCreate` / `workspaceUpdate` / `workspaceDelete` · `workspaceMemberAdd` / `workspaceMemberUpdate` / `workspaceMemberRemove` · `roleCreate` / `roleUpdate` / `roleDelete` | пространства, участники, роли |
| `dmCreate` | новый DM с ботом |
| `typingStart` | «печатает» — только в комнатах из `SUBSCRIBE` |
| `stickerPackCreate` / `stickerPackUpdate` / `stickerPackDelete` | стикерпаки пространства |
| `soundCreate` / `soundUpdate` / `soundDelete` · `soundPlay` | звуки пространства; `soundPlay` — пока бот в звонке комнаты |
| `botCreate` / `botUpdate` / `botDelete` | боты пространства — только при `MANAGE_BOTS` |
| `sipCallUpdate` | телефонный звонок из комнаты набран или сменил статус |
| `eventCreate` / `eventUpdate` / `eventDelete` · `eventRsvp` | встречи: свои (бот — организатор) и встречи видимых комнат; внешние адреса — только если бот может менять встречу |
| `boardCreate` / `boardUpdate` / `boardDelete` · `taskCreate` / `taskUpdate` / `taskDelete` · `taskActivity` | доски и задачи — по `VIEW_BOARD` бота |
| `taskNotice` | уведомление человека о задаче, если он выбрал этого бота — см. [Уведомления о задачах](./task-notices) |

Полная таблица всех событий протокола с пометкой, какие приходят ботам, — [События gateway](../reference/gateway-events). Боты **не получают** отметки о прочтении людей, уведомления о звонках один на один, события заметок, оплаты и Диска.

## Что бот может отправить

| Кадр | Что делает | Ограничения |
|---|---|---|
| `HEARTBEAT { lastSeq }` | держит соединение | каждые `heartbeatIntervalMs` |
| `TYPING { roomId }` | «бот печатает» в комнате | не чаще раза в 3 с на комнату |
| `SUBSCRIBE { roomIds }` | подписка на `typingStart` этих комнат; заменяет прежний набор | до 100 комнат |
| `PRESENCE_UPDATE { status }` | статус присутствия (`PRESENCE_STATUS_ONLINE`, `…_IDLE`, `…_DND`, `…_INVISIBLE`) | — |

`TYPING`, `SUBSCRIBE` и `PRESENCE_UPDATE` вместе — не больше 10 подряд и 2 в секунду; лишние молча отбрасываются. Больше 50 кадров в секунду устойчиво — сокет закрывается с `4008`.

## Переподключение и RESUME

Соединение рвётся — это нормально (деплой сервера, сеть). Правильная реакция:

1. Переподключитесь с экспоненциальной задержкой: 1 → 30 с со случайным разбросом.
2. После `HELLO` отправьте **`RESUME`** `{ token, sessionId, seq }` — `sessionId` из `ready`, `seq` — последний обработанный.
3. Сервер перешлёт пропущенное (буфер около 5 минут или 1000 событий) и пришлёт `resumed { replayed }`.
4. Если сессию не восстановить — придёт `INVALID_SESSION { resumable: false }`: через 1–5 с отправьте `IDENTIFY` на том же сокете и получите новый `ready`.

Кадр `RECONNECT` — сервер сам просит переподключиться (например, перед деплоем): закройте сокет и выполните шаги выше. События с `seq` не больше последнего обработанного пропускайте — при повторе они могут прийти дважды.

## Коды закрытия

| Код | Что значит | Что делать |
|---|---|---|
| `4000` | неизвестная ошибка | переподключиться, `RESUME` |
| `4000` + `replaced by a new session` | подключился другой процесс с тем же токеном | **не** переподключаться |
| `4001` · `4002` | неизвестный opcode · ошибка декодирования | переподключиться, `RESUME` |
| `1006` | соединение оборвалось | переподключиться, `RESUME` |
| `4003` | не прошёл `IDENTIFY` | переподключиться, новый `IDENTIFY` |
| `4004` | неверный токен | **не** переподключаться |
| `4007` · `4009` | неверный `seq` · истёк heartbeat | переподключиться, новый `IDENTIFY` |
| `4008` | превышен лимит (флуд или переполнена очередь отправки в 256 кадров) | подождать, `RESUME` |
| `4010` | токен отозван или бот удалён | **не** переподключаться |

## Ограничения сокета

| Что | Значение |
|---|---|
| Сокетов на токен | 1 |
| Размер входящего кадра | до 64 КиБ |
| Очередь отправки сервера | 256 кадров, переполнение — `4008` |
| Буфер для `RESUME` | около 5 минут или 1000 событий |
