# ADR-0046. Телефония SIP: исходящие звонки на городские номера из голосовой комнаты

Статус: принято (2026-09-30), к релизу **1.3.0**. Владелец, 30.09: «внедрить SIP — если включён,
возможность звонить на городские номера через него; потом добавим IVR и каждому участнику дадим
внутренний номер, но пока примитивный интерфейс: настройки SIP + возможность дозвониться до номера в
группе и с ним поговорить».

## Контекст

Голос у нас на LiveKit (ADR-0002). У LiveKit есть штатный SIP-сервис (`livekit/sip`): он держит
транки к провайдеру и «вводит» телефонного абонента в комнату как обычного участника
(`CreateSIPParticipant` — исходящий звонок; входящие — `SIPInboundTrunk` + `SIPDispatchRule`).
Значит, телефония ложится на существующую комнату без второго медиа-стека: звук абонента идёт
через те же треки, эхоподавление (docs/02) и запись (ADR-0023) работают как для человека.

## Решение

### Инфраструктура
- Контейнер `livekit/sip` (версия, совместимая с `livekit-server v1.13`) в `compose.yml`, `network_mode:
  host`, тот же Redis (Valkey) и те же `LIVEKIT_KEYS`; конфиг `infra/docker/livekit/sip.yaml.tpl`
  (рендер в `deploy.sh`): `sip_port: 5060` (UDP+TCP), `rtp_port: 10000-10200`, `use_external_ip`.
  Включается флагом `SIP_ENABLED=1` в `.env` (compose-профиль `sip`); без флага ничего не поднимается.
- Firewall стенда (docs/03): открыть `5060/udp,tcp` и `10000–10200/udp` только при `SIP_ENABLED`; не
  пересекается с чужой GPU-задачей (8000–8400, 9100, 9400) и с TURN-релеями (ниже 32768 — проверить
  диапазон в `livekit.yaml.tpl` и взять свободный). Стенд-агент перед релизом проверяет `ss -lun`.
- Секреты провайдера — только в БД (sealbox, как пароль CalDAV в ADR-0041), не в env.

### Модель (миграция `00051`; `00050` занял ADR-0047)
- `sip_accounts (workspace_id PK, provider text, host text, transport text CHECK (udp|tcp|tls),
  username text, auth_username text, port int (5060), password_enc bytea, caller_id text, outbound_prefix text, allowed_prefixes text[],
  trunk_id text, enabled bool, last_error text, updated_at)` — один аккаунт на пространство
  (позже — несколько). `trunk_id` — id `SIPOutboundTrunk` в LiveKit, создаётся/обновляется при
  сохранении настроек.
- `sip_calls (id uuid, workspace_id, room_id, number text, direction text CHECK (out|in),
  started_by uuid, participant_identity text, sip_call_id text, status text CHECK
  (dialing|ringing|active|ended|failed), reason text, started_at, answered_at, ended_at)` — журнал
  для аналитики и будущего биллинга (владелец: «потом аналитика»). Не удаляется с комнатой
  (`room_id` → `ON DELETE SET NULL`).
- Право `PERMISSION_PLACE_CALLS = 16777216` (1 << 24), уровень пространства и комнаты. **По
  умолчанию — нет** (звонки стоят денег); админ выдаёт роли или конкретным людям, отображается в
  редакторе ролей группой «Телефония». `ADMINISTRATOR` — как всегда всё.

### API (`internal/sip`)
- `GET/PUT /api/workspaces/{id}/sip` (`MANAGE_WORKSPACE`): настройки; `PUT` валидирует, шифрует
  пароль, создаёт/обновляет транк в LiveKit (`CreateSIPOutboundTrunk` / `UpdateSIPOutboundTrunk`),
  при ошибке — 502 с текстом провайдера в `last_error`. Пароль в `GET` не возвращается (`has_password`).
- `POST /api/workspaces/{id}/sip/test` (`MANAGE_WORKSPACE`): проверка регистрации/OPTIONS у
  провайдера через LiveKit (если API не даёт — тестовый звонок на `caller_id` длительностью 5 с
  в служебную комнату, результат в ответе).
- `POST /api/rooms/{id}/calls {number}` (`PLACE_CALLS` в комнате + `CONNECT`, комната голосовая, не
  архивная, звонящий сейчас в ней) → `CreateSIPParticipant(trunk, number, room, identity =
  "sip:<call id>", name = номер или имя из телефонной книги)` → `CallResponse{call}`. Лимиты: 1
  активный звонок на комнату (пока), 20 звонков в час на пространство (Redis), номер — E.164 после
  нормализации (`+7…`), `allowed_prefixes` пространства (пусто = любые).
- `DELETE /api/rooms/{id}/calls/{cid}` (тот же или `MUTE_MEMBERS`) → `RemoveParticipant`, статус `ended`.
- `GET /api/workspaces/{id}/calls?from&to&cursor` (`MANAGE_WORKSPACE`) — журнал.
- События LiveKit (`participant_joined/left` с атрибутом `sip.callStatus`, webhook уже есть в
  `internal/rtc/webhook.go`) → статусы в `sip_calls` и событие шлюза `SIP_CALL_UPDATE {call}` в
  комнату (следующий свободный номер в `gateway.proto`).
- Боты: `POST …/calls` и `DELETE` через `botAllow` с тем же битом (авто-обзвон позже).

### UI (docs/09 #145)
- Настройки пространства → вкладка **«Телефония»** (`MANAGE_WORKSPACE`): переключатель «SIP
  включён», поля провайдера (хост, транспорт, логин, пароль, Caller ID, префикс набора, разрешённые
  префиксы), кнопка «Проверить подключение», плашка `last_error`, журнал звонков (последние 100).
- Голосовая комната, участник с `PLACE_CALLS` и включённым SIP: в панели комнаты кнопка **«Позвонить
  на номер»** (иконка `Phone`) → попап с полем номера (маска E.164, подсказка «+7 …»), Enter —
  звонок. Телефонный участник в списке с иконкой `Phone` и подписью «Набираем… / Звонит… / В
  разговоре 02:14», кнопка «Завершить» у звонившего и модераторов. Пока идёт `dialing/ringing` —
  тональность вызова слышит только звонивший (локальный `<audio>`-файл, без WebAudio на выходе).
- Мобильный веб: та же кнопка в шторке участников.

### Права и безопасность
- Все проверки на сервере; клиент лишь прячет кнопку. Номер логируется в `sip_calls`, в чат не
  пишем. Пароль провайдера — sealbox, `GET` его не отдаёт, `PUT` без поля пароля не трогает
  сохранённый. `PLACE_CALLS` по умолчанию никому: включение телефонии = осознанная выдача права.
- Ограничение направления: `allowed_prefixes` (например `+7`) против международного фрода; лимит
  20/час/пространство; один активный звонок на комнату.
- Гостям — никогда (ни право, ни кнопка).

### Дальше (1.4+, не в этом ADR)
Входящие: `SIPInboundTrunk` + `SIPDispatchRule` → IVR (агент LiveKit: меню «нажмите 1…» →
комната/участник), внутренние номера (`users.extension`, звонок в DM-звонок ADR-0034), телефонная
книга пространства (имя по номеру), запись звонков в журнал с аудио, биллинг по `sip_calls`.

## Контракт для клиента (сервер 1.3.0)

Источник правды — `proto/calaba/v1/sip.proto` (комментарии у каждого запроса), `common.proto` (коды), `permissions.proto`.

**Когда показывать кнопку «Позвонить на номер»** (голосовая комната, панель участников; мобильный веб — шторка):
`Workspace.sip_enabled` && `computePermissions(...)` в комнате содержит `PLACE_CALLS` (есть и `VIEW_ROOM | CONNECT`) && роль не гость && я сейчас в звонке этой комнаты && в комнате нет живого звонка (`sip_calls` пуст по комнате). `sip_enabled` меняется через `WORKSPACE_UPDATE`.

**Звонок.** `POST /api/rooms/{id}/calls {number}` → `201 {call}` (`DIALING`). Номер можно слать как ввёл человек: сервер чистит пробелы/скобки/дефисы, `8…`/`7…` (11 цифр) → `+7…`, `00…` → `+…`; иначе нужен `+`. Ошибки: `422 VALIDATION field=number` («не номер»), `422 SIP_NUMBER_NOT_ALLOWED field=number` (не в разрешённых префиксах), `409 SIP_DISABLED`, `409 SIP_CALL_ACTIVE`, `409 CONFLICT` (я не в звонке комнаты), `429 SIP_RATE_LIMITED` (+ `Retry-After`), `403` (нет бита / гость / `WORKSPACE_SUSPENDED`).

**Статусы** приходят `SIP_CALL_UPDATE {call}` всем, кто видит комнату; в `READY`/`WORKSPACE_CREATE` — `WorkspaceSnapshot.sip_calls` (только живые). `DIALING → (RINGING) → ACTIVE → ENDED`; `DIALING|RINGING → FAILED|ENDED`. `RINGING` может не прийти (LiveKit сообщает его, только если линия вошла в комнату уже со звонком) — клиент показывает «Набираем…» до `ACTIVE`. Таймер «В разговоре 02:14» — от `answered_at`. Причины (`reason`) финала: ENDED — `hangup`, `hangup_moderator`, `cancelled` (положили до ответа), `remote` (абонент положил трубку или 2 ч), `empty` (все вышли из звонка комнаты), `room_closed`, `disabled` (телефонию выключили), `lost`; FAILED — `busy`, `no_answer`, `declined`, `invalid_number`, `provider_auth`, `unavailable`, `error NNN`. Тексты для людей — по этим кодам.

**Телефонный участник в LiveKit-комнате:** identity `sip:<call.id>` (`call.participant_identity`), имя — номер (E.164), `kind = SIP`, атрибут `sip.callStatus` (`dialing`, `ringing`, `active`, …). Линия входит в комнату сразу при наборе (до ответа; проверено с настоящим `livekit/sip`) и сразу публикует аудиотрек — гудки провайдера (early media) слышны всем в звонке, если провайдер их отдаёт; локальный сигнал вызова звонившему (решение выше) — по желанию клиента. Звук линии — обычный remote-трек через `<audio>` (docs/02). В списке участников строка по `SipCall` (иконка `Phone`, номер, статус), а не по `VOICE_STATE_UPDATE` — у линии голосового состояния нет. Линия не мьютится/не перемещается модерацией голоса; убрать — только «Завершить».

**Завершить:** `DELETE /api/rooms/{id}/calls/{call.id}` → `200 {call}` (звонивший; остальные — с `MUTE_MEMBERS`). `409 CONFLICT` — звонок уже закончился (обновить из события).

**Настройки** (вкладка «Телефония», `MANAGE_WORKSPACE`): `GET /api/workspaces/{id}/sip` → `{settings}`; `PUT` всей формой (`password` не слать = не менять, `""` = удалить) → `{settings}`; поля `auth_username` (пользователь SIP-аутентификации, если отличается от `username`/From; пусто = `username`) и `port` (порт сигнализации хоста, `0` в PUT = 5060; в GET — всегда число; `host` приходит без порта, `хост:порт` в PUT ещё принимается и должен совпасть с `port`); в транк LiveKit уходят `auth_username || username` и `address` = `host` или `host:port` при порте ≠ 5060; ошибки `422 VALIDATION` с `field` (`host` — только публичный адрес без `sip:`, `port` — 1–65535 или расходится с портом в `host`, `authUsername`, `callerId`, `username`, `password`, `outboundPrefix`, `allowedPrefixes`, `provider`, `transport`), `502 SIP_PROVIDER_ERROR` (текст LiveKit в `message`, он же в `last_error`; прежние настройки остаются). `settings.last_error` — плашка; `trunk_saved` — LiveKit принял транк. «Проверить подключение» — `POST …/sip/test` → `{ok, message, sip_status}` до ~25 с (кнопка с лоадером), `429 SIP_RATE_LIMITED` (5 в час), `409 SIP_DISABLED`. Журнал — `GET /api/workspaces/{id}/calls?from&to&cursor` → `{calls, next_cursor}`, 100 на страницу, новые сверху; строки с пустым `room_id` — проверки подключения (или удалённая комната); имя звонившего — из участников по `started_by`.

**Права в редакторе ролей:** бит `PLACE_CALLS` (`perm.PLACE_CALLS`, подписи уже в 4 локалях) — группа «Телефония»; можно ставить и в переопределениях комнаты; у встроенной роли «Гость» его нет и быть не может.

### Отличия реализации от решения выше
- Миграция `00051` (номер `00050` занят), плюс `workspaces.sip_enabled` — флаг для клиента без отдельного запроса (`Workspace.sip_enabled`), и `sip_calls.ended_by`, `sip_accounts.updated_by`.
- Пятый код ошибки `SIP_PROVIDER_ERROR` (502) — отказ LiveKit при сохранении отличим от прочих; сохранение атомарно: при отказе в БД меняется только `last_error`.
- Проверка подключения — всегда тестовый звонок на `caller_id` (≤ 5 с разговора, 15 с гудков) из служебной LiveKit-комнаты `sip-test_<id>`: OPTIONS/регистрации в API LiveKit нет. Успех — ответ или SIP-код, доказывающий, что провайдер принял звонок (408/480/486/487/600/603/607/608). Успех и без SIP-кода — если линия дошла до гудков (`sip.callStatus = ringing`, сервер опрашивает служебную комнату раз в секунду), а гудки кончились по 15 с. `max_call_duration` у LiveKit ограничивает весь звонок вместе с набором и гудками, поэтому для проверки он равен 15 + 5 с (было 5 с — проверка обрывалась «sip request timed out» через 5 с, если провайдер не отвечал сразу). Плашка «Подключена» значит лишь, что LiveKit принял транк; дозвон показывает проверка.
- Статусы берутся из результата `CreateSIPParticipant(wait_until_answered)` (ACTIVE / FAILED с SIP-кодом) плюс вебхуки: `participant_joined` с `sip.callStatus`, `participant_left` линии → `remote`, уход последнего человека из звонка → линия снимается (`empty`), `room_finished` → `room_closed`; lost-call-метёлка раз в 30 с. Вебхука на смену атрибутов у LiveKit нет.
- Лимиты: гудки 45 с, разговор ≤ 2 ч, проверка подключения 5/ч.
- Хост провайдера — только публичный адрес (защита от SSRF: сигнализация уходит с нашего хоста); политика адресов — та же, что у превью ссылок (`UNFURL_ALLOW_CIDRS` расширяет).
- Выключение телефонии удаляет транк в LiveKit и кладёт живые линии пространства.
- `livekit/sip:v1.14.0` — собран на том же коммите `livekit/protocol`, что `livekit-server v1.13.7` (psrpc 0.7.6 / 0.7.7); v1.17 уже на protocol 1.52 / psrpc 0.8 — обновлять вместе с сервером. Конфиг рендерится в переменную `SIP_CONFIG_BODY` (в нём пароль Valkey), а не в файл; `hide_inbound_port: true`.

## Последствия
- Новый контейнер и открытые порты только при `SIP_ENABLED`; на dev-стенде без провайдера
  телефония выключена, тесты мокают LiveKit SIP API как остальной `lksdk`.
- Клиент: одна кнопка и один тип участника в комнате; события — `SIP_CALL_UPDATE`.
- Отклонено: свой SIP-стек/WebRTC-шлюз (второй медиа-путь, эхо и запись пришлось бы дублировать);
  хранить пароль провайдера в env (один на все пространства).

## Пометка (02.10): телефония — только Business
Владелец, 02.10, к 2.0.0: телефония SIP доступна **только на тарифе Business** (`PLAN_ENTERPRISE`) и на
on-prem Enterprise — как SSO и вебхук доски. Заменяет «доступна на всех тарифах» из уточнения 30.09.
- Флаг `PlanLimits.telephony_disabled = 31` (`plans/limits.go` `TelephonyDisabled`; 24–26 остаются
  `reserved`): Free и Team — `true`, Business и on-prem — `false`, Custom — как сохранено, без ключа `true`
  (`plans.CustomBase`, как `board_webhooks_disabled`). Env `PLAN_*_LIMITS` переопределяют ключ.
- Сервер (`internal/sip`): `PUT …/sip` с `enabled: true`, `POST …/sip/test` и `POST /api/rooms/{id}/calls`
  (люди и боты) → `plans.FeatureError("telephony")` — `409 CONFLICT`, `reason PLAN_LIMIT`, `used = limit = 0`.
  Чтение настроек и журнала, `PUT` с `enabled: false` и «Завершить» доступны всегда.
- Понижение тарифа ничего не удаляет: аккаунт и транк в LiveKit остаются (настройки видны админу),
  `Workspace.sip_enabled` не меняется, идущий звонок не прерывается — новые звонки, проверка и повторное
  включение получают `PLAN_LIMIT`; после апгрейда всё работает без повторной настройки.
- Клиент: вкладка «Телефония» — форма и проверка под замком «Доступно на тарифе Business» (журнал открыт);
  кнопка «Позвонить на номер» в шапке комнаты скрыта, пункт меню комнаты — с замком и тостом; строка во
  вкладке «Тариф»; переключатель в форме «Индивидуальный» суперадмина (новый Custom — без телефонии).
