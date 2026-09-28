# 04 — Модель данных и права

PostgreSQL 18, `pgx` + `sqlc` + `goose` (миграции). Все id — `uuid v7` (сортируемые по времени), генерируются в Postgres встроенной `uuidv7()` (`DEFAULT uuidv7()`), а не в приложении. Все времена — `timestamptz`.

## Сущности

```
users               id, email (unique, citext), password_hash (argon2id), display_name,
                    avatar_file_id, status_text, settings (jsonb, UserSettings),
                    created_at, disabled_at, timezone? (IANA, «+3 UTC» у участников),
                    email_verified_at?, pending_email? (новый адрес до кода), locale? (en|ru|es|zh-CN, язык писем)
email_codes         user_id, purpose ('verify'|'change'|'reset'), code_hash (argon2id), expires_at,
                    attempts, created_at   PK (user_id, purpose) — один живой код на цель (ADR-0023)
mail_outbox         id, to_addr, template, locale, params (AES-GCM, ключ из JWT_SECRET; NULL после отправки),
                    priority (0 коды / 1 уведомления), attempts, next_at, expires_at, sent_at?, failed_at?, error
sessions            id, user_id, refresh_token_hash, prev_refresh_token_hash, rotated_at,
                    device_name, ip, user_agent,
                    created_at, last_seen_at, expires_at, revoked_at

workspaces          id, slug (unique), name, icon_file_id, visibility ('private'|'open'),
                    owner_id, created_at,
                    default_audio_bitrate_kbps (32), default_max_stream_preset ('h1080'),
                    default_max_streams (3),
                    storage_quota_bytes (10 GB), storage_used_bytes (0),
                    time_format ('auto'|'h24'|'h12', 'auto') — формат часов для всех времён в пространстве (docs/09 #73; PATCH — MANAGE_WORKSPACE)
workspace_members   workspace_id, user_id, role ('owner'|'admin'|'member'|'guest' — старшая встроенная роль),
                    nickname, joined_at            PK (workspace_id, user_id)
workspace_roles     id, workspace_id, name (1..32), color (0xRRGGBB, 0 = нет), position (UNIQUE в пространстве),
                    permissions bigint, builtin ('owner'|'admin'|'member'|'guest'|NULL), mentionable, created_at
member_roles        workspace_id, user_id, role_id      PK (workspace_id, user_id, role_id)   (ADR-0026)
workspace_invites   id, workspace_id, code (unique), created_by, max_uses, uses,
                    expires_at, created_at
email_invites       id, workspace_id, email (citext), role ('member'|'admin'), invited_by,
                    invite_id → workspace_invites (одноразовая ссылка /join/<code>, 7 дней),
                    expires_at, last_sent_at, accepted_at?   UNIQUE (workspace_id, email) среди непринятых

rooms               id, workspace_id? (NULL только у DM), type ('voice'|'text'|'dm'), name, topic,
                    position, category_id?, is_private, restricted (только при is_private, ADR-0029),
                    -- медиа-настройки комнаты (для voice), NULL = дефолт workspace:
                    audio_bitrate_kbps?  (16|24|32|48|64),
                    max_stream_preset?   ('economy'|'h720'|'h1080'|'original'),
                    max_streams?         (0..10),
                    created_at, archived_at
room_permissions    room_id, target_type ('role'|'user'), target_id (id роли | id пользователя),
                    allow bigint, deny bigint            -- overrides, как в Discord
                    PK (room_id, target_type, target_id)

messages            id (DEFAULT uuidv7()), room_id, author_id, content (text, ≤ 4000),
                    reply_to_id?, nonce?, created_at, edited_at, deleted_at
                    UNIQUE (author_id, nonce) WHERE nonce IS NOT NULL
message_attachments message_id, file_id (UNIQUE — файл прикреплён максимум к одному сообщению),
                    position (≤ 20 на сообщение)
files               id, workspace_id? (NULL — файл пользователя: аватар), uploader_id, key, thumbnail_key?, name,
                    mime, size, width?, height?, sha256, created_at
read_states         user_id, room_id, last_read_message_id      PK (user_id, room_id)
message_mentions    user_id, message_id, room_id                PK (user_id, message_id) — прямые @<user_id>
message_everyone_mentions  message_id PK, room_id                — @everyone / @here
room_notification_settings user_id, room_id, level (inherit|all|mentions|none), muted_until?   PK (user_id, room_id)
workspace_notification_settings user_id, workspace_id, level (all|mentions|none), muted_until?   PK (user_id, workspace_id)
room_categories     id, workspace_id, name, position            (rooms.category_id → ON DELETE SET NULL)
room_invites        id, room_id, code (unique, 12 символов), created_by, expires_at?, max_uses, uses,
                    allow_guests, allow_bits, revoked_at?       — ссылка на комнату (ADR-0016)
                    rooms += user_limit (0..99);  workspaces += allow_self_nickname (true)
                    users += is_guest, guest_expires_at?;  users.email nullable (только у гостей)
message_reactions   message_id, emoji, user_id, created_at      PK (message_id, emoji, user_id)
                    ≤ 20 разных эмодзи на сообщение; ≤ 3 разных эмодзи одного пользователя на сообщение
                    (MaxReactionsPerUser; 409 CONFLICT reason REACTION_LIMIT, проверка под FOR NO KEY UPDATE сообщения)
                    messages += pinned_at?, pinned_by?;  users += status_emoji, status_expires_at?
                    поиск: GIN по выражению to_tsvector('russian', content) || to_tsvector('simple', content)
user_notes          author_id, subject_id, text (1..1000), updated_at   PK (author_id, subject_id) — личная заметка о человеке
dm_members          room_id, user_id, created_at                PK (room_id, user_id) — ровно два участника DM (ADR-0020)
dm_state            user_id, room_id, archived_at, cleared_before  PK (user_id, room_id), FK → dm_members — своё состояние DM: архив, «Удалить чат» до id (docs/09 #51)
                    rooms += dm_key? (unique: least(a,b) || ':' || greatest(a,b));
                    CHECK (type = 'dm') = (workspace_id IS NULL), (type = 'dm') = (dm_key IS NOT NULL)

workspace_integrations workspace_id, kind ('gptunnel'), token_enc? (device token, AES-GCM как mail_outbox; NULL = отключено),
                    device_id, device_name, account, web_url, paired_by?, paired_at, revoked_at?   PK (workspace_id, kind)
room_recordings     id (uuidv7 приложения), workspace_id, room_id, started_by?, stopped_by?,
                    status (pending|recording|uploading|processing|done|failed), stop_reason, egress_id? (unique),
                    file (<workspace>/<id>.mp4 на томе записей), size_bytes, duration_sec, started_at, stopped_at?,
                    empty_since?, gptunnel_id, web_url, error, message_id? (карточка в чате), attempts, next_at?
                    (очередь загрузки/опроса), processing_since?, file_deleted_at?
                    UNIQUE (room_id) WHERE status IN (pending, recording) — одна запись на комнату (ADR-0025)
                    rooms += allow_recording (true);  messages += kind ('user'|'system'), payload? (jsonb SystemMessage)

sticker_packs       id, workspace_id, name (1..64), short_name ([a-z0-9_]{1,32}, UNIQUE среди живых в пространстве),
                    cover_sticker_id?, created_by?, created_at, updated_at, deleted_at?      (ADR-0030)
stickers            id, pack_id, file_id → files (UNIQUE), emoji, position, width, height (1..512), animated,
                    created_at, deleted_at?
user_sticker_packs  user_id, pack_id, position, added_at      PK (user_id, pack_id) — установленные паки и их порядок
                    messages += sticker_id? → stickers ON DELETE SET NULL (сообщение-стикер)

                    users += is_bot (ADR-0031; email NULL допустим у гостя или бота, бот не гость)
bots                user_id PK → users, owner_user_id, workspace_id («домашнее»; ON DELETE CASCADE), username (unique citext,
                    [a-z0-9_]{3,32}), description (≤ 512), token_id?, token_hash? (sha256 секрета; NULL = отозван), token_prefix,
                    webhook_url?, webhook_secret_enc? (AES-GCM, ключ из JWT_SECRET), webhook_disabled_at?, webhook_failing_since?,
                    webhook_last_ok_at?, webhook_last_error, created_at, revoked_at?
bot_commands        bot_user_id, name ([a-z0-9_]{1,32}), description (≤ 256), position   PK (bot_user_id, name)
bot_webhook_deliveries id (uuidv7 приложения = id в теле), bot_user_id, payload? (JSON; NULL после завершения), attempts,
                    next_at, created_at, delivered_at?, failed_at?, error          — outbox webhook-ов ботов
bot_blocks          user_id, bot_user_id, created_at   PK (user_id, bot_user_id) — человек заблокировал бота

voice_states        (не в Postgres — в Redis, источник LiveKit webhooks)
                    ключ — сессия (LiveKit identity = <user_id>:<session_id>):
                    workspace_id → { session_id → { user_id, room_id, muted, deafened,
                                                    streaming, joined_at } }
                    наружу агрегируется по пользователю (см. docs/05)
```

### Порядок комнат и категории (docs/09 P1 #19)
Категории — только пользовательские: новое пространство создаётся без них, комнаты (`category_id = NULL`) идут одним плоским списком по `position`; внутри категории — тоже только по `position` (текст и голос могут чередоваться). Миграция 00012 распустила категории с именами по умолчанию, созданные вместе с пространством, и пронумеровала комнаты каждого контейнера сквозно в прежнем видимом порядке. Перестановка — `PUT /api/workspaces/{id}/rooms/order` (право `MANAGE_ROOM` на уровне пространства): один батч `rooms[] {room_id, position, category_id ('' = верхний уровень)}` + `categories[] {category_id, position}` в одной транзакции (чужой элемент → 422, ничего не применено), затем CATEGORY_UPDATE и ROOM_UPDATE одним pipeline. Категории: `POST /api/workspaces/{id}/categories`, `PATCH`/`DELETE /api/categories/{id}`; при удалении комнаты уходят на верхний уровень после уже стоящих там.

Индексы: `messages (room_id, id desc)` для пагинации курсором; `workspace_members (user_id)`; `files (workspace_id)`.

### Сообщения: порядок и идемпотентность

- `messages.id` генерирует Postgres (`uuidv7()` в PG 18) в момент вставки → порядок id совпадает с порядком коммитов на одном сервере БД; курсорная пагинация и `before=<id>` работают без отдельного `created_at`-индекса. Клиентские часы в id не участвуют.
- `nonce` — клиентский идентификатор optimistic-сообщения. `UNIQUE (author_id, nonce) WHERE nonce IS NOT NULL`: повторный `POST` с тем же `nonce` (ретрай после обрыва) не создаёт дубль, а возвращает уже существующее сообщение (`INSERT … ON CONFLICT DO NOTHING` → `SELECT`), `MESSAGE_CREATE` повторно не рассылается.

### Файлы

- Загрузка и скачивание — **только через API** (`POST /api/workspaces/{id}/files`, `POST /api/me/avatar`, `GET /api/files/{id}`), байты лежат в `blob.Store` (ADR-0011: локальный диск, ключи `<workspace_id>/<file_id>[.thumb]`, аватары — `users/<user_id>/<file_id>`; S3 — позже), наружу хранилище не доступно. sha256 сервер считает сам при потоковой записи, поток обрывается при превышении лимита.
- `files.id` — uuid v7, но генерирует его **приложение**, а не Postgres: ключ объекта нужен до вставки строки (пишем байты → затем строка + квота в одной транзакции; ошибка → объект удаляется).
- Тип файла определяется по содержимому (sniffing); заявленный клиентом тип используется, только если sniffing неинформативен, и никогда — чтобы объявить изображение или активный контент (HTML/SVG/JS). Изображения (JPEG/PNG/GIF/WebP) отдаются `inline`, всё остальное — `attachment`, с `nosniff` и `CSP: sandbox`.
- Для изображений сервер делает превью (≤ 512 px по большей стороне, WebP q80, чистый Go — libwebp, транслированный из WASM, без cgo) вторым объектом → `thumbnail_key`; в payload сообщения — `thumbnail_url`. Изображения > 24 Мпикс превью не получают (бюджет памяти), размеры (`width`/`height`) пишутся всегда.
- Лимиты: файл ≤ 50 MB (`MAX_FILE_SIZE_MB`), аватар ≤ 5 MB, ≤ 20 вложений на сообщение, квота workspace `storage_quota_bytes` (по умолчанию 10 GB; тариф может её ужесточить — `storage_mb`, ADR-0024); `storage_used_bytes` увеличивается в той же транзакции, что и вставка в `files` (атомарно с проверкой квоты), уменьшается при удалении. Аватары (`workspace_id IS NULL`) в квоту не входят.
- Файл прикрепляется максимум к одному сообщению (права на файл = права на комнату этого сообщения). Удаление сообщения открепляет вложения; не прикреплённые более 24 ч файлы (кроме аватаров/иконок) удаляет фоновая чистка раз в час.

### Личные сообщения (ADR-0020)

- **Уровни уведомлений** (docs/09 п. 22, миграция 00014): у пользователя уровень на пространство (`workspace_notification_settings`, по умолчанию `mentions` = нет строки) и на комнату (по умолчанию `inherit` = нет строки). Эффективный уровень комнаты — её собственный, если не `inherit`, иначе уровень пространства; DM — каждое сообщение как упоминание, глушит только `none`/`muted_until`. `muted_until` пространства глушит все его комнаты. Миграция: комнаты без явного уровня и строки `all`, которые хранили только временный mute, стали `inherit` — у существующих пользователей фактически «Только упоминания». Правило — `internal/notifications` (Go) и `packages/protocol/src/notifications.ts`, общие векторы `proto/testdata/notifications.json`.
- DM — комната без пространства: `type = 'dm'`, `workspace_id IS NULL`, два участника в `dm_members`, одна на пару (`dm_key`). Сообщения, реакции, закрепы, read-state, настройки уведомлений — те же таблицы и эндпоинты комнат; доступ — по участию (`GetRoomAccess` отдаёт `dm_members`).
- Запросы по комнатам пространства фильтруют по `workspace_id` и DM не видят (списки, overrides, категории, позиции, поиск по пространству, `/api/me/mentions`). Голоса в DM нет: `rtc` считает комнату без пространства несуществующей.
- Файлы DM — пользовательские (`workspace_id IS NULL`, ключ `users/<user_id>/<file_id>`), грузятся через `POST /api/dms/{id}/files`, в квоту пространства не входят (действуют общий потолок `STORAGE_MAX_TOTAL_BYTES` и лимит 1 GiB неприкреплённых на пользователя). Публичны только аватары; остальные пользовательские файлы после прикрепления читаются по праву на комнату сообщения, т.е. только участниками DM.
- Прямые упоминания и `@everyone` в DM не сохраняются: каждое сообщение DM уведомляет получателя как упоминание.

### Профиль участника (docs/09 #20)

- «Участник с» — без новых полей: регистрация `users.created_at` (`User.created_at`) и вступление в пространство `workspace_members.joined_at` (`WorkspaceMember.joined_at`).
- Личные заметки `user_notes`: одна на пару (автор, о ком), видит и меняет только автор (`GET/PUT/DELETE /api/users/{id}/note`, docs/05). Писать можно о себе и о тех, с кем есть общее пространство (любая роль) или DM, иначе `404`. Пустой текст удаляет заметку. При анонимизации гостя удаляются его заметки и заметки о нём. Роли меняются `PUT …/members/{userId}/roles` (или legacy `PATCH …/members/{userId} {role}`; см. «Роли workspace» ниже).

## Роли workspace (ADR-0026)

У участника **несколько ролей** (`member_roles`). В каждом пространстве четыре встроенные роли (создаются триггером вместе с пространством, миграция 00021 — для существующих) и до 46 своих (всего ≤ 50):

| Роль | position | Права по умолчанию | Что можно менять |
|---|---|---|---|
| `owner` | 1001 | `ADMINISTRATOR` | только цвет/`mentionable`; снять/выдать нельзя; единственный, кто удаляет workspace |
| `admin` | 1000 | `ADMINISTRATOR` | цвет/`mentionable`; выдаёт и снимает только владелец |
| свои роли | 2 … | заданные | имя, цвет, права, порядок; удаляются |
| `member` | 1 | `VIEW_ROOM, SEND_MESSAGES, ATTACH_FILES, CONNECT, SPEAK, STREAM, VIDEO` | права; есть у каждого не-гостя |
| `guest` | 0 | `CONNECT, SPEAK` (комнаты — только с явным `allow VIEW_ROOM`) | права в пределах `VIEW_ROOM, SEND_MESSAGES, ATTACH_FILES, CONNECT, SPEAK, STREAM, VIDEO` |

- Встроенные роли участника следуют `workspace_members.role` (триггер): `owner` → owner + member, `admin` → admin + member, `member` → member, `guest` → guest. Поле `role` остаётся «старшей встроенной ролью» для клиентов до 0.6.0 (`WorkspaceMember.role`); свои роли назначаются отдельно (`member_roles`) и переживают смену встроенной. Имена встроенных ролей — ключи (`owner` …), клиент показывает локализованные.
- Новая своя роль встаёт в самый низ своих (position 2, остальные сдвигаются вверх, `ROLE_UPDATE`); порядок — `PUT …/roles/order` (свои роли от старшей к младшей).
- **Управление** (право `MANAGE_ROLES`, у admin — через `ADMINISTRATOR`): создавать, менять, удалять и переставлять можно только роли **ниже своей старшей** (владелец — любые); `ADMINISTRATOR` своей роли не выдаётся никогда; не-админ не может менять у роли `MANAGE_ROLES` / `MANAGE_WORKSPACE` и биты, которых нет у него самого. Создать роль может только тот, у кого старшая роль выше position 2.
- **Назначение** `PUT …/members/{userId}/roles {role_ids}` — полный набор ролей: `member`/`guest` сохраняется сам и не меняется (гость → участник — `promote`); `owner` не выдаётся и не снимается; `admin` — только владелец; каждая добавляемая/снимаемая роль — ниже старшей роли действующего и (для не-админа) без прав сверх его собственных; старшая роль цели — ниже старшей роли действующего (кроме себя).
- **Удаление** своей роли: её держатели остаются со своими прочими ролями (у каждого есть `member`/`guest` — это и есть «роль по умолчанию»), её переопределения в комнатах удаляются (`ROLE_DELETE` + `ROOM_PERMISSIONS_UPDATE`).
- Legacy `PATCH …/members/{userId} {role}` (`MANAGE_WORKSPACE`) меняет только встроенную роль, свои роли сохраняются.

Видимость workspace:
- `private` — вход только по инвайту (код/ссылка `calaba://join/<code>`).
- `open` — любой зарегистрированный пользователь сервера может зайти и получает роль `member`.

## Права (битмаска)

Проще Discord: один набор битов, действующий на уровне workspace (OR прав ролей участника) с overrides ролей и пользователя на уровне комнаты.

```ts
export const Permission = {
  VIEW_ROOM:        1n << 0n,   // видеть комнату в списке, читать
  SEND_MESSAGES:    1n << 1n,
  ATTACH_FILES:     1n << 2n,
  MANAGE_MESSAGES:  1n << 3n,   // удалять чужие
  CONNECT:          1n << 4n,   // войти в voice
  SPEAK:            1n << 5n,   // публиковать микрофон
  STREAM:           1n << 6n,   // публиковать экран
  MUTE_MEMBERS:     1n << 7n,   // серверный мьют/кик из voice
  MANAGE_ROOM:      1n << 8n,   // название, права, удаление комнаты
  MANAGE_WORKSPACE: 1n << 9n,   // настройки, инвайты, роли
  ADMINISTRATOR:    1n << 10n,  // всё, игнорирует deny
  MOVE_MEMBERS:     1n << 11n,  // перемещать других между voice-комнатами, входить сверх user_limit
  MANAGE_NICKNAMES: 1n << 12n,  // менять ники других (только уровень workspace)
  MENTION_EVERYONE: 1n << 13n,  // @everyone / @here (у member по умолчанию нет)
  VIDEO:            1n << 14n,  // веб-камера в voice (у member по умолчанию есть)
  MANAGE_ROLES:     1n << 15n,  // свои роли ниже своей старшей и их назначение (только уровень workspace, ADR-0026)
  MANAGE_STICKERS:  1n << 16n,  // стикерпаки пространства (только уровень workspace, ADR-0030)
} as const;
```

Дефолты встроенных ролей — в таблице «Роли workspace» выше (права `member`/`guest` редактируются).

Где какой бит проверяется (сервер, клиент, LiveKit grant) — `docs/16-permissions-matrix.md`.

Вычисление эффективных прав в комнате (единственная функция `computePermissions` в `packages/protocol`, зеркало — Go `internal/perm`, общие тест-векторы `proto/testdata/permissions.json`; сервер проверяет, клиент — для UI):

```
base   = OR(roles[].permissions)                     (права пространства; без переопределений)
if room.restricted:                                   (изменено ADR-0029)
    if owner → all;  base &= ~ADMINISTRATOR           (админы — как обычные участники)
elif base & ADMINISTRATOR → all                      (owner/admin: переопределения, в т.ч. deny, не действуют)
perms  = base
for role in roles sorted by position ASC:            (младшие первыми, старшая последней — её слово решает)
    perms &= ~roleOverride[role].deny;  perms |= roleOverride[role].allow
perms &= ~userOverride.deny;  perms |= userOverride.allow   (персональное — приоритетнее всех ролей)
if !(perms & VIEW_ROOM) → 0
```

`ADMINISTRATOR`, `MANAGE_WORKSPACE`, `MANAGE_NICKNAMES`, `MANAGE_ROLES`, `MANAGE_STICKERS` — только уровень пространства, в переопределениях комнаты запрещены (API отвечает `422`), а `computePermissions` их в переопределениях игнорирует (`allow`/`deny` маскируются `RoomOnly` / `ROOM_ONLY_PERMISSIONS`). Цель `role` в `room_permissions` — id роли (миграция 00021 перевела `member`/`guest` на id встроенных; API по-прежнему принимает имена встроенных ролей и сохраняет их id).

Приватная комната = override для роли `member` с `deny: VIEW_ROOM` + allow для своих ролей или конкретных пользователей (гостям `VIEW_ROOM` и так не положен).

**Только по списку (изменено ADR-0029).** Приватная комната с `rooms.restricted = true` (ставит и снимает только владелец — `workspaces.owner_id`, `PATCH /api/rooms/{id} {restricted}`, иначе `403 reason OWNER_ONLY`): `ADMINISTRATOR` в ней обхода не даёт — админы и роли с этим битом видят комнату только через `allow VIEW_ROOM` по роли или лично и получают права участника из переопределений; владелец (встроенная роль `owner`, её держит только `owner_id`) — всё всегда; суперадмин продукта — без обхода. `computePermissions({..., restricted, owner})`, векторы `restricted`/`owner` в `proto/testdata/permissions.json`.

**DM (ADR-0020).** Роли и overrides не применяются: `computePermissions({dm: {participant}})` (Go: `perm.ComputeDM`) даёт участнику фиксированный набор `VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES` (= 7), остальным — 0 (тест-векторы `roomType: "dm"` в `proto/testdata/permissions.json`). Остальные пункты ADR ложатся на правила, а не на биты: чтение истории — `VIEW_ROOM`, реакции — `SEND_MESSAGES`, правка/удаление своих сообщений — право автора везде, закреп в DM разрешён обоим участникам по типу комнаты. `MANAGE_MESSAGES`, `MENTION_EVERYONE`, модерации и голоса в DM нет.

## Маппинг прав → LiveKit grant

При выдаче токена на вход в voice-комнату:

```
canSubscribe        = VIEW_ROOM & CONNECT
canPublish          = SPEAK | STREAM
canPublishSources   = [ SPEAK ? 'microphone' : null, STREAM ? 'screen_share','screen_share_audio' : null ]
roomAdmin           = MUTE_MEMBERS (позволяет серверные mute/remove через API — но делаем через наш сервер, не даём клиенту)
```

Лимит «3 стрима в комнате» — проверяется сервером перед выдачей права STREAM в токене **и** контролируется через webhook `track_published` (если четвёртый прорвался — `mutePublishedTrack`/`removeParticipant` через server SDK). Токен на вход короткий (10 мин), при изменении прав сервер обновляет grant через `UpdateParticipant` в LiveKit API.

## Медиа-настройки комнаты

Админ (право `MANAGE_ROOM`) задаёт на комнате, как в Discord: битрейт голоса, максимальный пресет стрима, лимит стримов. Пусто → дефолт workspace. Клиент получает эффективные значения в объекте комнаты (`room.media`) и применяет при публикации; сервер использует `max_streams` при выдаче права STREAM и режет пресет выше разрешённого в `POST /rooms/:id/stream/request`.

## Тарифы и лимиты пространств (ADR-0024)

- `workspace_plans(workspace_id PK, plan free|team|custom, limits jsonb, valid_until, note, updated_by, updated_at)`; нет записи → `free`. `limits` хранится только у `custom` (как записано, 0 = без лимита); `free` / `team` берут лимиты из env `PLAN_FREE_LIMITS` / `PLAN_TEAM_LIMITS` (JSON поверх встроенных дефолтов, ключи ниже). Истёкший `valid_until` → лимиты `free`, запись остаётся (`Workspace.plan.expired = true`). Каждое изменение через admin API пишется в `workspace_plan_log` (кто, план, лимиты в силе на момент изменения, срок, заметка).
- Ключи: `room_members` (5), `stream_max_preset` (`h720`), `stream_max_fps` (15), `camera_max_preset` (`h720`), `camera_max_fps` (15), `streams_per_room` (1), `storage_mb` (1024), `members` (0 = ∞; пока информационный), `sticker_packs` (5) и `stickers` (200 на пространство, ADR-0030; упор — `409 CONFLICT, reason PLAN_LIMIT`), `bots` (2: ботов-участников пространства, ADR-0031; `409 CONFLICT`, `reason PLAN_LIMIT` при создании и добавлении). Team по умолчанию: 50 в комнате, 20 ботов, остальное без лимита.
- Сервер (`internal/plans`, кэш 30 с, сброс при изменении на всех инстансах через Redis `plans:changed`) применяет лимиты **для всех, включая владельца** (это не биты прав):
  - вход в голосовую комнату (`/join`, webhook `participant_joined`, перемещение): мест `min(user_limit, room_members)`, pending-устройства и гости считаются; упор в лимит плана → `409 ROOM_FULL`, `reason = PLAN_LIMIT`, `used`/`limit`. `user_limit` комнаты по-прежнему не действует на `MOVE_MEMBERS`, лимит плана — действует;
  - стрим: пресет ≤ `min(max_stream_preset комнаты, stream_max_preset)`, стримов ≤ `min(max_streams, streams_per_room)` (и при выдаче слота, и в webhook), fps ≤ `stream_max_fps`; камера: пресет/fps ≤ `camera_max_*` (ответ `/camera/request`);
  - файлы: квота = `min(storage_quota_bytes, storage_mb MiB)`; превышение → `413 FILE_QUOTA_EXCEEDED` c `used`/`limit` (байты), `reason = PLAN_LIMIT`, если упёрлись в план.
- `Room.media` остаётся настройками комнаты (UI различает замок «комната» и замок «тариф»); эффективные лимиты плана — в `Workspace.plan.limits` и в ответе `/join` (`media` уже урезан планом, `plan_limits`).
- Суперадмин — пользователь с email из `SUPERADMIN_EMAILS`; флаг не хранится, вычисляется из текущего email при каждом запросе (`Me.is_superadmin`).

## Стикеры (ADR-0030)

- Пак принадлежит пространству; стикер — WebP-файл пространства (строка `files`, ключ `<workspace>/<file_id>`, в квоте хранения, без превью) + эмодзи для поиска. Сервер разбирает контейнер сам (`internal/stickers.ValidateWebP`): `RIFF`/`WEBP`, размер RIFF = файлу, только известные чанки, стороны 1..512, анимация — `VP8X` + `ANIM` + 1..300 `ANMF` в пределах canvas, ≤ 10 с; ≤ 512 КБ статичный, ≤ 1 МБ анимированный; ≤ 120 стикеров в паке, ≤ 50 за загрузку, ≤ 50 установленных паков у пользователя.
- Права: управление паками — `MANAGE_STICKERS` (у owner/admin через `ADMINISTRATOR`); видеть паки и стикеры в ленте — все участники (и гости); устанавливать и отправлять — не-гости. Пак пространства W используется в комнатах W и в DM, где оба участника — не-гости W. Файл стикера читает участник W или тот, кто видит комнату с живым сообщением-стикером.
- Удаление не ломает историю: стикер (или пак), который показывает хоть одно сообщение, помечается `deleted_at` и уходит из пикеров; без ссылок — удаляется, файл забирает чистка сирот (она пропускает файлы живых стикеров). Удалённый пак снимается у всех.
- Сообщение-стикер: `messages.sticker_id`, пустой `content`, без вложений, правка запрещена (`403`); ответ и реакции — как обычно.

## Приостановка пространства и баны (docs/09 #32)

- **Приостановка** — только суперадмин (`PUT /api/admin/workspaces/{id}/suspension`): `workspaces.suspended_at / suspended_reason (≤ 500) / suspended_by`, каждое действие — в `workspace_admin_log (actor, action suspend|resume, reason)`. Приостановленное пространство — только для чтения, для всех ролей, владельца тоже: сервер отказывает `403 WORKSPACE_SUSPENDED` на отправку и правку сообщений, реакции, файлы, вход в голос и перемещение, стрим/камеру, запись, инвайты (обычные, по email, ссылки в комнату) и любой вход в пространство; все звонки завершаются (LiveKit `RemoveParticipant`). Чтение, история, READY, выход и управление участниками работают. Отказ — одна таблица маршрутов в `internal/moderation` (middleware после проверки прав), публичные ссылки в комнату и регистрация по инвайту проверяют сами. Причину видят только owner / admin (`Workspace.suspension.reason`), остальным — только факт.
- **Бан** (`workspace_bans(workspace_id, user_id, email, reason, banned_by, created_at)`, PK `(workspace_id, user_id)`): право — как у «Исключить» (`MANAGE_WORKSPACE`; владельца нельзя, админа — только владелец, себя — нельзя). Бан = исключение + отзыв ожидающих email-приглашений на адрес + отказ `403 BANNED` на любом пути назад: инвайт, открытое пространство, добавление по поиску, email-приглашение (и авто-принятие после подтверждения почты), регистрация по инвайту с тем же адресом, ссылка в комнату. `email` — адрес аккаунта на момент бана (у гостя нет: гость банится по своему гостевому аккаунту; новый анонимный гость по той же ссылке не распознаётся — ссылку стоит отозвать). Разбан не возвращает членство.

## Запись встреч (ADR-0025)

- **Подключение GPTunneL** — на пространство: код из GPTunneL → `POST /v1/meetings/device/pair` → device token хранится зашифрованным в `workspace_integrations` (ключ из `JWT_SECRET`, назначение `calaba/workspace-integration/v1`). Подключает/отключает `MANAGE_WORKSPACE`; статус видят все участники, кроме гостей. 401 от GPTunneL (устройство отозвано в вебе) → токен забывается, запись падает с `device_revoked`.
- **Кто пишет**: участник пространства (не гость) с `VIEW_ROOM | CONNECT` в голосовой комнате, где идёт звонок и `allow_recording = true` (выключает `MANAGE_WORKSPACE`; выключение останавливает идущую запись). Одна запись на комнату, не больше `RECORDING_MAX_CONCURRENT` на сервер (под `pg_advisory_xact_lock`).
- **Жизнь записи** (`room_recordings.status`): `pending` (строка до старта egress) → `recording` (egress идёт; стоп — `stopped_at`/`stop_reason`, строка остаётся `recording`, пока egress не отдаст файл) → `uploading` (файл на томе, очередь) → `processing` (загружено, GPTunneL распознаёт; `web_url`) → `done` (файл удалён) | `failed` (`error`). Авто-стоп: 3 ч 58 мин (GPTunneL принимает ≤ 4 ч / ≤ 4 ГБ; сверх — `failed: too_large` без загрузки), звонок пуст 2 мин, комната запретила запись. Файлы `failed` удаляются через 7 дней (janitor), бесхозные `.mp4` — через 8.
- **Воркер**: один на кластер (блокировка Valkey `rec:worker`), очередь — строки `uploading|processing` с `next_at` (захват сдвигает `next_at` на аренду 15 мин). Загрузка — кусками 8 МБ с `Content-Range`, докачка по `Upload-Offset`/409/HEAD, ретраи с backoff 30 с → 30 мин ≤ 24 ч; опрос статуса 20 с → 5 мин ≤ 2 ч (`timeout`). Reconcile (раз в 15 с): строки без живого egress забираются (файл есть → загрузка, нет → `failed`), `pending` старше 2 мин падают, наши egress без строки останавливаются.

## Auth (MVP)

- Email + пароль (argon2id: 19 MiB, t=2, p=1 — профиль OWASP; не больше 4 хэшей одновременно), refresh-токены с ротацией (в `sessions`), access JWT HS256 15 мин (`sub` = user, `sid` = session).
- Refresh-токен = `<session_id>.<secret>`, в БД — только `sha256(secret)`. Каждый refresh выдаёт новый секрет. Предъявлен не текущий секрет живой сессии → это повтор уже ротированного токена (или подделка) → сессия отзывается целиком. Исключение: предыдущий секрет в течение 30 с после ротации (гонка двух параллельных refresh) → `401` без отзыва.
- Отзыв сессии (logout, reuse, «выйти везде») мгновенно действует и на выданные access-токены: API ставит в Redis `auth:revoked:<session_id>` (TTL = время жизни access-токена), middleware проверяет его (rueidis client-side cache, инвалидация сервером Redis). Redis недоступен → `503` (fail closed).
- Регистрация: открытая или по инвайту (флаг сервера `REGISTRATION_MODE=open|invite`). В режиме `invite` без кода может зарегистрироваться только **первый пользователь сервера** (bootstrap владельца, под `pg_advisory_xact_lock`). Регистрация с инвайтом сразу добавляет в workspace ролью `member`.
- **Почта (ADR-0023).** Письма уходят только через outbox `mail_outbox` (в транзакции вызывающего) → воркер: цикл на каждом инстансе, отправляет держатель блокировки Valkey `mail:worker` (30 с); взятые строки «арендуются» (`next_at` +5 мин), поэтому потеря блокировки или падение не дают дубля. Ретраи 30 с × 2ⁿ (≤ 1 ч) до конца жизни письма (код — 10 мин, остальное — 24 ч); SMTP 5xx и ошибки шаблона — сразу `failed_at`. Лимиты (Valkey): `MAIL_PER_ADDRESS_PER_HOUR` (3) на адрес — при постановке (429), `MAIL_PER_HOUR` (200) на сервер — воркер ждёт. Без `SMTP_HOST` почты нет: регистрация сразу помечает адрес подтверждённым.
- **Подтверждение email.** Код — 6 цифр, argon2id, 10 мин, 5 попыток (попытка списывается до сравнения), новый — не чаще раза в 60 с (атомарно в `PutEmailCode`). Код шлют регистрация, вход неподтверждённого (если прошлый старше 60 с) и `verify/send`. Неподтверждённый аккаунт читает и входит, но `EMAIL_NOT_VERIFIED` (403) на создание пространства, приглашения (ссылки на пространство/комнату, email-приглашения, lookup, добавление) и **новый** DM; гости не затрагиваются. Существующие аккаунты **не** считаются подтверждёнными (владелец, 27.09). Суперадмин (`SUPERADMIN_EMAILS`) — только с подтверждённым адресом.
- **Смена email** — адрес попадает в `pending_email`, код уходит на новый адрес; вход — по старому, пока код не подтверждён (`verify` переносит адрес и ставит `email_verified_at`). Смена на текущий адрес отменяет ожидающую.
- **Сброс пароля.** `forgot` всегда 204 (работа в фоне, тайминг одинаковый); `reset` с неверным/просроченным кодом или неизвестным адресом — одинаково `422 CODE_INVALID`; успех: новый хэш, адрес подтверждён, **все** сессии отозваны.
- **Приглашения по email.** Право — `MANAGE_WORKSPACE` (право на приглашения) + подтверждённый адрес. `lookup` — точное совпадение среди подтверждённых активных не-гостей, 20/мин на пользователя, в лог — id действующего и sha256-префикс адреса. `members {user_id}` добавляет сразу (`member`) + письмо `workspace_added`. `invites/email` создаёт одноразовую ссылку, привязанную к адресу (регистрация/вход по ней с другим адресом → `INVITE_INVALID`; с этим — адрес сразу подтверждён), повтор тому же адресу — не чаще раза в 24 ч (новая ссылка, старая удаляется); 20 подряд / 30 в час на пользователя. Подтверждение адреса (код, сброс пароля, ссылка) принимает **все** живые email-приглашения этого адреса.
- Позже: OIDC (Google Workspace / Keycloak) — таблица `users` уже без привязки к паролю как единственному способу (`password_hash` nullable).

## Боты (ADR-0031)

- Бот — пользователь `is_bot` (без email/пароля, `email_verified_at` ставится при создании), участник пространств со встроенной ролью `member`; права — свои роли и переопределения комнат, `computePermissions` не меняется. `admin`/`guest` боту не выдаются (`422`), `owner` — никогда. Ограниченные комнаты (ADR-0029) действуют как на людей.
- Создаёт владелец или `MANAGE_WORKSPACE` (подтверждённый email) — «домашнее» пространство; добавить в другое — `MANAGE_WORKSPACE` там (`…/bots/add`). Токен, удаление — дома (владелец бота или `MANAGE_WORKSPACE`). Удаление: `bots` удаляется, членства и личные переопределения — тоже, аккаунт `disabled_at`, сообщения остаются. Удаление домашнего пространства удаляет строку `bots` (токен перестаёт работать).
- Аутентификация и маршруты для ботов — docs/05 «Боты».

## Гости (ADR-0016)

- Ссылка на комнату (`room_invites`) — это capability. По умолчанию: срок 7 дней, без лимита использований, гости разрешены. Права приглашённого: `VIEW_ROOM | CONNECT` всегда, плюс `SPEAK` / `SEND_MESSAGES` (по умолчанию да) и `ATTACH_FILES` / `STREAM` (по умолчанию нет). Не-админ не может выдать через ссылку права, которых нет у него самого.
- Переход по ссылке:
  - (a) уже есть доступ к комнате — ничего не меняется, использование не тратится;
  - (b) зарегистрированный пользователь не из workspace → членство `guest` + user-override на комнату; если он участник без доступа к комнате — только override;
  - (c) без аккаунта → гостевой аккаунт `is_guest` (без email и пароля, имя = введённый ник), сессия 24 ч, продлевается каждым refresh.
- Гость без активности 7 дней (`guest_expires_at`, сдвигается при refresh) **анонимизируется**, а не удаляется: членства, overrides, файлы и сессии удаляются, имя → «Гость (удалён)», сообщения остаются. Фоновая чистка — раз в час.
- Гостевой аккаунт не может: создавать и находить workspace, входить в открытые workspace, менять статус и аватар (только имя и настройки). Роль `guest` не видит комнат без override, поэтому не создаёт ссылок и не видит чужих комнат.
- `POST …/members/{userId}/promote` (MANAGE_WORKSPACE): `guest` → `member`. Аккаунт гостя после этого не чистится.
