---
title: Комнаты и голос
description: Комнаты и категории, временные комнаты, голос через LiveKit, модерация звонка, допуск гостей, запись встреч, саундборд и телефония.
order: 5
---

Бот видит только комнаты, где у него есть `VIEW_ROOM`. С правами своих ролей он может создавать и настраивать комнаты и категории, а в голосовой комнате — подключаться к звонку как обычный участник: слушать, говорить, показывать экран, модерировать, допускать гостей, записывать встречу, проигрывать звуки и звонить на телефон.

| Действие | Право |
|---|---|
| видеть комнату и категории | `VIEW_ROOM` / участник пространства |
| создавать, менять, удалять комнаты и категории, переопределения прав | `MANAGE_ROOM` (в пространстве или в комнате) |
| временная комната | `CREATE_TEMP_ROOMS` |
| подключиться к голосу | `CONNECT`; говорить — `SPEAK`, экран — `STREAM`, камера — `VIDEO` |
| заглушить / вернуть звук, отключить от голоса, остановить чужой стрим или камеру | `MUTE_MEMBERS` (и иерархия ролей: только тех, кто ниже) |
| переместить в другую комнату | `MOVE_MEMBERS` в обеих комнатах |
| допуск гостей | `INVITE_GUESTS` в комнате |
| запись встречи | `VIEW_ROOM` + `CONNECT` + `MANAGE_RECORDINGS` |
| звонок на телефон | `PLACE_CALLS`, бот в звонке комнаты, телефония включена |
| библиотека звуков | `MANAGE_STICKERS` |

## Маршруты

<!-- routes:rooms -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/workspaces/{id}/rooms` | Комнаты пространства, которые видит бот → `{rooms}` |
| `POST` | `/api/workspaces/{id}/rooms` | Создать комнату → `{room}` (`MANAGE_ROOM`) |
| `POST` | `/api/workspaces/{id}/rooms/temp` | Временная комната без гостей и без встречи (`CREATE_TEMP_ROOMS`) |
| `GET` | `/api/rooms/{id}` | Комната и права бота в ней → `{room, permissions}` |
| `PATCH` | `/api/rooms/{id}` | Изменить комнату → `{room}` (`MANAGE_ROOM`) |
| `DELETE` | `/api/rooms/{id}` | Удалить комнату (`MANAGE_ROOM`) |
| `PUT` | `/api/rooms/{id}/permissions` | Заменить переопределения прав комнаты `{overrides}` (`MANAGE_ROOM`) |
| `PUT` | `/api/workspaces/{id}/rooms/order` | Порядок комнат и категорий `{rooms, categories}` |
| `GET` | `/api/workspaces/{id}/categories` | Категории комнат → `{categories}` |
| `POST` | `/api/workspaces/{id}/categories` | Создать категорию `{name, position?}` |
| `PATCH` | `/api/categories/{id}` | Переименовать / переместить категорию |
| `DELETE` | `/api/categories/{id}` | Удалить категорию |
| `POST` | `/api/rooms/{id}/join` | Подключиться к голосу → `{url, token, …}` для LiveKit (`CONNECT`) |
| `POST` | `/api/rooms/{id}/voice/leave` | Выйти из голоса → `204` |
| `POST` | `/api/rooms/{id}/stream/request` | Запросить слот показа экрана (`STREAM`) |
| `POST` | `/api/rooms/{id}/camera/request` | Включить камеру перед публикацией (`VIDEO`) |
| `POST` | `/api/rooms/{id}/camera/stop` | Выключить свою камеру |
| `PATCH` | `/api/voice/self` | Свои `muted` / `deafened` |
| `PATCH` | `/api/rooms/{id}/voice-status` | Статус звонка комнаты `{status}` (≤ 60 символов) |
| `POST` | `/api/rooms/{id}/voice/{userId}/mute` | Заглушить участника (`MUTE_MEMBERS`) |
| `POST` | `/api/rooms/{id}/voice/{userId}/unmute` | Вернуть звук участнику (`MUTE_MEMBERS`) |
| `POST` | `/api/rooms/{id}/voice/{userId}/disconnect` | Отключить от голоса (`MUTE_MEMBERS`) |
| `POST` | `/api/rooms/{id}/voice/{userId}/move` | Переместить в другую комнату `{targetRoomId}` (`MOVE_MEMBERS`) |
| `POST` | `/api/rooms/{id}/voice/{userId}/stop-stream` | Остановить чужой показ экрана (`MUTE_MEMBERS`) |
| `POST` | `/api/rooms/{id}/voice/{userId}/stop-camera` | Выключить чужую камеру до выхода из звонка (`MUTE_MEMBERS`) |
| `POST` | `/api/rooms/{id}/voice/{userId}/allow-camera` | Снова разрешить камеру участнику (`MUTE_MEMBERS`) |
| `GET` | `/api/rooms/{id}/admissions` | Гости, ожидающие допуска → `{admissions}` (`INVITE_GUESTS`) |
| `POST` | `/api/rooms/{id}/admissions/{userId}` | Решение по гостю `{status, displayName?, badgeId?}` |
| `POST` | `/api/rooms/{id}/recording/start` | Начать запись встречи → `{recording}` |
| `POST` | `/api/rooms/{id}/recording/stop` | Остановить запись → `{recording}` |
| `GET` | `/api/workspaces/{id}/sounds` | Звуки саундборда → `{sounds}` |
| `POST` | `/api/workspaces/{id}/sounds` | Добавить звук `{name, emoji, fileId}` (`MANAGE_STICKERS`) |
| `PATCH` | `/api/workspaces/{id}/sounds/{soundId}` | Изменить звук (`MANAGE_STICKERS`) |
| `DELETE` | `/api/workspaces/{id}/sounds/{soundId}` | Удалить звук (`MANAGE_STICKERS`) |
| `POST` | `/api/rooms/{id}/sounds/play` | Проиграть звук всем в звонке `{soundId}` |
| `POST` | `/api/rooms/{id}/calls` | Позвонить на номер из звонка комнаты `{number}` (`PLACE_CALLS`) |
| `DELETE` | `/api/rooms/{id}/calls/{cid}` | Положить трубку |
<!-- /routes -->

### Недоступно ботам

- Гостевые ссылки на комнату: `GET · POST /api/rooms/{id}/invites`, `PATCH · DELETE /api/rooms/{id}/invites/{inviteId}`, вход по ссылке `POST /api/room-invites/{code}/join`.
- Настройки уведомлений комнаты: `PUT /api/rooms/{id}/notifications`.
- Ожидание допуска (`DELETE /api/rooms/{id}/admissions/me`) — это действие гостя.
- Фоны камеры пространства `/api/workspaces/{id}/backgrounds…` — у бота нет камеры с фоном.
- Настройки телефонии и журнал звонков: `/api/workspaces/{id}/sip`, `/api/workspaces/{id}/sip/test`, `GET /api/workspaces/{id}/calls`.
- Звонки один на один: `POST /api/dms/{id}/call`, `/api/calls/{id}/…` — бот не звонит и не отвечает, позвонить боту нельзя.
- Повтор обработки, перезагрузка и удаление записей встреч.

## Создать комнату

`CreateRoomRequest`: `type` (`ROOM_TYPE_TEXT` или `ROOM_TYPE_VOICE`), `name` (1..100), `topic` (≤ 1024), `isPrivate`, `categoryId`, `position`, `userLimit` (только голосовые, 0..99).

```sh tab="curl"
curl -s -X POST $CALAB/api/workspaces/$WS/rooms \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type": "ROOM_TYPE_VOICE", "name": "Стендап", "userLimit": 12}'
```

```js tab="JavaScript"
// у SDK нет отдельного метода — bot.rest.request возвращает разобранный JSON
const { room } = await bot.rest.request('POST', `/api/workspaces/${wsId}/rooms`, {
  json: { type: 'ROOM_TYPE_VOICE', name: 'Стендап', userLimit: 12 },
});
```

```json
{
  "room": {
    "id": "0192a2d0-1111-7000-8000-00000000a001",
    "workspaceId": "0191f0aa-0000-7000-8000-000000000001",
    "type": "ROOM_TYPE_VOICE",
    "name": "Стендап",
    "topic": "",
    "position": 7,
    "isPrivate": false,
    "categoryId": "",
    "userLimit": 12,
    "allowRecording": false,
    "restricted": false,
    "permissionOverrides": [],
    "createdAt": "2026-10-14T10:00:00Z"
  }
}
```

Список и одна комната есть и в SDK: `bot.rooms(workspaceId?)`, `bot.room(roomId)`.

### Временная комната

`POST /api/workspaces/{id}/rooms/temp` — `{name, ttlSeconds, private?, memberIds?, guests?, withEvent?}`; срок жизни — от 900 с (15 минут) до 604 800 с (7 дней). Ответ — `{room, inviteUrl, inviteCode}`: ссылка только для участников пространства.

> [!WARNING]
> Бот не приглашает гостей и не назначает встречи из временной комнаты: `guests` по умолчанию `true`, поэтому боту нужно явно передать `"guests": false` и не передавать `withEvent`, иначе — `403 BOT_NOT_ALLOWED`.

## Голос через LiveKit

Медиа идёт напрямую через LiveKit (SFU) — REST-API его не проксирует. Бот в звонке — обычный участник: строка в списке с меткой «BOT», индикатор речи; серверное заглушение и отключение действуют на него как на человека; он занимает место в комнате.

1. `POST /api/rooms/{id}/join` (голосовая комната, право `CONNECT`) → `JoinVoiceResponse {url, token, identity, media, canSpeak, canStream, canVideo, pending}`. `token` — JWT LiveKit на 10 минут; его права повторяют права бота: `SPEAK` — публиковать микрофон, `STREAM` — показ экрана (если есть свободный слот), `VIDEO` — камеру (перед публикацией вызовите `POST /api/rooms/{id}/camera/request`). Подключайтесь сразу: без подключения в течение 15 секунд место освобождается.
2. Подключите клиент LiveKit с `url` + `token`: подпишитесь на аудиодорожки участников и опубликуйте свою (Opus 48 кГц, источник «микрофон»).
3. Выход: отключитесь от LiveKit и вызовите `POST /api/rooms/{id}/voice/leave` (→ `204`) — место освободится сразу.

Кто в комнате: `voiceStates` в `READY` и события `voiceStateUpdate` (пустой `roomId` — участник вышел), см. [Gateway](./gateway). В SDK — `bot.voice.participants(roomId)`.

```js tab="JavaScript"
// npm i @livekit/rtc-node
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind,
  TrackPublishOptions, TrackSource } from '@livekit/rtc-node';

const { url, token, canSpeak } = await bot.voice.join(roomId);
const room = new Room();
await room.connect(url, token, { autoSubscribe: true });
room.on(RoomEvent.TrackSubscribed, async (track, _pub, participant) => {
  if (track.kind !== TrackKind.KIND_AUDIO) return;
  for await (const frame of new AudioStream(track, 48000, 1)) {
    // frame.data — Int16Array: 10 мс PCM от participant.identity
  }
});
const source = new AudioSource(48000, 1);
if (canSpeak) {
  await room.localParticipant.publishTrack(LocalAudioTrack.createAudioTrack('bot', source),
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  await source.captureFrame(new AudioFrame(pcm480, 48000, 1, 480)); // по 10 мс
}
// …
await room.disconnect();
await bot.voice.leave(roomId);
```

```python tab="Python"
# pip install livekit requests
import asyncio, requests
from livekit import rtc

join = requests.post(f"{CALAB}/api/rooms/{room_id}/join", headers=H).json()   # {"url", "token", …}
room = rtc.Room()

@room.on("track_subscribed")
def on_track(track, publication, participant):
    if track.kind == rtc.TrackKind.KIND_AUDIO:
        asyncio.create_task(listen(track, participant.identity))

async def listen(track, who):
    async for ev in rtc.AudioStream(track, sample_rate=48000, num_channels=1):
        pcm = ev.frame.data            # memoryview int16

await room.connect(join["url"], join["token"])
# говорить: source = rtc.AudioSource(48000, 1); track = rtc.LocalAudioTrack.create_audio_track("bot", source)
# await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
```

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$VOICE/join -H "Authorization: Bearer $TOKEN"
# {"url": "wss://…", "token": "eyJ…", "identity": "…", "canSpeak": true, "canStream": false, "canVideo": false, "pending": false, …}
curl -s -X POST $CALAB/api/rooms/$VOICE/voice/leave -H "Authorization: Bearer $TOKEN"   # → 204
```

На Go подойдёт `livekit/server-sdk-go` (`lksdk.ConnectToRoomWithToken(url, token, callbacks)`). Готовые примеры (эхо-бот в голосе, синтез речи, Python) — в разделе [SDK](./sdk).

> [!NOTE]
> Бот не слышит сам себя: LiveKit не присылает участнику его собственные дорожки.

## Модерация звонка

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$VOICE/voice/$USER/mute -H "Authorization: Bearer $TOKEN"
curl -s -X POST $CALAB/api/rooms/$VOICE/voice/$USER/move -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"targetRoomId\": \"$OTHER_VOICE\"}"
curl -s -X PATCH $CALAB/api/voice/self -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"muted": true}'
```

## Допуск гостей

Если в комнате включён допуск гостей, гость по ссылке ждёт решения. Бот с `INVITE_GUESTS` в комнате читает очередь и решает: `status` — `ROOM_ADMISSION_STATUS_ADMITTED` или `ROOM_ADMISSION_STATUS_DECLINED`; при допуске можно переименовать гостя (`displayName`, 1..40) и выдать значок (`badgeId`). Если запрос уже не ожидает решения — `409 CONFLICT`.

```sh tab="curl"
curl -s $CALAB/api/rooms/$VOICE/admissions -H "Authorization: Bearer $TOKEN"
curl -s -X POST $CALAB/api/rooms/$VOICE/admissions/$GUEST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"status": "ROOM_ADMISSION_STATUS_ADMITTED", "displayName": "Партнёр"}'
```

## Запись встречи

`POST /api/rooms/{id}/recording/start` и `…/stop` работают, когда в звонке комнаты кто-то есть, у комнаты включено `allowRecording`, а пространство подключено к сервису записи и расшифровки. Ответ — `{recording: {recordingId, state, byUserId, since, …}}`. Для бота нужны `VIEW_ROOM`, `CONNECT` и **`MANAGE_RECORDINGS`**. Готовая расшифровка — в разделе [Сообщения](./rest-messages#расшифровка-записи-встречи).

```js tab="JavaScript"
const rec = await bot.recording.start(roomId);
// …
await bot.recording.stop(roomId);
```

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$VOICE/recording/start -H "Authorization: Bearer $TOKEN"
```

## Саундборд

`GET /api/workspaces/{id}/sounds` — звуки пространства (`{sounds: [{id, name, emoji, fileId, durationMs, position}]}`). `POST /api/rooms/{id}/sounds/play {soundId}` проигрывает звук всем в звонке; `soundId` — id звука или встроенный `builtin:<name>`. Бот должен быть в звонке этой комнаты. Лимиты: 1 звук в 2 секунды на бота и 5 за 10 секунд на комнату.

Библиотеку звуков меняет бот с `MANAGE_STICKERS`: `{name (1..32), emoji, fileId}`, где файл — собственная загрузка бота в это пространство.

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$VOICE/sounds/play -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"soundId": "builtin:air_horn"}'
```

## Телефония

`POST /api/rooms/{id}/calls {number}` звонит на номер (E.164, например `+79161234567`) из звонка комнаты: собеседник входит в комнату участником `sip:<callId>`. `DELETE /api/rooms/{id}/calls/{cid}` кладёт трубку своей линии (чужой — с `MUTE_MEMBERS`). Статусы приходят событием `sipCallUpdate`.

- Нужны `PLACE_CALLS`, присутствие бота в звонке этой комнаты и включённая телефония пространства.
- Не больше 20 звонков в час на пространство (`429`, код `SIP_RATE_LIMITED`).
- Только тариф Business: ниже — `409 PLAN_LIMIT` (положить трубку можно всегда).

## Подводные камни

> [!NOTE]
> Закрытые комнаты действуют и для ботов: бот попадает в такую комнату только через переопределение прав на самой комнате (лично или по роли), иначе получает `404` — как человек.

> [!WARNING]
> Административные действия бота (удаление комнаты, смена прав комнаты, допуск гостей, запись) записываются в журнал сервера с указанием владельца бота. Токен бота с правами `MANAGE_*` храните как пароль администратора.
