# 04 — Модель данных и права

PostgreSQL 18 или 17, `pgx` + `sqlc` + `goose` (миграции). Все id — `uuid v7` (сортируемые по времени), генерируются в Postgres функцией `uuidv7()` (`DEFAULT uuidv7()`), а не в приложении: в PG 18 она встроенная, на 17 сервер до миграций создаёт совместимую `public.uuidv7()` (ADR-0037). Все времена — `timestamptz`.

## Сущности

```
users               id, email (unique, citext), password_hash (argon2id), display_name,
                    avatar_file_id, status_text, settings (jsonb, UserSettings),
                    created_at, disabled_at, timezone? (IANA, «+3 UTC» у участников),
                    email_verified_at?, pending_email? (новый адрес до кода), locale? (en|ru|es|zh-CN, язык писем),
                    birthday_day?/birthday_month? (вместе), birthday_year?, birthday_hidden (docs/09 #76)
email_codes         user_id, purpose ('verify'|'change'|'reset'), code_hash (argon2id), expires_at,
                    attempts, created_at   PK (user_id, purpose) — один живой код на цель (ADR-0023)
mail_outbox         id, to_addr, template, locale, params (AES-GCM, ключ из JWT_SECRET; NULL после отправки),
                    priority (0 коды / 1 уведомления), attempts, next_at, expires_at, sent_at?, failed_at?, error
sessions            id, user_id, refresh_token_hash, prev_refresh_token_hash, rotated_at,
                    refresh_gen, refresh_used_at?, replay_seal?,   -- повтор refresh (раздел «Auth»)
                    device_name, ip, user_agent,
                    created_at, last_seen_at, expires_at, revoked_at, revoked_reason?

workspaces          id, slug (unique), name, icon_file_id, visibility ('private'|'open'),
                    owner_id, created_at,
                    default_audio_bitrate_kbps (32), default_max_stream_preset ('h1080'),
                    default_max_streams (3),
                    storage_quota_bytes (10 GB), storage_used_bytes (0),
                    time_format ('auto'|'h24'|'h12', 'auto') — формат часов для всех времён в пространстве (docs/09 #73; PATCH — MANAGE_WORKSPACE)
workspace_members   workspace_id, user_id, role ('owner'|'admin'|'member'|'guest' — старшая встроенная роль),
                    nickname, joined_at,
                    badge_id? → workspace_badges (ON DELETE SET NULL),
                    achievement_count (живые ачивки, ADR-0061)   PK (workspace_id, user_id)
workspace_badges    id, workspace_id, name (1..32), file_id → files, position, created_at   (docs/09 #82, ≤ 20 в пространстве)
workspace_backgrounds id, workspace_id, name (1..40), file_id → files, position, created_at (ADR-0035, ≤ 20 в пространстве)
workspace_sounds    id, workspace_id, name (1..32), emoji (≤ 64 байт, '' = нет), file_id → files, duration_ms (1..5000), position, created_at (ADR-0036, ≤ 50 в пространстве)
workspace_apps      id, workspace_id, name (1..40), url (≤ 2048), icon_file_id? → files (SET NULL), position (double), created_by?, created_at, updated_at (ADR-0050, ≤ 20 в пространстве)
workspace_roles     id, workspace_id, name (1..32), color (0xRRGGBB, 0 = нет), position (UNIQUE в пространстве),
                    permissions bigint, builtin ('owner'|'admin'|'member'|'guest'|NULL), mentionable, created_at
member_roles        workspace_id, user_id, role_id      PK (workspace_id, user_id, role_id)   (ADR-0026)
workspace_invites   id, workspace_id, code (unique), created_by, max_uses, uses,
                    expires_at, created_at
email_invites       id, workspace_id, email (citext), role ('member'|'admin'), invited_by,
                    invite_id → workspace_invites (одноразовая ссылка /join/<code>, 7 дней),
                    expires_at, last_sent_at, accepted_at?   UNIQUE (workspace_id, email) среди непринятых

rooms               id, workspace_id? (NULL только у DM), type ('voice'|'text'|'dm'), name, topic,
                    position, category_id?, is_private, restricted (закрытая: только при is_private, ADR-0029/0048),
                    -- медиа-настройки комнаты (для voice), NULL = дефолт workspace:
                    audio_bitrate_kbps?  (8|16|32|64; 24, 48 legacy),
                    max_stream_preset?   ('economy'|'h720'|'h1080'|'original'),
                    max_streams?         (0..10),
                    created_at, archived_at,
                    expires_at?  (временная комната, ADR-0044: архивируется свипером в этот момент),
                    created_by?  (создатель; у временной — неявный MANAGE_ROOM на неё)
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
                    + require_approval? (NULL — как у комнаты; ADR-0040);  rooms += guest_approval (false)
room_admissions     room_id, user_id, invite_id?, status (pending|admitted|declined), requested_at,
                    decided_by?, decided_at?                     PK (room_id, user_id) — стук гостя (ADR-0040)
                    rooms += user_limit (0..99);  workspaces += allow_self_nickname (true)
                    users += is_guest, guest_expires_at?;  users.email nullable (только у гостей)
message_reactions   message_id, emoji, user_id, created_at      PK (message_id, emoji, user_id)
                    ≤ 20 разных эмодзи на сообщение; ≤ 3 разных эмодзи одного пользователя на сообщение
                    (MaxReactionsPerUser; 409 CONFLICT reason REACTION_LIMIT, проверка под FOR NO KEY UPDATE сообщения)
                    messages += pinned_at?, pinned_by?;  users += status_emoji, status_expires_at?
                    поиск: GIN по выражению to_tsvector('russian', content) || to_tsvector('simple', content)
user_notes          author_id, subject_id, text (1..1000), updated_at   PK (author_id, subject_id) — личная заметка о человеке
birthday_greetings  user_id, workspace_id, day (местная дата именинника), message_id?, created_at
achievements        id, workspace_id → workspaces CASCADE, title (1..60), description (0..200), file_id? → files
                    (картинка — файл пространства), legacy_image_key? (до копии картинки миграции 00063),
                    image_size, width, height (512), position, created_by? → users (SET NULL), created_at,
                    updated_at, archived_at?      -- каталог ПРОСТРАНСТВА (ADR-0061, поправка 1), ≤ 100
                    INDEX (workspace_id, position, id); INDEX (file_id)
achievement_legacy_blobs key — старые блобы "achievements/*" хоста, удаляются задачей запуска после копии
member_achievements id, workspace_id → workspaces CASCADE, user_id → users CASCADE, achievement_id →
                    achievements RESTRICT, granted_by? (SET NULL), note (1..120), message_id? → messages (SET NULL),
                    granted_at, revoked_at?, revoked_by?
                    INDEX (workspace_id, user_id, granted_at DESC) WHERE revoked_at IS NULL; INDEX (achievement_id)
                    PK (user_id, workspace_id, day) — дедуп карточки дня рождения (docs/09 #76)
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
Категории — только пользовательские: новое пространство создаётся без них, комнаты (`category_id = NULL`) идут одним плоским списком по `position`; внутри категории — тоже только по `position` (текст и голос могут чередоваться). Миграция 00012 распустила категории с именами по умолчанию, созданные вместе с пространством, и пронумеровала комнаты каждого контейнера сквозно в прежнем видимом порядке. Перестановка — `PUT /api/workspaces/{id}/rooms/order` (право `MANAGE_ROOM` на уровне пространства): один батч `rooms[] {room_id, position, category_id ('' = верхний уровень)}` + `categories[] {category_id, position}` в одной транзакции (чужой элемент → 422, ничего не применено), затем CATEGORY_UPDATE и ROOM_UPDATE одним pipeline. Категории: `POST /api/workspaces/{id}/categories` (сервер ставит новую в конец; клиент сразу поднимает её первой среди категорий тем же `PUT …/rooms/order`), `PATCH`/`DELETE /api/categories/{id}`; при удалении комнаты уходят на верхний уровень после уже стоящих там.

Индексы: `messages (room_id, id desc)` для пагинации курсором; `workspace_members (user_id)`; `files (workspace_id)`.

### Сообщения: порядок и идемпотентность

- `messages.id` генерирует Postgres (`uuidv7()`: встроенная в PG 18, на 17 — `public.uuidv7()`, ADR-0037) в момент вставки → порядок id совпадает с порядком коммитов на одном сервере БД; курсорная пагинация и `before=<id>` работают без отдельного `created_at`-индекса. Клиентские часы в id не участвуют.
- `nonce` — клиентский идентификатор optimistic-сообщения. `UNIQUE (author_id, nonce) WHERE nonce IS NOT NULL`: повторный `POST` с тем же `nonce` (ретрай после обрыва) не создаёт дубль, а возвращает уже существующее сообщение (`INSERT … ON CONFLICT DO NOTHING` → `SELECT`), `MESSAGE_CREATE` повторно не рассылается.
- **Прочтение другими** (docs/09 #92): из `read_states` — в DM маркер собеседника, в комнате самый дальний маркер остальных людей (без ботов); отдельной таблицы нет. `PUT /api/rooms/{id}/read` сдвигает маркер (`AdvanceReadState` сообщает, сдвинулся ли) и шлёт `READ_RECEIPT` (docs/05); комнатный максимум — `TopRoomReads` по `read_states_room_id_idx` (строк не больше, чем участников, читавших комнату), в READY — `ListPeerReads`. Индекс по `last_read_message_id` не добавлен сознательно: он отключил бы HOT-обновления частого upsert маркера.
- **Пересылка** (ADR-0033): `POST /api/rooms/{id}/messages/{mid}/forward {to_room_id}` — копия от пересылающего с `messages.forwarded_from` (всегда первоисточник), `forward_author_id`, `forward_sent_at` (→ `Message.forward`); вложения — строки `message_attachments.forwarded = true` на те же файлы (без квоты; уникальность файла — только среди непересланных), упоминания не пишутся, копию нельзя править (422 `MESSAGE_NOT_EDITABLE`); права — `VIEW_ROOM` в источнике (и из комнаты «только по списку»), `SEND_MESSAGES` в цели.

### Файлы

- Загрузка и скачивание — **только через API** (`POST /api/workspaces/{id}/files`, `POST /api/me/avatar`, `GET /api/files/{id}`), байты лежат в `blob.Store` (ADR-0011: локальный диск, ключи `<workspace_id>/<file_id>[.thumb]`, аватары — `users/<user_id>/<file_id>`; S3 — позже), наружу хранилище не доступно. sha256 сервер считает сам при потоковой записи, поток обрывается при превышении лимита.
- `files.id` — uuid v7, но генерирует его **приложение**, а не Postgres: ключ объекта нужен до вставки строки (пишем байты → затем строка + квота в одной транзакции; ошибка → объект удаляется).
- Тип файла определяется по содержимому (sniffing); заявленный клиентом тип используется, только если sniffing неинформативен, и никогда — чтобы объявить изображение или активный контент (HTML/SVG/JS). Изображения (JPEG/PNG/GIF/WebP) отдаются `inline`, всё остальное — `attachment`, с `nosniff` и `CSP: sandbox`.
- Для изображений сервер делает превью (≤ 512 px по большей стороне, WebP q80, чистый Go — libwebp, транслированный из WASM, без cgo) вторым объектом → `thumbnail_key`; в payload сообщения — `thumbnail_url`. Изображения > 24 Мпикс превью не получают (бюджет памяти), размеры (`width`/`height`) пишутся всегда.
- Лимиты: файл ≤ 50 MB (`MAX_FILE_SIZE_MB`), аватар ≤ 512 KB (клиент шлёт WebP 512×512, docs/02 «Изображения»; до 29.09 — 5 MB), ≤ 20 вложений на сообщение, квота workspace `storage_quota_bytes` (по умолчанию 10 GB; тариф может её ужесточить — `storage_mb`, ADR-0024); `storage_used_bytes` увеличивается в той же транзакции, что и вставка в `files` (атомарно с проверкой квоты), уменьшается при удалении. Аватары (`workspace_id IS NULL`) в квоту не входят.
- Файл прикрепляется максимум к одному сообщению (права на файл = права на комнату этого сообщения). Удаление сообщения открепляет вложения; не прикреплённые более 24 ч файлы (кроме аватаров/иконок) удаляет фоновая чистка раз в час.

### Личные сообщения (ADR-0020)

- **Уровни уведомлений** (docs/09 п. 22, миграция 00014): у пользователя уровень на пространство (`workspace_notification_settings`, по умолчанию `mentions` = нет строки) и на комнату (по умолчанию `inherit` = нет строки). Эффективный уровень комнаты — её собственный, если не `inherit`, иначе уровень пространства; DM — каждое сообщение как упоминание, глушит только `none`/`muted_until`. `muted_until` пространства глушит все его комнаты. Миграция: комнаты без явного уровня и строки `all`, которые хранили только временный mute, стали `inherit` — у существующих пользователей фактически «Только упоминания». Правило — `internal/notifications` (Go) и `packages/protocol/src/notifications.ts`, общие векторы `proto/testdata/notifications.json`.
- DM — комната без пространства: `type = 'dm'`, `workspace_id IS NULL`, два участника в `dm_members`, одна на пару (`dm_key`). Сообщения, реакции, закрепы, read-state, настройки уведомлений — те же таблицы и эндпоинты комнат; доступ — по участию (`GetRoomAccess` отдаёт `dm_members`).
- Запросы по комнатам пространства фильтруют по `workspace_id` и DM не видят (списки, overrides, категории, позиции, поиск по пространству, `/api/me/mentions`). Голос в DM — только звонок один на один (ADR-0034, «Звонки» ниже); остальные голосовые маршруты считают комнату без пространства несуществующей.
- Файлы DM — пользовательские (`workspace_id IS NULL`, ключ `users/<user_id>/<file_id>`), грузятся через `POST /api/dms/{id}/files`, в квоту пространства не входят (действуют общий потолок `STORAGE_MAX_TOTAL_BYTES` и лимит 1 GiB неприкреплённых на пользователя). Публичны только аватары; остальные пользовательские файлы после прикрепления читаются по праву на комнату сообщения, т.е. только участниками DM.
- Прямые упоминания и `@everyone` в DM не сохраняются: каждое сообщение DM уведомляет получателя как упоминание.

### Заметки — личные полки (ADR-0039)

- Полка — комната без пространства: `type = 'notes'`, `workspace_id IS NULL`, владелец — **единственная строка** в `dm_members` (код DM — доступ, события по `user:<id>`, файлы, закрепы, read-state, поиск, пересылка — работает без веток; `RoomAccess.Notes` отличает полку там, где DM значит «двое»: звонки/голос/стрим/камера → `404`, архив и «Удалить чат» DM полку не видят). Имя 1..40 — `rooms.name`, порядок — `rooms.position`, эмодзи — `rooms.emoji` (`''` = нет; у остальных комнат пусто). CHECK `type IN ('dm','notes')` ⇔ `workspace_id IS NULL`. Миграция 00043.
- Права — набор DM (`computePermissions({dm})`: VIEW_ROOM, SEND_MESSAGES, ATTACH_FILES; закреп — по типу комнаты); кроме владельца полку не видит никто (`404`). Боты и гостевые аккаунты — `403` на `/api/notes*`, в READY `notes` пусто.
- Не больше **20 полок** на пользователя (создание под advisory-lock пользователя; 21-я — `409 CONFLICT`, `reason = NOTES_LIMIT`). Удаление — `DELETE rooms` каскадом (сообщения, реакции, закрепы, read-state); вложения становятся сиротами и уходят обычной очисткой, копии, пересланные в другие чаты, остаются.
- **Личная квота**: `users.storage_quota_bytes` (`NULL` = `DEFAULT_PERSONAL_QUOTA_BYTES`, 1 GiB); меняет суперадмин (`GET|PUT /api/admin/users/{id}/storage-quota`). Считаются пользовательские файлы владельца (не аватар), лежащие в живых сообщениях его полок, и ещё не прикреплённые; проверка — в `POST /api/dms/{id}/files` для полки под lock общего потолка хранилища (`413 FILE_QUOTA_EXCEEDED`, `reason = PERSONAL_QUOTA`, `used/limit`). Пересылка в полку квоту не тратит (те же файлы, ADR-0033); загрузки в DM личной квотой не ограничены.

### Профиль участника (docs/09 #20)

- «Участник с» — без новых полей: регистрация `users.created_at` (`User.created_at`) и вступление в пространство `workspace_members.joined_at` (`WorkspaceMember.joined_at`).
- Личные заметки `user_notes`: одна на пару (автор, о ком), видит и меняет только автор (`GET/PUT/DELETE /api/users/{id}/note`, docs/05). Писать можно о себе и о тех, с кем есть общее пространство (любая роль) или DM, иначе `404`. Пустой текст удаляет заметку. При анонимизации гостя удаляются его заметки и заметки о нём. Роли меняются `PUT …/members/{userId}/roles` (или legacy `PATCH …/members/{userId} {role}`; см. «Роли workspace» ниже).
- **День рождения** (docs/09 #76, как в Telegram): `users.birthday_day/month` (обязательны вместе), `birthday_year` (по желанию, 1900..текущий, дата не в будущем), `birthday_hidden`. 29 февраля допустимо (в невисокосный год празднуется 28 февраля). `User.birthday {day, month, year?}` видят все, кому приходит `User` (участники общих пространств, DM); скрытый — только сам владелец (`Me.user.birthday` + `Me.birthday_hidden`). Гости и боты день рождения не задают. Карточка «🎂 Сегодня день рождения у …» — раз в день на (человек, пространство), дедуп `birthday_greetings` по местной дате именинника (строки старше 3 дней удаляются). Местное — по поясу именинника, без него — по поясу владельца пространства, без него — UTC (`birthdays.GreetZone`, docs/05; docs/09 #100).

## Роли workspace (ADR-0026)

У участника **несколько ролей** (`member_roles`). В каждом пространстве четыре встроенные роли (создаются триггером вместе с пространством, миграция 00021 — для существующих) и до 46 своих (всего ≤ 50):

| Роль | position | Права по умолчанию | Что можно менять |
|---|---|---|---|
| `owner` | 1001 | `ADMINISTRATOR` | только цвет/`mentionable`; снять/выдать нельзя; единственный, кто удаляет workspace |
| `admin` | 1000 | `ADMINISTRATOR` | цвет/`mentionable`; выдаёт и снимает только владелец |
| свои роли | 2 … | заданные | имя, цвет, права, порядок; удаляются |
| `member` | 1 | `VIEW_ROOM, SEND_MESSAGES, ATTACH_FILES, CONNECT, SPEAK, STREAM, VIDEO, VIEW_BOARD, CREATE_TASKS, CREATE_TEMP_ROOMS` (биты досок — миграция 00046, ADR-0042; временные комнаты — 00048, ADR-0044) | права; есть у каждого не-гостя |
| `guest` | 0 | `CONNECT, SPEAK` (комнаты — только с явным `allow VIEW_ROOM`) | права в пределах `VIEW_ROOM, SEND_MESSAGES, ATTACH_FILES, CONNECT, SPEAK, STREAM, VIDEO` |

- Встроенные роли участника следуют `workspace_members.role` (триггер): `owner` → owner + member, `admin` → admin + member, `member` → member, `guest` → guest. Поле `role` остаётся «старшей встроенной ролью» для клиентов до 0.6.0 (`WorkspaceMember.role`); свои роли назначаются отдельно (`member_roles`) и переживают смену встроенной. Имена встроенных ролей — ключи (`owner` …), клиент показывает локализованные.
- Новая своя роль встаёт в самый низ своих (position 2, остальные сдвигаются вверх, `ROLE_UPDATE`); порядок — `PUT …/roles/order` (свои роли от старшей к младшей).
- **Управление** (право `MANAGE_ROLES`, у admin — через `ADMINISTRATOR`): создавать, менять, удалять и переставлять можно только роли **ниже своей старшей** (владелец — любые); `ADMINISTRATOR` своей роли не выдаётся никогда; не-админ не может менять у роли `MANAGE_ROLES` / `MANAGE_WORKSPACE` и биты, которых нет у него самого. Создать роль может только тот, у кого старшая роль выше position 2.
- **Назначение** `PUT …/members/{userId}/roles {role_ids}` (`MANAGE_MEMBERS` или `MANAGE_ROLES`, ADR-0048) — полный набор ролей: `member`/`guest` сохраняется сам и не меняется (гость → участник — `promote`); `owner` не выдаётся и не снимается; `admin` — только владелец; каждая добавляемая/снимаемая роль — ниже старшей роли действующего и (для не-админа) без прав сверх его собственных; старшая роль цели — ниже старшей роли действующего (кроме себя).
- **Удаление** своей роли: её держатели остаются со своими прочими ролями (у каждого есть `member`/`guest` — это и есть «роль по умолчанию»), её переопределения в комнатах удаляются (`ROLE_DELETE` + `ROOM_PERMISSIONS_UPDATE`).
- Legacy `PATCH …/members/{userId} {role}` (`MANAGE_MEMBERS`, ADR-0048) меняет только встроенную роль, свои роли сохраняются.

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
  MANAGE_WORKSPACE: 1n << 9n,   // настройки, оформление, тариф, политика гостей, опасная зона (остальное вынесено: ADR-0043, ADR-0048)
  ADMINISTRATOR:    1n << 10n,  // всё, игнорирует deny
  MOVE_MEMBERS:     1n << 11n,  // перемещать других между voice-комнатами, входить сверх user_limit
  MANAGE_NICKNAMES: 1n << 12n,  // менять ники других (только уровень workspace)
  MENTION_EVERYONE: 1n << 13n,  // @everyone / @here (у member по умолчанию нет)
  VIDEO:            1n << 14n,  // веб-камера в voice (у member по умолчанию есть)
  MANAGE_ROLES:     1n << 15n,  // свои роли ниже своей старшей и их назначение (только уровень workspace, ADR-0026)
  MANAGE_STICKERS:  1n << 16n,  // «Стикеры и звуки»: стикерпаки и саундборд пространства (только уровень workspace, ADR-0030, ADR-0036)
  // Доски задач (ADR-0042): только для досок (BOARD_ONLY), в переопределениях комнат игнорируются
  VIEW_BOARD:       1n << 17n,  // видеть доску, задачи, комментарии; комментировать; подписываться
  CREATE_TASKS:     1n << 18n,  // создавать задачи; править свои и назначенные на себя
  EDIT_TASKS:       1n << 19n,  // править, двигать, архивировать любые задачи; модерация комментариев
  MANAGE_BOARD:     1n << 20n,  // статусы, лейблы, вехи, настройки, доступ, архив доски
  // Приглашения (ADR-0043): и на роли, и в переопределениях комнаты; MANAGE_* их не дают; гостям — никогда
  INVITE_MEMBERS:   1n << 21n,  // инвайты в пространство (ссылки, email, добавить); в комнате — ссылка «только для участников»
  INVITE_GUESTS:    1n << 22n,  // гостевые ссылки комнаты, их подтверждение, решение по ожидающим гостям, гостевые ссылки встреч
  CREATE_TEMP_ROOMS: 1n << 23n, // временные комнаты (ADR-0044); только уровень workspace, у member по умолчанию, гостям — никогда
  PLACE_CALLS:      1n << 24n,  // звонки на телефонные номера из голосовой комнаты (ADR-0046); и на роли, и в комнате; по умолчанию — никому, гостям — никогда
  // Роли v2 (ADR-0048): вынесены из MANAGE_WORKSPACE, только уровень workspace; MANAGE_WORKSPACE их не даёт,
  // ADMINISTRATOR — даёт; миграция 00052 выдала их всем ролям с MANAGE_WORKSPACE; member/guest — нет
  CREATE_BOARDS:    1n << 25n,  // создавать доски
  MANAGE_MEMBERS:   1n << 26n,  // исключать, банить, бейджи, гость → участник, назначать роли ниже своей
  MANAGE_BOTS:      1n << 27n,  // боты пространства
  MANAGE_INTEGRATIONS: 1n << 28n, // телефония (настройки), GPTunneL, будущие интеграции
  VIEW_JOURNALS:    1n << 29n,  // журнал звонков, журнал/экспорт досок (то, что видно)
  MANAGE_EVENTS:    1n << 30n,  // чужие встречи
  MANAGE_RECORDINGS: 1n << 31n, // удалять записи любой видимой комнаты, allow_recording
  // proto-enum int32: MANAGE_RECORDINGS там = -2147483648 (читается как беззнаковое); биты от 1 << 32 enum не вмещает
} as const;
```

Дефолты встроенных ролей — в таблице «Роли workspace» выше (права `member`/`guest` редактируются).

Где какой бит проверяется (сервер, клиент, LiveKit grant) — `docs/16-permissions-matrix.md`.

Вычисление эффективных прав в комнате (единственная функция `computePermissions` в `packages/protocol`, зеркало — Go `internal/perm`, общие тест-векторы `proto/testdata/permissions.json`; сервер проверяет, клиент — для UI):

```
base   = OR(roles[].permissions)                     (права пространства; без переопределений)
if room.restricted:                                   (ADR-0029, ADR-0048)
    if owner → all;  base &= ~(ADMINISTRATOR | VIEW_ROOM)   (админы — как участники; впускает только переопределение)
elif base & ADMINISTRATOR → all                      (owner/admin: переопределения, в т.ч. deny, не действуют)
perms  = base
for role in roles sorted by position ASC:            (младшие первыми, старшая последней — её слово решает)
    perms &= ~roleOverride[role].deny;  perms |= roleOverride[role].allow
perms &= ~userOverride.deny;  perms |= userOverride.allow   (персональное — приоритетнее всех ролей)
if !(perms & VIEW_ROOM) → 0
```

`ADMINISTRATOR`, `MANAGE_WORKSPACE`, `MANAGE_NICKNAMES`, `MANAGE_ROLES`, `MANAGE_STICKERS`, `CREATE_TEMP_ROOMS` и семь битов ADR-0048 (`WorkspaceOnly` / `WORKSPACE_ONLY_PERMISSIONS`) — только уровень пространства (и в переопределениях досок тоже игнорируются), в переопределениях комнаты запрещены (API отвечает `422`), а `computePermissions` их в переопределениях игнорирует (`allow`/`deny` маскируются `RoomOnly` / `ROOM_ONLY_PERMISSIONS`). `INVITE_MEMBERS` / `INVITE_GUESTS` (ADR-0043) и `PLACE_CALLS` (ADR-0046) — и на ролях, и в переопределениях комнаты; гостям сервер их не даёт по роли, что бы ни стояло в битах. Цель `role` в `room_permissions` — id роли (миграция 00021 перевела `member`/`guest` на id встроенных; API по-прежнему принимает имена встроенных ролей и сохраняет их id).

Приватная комната = override для роли `member` с `deny: VIEW_ROOM` + allow для своих ролей или конкретных пользователей (гостям `VIEW_ROOM` и так не положен).

**Закрытые комнаты и доски (ADR-0029 → ADR-0048).** Приватная комната с `rooms.restricted = true` или приватная доска с `boards.restricted = true` (CHECK: только при `is_private`): `ADMINISTRATOR` обхода не даёт, а `VIEW_ROOM` / `VIEW_BOARD` из прав ролей снимается — впускает только `allow` в переопределении этого объекта (по роли или лично); впущенный получает свои права ролей (кроме `ADMINISTRATOR`) плюс переопределения. Биты пространства (`MANAGE_*`, `VIEW_JOURNALS`, `MANAGE_RECORDINGS` …) объект не открывают. Владелец (встроенная роль `owner`, её держит только `owner_id`) — всё всегда; суперадмин продукта — без обхода; гость на закрытой доске — никогда. Ставит и снимает `MANAGE_ROOM` / `MANAGE_BOARD` на объекте (`PATCH /api/rooms/{id}` / `PATCH /api/boards/{id} {restricted}`; создатель временной комнаты и доски — тоже); закрывший (не владелец) получает личное `allow VIEW_* | MANAGE_*`, чтобы не запереть себя; владелец открывает всегда. Чужим — 404 везде (списки, поиск, упоминания, уведомления, календарь, задачи, журналы, экспорт, записи, файлы). Роль, открывающую закрытый объект, не-владелец, который его не видит, выдать/снять/переставить не может (`403 OWNER_ONLY`, `restrictedGuard`). `computePermissions({..., restricted, owner})` / `board: {private, guest, restricted, owner}`, векторы в `proto/testdata/permissions.json`.

**DM (ADR-0020).** Роли и overrides не применяются: `computePermissions({dm: {participant}})` (Go: `perm.ComputeDM`) даёт участнику фиксированный набор `VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES` (= 7), остальным — 0 (тест-векторы `roomType: "dm"` в `proto/testdata/permissions.json`). Остальные пункты ADR ложатся на правила, а не на биты: чтение истории — `VIEW_ROOM`, реакции — `SEND_MESSAGES`, правка/удаление своих сообщений — право автора везде, закреп в DM разрешён обоим участникам по типу комнаты. `MANAGE_MESSAGES`, `MENTION_EVERYONE`, модерации и голоса в DM нет.

**Доски (ADR-0042).** Та же функция с переопределениями доски: `computePermissions({roles, roleOverrides, userOverride, board: {private, guest, restricted, owner}})` (Go: `perm.ComputeBoard` / `ComputeBoardIn`). Порядок тот же (`ADMINISTRATOR` → всё, кроме закрытой доски; роли снизу вверх, затем пользователь), но переопределения трогают только `BOARD_ONLY` (`VIEW_BOARD | CREATE_TASKS | EDIT_TASKS | MANAGE_BOARD`), а переопределения комнат, наоборот, биты досок игнорируют (`ROOM_ONLY` их не содержит). Приватная доска сначала снимает `VIEW_BOARD` из прав ролей — видят только те, кому его дало переопределение (роль или лично; прочие биты досок — из ролей); без `VIEW_BOARD` — 0; гость (старшая встроенная роль `guest`) — всегда 0. Векторы `board` в `proto/testdata/permissions.json`. Комната задачи: `perm.TaskRoom` / `taskRoomPermissions` — `VIEW_BOARD` → `VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES` (у архивной задачи — только `VIEW_ROOM`), `EDIT_TASKS` → `+ MANAGE_MESSAGES`.

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

- `workspace_plans(workspace_id PK, plan free|team|enterprise|custom, limits jsonb, valid_until, note, updated_by, updated_at)`; нет записи → `free`. `limits` хранится только у `custom` (как записано, 0 = без лимита); `free` / `team` / `enterprise` берут лимиты из env `PLAN_FREE_LIMITS` / `PLAN_TEAM_LIMITS` / `PLAN_BUSINESS_LIMITS` (JSON поверх встроенных дефолтов, ключи ниже). Значение `PLAN_ENTERPRISE` в БД и протоколе — облачный тариф **Business** (владелец, 30.09; в интерфейсе везде «Business»); «Enterprise» теперь значит свой сервер без лимитов (self-hosted). Истёкший `valid_until` → лимиты `free`, запись остаётся (`Workspace.plan.expired = true`). Каждое изменение через admin API пишется в `workspace_plan_log` (кто, план, лимиты в силе на момент изменения, срок, заметка).
- Ключи (в скобках — Free, владелец 28.09): `room_members` (5), `members` (50: участники без гостей, боты считаются), `audio_tier_max_kbps` (16 = «Нормальное»; 0 | 8 | 16 | 32 | 64), `stream_max_preset` (`h720`), `stream_max_fps` (15), `camera_max_preset` (`h720`), `camera_max_fps` (15), `streams_per_room` (1), `storage_mb` (5120 = 5 ГБ), `sticker_packs` (1) и `stickers` (200 на пространство, ADR-0030), `bots` (1: ботов-участников пространства, ADR-0031), `boards` (3: досок задач, живых и в архиве, ADR-0042; жёсткий предел — 50). Флаги-«выключено» (ноль = есть): `caldav_disabled` (Free), `musician_disabled` (Free; режим музыканта, ADR-0052), `checklists_disabled` (Free), `board_webhooks_disabled` (Free, Team; ADR-0058 §5), `telephony_disabled` (Free, Team; телефония SIP — только Business и on-prem, владелец 02.10, ADR-0046); `automations_disabled` (Free; автоматизации досок, ADR-0060); `cameras_per_room` — потолок для `camera_limit` комнаты/пространства (эффективное = min).

  | | Free | Team | Business (`PLAN_ENTERPRISE`) | Enterprise (свой сервер) |
  |---|---|---|---|---|
  | Голосовая комната | 5 | 15 | 50 | ∞ |
  | Участники пространства (гости не считаются) | 50 | 100 | 500 | ∞ |
  | Качество звука | до «Нормальное» (16) | любое, до «Отличное» | любое | любое |
  | Качество стрима и камеры | 720p / 15 fps | ∞ | ∞ | ∞ |
  | Стримов в комнате | 1 | 2 | 5 | ∞ |
  | Камер в комнате | 3 | 10 | 25 | ∞ |
  | Файлы | 5 ГБ | 300 ГБ | 1 ТБ | ∞ |
  | Боты | 1 | 5 | 20 | ∞ |
  | Стикерпаки | 1 (200 стикеров) | ∞ | ∞ | ∞ |
  | Доски задач | 3 | 30 | 50 | ∞ (≤ 50) |
  | CalDAV | — | есть | есть | есть |
  | Режим музыканта (ADR-0052) | — | есть | есть | есть |
  | Согласование задач (ADR-0049) | — | — | есть | есть |
  | Веб-приложения в рейле (ADR-0050) | — | — | есть | есть |
  | Телефония SIP (ADR-0046) | — | — | есть | есть |
  | White-label | — | — | — | только self-hosted |
  | Поддержка | — | поддержка | приоритетная | — |

  Self-hosted (Enterprise) — лимиты задаёт оператор своего сервера (`PLAN_FREE_LIMITS` / `PLAN_TEAM_LIMITS` / `PLAN_BUSINESS_LIMITS`: ключ `0` / `false` снимает лимит, например `{"caldav_disabled":false}` для Free; план пространства — через суперадмина). Индивидуальный (`custom`) берёт только записанные ключи: отсутствующие флаги = функция включена, кроме `board_webhooks_disabled` и `telephony_disabled` — без ключа они `true` (`plans.CustomBase`: функции Business не появляются у старой записи сами).
- Функции по тарифу: `409 CONFLICT`, `reason = PLAN_LIMIT`, `used = limit = 0` и сообщение с названием функции (`plans.FeatureError`). Функции по тарифу — CalDAV (по человеку, см. ADR-0024 «Уточнение (30.09)»), режим музыканта (по пространству голосовой комнаты, в звонке один на один — по любому пространству человека; ADR-0052), чек-листы и вебхук доски (ADR-0058 §5), телефония SIP (по пространству; ADR-0046, пометка 02.10).
- Сервер (`internal/plans`, кэш 30 с, сброс при изменении на всех инстансах через Redis `plans:changed`) применяет лимиты **для всех, включая владельца** (это не биты прав):
  - вход в голосовую комнату (`/join`, webhook `participant_joined`, перемещение): мест `min(user_limit, room_members)`, pending-устройства и гости считаются; упор в лимит плана → `409 ROOM_FULL`, `reason = PLAN_LIMIT`, `used`/`limit`. `user_limit` комнаты по-прежнему не действует на `MOVE_MEMBERS`, лимит плана — действует;
  - стрим: пресет ≤ `min(max_stream_preset комнаты, stream_max_preset)`, стримов ≤ `min(max_streams, streams_per_room)` (и при выдаче слота, и в webhook), fps ≤ `stream_max_fps`; камера: пресет/fps ≤ `camera_max_*` (ответ `/camera/request`);
  - файлы: квота = `min(storage_quota_bytes, storage_mb MiB)`; превышение → `413 FILE_QUOTA_EXCEEDED` c `used`/`limit` (байты), `reason = PLAN_LIMIT`, если упёрлись в план;
  - участники, боты, стикерпаки, доски — одна проверка `plans.Service.Check` (advisory-lock + счётчик в транзакции добавления) → `409 CONFLICT`, `reason = PLAN_LIMIT`, `used`/`limit`. Место занимают участники без гостей, бот — тоже; проверка на ссылке-приглашении и email-приглашении (заранее), входе/регистрации по коду, открытом пространстве, добавлении по поиску, создании/добавлении бота, повышении гостя; авто-принятие email-приглашения при нехватке мест ждёт;
  - звук: уровень комнаты / дефолта пространства выше `audio_tier_max_kbps` → `409 CONFLICT PLAN_LIMIT` (кроме уже сохранённого значения); при входе `media.audio_bitrate_kbps = min(комната, план)`.
- `Room.media` остаётся настройками комнаты (UI различает замок «комната» и замок «тариф»); эффективные лимиты плана — в `Workspace.plan.limits` и в ответе `/join` (`media` уже урезан планом, `plan_limits`).
- Суперадмин — пользователь с email из `SUPERADMIN_EMAILS`; флаг не хранится, вычисляется из текущего email при каждом запросе (`Me.is_superadmin`).

## Бейджи участников (docs/09 #82)

- Библиотека пространства (`workspace_badges`, ≤ 20): название 1..32 + картинка — файл этого пространства, загруженный самим администратором (не чужой — бейдж делает файл читаемым всем участникам; не файл стикера; строка `files`, в квоте), PNG / WebP / JPEG ≤ 128 КБ и ≤ 256×256 (размеры сервер берёт из `files.width/height`, измеренных при загрузке). Клиент перед загрузкой обрезает картинку до квадрата и рисует 64×64 WebP (`lib/badgePrepare`). У участника — один бейдж (`workspace_members.badge_id`, `WorkspaceMember.badge_id`); бейдж — свойство членства в пространстве, в DM не показывается.
- Права: библиотека (создать / переименовать / сменить картинку / удалить) — `MANAGE_MEMBERS` (ADR-0048); назначить / снять — `MANAGE_NICKNAMES` + иерархия `workspaces.outranks` (себе — можно), у ботов бейджа нет (403); список видят все участники (и гости), картинку бейджа читает любой участник пространства (`files.CanRead`, `IsWorkspaceBadge`). Бот-токен: управление — 403 `BOT_NOT_ALLOWED`, `GET …/badges` и `badge_id` у участника — читаются.
- Доставка как у ролей (ADR-0026): `WorkspaceSnapshot.badges` в READY / WORKSPACE_CREATE, события `BADGE_CREATE` / `BADGE_UPDATE` / `BADGE_DELETE` всем участникам, смена бейджа участника — `WORKSPACE_MEMBER_UPDATE`. Удаление бейджа снимает его у всех (сначала `WORKSPACE_MEMBER_UPDATE` каждому, затем `BADGE_DELETE`); прежняя картинка без ссылок уходит с чисткой сирот (она пропускает живые картинки бейджей).

## Ачивки (ADR-0061, миграции 00061, 00063)

- Каталог — у каждого пространства (`achievements.workspace_id`, ≤ 100, иначе 409 `CONFLICT` reason `ACHIEVEMENT_LIMIT` с used/limit); ведут владелец и админы (`MANAGE_WORKSPACE`, не гость) в настройках пространства: `POST /api/workspaces/{id}/achievements {title, description, fileId}`, `PATCH /api/achievements/{id} {title?, description?, position?, archived?, fileId?}`, `DELETE /api/achievements/{id}`; бот-токен — 403 `BOT_NOT_ALLOWED`; приостановленное пространство — 403 `WORKSPACE_SUSPENDED` на все три. Картинка — как у бейджа: своя загрузка в это пространство (PNG / WebP ≤ 4 МБ, сторона 128..2048, с альфой — иначе 422 `IMAGE_NEEDS_ALPHA`, не стикер); сервер делает **новый** файл пространства 512×512 WebP с альфой (`achievements.PrepareAchievement`: обрезка по видимой части +4 %, по центру) в квоте пространства, исходная загрузка уходит с чисткой сирот. Чтение картинки — `GET /api/files/{fileId}` любым участником (и гостем) через `files.CanRead` (`IsWorkspaceAchievement`); чистка сирот живые картинки ачивок пропускает. Замена картинки — новый файл, старый уходит с чисткой сирот. Архив (`archived_at`) — нельзя вручать, вручённые видны; удалить можно только ни разу не вручённую (иначе 409 `ACHIEVEMENT_IN_USE`).
- `GET /api/workspaces/{id}/achievements` — каталог по `position` (архивные с `archived_at`, `grantedCount` — живые вручения, `inUse` — вручали хоть раз), любой участник (гости, боты), `ETag` / 304. Изменение каталога — событие `WORKSPACE_ACHIEVEMENTS_UPDATE {workspace_id}` всем участникам (клиент перечитывает список); в READY каталог не кладётся.
- Миграция 00063 (хост → пространства): вручённая ачивка хоста копируется в каждое пространство, где есть её вручения (новый id, вручения и открытки `system.achievement.achievementId` перепривязаны), невручённые удаляются, затем `workspace_id NOT NULL`. Байты картинок — задача запуска `achievements.MigrateLegacy` (идемпотентна, по одной строке в транзакции, `SKIP LOCKED`): из `legacy_image_key` делает файл пространства (вне проверки квоты, но с учётом в `storage_used_bytes`; загрузивший — владелец пространства), затем удаляет старые блобы `achievements/*` из `achievement_legacy_blobs`. Пропавший блоб — ачивка без картинки (`file_id` пуст, клиент рисует заглушку).
- Вручение (`member_achievements`) — `MANAGE_MEMBERS`; ачивка — из каталога этого пространства; получатель — участник, не гость, не бот, не сам вручающий (422 `SELF_GRANT`); `note` («за что») 1..120 обязательно; ачивку можно вручить повторно. Отзыв — `revoked_at` (строка остаётся, открытка в чате тоже). Список живых — любой участник, гость — только видимых ему (правило профиля ADR-0051); боты читают, вручать/отзывать — 403 `BOT_NOT_ALLOWED`.
- `workspace_members.achievement_count` = число живых вручений (`WorkspaceMember.achievement_count`), пересчитывается в транзакции вручения/отзыва (и триггером при повторном вступлении); изменение — `WORKSPACE_MEMBER_UPDATE`.
- Открытка (`announce = true`): в той же транзакции системное сообщение `system.achievement {achievement_id, grant_id, note, granted_by}`, автор — получатель, в комнату `announcement_room()` (первая текстовая, неприватная предпочтительнее — то же правило, что у открытки дня рождения) + строка `message_mentions` получателя (инбокс «Упоминания», счётчики). Нет текстовой комнаты — вручение без открытки (`message_id` пуст).

## Фоны пространства (ADR-0035, дополнение 29.09)

- Фоны камеры, которые админ добавляет для всех (`workspace_backgrounds`, ≤ 20, без лимита тарифа): название 1..40 + файл. Источник — своя загрузка в это пространство (правило бейджей: не чужой файл, не стикер), JPEG / PNG / WebP ≤ 10 МБ; клиент заранее режет его до 16:9 1280×720 WebP (тот же `prepareUpload`, что у своих картинок), а сервер всё равно делает **новый** файл сам: центр 16:9 → 1280×720 WebP + миниатюра 320×180 (`files.PrepareBackground`, отдаётся `GET /api/files/{id}/thumbnail`), резервирует его в квоте хранения пространства (413 при нехватке). Исходная загрузка остаётся неприкреплённой и уходит с чисткой сирот.
- Права: список и картинка — любой участник, гости тоже (`files.CanRead`, `IsWorkspaceBackground`, как иконка); создать / переименовать / удалить — `MANAGE_WORKSPACE`; бот-токен — 403 `BOT_NOT_ALLOWED` на всех маршрутах (у ботов нет камеры).
- Доставка: `WorkspaceSnapshot.backgrounds` в READY / WORKSPACE_CREATE, события `BACKGROUND_CREATE` / `BACKGROUND_UPDATE` / `BACKGROUND_DELETE` всем участникам. Удаление убирает только строку: картинка без ссылок уходит с чисткой сирот (живые фоны она пропускает), выбор у пользователей сбрасывает клиент.
- Клиент: выбор — настройка устройства `cameraBackground.imageId = ws:<id>`; картинка скачивается один раз и лежит в IndexedDB (`calaba-workspace-backgrounds`, последние 3). Если выбранного фона больше нет (BACKGROUND_DELETE, пространство покинуто/удалено, нет после READY) — выбор сбрасывается на «Нет».

## Саундборд (ADR-0036)

- Библиотека пространства (`workspace_sounds`, ≤ 50, без лимита тарифа): название 1..32, эмодзи (одна или пусто), клип, длительность, порядок. Источник — своя загрузка в это пространство (правило бейджей: не чужой файл; не стикер, бейдж, фон или клип другого звука), MP3 / Ogg / WAV ≤ 2 МБ; сервер делает из неё **новый** файл сам (`files.PrepareSound`: `ffmpeg` → Ogg/Opus 48 кГц моно, −16 LUFS, ≤ 5 с; длительность — по гранулам последней страницы Ogg) и резервирует его в квоте хранения (413). Исходная загрузка остаётся неприкреплённой и уходит с чисткой сирот; без `ffmpeg` добавление отвечает 503.
- Права: список и клип — любой участник, гости тоже (`files.CanRead`, `IsWorkspaceSound`); создать / изменить (название, эмодзи, файл, позиция) / удалить — `MANAGE_STICKERS` («Стикеры и звуки», без нового бита); бот-токен: `GET …/sounds` и play — можно, управление — 403 `BOT_NOT_ALLOWED`.
- Проиграть: `POST /api/rooms/{id}/sounds/play` — вызывающий подключён к звонку этой комнаты (голосовое состояние, не «подключается»), звук — `builtin:<имя>` или звук пространства комнаты; 1 нажатие в 2 с на пользователя и 5 в 10 с на комнату (429). В DM-звонках звуков нет (422).
- Доставка: `WorkspaceSnapshot.sounds` в READY / WORKSPACE_CREATE, `SOUND_CREATE` / `SOUND_UPDATE` (перенос — каждому сдвинутому) / `SOUND_DELETE` всем участникам; `SOUND_PLAY` — только тем, кто в звонке. Удаление убирает строку, клип без ссылок уходит с чисткой сирот. Избранное и «Часто используемые» — настройки устройства.

## Стикеры (ADR-0030)

- Пак принадлежит пространству; стикер — WebP-файл пространства (строка `files`, ключ `<workspace>/<file_id>`, в квоте хранения, без превью) + эмодзи для поиска. Сервер разбирает контейнер сам (`internal/stickers.ValidateWebP`): `RIFF`/`WEBP`, размер RIFF = файлу, только известные чанки, стороны 1..512, анимация — `VP8X` + `ANIM` + 1..300 `ANMF` в пределах canvas, ≤ 10 с; ≤ 512 КБ статичный, ≤ 1 МБ анимированный; ≤ 120 стикеров в паке, ≤ 50 за загрузку, ≤ 50 установленных паков у пользователя.
- Права: управление паками — `MANAGE_STICKERS` (у owner/admin через `ADMINISTRATOR`); видеть паки и стикеры в ленте — все участники (и гости); устанавливать и отправлять — не-гости. Пак пространства W используется в комнатах W и в DM, где оба участника — не-гости W. Файл стикера читает участник W или тот, кто видит комнату с живым сообщением-стикером.
- Удаление не ломает историю: стикер (или пак), который показывает хоть одно сообщение, помечается `deleted_at` и уходит из пикеров; без ссылок — удаляется, файл забирает чистка сирот (она пропускает файлы живых стикеров). Удалённый пак снимается у всех.
- Встроенный `Calab Stikers` (ADR-0057): глобальный read-only пак с NULL workspace_id и file_id у стикеров; фиксированные ID внесены миграцией, картинки встроены в сервер и клиент. Всегда первым в installed, вне квот; не удаляется/не переставляется. Доступен всем тарифам, включая гостей; в комнатах требует SEND_MESSAGES, в DM не требует общего пространства. Обычные паки сохраняют прежние правила.
- Сообщение-стикер: `messages.sticker_id`, пустой `content`, без вложений, правка запрещена (`403`); ответ и реакции — как обычно.

## Приостановка пространства и баны (docs/09 #32)

- **Приостановка** — только суперадмин (`PUT /api/admin/workspaces/{id}/suspension`): `workspaces.suspended_at / suspended_reason (≤ 500) / suspended_by`, каждое действие — в `workspace_admin_log (actor, action suspend|resume, reason)`. Приостановленное пространство — только для чтения, для всех ролей, владельца тоже: сервер отказывает `403 WORKSPACE_SUSPENDED` на отправку и правку сообщений, реакции, файлы, вход в голос и перемещение, стрим/камеру, запись, инвайты (обычные, по email, ссылки в комнату) и любой вход в пространство; все звонки завершаются (LiveKit `RemoveParticipant`). Чтение, история, READY, выход и управление участниками работают. Отказ — одна таблица маршрутов в `internal/moderation` (middleware после проверки прав), публичные ссылки в комнату и регистрация по инвайту проверяют сами. Причину видят только owner / admin (`Workspace.suspension.reason`), остальным — только факт.
- **Бан** (`workspace_bans(workspace_id, user_id, email, reason, banned_by, created_at)`, PK `(workspace_id, user_id)`): право — как у «Исключить» (`MANAGE_MEMBERS`, ADR-0048; владельца нельзя, админа — только владелец, себя — нельзя). Бан = исключение + отзыв ожидающих email-приглашений на адрес + отказ `403 BANNED` на любом пути назад: инвайт, открытое пространство, добавление по поиску, email-приглашение (и авто-принятие после подтверждения почты), регистрация по инвайту с тем же адресом, ссылка в комнату. `email` — адрес аккаунта на момент бана (у гостя нет: гость банится по своему гостевому аккаунту; новый анонимный гость по той же ссылке не распознаётся — ссылку стоит отозвать). Разбан не возвращает членство.

## Запись встреч (ADR-0025)

- **Подключение GPTunneL** — на пространство: код из GPTunneL → `POST /v1/meetings/device/pair` → device token хранится зашифрованным в `workspace_integrations` (ключ из `JWT_SECRET`, назначение `calaba/workspace-integration/v1`). Подключает/отключает `MANAGE_INTEGRATIONS` (ADR-0048); статус видят все участники, кроме гостей. 401 от GPTunneL (устройство отозвано в вебе) → токен забывается, запись падает с `device_revoked`.
- **Кто пишет**: участник пространства (не гость) с `VIEW_ROOM | CONNECT` в голосовой комнате, где идёт звонок и `allow_recording = true` (выключает `MANAGE_ROOM` + `MANAGE_RECORDINGS`, ADR-0048; выключение останавливает идущую запись). Одна запись на комнату, не больше `RECORDING_MAX_CONCURRENT` на сервер (под `pg_advisory_xact_lock`).
- **Жизнь записи** (`room_recordings.status`): `pending` (строка до старта egress) → `recording` (egress идёт; стоп — `stopped_at`/`stop_reason`, строка остаётся `recording`, пока egress не отдаст файл) → `uploading` (файл на томе, очередь) → `processing` (загружено, GPTunneL распознаёт; `web_url`) → `done` (файл удалён) | `failed` (`error`). Авто-стоп: 3 ч 58 мин (GPTunneL принимает ≤ 4 ч / ≤ 4 ГБ; сверх — `failed: too_large` без загрузки), звонок пуст 2 мин, комната запретила запись. Файлы `failed` удаляются через 7 дней (janitor), бесхозные `.mp4` — через 8.
- **Воркер**: один на кластер (блокировка Valkey `rec:worker`), очередь — строки `uploading|processing` с `next_at` (захват сдвигает `next_at` на аренду 15 мин). Загрузка — кусками 8 МБ с `Content-Range`, докачка по `Upload-Offset`/409/HEAD, ретраи с backoff 30 с → 30 мин ≤ 24 ч; опрос статуса 20 с → 5 мин ≤ 2 ч (`timeout`). Reconcile (раз в 15 с): строки без живого egress забираются (файл есть → загрузка, нет → `failed`), `pending` старше 2 мин падают, наши egress без строки останавливаются.
- **Пересланная карточка** (ADR-0033 §4): копия — тоже `kind = system` с тем же `payload`; `System.Update` обновляет и живые копии (`forwarded_from = message_id`), сохранённое аудио прикрепляется и к ним; транскрипт отдаётся и в комнате с живой копией (`RecordingVisibleInRoom`); удалить/повторить — только из комнаты записи.

## Звонки (ADR-0034)

- **Состояние — в Valkey** (сервер stateless, `internal/calls`): `call:<id>` — JSON `{id, dm, from, to, st, c, a, e, r, away}`, TTL 24 ч (продлевается при ответе); `user_call:<uid>` → id RINGING/ACTIVE-звонка пользователя (занятость, `READY.call`); `call:oncall:<uid>` — пока звонок ACTIVE (`Presence.on_call`); `call:ringing` (zset по дедлайну) и `call:active` — для подметальщика. Каждый переход — один Lua compare-and-set записи и индексов: второй `accept`/`hangup` видит новое состояние → `409`. Старт — Lua: `user_call` звонящего есть → `IN_CALL`, вызываемого → `BUSY` (звонок не создаётся, в DM пишется карточка BUSY).
- **Состояния**: `RINGING → ACTIVE → ENDED`, `RINGING → DECLINED | CANCELLED | MISSED`; BUSY — только исход карточки. Кто что может — `call.proto`; не участник → `404`, чужая сторона → `403`, не то состояние → `409`.
- **Таймеры**: дозвон 45 с → MISSED (таймер инстанса + подметальщик раз в 15 с под блокировкой `calls:sweep`). **Обрыв**: у ACTIVE-звонка в `away` — кто из двоих сейчас без устройства в сессии DM и с какого момента (при ответе — оба); `rtc` сообщает каждое «первое устройство вошло / последнее вышло» (pending тоже считается «в сессии»). Кто-то отсутствует ≥ 30 с (вышел и не вернулся или так и не вошёл) → ENDED `reason: "lost"`; перед этим голосовое состояние перечитывается, пропущенный вебхук звонок не рвёт.
- **Медиа** — голосовая сессия DM-комнаты: скоуп голоса = id DM-комнаты (ключи `voice:*` как у пространства, `RoomName(id, id) = "dm:<id>"`), LiveKit-комната `dm:<room_id>`. `join` — только участнику ACTIVE-звонка этой DM (`409 CALL_NOT_ACTIVE`), `participant_joined` перепроверяет. Grant фиксированный: `microphone, screen_share(+audio), camera`, subscribe, без модерации и лимитов тарифа; медиа — 48 кбит/с, до 1080p, 4 стрима / 4 камеры. Конец звонка закрывает LiveKit-комнату. `voice:sess:<session>` удаляется только в своём скоупе: выход из старой комнаты не стирает место устройства в звонке.
- **Лог** — системное сообщение DM (`kind = system`, `SystemMessage.call`, автор — звонящий) на каждый конец, в т. ч. BUSY. MISSED непрочитан у вызываемого (как входящее сообщение: достаёт DM из архива, уведомление «Пропущенный звонок»); остальные исходы сразу прочитаны обоими (маркер вызываемого двигается, только если в DM у него не было непрочитанного).
- Боты не звонят и не принимают (`botDeny`), позвонить боту, гостю или без общего пространства (полные участники) — `403`.

## Календарь (ADR-0038)
- `events` — встреча или серия: `room_id` (голосовая комната, `NULL` — без комнаты), `title` ≤ 120, `description` ≤ 4000, `starts_at`/`ends_at` (UTC, конец > начала, ≤ 7 дней), `all_day` (полночи зоны `tz`), `tz` — зона организатора, `organizer_id`, `record`, `rrule` (подмножество RFC 5545: `FREQ=DAILY|WEEKLY|MONTHLY`, `INTERVAL=2` для раза в две недели, `UNTIL`), `until_at` (верхняя граница конца последнего вхождения; `NULL` — бесконечная серия), `sequence` (iCalendar SEQUENCE: +1 на каждое изменение, ушедшее письмом), `cancelled_at`.
- `event_attendees` — участник пространства (`user_id`) или внешний адрес (`email citext`), ровно одно; `required`, `status pending|accepted|declined|maybe`, `responded_at`, `invite_id` (гостевая ссылка внешнего, `room_invites`). Ссылки внешнего в письме подписаны HMAC (ключ из `JWT_SECRET`) и в БД не хранятся: answer-токены (accepted/declined/maybe) и view-токен (`/e/<id>?t=`, только чтение, срок — конец встречи/серии + 1 ч). Организатор — всегда участник (`accepted`). ≤ 100 всего, ≤ 20 внешних; участники — не боты и не гости пространства.
- `event_exceptions (event_id, occurrence_at)` — отменённые вхождения серии; `event_recordings (event_id, occurrence_at, recording_id)` — запись вхождения (организатор начал запись в окне [начало − 15 мин; конец)).
- `event_reminders_sent` / `event_room_signals` — дедуп напоминаний и `ROOM_EVENT_ACTIVE/ENDED` (метёлка на каждом инстансе, вставка «забирает» отправку; старше 3 суток удаляются).
- `users.event_reminders smallint[]` (по умолчанию `{60,5}`, ≤ 5 значений из 5/10/15/30/60/120/1440) и `event_reminders_dnd` (напоминать при «Не беспокоить», по умолчанию да) — отдельно от `settings` jsonb: `PATCH /api/me {settings}` их не затирает.
- `room_invites.not_before` / `event_id` — гостевая ссылка встречи работает с 15 минут до начала.
- Видимость: не гость видит встречу, если он организатор/участник или видит её комнату (`VIEW_ROOM`); встречу без комнаты — только её участники. Менять/отменять — организатор, иначе `MANAGE_ROOM` в комнате встречи или `MANAGE_EVENTS` (ADR-0048; встреча без комнаты или в видимой комнате). Гости календаря не видят; боты только читают (без адресов внешних).
- **Свободно/занято и CalDAV (ADR-0041).** `users.work_start_min / work_end_min smallint` (минуты от полуночи зоны пользователя, по умолчанию 600 / 1140) и `work_days smallint[]` (1 = пн … 7 = вс, по умолчанию `{1,2,3,4,5}`) — рабочие часы, отдельно от `settings` jsonb (как напоминания). `caldav_accounts` (PK `user_id`): `url`, `username`, `secret_enc` (пароль, AES-GCM `sealbox` «calaba/caldav/v1» из `JWT_SECRET`, привязан к `user_id`; в API не отдаётся), `calendars jsonb` (найденные календари `[{href, name, color}]`), `calendar_href`, `import` (по умолчанию да), `push` (нет), `last_sync_at`, `last_error`, `share_level` (ADR-0045: `busy` по умолчанию · `title` · `details` — что коллеги видят в freebusy; меняет только владелец, `PATCH /api/me/caldav`), `remind` (ADR-0045 поправка 3: напоминать о внешних событиях по `users.event_reminders`, по умолчанию нет; тот же `PATCH`). `external_reminders_sent (user_id, uid, occurrence_at, minutes)` — дедуп этих напоминаний (как `event_reminders_sent`, чистится той же метёлкой). `external_busy (user_id, uid, starts_at, ends_at, all_day, summary, location, attendees, organizer, url)` — импортированные события окна −1…+30 дней, по строке на вхождение: `uid` — хэш UID события; детали (ADR-0045) — `summary`/`location` ≤ 200 символов, `attendees jsonb` `[{email, name?}]` ≤ 50 (e-mail в нижнем регистре), `organizer` (e-mail), `url` ≤ 500 (`URL` события или первая `https://` из DESCRIPTION; сам DESCRIPTION не хранится); заменяется целиком при каждом импорте. Детали целиком видит только владелец (`GET /api/me/external-events`); коллеги в `freebusy` получают `title` при `title`/`details` и `attendee_user_ids` (участники пространства по подтверждённому `users.email`) при `details` — место, организатор, ссылка и чужие адреса не отдаются никогда. `caldav_pushes (user_id, event_id)` — outbox экспорта встреч: одна строка на пару, `gen` растёт с каждым изменением (доставка старого состояния не удаляет новое), `attempts` ≤ 5, `next_at`; воркер сам решает PUT или DELETE по текущему состоянию встречи.

## Доски задач (ADR-0042, миграция 00046)
- `boards` — доска пространства: `name` 1..60, `key` 2..6 `A–Z0–9` с буквы (уникален в пространстве, пустой → из названия: инициалы слов или 3 буквы, кириллица транслитерируется, занятый → суффикс цифрой), `emoji`, `icon_file_id`, `description` ≤ 2000, `is_private`, `position`, `next_number` (нумерация задач; ключ нельзя менять после первой задачи), `auto_archive_days` (30; 0 — никогда), `default_view_id`, `archived_at`, `restricted` (закрытая, только при `is_private`, ADR-0048, миграция 00052). Создаёт `CREATE_BOARDS`. Создатель получает `board_permissions` user-allow всех битов доски. Шаблоны статусов: «Простая» (Todo / В работе / Готово), «Разработка» (+ Backlog, Ревью, Отменено), «Пустая» (Todo).
- `board_permissions` (как `room_permissions`), `board_statuses` (`type backlog|unstarted|started|completed|cancelled`, ровно один `is_default`; удаление — с `move_to`, у default — нельзя), `board_labels` (имя уникально без регистра), `board_milestones`, `board_views` (`filter` — `TaskFilter` protojson, `shared` / личные). Лимиты: 50 досок (живые + архив), 20 статусов, 50 лейблов и вех, 30 видов, 5000 живых задач (`409 BOARD_TASK_LIMIT`), 200 подзадач, 10 исполнителей, 20 вложений.
- `tasks` — `number` (UNIQUE `(board_id, number)`, ключ `KEY-N`), `title` 1..200, `description` ≤ 20000, `status_id`, `priority` 0..4, `estimate` 1..21, `start_on`/`due_on` (date), `parent_id` (один уровень), `milestone_id`, `position` (double: вставка — середина соседей, конец — +1024; зазор < 1e-6 → перенумерация колонки шагом 1024), `room_id` → `rooms.type = 'task'` (скрытая комната комментариев, `workspace_id` доски: файлы в квоте пространства; не в списках комнат, READY и поиске пространства), `started_at` (первый вход в `started`), `completed_at`/`completed_by` (пока в `completed|cancelled`), `archived_at`. Поиск — GIN по `to_tsvector('simple', title || ' ' || description)` и ключ (`FNG-12` — точно, `FNG` — префикс ключа доски).
- `task_assignees` (≤ 10, ровно один `is_lead`, если есть; `note` ≤ 120, `assigned_by/at`), `task_labels`, `task_relations` (`blocks` хранится один раз, `relates`/`duplicates` читаются в обе стороны), `task_attachments` (файлы описания; сироты-очистка их не трогает, `FileRooms` даёт комнату задачи).
- **Согласование (ADR-0049, миграция 00053).** `tasks.approval_required smallint` (0..10; сколько одобрений нужно, `0` — все); `task_approvers (task_id, user_id, state pending|approved|rejected, comment ≤ 500 — обязателен при rejected, decided_at, added_by, added_at, requested_at, reminders, reminded_at)`, PK `(task_id, user_id)`, ≤ 10 на задачу — участники, видящие доску, не гости и не боты. Кворум = `min(approval_required, число согласующих)`; состояние задачи не хранится, а выводится (`boards.Tally.State` / `ApprovalStateSQL` в фильтре): `none` (нет согласующих) · `rejected` (есть хоть одно отклонение — вето) · `approved` (одобрений ≥ кворума) · `pending`. Пока `pending`/`rejected`, **любой** путь смены статуса (`PATCH` и kanban, массовые действия списка, боты, перенос на другую доску, удаление статуса с `move_to`) не пускает «вперёд» — в статус с большей позицией или в любой `completed` (назад, внутри колонки и в `cancelled` — можно): одна проверка `checkApprovalGate`, ответ `409 CONFLICT` reason `TASK_APPROVAL_REQUIRED`, `used`/`limit` = одобрения/кворум. Правка названия, описания или вложений описания сбрасывает все голоса (`approvals_reset`); задавать согласующих — кто вправе править задачу; голосует только сам согласующий, пока видит доску. Напоминание: голос `pending` 24 ч — повторное `APPROVAL_REQUESTED` раз в сутки, не больше 3 (`requested_at`/`reminded_at`/`reminders`, свипер досок).
- `task_activity` — неизменяемый журнал: `kind created|status|assignees|priority|labels|dates|estimate|parent|milestone|relation|title|description|attachments|archived|restored|moved_board|approvers|approval|approvals_reset`, `before`/`after` jsonb, `actor_id` (человек или бот; `NULL` — метёлка автоархива), удаляется только с доской.
- `task_subscribers (task_id, user_id, muted, notified_at, seen_at)`: автор, исполнители, комментаторы и упомянутые подписываются сами; «Отписаться» = `muted`; непрочитано = `notified_at > seen_at`. Уровень уведомлений «Задачи» — `workspace_notification_settings.task_level` (`all` по умолчанию | `mentions` | `none`), правило `notifications.TaskNotifies` / `taskNotifies` (векторы `task` в `proto/testdata/notifications.json`): назначение и упоминание — при `all`/`mentions`, даже без подписки; комментарий и смена статуса — при `all` подписчикам без `muted`; mute пространства глушит всё. Исключение — согласование (ADR-0049 §5): `approval_requested` (согласующему) и `approved`/`rejected` создателю и ведущему исполнителю (`mandatory`) приходят всегда, в обход уровня, mute пространства и «Отписаться»; остальным `approved`/`rejected` — как смена статуса. Согласующие, создатель и ведущий подписываются автоматически.

### Доски 2.0 (ADR-0058, миграция 00059)
- `board_categories (id uuidv7, workspace_id FK CASCADE, name 1..100, position int, created_at)`, индекс `(workspace_id, position)`, ≤ 50 на пространство (`409 BOARD_CATEGORY_LIMIT`). Отдельны от категорий комнат. `boards.category_id` → `board_categories ON DELETE SET NULL` (доски без категории — хвост), `boards.position` — порядок внутри контейнера. Права: категории — `CREATE_BOARDS`; положить доску — `MANAGE_BOARD` на ней.
- `boards.disabled_features bigint NOT NULL DEFAULT 0` — **хранится выключенное** (бит = номер `BoardFeature`: `ESTIMATE`, `START_DATE`, `DUE_DATE`, `PRIORITY`, `LABELS`, `MILESTONES`, `SUBTASKS`, `RELATIONS`, `APPROVALS`, `CHECKLISTS`, `ATTACHMENTS`, `COMMENTS`, `TIMELINE`), `boards.estimate_scale text DEFAULT 'fibonacci'` (`fibonacci` 1,2,3,5,8,13,21 · `linear` 1..10 · `tshirt` XS=1, S=2, M=3, L=5, XL=8; смена шкалы задачи не переписывает). Меняет `PATCH /api/boards/{id}` (`MANAGE_BOARD`). Данные выключенной фичи не удаляются и отдаются в API и вебхуке. Одна проверка `requireFeature` во всех путях записи: запрос, **меняющий** поле выключенной фичи на непустое, → `409 CONFLICT`, `reason FEATURE_DISABLED`, `field` = JSON-имя поля; сброс в пусто и повтор текущего значения проходят. `COMMENTS` выкл. — комната задачи как у архивной (`perm.TaskRoom(board, archived, commentsOff)` снимает `SEND_MESSAGES | ATTACH_FILES`); `APPROVALS` выкл. — `checkApprovalGate` не применяется.
- `task_checklists (id, task_id FK CASCADE, title 1..100, position int, created_by, created_at)` ≤ 10 на задачу (`409 CHECKLIST_LIMIT`); `task_checklist_items (id, checklist_id FK CASCADE, task_id (денормализовано для счётчиков), text 1..500, done, done_by, done_at, position double, created_by, created_at)` ≤ 100 на чек-лист (`409 CHECKLIST_ITEM_LIMIT`). `Task.checklist_total/checklist_done` — во всех списках, `Task.checklists` — только `GET /tasks/{id}`. Права — как у полей задачи (`EDIT_TASKS`; `CREATE_TASKS` — свои и назначенные), боты так же. Журнал — `task_activity.kind = 'checklist'` (`after.action`: `created|renamed|deleted|item_added|item_edited|item_done|item_undone|item_removed|item_moved|converted`). Тариф: чек-листы с Team (`PlanLimits.checklists_disabled`), ниже — read-only, запись `409 PLAN_LIMIT`.
- `board_webhooks (board_id PK FK CASCADE, url https ≤ 2048, secret_enc bytea (sealbox `calaba/board-webhook/v1`, из `JWT_SECRET`), disabled_at, failing_since, last_ok_at, last_error, next_seq bigint DEFAULT 1, created_by, created_at, updated_at)` — один вебхук на доску; `board_webhook_deliveries (id uuidv7, board_id FK CASCADE, seq, event_type, payload bytea, attempts, next_at, created_at, delivered_at, failed_at, error)` — outbox (строка пишется в той же транзакции, что изменение; доставленные и упавшие чистятся через 7 дней). Настраивает `MANAGE_BOARD` + `MANAGE_INTEGRATIONS`, только Business (`board_webhooks_disabled`), боты — нет. См. docs/19 «Вебхук доски».
- Маршруты (все в `internal/boards`, права на сервере):
  - `GET/POST /api/workspaces/{id}/board-categories`, `PATCH/DELETE /api/board-categories/{id}`, `PUT /api/workspaces/{id}/boards/order {boards[{board_id, category_id, position}], categories[{category_id, position}]}` — один drag = одна транзакция; `PUT /api/boards/{id}/position` + `category_id`.
  - `PATCH /api/boards/{id} {set_disabled_features, disabled_features[], estimate_scale}`.
  - `POST /api/tasks/{id}/checklists`, `PATCH/DELETE /api/checklists/{id}`, `POST /api/checklists/{id}/items`, `PATCH/DELETE /api/checklist-items/{id}` (`checklist_id` — перенос внутри задачи), `POST /api/checklist-items/{id}/convert` (подзадача; фича `SUBTASKS`, задача сама не подзадача).
  - `GET/PUT/DELETE /api/boards/{id}/webhook`, `POST /api/boards/{id}/webhook/ping` (≤ 1 раз в 10 с, иначе `429`).
- Ошибки: `409 CONFLICT` с `reason` — `FEATURE_DISABLED` (+ `field`), `PLAN_LIMIT` (чек-листы / вебхук не в тарифе, `used = limit = 0`), `CHECKLIST_LIMIT`, `CHECKLIST_ITEM_LIMIT`, `BOARD_CATEGORY_LIMIT` (`used`/`limit`); оценка вне шкалы доски — `422 estimate`.

### Автоматизации досок (ADR-0060, миграция 00062)
- `board_rules (id uuidv7, board_id FK CASCADE, name 1..60, enabled, position, trigger_kind, trigger jsonb (RuleTrigger), condition jsonb? (TaskFilter), actions jsonb (RuleAction[] 1..5), created_by, created_at, updated_at, runs_count, last_run_at, last_error)` ≤ 20 на доску (`409 RULE_LIMIT`); индексы `(board_id, position)`, `(board_id) WHERE enabled` (одна проба на транзакцию изменения), `(trigger_kind) WHERE enabled AND` по расписанию. `trigger_kind` — имя case триггера (`status_changed`, `due_in`…).
- `board_rule_runs (id, rule_id FK CASCADE, task_id → tasks SET NULL, trigger_kind, ok, error, actions_applied, sched_key date?, created_at)` — журнал правила; свипер оставляет 100 последних на правило и не старше 90 дней. `UNIQUE (rule_id, task_id, sched_key) WHERE sched_key IS NOT NULL` — правило по расписанию срабатывает один раз на задачу и ключевую дату (срок задачи для `due_in`/`overdue`, дата последнего изменения для `stale`).
- `board_git (board_id PK FK CASCADE, provider github|gitlab|gitea, secret_enc (sealbox `calaba/board-git/v1`), created_by, created_at, last_event_at, last_error, events_count)` — входящий Git-вебхук доски.
- `task_git_links (id, task_id FK CASCADE, kind branch|pr|commit, provider, repo, ref, title ≤ 200, url ≤ 2048, state open|merged|closed|'', author ≤ 100, created_at, updated_at, UNIQUE (task_id, kind, provider, repo, ref))` ≤ 50 на задачу (старые коммиты вытесняются первыми). `Task.git_links` — только `GET /tasks/{id}`, `Task.git_links_count` — везде.
- `task_activity.rule_id uuid NULL` (без FK): запись сделана правилом — `actor_id` NULL. Новые виды журнала: `git` (`after {event, kind, provider, repo, ref, title, url, state, commits[]}`); `approval`/`approvers` получают `after.approval_state`, когда решают согласование.
- Тариф: `PlanLimits.automations_disabled` (Free) — новые правила `409 PLAN_LIMIT`, существующие и Git-события не выполняются.
- Маршруты: `GET/POST /api/boards/{id}/rules`, `PATCH/DELETE /api/rules/{id}`, `POST /api/rules/{id}/test`, `GET /api/rules/{id}/runs`; `GET/PUT/DELETE /api/boards/{id}/git`; публичный `POST /api/git/boards/{id}/{provider}` (подпись провайдера). Права — docs/16, контракт — `proto/calaba/v1/automations.proto`.

### Вехи внутри задачи (ADR-0063, миграция 00066)
- `task_milestones (id uuidv7, task_id → tasks CASCADE, name 1..60, due_on date?, position double, completed_at?, completed_by?, created_by, created_at, updated_at)` ≤ 20 на задачу (`409 TASK_MILESTONE_LIMIT`), у подзадачи вех нет (`422`); индексы `(task_id, position)`, `completed_by`/`created_by` (partial). Вехи доски (`board_milestones`) не меняются.
- `tasks.task_milestone_id → task_milestones ON DELETE SET NULL` (FK добавлен `NOT VALID` + `VALIDATE`, индекс `CONCURRENTLY WHERE NOT NULL`): веха подзадачи — только веха её родителя (`422 taskMilestoneId`); смена родителя сбрасывает ссылку (если в том же запросе не указана веха нового родителя), перенос на другую доску и отцепление подзадач — тоже.
- Прогресс вехи считает сервер (`boards.MilestoneProgress`): живые привязанные подзадачи, `cancelled` не входят в `total`, `done` — в `completed`. Есть что считать (`total > 0`) — `completed_at` ведёт сервер: `syncMilestones` в конце каждой транзакции изменения задачи (`taskTx`, после правил) ставит/снимает его, когда все привязанные закрыты / уже нет, запись журнала `auto_completed`/`auto_reopened` у родителя (актор — автор изменения) и `TASK_UPDATE` родителя; ручной `completed` тогда — `409 TASK_MILESTONE_AUTO`. Нечего считать — веху отмечает человек.
- `Task.milestones` (по позиции, с `done/total`), `Task.milestone_progress {done, total}` (выполненных вех из всех) и `Task.task_milestone_id` — **во всех задачах** (списки, события, REST, вебхук): таймлайн рисует ромбы на полосах, а изменения едут существующим `TASK_UPDATE` задачи (нового события нет). Отступление от ADR-0063 §4 («только `GET /tasks/{id}`») — иначе полосам таймлайна нечего рисовать.
- Права — как у полей задачи (`requireEdit`: `EDIT_TASKS`; `CREATE_TASKS` — свои и назначенные, в т. ч. исполнитель по карточке, ADR-0059), видеть — кто видит задачу; боты так же. Фича доски `MILESTONES` выключена — создание и правка `409 FEATURE_DISABLED` (`field` `milestones` / `taskMilestoneId`), удаление и отвязка проходят. Архивная задача — `409`.
- Журнал `task_activity.kind = 'milestones'`: у задачи `after {action: created|renamed|dated|moved|completed|reopened|deleted|auto_completed|auto_reopened, milestone_id, name, due_on}` (+ `before` — старое имя/дата/позиция); у подзадачи `after {action: linked|unlinked, task_milestone_id, parent_id}`. Вебхук доски и правила (ADR-0060) видят его как любое изменение (`task.updated`, `changes[field=milestones]`).
- Маршруты: `POST /api/tasks/{id}/milestones {name, due_on?, position?}`, `PATCH /api/task-milestones/{id} {name?, due_on? ("" — снять), position?, completed?}`, `DELETE /api/task-milestones/{id}` (привязанные подзадачи теряют ссылку, им `TASK_UPDATE`) → `TaskMilestoneResponse {milestone, task}`; подзадача — `PATCH /api/tasks/{id} {task_milestone_id}`.

## Временные комнаты (ADR-0044, миграция 00048)
- Временная комната — обычная `voice` с `rooms.expires_at` (`Room.expires_at`, отдельного `is_temp` нет) и `created_by`. Создание — `POST /api/workspaces/{id}/rooms/temp` (`CREATE_TEMP_ROOMS`), лимиты: 20 живых на пространство, 5 на создателя (`409 TEMP_ROOM_LIMIT`).
- Права: создатель (не гость) управляет своей временной комнатой как с `MANAGE_ROOM` — одна проверка `rooms.MayManage` (сервер) / `mayManageRoom` (клиент); `computePermissions` не меняется. На постоянных комнатах `created_by` прав не даёт. `make_permanent` — только настоящий `MANAGE_ROOM`.
- Приватная временная = deny `VIEW_ROOM` роли `member` + личные allow (`VIEW_ROOM | CONNECT | SPEAK | VIDEO | STREAM | SEND_MESSAGES | ATTACH_FILES` в пределах прав создателя) создателю, выбранным людям и всем, кто вошёл по ссылке.
- Архив: `archived_at` (удаление или истечение), ссылки отозваны, LiveKit-комната закрыта. История читается с `VIEW_ROOM` (сообщения, закрепы, вложения), остальное — `410 ROOM_ARCHIVED`; постоянные архивные комнаты по-прежнему скрыты (`404`). Через `TEMP_ROOM_RETENTION_DAYS` (90) архивная временная комната удаляется с историей.

## Телефония (ADR-0046, миграция 00051)
- `sip_accounts` — один аккаунт SIP-провайдера на пространство: `provider` (подпись), `host` (без порта, только публичный адрес — иначе `422`), `port` (по умолчанию 5060), `transport udp|tcp|tls`, `username`, `auth_username` (пусто — аутентификация как `username`), `password_enc` (sealbox `calaba/sip-password/v1`, как пароль CalDAV; `GET` отдаёт только `has_password`, `PUT` без поля пароля его не трогает, `""` — удаляет), `caller_id` (E.164), `outbound_prefix` (`+` и/или до 8 цифр перед цифрами номера), `allowed_prefixes text[]` (пусто — любые номера), `trunk_id` (`SIPOutboundTrunk` LiveKit; строка всегда совпадает с тем, что в LiveKit: отказ LiveKit меняет только `last_error`), `enabled`, `last_error`, `updated_at/by`.
- `workspaces.sip_enabled` = `enabled && trunk_id <> ''` — ставит `PUT …/sip` в той же транзакции; клиенту это `Workspace.sip_enabled` (READY, `WORKSPACE_UPDATE`).
- `sip_calls` — журнал: `number` (E.164), `direction out|in` (`in` — задел под входящие), `room_id` (`SET NULL` при удалении комнаты; `NULL` с самого начала — проверка подключения), `started_by`, `participant_identity` (`sip:<id>` — участник LiveKit), `sip_call_id`, `status dialing|ringing|active|ended|failed`, `reason`, `ended_by`, `started_at/answered_at/ended_at`. Не больше одного живого звонка (`dialing|ringing|active`) на комнату — частичный уникальный индекс. Удаляется только с пространством.
- Права (ADR-0048): настройки и проверка подключения — `MANAGE_INTEGRATIONS`, журнал — `VIEW_JOURNALS` (звонки комнат, которых читающий не видит, пропускаются).
- Звонить: `PLACE_CALLS` + `VIEW_ROOM` + `CONNECT` в голосовой комнате (не гость, не архивная), звонящий сейчас в звонке этой комнаты; 20 звонков в час на пространство (Redis), номер в `allowed_prefixes`. Завершить: звонивший или `MUTE_MEMBERS`. Когда из звонка комнаты ушёл последний человек (или бот) — телефонная линия кладётся (`reason = empty`); выключение телефонии кладёт все линии пространства (`disabled`). Звонок длится не больше 2 ч, гудки — до 45 с.
- Тариф (владелец, 02.10): телефония — только Business и on-prem (`telephony_disabled`). Ниже Business `PUT …/sip` с `enabled: true`, `POST …/sip/test` и `POST /api/rooms/{id}/calls` (и для ботов) — `409 PLAN_LIMIT`; чтение настроек и журнала, выключение и «Завершить» доступны всегда. При понижении тарифа аккаунт и транк не удаляются, идущий звонок не прерывается.

## Веб-приложения пространства (ADR-0050, миграция 00054)
- `workspace_apps` — ярлыки сайтов в рейле под иконкой пространства: название 1..40, адрес ≤ 2048, иконка (своя загрузка в это пространство, картинка, не стикер — правило бейджей; нет — первая буква на цветной плашке), `position` дробная (перенос — между соседями, при исчерпании зазора сервер перенумеровывает 1..n). ≤ 20 на пространство (advisory-lock на создание и перенос).
- Адрес: `https://` куда угодно; `http://` — только на частный хост (localhost / *.localhost, 127/8, [::1], 10/8, 172.16/12, 192.168/16, *.local, одиночное имя без точки); без `user:pass@`, пробелов, управляющих символов и `\`; хост и порт синтаксически верны. Разбор ручной, одинаковый в Go (`workspaces.ValidateAppURL`) и TS (`apps/desktop/src/shared/appUrl.ts`), общие векторы — `proto/testdata/app_urls.json`. Сервер по адресу **не ходит** (SSRF нет).
- Права: видят все участники, кроме гостей и ботов (маршруты — `botDeny`, из READY ботам и гостям не отдаются); создать / изменить / удалить / переставить — `MANAGE_INTEGRATIONS` (ADR-0048). Чужое пространство и гостю — 404 на `…/workspace-apps/{id}`, гостю на список — 403. Иконку (`files.CanRead`) читают участники пространства, кроме гостей; в чистку сирот не попадает.
- REST: `GET|POST /api/workspaces/{id}/apps`, `PATCH|DELETE /api/workspace-apps/{id}`, `PUT /api/workspace-apps/{id}/position {after_app_id, before_app_id}` → все приложения по порядку. События — `WORKSPACE_APP_UPSERT` / `WORKSPACE_APP_DELETE` (docs/05).
- Десктоп: сайт — `WebContentsView` main-процесса с сессией `persist:app-<id>` (логины на сайте живут между запусками, изолированы от Calab и друг от друга); удаление приложения и конец сессии Calab (выход, отзыв) чистят данные сайта на устройстве. Ответы на запросы разрешений хранятся локально (`userData/web-app-permissions.json`) по приложению.

## Auth (MVP)

- Email + пароль (argon2id: 19 MiB, t=2, p=1 — профиль OWASP; не больше 4 хэшей одновременно), refresh-токены с ротацией (в `sessions`, скользящий срок `REFRESH_TOKEN_TTL` — 1 год без использования), access JWT HS256 на `ACCESS_TOKEN_TTL` — 24 ч (`sub` = user, `sid` = session). Сроки мягкие (владелец, 29.09: «входить раз в год»), потому что отзыв не ждёт истечения (ниже); свой сервер может ужесточить env.
- Refresh-токен = `<session_id>.<secret>`, в БД — только `sha256(secret)`. Каждый refresh выдаёт новый секрет (новое **поколение** `sessions.refresh_gen`; access JWT несёт его в claim `rg`).
- **Повтор refresh (docs/09 #89, #123).** Предъявлен *предыдущий* секрет, а новый ещё **не использован** (`refresh_used_at IS NULL`) — это ретрай refresh, чей ответ потерялся (обрыв сети, зависшее соединение, выход приложения на обновление), или гонка двух вкладок: сервер отдаёт **тот же** новый refresh-токен и свежий access, без ротации и без продления сессии. **Срока у этого нет**: ноутбук, пролежавший офлайн часы, возвращается к той же паре (0.8.0 ограничивал это 60 с — инцидент 29.09: ответ потерян, ретрай через 78 с → сессия отозвана как «на другом устройстве»). «Использован» = refresh этим новым токеном (тогда старый становится на два поколения старше) **или** первый запрос (REST или gateway `IDENTIFY`) с access-токеном, выписанным для нового поколения: `auth.markGenUsed` один раз ставит `refresh_used_at` (`UPDATE … WHERE refresh_gen = rg AND refresh_used_at IS NULL`; на инстансе — кэш «поколение уже отмечено», один UPDATE на ротацию, не на запрос; ошибка БД не роняет запрос, лишь откладывает отметку). Access-токены прежнего поколения новое не «используют». Новый секрет хранится в строке сессии `replay_seal`: AES-GCM ключом `HMAC-SHA256(предыдущий секрет, "calaba/refresh-replay/v1")`, AAD = id сессии, пишется в той же транзакции, что и ротация (открыть может только владелец предыдущего токена; ни дамп БД, где лежит лишь `sha256`, ни Valkey его не дают). Параллельные refresh одним токеном сериализует `SELECT … FOR UPDATE`: одна ротация, остальные получают ту же пару. `replay_seal` обнуляется при первом использовании поколения и при любом отзыве. Ротация до миграции 00040 (нет `replay_seal`) при неиспользованном новом токене → `409 CONFLICT` без отзыва; ротации старше 60 с на момент миграции помечены использованными (как считал 0.8.0).
- **Отзыв за повтор (reuse) — только настоящий.** Предыдущий секрет после использования нового, секрет двумя и более поколениями старше или неизвестный секрет живой сессии → сессия отзывается целиком: `401 SESSION_REVOKED`, `reason: "REUSE"`, gateway закрывает сокет `4010 "session revoked: REUSE"`. Прочие отзывы тоже помнят причину (`sessions.revoked_reason`, `ApiError.reason`, суффикс причины закрытия `4010`): `LOGOUT`, `LOGOUT_ALL`, `OTHER_DEVICE` (завершена из списка сессий), `PASSWORD_CHANGED` (смена/сброс пароля), `ACCOUNT_DISABLED`, `GUEST_EXPIRED`. Причину отозванной сессии сервер сообщает только предъявившему один из двух её последних токенов, иначе — `401 INVALID_REFRESH_TOKEN` (как и для неизвестной/истёкшей). Клиент показывает: `REUSE` → «Сессия сброшена после обрыва связи — войдите снова»; `LOGOUT_ALL`/`OTHER_DEVICE`/`PASSWORD_CHANGED`/`ACCOUNT_DISABLED`/неизвестная → «Сессия завершена на другом устройстве»; истёкшая/`GUEST_EXPIRED` → «Сессия истекла»; `LOGOUT` — без баннера. Сетевые ошибки refresh любой длительности сессию не завершают: клиент повторяет с backoff тем же (предыдущим) токеном и после возврата связи получает уже выданную пару; ошибку сети (включая таймаут 15 с) десктоп сразу повторяет один раз через новое соединение (отдельная in-memory сессия Electron, пул сокетов закрыт перед запросом).
- **Модель угроз повтора.** Укравший *предыдущий* refresh-токен получает ту же пару, что и легитимный клиент, **только пока тот её не использовал** — то есть пока легитимный клиент офлайн или его ответ потерян; в 0.8.0 то же было возможно в пределах 60 с. Как только одна из сторон использует новую пару (refresh или любой запрос с её access-токеном), следующее предъявление старого токена другой стороной — reuse: отзываются **обе** копии. Если вор успел первым, легитимный клиент при возвращении попадёт на экран входа с «Сессия сброшена после обрыва связи», а вор теряет доступ — не хуже прежнего детектора: первый конфликт отзывает сессию, окно безнаказанного использования ограничено временем, пока вторая сторона молчит, и ни в какой момент у двух сторон нет *разных* живых токенов одной сессии. Украденный *текущий* токен детектор и раньше не ловил до первого конфликта; этот случай не изменился. Кража старого токена бесполезна после первого использования нового (отзыв), а `replay_seal` без предыдущего секрета не открывается. «Выйти везде» по refresh-токену (`LogoutByRefresh`, `all_sessions`) принимает только **текущий** токен; предыдущий (пока новый не использован) завершает лишь свою сессию.
- Отзыв сессии (logout, reuse, «выйти везде», завершение сеанса в списке, смена/сброс пароля, удаление гостя) мгновенно действует и на выданные access-токены: API ставит в Valkey `auth:revoked:<session_id>` = причина (TTL = время жизни access-токена + 1 мин) и публикует `session:revoked:<session_id>` — gateway закрывает сокет с 4010 (+ причина). Middleware REST и IDENTIFY gateway проверяют маркер на каждом запросе (rueidis client-side cache, инвалидация сервером), а раз в минуту на сессию и инстанс — `sessions.revoked_at` в Postgres (`auth/sessioncheck.go`): маркер, который не удалось записать (Valkey отказал в момент отзыва), стоит не больше минуты, а не срок access-токена; gateway повторяет ту же проверку на каждом heartbeat и закрывает сокет `4010` (≤ 1 мин + heartbeat), если потерялось и событие. Valkey недоступен на чтение → решает Postgres (с тем же кэшем на минуту); Postgres не подтвердил сессию за последнюю минуту (ошибка БД) → `503` (fail closed), маркер один сессию не пропускает; живой сокет при ошибке зависимостей не рвётся. Та же проверка раз в 5 мин обновляет `last_seen_at` («Настройки → Сеансы: активность»), refresh теперь раз в сутки. Бан в пространстве сессию не отзывает (аккаунт жив) — участник удаляется, права в пространстве проверяются по БД на каждом запросе. Проверено `internal/app/revocation_integration_test.go` (access 24 ч: REST 401 и сокет 4010 ≤ 1 с для каждого пути; маркер потерян — REST и сокет; Valkey недоступен; Postgres недоступен).
- **Модель угроз долгих сессий.** Refresh живёт год (скользящий срок), access — сутки, поэтому потерянное или украденное устройство остаётся входом, пока сессию не завершат явно: «Настройки → Сеансы» (список устройств с последней активностью, завершение любого) или «Выйти везде»; смена пароля завершает все сеансы, кроме текущего. После этого доступ пропадает сразу (выше), срок токенов на это не влияет. Смена email сеансы не завершает. Защиты от кражи самого устройства (диска, профиля браузера) сервер не даёт — её дают блокировка ОС и шифрование диска; кто этого не хочет, ужесточает `ACCESS_TOKEN_TTL`/`REFRESH_TOKEN_TTL` на своём сервере.
- Регистрация: открытая или по инвайту (флаг сервера `REGISTRATION_MODE=open|invite`). В режиме `invite` без кода может зарегистрироваться только **первый пользователь сервера** (bootstrap владельца, под `pg_advisory_xact_lock`). Регистрация с инвайтом сразу добавляет в workspace ролью `member`.
- **Подсказка «похожий аккаунт» (docs/09 #119).** `RegisterRequest.check_similar_account` (клиент шлёт его первым запросом): если адрес свободен, а есть активный не-гость/не-бот с тем же логином (до `@`, без учёта регистра) на домене «той же организации» — то же имя с другим последним уровнем (`kv@gptunnel.ai` ↔ `kv@gptunnel.ru`) или домен email-приглашений пространства из кода инвайта, — ничего не создаётся, ответ `200 {similar_account: true}` без токенов и без адреса. Повтор без флага создаёт аккаунт. Проверка идёт последней внутри транзакции регистрации (после хеша пароля, инвайта, мест, банов; попадание — откат): подсказку получает только регистрация, которая иначе прошла бы, а промах создаёт аккаунт — оракул не дешевле точного `409` (он остаётся как прежде) и под тем же лимитом регистрации per IP (`AUTH_RATE_*`, 10/мин).
- **Почта (ADR-0023).** Письма уходят только через outbox `mail_outbox` (в транзакции вызывающего) → воркер: цикл на каждом инстансе, отправляет держатель блокировки Valkey `mail:worker` (30 с); взятые строки «арендуются» (`next_at` +5 мин), поэтому потеря блокировки или падение не дают дубля. Ретраи 30 с × 2ⁿ (≤ 1 ч) до конца жизни письма (код — 10 мин, остальное — 24 ч); SMTP 5xx и ошибки шаблона — сразу `failed_at`. Лимиты (Valkey): `MAIL_PER_ADDRESS_PER_HOUR` (3) на адрес — при постановке (429; письма встреч — свой лимит `MAIL_EVENTS_PER_ADDRESS_PER_HOUR`, 10), `MAIL_PER_HOUR` (200) на сервер — воркер ждёт. Без `SMTP_HOST` почты нет: регистрация сразу помечает адрес подтверждённым.
- **Подтверждение email.** Код — 6 цифр, argon2id, 10 мин, 5 попыток (попытка списывается до сравнения), новый — не чаще раза в 60 с (атомарно в `PutEmailCode`). Код шлют регистрация, вход неподтверждённого (если прошлый старше 60 с) и `verify/send`. Неподтверждённый аккаунт читает и входит, но `EMAIL_NOT_VERIFIED` (403) на создание пространства, приглашения (ссылки на пространство/комнату, email-приглашения, lookup, добавление) и **новый** DM; гости не затрагиваются. Существующие аккаунты **не** считаются подтверждёнными (владелец, 27.09). Суперадмин (`SUPERADMIN_EMAILS`) — только с подтверждённым адресом.
- **Смена email** — адрес попадает в `pending_email`, код уходит на новый адрес; вход — по старому, пока код не подтверждён (`verify` переносит адрес и ставит `email_verified_at`). Смена на текущий адрес отменяет ожидающую.
- **Сброс пароля.** `forgot` → `200 ForgotPasswordResponse` с одинаковым ответом, есть аккаунт или нет (письмо уходит в фоне; обе выборки — точный адрес и «похожий» — выполняются всегда, тайминг одинаковый). Единственное исключение — `similar_account: true` (docs/09 #137): точного аккаунта нет, а есть тот же логин на домене той же организации (та же проверка `HasSimilarAccount`, что у регистрации #119, без доменов инвайтов; под лимитом `forgot` per IP); если точный аккаунт существует — `false`, чужой адрес не называется. Каждая остановка пишется в лог без адреса: `password reset: no account` (`domain`, `email_hash` — 8 hex sha256 нормализованного адреса, `ip`, `similar_account`) или `password reset: account not eligible` (`user_id`, `reason`: `guest` / `no_password` / `disabled`); `reset` с неверным/просроченным кодом или неизвестным адресом — одинаково `422 CODE_INVALID`; успех: новый хэш, адрес подтверждён, **все** сессии отозваны.
- **Приглашения по email.** Право — `INVITE_MEMBERS` (ADR-0043) + подтверждённый адрес. `lookup` — точное совпадение среди подтверждённых активных не-гостей, 20/мин на пользователя, в лог — id действующего и sha256-префикс адреса. `members {user_id}` добавляет сразу (`member`) + письмо `workspace_added`. `invites/email` создаёт одноразовую ссылку, привязанную к адресу (регистрация/вход по ней с другим адресом → `INVITE_INVALID`; с этим — адрес сразу подтверждён), повтор тому же адресу — не чаще раза в 24 ч (новая ссылка, старая удаляется); 20 подряд / 30 в час на пользователя. Подтверждение адреса (код, сброс пароля, ссылка) принимает **все** живые email-приглашения этого адреса.
- Позже: OIDC (Google Workspace / Keycloak) — таблица `users` уже без привязки к паролю как единственному способу (`password_hash` nullable).

## Боты (ADR-0031)

- Бот — пользователь `is_bot` (без email/пароля, `email_verified_at` ставится при создании), участник пространств со встроенной ролью `member`; права — свои роли и переопределения комнат, `computePermissions` не меняется. `admin`/`guest` боту не выдаются (`422`), `owner` — никогда. Ограниченные комнаты (ADR-0029) действуют как на людей.
- Создаёт `MANAGE_BOTS` (ADR-0048; подтверждённый email) — «домашнее» пространство; добавить в другое — `MANAGE_BOTS` там (`…/bots/add`). Токен, удаление — дома (владелец бота или `MANAGE_BOTS`). Удаление: `bots` удаляется, членства и личные переопределения — тоже, аккаунт `disabled_at`, сообщения остаются. Удаление домашнего пространства удаляет строку `bots` (токен перестаёт работать).
- Аутентификация и маршруты для ботов — docs/05 «Боты».

## Гости (ADR-0016)

- Ссылка на комнату (`room_invites`) — это capability. По умолчанию: срок 7 дней, без лимита использований, гости разрешены. Права приглашённого: `VIEW_ROOM | CONNECT` всегда, плюс `SPEAK` / `SEND_MESSAGES` (по умолчанию да) и `ATTACH_FILES` / `STREAM` (по умолчанию нет). Не-админ не может выдать через ссылку права, которых нет у него самого.
- Переход по ссылке:
  - (a) уже есть доступ к комнате — ничего не меняется, использование не тратится;
  - (b) зарегистрированный пользователь не из workspace → членство `guest` + user-override на комнату; если он участник без доступа к комнате — только override;
  - (c) без аккаунта → гостевой аккаунт `is_guest` (без email и пароля, имя = введённый ник), сессия 24 ч, продлевается каждым refresh.
- Гость без активности 7 дней (`guest_expires_at`, сдвигается при refresh) **анонимизируется**, а не удаляется: членства, overrides, файлы и сессии удаляются, имя → «Гость (удалён)», сообщения остаются. Фоновая чистка — раз в час.
- Гостевой аккаунт не может: создавать и находить workspace, входить в открытые workspace, менять статус и аватар (только имя и настройки). Роль `guest` не видит комнат без override, поэтому не создаёт ссылок и не видит чужих комнат.
- **Кого видит гость** (роль `guest`, дополнение ADR-0016 от 02.10): себя и людей своих комнат — приглашённых поимённо (user-override комнаты, в т.ч. по ссылке) и создателя комнаты, пока они её видят; тех, кто сейчас в звонке комнаты; авторов её сообщений. Одной возможности видеть комнату мало: публичная (и временная публичная) комната открыта всем участникам, но каталог пространства через неё гостю не отдаётся. Правило одно — `perm.GuestVisible`: READY (`members`, `presences`, `voice_states`), события (`WORKSPACE_MEMBER_*`, `PRESENCE_UPDATE`, `USER_UPDATE`, `VOICE_STATE_UPDATE`, `TYPING_START`; синтетический `MEMBER_ADD` приходит до первого сообщения / входа в звонок нового человека, `MEMBER_REMOVE` — после ухода из звонка, если других причин видеть нет), REST `GET …/members`, `…/members/{userId}` (`404`), список отреагировавших (`GET /api/messages/{id}/reactions/{emoji}` без невидимых). `…/members/birthdays`, события банов и ботов гостю не отдаются ни при каких битах.
- `POST …/members/{userId}/promote` (MANAGE_MEMBERS, ADR-0048): `guest` → `member`. Аккаунт гостя после этого не чистится.
- **Подтверждение входа (ADR-0040).** `rooms.guest_approval` (настройки комнаты, `MANAGE_ROOM`) и `room_invites.require_approval` (`NULL` — как у комнаты; гостевые ссылки встреч — `NULL`). Если подтверждение нужно, (b)/(c) дают членство `guest` **без** override и строку `room_admissions` `pending` (использование ссылки тратится; при отклонении / «нет ответа» / отмене — возвращается). Участник пространства (не гость) не ждёт никогда. Решают `MANAGE_ROOM` в комнате и автор ссылки (не гость): `admitted` → override с битами ссылки (ссылки нет — биты ссылки по умолчанию), строка удаляется, опционально имя гостевого аккаунта (1..40) и бейдж из библиотеки; `declined` → строка живёт 10 мин (новый стук — `429 ADMISSION_DECLINED`), членство гостя снимается, если у него нет других комнат и стуков. Метёлка раз в 30 с: `pending` старше 30 мин → `declined` без `decided_by` («Никто не ответил», стучать снова можно сразу), `declined` старше 10 мин удаляются. На комнату ≤ 50 ожидающих (`429 ADMISSION_QUEUE_FULL`).

### Формы досок — ADR-0064
`board_forms` хранит definition (protobuf JSON), стабильный случайный code, revision,
автора и времена; FK board_id CASCADE. `board_form_submissions` — квитанция, nonce,
хэш запроса, actor_id (NULL у anonymous), task_id; UNIQUE(form_id,nonce). Миграция 00060.
Удаление формы каскадно удаляет квитанции, но не задачи. Права управления — MANAGE_BOARD;
приватный ACL даёт только заполнение. Задача/комната/журнал/квитанция/outbox атомарны.
PlanLimits.board_forms_disabled / board_forms_per_board: Free true/0, Team false/5,
Business false/20, Custom/on-prem false/0 по умолчанию. Подробнее — контракт и ошибки в ADR.
