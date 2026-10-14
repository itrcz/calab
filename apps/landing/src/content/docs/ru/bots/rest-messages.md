---
title: Сообщения
description: Отправка, правка и удаление сообщений, ответы, пересылка, реакции, закрепы, отметка о прочтении и расшифровки записей встреч.
order: 4
---

Бот пишет в комнаты и личные сообщения теми же маршрутами, что и приложение: отправляет текст, файлы и стикеры, отвечает на сообщения, пересылает их, ставит реакции, закрепляет и читает историю. Здесь же — чтение одного сообщения по id (удобно для ответа на карточку) и полная расшифровка записи встречи.

Права проверяются по комнате, как для человека:

| Действие | Право |
|---|---|
| читать историю, одно сообщение, закрепы, расшифровку | `VIEW_ROOM` |
| писать, ставить реакции | `SEND_MESSAGES` (+ `ATTACH_FILES` для вложений) |
| править своё сообщение | автор |
| удалять чужие, закреплять | `MANAGE_MESSAGES` (в личных сообщениях закрепляют оба участника) |
| пересылать | `VIEW_ROOM` в исходной комнате и `SEND_MESSAGES` в целевой |

## Маршруты

<!-- routes:messages -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/rooms/{id}/messages` | История комнаты, новые сверху: `?before=&after=&limit=` (`limit ≤ 100`); `?q=` — полнотекстовый поиск по комнате (`VIEW_ROOM`) |
| `GET` | `/api/rooms/{id}/messages/{messageId}` | Одно сообщение — голый `Message` без обёртки (`VIEW_ROOM`) |
| `POST` | `/api/rooms/{id}/messages` | Отправить сообщение → `201 {message}` (`SEND_MESSAGES`) |
| `POST` | `/api/rooms/{id}/messages/{mid}/forward` | Переслать в другую комнату `{toRoomId}` → `201 {message}` с полем `forward` |
| `PATCH` | `/api/messages/{id}` | Править своё сообщение: текст и/или inline-клавиатуру → `{message}` |
| `DELETE` | `/api/messages/{id}` | Удалить своё или чужое (`MANAGE_MESSAGES`) → `204` |
| `GET` | `/api/messages/{id}/reactions/{emoji}` | Кто поставил реакцию: `?after=&limit=` (1..100, по умолчанию 25) → `{users, hasMore}` |
| `PUT` | `/api/messages/{id}/reactions/{emoji}` | Поставить реакцию (emoji в URL-кодировке) → `204` |
| `DELETE` | `/api/messages/{id}/reactions/{emoji}` | Снять свою реакцию → `204` |
| `PUT` | `/api/messages/{id}/pin` | Закрепить → `204` (`MANAGE_MESSAGES`) |
| `DELETE` | `/api/messages/{id}/pin` | Открепить → `204` |
| `GET` | `/api/rooms/{id}/pins` | Закреплённые сообщения, последние закреплённые сверху → `{messages}` |
| `PUT` | `/api/rooms/{id}/read` | Сдвинуть отметку о прочтении `{messageId}` → `204` |
| `PUT` | `/api/messages/{id}/embeds-hidden` | Скрыть / показать превью ссылок `{hidden}` (автор или `MANAGE_MESSAGES`) → `{message}` |
| `GET` | `/api/rooms/{id}/recordings/{rid}/transcript` | Полная расшифровка записи встречи (`VIEW_ROOM`) |
<!-- /routes -->

### Недоступно ботам

На эти маршруты бот получает `403 FORBIDDEN`, `reason: "BOT_NOT_ALLOWED"`:

- `POST /api/messages/{id}/interactions` — нажатие inline-кнопки: нажимают только люди (бот получает результат как событие `botCallback`, см. [Команды и кнопки](./commands-buttons));
- `GET /api/unfurl`, `GET /api/unfurl/image` — превью ссылок строит приложение, не бот;
- `POST /api/rooms/{id}/recordings/{rid}/recheck`, `…/reupload`, `DELETE /api/rooms/{id}/recordings/{rid}` — повтор обработки, перезагрузка и удаление записей.

## Отправить сообщение

Тело — `CreateMessageRequest`:

| Поле | Тип | Описание |
|---|---|---|
| `content` | string | Текст, ≤ 4000 символов. Упоминание — `@<id пользователя>` |
| `attachmentIds` | string[] | id заранее загруженных файлов, ≤ 20 (см. [Файлы](./rest-files)) |
| `replyToId` | string | id сообщения, на которое это ответ |
| `nonce` | string | Ключ идемпотентности, ≤ 64 символов |
| `stickerId` | string | Стикер вместо текста (см. [Стикеры](./rest-stickers)) |
| `inlineKeyboard` | object | Inline-кнопки (см. [Команды и кнопки](./commands-buttons)) |

`nonce` защищает от дублей: повтор запроса с тем же `nonce` вернёт то же сообщение с кодом `200` вместо `201`. Генерируйте его один раз на сообщение и повторяйте при сетевых ошибках и `429`.

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$ROOM/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content": "Привет! Я бот.", "nonce": "hello-1"}'
```

```js tab="JavaScript"
import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, { server: 'https://app.example.com' });
const message = await bot.send(roomId, { text: 'Привет! Я бот.', nonce: 'hello-1' });
```

```python tab="Python"
import os, requests

CALAB = "https://app.example.com"
H = {"Authorization": f"Bearer {os.environ['BOT_TOKEN']}"}
r = requests.post(f"{CALAB}/api/rooms/{room_id}/messages", headers=H,
                  json={"content": "Привет! Я бот.", "nonce": "hello-1"})
message = r.json()["message"]
```

Ответ `201`:

```json
{
  "message": {
    "id": "0192a1c4-7b2e-7d10-9a51-3f2b8c0e1d77",
    "roomId": "0191f0aa-2c3d-7e4f-8a9b-1c2d3e4f5a6b",
    "authorId": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
    "content": "Привет! Я бот.",
    "attachments": [],
    "replyToId": "",
    "nonce": "hello-1",
    "createdAt": "2026-10-14T10:01:02.345Z",
    "reactions": [],
    "kind": "MESSAGE_KIND_UNSPECIFIED",
    "embedsHidden": false
  }
}
```

Поля со значениями по умолчанию всегда присутствуют в ответе; поля `uint64` (например, `keyboardRevision`, `size` файла) приходят строками.

### Ответ и упоминание

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$ROOM/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"content\": \"Готово, @$USER\", \"replyToId\": \"$MSG\", \"nonce\": \"r-1\"}"
```

```js tab="JavaScript"
bot.on('message', async (m) => {
  if (m.content.includes('отчёт')) await bot.reply(m, 'Готово');   // replyToId = m.id
});
```

### Файл во вложении

Сначала загрузите файл в пространство (или в личные сообщения), затем передайте его id в `attachmentIds`. SDK делает оба шага сам.

```sh tab="curl"
curl -s -X POST $CALAB/api/workspaces/$WS/files -H "Authorization: Bearer $TOKEN" -F file=@report.pdf
# {"file": {"id": "0192b3…", "name": "report.pdf", "mime": "application/pdf", "size": "48213", "url": "/api/files/0192b3…", …}}
curl -s -X POST $CALAB/api/rooms/$ROOM/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content": "Отчёт", "attachmentIds": ["0192b3…"], "nonce": "rep-1"}'
```

```js tab="JavaScript"
import { readFile } from 'node:fs/promises';

await bot.send(roomId, {
  text: 'Отчёт',
  files: [{ name: 'report.pdf', data: await readFile('report.pdf') }],
});
```

## Править и удалять

`PATCH /api/messages/{id}` принимает `UpdateMessageRequest {content, inlineKeyboard, preserveContent}`:

- `content` заменяет текст целиком; пустой текст допустим, только если у сообщения есть вложения;
- `inlineKeyboard` не передан — клавиатура остаётся; `{}` или `{"rows": []}` — снимается;
- `preserveContent: true` — правка только клавиатуры: текст не трогается, `content` нужно опустить;
- любая правка текста или клавиатуры меняет серверный `keyboardRevision`.

```sh tab="curl"
curl -s -X PATCH $CALAB/api/messages/$MSG \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content": "Отчёт (исправлено)"}'
curl -s -X DELETE $CALAB/api/messages/$MSG -H "Authorization: Bearer $TOKEN"   # → 204
```

```js tab="JavaScript"
await bot.edit(messageId, 'Отчёт (исправлено)');
await bot.edit(messageId, { inlineKeyboard: { rows: [] } }); // снять кнопки, текст оставить
await bot.deleteMessage(messageId);
```

## Пересылка

`POST /api/rooms/{id}/messages/{mid}/forward {toRoomId}` создаёт в целевой комнате копию с полем `forward` (откуда и чьё сообщение). У пересланных копий inline-кнопки не активны.

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$ROOM/messages/$MSG/forward \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"toRoomId\": \"$OTHER_ROOM\"}"
```

```js tab="JavaScript"
const copy = await bot.forward(roomId, messageId, otherRoomId);
```

## Реакции

Emoji передаётся в пути в URL-кодировке. Ответ — `204`. Один участник ставит на одно сообщение не больше 3 разных реакций (`409 CONFLICT`, `reason: "REACTION_LIMIT"`); всего на сообщении — до 20 разных emoji. В комнате — до 50 закреплённых сообщений.

```sh tab="curl"
curl -s -X PUT "$CALAB/api/messages/$MSG/reactions/%F0%9F%91%8D" -H "Authorization: Bearer $TOKEN"   # 👍 → 204
curl -s "$CALAB/api/messages/$MSG/reactions/%F0%9F%91%8D?limit=50" -H "Authorization: Bearer $TOKEN"
# {"users": [{"id": "…", "displayName": "Анна", …}], "hasMore": false}
```

```js tab="JavaScript"
await bot.react(messageId, '👍');
await bot.unreact(messageId, '👍');
```

## История и одно сообщение

`GET /api/rooms/{id}/messages` возвращает `{messages, hasMore}`, новые сверху. Листайте назад через `before=<id самого старого>`, вперёд — через `after=`.

`GET /api/rooms/{id}/messages/{messageId}` возвращает **`200` с голым `Message`** — без обёртки `{message: …}`. Поля и подгрузка деталей те же, что в истории: `id`, `roomId`, `authorId`, `content`, `replyToId`, `attachments`, `reactions` (`me` — относительно вызывающего), метки времени, `kind`, `system`, `sticker`, `forward`. Поле `command` не заполнено — как во всех ответах REST.

```js tab="JavaScript"
const { messages, hasMore } = await bot.messages(roomId, { limit: 50 });
const one = await bot.message(roomId, messageId);
```

```sh tab="curl"
curl -s "$CALAB/api/rooms/$ROOM/messages?limit=50" -H "Authorization: Bearer $TOKEN"
curl -s $CALAB/api/rooms/$ROOM/messages/$MSG -H "Authorization: Bearer $TOKEN"
```

`404 NOT_FOUND` означает одно из: комната недоступна, сообщения нет или оно удалено, сообщение из другой комнаты, сообщение до отметки «очищенной» истории личных сообщений у вызывающего. Второй участник личных сообщений сохраняет свою историю. Для чтения не нужны ни `SEND_MESSAGES`, ни подключение к голосу.

### Системные сообщения

Карточки, которые создаёт сервер, приходят с `kind: "MESSAGE_KIND_SYSTEM"` и полем `system`:

| `system.…` | Что это |
|---|---|
| `recording {recordingId}` | Карточка записи встречи: используйте `recordingId` в URL расшифровки |
| `achievement {achievementId, grantId, note, grantedBy}` | Выданное достижение; автор — получатель |
| `automation {boardId, taskId, ruleId, ruleName, text}` | Сообщение правила автоматизации доски. `text` — простой текст без упоминаний и разметки, никого не уведомляет; `authorId` — создатель правила. Показывайте как «Автоматизация: ruleName» |
| `roomIcon {fileId}` | Смена картинки комнаты (пусто — убрана); автор — кто сменил. Сама картинка — `iconFileId` комнаты |

Команда-ответ на карточку несёт `replyToId` с id **сообщения**-карточки.

## Отметка о прочтении

`PUT /api/rooms/{id}/read {messageId}` двигает отметку только вперёд. Бот не ставит людям отметку «прочитано» (✓✓) и сам не получает события о прочтении.

## Расшифровка записи встречи

`GET /api/rooms/{id}/recordings/{rid}/transcript` возвращает `200` и всю сохранённую расшифровку без пагинации:

```json
{
  "recordingId": "0192a100-0000-7000-8000-000000000001",
  "language": "ru",
  "segments": [
    {"speaker": 0, "startMs": 480, "endMs": 6900, "text": "Первый фрагмент."},
    {"speaker": -1, "startMs": 7200, "endMs": 12050, "text": "Неизвестный говорящий."}
  ]
}
```

`startMs` / `endMs` — числа в миллисекундах от начала записи; `speaker` — метка распознавания с нуля или `-1`, если говорящий неизвестен; `language` может быть пустым.

```js tab="JavaScript"
const t = await bot.transcript(roomId, recordingId);
for (const s of t.segments) console.log(s.speaker, s.text);
```

```sh tab="curl"
curl -s $CALAB/api/rooms/$ROOM/recordings/$REC/transcript -H "Authorization: Bearer $TOKEN"
```

`404 NOT_FOUND` — комната недоступна, записи нет или она удалена, расшифровка ещё не готова, либо в комнате нет ни исходной записи, ни живой пересланной копии её карточки. Подставляйте `roomId` той карточки, которую видите, в том числе пересланной; удаление единственной пересланной копии отзывает доступ к расшифровке.

> [!WARNING]
> `VIEW_ROOM` открывает боту **всю** сохранённую расшифровку, доступную через эту комнату, с учётом правил закрытых комнат. Управлять записью (старт и стоп) это право не даёт — для этого нужен `MANAGE_RECORDINGS`, см. [Комнаты и голос](./rest-rooms).

## Подводные камни

> [!TIP]
> При `429 RATE_LIMITED` подождите `Retry-After` секунд и повторите запрос **с тем же `nonce`** — дубля не будет. Лимиты — в разделе [Ошибки и лимиты](./errors-limits).

> [!NOTE]
> Сообщения, написанные ботами, никогда не становятся командами — петель «бот ↔ бот» не бывает. Как адресовать боту `/команду`, — в разделе [Команды и кнопки](./commands-buttons).

> [!NOTE]
> В приостановленном пространстве запись запрещена (`403 WORKSPACE_SUSPENDED`), чтение работает.
