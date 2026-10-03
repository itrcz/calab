# 05 — Realtime-протокол (WS gateway)

Транспорт всех изменений состояния: сообщения, presence, voice-state, изменения комнат/прав. По образцу Discord Gateway, урезано.

Данные LiveKit (data channels) для чата **не используются**: не буферизуются на сервере, best-effort, живут только внутри комнаты и умирают вместе с медиа. Их применяем только для эфемерных сигналов внутри звонка (реакции, «поднять руку», указка на стриме).

## Соединение

- `wss://app.<domain>/gateway?v=1` — бинарные protobuf-кадры (`GatewayFrame { op, seq, oneof payload }`, событие DISPATCH — `DispatchEvent { oneof event }` вместо discord-овских `t`/`d`); `?encoding=json` — для отладки.
- Ниже структура описана в JSON-нотации для читаемости.
- Один сокет на клиент (устройство), на все workspace пользователя. Одновременно — не больше **5 устройств (auth-сессий) с gateway на пользователя** (`GATEWAY_MAX_SESSIONS_PER_USER`); шестой `IDENTIFY` отклоняется: сокет закрывается с `4008` до `READY`. Клиент, получивший `4008` без `READY`, не ретраит в цикле, а показывает «слишком много активных устройств» (со ссылкой на список сессий). Повторный `IDENTIFY` с того же устройства (та же auth-сессия) не считается новым: он заменяет прежнюю gateway-сессию устройства (её сокет закрывается с `4000`).
- **Вкладки браузера** (#40). Вкладки одного браузера делят auth-сессию (одно устройство), поэтому веб-клиент шлёт в `IDENTIFY` `tab_id` — случайный id вкладки (`sessionStorage`, переживает перезагрузку; 1–64 символа `[A-Za-z0-9_-]`, иначе считается пустым). Gateway-сессия привязывается к паре (auth-сессия, `tab_id`) (Redis `gw:tabs:<asess>`): новый `IDENTIFY` заменяет (`4000 replaced by a new session`) только сессию той же вкладки; вкладки сосуществуют и все получают события. На auth-сессию — не больше **8 вкладок**; девятая вытесняет вкладку, занятую (`IDENTIFY`/`RESUME`) раньше всех: `4011`. Вкладки одной auth-сессии считаются одним устройством в лимите 5. Десктоп и боты `tab_id` не шлют — у них одна gateway-сессия на auth-сессию, как раньше. Отзыв auth-сессии закрывает все её вкладки (`4010`); identity-lease проверяется для каждой gateway-сессии. Голос принадлежит auth-сессии (identity LiveKit `<user_id>:<session_id>`): две вкладки не могут быть в голосе одновременно: вход в голос во вкладке рассылает остальным вкладкам браузера `BroadcastChannel` `calaba:voice`, и они выходят из голоса локально, **без** `/voice/leave` (место в голосе — общее у auth-сессии, leave выкинул бы новую вкладку; в той же комнате то же делает `DUPLICATE_IDENTITY` LiveKit) — тост «в другом окне». Звук и системное уведомление о сообщении играет одна вкладка (Web Locks `calaba:once:msg:<id>`, видимая вкладка в приоритете).
  - Клиент: `4000 replaced` на вебе = вкладку продублировали вместе с `sessionStorage` → новый `tab_id`, сразу `IDENTIFY`. `4011` в скрытой вкладке → без таймеров ждёт, пока вкладку покажут (`visibilitychange`), затем `IDENTIFY`; в видимой → backoff 4 → 8 → … 30 с, не сбрасываемый `READY` (две видимые вкладки сверх лимита не зацикливаются).

## Защита соединения

- Сервер ставит `SetReadLimit(64 KiB)` на сокет: кадр больше — закрытие с `1009` (стандартный код).
- У каждого сокета исходящая очередь на **256 кадров**. Переполнение (медленный клиент) → закрытие с `4008`; во время `RESUME` (пока из Redis читается replay) придержанные кадры считаются в тот же лимит 256; клиент переподключается и делает `RESUME`, пропущенное досылается из буфера сессии. Медленный сокет никогда не тормозит fan-out остальным.
- Отзыв сессии: при `sessions.revoked_at` (logout, «выйти на всех устройствах», админ) API публикует в Redis `session:revoked:<session_id>` (payload — причина); инстанс gateway, держащий этот сокет, закрывает его с `4010 "session revoked: <причина>"`. LiveKit-токены для отозванной сессии больше не выдаются (текущее подключение к LiveKit сервер снимает через `RemoveParticipant` по identity `<user_id>:<session_id>`).

### Коды закрытия

| Код | Значение | Клиент |
|---|---|---|
| 4000 | unknown error | переподключиться, `RESUME` |
| 4001 | unknown opcode (или опкод не к месту, напр. второй `IDENTIFY`) | переподключиться, `RESUME` (баг клиента — в лог) |
| 4002 | decode error (в т.ч. `op` не совпадает с типом payload) | переподключиться, `RESUME` (баг клиента — в лог) |
| 4003 | not authenticated (кадр до `IDENTIFY`, кроме `HEARTBEAT`; или нет `IDENTIFY` за 30 с) | новый `IDENTIFY` |
| 4004 | authentication failed | обновить access-token через refresh; refresh отклонён (401) → экран логина; нет сети / 5xx → повтор с backoff (сессию не терять) |
| 4007 | invalid seq (`RESUME` с неизвестным `seq`) | новый `IDENTIFY` |
| 4008 | rate limited / переполнена очередь отправки / лимит сессий | переподключиться с backoff, `RESUME` |
| 4009 | session timed out (нет heartbeat) | новый `IDENTIFY` |
| 4010 | session revoked (`session revoked: <REASON>` — причина из `ApiError.reason` `SESSION_REVOKED`: `REUSE`, `LOGOUT_ALL`, `OTHER_DEVICE`, …) | **не переподключаться**, экран логина; `REUSE` → «Сессия сброшена после обрыва связи», прочие → «завершена на другом устройстве» (docs/04 «Auth») |
| 4011 | session evicted: у auth-сессии больше 8 вкладок, эта занята раньше всех (#40) | скрытая вкладка — переподключиться (`IDENTIFY`), когда её покажут; видимая — медленный backoff |

## Опкоды

| op | Направление | Назначение |
|---|---|---|
| 8 `DISPATCH` | s→c | `DispatchEvent` (oneof события), номер `seq`. **8, а не 0 как в Discord**: в proto3 нулевое значение enum — `UNSPECIFIED` |
| 1 `HEARTBEAT` | c→s | `d = последний s` |
| 2 `IDENTIFY` | c→s | `{ token, device, capabilities, tab_id }` (`tab_id` — только веб, см. «Вкладки браузера») |
| 3 `RESUME` | c→s | `{ session_id, seq }` |
| 4 `PRESENCE_UPDATE` | c→s | `{ status: online|idle|dnd|invisible, until? }` — с `until` ручной статус пользователя (см. «Presence»), без — автоматический статус сессии (AFK) |
| 5 `TYPING` | c→s | `{ room_id }` — нужны `VIEW_ROOM` + `SEND_MESSAGES`; не чаще 1 раза в 3 с на пользователя и комнату (лишние молча отбрасываются) |
| 6 `SUBSCRIBE` | c→s | `{ room_ids: [...] }` (≤ 100) — **заменяет** набор комнат, для которых сессия получает `TYPING_START`. Клиент шлёт его при каждом открытии/закрытии комнаты: `[id открытой комнаты]` (или `[]`). Без подписки `TYPING_START` не приходит вообще |
| 10 `HELLO` | s→c | `{ heartbeat_interval }` |
| 11 `HEARTBEAT_ACK` | s→c | |
| 7 `RECONNECT` | s→c | сервер просит переподключиться (деплой) |
| 9 `INVALID_SESSION` | s→c | `{ resumable: bool }` |

## Жизненный цикл

1. Открыли сокет → `HELLO { heartbeat_interval_ms }`.
2. `IDENTIFY` → сервер валидирует access-token (отозванная сессия → `4010`) → `READY` (DISPATCH, `seq = 1`): `{ session_id, me, workspaces[] (WorkspaceSnapshot: workspace, роль (старшая встроенная), видимые комнаты, участники с `role_ids`, `roles` — все роли пространства от старшей к младшей (ADR-0026), voice_states, presences, permissions — биты прав пользователя по каждой видимой комнате), read_states (с `unread_count` / `mention_count`), notification_settings, workspace_notification_settings, dms[] (DmSummary, см. «Личные сообщения»), notes[] (NotesShelf — полки «Заметок» по position, ADR-0039; ботам и гостям пусто), peer_reads[] (`PeerRead {room_id, last_read_message_id}` — докуда прочитали другие, по видимым комнатам пространств, где кто-то читал; DM — в `dms[].peer_read_message_id`; docs/09 #92) }`. События, пришедшие пока строился READY, отправляются сразу после него (возможен дубль уже учтённого в READY — события идемпотентны).
3. Клиент шлёт `HEARTBEAT` каждые `heartbeat_interval` (~41 с) с jitter; нет `ACK` за 2 интервала → закрыть и переподключиться.
4. Обрыв → переподключение с экспоненциальным backoff (1s → 30s, jitter) → `RESUME { token, session_id, seq }` (token — свежий access JWT):
   - сервер держит буфер событий сессии в Redis (последние ~5 мин / 1000 событий) → досылает пропущенное по порядку, затем событие `RESUMED { replayed }`;
   - буфер протух / сессия неизвестна / `seq` не покрыт буфером → `INVALID_SESSION { resumable: false }`; сокет остаётся открытым — клиент шлёт `IDENTIFY` в нём же.
   - RESUME на другом инстансе удаётся, только если прежний владелец жив и подтвердил передачу (он дописал всё, что успел разослать, в буфер). Если владелец упал, отпустил сессию при остановке (деплой) или не ответил за 3 с — `INVALID_SESSION{false}`. События, опубликованные в разрыве, **никогда не теряются молча**: клиент либо получает их при RESUME, либо узнаёт о необходимости полного `IDENTIFY`. После `RECONNECT` при деплое ожидайте именно `INVALID_SESSION`.
   - Входящие кадры: сверх мягкого бюджета (10 подряд, 2/с) `SUBSCRIBE` / `TYPING` / повторный `PRESENCE_UPDATE` молча отбрасываются; `HEARTBEAT` и `PRESENCE_UPDATE`, реально меняющий статус, обрабатываются всегда. Закрытие `4008` — только при явном флуде: больше 50 кадров/с устойчиво, запас — 100 кадров. Повтор того же `PRESENCE_UPDATE` игнорируется.
   - Закрытие сокета клиентом с `1000`/`1001` (выход из приложения, logout) завершает сессию сразу (без RESUME, presence сразу offline). Обрыв без close-кадра оставляет сессию доступной для RESUME 5 мин.
   - Нет heartbeat дольше 2 × интервал + 10 с → `4009`, сессия завершена.
5. Sequence `s` монотонный на сессию; клиент игнорирует `s <= last`.

## События (`t`)

```
READY
WORKSPACE_CREATE / UPDATE / DELETE    -- Workspace.plan: тариф и эффективные лимиты (ADR-0024); смена тарифа → WORKSPACE_UPDATE всем участникам
                                      -- Workspace.time_format (AUTO|H24|H12; UNSPECIFIED = AUTO): PATCH /api/workspaces/{id} {time_format} → WORKSPACE_UPDATE, клиент применяет живьём (docs/09 #73)
WORKSPACE_MEMBER_ADD / UPDATE (роль, role_ids, ник) / REMOVE
ROLE_CREATE / ROLE_UPDATE     { role } — роли пространства (ADR-0026); ROLE_UPDATE и для каждой роли со сменившейся позицией
ROLE_DELETE                   { workspace_id, role_id } — убрать role_id у всех участников; затем ROOM_PERMISSIONS_UPDATE по комнатам, где были её переопределения
ROOM_CREATE / UPDATE / DELETE
ROOM_PERMISSIONS_UPDATE      { room_id, permissions[] }
MESSAGE_CREATE / UPDATE / DELETE
TYPING_START                  { room_id, user_id, timestamp } — только сессиям с SUBSCRIBE на комнату (см. опкод 6), показывать ~8 с
PRESENCE_UPDATE               { user_id, status, last_seen, on_call } — on_call: в звонке один на один (ADR-0034)
VOICE_STATE_UPDATE            { workspace_id, user_id, room_id|null, muted, deafened, streaming, joined_at, server_muted, camera }
VOICE_STREAM_START / STOP     { room_id, user_id, track_sid, preset }   -- для PiP-плитки
VOICE_CAMERA_STOP             { room_id, user_id, track_sid, reason: LIMIT_REACHED | MODERATOR | ROOM_POLICY }   -- камеру остановил сервер
VOICE_DISCONNECTED            { workspace_id, room_id, session_id, reason: OTHER_DEVICE } — только своим устройствам: устройство session_id выведено из голоса, т. к. пользователь вошёл с другого («Несколько устройств»)
READ_STATE_UPDATE
READ_RECEIPT                  { room_id, last_read_message_id } — докуда прочитали другие (docs/09 #92): в DM — собеседник, в комнате — самый дальний маркер остальных людей (кто — не раскрывается)
ROOM_NOTIFICATION_UPDATE      { settings: { room_id, level, muted_until } } — только своим устройствам
WORKSPACE_NOTIFICATION_UPDATE { settings: { workspace_id, level, muted_until, task_level } } — только своим устройствам (task_level — «Задачи», ADR-0042)
USER_UPDATE                   { me } — своим устройствам (профиль, email, настройки);
                              { user } — участникам всех workspace пользователя (публичный профиль: имя, статус, аватар)
RESUMED                       { replayed }  — после успешного RESUME
CATEGORY_CREATE / UPDATE / DELETE
MESSAGE_REACTION_ADD / REMOVE { workspace_id, room_id, message_id, user_id, emoji }
DM_CREATE                     { dm: DmSummary } — обоим участникам нового DM, каждому со своим peer
DM_STATE_UPDATE               { room_id, archived_at, cleared_before_message_id } — своё состояние DM (архив / «Удалить чат»), только своим устройствам
NOTES_CREATE / NOTES_UPDATE    { shelf: NotesShelf } — полка создана / переименована, сменила эмодзи или место (UPDATE для каждой сдвинутой), всем устройствам владельца (ADR-0039)
NOTES_DELETE                  { room_id } — полка удалена со всеми сообщениями, всем устройствам владельца
STICKER_PACK_CREATE / UPDATE  { pack } — пак пространства целиком (живые стикеры по порядку), всем участникам (ADR-0030)
STICKER_PACK_DELETE           { workspace_id, pack_id } — пак удалён; стикеры в уже отправленных сообщениях остаются
BADGE_CREATE / UPDATE         { badge } — бейдж библиотеки пространства (docs/09 #82), всем участникам; в READY — WorkspaceSnapshot.badges
BADGE_DELETE                  { workspace_id, badge_id } — бейдж удалён; его участники перед этим получили WORKSPACE_MEMBER_UPDATE без badge_id
BACKGROUND_CREATE / UPDATE    { background } — фон камеры пространства (ADR-0035), всем участникам; в READY — WorkspaceSnapshot.backgrounds
BACKGROUND_DELETE             { workspace_id, background_id } — фон удалён; клиенты, выбравшие его, сбрасывают фон на «Нет»
SOUND_CREATE / UPDATE         { sound } — звук саундборда пространства (ADR-0036), всем участникам; в READY — WorkspaceSnapshot.sounds; перенос — UPDATE каждому сдвинутому
SOUND_DELETE                  { workspace_id, sound_id } — звук удалён
SOUND_PLAY                    { room_id, sound_id, user_id, at } — кто-то в звонке нажал звук (`builtin:<имя>` или id звука): только тем, кто в звонке комнаты (их user-каналы), нажавшему тоже; клиент играет клип сам через <audio>, опоздание > 3 с — пропускает
ROOM_RECORDING                { workspace_id, room_id, recording_id, state: ACTIVE | STOPPED, by_user_id, since,
                                stop_reason, stopped_by } — запись встречи началась / остановилась (ADR-0025)
BOT_CREATE / BOT_UPDATE       { workspace_id, bot } — бот вступил / изменился (профиль, команды, токен, webhook; ADR-0031)
BOT_DELETE                    { workspace_id, bot_user_id } — бот удалён или убран из пространства
CALL_RING                     { call, caller: User } — звонок вызываемому (ADR-0034), всем его устройствам
CALL_STATE                    { call } — звонок создан или сменил состояние, обоим участникам
EVENT_CREATE / EVENT_UPDATE   { event: CalendarEvent } — встреча создана / изменена (ADR-0038); серия, без my_status
EVENT_DELETE                  { event } — встреча отменена (cancelled_at задан) или ушла из поля зрения получателя
                                (другая комната, удалён из участников; cancelled_at пуст — за ним EVENT_UPDATE тем, кто её видит)
EVENT_RSVP                    { workspace_id, event_id, attendee, counts, event } — участник ответил
EVENT_REMINDER                { event (вхождение), occurrence_at, minutes } — напоминание, в user:<id>
ROOM_EVENT_ACTIVE             { workspace_id, room_id, event (вхождение) } — за 15 мин до начала и до конца: значок встречи у комнаты
ROOM_EVENT_ENDED              { workspace_id, room_id, event_id, occurrence_at } — вхождение закончилось, отменено или перенесено
ROOM_ADMISSION_REQUEST        { admission: RoomAdmission } — гость стучится в комнату (ADR-0040), решающим
ROOM_ADMISSION_DECIDED        { admission } — ADMITTED | DECLINED (no_answer — никто не ответил за 30 мин) | CANCELLED (гость
                                передумал): решающим (user — только id) и гостю в user:<id> (с room_name / workspace_name)
BOARD_CREATE / BOARD_UPDATE   { board } — доска (ADR-0042) с Board.permissions получателя; UPDATE — и статусы, лейблы, вехи, общие виды, доступ
BOARD_DELETE                  { workspace_id, board_id, purged } — в архив (purged false) или удалена; или доска перестала быть видна
TASK_CREATE / TASK_UPDATE     { task } — полная задача без ленты; TASK_UPDATE в user:<id> — с viewer_state (subscribed, muted, unread) и notice
TASK_DELETE                   { workspace_id, board_id, task_id, purged } — архив задачи (или переезд на другую доску)
TASK_ACTIVITY                 { workspace_id, activity } — одна запись журнала задачи
BOARD_CATEGORY_CREATE / UPDATE { category } — категория досок (ADR-0058; 87/88), всем участникам пространства, кроме гостей; в READY — `WorkspaceSnapshot.board_categories`; перенос — UPDATE каждой сдвинутой
BOARD_CATEGORY_DELETE         { workspace_id, category_id } — (89) её доски уходят в «без категории» хвостом, каждой — `BOARD_UPDATE`
TASK_CHECKLIST_UPDATE         { workspace_id, board_id, task_id, checklist, checklist_total, checklist_done } — (90) чек-лист создан/изменён, целиком (≤ 100 пунктов), зрителям доски. **`TASK_UPDATE` на операции чек-листа не шлётся**: клиент патчит два счётчика задачи; рядом — обычный `TASK_ACTIVITY` (`kind = checklist`)
TASK_CHECKLIST_DELETE         { workspace_id, board_id, task_id, checklist_id, checklist_total, checklist_done } — (91) чек-лист удалён, новые счётчики
BOARD_RULE_UPDATE             { workspace_id, board_id, rule } — (92) правило автоматизации создано/изменено (ADR-0060); после срабатываний — только когда сменилось last_error; зрителям доски (`VIEW_BOARD`, не по карточкам)
BOARD_RULE_DELETE             { workspace_id, board_id, rule_id } — (93) правило удалено; создание/удаление сопровождает `BOARD_UPDATE` (`rules_count`)
TASK_GIT_LINKS_UPDATE         { workspace_id, board_id, task_id, links, count } — (94) Git-связи задачи (все, ≤ 50) изменились; зрителям доски и приглашённым по карточке (ADR-0059); рядом `TASK_UPDATE` (`git_links_count`) и `TASK_ACTIVITY` (`kind = git`)
SIP_CALL_UPDATE               { call: SipCall } — телефонный звонок комнаты начат или сменил статус (ADR-0046); в READY — WorkspaceSnapshot.sip_calls (живые)
WORKSPACE_APP_UPSERT          { app: WorkspaceApp } — веб-приложение пространства добавлено / изменено / перенесено (ADR-0050; перенумерация — по событию на каждое); в READY — WorkspaceSnapshot.apps
WORKSPACE_APP_DELETE          { workspace_id, app_id } — приложение удалено: клиент убирает иконку, десктоп закрывает вид и чистит данные сайта
```

Фильтрация по получателю (выполняет gateway, без запросов в БД — у инстанса кэш комнат и ролей каждого workspace, обновляемый самими событиями):
- `ROOM_ADMISSION_*` (ADR-0040) — решающим: `MANAGE_ROOM` в комнате или автор ссылки (`admission.invite_created_by`, не гость). Гость получает `ROOM_ADMISSION_DECIDED` в `user:<id>`; после `ADMITTED` комната приходит обычным `ROOM_CREATE` (из `ROOM_PERMISSIONS_UPDATE`) — порядок между этими двумя событиями не гарантирован.
- `BOT_*` — участникам с `MANAGE_WORKSPACE` и владельцу бота (ему `BOT_UPDATE` приходит и в `user:<id>`). `MESSAGE_CREATE` с `Message.command` — команда остаётся только у адресованного бота, остальные получают обычное сообщение (и в DM).
- `MESSAGE_*`, `VOICE_STREAM_*`, `ROOM_RECORDING`, `SIP_CALL_UPDATE` — только тем, у кого `VIEW_ROOM` в комнате; `TYPING_START` — кроме того только сессиям, подписанным на комнату через `SUBSCRIBE` (и не самому печатающему).
- `ROOM_UPDATE` / `ROOM_PERMISSIONS_UPDATE` / `WORKSPACE_MEMBER_UPDATE` (смена ролей) / `ROLE_UPDATE` / `ROLE_DELETE` (права, порядок, удаление роли — для всех её держателей) пересчитывают видимость: доступ появился → получатель видит `ROOM_CREATE` с комнатой (голосовая с идущим звонком — с `voice_started_at`, за ней `VOICE_STATE_UPDATE` каждого участника: раньше их состояния приходили ему без комнаты), пропал → `ROOM_DELETE` (клиент убирает и голосовые состояния этой комнаты), остался → исходное событие. Смена `Room.restricted` (ADR-0029) — `ROOM_UPDATE` и следом `ROOM_PERMISSIONS_UPDATE` с теми же переопределениями (пересчёт грантов звонка).
- `READ_RECEIPT` (docs/09 #92): публикуется `PUT /api/rooms/{id}/read`, только если маркер сдвинулся и не бот. DM — сразу собеседнику (`user:<id>`). Комната — если чьё-то «прочитали другие» выросло (маркер читателя дальше второго по дальности маркера остальных; `TopRoomReads`: индекс `read_states_room_id_idx` + top-3), не чаще раза в 3 с на комнату (Redis `rr:<room>`: первое событие сразу, одно завершающее в конце окна с текущими маркерами). В `ws:<id>` уходит самый дальний маркер с внутренним `except_user_id` (его владелец): gateway не шлёт событие ему и ботам и вырезает поле; владельцу — второй по дальности в `user:<id>`. Чтения ботов не считаются, ботам события не приходят. Клиент хранит максимум.
- `WORKSPACE_APP_*` (ADR-0050) — всем участникам пространства, кроме гостей и ботов; `WorkspaceSnapshot.apps` гостям и ботам пуст. Гость, ставший участником, получает список `GET …/apps` сам (клиент по `WORKSPACE_MEMBER_UPDATE` своей роли).
- `VOICE_STATE_UPDATE` для невидимой получателю комнаты приходит с пустым `room_id` (пользователь выглядит не в голосе).
- `EVENT_*` (ADR-0038) — организатору, участникам встречи и тем, кто видит её комнату; гостям — никогда. Адреса внешних участников: полностью — вовлечённым и тем, кто может менять встречу (`MANAGE_ROOM` в комнате / `MANAGE_WORKSPACE` без комнаты), остальным — маской `a***@домен`, ботам — пусто. `ROOM_EVENT_*` — видящим комнату, кроме гостей.
- `BOARD_*`, `TASK_*` (ADR-0042) — тем, у кого `VIEW_BOARD` на доске (gateway держит доски с переопределениями и комнаты задач); `BOARD_CREATE/UPDATE` — с битами получателя, доступ к доске появился / пропал (переопределения доски, роли) → `BOARD_CREATE` / `BOARD_DELETE`. Комментарии — обычные `MESSAGE_*` / `MESSAGE_REACTION_*` / `TYPING_START` / `READ_RECEIPT` комнаты задачи, по `VIEW_BOARD`; гостям — никогда. Личное (`TASK_UPDATE` с `notice`: ASSIGNED / MENTIONED / COMMENT / STATUS / APPROVAL_REQUESTED / APPROVED / REJECTED, и `unread`) — в `user:<id>`. `BOARD_CATEGORY_*` (ADR-0058) — всем участникам, кроме гостей; `TASK_CHECKLIST_*` — зрителям доски (маршрутизация `gateway/boards.go: routeBoards`, классификация — `identity.go: eventScope`). Согласование (ADR-0049) отдельных событий не имеет: `approvers` / `approval_required` / `approval_state` приходят в задаче `TASK_UPDATE`.
- Вступление в workspace → `WORKSPACE_CREATE { snapshot }` на все устройства пользователя; выход/исключение/удаление → `WORKSPACE_DELETE`.
- `VOICE_STREAM_STOP.reason`: `ENDED` | `LIMIT_REACHED` (превышен `max_streams`, трек заглушён сервером) | `MODERATOR`.
- События DM-комнат (`MESSAGE_*`, `MESSAGE_REACTION_*`, `TYPING_START`) идут не в `ws:<id>`, а в `user:<id>` обоим участникам, с пустым `workspace_id`; `TYPING_START` DM — только сессиям получателя с `SUBSCRIBE` на комнату. Так же — голос звонка DM (`VOICE_STATE_UPDATE`, `VOICE_STREAM_*`, `VOICE_CAMERA_STOP` с `room_id` = DM, ADR-0034) и `CALL_RING`/`CALL_STATE`: в пространства они не попадают.

Payload'ы — protobuf-сообщения в `proto/calaba/v1/gateway.proto`; Go и TS типы генерируются из них.

## Масштабирование gateway

- Сессии/буферы в Redis; gateway-сессия живёт на инстансе-владельце (`gw:sess:<id>.owner`), пока подключена или ждёт RESUME. RESUME на другом инстансе забирает сессию: просит владельца отдать её (`gw:ctl:<instance>`), тот сбрасывает буфер и отпускает; мёртвого владельца (нет lease `gw:inst:<id>`) не ждут.
- Fan-out через Redis pub/sub: каналы `ws:<workspaceId>`, `user:<userId>`, `session:revoked:<sessionId>`; инстанс подписан по шаблонам (`PSUBSCRIBE ws:* user:* …`; с `REDIS_KEY_PREFIX` все ключи и каналы начинаются с префикса, а шаблон один — `<префикс>*`, docs/06 «Общий Valkey») и держит карту `workspaceId → Set<session>`. Payload — 16-байтный id события + protobuf `DispatchEvent`; id нужен для дедупликации (presence публикуется во все общие workspace) и при передаче сессии между инстансами.
- Разрыв подписки на pub/sub (Redis перезапущен) → события за это время потеряны → всем сессиям инстанса `INVALID_SESSION{false}`, клиенты делают `IDENTIFY`.
- Требуется Redis ≥ 7.4 (HEXPIRE для per-session TTL в presence); сервер проверяет версию при старте.
- Presence: см. раздел «Несколько устройств» ниже.
- При деплое — `RECONNECT` с задержкой-разбросом, чтобы не было thundering herd.

## Несколько устройств

Пользователь может быть одновременно залогинен на нескольких устройствах (каждое — своя `sessions`-запись и свой gateway-сокет).

**Voice:**
- LiveKit participant identity = `<user_id>:<session_id>`.
- **В голосе — одно устройство** (владелец, 29.09; вход, чат и presence остаются многоустройственными). `POST /api/rooms/{id}/join` с устройства B (комната любого пространства или звонок один на один) под пользовательской блокировкой `voice:ulock:<user_id>` записывает B (pending) и выводит из голоса все прочие устройства пользователя (активные сессии из `sessions` → `voice:sess:*`): каждому — `VOICE_DISCONNECTED{workspace_id, room_id, session_id, reason: OTHER_DEVICE}` в канал пользователя (действует только устройство с этим `session_id`), затем `RemoveParticipant`, снятие voice state и `VOICE_STATE_UPDATE`. Устройство помечается `voice:superseded:<session_id>` = `<scope>/<room>` (15 мин, снимается его собственным `/join`): его поздний `participant_joined` и reconcile в этой комнате отклоняются (удаляется из LiveKit), так что старый токен не возвращает его. Та же сессия (повторный `/join`, реконнект, перемещение модератором по ADR-0019) никого не выводит. Два устройства, входящие одновременно, упорядочены блокировкой — выигрывает последнее.
  - Клиент A по `VOICE_DISCONNECTED`: выходит из голоса без попытки переподключения (цикл rejoin останавливается), островок — в idle, тост «Вы подключились с другого устройства». `PARTICIPANT_REMOVED` от LiveKit ждёт это событие 500 мс, прежде чем считать отключение модераторским.
  - Звонок один на один: вывод устройства из сессии звонка **не завершает звонок** — A не шлёт hangup, а «отпускает» звонок, как принятый на другом устройстве. Если B вошёл в сам звонок, звонок продолжается с B; если B ушёл в комнату пространства, пользователь покинул сессию звонка — сервер завершает звонок по правилу «потерян 30 с» (ADR-0034).
  - Если `/join` B не дошёл до LiveKit (сеть, отказ), A остаётся вне голоса — принято: пользователь сам зашёл с B.
- `voice_states` в Redis хранятся по сессии; наружу `VOICE_STATE_UPDATE` отдаётся **агрегированно по пользователю**: пользователь в комнате своего последнего вошедшего устройства; `muted`/`deafened`/`streaming` — от сессии в этой комнате (кратковременно, пока A выводится, их может быть две: `streaming` = любая стримит, `muted` = все замьючены).

**Presence:**
- Redis-хэш `presence:<user_id>`: поле на каждую gateway-сессию (`<session_id>` → `status`) со своим TTL (HEXPIRE) = 2 × `heartbeat_interval`, продлевается каждым heartbeat; `presence:seen:<user_id>` — `last_seen`. Сессия умерла без закрытия → её поле истекает; sweeper (раз в 15 с, один инстанс) публикует OFFLINE, когда у пользователя не осталось живых сессий.
- Итоговый статус — максимум по приоритету среди сессий: `dnd` > `invisible` > `online` > `idle` (ручной статус не перебивается AFK-`idle` с другого устройства); `invisible` показывается как offline, `last_seen` не раскрывается.
- `PRESENCE_UPDATE` рассылается только при смене агрегированного статуса.
- **Ручной статус со сроком** (меню статуса: 15 мин … 3 дня / навсегда) — per-user, общий для всех устройств: `SetPresence{status, until}` (`until` = 0 — без срока, `online` или прошедшее время — сброс, не дальше 30 дней). Хранится в `users.presence_status/presence_until` (Postgres, переживает рестарт Valkey — при старте копируется обратно) и в Valkey `presence:manual:<user_id>` = `<status>:<until_ms>` с PXAT до `until`. Ручной статус перебивает статусы сессий (включая AFK), но без живых сессий пользователь offline. Другие видят его в `Presence.until` (`PRESENCE_UPDATE`, `READY.presences`); `invisible` для них — `offline` без `until` и `last_seen`, `dnd` — как есть. Сам пользователь получает свой статус как есть (с `invisible`) в `READY.presence` и `USER_UPDATE{presence}` (только своим сессиям). По истечении sweeper (тот же, раз в 15 с) очищает строку, возвращает `online` и рассылает `PRESENCE_UPDATE` во все общие пространства + `USER_UPDATE{presence: online}`. Клиент берёт статус из READY/событий; выбор, сделанный офлайн, отправляет после READY; локальный таймер лишь сбрасывает отображение «до 14:30».
- **Кастомный статус со сроком** (`User.status_expires_at`): тот же sweeper (раз в 15 с, одна инстанция) очищает `status_text/status_emoji/status_expires_at` (`ExpireCustomStatuses`) и рассылает `PRESENCE_UPDATE` с пустым статусом во все пространства пользователя + `USER_UPDATE{me}` его устройствам и `USER_UPDATE{user}` пространствам (как `PATCH /api/me/status`).
  Клиент ставит один `setTimeout` на `statusExpiresAt` и в момент истечения сам обнуляет статус в `session.me` и `users[me]`; событие сервера это подтверждает (issue #17).

## Voice state — источник LiveKit

- Webhooks LiveKit (`participant_joined/left`, `track_published/unpublished`, `room_finished`) → `POST /api/rtc/webhook` (подпись проверяется) → обновление `voice_states` сессии (`<user_id>:<session_id>` из identity) в Redis → агрегация по пользователю → `VOICE_STATE_UPDATE`.
- Клиент дополнительно оптимистично шлёт своё состояние (mute/deafen) через REST `PATCH /api/voice/self`, чтобы UI у всех обновлялся без задержки webhook. Состояние микрофона также берётся из webhook `track_published/unpublished` (mic) — вебхуков mute/unmute у LiveKit нет.
- **Режим музыканта** (ADR-0052): `VoiceState.musician` — устройство пользователя в этой комнате шлёт микрофон без эхо-/шумоподавления и AGC (агрегат — «хоть одно устройство»). Ставит его только сам клиент: `PATCH /api/voice/self {musician}` (как mute/deafen; переход устройства в другую комнату флаг сохраняет, новое подключение — без флага, клиент досылает при сверке `VOICE_STATE_UPDATE`). Включить можно, только если режим есть в тарифе пространства голосовой комнаты (`PlanLimits.musician_disabled`, Free — нет; звонок один на один — любое пространство пользователя), иначе `409 PLAN_LIMIT`; выключение принимается всегда. Смена флага — `VOICE_STATE_UPDATE`.
- Webhook-события дедуплицируются по `id` (LiveKit ретраит доставку). Устройство отозванной сессии, успевшее подключиться, отключается при `participant_joined`.
- Изменение прав/роли/членства/отзыв сессии → сервер обновляет grant участника (`UpdateParticipant`) или отключает его (`RemoveParticipant`); удаление комнаты → `DeleteRoom`.
- Reconcile: раз в 30 с сервер сверяет `ListParticipants` с Redis (пропущенные webhook'и).
- **Оптимистичный вход** (docs/09 P1 #8). `POST /api/rooms/{id}/join` сразу записывает voice-state устройства с `pending = true` и шлёт всем `VOICE_STATE_UPDATE` — участник виден в комнате до подключения к LiveKit. Запись и проверка `user_limit` идут под блокировкой workspace: pending-устройства занимают место. Ответ несёт `pending`. Повторный `/join` устройства, уже записанного в комнате, ничего не меняет (`pending = false`, если оно уже подключено). При переходе из другой комнаты mute/deafen устройства сохраняются.
  - `participant_joined` снимает `pending` (`joined_at` остаётся от `/join`). Если за 15 с устройство не подключилось, состояние снимается (`VOICE_STATE_UPDATE` с пустой комнатой); если подключилось, но webhook потерян, — снимается `pending`. Таймер тот же, что у app-level move (ADR-0019; там перемещённое устройство тоже `pending`). Страховка — reconcile: pending моложе 15 с он не трогает, старше и без участника в LiveKit — удаляет, с участником — снимает `pending`.
  - **Выход** — `POST /api/rooms/{id}/voice/leave` (только своя сессия, всегда 204): снимает состояние устройства в этой комнате (pending или connected) с `VOICE_STATE_UPDATE` сразу, отменяет 15-секундное ожидание и удаляет участника из LiveKit, если он там есть. Устройство, уже записанное в другой комнате (новый `/join`), не трогается. Клиент вызывает его при «Отключиться» и отмене входа — после `room.disconnect()`, без ожидания ответа, но после ответа `/join`, если тот ещё в пути; следующий `/join` ждёт незавершённый leave (≤ 3 с).
  - Агрегат по пользователю: `pending` = все его устройства в этой комнате ещё подключаются. Клиент до ответа `/join` вставляет себя в список сам, а при ошибке `/join` убирает.
  Свежие записи не удаляются (grace 15 с от начала прохода): состояние с `joinedAt` и стрим (демонстрация экрана) со `startedAt` моложе «начало − 15 с» могли появиться по webhook'у уже после листинга; запись стрима без времени старта считается старой.
- **Восстановление голоса после разрыва** (docs/09 #71, issue #15). Источник истины о месте устройства — сервер; `VOICE_STATE` агрегирован по пользователю, поэтому клиент сверяется не по снимку, а теми же идемпотентными вызовами, что и при входе/выходе (сервер не меняется). Проверка места запускается после `READY`/`RESUMED`, когда запоздавший `/join` (перебитый новым переходом) всё же дошёл до сервера, и когда свой `VOICE_STATE_UPDATE` 3 с показывает меня не там, где я подключён. Во время входа/перехода/выхода/перемещения проверка ждёт их завершения (они сами приводят сервер в порядок).
  - LiveKit подключён к комнате R → `/voice/leave` «потерянных» комнат, затем повторный `POST /rooms/R/join`: сервер, у которого устройство есть, ничего не меняет; потерявший — записывает его снова (`pending`, подтверждается по LiveKit) и клиент досылает mute/deafen. Отказ `403`/`404`/`409` (нет доступа, комнаты нет, полна) — невосстановимо: `leave` с тостом «Соединение с голосом потеряно», без «призрака». Сеть/5xx — ждём следующего переподключения.
  - Место есть, LiveKit нет: цикл переподключения (1, 2, 4… с) пропускает ожидание и сразу делает `/join` с новым токеном; LiveKit, который сам переподключается ещё 5 с после возврата gateway, заменяется таким же `/join`.
  - Не в голосе: `/voice/leave`, не дошедший из-за сети, и запоздавший `/join` в комнату, которую я уже покинул, досылаются как `/voice/leave` этой комнаты.
  - Запросы места упорядочены: `/join` ждёт (до 3 с) незавершённые `/voice/leave` и предыдущий `/join`, чтобы старый не обогнал новый.

## Звонки один на один (ADR-0034)

- REST (контракт — `call.proto`): `POST /api/dms/{id}/call` → `201 {call}` (RINGING; `404` не участник, `403` нельзя звонить этому человеку — бот, гость, нет общего пространства полными участниками, `409 IN_CALL` у звонящего уже есть звонок, `409 BUSY` у вызываемого есть — звонка нет, в DM карточка BUSY, `429` + `Retry-After` — больше 10 звонков подряд / 10 в минуту на пользователя или больше 3 подряд / 2 в минуту в одну DM: перезвон со сбросом не превращается в спам). `POST /api/calls/{id}/accept` (вызываемый) · `/decline` (вызываемый) · `/cancel` (звонящий) — только RINGING; `/hangup` (любой) — только ACTIVE → `200 {call}`; `404` чужой/неизвестный звонок, `403` не та сторона, `409` не то состояние (второй accept, hangup после конца).
- События: `CALL_RING {call, caller}` — устройствам вызываемого; `CALL_STATE {call}` — обоим на создании и каждом переходе (принятие/отклонение на одном устройстве закрывает входящий на остальных). Без ответа 45 с → `MISSED`; ACTIVE, где кто-то ≥ 30 с без устройства в сессии (вышел и не вернулся или так и не вошёл после ответа) → `ENDED`, `reason: "lost"`; hangup — `reason: "hangup"`.
- `READY.call` — текущий RINGING/ACTIVE-звонок получателя (входящий или исходящий): после реконнекта клиент восстанавливает модалку / in-call UI. `RESUME` досылает пропущенные `CALL_*` из буфера.
- **Голос** — `POST /api/rooms/{dm_room_id}/join` после ACTIVE (обе стороны; иначе `409 CALL_NOT_ACTIVE`): LiveKit-комната `dm:<room_id>`, токен сразу с `microphone`, `screen_share(+audio)`, `camera` (`can_speak/can_stream/can_video = true`, `plan_limits` нет, `media`: 48 кбит/с, до 1080p). Дальше как в комнате: pending и 15-секундное подтверждение, `PATCH /api/voice/self`, `/voice/leave`, `/stream/request` и `/camera/request` (отвечают сразу, grant уже есть), `/camera/stop`. `VOICE_STATE_UPDATE` звонка — `workspace_id` пуст, `room_id` = DM, только двум участникам. Конец звонка закрывает LiveKit-комнату (состояния снимаются).
- `Presence.on_call` — пока звонок ACTIVE, `PRESENCE_UPDATE` во все пространства пользователя (с кем — не раскрывается); при невидимом/офлайн статусе не показывается.
- Лог: на каждый конец — системное сообщение DM `system.call = CallCard {caller_id, outcome: ENDED | MISSED | DECLINED | CANCELLED | BUSY, duration_sec, started_at, call_id}`, автор — звонящий (`MESSAGE_CREATE` обоим). MISSED у вызываемого непрочитан и достаёт DM из архива (клиент: уведомление «Пропущенный звонок от X»); остальные исходы сразу прочитаны: `READ_STATE_UPDATE` следом звонящему и вызываемому (если у того в DM не было непрочитанного).
- Боты не звонят и не принимают (`403 BOT_NOT_ALLOWED`), позвонить боту — `403`; карточки в DM с ботом не бывает.

## Запись встреч (ADR-0025)

- `GET /api/workspaces/{id}/integrations/gptunnel` (участник, не гость) → `{ integration: { paired, deviceName, account, pairedBy, pairedAt, webUrl } }`; `POST` `{ code: "ABCD-EFGH" }` (`MANAGE_WORKSPACE`) — подключить (заменяет прежнее; `422 CODE_INVALID`, `429`, `503`); `DELETE` → 204 — отключить (токен отзывается в GPTunneL).
- `POST /api/rooms/{id}/recording/start` → `{ recording: RoomRecording }` (участник не гость, `VIEW_ROOM | CONNECT`, голосовая комната, идёт звонок). Ошибки: `403` (гость / `allow_recording = false`), `409 NOT_PAIRED`, `409 ALREADY_RECORDING`, `409 RECORDING_LIMIT` (`used`/`limit`), `409 CONFLICT` (в звонке никого), `503` (egress недоступен). `POST …/recording/stop` → `{ recording }` со `state = STOPPED`, `404`, если запись не идёт.
- Результат записи (docs/09 #47, docs/17): карточка `RecordingCard` в `DONE` несёт `summary` (Markdown из GPTunneL), `has_transcript`, `result_pending` (ещё забираем), `audio_until` (аудио — вложение `audio/mp4` этого же сообщения до `RECORDING_KEEP_DAYS`); всё меняется через `MESSAGE_UPDATE`. `GET /api/rooms/{id}/recordings/{rid}/transcript` → `GetRecordingTranscriptResponse {language, segments[{speaker (-1 — неизвестен), start_ms, end_ms, text}]}` — `VIEW_ROOM` в комнате (в ограниченной — только допущенные), иначе/нет транскрипта/удалена — `404`. `DELETE /api/rooms/{id}/recordings/{rid}` → `204` (#50): кто запустил, владелец пространства или `MANAGE_MESSAGES` в комнате; удаляет аудио, файл, саммари и транскрипт (и запись в GPTunneL, best effort), карточка → `deleted_at`/`deleted_by`; идущая запись — `409 CONFLICT`, `403`, `404`.
- Повтор после `FAILED` (docs/09 #40), права как у `start` (`allow_recording` не требуется; при приостановке — `403 WORKSPACE_SUSPENDED`) → `{ recording: RecordingCard }`, карточка обновляется `MESSAGE_UPDATE`:
  - `POST /api/rooms/{id}/recordings/{rid}/recheck` — файл был доставлен в GPTunneL (`not_uploaded = false`): `FAILED → PROCESSING`, статус опрашивается заново по `gptunnel_id`, окно 2 ч — с нуля.
  - `POST /api/rooms/{id}/recordings/{rid}/reupload` — загрузка не завершилась (`not_uploaded = true`) и файл ещё на сервере (7 дней): `FAILED → UPLOADING`, файл уходит в GPTunneL новой записью (`client_id = <id>#<n>`).
  - Ошибки: `404` (нет такой записи в комнате), `409 NOT_PAIRED`, `409 CONFLICT` (не `FAILED`; recheck — файл не доставлен), `409 ALREADY_UPLOADED` (reupload доставленного — повторно не отправляем), `409 FILE_GONE` (файла нет). При 409 про запись сервер обновляет и карточку.
- Опрос статуса: ответ GPTunneL `failed` с `error = internal` и HTTP 5xx — не финал, опрос продолжается до 2 ч (по истечении — `FAILED` с `internal` / `timeout`).
- `READY` / `WORKSPACE_CREATE`: `WorkspaceSnapshot.recordings[]` — идущие записи видимых комнат (`state = ACTIVE`); таймер «REC» — от `since`.
- Карточка в чате комнаты — системное сообщение: `Message.kind = SYSTEM`, `content` пуст, `system.recording = RecordingCard { recording_id, started_by, started_at, duration_sec, status: UPLOADING | PROCESSING | DONE | FAILED, web_url, error, file_gone, not_uploaded }`, автор — кто начал запись. Появляется при остановке (`MESSAGE_CREATE`), дальше обновляется (`MESSAGE_UPDATE`, без `edited_at`). Редактировать нельзя (403), удалять/закреплять/реагировать — как обычное. `error`: коды GPTunneL (`insufficient_balance`, `empty_audio`, …) или наши (`device_revoked`, `not_paired`, `upload_failed`, `no_audio`, `recorder_failed`, `timeout`). `FAILED`: `not_uploaded = false` → кнопка «Проверить снова»; `not_uploaded = true` и `file_gone = false` → «Отправить снова»; иначе кнопок нет (старые карточки без полей — «Проверить снова»).
- `Room.allow_recording` (по умолчанию `true`) меняет `PATCH /api/rooms/{id}` `{ allowRecording }` — нужно `MANAGE_WORKSPACE`.

## Телефония (ADR-0046)

REST и коды ошибок — `proto/calaba/v1/sip.proto` и ADR-0046 «Контракт для клиента». Кратко: настройки `GET|PUT /api/workspaces/{id}/sip`, проверка `POST …/sip/test`, журнал `GET /api/workspaces/{id}/calls` (всё — `MANAGE_WORKSPACE`, не боты); звонок `POST /api/rooms/{id}/calls {number}` и `DELETE /api/rooms/{id}/calls/{cid}`. Статусы — `SIP_CALL_UPDATE`; телефонная линия — участник LiveKit `sip:<call id>` с именем = номер.

## Дни рождения (docs/09 #76)

- `PATCH /api/me` `{ birthday: {day, month, year?} }` — задать (`422` на несуществующую дату, год вне 1900..текущий или в будущем; `{day: 0, month: 0}` — очистить), `{ birthdayHidden }` — скрыть/показать; гостям и ботам — `403`. Изменение — `USER_UPDATE` в пространства (`User.birthday` без скрытого) и `{me}` на свои устройства.
- Воркер раз в час (и при старте, на каждом инстансе — карточку «забирает» вставка в `birthday_greetings`): у кого сегодня день рождения и местное время ≥ 09:00 — в каждое его пространство (не гость, не приостановлено, есть кто-то ещё кроме ботов) системное сообщение в первую текстовую комнату по порядку сайдбара, публичные раньше приватных: `Message.kind = SYSTEM`, `system.birthday = BirthdayCard {day, month}`, автор — именинник, `MESSAGE_CREATE`. Уведомления, звук и счётчики — как у обычного сообщения по правилам комнаты (клиент, `notify.ts`); самому имениннику — как своё. Скрытый день рождения карточки не получает. Пояс «сегодня» и 09:00 — `birthdays.GreetZone`: `User.timezone` именинника, нет — пояс владельца пространства (`Workspace.owner_id`; команда в Москве получает открытку в 09:00 МСК, не в 12:00), нет и его — UTC; неизвестное имя пояса = не задан. Клиент повторяет правило (`lib/birthday.ts` `greetZone`) для подсказки «Открытка в чате появится в …» на плашке панели участников.
- `GET /api/workspaces/{id}/birthdays?days=7` (участник не гость; гость — `403`, не участник — `404`; `days` 1..31, иначе `422`) → `ListBirthdaysResponse { birthdays: [{user_id, birthday, in_days}] }` — ближайшие дни рождения участников по «сегодня» вызывающего (его пояс, иначе UTC), по возрастанию `in_days`; скрытые и боты не входят.

## Календарь (ADR-0038)

```
GET    /api/workspaces/{id}/events?from=&to=   RFC 3339, окно ≤ 62 дня → ListCalendarEventsResponse { events: вхождения по началу }
POST   /api/workspaces/{id}/events             CreateCalendarEventRequest → 201 CalendarEventResponse (не гость, не бот)
GET    /api/events/{id}                        серия (отменённая — с cancelled_at, для ссылки /e/<id>); не видна — 404; гость — текущее вхождение активной встречи видимой комнаты без участников, иначе 404
PATCH  /api/events/{id}                        UpdateCalendarEventRequest → CalendarEventResponse (организатор / MANAGE_ROOM / MANAGE_WORKSPACE)
DELETE /api/events/{id}[?occurrence=<RFC 3339>] 204: отмена встречи (письмо CANCEL) или одного вхождения серии (EVENT_UPDATE, письмо с EXDATE)
PUT    /api/events/{id}/rsvp                   { status: ACCEPTED | DECLINED | MAYBE } → CalendarEventResponse (только участник)
GET    /api/me/events/today?tz=                сегодняшние предстоящие встречи (не отклонённые) во всех пространствах → { count, events }
GET    /api/event-rsvp?t=                      публично: встреча по view- или answer-токену внешнего участника → EventRsvpTokenResponse (описание, комната, my_status, три answer-токена, guest_url + окно, повтор, почта организатора; без других участников)
POST   /api/event-rsvp { token }               публично: сохранить ответ answer-токена (идемпотентно); view-токен — 400; после конца — 410 EVENT_OVER; битая — 404
```

- Ошибки: `422` — название 1..120, описание ≤ 4000, конец > начала и ≤ 7 дней, неизвестная `tz`, комната не голосовая/чужая/невидимая, участник не из пространства / бот / гость, > 100 участников или > 20 внешних адресов, `repeat_until` раньше начала; гость — `403`; внешние адреса без подтверждённой почты — `403 EMAIL_NOT_VERIFIED`; 30 изменений сразу, 120 в час на пользователя — `429`.
- Вхождение в списке: `occurrence_at` = его начало, `starts_at`/`ends_at` — его время, `recording_id` — запись этого вхождения; `my_status`, `can_edit`, `counts` посчитаны для вызывающего. Повтор серии: `EventRepeat` (день / неделя / две недели / месяц — месяцы без такого числа пропускаются) + `repeat_until`; разворачивается в зоне `tz` (время на часах сохраняется при переходе на летнее время).
- Письма (ADR-0023, outbox): при создании — `event_invite` каждому участнику с подтверждённой почтой и внешним адресам; при изменении времени/комнаты/названия/описания/повтора — `event_update` всем (SEQUENCE + 1), добавленным — `event_invite`, удалённым — `event_cancel`; при отмене — `event_cancel`. Вложение `invite.ics` (и `text/calendar; method=…` в alternative): `UID=<id>@calab`, `SEQUENCE`, `DTSTART/DTEND` в UTC (повторяющаяся встреча в зоне с DST — `TZID` + `VTIMEZONE`), `RRULE`, `EXDATE`, `ORGANIZER`, `ATTENDEE` с `ROLE=REQ/OPT-PARTICIPANT`, `URL=https://<APP_HOST>/e/<id>` (внешним — `/e/<id>?t=<view-токен>`, как и кнопка письма; срок — конец встречи/серии + 1 ч); `Reply-To` — подтверждённая почта организатора. Внешним — ссылки ответа и гостевая ссылка в комнату; их `invite.ics` — только `ORGANIZER` и свой `ATTENDEE`, «Участники» — имена коллег и свой адрес. Лимит писем встреч на адрес — свой (`MAIL_EVENTS_PER_ADDRESS_PER_HOUR`, 10; коды и приглашения его не делят): сверх него письмо не уходит (в логе).
- Напоминания: метёлка раз в 30 с на каждом инстансе; вхождения ближайших 25 ч; каждому участнику (и организатору), кто не отклонил и остаётся участником пространства, по его `event_reminders` (окно отправки — 2 мин после момента напоминания); при DND — только если `event_reminders_dnd`. `ROOM_EVENT_ACTIVE` — один раз на вхождение (и сразу при создании/переносе внутрь окна), `ROOM_EVENT_ENDED` — по окончании (до часа спустя), при отмене и переносе.
- `READY` / `WORKSPACE_CREATE`: `WorkspaceSnapshot.active_events` — активные сейчас вхождения видимых комнат (гостям — без участников, записи и прав; `ROOM_EVENT_ACTIVE/ENDED` гостям комнаты — так же; `EVENT_*` гостям не уходят).
- Настройки напоминаний: `PATCH /api/me { eventReminders: { minutes: [...], dnd } }` (≤ 5 различных из 5/10/15/30/60/120/1440, иначе `422`); в `Me.settings.event_reminders` / `event_reminders_dnd` (по убыванию; по умолчанию `[60, 5]`, да).
- **Свободно/занято и подбор времени (ADR-0041):**
  ```
  GET    /api/workspaces/{id}/freebusy?users=<id,…>&from=&to=   ≤ 20 участников, окно ≤ 14 дней → FreeBusyResponse { users: [{ user_id, timezone, work_hours, busy: [{ starts_at, ends_at, event_id?, kind, all_day }] }] }
  POST   /api/workspaces/{id}/freebusy/suggest                   SuggestSlotsRequest { users, duration_min, from, to, within_work_hours, room_id? } → SuggestSlotsResponse { slots: до 10 }
  GET|POST|PUT|DELETE /api/me/caldav · POST /api/me/caldav/sync  CalDAV-аккаунт → CalDavAccountResponse { account } (нет аккаунта — account отсутствует)
  ```
  Занятость `MEETING` — встречи (всех пространств человека), где он организатор или участник с ответом не «отклонил»; `event_id` — только если вызывающий видит встречу в этом пространстве; встреча «весь день» — занятость с полуночи до полуночи дней в зоне человека (`all_day`). `EXTERNAL` — импорт из CalDAV, всегда без id. Подбор: сетка 15 мин (UTC), не раньше «сейчас», длительность 5..1440 мин; `within_work_hours` — пересечение рабочих часов всех, пусто в окне → `409 NO_COMMON_HOURS`; `room_id` — видимая комната, её встречи тоже занятость. Ошибки: гость, бот — `403`; не участник пространства в `users` — `422`; лимиты 60/мин (freebusy), 30/мин (suggest). Рабочие часы: `PATCH /api/me { workHours: { startMin, endMin, days } }` (`start < end ≤ 1440`, дни 1..7; гость/бот — `403`), читаются из `Me.settings.work_hours`.
  CalDAV: `POST { url, username, password }` — discovery (`PROPFIND` current-user-principal → calendar-home-set → календари с `VEVENT`), `https`, публичные адреса (политика unfurl), 10 с, ≤ 2 МБ, без редиректов; неверный пароль — `422 password`, сервер не найден — `422 url`; 5 в час. Повторное подключение с тем же `url` и `username` сохраняет выбор календаря. `PUT { calendarHref, import, push }` — `calendarHref` из `calendars`, иначе `422`; смена календаря или `import: false` стирает импортированную занятость; включение `push` выгружает текущие встречи. `POST …/sync` — импорт сейчас (раз в минуту; без календаря/с выключенным импортом — `422`). Импорт — метёлка (Valkey-блокировка) раз в `CALDAV_SYNC_INTERVAL` (15 мин): `REPORT calendar-query` окна −1…+30 дней, из `VEVENT` — только `DTSTART/DTEND/DURATION/RRULE/EXDATE/RECURRENCE-ID/STATUS/TRANSP` (прозрачные и отменённые пропускаются, свои `…@calab` — тоже); ошибка — в `last_error`. Экспорт: создание/изменение/отмена встречи и «отклонил/передумал» ставят в outbox `PUT <calendar_href><event_id>.ics` (тот же `.ics`, что в письме, без `METHOD/ORGANIZER/ATTENDEE`, чтобы сервер не рассылал приглашения; `no-uid-conflict` — успех) или `DELETE`; повтор 1/5/15/60 мин, после 5 попыток — ошибка в `last_error`.
- Запись: запись, которую организатор начал в комнате встречи в окне [начало − 15 мин; конец), привязывается к вхождению — `recording_id` в списке и повторный `ROOM_EVENT_ACTIVE`.
- Ссылка `/e/<id>` — страница веб-клиента (SPA, как `/r/<code>`); `/e/<id>/rsvp?t=` — страница ответа внешнего участника.

## Доски задач (ADR-0042)

```
GET    /api/workspaces/{id}/boards[?archived=1]     видимые доски (архив — с MANAGE_BOARD) → ListBoardsResponse; гость — 403
POST   /api/workspaces/{id}/boards                  CreateBoardRequest {name, key?, emoji, is_private, description, template, icon_file_id} → 201 BoardResponse (MANAGE_WORKSPACE; 409 PLAN_LIMIT / BOARD_LIMIT / ключ занят)
GET · PATCH /api/boards/{id}                         BoardResponse; PATCH — UpdateBoardRequest (MANAGE_BOARD; key — до первой задачи, иначе 409)
                                                     PATCH (ADR-0058): + set_disabled_features / disabled_features[] (выключенные фичи доски), estimate_scale (FIBONACCI | LINEAR | TSHIRT); запись выключенной фичи — 409 FEATURE_DISABLED
GET · POST /api/workspaces/{id}/board-categories     категории досок (ADR-0058): ListBoardCategoriesResponse / 201 BoardCategoryResponse (CREATE_BOARDS; ≤ 50 — 409 BOARD_CATEGORY_LIMIT)
PATCH · DELETE /api/board-categories/{id}            UpdateBoardCategoryRequest {name?, position?}; DELETE → 204, доски в «без категории» (CREATE_BOARDS)
PUT    /api/workspaces/{id}/boards/order             SetBoardOrderRequest {boards[{board_id, category_id, position}], categories[{category_id, position}]} → SetBoardOrderResponse; один drag = одна транзакция (MANAGE_BOARD на каждой доске, categories — CREATE_BOARDS; невидимая доска — 422)
GET · PUT · DELETE /api/boards/{id}/webhook          вебхук доски (ADR-0058): BoardWebhookResponse; PUT {url, secret?} — секрет в ответе один раз; MANAGE_BOARD + MANAGE_INTEGRATIONS, Business (иначе 409 PLAN_LIMIT), боты — нет
POST   /api/boards/{id}/webhook/ping                 синхронная доставка `ping` → BoardWebhookPingResponse {ok, status, error}; ≤ 1 раз в 10 с (429)
DELETE /api/boards/{id}[?purge=1]                    204: в архив; purge — навсегда с задачами, комментариями и журналом (только люди)
POST   /api/boards/{id}/restore                      из архива → 201 BoardResponse
PUT    /api/boards/{id}/position {position}          новый индекс в списке (MANAGE_BOARD)
GET · PUT /api/boards/{id}/permissions               BoardPermissionsResponse; PUT {overrides[]} — как у комнат, только биты доски, PUT — только люди
POST · PATCH · DELETE /api/boards/{id}/statuses[/{sid}]    DELETE ?move_to=<sid> (обязательно; default удалить нельзя) → BoardResponse
POST · PATCH · DELETE /api/boards/{id}/labels[/{sid}]      создать — MANAGE_BOARD или CREATE_TASKS («создать лейбл» в пикере)
POST · PATCH · DELETE /api/boards/{id}/milestones[/{sid}]
GET · POST · PATCH · DELETE /api/boards/{id}/views[/{sid}] общие (shared, MANAGE_BOARD) и личные (автор)
POST   /api/boards/{id}/files                        загрузка вложения задачи или комментария (VIEW_BOARD, квота пространства)
GET    /api/boards/{id}/activity?since&until&actor&kind&cursor[&format=csv]   журнал (MANAGE_BOARD или EDIT_TASKS), CSV — целиком
GET    /api/boards/{id}/tasks?filter=<TaskFilter JSON>&archived=1&updated_after&cursor&limit   ≤ 500 за страницу (по номеру) → {tasks, next_cursor}
POST   /api/boards/{id}/tasks                        CreateTaskRequest → 201 TaskResponse (CREATE_TASKS)
GET    /api/tasks/{id}                               TaskResponse {task (+attachments), subtasks, related, parent, room}
PATCH  /api/tasks/{id}                               UpdateTaskRequest (EDIT_TASKS; CREATE_TASKS — свои и назначенные); status_id + after_task_id/before_task_id — перенос; board_id — на другую доску (MANAGE_BOARD на обеих)
POST   /api/tasks/{id}/archive | restore             EDIT_TASKS или автор
PUT    /api/tasks/{id}/assignees {assignees[]}       полный список, ровно один is_lead (не отмечен — первый)
PUT    /api/tasks/{id}/relations {related_id, kind} · DELETE ?related_id&kind
POST   /api/tasks/{id}/checklists {title, position?} чек-листы (ADR-0058): 201 TaskChecklistResponse {checklist, checklist_total, checklist_done}; ≤ 10 на задачу (409 CHECKLIST_LIMIT); права как у полей задачи
PATCH · DELETE /api/checklists/{id}                  {title?, position?}; DELETE → ответ без checklist (счётчики)
POST   /api/checklists/{id}/items {text, position?}  201; ≤ 100 на чек-лист (409 CHECKLIST_ITEM_LIMIT)
PATCH · DELETE /api/checklist-items/{id}             {text?, done?, position?, checklist_id?} (перенос внутри задачи); → TaskChecklistResponse
POST   /api/checklist-items/{id}/convert             → 201 ConvertChecklistItemResponse {task, checklist, счётчики}: подзадача с текстом пункта, пункт удалён (фича SUBTASKS; задача сама не подзадача)
PUT    /api/tasks/{id}/subscription {muted}          · PUT /api/tasks/{id}/read — снять «непрочитано»
GET    /api/tasks/{id}/activity?before&limit         лента: сообщения комнаты задачи и журнал вперемешку, новые первыми (id — uuidv7)
GET    /api/t/{KEY-N}[?workspace_id=]                задача по ключу среди пространств вызывающего (TaskResponse + board)
GET    /api/me/tasks?workspace_id&scope=assigned|lead|created|subscribed&open=1&cursor
GET    /api/workspaces/{id}/tasks/search?q&limit     ⌘K: ключ и слова по видимым доскам
```

- Комментарии — сообщения комнаты `task.room_id` через обычные `/api/rooms/{room_id}/messages*`, реакции, стикеры, закрепы (`EDIT_TASKS`), поиск, пересылка, прочтение и typing; `@<user_id>` подписывает и уведомляет упомянутого, если он видит доску.
- `TaskFilter` → SQL — одна функция `boards.Translate` (поля и операции — `boards.proto`; `"me"` — вызывающий; даты `today|week_start|week_end|month_end|±Nd`, «сегодня» — в поясе профиля).
- `READY` / `WORKSPACE_CREATE`: `WorkspaceSnapshot.boards` (видимые, с битами и общими видами) и `unread_task_ids` (≤ 999).
- Unfurl своих ссылок: `GET /api/unfurl?url=https://<хост приложения>/t/<KEY-N>` или `/b/<id>` отвечает из БД по правам смотрящего (`UnfurlResponse.task` / `board`, без кэша и HTTP), невидимое — 404.
- **Фичи доски (ADR-0058 §3).** `Board.disabled_features` (хранится выключенное) и `estimate_scale` едут в `BOARD_UPDATE`. Любой путь записи (REST = Bot API, «задача из сообщения») на запрос, меняющий поле выключенной фичи на непустое, отвечает `409 CONFLICT`, `reason FEATURE_DISABLED`, `field` = JSON-имя поля; сброс в пусто и повтор текущего значения проходят. Данные не удаляются и отдаются как раньше. `COMMENTS` выкл. — комната задачи без `SEND_MESSAGES | ATTACH_FILES` (состояние шлюза `taskRoomBits`).
- Метёлка автоархива: раз в час (Redis-лок `boards:sweep`), задачи в `completed|cancelled` старше `auto_archive_days` доски → архив, запись журнала `archived {auto: true}` без актора, `TASK_DELETE` + `TASK_ACTIVITY`.

## Боты (ADR-0031)

Бот — пользователь (`User.is_bot`) без email и пароля; права — только роли и переопределения комнат, как у людей (встроенная роль всегда `member`: `admin`/`guest` боту → `422`). Тот же REST и gateway, что у клиента; публичная документация — `docs/19-bot-api.md` (фаза 2).

- **Токен** `calab_bot_<bot_user_id>_<секрет 43 символа base64url>` в `Authorization: Bearer …` и в `IDENTIFY`. В БД — `sha256(секрета)`, проверка при каждом запросе (кэш Valkey ≤ 30 с, при смене токена перезаписывается). `token_id` (перевыпускается с токеном) — «сессия» бота: identity LiveKit `<bot_id>:<token_id>`, одно устройство gateway, отзыв = маркер `auth:revoked:<token_id>` → REST `401`, сокет `4010`, участник LiveKit удаляется. Неверный токен — `401` / `4004`.
- **Маршруты.** Каждый маршрут сервера классифицирован в `internal/app/botroutes.go` (`public` / `allow` / `deny`); тест обходит все маршруты mux, маршрут без решения для бота закрыт. Закрыто (`403 FORBIDDEN`, `reason: "BOT_NOT_ALLOWED"`): сессии, пароль, почта, подтверждение, статус и настройки профиля (`PATCH /api/me` — только `displayName`/`avatarFileId`), заметки, создание/поиск/вступление в пространства, все инвайты и ссылки в комнату (в т.ч. `POST /api/room-invites/{code}/join` и `logout` с токеном бота), уведомления, архив DM, превью ссылок, управление записью встреч (старт/стоп/повтор/удаление), суперадминка, управление ботами. Открыто: сообщения, реакции, закрепы, поиск, файлы, полный транскрипт доступной записи (`VIEW_ROOM`, включая пересланную карточку, ADR-0033), комнаты/категории/роли/участники/баны (по правам), DM, голос (`/join`, стрим, камера, модерация — по правам), `/api/bots/me*`, подсказки команд.
- **Лимиты:** `rl:bot:req:` — `BOT_RATE_PER_SEC` (30, burst 30) запросов на бота, `rl:bot:msg:` — `BOT_MESSAGES_PER_MIN` (20) сообщений на бота во всех комнатах и DM (сверх обычного 5/5 с на комнату); `429` + `Retry-After`. Ботов в пространстве — ключ тарифа `bots` (free 2, team 20): `409 CONFLICT`, `reason: "PLAN_LIMIT"`, `used`/`limit`.
- **Присутствие:** онлайн, пока есть сокет gateway или были REST-запросы за последние 2 × heartbeat (webhook-боты); клиент показывает ботов отдельной секцией по `User.is_bot`.
- **Голос:** как у человека — `POST /api/rooms/{id}/join` (те же права и grant, место в комнате считается), звук — LiveKit-клиентом по `url`/`token`. Отдельной пометки в metadata LiveKit нет: клиент узнаёт бота по `is_bot` участника.

```
POST   /api/workspaces/{id}/bots                 CreateBotRequest{displayName, username, description} → 201 {bot, token}
                                                 (владелец / MANAGE_WORKSPACE, подтверждённый email; username [a-z0-9_]{3,32}, занят → 409)
GET    /api/workspaces/{id}/bots                 ListBotsResponse — боты-участники (MANAGE_WORKSPACE); webhook — у ботов этого пространства
POST   /api/workspaces/{id}/bots/add             AddBotRequest{botUserId | username} → 201 {bot} (MANAGE_WORKSPACE; уже участник → 409)
DELETE /api/workspaces/{id}/bots/{botId}         204: в «домашнем» пространстве — удалить бота (токен, членства, звонки; аккаунт disabled,
                                                 сообщения остаются; владелец бота или MANAGE_WORKSPACE); в другом — убрать (MANAGE_WORKSPACE)
POST   /api/workspaces/{id}/bots/{botId}/token   → {bot, token} — перевыпуск (только дома; владелец бота или MANAGE_WORKSPACE); DELETE — отзыв → 204
GET    /api/bots/{id|username}                   GetBotMeResponse — публичная карточка («Добавить бота»; людям)
GET    /api/bots/me                              GetBotMeResponse (только боты; иначе 403)
PATCH  /api/bots/me                              UpdateBotMeRequest{displayName?, description?} → GetBotMeResponse (+ USER_UPDATE при смене имени)
PUT    /api/bots/me/commands                     SetBotCommandsRequest{commands[{name, description}]} → {commands} (≤ 100, [a-z0-9_]{1,32}, «/» в начале снимается)
GET    /api/bots/me/webhook                      BotWebhookResponse{webhook{url, enabled, disabledAt, failingSince, lastOkAt, lastError, pending}}
PUT    /api/bots/me/webhook                      SetBotWebhookRequest{url (https), secret (16..256)} → BotWebhookResponse; DELETE → 204
GET    /api/rooms/{id}/bot-commands              ListRoomBotCommandsResponse — команды ботов, видящих комнату (VIEW_ROOM), для подсказок композера
GET    /api/me/blocked-bots                      ListBlockedBotsResponse; POST / DELETE /api/me/blocked-bots/{id} → 204 (людям; не бот → 404)
```

- **Команды.** Сообщение, начинающееся с `/name` или `/name@username` (имя `[A-Za-z0-9_]{1,32}`, дальше пробел или конец), всем приходит обычным, а `MESSAGE_CREATE` адресованному боту (gateway и webhook) несёт `Message.command {bot_user_id, name (нижний регистр), args}`. `/name@username` — этому боту, если он видит комнату (команда не обязана быть зарегистрирована); `/name` — единственному боту комнаты с такой зарегистрированной командой (несколько — не команда). В REST-ответах и истории `command` нет; сообщения ботов командами не считаются.
- **DM.** Бот пишет участникам общих пространств (`POST /api/dms`, как человек). Человек блокирует бота — боту `403 BOT_BLOCKED` на новый DM и на сообщения в DM с ним; человек может писать боту.
- **Webhook.** Боту с webhook в очередь `bot_webhook_deliveries` ставятся `MESSAGE_CREATE/UPDATE/DELETE` и `MESSAGE_REACTION_ADD/REMOVE` комнат, которые он видит, и его DM (кроме своих сообщений и реакций). `POST <url>`, тело — `BotWebhookUpdate {id, botUserId, createdAt, event}` (protojson), заголовки `X-Calab-Signature: sha256=<hex HMAC-SHA256(secret, тело)>`, `X-Calab-Delivery: <id>`; успех — любой 2xx за 10 с, редиректы не выполняются. Адрес — только https и публичный (фильтр SSRF как у превью ссылок). Ретраи 1 мин → 1 ч; доставка живёт сутки; webhook, падающий сутки подряд, отключается (`webhook.disabledAt`, очередь сброшена, `BOT_UPDATE` владельцу и управляющим); `PUT` включает снова. Порядок доставок не гарантирован — дедуплицировать по `id`. Воркер один на кластер (Valkey `bots:webhook:worker`).

## REST

Тела запросов и ответов — proto-сообщения из `proto/calaba/v1/*.proto` в JSON (`protojson`): поля в lowerCamelCase (`displayName`), enum — полными именами (`"ROOM_TYPE_VOICE"`), `uint64` (биты прав, байты) — строками, время — RFC 3339; скалярные поля по умолчанию в ответе присутствуют, неизвестные поля в запросе игнорируются. Авторизация — `Authorization: Bearer <access JWT>`.

### Стикеры (ADR-0030)

- `GET /api/workspaces/{id}/sticker-packs` (любой участник) → `{packs[]}`; `POST` `{name, short_name?}` (`MANAGE_STICKERS`; создатель получает пак установленным) → 201; `409 PLAN_LIMIT` сверх `sticker_packs`.
- `GET /api/sticker-packs/{id}` (участник пространства пака) · `PATCH {name?, short_name?, cover_sticker_id?, sticker_ids[]}` · `DELETE` (`MANAGE_STICKERS`) → `STICKER_PACK_UPDATE` / `DELETE`.
- `POST /api/sticker-packs/{id}/stickers` — multipart, перед каждым `file` (WebP) поле `emoji`; ≤ 50 за раз, всё или ничего (`422`, `field = file[i]` / `emoji[i]`), квота как у файлов (`413`), `409 PLAN_LIMIT` сверх `stickers`. `PATCH /api/stickers/{id} {emoji}`, `DELETE /api/stickers/{id}` → пак.
- `PUT /api/sticker-packs/{id}/stickers/{sid}` (`MANAGE_STICKERS`) — замена на месте: multipart `file` (те же проверки, что при загрузке; `422 field = file`) и/или `emoji` (`422 field = emoji`); id, позиция и сообщения со стикером сохраняются (показывают новую картинку), старый файл удаляется, если больше ни одним стикером не используется; ответ — пак, событие `STICKER_PACK_UPDATE`.
- `GET /api/me/sticker-packs` → `{installed[] (мой порядок), available[] (паки моих пространств, где я не гость)}`; `PUT /api/me/sticker-packs/{id}` (в начало), `DELETE …/{id}`, `PUT …/order {pack_ids}` (полный список). События установки нет — клиент перечитывает список.
- Отправка: `POST /api/rooms/{id}/messages {sticker_id, reply_to_id?, nonce}` (`SEND_MESSAGES`; пустой `content`, без вложений); `Message.sticker` в истории и событиях, `DmLastMessage.sticker_emoji` в списке DM.

### Веб-клиент: refresh в cookie (ADR-0015)

- Признак веб-клиента — заголовок **`X-Client: web`**. `Sec-Fetch-*` для этого не годится: его шлёт и Chromium внутри Electron. Без заголовка поведение десктопное, без изменений: refresh-токен приходит в теле ответа.
- `login` / `register` / `refresh` веб-клиента: `tokens.refreshToken` в теле пустой, токен ставится cookie `calaba_refresh` (`HttpOnly; Secure; SameSite=Strict; Path=/api/auth`, срок = срок сессии). Access-токен приходит в теле, как обычно, и хранится только в памяти страницы.
- `refresh` с пустым `refreshToken` берёт токен из cookie и ставит новый (ротация). Предыдущий токен в пределах 60 с после ротации (ответ потерялся или другая вкладка успела раньше), пока новый не использован, получает тот же новый токен (`200`, та же cookie); если повторить ротацию нельзя — `409 ERROR_CODE_CONFLICT`, cookie не трогается: повторите refresh, в cookie уже новый токен. `logout` без `Authorization` и без токена в теле берёт токен из cookie и очищает её (`Max-Age=-1`). Мёртвый токен в cookie → `401`, cookie очищается.
- **CSRF**: запросы с аутентификацией по cookie (`refresh`/`logout` из cookie), а также веб-`login`/`register`, выставляющие cookie, проходят проверку источника:
  - `Origin` задан → он должен точно совпадать с одним из разрешённых origin (схема + хост + порт): `PUBLIC_APP_URLS` (список через запятую) плюс `PUBLIC_APP_URL` и `PUBLIC_APP_URL_ALT`;
  - `Origin` нет → нужен `Sec-Fetch-Site: same-origin`;
  - ни того ни другого → `403 ERROR_CODE_FORBIDDEN`.

  Запросы с `Authorization: Bearer` (все остальные API, десктоп) этой проверке не подлежат: cookie с `Path=/api/auth` в них не участвует.
- `GET /gateway` проверяет `Origin` при апгрейде:
  - без `Origin` (нативные клиенты) — пропускается;
  - `null` / `file://` (собранный Electron) — пропускается;
  - `http://localhost:*` / `http://127.0.0.1:*` (dev) — пропускается;
  - иначе — только разрешённые origin (`PUBLIC_APP_URLS`, `PUBLIC_APP_URL[_ALT]`), остальное → `403`.

  Аутентификация в gateway — по-прежнему `IDENTIFY` с access-токеном.

Реализовано (stage 2, server core):

```
POST   /api/auth/register              RegisterRequest → 201 RegisterResponse
POST   /api/auth/login                 LoginRequest → LoginResponse          (rate-limit по IP)
POST   /api/auth/refresh               RefreshRequest → RefreshResponse      (ротация; повтор старого токена = отзыв сессии)
POST   /api/auth/logout                LogoutRequest{allSessions, refreshToken?} → 204   (сессия — по access-токену, иначе по refresh из тела или cookie)
GET    /api/version                    GetVersionResponse {product "Calab", version, commit, license "BUSL-1.1", commercialLicense, attribution "Powered by GPTunneL", url} — публичный
GET    /api/me                         GetMeResponse
PATCH  /api/me                         UpdateMeRequest → UpdateMeResponse   (+ timezone: IANA-имя, "" — сбросить; публичное поле User.timezone → USER_UPDATE, READY)
GET    /api/me/sessions                ListSessionsResponse
DELETE /api/me/sessions/{id}           204
PATCH  /api/me/password                ChangePasswordRequest{currentPassword, newPassword} → 204; остальные сессии отзываются
PATCH  /api/me/email                   ChangeEmailRequest{newEmail, currentPassword} → UpdateMeResponse (me.pendingEmail; код на новый адрес); 409 — адрес занят
POST   /api/auth/verify/send           → 204: код на pendingEmail или email; 409 — уже подтверждён; без SMTP — помечает подтверждённым
POST   /api/auth/verify                VerifyEmailRequest{code} → VerifyEmailResponse{me, joinedWorkspaceIds}; 422 CODE_INVALID | CODE_EXPIRED
POST   /api/auth/password/forgot       ForgotPasswordRequest{email} → 200 ForgotPasswordResponse{similar_account} (без auth; 503 без SMTP)
POST   /api/auth/password/reset        ResetPasswordRequest{email, code, password} → 204, все сессии отозваны; 422 CODE_INVALID
POST   /api/workspaces                 CreateWorkspaceRequest → 201         (создатель — owner)
GET    /api/workspaces                 ListWorkspacesResponse               (мои)
GET    /api/workspaces/discover        DiscoverWorkspacesResponse           (open, где я не участник)
GET    /api/workspaces/{id}            GetWorkspaceResponse
PATCH  /api/workspaces/{id}            UpdateWorkspaceRequest                (MANAGE_WORKSPACE; включая медиа-дефолты)
DELETE /api/workspaces/{id}            204                                   (только owner)
POST   /api/workspaces/{id}/join       JoinWorkspaceResponse                 (только open-workspace)
GET    /api/workspaces/{id}/invites    ListInvitesResponse                   (MANAGE_WORKSPACE)
POST   /api/workspaces/{id}/invites    CreateInviteRequest → 201
DELETE /api/workspaces/{id}/invites/{inviteId}   204
GET    /api/workspaces/{id}/members    ListMembersResponse
PATCH  /api/workspaces/{id}/members/{userId|@me}  UpdateMemberRequest{role?, nickname?}   (role — legacy: только встроенная роль, свои роли сохраняются)
PUT    /api/workspaces/{id}/members/{userId|@me}/roles  SetMemberRolesRequest{role_ids} → {member}   (MANAGE_ROLES, ADR-0026)
GET    /api/workspaces/{id}/roles      ListRolesResponse                    (любой участник; от старшей к младшей)
POST   /api/workspaces/{id}/roles      CreateRoleRequest{name, color, permissions, mentionable} → 201   (MANAGE_ROLES; ≤ 50 ролей → 409)
PATCH  /api/workspaces/{id}/roles/{roleId}   UpdateRoleRequest{name?, color?, permissions?, mentionable?}
DELETE /api/workspaces/{id}/roles/{roleId}   204                           (только свои роли)
PUT    /api/workspaces/{id}/roles/order      SetRoleOrderRequest{role_ids: свои роли от старшей} → {roles}
DELETE /api/workspaces/{id}/members/{userId|@me}  204                        (kick / leave)
POST   /api/workspaces/{id}/invites/lookup   InviteLookupRequest{email} → {user?, member}   (MANAGE_WORKSPACE, 20/мин)
POST   /api/workspaces/{id}/members    AddMemberRequest{userId} → 201 AddMemberResponse   (сразу member + письмо; 409 — уже участник)
POST   /api/workspaces/{id}/invites/email    CreateEmailInviteRequest{email, role?} → 201 (ссылка PUBLIC_APP_URL/join/<code>, 7 дней; 429 < 24 ч)
GET    /api/workspaces/{id}/invites/email    ListEmailInvitesResponse (ожидающие)
DELETE /api/workspaces/{id}/invites/email/{inviteId}   204 (ссылка отзывается)
GET    /api/invites/{code}             GetInviteResponse                     (превью перед входом, **без auth**, 30/мин на IP: имя/slug/иконка, число участников; email — для приглашения по почте, принятое — до истечения)
POST   /api/invites/{code}/join        JoinWorkspaceResponse                 (код ссылки или из письма; участник → 200; email-код: 403 INVITE_EMAIL_MISMATCH / EMAIL_NOT_VERIFIED)
POST   /api/workspaces/{id}/rooms      CreateRoomRequest → 201               (MANAGE_ROOM на уровне workspace = admin/owner)
GET    /api/workspaces/{id}/rooms      ListRoomsResponse                     (только комнаты с VIEW_ROOM)
GET    /api/rooms/{id}                 GetRoomResponse{room, permissions}    (нет VIEW_ROOM → 404)
PATCH  /api/rooms/{id}                 UpdateRoomRequest                     (MANAGE_ROOM; mediaOverride заменяется целиком; restricted — только владелец, иначе 403 reason OWNER_ONLY, только приватная комната, ADR-0029)
DELETE /api/rooms/{id}                 204                                   (MANAGE_ROOM; архивирование, archived_at)
PUT    /api/rooms/{id}/permissions     SetRoomPermissionsRequest             (MANAGE_ROOM; заменяет все overrides; цель ROLE — id роли, имя встроенной роли тоже принимается и сохраняется как её id)
GET    /healthz  /readyz  /metrics     вне /api, Caddy наружу не проксирует
```

Этап 3 (gateway, messages, files, rtc):

```
GET    /gateway?v=1[&encoding=json]    WebSocket
GET    /api/rooms/{id}/messages?before=|after=&limit=   ListMessagesResponse (VIEW_ROOM; before — новые→старые, after — старые→новые; limit 1..100, 50)
GET    /api/rooms/{id}/messages/{messageId}             Message (без обёртки; VIEW_ROOM; 404: чужое/удалённое/очищенная история DM)
POST   /api/rooms/{id}/messages        CreateMessageRequest → 201 | 200 при повторе nonce   (SEND_MESSAGES; вложения — ATTACH_FILES)
PATCH  /api/messages/{id}              UpdateMessageRequest                (только автор)
DELETE /api/messages/{id}              204                                 (автор или MANAGE_MESSAGES; мягкое удаление)
GET    /api/messages/{id}/reactions/{emoji}?after=&limit=   ListReactionUsersResponse   (VIEW_ROOM; кто поставил эмодзи — тултип реакции, по запросу; по user id, after — последний id страницы; limit 1..100, 25; 404 — как у чтения сообщения)
PUT    /api/rooms/{id}/read            UpdateReadStateRequest → 204        (маркер только вперёд; сдвиг → READ_RECEIPT другим, docs/09 #92)
POST   /api/workspaces/{id}/files      multipart, поле "file" → 201 UploadFileResponse   (участник workspace)
POST   /api/me/avatar                  multipart, только изображение ≤ 5 MB → UpdateMeResponse
GET    /api/files/{id}                 байты: Range, ETag (= sha256), Content-Disposition
GET    /api/files/{id}/thumbnail       WebP-превью ≤ 512 px (для изображений); ?w=512|1024 (иначе 400)
POST   /api/rooms/{id}/join            JoinVoiceResponse { url, token, identity, media, can_speak, can_stream, can_video, pending }   (CONNECT, только voice)
POST   /api/rooms/{id}/voice/leave     204   (своя сессия: снять voice-state в этой комнате — pending или connected — и RemoveParticipant; идемпотентно)
POST   /api/rooms/{id}/stream/request  RequestStreamRequest → RequestStreamResponse { preset }   (STREAM; 409 — лимит или не в комнате)
POST   /api/rooms/{id}/camera/request  204   (VIDEO + CONNECT; 409 — camera_limit достигнут, камеры выключены (0) или не в комнате)
POST   /api/rooms/{id}/camera/stop     204   (своя камера: снять резерв и grant)
PATCH  /api/voice/self                 UpdateVoiceSelfRequest → 204        (409 — устройство не в голосе; 409 PLAN_LIMIT — musician без режима в тарифе)
POST   /api/rooms/{id}/voice/{userId}/mute         204   (MUTE_MEMBERS на уровне workspace: серверный mute → server_muted, до unmute)
POST   /api/rooms/{id}/voice/{userId}/unmute       204   (MUTE_MEMBERS на уровне workspace: снять server_muted; участник может быть уже не в комнате)
POST   /api/rooms/{id}/voice/{userId}/disconnect   204   (MUTE_MEMBERS: RemoveParticipant)
POST   /api/rooms/{id}/voice/{userId}/stop-camera  204   (MUTE_MEMBERS: камеры заглушены, grant снят → VOICE_CAMERA_STOP{MODERATOR}; стоп «липкий»; 404 — нет ни камеры, ни резерва)
POST   /api/rooms/{id}/voice/{userId}/allow-camera 204   (MUTE_MEMBERS: снять липкий стоп камеры)
POST   /api/rooms/{id}/voice/{userId}/stop-stream  204   (MUTE_MEMBERS: screen-треки заглушены, grant на экран снят → VOICE_STREAM_STOP{MODERATOR}; 404 — стримов нет)
POST   /api/rtc/webhook                LiveKit → сервер (подпись API key/secret + sha256 тела)
```

P0.5 (docs/09 #31–35):

```
PATCH  /api/rooms/{id}                         + userLimit (0..99, только voice); POST …/rooms — + userLimit
POST   /api/rooms/{id}/join                    409 ERROR_CODE_ROOM_FULL, если различных пользователей в комнате ≥ userLimit
                                               (MOVE_MEMBERS — вход сверх лимита; второе устройство того же пользователя не считается)
POST   /api/rooms/{id}/voice/{userId}/move     MoveMemberRequest{targetRoomId} → 204   (MOVE_MEMBERS в обеих комнатах;
                                               у перемещаемого VIEW_ROOM+CONNECT в цели; лимит цели — кроме ADMINISTRATOR)
GET    /api/workspaces/{id}/members/{userId}   → GetMemberResponse{member, openTasks} (ADR-0051; @me — сам): участник, гость — только
                                               видимых ему (иначе 404); openTasks — открытые задачи участника на досках, видимых вызывающему, ≤ 50
PATCH  /api/workspaces/{id}/members/{userId}   nickname: чужой — MANAGE_NICKNAMES; свой — если workspace.allowSelfNickname
POST   /api/workspaces/{id}/members/{userId}/promote   гость → member (MANAGE_WORKSPACE)
POST   /api/rooms/{id}/invites                 CreateRoomInviteRequest → 201 RoomInvite   (MANAGE_ROOM)
GET    /api/rooms/{id}/invites                 активные ссылки;  DELETE /api/rooms/{id}/invites/{inviteId} — отзыв
GET    /api/room-invites/{code}                превью для страницы /r/<code> (без auth)
POST   /api/room-invites/{code}/join           JoinRoomInviteRequest{nickname} → {roomId, workspaceId[, tokens, me][, admission]}
PATCH  /api/rooms/{id}/invites/{inviteId}      UpdateRoomInviteRequest{requireApproval | inheritApproval} → {invite}   (MANAGE_ROOM)
GET    /api/rooms/{id}/admissions              ожидающие стуки (ADR-0040): MANAGE_ROOM — все, автор ссылки — по своим ссылкам
POST   /api/rooms/{id}/admissions/{userId}     DecideRoomAdmissionRequest{status ADMITTED|DECLINED, displayName?, badgeId?} → {admission}
DELETE /api/rooms/{id}/admissions/me           гость отменяет ожидание → 204
```

- **Подтверждение входа гостей (ADR-0040).** `PATCH /api/rooms/{id} {guestApproval}` (MANAGE_ROOM) — `Room.guest_approval`; ссылка: `CreateRoomInviteRequest.require_approval` / PATCH выше (`RoomInvite.require_approval` не задан — как у комнаты); превью — `requires_approval` (итоговое). Если подтверждение нужно, join отвечает `admission` (`PENDING`): гость — член пространства `guest` без комнаты (READY: пространство без неё, `Ready.pending_admissions[]` — свои `PENDING` и `DECLINED` за последние 10 мин), история и LiveKit-токен комнаты — `404`. Повторный join во время ожидания — тот же стук, использование не тратится. Решающим — `WorkspaceSnapshot.admissions[]` в READY. `POST …/admissions/{userId}`: `displayName` 1..40 — только гостевому аккаунту (иначе 422), пишется в `users.display_name` (`USER_UPDATE`); `badgeId` (`""` — снять) — из библиотеки пространства (`WORKSPACE_MEMBER_UPDATE`); не ожидает — `404`, не решающий — `403`, бот — `403 BOT_NOT_ALLOWED` (боты — только `GET`). Отклонение снимает членство гостя без других комнат (`WORKSPACE_MEMBER_REMOVE`, гостю `WORKSPACE_DELETE`). Стук: `429` с `reason` `ADMISSION_DECLINED` (≤ 10 мин после отклонения человеком) или `ADMISSION_QUEUE_FULL` (50 ожидающих, `used`/`limit`).

- Публичные пути — `/api/room-invites/…`, а не `/api/rooms/invites/…`: второй вариант конфликтует в `net/http.ServeMux` с `/api/rooms/{id}/invites` (путь `/api/rooms/invites/invites` подходит под оба шаблона, и mux паникует).
- **Перемещение** (ADR-0019). Проверки прав и лимитов прежние. Voice-state устройства сразу записывается в целевую комнату (все получают `VOICE_STATE_UPDATE`). Дальше зависит от LiveKit:
  - **LiveKit Cloud:** `MoveParticipant` переносит устройство внутри SFU без переподключения, записи стримов переезжают. Перемещённый получает `VOICE_MOVED { from_room_id, to_room_id, by_user_id }` с пустыми `url`/`token` — делать ничего не нужно.
  - **Open-source LiveKit** (наш стенд) отвечает `not implemented`. Сервер запоминает это на процесс и переносит устройство сам:
    - на каждое устройство приходит `VOICE_MOVED { …, url, token, session_id, identity }` — join-токен целевой комнаты (identity та же, grant по правам в цели, TTL 2 мин);
    - устройство с этим `session_id` (своя auth-сессия) сразу отключается от старой комнаты и подключается к целевой с этим токеном (разрыв ~1 с); другие устройства пользователя событие игнорируют;
    - стримы устройства в старой комнате завершаются (`VOICE_STREAM_STOP{ENDED}`), после переподключения клиент запрашивает их заново;
    - через 5 с сервер удаляет устройство из старой комнаты LiveKit, если оно ещё там;
    - если за 15 с устройство не подключилось к целевой, voice-state откатывается (устройство вне звонка, `VOICE_STATE_UPDATE`); позднее подключение принимается обычным `participant_joined`.
- **Гость (c).** Без `Authorization` и при `allowGuests` создаётся гостевой аккаунт: ответ `201` с токенами, как у login; веб-клиент (`X-Client: web`) получает refresh в cookie, и проверяется Origin. Лимит — 5 гостей в час с одного IP. С `Authorization` — сценарии (a)/(b), ответ `200`. `User.is_guest` — для бейджа «Гость».
- **Presence / AFK.** Агрегация по устройствам идёт по приоритету `dnd > invisible > online > idle`: ручной статус с одного устройства не перебивается автоматическим `idle` с другого; invisible показывается как offline. Heartbeat не меняет статус сессии.

UI-бэклог (docs/09):

```
GET    /api/workspaces/{id}/categories                 ListCategoriesResponse
POST   /api/workspaces/{id}/categories                 CreateCategoryRequest → 201   (MANAGE_ROOM на уровне workspace)
PATCH  /api/categories/{id}                            UpdateCategoryRequest          (то же)
DELETE /api/categories/{id}                            204; комнаты выходят из категории (ROOM_UPDATE)
PUT    /api/workspaces/{id}/rooms/order                SetRoomOrderRequest → SetRoomOrderResponse   (drag & drop, одна транзакция)
PATCH  /api/rooms/{id}                                 + categoryId ("" — без категории); POST …/rooms — + categoryId
GET    /api/rooms/{id}/messages?q=&before=&limit=      поиск в комнате (FTS)
GET    /api/workspaces/{id}/messages/search?q=&room_id=&author_id=&before=&limit=   поиск по видимым комнатам
PUT    /api/messages/{id}/reactions/{emoji}            204, идемпотентно  (SEND_MESSAGES; ≤ 20 разных эмодзи на сообщение)
DELETE /api/messages/{id}/reactions/{emoji}            204, своя реакция
PUT    /api/messages/{id}/pin | DELETE …/pin           204   (MANAGE_MESSAGES; ≤ 50 на комнату) → MESSAGE_UPDATE
GET    /api/rooms/{id}/pins                            ListMessagesResponse (закреплённые, свежие первыми)
PUT    /api/messages/{id}/embeds-hidden                SetEmbedsHiddenRequest{hidden} → UpdateMessageResponse (автор или MANAGE_MESSAGES) → MESSAGE_UPDATE
PATCH  /api/rooms/{id}/voice-status                    UpdateVoiceStatusRequest{status} → UpdateRoomResponse (voice-комната; CONNECT и участник звонка сейчас, или MANAGE_ROOM) → ROOM_UPDATE
GET    /api/me/mentions?before=&limit=&workspace_id=   ListMessagesResponse — сообщения с упоминанием меня (по видимым сейчас комнатам)
PUT    /api/rooms/{id}/notifications                   UpdateRoomNotificationSettingsRequest{level, mutedUntil} → …Response  (VIEW_ROOM)
PUT    /api/workspaces/{id}/notifications              UpdateWorkspaceNotificationSettingsRequest{level, mutedUntil} → …Response  (участник; INHERIT → 422)
POST   /api/dms                                        CreateDmRequest{userId} → 201 | 200 CreateDmResponse{dm}  (get-or-create; см. «Личные сообщения»)
GET    /api/dms                                        ListDmsResponse{dms[]} (свежие первыми, ≤ 500)
GET    /api/dms/candidates?q=                          ListDmCandidatesResponse{users[]} (≤ 20)
POST   /api/dms/{id}/files                             multipart, поле "file" → 201 UploadFileResponse (участник DM; вложение для DM)
PATCH  /api/dms/{id}/state                             UpdateDmStateRequest{archived?, cleared} → UpdateDmStateResponse{dm} (участник; иначе 404)
GET    /api/notes                                      ListNotesResponse{shelves[], storage} (полки по position, ≤ 20; личная квота)
POST   /api/notes                                      CreateNotesRequest{name, emoji} → 201 CreateNotesResponse{shelf} (409 NOTES_LIMIT на 21-ю)
PATCH  /api/notes/{id}                                 UpdateNotesRequest{name?, emoji?, position?} → UpdateNotesResponse{shelf} (чужая — 404)
DELETE /api/notes/{id}                                 204 (со всеми сообщениями; чужая — 404)
PATCH  /api/me/status                                  UpdateStatusRequest{text, emoji, expiresInSeconds} → UpdateMeResponse
GET    /api/users/{id}/note                            UserNoteResponse{note} — моя заметка о человеке (пустой text = нет)
PUT    /api/users/{id}/note                            PutUserNoteRequest{text ≤ 1000} → UserNoteResponse (пустой text удаляет)
DELETE /api/users/{id}/note                            204
GET    /api/unfurl?url=                                UnfurlResponse (превью ссылки) | 404 — превью нет
GET    /api/unfurl/image?url=&sig=                     прокси картинки превью (подписанная ссылка из UnfurlResponse)
```

- **Поиск.** Postgres FTS: `to_tsvector('russian') || to_tsvector('simple')`, так что работают и стемминг («кошка» → «Кошки»), и точные слова и идентификаторы (`deploy`). Индекс — GIN по выражению, а не по сохранённой колонке. Синтаксис запроса — `websearch_to_tsquery`: `"фраза"`, `OR`, `-исключить`. Результаты идут от новых к старым, курсор `before`, `limit` ≤ 50 (по умолчанию 25), ответ — `ListMessagesResponse`.
- **Реакции.** В REST-ответах `Message.reactions` — `[{emoji, count, me}]` в порядке первого использования. В `MESSAGE_UPDATE` `count` актуальны, `me` всегда `false`: клиент хранит свой `me` и применяет `MESSAGE_REACTION_ADD/REMOVE { workspace_id, room_id, message_id, user_id, emoji }` (приходят только тем, у кого `VIEW_ROOM`).
- **Личные сообщения** (ADR-0020). DM — комната `type = DM` без `workspace_id` с двумя участниками; сообщения, реакции, закрепы, read-state и уведомления — через обычные `/api/rooms/{id}/…` и `/api/messages/{id}/…`, доступ по участию (третьему — `404`). Права — фиксированный набор (docs/04); закреплять могут оба; `PATCH/DELETE /api/rooms/{id}`, права, ссылки-приглашения, голос — `403`.
  - `POST /api/dms {userId}` — get-or-create: `201` и `DM_CREATE` обоим, если создан; `200`, если уже был (с любой стороны). Писать можно тому, с кем есть общее пространство, где оба — не `guest`, или с кем DM уже есть. Себе — `422`; нет такого пользователя / нет общего пространства — `404`; гостевой аккаунт с любой стороны — `403` (гости DM не видят: `GET /api/dms*` → `403`, в READY `dms` пусто). Не больше 10 новых DM подряд и 30 в час на пользователя (`429`).
  - `DmSummary { room, peer, read_state, last_message_at, last_message, peer_read_message_id }` (`peer_read_message_id` — маркер собеседника для ✓✓, пусто — не читал или бот; docs/09 #92): `room` — без имени и медиа (клиент подписывает его именем peer), `last_message_id/at` как в READY. `last_message` — превью для списка: `{id, author_id, content (первые 200 символов), attachment_count, created_at}`, не задано — сообщений нет; клиент не запрашивает историю каждого DM. `read_state.unread_count` — сообщения peer после маркера (≤ 999; до первого прочтения — с начала DM), `mention_count = unread_count`. Тот же `read_state` есть и в `READY.read_states`, сохранённые настройки уведомлений DM — в `READY.notification_settings`.
  - Уведомления: каждое сообщение DM клиент показывает как упоминание — уровни `ALL` и `MENTIONS` уведомляют, `NONE` и `muted_until` глушат DM, «не беспокоить» действует как для упоминаний. `@everyone` и прямые упоминания в DM не хранятся (`/api/me/mentions` DM не содержит).
  - `GET /api/dms/candidates?q=` — кому можно написать: участники (не `guest`) общих пространств, без гостевых аккаунтов и себя; `q` — подстрока имени или ника в пространстве без учёта регистра (≤ 64 символов, иначе `422`), сортировка по имени, до 20.
  - **Архив и «Удалить чат»** (docs/09 #51) — только для себя, у собеседника ничего не меняется. `PATCH /api/dms/{id}/state {archived}` кладёт DM в архив / достаёт; `{cleared: true}` запоминает `cleared_before` (uuidv7 «сейчас») и снимает архив: история, поиск, закрепы, `last_message` и счётчики непрочитанного для меня начинаются после метки. Состояние — `DmSummary.archived_at` / `cleared_before_message_id` (READY, `GET /api/dms`), изменения — `DM_STATE_UPDATE` своим устройствам. Входящее сообщение снимает архив у получателя (`DM_STATE_UPDATE` раньше `MESSAGE_CREATE`); своё — нет. Очищенный DM без новых сообщений клиент не показывает в списке; новое сообщение возвращает его «чистым» с тем же id.
  - Вложения DM грузятся через `POST /api/dms/{id}/files` (файл без пространства, в квоту workspace не входит); файл пространства к DM не прикрепить и наоборот (`422`). Скачивание — участникам DM.
  - Ссылка `/dm/<id>` на чужую / несуществующую переписку — после READY (и перечитывания `GET /api/dms`) клиент показывает ошибку «Переписка по ссылке недоступна», «Личные» остаются без выбранной переписки.
  - Presence и профиль peer приходят через общие пространства; если общего пространства больше нет, DM остаётся, но `PRESENCE_UPDATE` / `USER_UPDATE` peer не приходят (профиль — из `DmSummary.peer` при следующем READY).
- **Заметки** (ADR-0039). Полка — комната `type = NOTES` без `workspace_id`, единственный участник — владелец; сообщения, файлы (`POST /api/dms/{id}/files`, личная квота: `413 FILE_QUOTA_EXCEEDED`, `reason = PERSONAL_QUOTA`), реакции, закрепы, read-state, поиск (`GET /api/rooms/{id}/messages?q=`) — те же эндпоинты, события — по `user:<id>` владельцу с пустым `workspace_id`. Пересылка (ADR-0033) — в обе стороны без новых правил; копия из полки не раскрывает её (`Forward.room_id` пустой). `NotesShelf { room (name, position, last_message_*), emoji, last_message }`. Голос/звонки/стрим/камера в полке — `404`; боты и гостевые аккаунты — `403` на `/api/notes*`. Суперадмин: `GET|PUT /api/admin/users/{id}/storage-quota {quota_bytes?}` → `UserStorageQuota {quota_bytes, used_bytes, is_default}` (без `quota_bytes` — вернуть к `DEFAULT_PERSONAL_QUOTA_BYTES`).
- **Гости** (`role = guest`) видят участников, presence, voice-state и события о людях только из тех комнат, которые видят сами (READY, `GET …/members`, gateway). Когда общая комната появляется или пропадает, гость получает синтетические `WORKSPACE_MEMBER_ADD` (+ `PRESENCE_UPDATE`) / `WORKSPACE_MEMBER_REMOVE`.
- **Камеры** (v0.2).
  - Право `VIDEO` (1<<14; у member по умолчанию есть, у guest — нет). Лимит — `RoomMediaSettings.camera_limit`: 0..25, 0 — камеры в комнате выключены. Default workspace — 6 (`UpdateWorkspaceRequest.default_camera_limit`), override комнаты — `RoomMediaOverride.camera_limit`. `JoinVoiceResponse.can_video` = VIDEO и лимит > 0.
  - Порядок как у стримов. В join-токене camera-источника нет. Перед публикацией клиент вызывает `POST …/camera/request`: сервер проверяет, что есть свободное место, резервирует его на 10 мин и добавляет `camera` в `canPublishSources`. Источник остаётся в grant, пока у устройства есть резерв или включённая камера.
  - Лимит проверяется атомарно на `track_published` (Lua). Лишняя камера глушится сервером, grant снимается, всем, кто видит комнату, приходит `VOICE_CAMERA_STOP{LIMIT_REACHED}`.
  - `VoiceState.camera` — камера устройства в эфире (`track_published` / `track_unpublished` source CAMERA; заглушённый трек reconcile считает выключенным). Приходит в READY и `VOICE_STATE_UPDATE`. Выключая камеру, клиент снимает публикацию трека (unpublish) и вызывает `…/camera/stop`. Отдельного события для собственного выключения нет — хватает `VoiceState.camera`.
  - Модератор (`MUTE_MEMBERS` в комнате, иерархия как у mute) — `…/voice/{userId}/stop-camera`:
    - трек глушится, grant снимается (dev-LiveKit при этом сам снимает публикацию), приходит `VOICE_CAMERA_STOP{MODERATOR}`. Действует и на один только резерв (между request и публикацией) — ответ 204, 404 только если нечего останавливать.
    - Стоп **липкий** для устройств участника (`voice:camoff:<identity>`): пока участник не выйдет из звонка или модератор не вызовет `…/allow-camera`, `/camera/request` отвечает 403. Переподключение устройства в ту же комнату стоп не снимает: поздний `participant_left` старого соединения (participant SID ≠ текущему) удаляет только его треки, состояние, резерв и стоп остаются. Надолго лишить камеры — это `deny VIDEO` override.
  - Перемещение (move, ADR-0019):
    - **SFU-move (LiveKit Cloud):** камера переезжает вместе с участником; лимит целевой комнаты не применяется, как и `user_limit`. Если в целевой комнате камеры выключены (`camera_limit = 0`) или у участника там нет `VIDEO` — `VOICE_CAMERA_STOP{ROOM_POLICY}`, трек глушится, grant снимается.
    - **app-level move (open-source LiveKit):** устройство переподключается новым соединением, поэтому камера выключается — записи и резерв удаляются, `camera = false` (одним `VOICE_STATE_UPDATE` вместе со сменой комнаты). `VOICE_CAMERA_STOP` не приходит: это не остановка. В новой комнате клиент снова запрашивает `/camera/request`.
    - Липкий stop-camera модератора переживает перемещение любого вида: `participant_left` старого соединения не снимает его и резерв у устройства, которое уже в другой комнате.
  - Гонки grant: после каждой отправки прав сервер перечитывает и server mute, и состояние камеры. Поэтому устаревшая отправка не снимет свежий camera-grant и не вернёт камеру после stop-camera. Reconcile не трогает записи камер моложе 15 с.
- **Серверный mute.** Ставит и снимает только `MUTE_MEMBERS` **на уровне workspace** (owner / admin по роли): mute действует во всех комнатах, поэтому модератору одной комнаты (override) он недоступен, у того остаются disconnect / stop-stream в своей комнате. `VoiceState.server_muted` (в READY и `VOICE_STATE_UPDATE`) хранится в Valkey на пользователя в workspace и держится, пока модератор не снимет его через `/unmute`: переживает переподключение и вход с другого устройства; исчезает, если участник покинул workspace. Пока флаг стоит:
  - из LiveKit-grant всех устройств убран источник microphone, поэтому SFU сам не даст опубликовать или включить микрофон;
  - опубликованные треки микрофона заглушены (`MutePublishedTrack`); трек, опубликованный токеном, выданным до mute, глушится на `track_published`;
  - `PATCH /api/voice/self {muted:false}` → 403 (проверка под той же блокировкой, что и установка mute), `join` отвечает `can_speak = false`;
  - после каждой отправки grant в LiveKit флаг перечитывается, и при изменении grant отправляется заново — параллельные mute/unmute/вход не оставляют микрофон вопреки флагу;
  - если флаг не удаётся прочитать (Valkey недоступен), пользователь считается заглушённым (fail closed).

  Отдельного webhook `track_unmuted` в LiveKit нет, поэтому самостоятельное включение микрофона блокирует grant. После `/unmute` grant восстанавливается, а микрофон участник включает сам. Клиент при `server_muted` показывает «заглушён модератором» и блокирует кнопку микрофона.
- **Модерация** (mute / unmute / disconnect / stop-stream / move) идёт по иерархии: владельца не трогает никто, админа — только владелец; модераторы-участники (через override) действуют на участников и гостей.
- **Вход в голос перепроверяется** на `participant_joined`: отозванная сессия, пропавшие `VIEW_ROOM`/`CONNECT` (например, кик за время жизни 10-минутного токена) или превышенный `user_limit` → участник удаляется из LiveKit. Проверка лимита атомарна вместе с записью voice-state (блокировка workspace). Grant участника выравнивается под текущие права.
- **Загрузка файлов** требует `ATTACH_FILES` хотя бы в одной комнате, ограничена 30 подряд / 120 в час на пользователя и 1 GiB неприкреплённых файлов на пользователя в workspace.
- **Заметки о людях** (docs/09 #20). `…/users/{id}/note` — только своя заметка: другой автор её не видит ни через API, ни в событиях (событий нет — клиент читает при открытии профиля). Субъект — я сам или человек с общим пространством / DM, иначе `404` (как для несуществующего id). Текст обрезается по краям, > 1000 символов — `422`.
- **Статус.** Кастомный статус (`User.status_text/status_emoji/status_expires_at`) после `expires_at` отдаётся пустым. `PATCH /api/me/status` рассылает `PRESENCE_UPDATE` (поля `status_*` в `Presence`) и `USER_UPDATE` во все workspace пользователя.
- **Unfurl.** Защита от SSRF:
  - только http(s) без userinfo;
  - адрес проверяется при подключении, после DNS: запрещены loopback, private, link-local, CGNAT, NAT64/6to4, multicast и служебные сети — это закрывает и DNS rebinding;
  - ≤ 3 редиректа, каждый проверяется заново;
  - таймаут 5 с, ≤ 1 MB, только `text/html`, кодировка по заголовку или `<meta charset>`.

  Для dev-машин с VPN в режиме fake-IP есть явное исключение `UNFURL_ALLOW_CIDRS`; в проде эта переменная не задаётся.

  Кэш в Redis: 24 ч, негативный — 1 ч. Rate limit — 30 подряд, 120 в минуту на пользователя. Картинки и favicon идут только через `/api/unfurl/image`: ссылка подписана HMAC, поэтому это не открытый прокси; только растровые типы по сигнатуре (SVG — никогда), ≤ 5 MB, таймаут 10 с. IP пользователей сторонним сайтам не виден.
- **Время звонка.** `VoiceState.joined_at` — самый ранний вход устройств пользователя в эту комнату. `Room.voice_started_at` — когда в комнате без звонка подключилось первое устройство (снятие `pending` по `participant_joined`/reconcile; устройство, записанное сразу подключённым, — его `joined_at`), сбрасывается, когда уходит последнее подключённое. Pending-устройства (оптимистичный `/join`, app-level move) звонка не начинают и не продлевают, так что откат pending не оставляет фантомного звонка. Приходит в READY / WORKSPACE_CREATE и в `ROOM_UPDATE`: при старте звонка (с `voice_started_at`) и при его конце (без поля) сервер рассылает `ROOM_UPDATE` с комнатой — из одной точки под блокировкой voice-состояния workspace, так что события одной комнаты идут в порядке изменений; если Valkey недоступен, событие не отправляется (а не сбрасывает таймер); любой другой `ROOM_UPDATE` голосовой комнаты (переименование, настройки) тоже несёт текущее значение, так что клиент просто берёт поле из последнего события. Таймер считается от серверного времени.
- **Упоминания.** Формат в `content`: `@<user_id>` (UUID; клиент вставляет его при выборе участника и рендерит как имя), `@everyone` и `@here` — все, кто видит комнату; действуют только при праве `MENTION_EVERYONE` в комнате (у owner/admin — по роли, остальным — через override), иначе остаются обычным текстом (для истории `@here` = `@everyone`). Внутри `` `код` `` и блоков кода упоминаний нет; своё сообщение себя не упоминает; учитываются только участники workspace, ≤ 50 прямых упоминаний на сообщение. Сервер сохраняет упоминания при создании и правке (правка пересчитывает), удаление сообщения их убирает. `MESSAGE_CREATE` несёт `content` — бейджи клиент считает сам; `GET /api/me/mentions` нужен для истории: от новых к старым, курсор `before`, `limit` ≤ 100 (по умолчанию 50), `workspace_id` — фильтр, `after` не поддерживается.
- **Смена пароля и email** (раздел «Профиль»). Обе операции требуют текущий пароль.
  - Неверный пароль → 403 `INVALID_CREDENTIALS` (не 401: клиент не должен уходить в refresh/logout). Гости (без пароля) → 403 `FORBIDDEN`.
  - Проверки пароля ограничены 5 за 15 мин на аккаунт (429 + `Retry-After`); запросы с неверным форматом (`newPassword` не 8..256 символов → 422, невалидный `newEmail` → 422) бюджет не тратят.
  - Новый пароль — argon2id. Все **другие** сессии отзываются сразу, их access-токены отклоняются по Redis-маркеру, а gateway закрывает их сокеты; текущая сессия остаётся.
  - Email уникален без учёта регистра (citext), занятый → 409 `CONFLICT`. Новый адрес становится `me.pendingEmail`, на него уходит код; `POST /api/auth/verify` делает его адресом входа (ADR-0023; без SMTP — сразу). Устройства пользователя получают `USER_UPDATE {me}`; другим участникам email не рассылается.
- **Почта (ADR-0023).** `Me.emailVerified` (READY, `GET /api/me`, login/register, `USER_UPDATE {me}`), `Me.pendingEmail`, `Me.locale` (язык писем; `PATCH /api/me {locale}` — BCP 47 → `en|ru|es|zh-CN`, `""` — сброс; при регистрации — `RegisterRequest.locale`, иначе `Accept-Language`). Неподтверждённый: неубираемая плашка с полем кода; `403 EMAIL_NOT_VERIFIED` на создание пространств, приглашения и новые DM. Коды: `422 CODE_INVALID` (неверный; в сообщении — сколько попыток осталось), `422 CODE_EXPIRED` (нет живого кода — запросить новый), `429` + `Retry-After` (код < 60 с назад / 3 письма в час на адрес / приглашение тому же адресу < 24 ч). Подтверждение принимает ожидающие email-приглашения: `WORKSPACE_CREATE` на каждое пространство.
- **Один код приглашения (ADR-0027, docs/09 #36).** Код из письма-приглашения и код ссылки `/join/<code>` — оба валидный `invite_code` регистрации (`REGISTRATION_MODE=invite`), превью и вступления. Код ссылки: регистрация сразу вступает. Код из письма: только для приглашённого адреса (иначе `403 INVITE_EMAIL_MISMATCH`), аккаунт создаётся неподтверждённым, вступление — после `POST /api/auth/verify` (ответ `joinedWorkspaceIds` + `WORKSPACE_CREATE`). Клиент: `/join/<code>` без сессии → регистрация с карточкой «Приглашение в «…»», код скрыт, адрес из приглашения заблокирован; после регистрации по приглашению онбординг не показывает шаг «Присоединиться» и диалог вступления не открывается; подтверждение с `joinedWorkspaceIds` открывает пространство (одно уведомление).
- **Непрочитанное в READY.** `read_states` в READY — по одному на **каждую видимую комнату**. Каждый несёт:
  - `unread_count` — чужие живые сообщения после `last_read_message_id`, максимум 999 (показывать «999+»);
  - `mention_count` — сколько из них упоминают пользователя (`@<user_id>`, `@everyone`, `@here`); своё `@everyone` не считается.

  Если пользователь комнату ещё не открывал, `last_read_message_id` пустой, а счётчики идут от его вступления в workspace. Запрос — индексные сканы без чтения таблицы (миграция 00007): ~6 мс на 100 комнат при 1M сообщений. В `READ_STATE_UPDATE` счётчики не заполняются (0): дальше клиент ведёт их сам по `MESSAGE_CREATE`/`MESSAGE_DELETE`.
- **Уведомления комнаты.** `level`: `INHERIT` (по умолчанию, «Как в пространстве») | `ALL` | `MENTIONS` | `NONE`; `muted_until` — временное отключение (≤ 1 год вперёд). **`NONE` без `muted_until` — бессрочно**: уровень хранится, пока пользователь его не сменит; `muted_until` — отдельный временный mute поверх любого уровня. Когда он истёк, действует сохранённый `level`. `PUT` заменяет настройки целиком; `INHERIT` (или `UNSPECIFIED`) без `muted_until` — сброс к умолчанию (строка удаляется). READY `notification_settings` содержит только сохранённые настройки видимых сейчас комнат; комнаты не из списка — по умолчанию. Уведомления показывает клиент; сервер хранит и синхронизирует настройки между устройствами (`ROOM_NOTIFICATION_UPDATE`).
- **Уведомления пространства** (docs/09 п. 22). `WorkspaceNotificationSettings{workspace_id, level, muted_until}`: `level` `ALL` | `MENTIONS` (по умолчанию) | `NONE`, `INHERIT` → 422; `MENTIONS` без `muted_until` — нет строки. Эффективный уровень комнаты = её `level`, если не `INHERIT`, иначе уровень пространства; DM — всегда как упоминание (глушат только свой `NONE`/`muted_until`); `muted_until` пространства глушит все его комнаты, упоминания тоже. Звук «Новое сообщение» и системные уведомления клиент даёт только для DM, упоминаний и комнат с эффективным `ALL`; счётчики непрочитанного и упоминаний от уровней не зависят. Сервер пушей не шлёт — фильтрует клиент (`shouldNotify`). READY `workspace_notification_settings` — сохранённые настройки пространств, где пользователь состоит.
- **Статус звонка** (`Room.voice_status`, ≤ 60 символов, пробелы по краям обрезаются) — строка вроде «Планёрка» у voice-комнаты.
  - Ставит участник текущего звонка (`CONNECT` и сейчас в комнате) или `MANAGE_ROOM`; пустая строка — очистить.
  - Сбрасывается сервером, когда комната пустеет, — в том же `ROOM_UPDATE`, что убирает `voice_started_at`. Проверка «в звонке» и запись идут под той же блокировкой voice-состояния, что и сброс, поэтому статус не переживает свой звонок.
  - Приходит в READY / WORKSPACE_CREATE и во всех `ROOM_UPDATE`.
- **Пересылка** (ADR-0033): `POST /api/rooms/{id}/messages/{mid}/forward {to_room_id}` → `201 ForwardMessageResponse`, в цели — `MESSAGE_CREATE` с `Message.forward {author_id, room_id (пусто для DM), message_id, sent_at}`; упоминания копии не уведомляют. Копия карточки записи получает `MESSAGE_UPDATE` в своей комнате (DM — участникам) при каждом обновлении оригинала, включая удаление записи.
- **Скрытые превью ссылок** (`Message.embeds_hidden`): автор (или `MANAGE_MESSAGES`) скрывает превью у своего сообщения, клиент их тогда не рендерит. Сообщение не помечается отредактированным. Все, кто видит комнату, получают `MESSAGE_UPDATE`.
- **Категории.** `Room.category_id`, `WorkspaceSnapshot.categories`. События `CATEGORY_CREATE/UPDATE/DELETE` приходят всем участникам workspace; клиент скрывает категории без видимых ему комнат.

Изменения относительно первоначального плана: `PUT /api/files` → `POST /api/workspaces/{id}/files` (файл принадлежит workspace, квота — его); `?thumb=1` → `/thumbnail`. Скачивание требует `Authorization`; клиент грузит через `fetch` и показывает через blob URL. Доступ к файлу: загрузивший; аватары — любой пользователь; иконка workspace — участники; вложение — `VIEW_ROOM` комнаты сообщения. Файл прикрепляется только к одному сообщению; при удалении сообщения вложения открепляются и удаляются чисткой сирот (не прикреплённые > 24 ч).

`POST /api/rooms/:id/messages` идемпотентен по `nonce`: `id` генерирует Postgres (`uuidv7()`), а повтор с уже использованным `(author_id, nonce)` возвращает существующее сообщение (`200` вместо `201`) без повторного `MESSAGE_CREATE`.

Тарифы (ADR-0024):
- `READY.plan_contact` и `GET /api/version` → `planContact`: куда писать за подпиской (`PLAN_CONTACT_URL`, иначе `mailto:` + `PLAN_CONTACT_EMAIL`, по умолчанию `mailto:it@gptunnel.ai`). `READY.me.is_superadmin`.
- `Workspace.plan {plan, limits, valid_until, expired}` — в READY / `WORKSPACE_CREATE` / `WORKSPACE_UPDATE` и REST пространства (не в discover и превью инвайта).
- `POST /api/rooms/{id}/join` → `media` урезан планом (`max_stream_preset`, `max_streams`), `plan_limits`. Места в комнате: pending считается; упор в план → `409 ROOM_FULL` с `reason: "PLAN_LIMIT"`, `used`, `limit`.
- `POST …/stream/request {preset, fps?}` → `{preset, fps}` фактические (1080p на free → `H720` / 15). `POST …/camera/request {preset?, fps?}` → `200 {preset, fps}` (раньше 204): `min(запрошенное, план)`; `UNSPECIFIED`/0 = без ограничения.
- Файлы: `413 FILE_QUOTA_EXCEEDED` c `used`/`limit` (байты) и `reason: "PLAN_LIMIT"`, если упёрлись в `storage_mb`.
- `ApiError.reason` / `used` / `limit` — необязательные поля, есть только у этих ошибок.
- Суперадмин (`/api/admin/*`, только email из `SUPERADMIN_EMAILS`, остальным `404`; лимит 60/мин на пользователя; каждый запрос в лог): `GET /api/admin/workspaces?q=` (имя / slug / email владельца, ≤ 50, с планом и использованием: участники без гостей, комнаты, МБ, последнее сообщение), `GET /api/admin/workspaces/{id}`, `PUT /api/admin/workspaces/{id}/plan {plan, limits? (только CUSTOM), valid_until?, note ≤ 500}` (422 на неверное; журнал; `WORKSPACE_UPDATE`), `GET /api/admin/workspaces/{id}/plan/log` (≤ 100, новые сверху).

Приостановка и баны (docs/09 #32, docs/04):
- `PUT /api/admin/workspaces/{id}/suspension {suspended, reason}` (суперадмин; при `suspended: true` причина 1..500 обязательна, иначе 422; идемпотентно, время первой приостановки сохраняется) → `AdminWorkspace` (+ `suspended_by`, `suspended_by_email`). `WORKSPACE_UPDATE` с `Workspace.suspension {at, reason}` (unset = активно); `reason` получают только owner / admin — в событии, READY, `WORKSPACE_CREATE` и REST, остальным пустая строка. Все участники звонков отключаются (LiveKit `PARTICIPANT_REMOVED` → `VOICE_STATE_UPDATE`). Пока приостановлено: `403 WORKSPACE_SUSPENDED` на `POST /rooms/{id}/messages`, `PATCH /messages/{id}`, `PUT|DELETE …/reactions/{emoji}`, `POST /workspaces/{id}/files`, `POST /rooms/{id}/join`, `…/move`, `…/stream/request`, `…/camera/request`, `…/allow-camera`, `…/recording/start`, `…/recordings/{rid}/recheck|reupload`, `POST /rooms/{id}/invites`, `POST /workspaces/{id}/invites`, `…/invites/email`, `POST /workspaces/{id}/members`, `POST /workspaces/{id}/join`, `POST /invites/{code}/join`, `POST /room-invites/{code}/join`, `POST /workspaces/{id}/bots` и `…/bots/add`, регистрация с `invite_code`.
- Баны (`MANAGE_WORKSPACE`): `GET /api/workspaces/{id}/bans` → `ListBansResponse` (новые сверху), `POST /api/workspaces/{id}/bans {user_id, reason ≤ 500}` → `201 CreateBanResponse` (участник исключается: `WORKSPACE_MEMBER_REMOVE` всем, `WORKSPACE_DELETE` ему; можно забанить и не-участника), `DELETE /api/workspaces/{id}/bans/{user_id}` → 204 (404, если бана нет). `WORKSPACE_BAN_ADD {ban}` / `WORKSPACE_BAN_REMOVE {workspace_id, user_id}` — только owner / admin. Забаненному (по аккаунту или адресу) — `403 BANNED` на вход по инвайту, в открытое пространство, добавление, email-приглашение, регистрацию по инвайту и ссылку в комнату.

Файлы: хранилище (ADR-0011, `blob.Store`) наружу не публикуется, загрузка и скачивание идут только через API. Лимиты — 50 MB на файл (`MAX_FILE_SIZE_MB`, иначе `413`), 20 вложений на сообщение, квота workspace (`min(storage_quota_bytes, план storage_mb)`, по умолчанию 10 GB; превышение → `ERROR_CODE_FILE_QUOTA_EXCEEDED`). Для `image/*` сервер генерирует превью (≤ 512 px, WebP), в сообщении приходит `thumbnail_url`. `?w=1024` — превью ≤ 1024 px (WebP q85) для 2×-экранов: делается лениво при первом запросе и кэшируется в хранилище рядом (`<key>.thumb1024`, удаляется вместе с файлом), без увеличения (оригинал ≤ 512 — отдаётся превью 512, до 1024 — свой размер), в квоту не входит; без `w` — 512, как раньше.

HEIC → JPEG (docs/02 «Изображения: клиентское сжатие и HEIC»): `POST /api/files/convert?to=jpeg`, multipart `file` — только HEIF (`415`), ≤ 25 MB (`413`), ответ — байты `image/jpeg` ≤ 4096 px с применённой ориентацией, ничего не сохраняется; `501` — на сервере нет ffmpeg ≥ 7.1, `503` — занято дольше 20 с, `422` — не декодируется.

Голосовые сообщения (docs/09 #43): та же загрузка (`POST /api/workspaces/{id}/files` или `/api/dms/{id}/files`, те же права и квота) с `?voice_duration_ms=<1..300000>&voice_waveform=<base64url без паддинга, ≤ 100 байт 0..255>`. Сервер требует объявленный тип части `audio/ogg` и начало `OggS` + `OpusHead`, хранит как `audio/ogg`, лимит `min(MAX_FILE_SIZE_MB, 1,5 MB)`; иначе `422` / `413`. В `FileMeta.voice {duration_ms, waveform}` (proto `VoiceInfo`) — длительность и волна, посчитанные клиентом при записи; у остальных файлов поле не задано. Без параметров тот же `.ogg` — обычное аудио-вложение.

Защита от злоупотреблений (security review, 2026-09-26):
- **Rate limit.** Все лимитеры — token bucket в Redis. При исчерпании — `429` с `Retry-After` (секунды). При недоступности Redis лимитеры **fail closed**: `503`, как и проверка отзыва сессий.
- **Login.** Два лимита: по IP и по аккаунту — `LOGIN_ACCOUNT_ATTEMPTS` (10) за 15 мин на email с любых IP. Лимит по аккаунту работает одинаково и для несуществующих email, поэтому не раскрывает, есть ли аккаунт.
- **Workspace.** Не больше `MAX_WORKSPACES_PER_USER` (5) во владении (`409 ERROR_CODE_WORKSPACE_LIMIT`) и `WORKSPACE_CREATES_PER_HOUR` (3) созданий в час; квота нового — `DEFAULT_WORKSPACE_QUOTA_BYTES`.
- **Хранилище.** Потолок `STORAGE_MAX_TOTAL_BYTES` на всё хранилище сервера (квоты всех workspace + аватары) проверяется при загрузке, под advisory lock вместе с резервированием квоты → `507 ERROR_CODE_STORAGE_FULL`.
- **Заголовки.** Ответы `/api/*` по умолчанию идут с `Cache-Control: no-store` и `X-Content-Type-Options: nosniff`; файлы и прокси картинок ставят свой `Cache-Control`.
- **Webhook LiveKit.** `exp` обязателен, допуск по часам — 5 мин.
- **Gateway.** Origin `null` / `file://` пропускается только без cookie: у десктопа их нет, а `null` с cookie — это чужая sandbox-страница → `403`.

Ошибки: `ApiError { code: "ERROR_CODE_FORBIDDEN" | "ERROR_CODE_RATE_LIMITED" | …, message, field }` + HTTP-статус (коды и статусы — enum `ErrorCode` в `common.proto`). Недоступный пользователю ресурс (чужой workspace, комната без `VIEW_ROOM`) — `404`, а не `403`, чтобы не раскрывать существование. Rate-limit на сообщения (5/5с на комнату), typing (1/3с), login и register (token bucket по IP в Redis: `AUTH_RATE_BURST`, `AUTH_RATE_PER_MINUTE`).

Если клиент оборвал запрос (закрыл соединение, reload сразу после POST) и обработка из-за этого не завершилась, сервер отвечает `499` (Client Closed Request): это не ошибка сервера — в логе уровень debug, в метриках статус 499, а не 5xx. Изменение, которое успело закоммититься, всё равно рассылается: события публикуются независимо от контекста запроса.

REST-мутации после коммита публикуют `DispatchEvent` в Redis (`ws:<workspace_id>`, `user:<user_id>`, `session:revoked:<session_id>`) — gateway (следующий этап) подписывается и рассылает с фильтрацией по правам.

- **Бюджет публикации.** Вся работа с Redis после коммита (PUBLISH, пометка отзыва сессии, чтение `voice_started_at` для `ROOM_UPDATE`) идёт через `events.Detached`: контекст не отменяется вместе с запросом и ограничен общим бюджетом **5 с на запрос** (`events.RequestBudget`, ставит middleware `events.Middleware`). В бюджет засчитывается только время ожидания Redis; когда он исчерпан, остальные публикации запроса сразу завершаются ошибкой (warn в логе), и хэндлер не висит, даже если Redis завис.
- **Пакетная публикация.** Много событий в один workspace (`PUT …/rooms/order`, удаление категории, смена медиа-дефолтов workspace) уходят одним пайплайном `Publisher.WorkspaceEvents` (DoMulti), с сохранением порядка, а не отдельным PUBLISH на каждую комнату.
- **Фоновые задачи** (gateway, таймеры, reconcile) ограничены 3 с на вызов. Уборка гостей — один бюджет 5 с на весь проход для MEMBER_REMOVE плюс свои 3 с на отзыв сессий каждого гостя (см. ниже).
- **Вне общего бюджета** — то, потеря чего вредит безопасности или оставляет пользователя «в подвешенном состоянии»: отзыв сессий (маркеры `auth:revoked:*` одним пайплайном + `SessionRevoked`, по 3 с — чтобы «выйти на всех устройствах» гасил токены сразу, а не по TTL) и `VOICE_MOVED` с токеном целевой комнаты (свои 3 с).
