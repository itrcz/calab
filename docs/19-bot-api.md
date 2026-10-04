# 19 — Bot API

Публичная документация для разработчиков ботов Calab. English: [`19-bot-api.en.md`](19-bot-api.en.md).
Решение и границы — [ADR-0031](adr/0031-bots.md); протокол целиком — [`05-realtime-protocol.md`](05-realtime-protocol.md);
контракт — `proto/calaba/v1/*.proto` (источник правды: имена полей и событий ниже — оттуда).

Бот в Calab — это **пользователь** с флагом `is_bot`: у него те же REST API и realtime-gateway, что у приложения,
а права — только те, что дают его роли и переопределения комнат, как у людей. Отдельного «Bot API» нет: бот делает
то же, что человек, в пределах своих прав. Голос — через LiveKit: бот получает `url` + `token` и подключается
LiveKit-клиентом как обычный участник.

- [Боты за 5 минут](#боты-за-5-минут)
- [Токен и безопасность](#токен-и-безопасность)
- [REST](#rest)
- [Gateway: события в реальном времени](#gateway-события-в-реальном-времени)
- [Команды](#команды)
- [Webhook](#webhook)
- [Вебхук доски](#вебхук-доски)
- [Голос через LiveKit](#голос-через-livekit)
- [Стикеры по API](#стикеры-по-api)
- [Лимиты и ошибки](#лимиты-и-ошибки)
- [FAQ](#faq)

## Боты за 5 минут

1. **Создайте бота.** «Настройки пространства → Боты → Создать бота» (владелец пространства или роль с
   `MANAGE_BOTS`, подтверждённая почта): имя, `username` (`[a-z0-9_]{3,32}`, для `/cmd@username`), описание.
   Токен показывается **один раз** — скопируйте его. Бот сразу становится участником пространства с ролью «участник».
2. **Выдайте права.** По умолчанию у бота права роли «участник» (читать и писать в открытых комнатах, входить в
   голос). Нужно больше или меньше — дайте ему роль или переопределения комнат, как человеку.
3. **Запустите пример** (Node ≥ 20, из корня репозитория):
   ```sh
   pnpm install && pnpm -F @calaba/bot-sdk build
   cd examples/bots/echo && npm install
   BOT_TOKEN=calab_bot_… CALAB_SERVER=https://app.calab.io npm start
   ```
   Напишите в комнате что угодно или `/echo привет` — бот ответит.

Минимальный бот на SDK ([`packages/bot-sdk`](../packages/bot-sdk/README.md)):

```js
import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, { server: 'https://app.calab.io' });
await bot.commands([{ name: 'echo', description: 'Повторить текст' }]);
bot.on('message', (m) => bot.reply(m, m.content));
bot.on('command', (c) => c.name === 'echo' && bot.reply(c, c.args || 'Напишите: /echo текст'));
await bot.start();
```

Без SDK — любой язык с HTTP и WebSocket: REST ниже, gateway — protobuf или JSON-кадры.

## Токен и безопасность

- Формат: `calab_bot_<id бота>_<секрет 43 символа base64url>`. Префикс `calab_bot_` помогает сканерам секретов
  находить утёкшие токены.
- Передаётся **только** в заголовке `Authorization: Bearer <токен>` (REST) и в `IDENTIFY` (gateway). Никогда в URL.
- Сервер хранит только `sha256` секрета; показать токен повторно нельзя. «Перевыпустить токен» (владелец бота или
  `MANAGE_BOTS` домашнего пространства) выдаёт новый и сразу гасит старый; «Отозвать» — гасит без нового.
  Отозванный/перевыпущенный токен: REST → `401`, gateway закрывается с `4010`, бот выходит из звонков.
- Один токен — одно «устройство» gateway: второй процесс с тем же токеном вытесняет первый (сокет первого
  закрывается с `4000 replaced by a new session`). Запускайте один процесс на токен.
- Боту **закрыты** пользовательские эндпоинты (`403 FORBIDDEN`, `reason: "BOT_NOT_ALLOWED"`): сессии, пароль, почта,
  подтверждение, статус и настройки профиля, заметки, создание/поиск/вступление в пространства, поиск аккаунта по
  почте и прямое добавление, гостевые ссылки комнат, уведомления, архив DM, превью ссылок, повтор/удаление записей,
  суперадминка, управление ботами, фоны камеры пространства (`/api/workspaces/{id}/backgrounds…`, ADR-0035 — у бота
  нет камеры). Приглашения в пространство, календарь, бейджи, звуки, решение по гостям и старт/стоп записи с
  ADR-0051 открыты по тем же битам, что людям (см. таблицу ниже).
- Бот видит только то, что разрешает `VIEW_ROOM` / `VIEW_BOARD`; закрытые комнаты и доски (ADR-0029, ADR-0048) действуют и на ботов:
  бот попадает в них только по переопределению на самом объекте (лично или через роль), иначе — 404, как людям.
- Биты пространства из ADR-0048 бот получает, как человек, через свои роли: `MANAGE_MEMBERS` — исключать и банить,
  `CREATE_BOARDS` — создавать доски, `VIEW_JOURNALS` — журнал доски, `MANAGE_EVENTS` — чужие встречи,
  `MANAGE_RECORDINGS` — запись встреч; управление ботами, настройки телефонии,
  GPTunneL и журнал звонков боту закрыты (`403 BOT_NOT_ALLOWED`), даже с `MANAGE_BOTS` / `MANAGE_INTEGRATIONS` /
  `VIEW_JOURNALS`.
- Человек может «Заблокировать бота» — тогда бот не может писать ему в DM (`403 BOT_BLOCKED`).
- Звонки один на один (ADR-0034) ботам недоступны: бот не звонит и не принимает (`POST /api/dms/{id}/call`, `/api/calls/…` — `403 BOT_NOT_ALLOWED`), позвонить боту нельзя.
- «Заметки» (личные полки, ADR-0039) ботам недоступны: `/api/notes*` — `403 BOT_NOT_ALLOWED`; чужую полку бот не видит (`404`).
- Webhook-секрет храните отдельно от токена; проверяйте подпись каждой доставки (см. [Webhook](#webhook)).

## REST

База — адрес приложения (`https://app.calab.io` или ваш `https://<APP_HOST>`). Тела запросов и ответов — proto-сообщения
в JSON (protojson): поля в lowerCamelCase, enum — полными именами (`"ROOM_TYPE_VOICE"`), `uint64` — строками, время —
RFC 3339; поля со значениями по умолчанию в ответе присутствуют, неизвестные поля в запросе игнорируются. Ошибка —
`ApiError { code, message, field?, reason?, used?, limit? }`.

```sh
export CALAB=https://app.calab.io
export TOKEN=calab_bot_…
curl -s $CALAB/api/bots/me -H "Authorization: Bearer $TOKEN"
```
```json
{"bot": {"user": {"id": "0192…", "displayName": "Echo", "isBot": true, "…": "…"},
         "username": "echo", "ownerUserId": "0191…", "workspaceId": "0191…", "description": "",
         "commands": [{"name": "echo", "description": "Повторить текст"}], "tokenPrefix": "Qx3v9a",
         "createdAt": "2026-09-27T10:00:00Z", "webhook": {"url": "", "enabled": false, "…": "…"}}}
```

### Эндпоинты, открытые боту

Всё ниже — «по правам»: сервер проверяет права бота так же, как права человека. Полная таблица маршрутов с
решением для ботов — `apps/server/internal/app/botroutes.go`.

| Метод и путь | Что делает | Права |
|---|---|---|
| `GET /api/me` | аккаунт бота (`me.user.isBot = true`) | — |
| `PATCH /api/me` | только `displayName`, `avatarFileId` | — |
| `POST /api/me/avatar` | аватар (multipart `file`) | — |
| `POST /api/workspaces/{id}/bots/{botId}/avatar` | аватар бота из интерфейса «Боты» (docs/09 #87): multipart `file`, как `POST /api/me/avatar` (не картинка — 422) → `{bot}`; боту — 403 `BOT_NOT_ALLOWED` | люди: владелец бота или `MANAGE_BOTS` домашнего пространства |
| `DELETE /api/workspaces/{id}/bots/{botId}/avatar` | убрать аватар бота → `{bot}`; бот не участник `{id}` — 404, не домашнее пространство — 403 | то же |
| `GET /api/bots/me` · `PATCH /api/bots/me` | профиль бота: `{displayName?, description?}` | только боты |
| `PUT /api/bots/me/commands` | заменить список команд `{commands: [{name, description}]}` | только боты |
| `GET · PUT · DELETE /api/bots/me/webhook` | webhook `{url, secret}` | только боты |
| `GET /api/workspaces` · `GET /api/workspaces/{id}` | пространства бота | участник |
| `GET /api/workspaces/{id}/members` | участники (`WorkspaceMember`, у ботов `user.isBot`) | участник |
| `GET /api/workspaces/{id}/members/{userId}` | профиль участника (ADR-0051; `@me` — сам бот) → `{member, openTasks}`: имя, ник, роли, бейдж, статус, часовой пояс, день рождения (скрытый не отдаётся), открытые задачи, где он исполнитель, — только с досок, которые видит бот (≤ 50). SDK `bot.members.get` | участник |
| `PATCH /api/workspaces/{id}/members/{userId} {nickname}` | переименовать участника (ник в пространстве; `""` — снять). SDK `bot.members.setNickname` | `MANAGE_NICKNAMES` |
| `GET /api/workspaces/{id}/badges` | бейджи участников (docs/09 #82): `WorkspaceMember.badge_id` ссылается на них | участник |
| `POST /api/workspaces/{id}/badges {name, fileId}` · `PATCH · DELETE …/badges/{badgeId}` | библиотека бейджей; картинка — своя загрузка бота в это пространство (PNG/WebP/JPEG ≤ 128 КБ). SDK `bot.badges.create/update/delete` | `MANAGE_MEMBERS` |
| `PUT /api/workspaces/{id}/members/{userId}/badge {badgeId}` | выдать / снять (`""`) бейдж; цель — не бот и ниже старшей роли бота. SDK `bot.badges.set` | `MANAGE_NICKNAMES` |
| `GET · POST /api/workspaces/{id}/invites` · `DELETE …/invites/{inviteId}` | ссылки-приглашения в пространство `{maxUses, expiresInSeconds}`. SDK `bot.invites.list/create/delete` | `INVITE_MEMBERS` |
| `GET · POST /api/workspaces/{id}/invites/email` · `DELETE …/invites/email/{inviteId}` | приглашение по почте `{email}`: письмо «Пространство (от имени бота X)», тот же адрес — не чаще раза в сутки; пригласить админом — только владелец. SDK `bot.invites.email/listEmail/deleteEmail` | `INVITE_MEMBERS` |
| `GET /api/workspaces/{id}/rooms` · `GET /api/rooms/{id}` | комнаты, которые бот видит | `VIEW_ROOM` |
| `GET /api/workspaces/{id}/categories` | категории комнат | участник |
| `GET /api/rooms/{id}/messages?before=&after=&limit=` | история (новые первыми, `limit ≤ 100`) | `VIEW_ROOM` |
| `GET /api/rooms/{id}/messages/{messageId}` | одно сообщение, `Message` без обёртки (SDK `message(roomId, messageId)`) | `VIEW_ROOM` |
| `GET /api/rooms/{id}/recordings/{rid}/transcript` | полный сохранённый транскрипт (SDK `transcript(roomId, recordingId)`) | `VIEW_ROOM` |
| `POST /api/rooms/{id}/messages` | сообщение `{content, attachmentIds, replyToId, nonce, stickerId}` → 201 | `SEND_MESSAGES` (+ `ATTACH_FILES`) |
| `PATCH /api/messages/{id}` · `DELETE /api/messages/{id}` | правка своего / удаление | автор или `MANAGE_MESSAGES` |
| `POST /api/rooms/{id}/messages/{mid}/forward` | пересылка `{toRoomId}` → 201 `{message}` с `forward` (ADR-0033; SDK `forward(roomId, messageId, toRoomId)`) | `VIEW_ROOM` в источнике, `SEND_MESSAGES` в цели |
| `PUT · DELETE /api/messages/{id}/reactions/{emoji}` | реакция (emoji в URL-кодировке) → 204 | `SEND_MESSAGES` |
| `PUT · DELETE /api/messages/{id}/pin` · `GET /api/rooms/{id}/pins` | закрепы | `MANAGE_MESSAGES` / `VIEW_ROOM` |
| `PUT /api/rooms/{id}/read` | отметка прочтения (не даёт людям ✓✓ «Прочитано»; `READ_RECEIPT` ботам не приходит) | `VIEW_ROOM` |
| `GET /api/workspaces/{id}/messages/search?q=` · `GET /api/me/mentions` | поиск, упоминания бота | `VIEW_ROOM` |
| `POST /api/workspaces/{id}/files` · `POST /api/dms/{id}/files` | загрузка файла (multipart `file`) → `{file}` | `ATTACH_FILES` |
| `GET /api/files/{id}` · `GET /api/files/{id}/thumbnail` | скачать файл | доступ к комнате |
| `POST /api/dms {userId}` · `GET /api/dms` · `GET /api/dms/candidates` | DM с участником общего пространства | не заблокирован |
| `GET /api/rooms/{id}/bot-commands` | команды ботов комнаты | `VIEW_ROOM` |
| `POST /api/rooms/{id}/join` · `POST /api/rooms/{id}/voice/leave` | голос: `{url, token, …}` / выход | `CONNECT` |
| `POST /api/rooms/{id}/stream/request` · `…/camera/request` · `…/camera/stop` | стрим экрана, камера | `STREAM` / `VIDEO` |
| `PATCH /api/voice/self` · `PATCH /api/rooms/{id}/voice-status` | своё mute/deafen, статус звонка | в звонке |
| `POST /api/rooms/{id}/voice/{userId}/mute · unmute · disconnect · move · stop-stream · stop-camera · allow-camera` | модерация голоса | `MUTE_MEMBERS` / `MOVE_MEMBERS` |
| `GET /api/rooms/{id}/admissions` · `POST /api/rooms/{id}/admissions/{userId} {status, displayName?, badgeId?}` | гости, ожидающие подтверждения входа (ADR-0040), и решение по ним: `ROOM_ADMISSION_STATUS_ADMITTED` / `…_DECLINED` (ADR-0051) | `INVITE_GUESTS` в комнате |
| `POST /api/rooms/{id}/recording/start` · `…/recording/stop` | запись встречи (ADR-0025): в звонке комнаты кто-то есть, `allowRecording`, пространство подключено к GPTunneL. SDK `bot.recording.start/stop` | `VIEW_ROOM` + `CONNECT` и **`MANAGE_RECORDINGS`** (для ботов, ADR-0051) |
| `POST /api/rooms/{id}/calls {number}` · `DELETE /api/rooms/{id}/calls/{callId}` | телефония (ADR-0046): позвонить на номер из звонка комнаты — абонент входит в комнату участником `sip:<callId>`; положить свою линию (чужую — с `MUTE_MEMBERS`). Статусы — событие `sipCallUpdate`. Лимит — 20 звонков в час на пространство (`429 SIP_RATE_LIMITED`). Настройки SIP и журнал — 403 `BOT_NOT_ALLOWED`. Только тариф Business: ниже — `409 PLAN_LIMIT` (положить линию можно всегда) | `PLACE_CALLS`, бот в звонке комнаты, телефония включена |
| `GET /api/workspaces/{id}/events?from=&to=` · `GET /api/events/{id}` | календарь (ADR-0038): встречи, которые бот организует, и встречи видимых ему комнат; адреса внешних участников — только если бот может править встречу. SDK `bot.calendar.list/get` | `VIEW_ROOM` |
| `POST /api/workspaces/{id}/events` | создать встречу (ADR-0051): **бот — организатор, но не участник** (себя в `attendees` — 422); письма и `invite.ics` участникам уходят от системного адреса «Пространство (от имени бота X)», без `Reply-To` и без гостевых ссылок комнаты — внешние получают ссылку на страницу встречи. SDK `bot.calendar.create` | не гость; комната — видимая голосовая |
| `PATCH · DELETE /api/events/{id}[?occurrence=]` | изменить / отменить встречу (или одно вхождение серии). SDK `bot.calendar.update/delete` | свою; чужую — `MANAGE_ROOM` в её комнате или `MANAGE_EVENTS` (внешние адреса в чужую встречу — 403) |
| `GET /api/workspaces/{id}/freebusy?users=&from=&to=` · `POST …/freebusy/suggest` | свободно/занято и подбор времени (ADR-0041): боту — только «занято» (без названий и участников внешних событий). SDK `bot.calendar.freebusy/suggest` | не гость |
| `PUT /api/events/{id}/rsvp`, `GET /api/me/events/today`, CalDAV (`/api/me/caldav…`, `/api/me/external-events`) | 403 `BOT_NOT_ALLOWED`: бот не участник встреч и не держит внешний календарь | — |
| доски задач (ADR-0042): `GET /api/workspaces/{id}/boards`, `GET /api/boards/{id}`, `GET/POST /api/boards/{id}/tasks`, `GET/PATCH /api/tasks/{id}`, `PUT /api/tasks/{id}/assignees`, `GET /api/workspaces/{id}/tasks/search?q=`, `GET /api/t/{KEY-N}`, `GET /api/me/tasks`, статусы/лейблы/вехи/виды, архив задач | бот работает как человек — по битам доски своих ролей и переопределений (бота можно назначить исполнителем и дать ему доступ к приватной доске лично); комментарий — сообщение в `task.roomId`. Доступ к доске (`PUT …/permissions`) и удаление навсегда (`DELETE …?purge=1`) — 403 `BOT_NOT_ALLOWED`. SDK: `bot.boards.list/get`, `bot.tasks.list/search/get/create/update/setAssignees/comment` | `VIEW_BOARD` / `CREATE_TASKS` / `EDIT_TASKS` / `MANAGE_BOARD` |
| доски 2.0 (ADR-0058): `GET/POST /api/workspaces/{id}/board-categories`, `PATCH/DELETE /api/board-categories/{id}`, `PUT /api/workspaces/{id}/boards/order`, `PATCH /api/boards/{id} {setDisabledFeatures, disabledFeatures, estimateScale}`, чек-листы: `POST /api/tasks/{id}/checklists`, `PATCH/DELETE /api/checklists/{id}`, `POST /api/checklists/{id}/items`, `PATCH/DELETE /api/checklist-items/{id}`, `POST /api/checklist-items/{id}/convert` | категории — `CREATE_BOARDS`, положить доску и фичи — `MANAGE_BOARD`, чек-листы — как поля задачи (`EDIT_TASKS`; `CREATE_TASKS` — свои и назначенные); чек-листы — с тарифа Team (`409 PLAN_LIMIT`). Фича доски выключена → запрос, **меняющий** её поле на непустое, — `409 CONFLICT`, `reason FEATURE_DISABLED`, `field` = имя поля (`estimate`, `dueOn`, `approverIds`…); сброс в пусто и повтор текущего значения проходят. Вебхук доски (`/api/boards/{id}/webhook*`) — только люди, боту `403 BOT_NOT_ALLOWED`. SDK: `bot.boards.categories.*`, `bot.boards.setFeatures`, `bot.tasks.checklists.*` | см. слева |
| `GET /api/workspaces/{id}/sounds` · `POST /api/rooms/{id}/sounds/play {soundId}` | саундборд (ADR-0036): список звуков; проиграть звук всем в звонке (`builtin:<имя>` или id звука; 1 в 2 с на бота, 5 в 10 с на комнату) | бот в звонке комнаты |
| `POST /api/workspaces/{id}/sounds` · `PATCH · DELETE …/sounds/{soundId}` | библиотека звуков (ADR-0051): клип — своя загрузка бота в это пространство | `MANAGE_STICKERS` |
| стикеры: `GET/POST /api/workspaces/{id}/sticker-packs`, `/api/sticker-packs/{id}…`, `/api/stickers/{id}`, `/api/me/sticker-packs…` | см. [Стикеры](#стикеры-по-api) | участник / `MANAGE_STICKERS` |
| комнаты, категории, роли, участники, баны (`POST/PATCH/DELETE …`) | управление пространством | `MANAGE_ROOM`, `MANAGE_ROLES`, `MANAGE_MEMBERS` (исключить, бан, встроенная роль, назначить роли — ADR-0048), `MANAGE_WORKSPACE` (настройки), … |

**Остаются только для людей** (403 `BOT_NOT_ALLOWED`, ADR-0051): удаление пространства; управление ботами (создать, токены,
аватар — какой бы бит ни был у бота); настройки SIP, GPTunneL, веб-приложения пространства; суперадминка; голос в
согласовании задач; RSVP, CalDAV, «сегодня»; поиск аккаунта по почте и прямое добавление аккаунта
(`invites/lookup`, `POST …/members`); гостевые ссылки комнат; таблица и правка дней рождения; доступ к доске;
удаление и перезагрузка записей; фоны камеры, заметки, звонки DM, пароль, почта, сессии.

**Бот с административными правами — это администратор.** Токен бота, роли которого дают `MANAGE_*`, `INVITE_*` или
`VIEW_JOURNALS`, действует как администратор с этими правами: храните его как пароль администратора, при подозрении
на утечку — «Перевыпустить токен». Редактор ролей предупреждает, если такие права получает роль, которая есть у
ботов. Каждое административное действие бота сервер пишет в журнал (`bot action`: маршрут, статус, бот и его
владелец). Закрытые комнаты и доски (ADR-0048 «без администраторов») бот видит только по переопределению на них.

### Ответы на сообщения и транскрипты встреч

`GET /api/rooms/{id}/messages/{messageId}` возвращает **HTTP 200 и сам `calaba.v1.Message`**,
без `{message: …}` или `{messages: […]}`. Поля и детали совпадают с элементом истории:
`id`, `roomId`, `authorId`, `content`, `replyToId`, `attachments`, `reactions` (`me` относительно
вызывающего), времена, `kind`, `system`, `sticker`, `forward`. `command` не задан, как во всех REST-ответах.
У карточки записи `kind: "MESSAGE_KIND_SYSTEM"` и `system.recording.recordingId`; последний id
нужен для URL транскрипта. В команде, отправленной ответом на карточку, `replyToId` содержит id
**сообщения** с карточкой, а не id записи.

`404 NOT_FOUND`: комната недоступна, сообщение отсутствует/удалено, относится к другой комнате
или находится на/до границы очищенной истории DM вызывающего. У второго участника DM история
остаётся своей. Для чтения не нужны `SEND_MESSAGES` или подключение к голосу.

`GET /api/rooms/{id}/recordings/{rid}/transcript` возвращает **HTTP 200** и существующий
`GetRecordingTranscriptResponse` целиком, без пагинации:

```json
{"recordingId":"0192a100-0000-7000-8000-000000000001","language":"ru","segments":[{"speaker":0,"startMs":480,"endMs":6900,"text":"Первая реплика."},{"speaker":-1,"startMs":7200,"endMs":12050,"text":"Неизвестный спикер."}]}
```

`startMs` / `endMs` — JSON-числа, миллисекунды от начала записи; `speaker` — номер спикера
распознавания от нуля или `-1`, если неизвестен. `language` может быть пустым. `404 NOT_FOUND`:
комната недоступна, запись отсутствует/удалена, транскрипт ещё не сохранён или в комнате нет
ни самой записи, ни живой пересланной копии её карточки (ADR-0033). В URL используйте `roomId`
видимой карточки, в том числе пересланной. Удаление последней копии отзывает доступ к транскрипту
через неё. Право `VIEW_ROOM` открывает боту **весь** сохранённый транскрипт, доступный через эту
комнату, с учётом ограниченных комнат. Управление записью это право боту не открывает (старт/стоп — с
`MANAGE_RECORDINGS`, ADR-0051).

### Примеры

Отправить сообщение (`nonce` — ключ идемпотентности: повтор с тем же `nonce` вернёт то же сообщение с `200`):

```sh
curl -s -X POST $CALAB/api/rooms/$ROOM/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content": "Привет! Я бот.", "nonce": "hello-1"}'
```
```json
{"message": {"id": "0192a1…", "roomId": "0191f0…", "authorId": "0192…", "content": "Привет! Я бот.",
             "attachments": [], "replyToId": "", "nonce": "hello-1", "createdAt": "2026-09-27T10:01:02.345Z",
             "reactions": [], "kind": "MESSAGE_KIND_UNSPECIFIED", "…": "…"}}
```

Файл: сначала загрузить, потом приложить `attachmentIds`:

```sh
curl -s -X POST $CALAB/api/workspaces/$WS/files -H "Authorization: Bearer $TOKEN" -F file=@report.pdf
# {"file": {"id": "0192b3…", "name": "report.pdf", "mime": "application/pdf", "size": "48213", "url": "/api/files/0192b3…", …}}
curl -s -X POST $CALAB/api/rooms/$ROOM/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content": "Отчёт", "attachmentIds": ["0192b3…"], "nonce": "rep-1"}'
```

Реакция, ответ, DM:

```sh
curl -s -X PUT "$CALAB/api/messages/$MSG/reactions/%F0%9F%91%8D" -H "Authorization: Bearer $TOKEN"   # 👍 → 204
curl -s -X POST $CALAB/api/rooms/$ROOM/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"content\": \"Готово\", \"replyToId\": \"$MSG\", \"nonce\": \"r-1\"}"
curl -s -X POST $CALAB/api/dms -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"userId\": \"$USER\"}"      # → {"dm": {"room": {"id": "…", "type": "ROOM_TYPE_DM", …}, "peer": {…}}}
```

Комнаты и участники:

```sh
curl -s $CALAB/api/workspaces -H "Authorization: Bearer $TOKEN"              # {"workspaces": [{"id", "name", …}]}
curl -s $CALAB/api/workspaces/$WS/rooms -H "Authorization: Bearer $TOKEN"    # {"rooms": [{"id", "type": "ROOM_TYPE_TEXT", "name", …}]}
curl -s $CALAB/api/workspaces/$WS/members -H "Authorization: Bearer $TOKEN"  # {"members": [{"user": {…}, "role": "WORKSPACE_ROLE_MEMBER", "roleIds": […]}]}
curl -s $CALAB/api/workspaces/$WS/members/$USER -H "Authorization: Bearer $TOKEN"  # {"member": {…}, "openTasks": [{"key": "FNG-12", …}]}
curl -s -X PATCH $CALAB/api/workspaces/$WS/members/$USER -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"nickname": "Боря (продажи)"}'      # MANAGE_NICKNAMES → {"member": {…}}
```

Календарь и приглашения (ADR-0051):

```sh
# встреча в голосовой комнате: бот — организатор, Боб и внешний адрес — участники
curl -s -X POST $CALAB/api/workspaces/$WS/events -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"title\": \"Планёрка\", \"roomId\": \"$VOICE\", \"startsAt\": \"2026-10-02T09:00:00Z\", \"endsAt\": \"2026-10-02T09:30:00Z\",
       \"tz\": \"Europe/Moscow\", \"attendees\": [{\"userId\": \"$USER\", \"required\": true}, {\"email\": \"partner@example.com\"}]}"
# → 201 {"event": {"id": "…", "organizerId": "<id бота>", "canEdit": true, "attendees": [...], …}}
curl -s "$CALAB/api/workspaces/$WS/freebusy?users=$USER&from=2026-10-02T00:00:00Z&to=2026-10-03T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN"   # {"users": [{"userId", "timezone", "workHours", "busy": [{"startsAt", "endsAt", "kind"}]}]}
curl -s -X POST $CALAB/api/workspaces/$WS/invites -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"maxUses": 1, "expiresInSeconds": 86400}'   # INVITE_MEMBERS → 201 {"invite": {"code": "…"}}; ссылка https://<APP_HOST>/join/<code>
```

```js
const ev = await bot.calendar.create(wsId, { title: 'Планёрка', roomId, startsAt: timestampFromDate(start), endsAt: timestampFromDate(end),
  attendees: [{ userId, required: true }] });          // import { timestampFromDate } from '@bufbuild/protobuf/wkt'
const { member, openTasks } = await bot.members.get(wsId, userId);
await bot.members.setNickname(wsId, userId, 'Боря');
const invite = await bot.invites.create(wsId, { maxUses: 1 });
```

## Gateway: события в реальном времени

`wss://<APP_HOST>/gateway?v=1` — один сокет на бота. Кадры — `GatewayFrame { op, seq, oneof payload }`: бинарный
protobuf по умолчанию; с `?encoding=json` — текстовые protojson-кадры (удобно без protobuf-библиотеки).

1. Сервер: `HELLO { heartbeatIntervalMs }` (~41 с).
2. Бот: `IDENTIFY { token: "<токен бота>", device: {name, platform, appVersion} }`.
3. Сервер: `DISPATCH READY` (`seq = 1`): `sessionId`, `me`, `workspaces[]` (для каждого: пространство, видимые
   комнаты, участники, роли, голосовые состояния, присутствие, права бота по комнатам), `dms[]`, `readStates`.
4. Дальше — `DISPATCH` с событиями и растущим `seq`; бот шлёт `HEARTBEAT { lastSeq }` каждые `heartbeatIntervalMs`
   (сервер отвечает `HEARTBEAT_ACK`). Нет heartbeat дольше 2 × интервал + 10 с → `4009`.

JSON-кадры (`?encoding=json`):

```json
→ {"op": "GATEWAY_OPCODE_IDENTIFY", "identify": {"token": "calab_bot_…", "device": {"name": "my-bot", "platform": "linux", "appVersion": "1.0"}}}
← {"op": "GATEWAY_OPCODE_DISPATCH", "seq": "1", "dispatch": {"ready": {"sessionId": "…", "me": {"user": {"id": "…", "isBot": true, …}}, "workspaces": […], "dms": […]}}}
← {"op": "GATEWAY_OPCODE_DISPATCH", "seq": "2", "dispatch": {"messageCreate": {"workspaceId": "…", "message": {"id": "…", "content": "/echo hi", "command": {"botUserId": "…", "name": "echo", "args": "hi"}, …}}}}
→ {"op": "GATEWAY_OPCODE_HEARTBEAT", "heartbeat": {"lastSeq": "2"}}
```

**События** (поле `DispatchEvent.event`; бот получает только то, что видит по `VIEW_ROOM`):

| Событие | Когда |
|---|---|
| `ready` · `resumed` | после IDENTIFY · после успешного RESUME |
| `messageCreate` · `messageUpdate` · `messageDelete` | сообщения комнат и DM бота (включая его собственные) |
| `messageReactionAdd` · `messageReactionRemove` | реакции |
| `voiceStateUpdate` · `voiceStreamStart/Stop` · `voiceCameraStop` · `voiceMoved` | голос: кто в какой комнате, mute, стримы |
| `presenceUpdate` · `userUpdate` | присутствие и профили |
| `roomCreate/Update/Delete` · `roomPermissionsUpdate` · `categoryCreate/Update/Delete` | комнаты |
| `workspaceCreate/Update/Delete` · `workspaceMemberAdd/Update/Remove` · `roleCreate/Update/Delete` | пространства, участники, роли |
| `dmCreate` | новый DM с ботом |
| `typingStart` | «печатает» — только для комнат из `SUBSCRIBE { roomIds }` |
| `stickerPackCreate/Update/Delete` | стикерпаки пространства |
| `soundCreate/Update/Delete` · `soundPlay` | саундборд пространства; `soundPlay` — только пока бот в звонке комнаты |
| `botCreate/Update/Delete` | боты пространства — только при `MANAGE_BOTS` (ADR-0048) |
| `sipCallUpdate` | телефонный звонок комнаты начат или сменил статус (ADR-0046) |
| `eventCreate/Update/Delete` · `eventRsvp` | встречи: свои (бот — организатор) и встречи видимых комнат; адреса внешних — только если бот может править встречу |
| `boardCreate/Update/Delete` · `taskCreate/Update/Delete` · `taskActivity` | доски и задачи — по `VIEW_BOARD` бота |

Боту доступны и исходящие опкоды `TYPING { roomId }` («печатает», не чаще раза в 3 с на комнату),
`SUBSCRIBE { roomIds }` (≤ 100) и `PRESENCE_UPDATE`.

**Переподключение и resume.** Обрыв → переподключитесь с экспоненциальной задержкой (1 → 30 с, со случайным
разбросом) и пошлите `RESUME { token, sessionId, seq }` (последний обработанный `seq`). Сервер дошлёт пропущенное
(буфер ≈ 5 мин / 1000 событий) и `RESUMED { replayed }`. Если сессию восстановить нельзя — `INVALID_SESSION
{ resumable: false }`: в том же сокете через 1–5 с пошлите `IDENTIFY` и получите новый `READY`. `RECONNECT` — сервер
просит переподключиться (деплой). События с `seq ≤` последнего обработанного пропускайте.

| Закрытие | Что делать |
|---|---|
| `4000` (кроме `replaced by a new session`), `4001`, `4002`, `1006` | переподключиться, `RESUME` |
| `4000 replaced by a new session` | тот же токен подключил другой процесс — не переподключаться |
| `4003`, `4007`, `4009` | переподключиться, новый `IDENTIFY` |
| `4004` | неверный токен — не переподключаться |
| `4008` | лимит (флуд, переполнена очередь 256 кадров) — backoff, `RESUME` |
| `4010` | токен отозван / бот удалён — не переподключаться |

Лимиты сокета: кадр ≤ 64 КиБ; входящих `TYPING`/`SUBSCRIBE`/`PRESENCE_UPDATE` — не больше 10 подряд и 2/с (лишние
отбрасываются), > 50 кадров/с устойчиво → `4008`. SDK делает всё это сам.

## Команды

- Бот регистрирует команды: `PUT /api/bots/me/commands` `{commands: [{name, description}]}` — полная замена, ≤ 100,
  имя `[a-z0-9_]{1,32}` (ведущий `/` снимается), описание ≤ 256 символов. Композер показывает их по `/`
  (`GET /api/rooms/{id}/bot-commands`), участники видят их в профиле бота.
- Сообщение, начинающееся с `/name` или `/name@username` (дальше пробел или конец текста), всем приходит обычным
  сообщением, а адресованному боту `messageCreate` несёт `message.command { botUserId, name, args }`
  (`name` в нижнем регистре, `args` — остаток текста без пробелов по краям).
- `/name@username` — этому боту, если он видит комнату (регистрировать команду не обязательно). `/name` — единственному
  боту комнаты, зарегистрировавшему `name`; если таких несколько — это не команда (пишите `@username`).
- В DM с ботом `/name` адресовано ему. Сообщения ботов командами не считаются (нет петель бот ↔ бот).
- `command` есть только в событиях (gateway, webhook); в REST-ответах и истории его нет.
- Упоминание бота — обычное упоминание: в тексте `@<id бота>`; `GET /api/me/mentions` — сообщения с упоминаниями бота.

```js
bot.on('command', async (c) => {
  if (c.name === 'roll') await bot.reply(c, String(1 + Math.floor(Math.random() * Number(c.args || 6))));
});
```

## Webhook

Вместо (или вместе с) gateway сервер может сам присылать события боту по HTTPS — удобно для serverless.

- Включить: `PUT /api/bots/me/webhook {url, secret}` — `url` только `https://` на публичный адрес (частные сети,
  `localhost`, IP из приватных диапазонов запрещены), `secret` 16..256 символов. Ответ — `BotWebhookResponse
  { webhook: {url, enabled, disabledAt, failingSince, lastOkAt, lastError, pending} }`; `GET` — текущее состояние,
  `DELETE` → 204 (очередь сбрасывается).
- Что доставляется: `messageCreate/Update/Delete` и `messageReactionAdd/Remove` комнат, которые бот видит, и его DM —
  кроме его собственных сообщений и реакций. Команды — так же, как в gateway (`message.command`). С ADR-0051 ещё
  `taskCreate/Update/Delete` и `taskActivity` видимых досок, `eventCreate/Update/Delete` и `eventRsvp` (как в gateway,
  адреса внешних — только боту, который может править встречу) и `workspaceMemberUpdate`.
- Запрос: `POST <url>`, `Content-Type: application/json`, `User-Agent: CalabBot-Webhook/1.0`, тело —
  `BotWebhookUpdate { id, botUserId, createdAt, event: DispatchEvent }` (protojson), заголовки
  `X-Calab-Delivery: <id>` и `X-Calab-Signature: sha256=<hex HMAC-SHA256(secret, тело)>`.
- Успех — любой `2xx` за 10 с; редиректы не выполняются (это ошибка). Ретраи: 1 мин, 2, 4 … до 1 ч между попытками,
  доставка живёт сутки. Webhook, падающий сутки подряд, **отключается** (`webhook.disabledAt`, очередь сброшена,
  владельцу бота и управляющим — `BOT_UPDATE`); `PUT` включает снова.
- Порядок не гарантирован, повторы возможны — дедуплицируйте по `id`. Отвечайте быстро, работу делайте после ответа.

```json
{"id": "0192c4…", "botUserId": "0192…", "createdAt": "2026-09-27T10:05:00Z",
 "event": {"messageCreate": {"workspaceId": "0191…", "message": {"id": "0192c3…", "roomId": "…", "authorId": "…",
   "content": "/ping", "command": {"botUserId": "0192…", "name": "ping", "args": ""}, "…": "…"}}}}
```

Проверка подписи (считайте HMAC от **сырых байтов** тела, не от пересобранного JSON):

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

В SDK: `new Bot(token, { server, webhookSecret })` и `bot.handleWebhook(rawBody, headers)` — проверит подпись,
отбросит повтор и выдаст те же события `message` / `command` / `reaction`, что и gateway.

## Вебхук доски

(ADR-0058.) Доска сама присылает JSON на ваш HTTPS-адрес, когда что-то меняется в её задачах. Это отдельный механизм от
[вебхука бота](#webhook): один вебхук на доску, все изменения задач, без выбора событий.

- **Кто настраивает.** Только люди (боту `403 BOT_NOT_ALLOWED`: в нём секрет и вывод данных наружу): `MANAGE_BOARD` на доске
  **и** `MANAGE_INTEGRATIONS` пространства, тариф **Business** (ниже — `409 CONFLICT`, `reason PLAN_LIMIT`).
  Вебхук принадлежит доске, а не создателю: его видит и меняет любой, у кого есть `MANAGE_BOARD`.
- **Маршруты.** `PUT /api/boards/{id}/webhook {url, secret?}` — создать, заменить или включить заново отключённый;
  `url` — только `https://` на публичный адрес, `secret` 16..256 символов; пустой — сервер сгенерирует 32 случайных байта
  (base64url) и вернёт `secret` **один раз** в ответе. `GET` — состояние (`url`, `hasSecret`, `enabled`, `disabledAt`,
  `failingSince`, `lastOkAt`, `lastError`, `pending`, `pausedReason`); секрет не отдаётся никогда. `DELETE` → 204 (очередь
  помечается `failed`). `POST …/webhook/ping` — синхронно шлёт событие `ping` тем же способом →
  `{ok, status, error}`, не чаще раза в 10 с (`429`).
- **События** (`type`): `task.created`, `task.updated` (любое изменение: поля, статус, исполнители, связи, вложения,
  согласования, чек-листы), `task.archived`, `task.restored` (автоархив — `actor: null`), `task.moved_in` (доска-получатель;
  задача уже с новым ключом), `task.moved_out` (доска-источник), `task.comment.created`, `task.comment.updated`,
  `task.comment.deleted`, `ping`. Изменения одной транзакции — одно событие, список `changes` — записи журнала задачи
  (`field` = `kind` журнала: `status`, `assignees`, `checklist` …; `before` / `after` — их данные).
- **Запрос.** `POST <url>`, `Content-Type: application/json`, `User-Agent: Calab-Webhook/1.0`, заголовки:

  | Заголовок | Значение |
  |---|---|
  | `X-Calab-Webhook-Version` | `1` (контракт меняется только добавлением полей) |
  | `X-Calab-Event` | `type` события |
  | `X-Calab-Delivery` | id доставки (= `id` в теле) |
  | `X-Calab-Timestamp` | unix-секунды отправки |
  | `X-Calab-Signature` | `v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>` |

- **Подпись.** HMAC считается от строки `timestamp + "." + сырые байты тела`. Отвергайте запрос, если `|now − timestamp| > 5 минут`
  (защита от повтора), сравнивайте подпись за постоянное время. Боты остаются на `sha256=…` без timestamp.
- **Доставка.** At-least-once: повторы возможны, порядок доставки не гарантирован. **Идемпотентность** — по `id`
  (хранить виденные); **порядок** — по `sequence` (монотонен в пределах доски, начиная с 1; у `ping` — 0). Успех — любой
  `2xx` за 10 с, редиректы — ошибка. Ретраи: 1 мин, 2, 4 … до 1 ч, доставка живёт сутки; вебхук, падающий сутки подряд,
  **отключается** (`enabled: false`, очередь сброшена; `PUT` включает снова). Принимайте тело ≤ 256 КБ.
- **Паузы.** При понижении тарифа ниже Business вебхук не удаляется, а встаёт на паузу (`pausedReason = PLAN`): новые
  события не ставятся в очередь, после апгрейда доставка идёт с новых событий. Архивная доска — задачи только для чтения,
  событий нет, накопленная очередь дорабатывается.
- **Известный пробел.** События комментариев ставятся в очередь **после** коммита сообщения: если процесс упал ровно
  между ними, событие потеряно (редкое окно; события изменений задачи пишутся в той же транзакции и не теряются).

### Формат тела

`BoardWebhookEvent` в protojson, но с **именами полей из proto (snake_case)**, а не lowerCamelCase, как в REST. Каждое поле
присутствует: неустановленные — `null` (`actor: null` у изменений сервера, `edited_at: null`), пустые строки и списки — как
есть; `uint64` (например `size` вложения) — **строкой**, `sequence` — числом. `task` — задача без данных зрителя
(`subscribed`, `muted`, `unread`, `viewer_state` всегда в значениях по умолчанию), `attachments` и `checklists` всегда пусты
(счётчики `attachment_count`, `checklist_total/done` на месте);
`comment` — только у `task.comment.*`. Ссылка на задачу — `task_url`. Реальный пример (golden-фикстура
`apps/server/internal/boards/testdata/webhook_event.json`, поля по алфавиту; чтобы показать и `changes`, и `comment`, она
собрана вместе, у настоящего `task.updated` `comment` равен `null`):

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
    "id": "0192a000-0000-7000-8000-0000000000dd",
    "key": "FNG-12",
    "label_ids": [],
    "milestone_id": "",
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

`task.moved_out` несёт только то, что знала доска-источник: `task` содержит лишь `id`, прежний `key` и `board_id`
доски-источника, `changes` — одна запись `moved_board` с `before`; задача целиком (новый ключ, статусы и лейблы
получателя) приходит в `task.moved_in` доски-получателя.

### Проверка подписи

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody — сырые байты тела (Buffer), не пересобранный JSON; headers — заголовки запроса в нижнем регистре
export function verifyBoardWebhook(secret, rawBody, headers, now = Date.now() / 1000) {
  const ts = headers['x-calab-timestamp'];
  if (!ts || Math.abs(now - Number(ts)) > 300) return false; // replay: окно ±5 минут
  const want = Buffer.from('v1=' + createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex'));
  const got = Buffer.from(headers['x-calab-signature'] ?? '');
  return want.length === got.length && timingSafeEqual(want, got);
}
```

```python
import hashlib, hmac, time

def verify_board_webhook(secret: bytes, raw_body: bytes, headers: dict, now: float | None = None) -> bool:
    ts = headers.get("X-Calab-Timestamp", "")
    if not ts.isdigit() or abs((now or time.time()) - int(ts)) > 300:  # replay: окно ±5 минут
        return False
    mac = hmac.new(secret, ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest("v1=" + mac, headers.get("X-Calab-Signature", ""))
```

В SDK: `verifyBoardWebhook(secret, timestamp, body, signature)` из `@calaba/bot-sdk` (проверяет подпись и окно ±5 минут;
`parseBoardWebhookEvent(body)` разбирает тело).

## Голос через LiveKit

Медиа идёт напрямую через LiveKit (SFU) — наш REST его не проксирует. Бот в звонке — обычный участник: строка в
списке со значком «БОТ», индикатор речи, серверный mute/kick действуют как на человека, место в комнате считается.

1. `POST /api/rooms/{id}/join` (голосовая комната, право `CONNECT`) →
   `JoinVoiceResponse { url, token, identity, media, canSpeak, canStream, canVideo, pending }`.
   `token` — LiveKit-JWT на 10 мин с grant по правам бота: `SPEAK` → публикация микрофона, `STREAM` → демонстрация
   экрана (если свободен слот), `VIDEO` → камера (перед публикацией — `POST /api/rooms/{id}/camera/request`).
   Подключитесь сразу: без подключения за 15 с место освобождается.
2. Подключитесь LiveKit-клиентом по `url` + `token`: подпишитесь на аудио-треки участников, опубликуйте свой
   аудио-трек (Opus 48 кГц, источник «микрофон»).
3. Выход: отключитесь от LiveKit и вызовите `POST /api/rooms/{id}/voice/leave` (→ 204) — место освобождается сразу.

Кто в комнате — `voiceStates` в `READY` и события `voiceStateUpdate` (`roomId` пуст — вышел).

**Node** (`@livekit/rtc-node`, полный пример — [`examples/bots/voice-echo`](../examples/bots/voice-echo)):

```js
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind,
  TrackPublishOptions, TrackSource } from '@livekit/rtc-node';

const { url, token, canSpeak } = await bot.voice.join(roomId);
const room = new Room();
await room.connect(url, token, { autoSubscribe: true });
room.on(RoomEvent.TrackSubscribed, async (track, _pub, participant) => {
  if (track.kind !== TrackKind.KIND_AUDIO) return;
  for await (const frame of new AudioStream(track, 48000, 1)) {
    // frame.data — Int16Array, 10 мс PCM участника participant.identity
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

**Python** (`pip install livekit`, полный пример — [`examples/bots/python/voice_listen.py`](../examples/bots/python/voice_listen.py)):

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
        pcm = ev.frame.data            # memoryview int16

await room.connect(join["url"], join["token"])
# говорить: source = rtc.AudioSource(48000, 1); track = rtc.LocalAudioTrack.create_audio_track("bot", source)
# await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
```

Go: `livekit/server-sdk-go` (`lksdk.ConnectToRoomWithToken(url, token, callbacks)`). Синтез речи —
[`examples/bots/tts`](../examples/bots/tts).

## Стикеры по API

- Отправить стикер: `POST /api/rooms/{id}/messages {stickerId, nonce}` (пустой `content`, без вложений). Стикер должен
  быть из пака этого пространства (в DM — пространства, где оба участника не гости).
- Паки: `GET /api/workspaces/{id}/sticker-packs` → `{packs}`; `GET /api/me/sticker-packs` → `{installed, available}`;
  `PUT/DELETE /api/me/sticker-packs/{id}` — установить себе / убрать.
- Создавать и менять паки — при праве `MANAGE_STICKERS` у бота:
  ```sh
  curl -s -X POST $CALAB/api/workspaces/$WS/sticker-packs -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d '{"name": "Котики", "shortName": "cats"}'      # → 201 {"pack": {…}}
  curl -s -X POST $CALAB/api/sticker-packs/$PACK/stickers -H "Authorization: Bearer $TOKEN" \
    -F emoji=😺 -F file=@cat1.webp -F emoji=😿 -F file=@cat2.webp                        # → {"pack", "added": […]}
  ```
  Каждому `file` (WebP, стороны ≤ 512, ≤ 512 КБ статичный / ≤ 1 МБ анимированный) предшествует поле `emoji`; до 50
  за запрос, всё или ничего (`422`, `field: "file[i]"`), ≤ 120 в паке, лимиты тарифа `sticker_packs`/`stickers`
  (`409 PLAN_LIMIT`). `PATCH /api/sticker-packs/{id} {name?, shortName?, coverStickerId?, stickerIds}`,
  `PATCH /api/stickers/{id} {emoji}`, `DELETE /api/stickers/{id}`, `DELETE /api/sticker-packs/{id}`.

## Лимиты и ошибки

| Лимит | Значение |
|---|---|
| Запросы бота | 30/с (burst 30), env `BOT_RATE_PER_SEC` |
| Сообщения бота | 20/мин во всех комнатах и DM, env `BOT_MESSAGES_PER_MIN`; плюс общий 5 за 5 с на комнату |
| Новые DM | 10 сразу, 30/ч |
| Загрузки файлов | 30 сразу, 120/ч; размер и квота — по тарифу |
| Сообщение | ≤ 4000 символов, ≤ 20 вложений, `nonce` ≤ 64 |
| Команды | ≤ 100, имя ≤ 32, описание ≤ 256 |
| Ботов в пространстве | ключ тарифа `bots` (free 1, team 20); бот занимает и место участника (`members`, free 50) |
| Gateway | 1 сокет на токен, кадр ≤ 64 КиБ |

Все ошибки — `ApiError`. `code` — из `ErrorCode` (`ERROR_CODE_…`):

| HTTP | `code` / `reason` | Значит |
|---|---|---|
| 400 | `BAD_REQUEST` | кривой JSON / параметры |
| 401 | `UNAUTHENTICATED` | нет токена, неверный, отозван или перевыпущен |
| 403 | `FORBIDDEN`, `reason: "BOT_NOT_ALLOWED"` | эндпоинт только для людей |
| 403 | `FORBIDDEN` | нет права (`message` называет какое) |
| 403 | `BOT_BLOCKED` | человек заблокировал бота: новый DM и сообщения в DM с ним запрещены |
| 403 | `WORKSPACE_SUSPENDED` | пространство приостановлено: писать нельзя, читать можно |
| 404 | `NOT_FOUND` | нет такого объекта или он скрыт от бота |
| 409 | `CONFLICT`, `reason: "PLAN_LIMIT"` (`used`/`limit`) | лимит тарифа (боты, паки, стикеры) |
| 409 | `CONFLICT`, `reason: "REACTION_LIMIT"` | не больше 3 разных реакций на сообщение |
| 409 | `CONFLICT`, `reason: "FEATURE_DISABLED"` (`field`) | фича доски выключена, а запрос ставит её полю непустое значение |
| 409 | `CONFLICT`, `reason: "CHECKLIST_LIMIT"` / `"CHECKLIST_ITEM_LIMIT"` / `"BOARD_CATEGORY_LIMIT"` (`used`/`limit`) | ≤ 10 чек-листов в задаче, ≤ 100 пунктов в чек-листе, ≤ 50 категорий досок в пространстве |
| 409 | `ROOM_FULL` | голосовая комната заполнена |
| 413 | `FILE_TOO_LARGE`, `FILE_QUOTA_EXCEEDED`, `PAYLOAD_TOO_LARGE` | размер / квота |
| 422 | `VALIDATION` (`field`) | неверное значение поля |
| 429 | `RATE_LIMITED` + заголовок `Retry-After` (с) | подождите и повторите (с тем же `nonce`) |
| 503 | `UNAVAILABLE` | временная ошибка — повторите позже |

## FAQ

**Бот не видит комнату / сообщения.** Нет `VIEW_ROOM`: приватная комната, закрытая (только по переопределению на ней,
ADR-0048) или роль бота не даёт доступ. Проверьте роли и переопределения комнаты.

**Бот не отвечает на `/cmd`.** Команду никто не зарегистрировал или её зарегистрировали несколько ботов комнаты —
пишите `/cmd@username`. Сообщения ботов командами не считаются.

**Можно ли бота в другое пространство?** Да: админ того пространства добавляет его («Добавить бота» по ссылке
`/bots/<username>`). Управляют ботом (токен, удаление) в «домашнем» пространстве.

**Нужен ли gateway, если есть webhook?** Нет. Webhook-бот работает только через REST и webhook и считается «в сети»,
пока делает запросы. Голосовые события (`voiceStateUpdate`) приходят только через gateway.

**Два процесса с одним токеном?** Нет — второй вытеснит первого. Для масштабирования используйте webhook
(идемпотентная обработка по `id`) или несколько ботов.

**Бот слышит сам себя?** Нет: LiveKit не присылает участнику его же треки. Свои сообщения и реакции SDK по
умолчанию не отдаёт (`receiveOwn: true` — отдавать).

**Где типы?** `proto/calaba/v1/*.proto` — источник правды; `@calaba/protocol` (TS, protobuf-es) и Go-код генерируются
из него. Другим языкам — `buf generate` с нужным плагином или protojson «руками».

## Кнопки под сообщениями (ADR-0047)

`inlineKeyboard` доступна обычным сообщениям ботов. До 5 строк по 5 кнопок и 50
`allowedUserIds`; пустой список пользователей разрешает всем с правами. Кнопка:
уникальный `id` (1–64 ASCII буквы/цифры/`_`/`-`), `label` (1–80 символов без
управляющих), `data` (до 512 UTF-8 байт), `disabled`. Всё это публичные метаданные,
не место для секретов. Пересланная копия не получает активных кнопок.

```ts
const message = await bot.send(roomId, {
  text: 'Проверьте черновик',
  inlineKeyboard: {
    allowedUserIds: [authorId],
    rows: [{ buttons: [{ id: 'confirm', label: 'Подтвердить', data: 'draft:42:v3' }] }],
  },
});
await bot.edit(message.id, { inlineKeyboard: { rows: [] } }); // убрать, сохранить текст
// bot.edit(message.id, { text: 'Новый черновик', inlineKeyboard: nextKeyboard });
bot.on('callback', (callback) => {
  // Сохранить callback.id в своём inbox, проверить userId, messageId и актуальную
  // версию черновика перед внешним действием. Проверка автора обязательна.
});
```

REST `PATCH /api/messages/{id}`: отсутствие `inlineKeyboard` сохраняет кнопки, `{}`
удаляет. Для правки только кнопок передать `preserveContent:true` без `content`.
Флаг требует клавиатуру и запрещает непустой текст. Без него прежнее поведение:
отсутствующий/пустой `content` = пустой текст, допустимый только с вложениями.
SDK автоматически ставит флаг, когда в объекте edit нет `text`. Любая правка текста
или клавиатуры меняет серверную `keyboardRevision`.

Человек вызывает `POST /api/messages/{id}/interactions` с
`{buttonId, keyboardRevision, nonce}`. Нужны VIEW_ROOM + SEND_MESSAGES; сервер
проверяет живое сообщение, версию, кнопку, allowed users, активного бота и его доступ,
блокировку и очищенную историю DM. Без общего пространства старые DM-кнопки бота
не работают. Устаревшее/недоступное действие: 409 `KEYBOARD_STALE` /
`BUTTON_UNAVAILABLE`. Actor и data берутся с сервера; ботам маршрут запрещён.

200 `{interactionId}` означает **принято, не выполнено**. `botCallback` содержит
`id`, `botUserId`, `userId`, `workspaceId` (пусто в DM), `roomId`, `messageId`,
`buttonId`, `data`, `keyboardRevision`, `createdAt`. Доставка только боту-автору:
user channel gateway и подписанный webhook. Включённый webhook ставится в существующую
очередь атомарно с квитанцией, с обычными ретраями/истечением. Gateway после commit
работает best effort: RESUME может повторить буфер, новая сессия не восстанавливает
пропущенные callback. Для важных действий использовать webhook. Сообщения в чат нет.

Повтор с тем же `(actor, nonce)` (1–64 байта) возвращает прежний id без новой доставки,
в том числе после изменения/удаления кнопок, но с проверкой текущего доступа и наличия
сообщения/бота. Другая кнопка, версия или сообщение с той же nonce: 409. Квитанции
живут до физического удаления сообщения. Разные nonce могут быть приняты обе.
Бот обязан надёжно дедуплицировать `callback.id` между транспортами/ретраями,
повторно проверять собственную актуальную версию черновика и использовать идемпотентность
внешнего эффекта. Уже принятое событие не отменяется правкой сообщения. Ограниченный
кэш SDK не гарантирует exactly-once. UI блокирует всю клавиатуру после принятия до
новой версии от бота; устаревший клик обновляет сообщение без запуска нового действия.

## Формы досок (ADR-0059)

С Team: до 5 форм на доску, Business — 20, Custom/on-prem — по лимитам (0 = без
ограничения). Управление требует `VIEW_BOARD | MANAGE_BOARD`; бот использует обычный
Bearer token. `GET/POST /api/boards/{id}/forms`, `PUT/DELETE /api/boards/{id}/forms/{fid}`;
PUT передаёт полное `definition` и текущую `revision`. SDK: `bot.forms.list/create/update/delete`.

Определение (`BoardFormDefinition`): `title`, `description`, `fields[] {id,type,label,hint,
placeholder,required,options[]}`, `titleFieldId` (обязательное короткое поле), `statusId`,
`priority`, `isPrivate`, `allowedUserIds[]`. Идентификаторы полей — UUID, типы — enum
`BOARD_FORM_FIELD_TYPE_TEXT|PARAGRAPH|EMAIL|NUMBER|DATE|SELECT|CHECKBOX`. Бот должен быть
в allowedUserIds приватной формы; право управления не подменяет право заполнения.

`GET /api/forms/{code}` → безопасное представление формы; `POST …/submissions` принимает
`{revision,nonce,answers:[{fieldId,value}]}` и возвращает только `{receiptId}`. `nonce` —
UUID, сохраняйте его при повторе запроса: тот же запрос не создаёт вторую задачу.
Ответы — строки; checkbox — `"true"/"false"`. SDK: `bot.forms.get/submit`.
`POST /api/boards/{id}/forms/preview {definition,answers}` / `bot.forms.preview` проверяет
несохранённую форму без записи задачи, номера или вебхука. Все типы экспортирует `@calaba/protocol`.

`FORM_CHANGED` — перечитать форму/ревизию; `NONCE_CONFLICT` — nonce использован другим
запросом; `FORM_TARGET_UNAVAILABLE` — выбранный статус удалён; `PLAN_LIMIT` — тариф;
`FEATURE_DISABLED` — приоритет выключен на доске. Удаление формы отзывает ссылку, задачи
сохраняются. Публичный `/api/public/forms/{code}` не даёт прав на доску и блокируется
при обязательном SSO; боты используют авторизованный `/api/forms/{code}`.
