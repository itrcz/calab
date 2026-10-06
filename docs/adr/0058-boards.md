# ADR-0058: Доски — категории, чек-листы, фичи доски, вебхук (2026-10-02)

**Статус: принято и реализовано в 2.0.0 (этапы 0–5; правки по итогам реализации — в тексте ниже).** Уточняет ADR-0042 (доски), ADR-0049 (согласования),
ADR-0031 §4 (очередь вебхуков ботов), ADR-0048 (права v2). Номера 0054–0056 заняты Identity 2.0, 0057 — встроенные стикеры (PR #57);
миграции 00055–00057 — там же, 00058 — стикеры, наша — **00059**. Ветки — от текущего `main` (доски входят в 2.0.0).
Номера сверены с кодом при фиксации контракта (этап 0, 02.10).

## Контекст
Владелец (02.10): «нужны категории как в голосовых каналах; чек-листы в тасках, чтобы задавать чек-лист и
отмечать; возможность включать/отключать на доске фичи — сторипоинты, дедлайны и т. д.; вебхук на доске,
на который улетает JSON, если что-то меняется в задаче». Уточнения: чек-листов в задаче несколько,
именованных; конфигурируется всё, что можно; вебхук — один на доску, шлёт все изменения (выбор событий —
следующей версией); категории досок отдельные от категорий комнат.

## Решение

### 0. Общие правила (вытекают из кода, обязательны для всех этапов)
- **Новые события и Identity 2.0.** `gateway/identity.go: eventScope` — явный список всех oneof
  `DispatchEvent` с `TestEventScopeClassified` (неклассифицированное событие молча не доходит и валит тест);
  86 занят `WORKSPACE_IDENTITY_ACCESS_UPDATE`, наши — **87–91**, классифицированы в этапе 0. Новые события
  идут по каналу пространства — DB-резолв `eventResources` (user-канал) их не касается. Маршрутизация в
  `gateway/boards.go: routeBoards` (этап 0): категории — всем участникам, кроме гостей; чек-листы — зрителям доски.
- **Admission-граница записи.** После PR #52 любая мутация — через `s.tx` (`db.TxRaw`) или `db.GuardValue`,
  никогда голым `s.db.Q.<Mutation>`. Outbox вебхука — **в той же** транзакции, что изменение.
- Новых битов прав нет; `computePermissions` не меняется. Новые маршруты — в `botroutes.go`: категории,
  чек-листы, фичи — `botAllow` по тем же битам; вебхук — `botDeny` (секреты).

### 1. Категории досок
- `board_categories (id uuidv7, workspace_id FK CASCADE, name 1..100, position int, created_at)`, индекс
  `(workspace_id, position)`, ≤ 50 на пространство; `boards.category_id uuid NULL REFERENCES board_categories
  ON DELETE SET NULL` (+ индекс). Порядок — как у комнат после 00012: `boards.position` внутри контейнера
  (категория или «без категории»); существующие позиции остаются валидными (все доски — без категории).
- Права: категории (создать/переименовать/удалить/переставить) — `CREATE_BOARDS` ws (у комнат — `MANAGE_ROOM`
  ws; отдельного ws-бита для досок нет, `MANAGE_BOARD` пообъектный). Положить/переставить доску —
  `MANAGE_BOARD` на ней (как `PUT /boards/{id}/position`). Категория — только имя, видна всем; клиент прячет
  категории без видимых досок (имя может намекать на закрытую доску — как у комнат; принято).
- API (зеркало комнат): `GET/POST /api/workspaces/{id}/board-categories`, `PATCH/DELETE
  /api/board-categories/{id}` (удаление — доски в «без категории» хвостом, каждой `BOARD_UPDATE`);
  `PUT /api/workspaces/{id}/boards/order {boards[{board_id, category_id, position}], categories[{category_id,
  position}]}` — один drag = одна транзакция и один `WorkspaceEvents`-пайплайн; `categories` требует
  `CREATE_BOARDS`, каждая доска — `MANAGE_BOARD` (невидимая → `422`, как у комнат). `PUT /boards/{id}/position`
  остаётся, + `optional string category_id` (`SetBoardPositionRequest = 2`). Сообщения:
  `SetBoardOrderRequest/Response`, `Create/UpdateBoardCategoryRequest`, `BoardCategoryResponse`.
- Proto: `BoardCategory {id, workspace_id, name, position}`, `Board.category_id = 25`; события
  `BOARD_CATEGORY_CREATE/UPDATE/DELETE = 87/88/89` всем участникам пространства, кроме гостей; `WorkspaceSnapshot.
  board_categories = 20`. Свёрнутость — локально на клиенте.

### 2. Чек-листы задачи
- `task_checklists (id, task_id FK CASCADE, title 1..100, position int, created_by, created_at)` ≤ 10 на задачу;
  `task_checklist_items (id, checklist_id FK CASCADE, task_id (денормализовано — счётчики), text 1..500,
  done bool, done_by, done_at, position double, created_by, created_at)` ≤ 100 на чек-лист; индексы
  `(checklist_id, position)`, `(task_id)`. `tasks` не меняется.
- `Task.checklist_total = 39`, `checklist_done = 40` (через `TaskCounts`, во всех списках — прогресс «3/7» на
  карточке); `repeated TaskChecklist checklists = 41` — только `GET /tasks/{id}`. Ответ маршрутов чек-листов —
  `TaskChecklistResponse {checklist, checklist_total, checklist_done}`.
- Права — как у полей задачи (`requireEdit`: `EDIT_TASKS` любые, `CREATE_TASKS` — свои и назначенные);
  отметка пункта — то же право. Боты — так же. Фича `CHECKLISTS` (§3).
- API: `POST /api/tasks/{id}/checklists {title}`, `PATCH /api/checklists/{id} {title?, position?}`, `DELETE`;
  `POST /api/checklists/{id}/items {text, position?}`, `PATCH /api/checklist-items/{id} {text?, done?,
  position?, checklist_id?}` (перенос внутри задачи), `DELETE`; `POST /api/checklist-items/{id}/convert` →
  `ConvertChecklistItemResponse {task, checklist, счётчики}` — подзадача с текстом пункта (статус по умолчанию, без других полей), пункт удаляется; требует фичу
  `SUBTASKS` и что задача сама не подзадача (один уровень).
- События: `TASK_CHECKLIST_UPDATE = 90 {workspace_id, board_id, task_id, checklist (полный, ≤ 100 пунктов),
  checklist_total, checklist_done}` и `TASK_CHECKLIST_DELETE = 91 {…, checklist_id, счётчики}` зрителям доски.
  **`TASK_UPDATE` на операции чек-листа не шлётся**: счётчики едут в самом событии (экономим `tasksProto` —
  6 запросов — и полную перерисовку карточки); клиент патчит два поля задачи (новый объект задачи — только при
  смене счётчиков). `tasks.updated_at` обновляется (`updated_after`, вебхук). Журнал `task_activity.kind =
  'checklist'`: `after {checklist_id, title, item_id?, text?, action: created|renamed|deleted|item_added|
  item_edited|item_done|item_undone|item_removed|item_moved|converted}` → обычный `TASK_ACTIVITY`.
  Уведомлений нет (и на последний пункт тоже — шум); голоса согласования не сбрасываются.

### 3. Фичи доски
- `enum BoardFeature` (1..13, см. дополнение ниже): `ESTIMATE`, `START_DATE`, `DUE_DATE`, `PRIORITY`, `LABELS`, `MILESTONES`,
  `SUBTASKS`, `RELATIONS`, `APPROVALS`, `CHECKLISTS`, `ATTACHMENTS` (вложения описания), `COMMENTS`,
  `TIMELINE`. `Board.disabled_features repeated BoardFeature = 26`; БД `boards.disabled_features bigint NOT
  NULL DEFAULT 0` (бит = номер значения). **Хранится выключенное**: новая фича будущих версий на старых досках
  включена. (ADR-0054 §5 запрещает отрицательный флаг для *доступа*; здесь UX-настройка — не противоречит.)
- **Дополнение (владелец, 07.10: «в досках нет возможности все фичи выключить»).** `BoardFeature` расширен до
  1..16: `FORMS` (формы приёма: создание/правка — `409 FEATURE_DISABLED`, существующая форма не открывается —
  `404`, данные целы), `AUTOMATIONS` (создание, включение, правка и тест правила — `409`; включённые правила
  на паузе: движок и свипер их пропускают, ничего не удаляется; вкладка «Автоматизации» скрыта), `GIT_LINKS`
  (секция и бейдж Git-ссылок в задаче скрыты — только клиент; привязка по ключу в сообщениях продолжает работать).
  Выключить можно всё необязательное; обязательны статус и заголовок (без них задача не существует), исполнители
  и подписки — отдельные механизмы доступа, не фичи. Лист создания задачи получил чип «Начало» (фича
  `START_DATE`; сервер принимал `start_on` и раньше; поздний выбор сбрасывает противоположную дату, чтобы не
  получить `422`). Существующие доски ведут себя как раньше (выключенное хранится, дефолт — всё включено).
- Шкала оценки: `enum EstimateScale {FIBONACCI (1,2,3,5,8,13,21; дефолт), LINEAR (1..10), TSHIRT (XS=1, S=2,
  M=3, L=5, XL=8 — хранится число)}`, `Board.estimate_scale = 27`, БД `boards.estimate_scale text DEFAULT
  'fibonacci'`. Запись проверяет `estimate ∈ шкале` (`422 estimate`); смена шкалы задачи не переписывает,
  значение вне шкалы показывается числом до правки. CHECK `1..21` остаётся.
- `PATCH /api/boards/{id} {set_disabled_features, disabled_features[], estimate_scale}` (`UpdateBoardRequest`
  10–12; `ESTIMATE_SCALE_UNSPECIFIED` не отправляется и в записи — `422`) — `MANAGE_BOARD`;
  едет в `BOARD_UPDATE` (редкое событие — полная перерисовка доски допустима).
- **Сервер — один helper `requireFeature`** во всех путях записи (REST = Bot API, те же обработчики; «задача из
  сообщения» = `createTask`): запрос, **меняющий** поле выключенной фичи на непустое, → `409 CONFLICT`,
  `reason FEATURE_DISABLED`, `field` = JSON-имя поля (`estimate`, `dueOn`, `approverIds`…). Сброс в пусто и
  повтор текущего значения проходят (клиенты/боты могут чистить и не ломаются на `PATCH` без изменений).
  Точки: `createTask`/`updateTask` (estimate, start_on, due_on, priority ≠ NONE, label_ids, milestone_id,
  parent_id, attachment_ids, approver_ids/approval_required), `setApprovers`/`vote` (APPROVALS), `addRelation`
  (RELATIONS; удаление можно), маршруты чек-листов (CHECKLISTS; удаление можно), `convert` (SUBTASKS).
  Настройки доски (лейблы, вехи) не гейтятся — это конфигурация. CSV-импорта на сервере нет; экспорт — клиент.
- **Данные не удаляются** и по-прежнему отдаются в API/вебхуке; клиент их скрывает; включение возвращает всё.
  Фильтры и виды сервер считает как есть (молчаливый пропуск условия меняет выдачу); клиент прячет поле в
  пикере и помечает чип «выключено»; вид `timeline` при выключенном `TIMELINE` открывается списком. Перенос на
  доску с другим набором фич разрешён — поля там просто скрыты.
- Особые случаи: `APPROVALS` выкл. — `checkApprovalGate` не применяется (и при переносе на такую доску),
  голоса сохраняются, напоминания свипера не шлются; `COMMENTS` выкл. — комната задачи как у архивной
  задачи: `perm.TaskRoom(board, archived, commentsOff)` снимает `SEND_MESSAGES | ATTACH_FILES` (`VIEW_ROOM` и
  `MANAGE_MESSAGES` у `EDIT_TASKS` остаются — старое видно и модерируется); флаг — в `GetBoardAccess`/
  `BoardAccess`, в состояние шлюза (`taskRoomBits` из `Board.disabled_features`) и в TS
  `taskRoomPermissions(board, archived, commentsOff)`; `SUBTASKS` выкл. — новые `parent_id` и `convert`
  отклоняются, существующие связи остаются; `TIMELINE` — только клиент.

### 4. Вебхук доски
- `board_webhooks (board_id PK FK CASCADE, url https ≤ 2048, secret_enc bytea (sealbox, как у ботов),
  disabled_at, failing_since, last_ok_at, last_error, next_seq bigint DEFAULT 1, created_by, created_at,
  updated_at)`; `board_webhook_deliveries (id uuidv7, board_id FK CASCADE, seq bigint, event_type, payload bytea,
  attempts, next_at, created_at, delivered_at, failed_at, error)`, partial-индекс due `(next_at) WHERE
  delivered_at IS NULL AND failed_at IS NULL`, `(board_id, created_at)`; доставленные/упавшие чистятся через 7 дней.
- Права: `MANAGE_BOARD` на доске **и** `MANAGE_INTEGRATIONS` пространства (вывод данных наружу). Боты — нет.
  Секрет: 16..256 символов свой или пустой → сервер генерирует 32 байта base64url и возвращает **один раз** в
  ответе `PUT`; `GET` отдаёт `has_secret`, сам секрет — никогда. Вебхук принадлежит доске: виден любому
  `MANAGE_BOARD` в настройках (с `created_by`), уход создателя/закрытие доски его не трогают — ответственность
  управляющих доской. Политика Identity 2.0 не применяется (машинная интеграция, как вебхук бота, ADR-0054 §4);
  воркер — фоновая работа без admission, постановка в очередь — внутри admission-транзакции изменения.
- API: `GET/PUT/DELETE /api/boards/{id}/webhook` (`PUT` на отключённый — включает заново, как у ботов; `DELETE`
  — очередь помечается `failed`), `POST /api/boards/{id}/webhook/ping` — синхронная доставка события `ping`
  тем же транспортом, ответ `BoardWebhookPingResponse {ok, status, error}`, ≤ 1 раз в 10 с на доску.
  `BoardWebhook {board_id, url, has_secret, enabled, disabled_at, failing_since, last_ok_at, last_error, pending,
  created_by, created_at, updated_at, paused_reason}`; `GET` без вебхука — `BoardWebhookResponse` без `webhook`.
- **Движок — общий с ботами, вынесенный, а не скопированный.** Сегодня `internal/bots` — post-commit
  `Publisher` + воркер, привязанный к `sqlc.BotWebhookDelivery`. Новый пакет `internal/webhook`: `Transport`
  (`unfurl.PublicAddr`/`SafeTransport`, только https, без редиректов, 10 с, `CheckURL`), `Options`
  (= `bots.WebhookOptions`), `Backoff` 1 мин → 1 ч, `GiveUp` 24 ч, авто-отключение, generic `Worker` над
  интерфейсом `Queue {Claim, Target, Delivered, Retry, Failed, Failing, Disable}` с Valkey-lock по ключу очереди
  (`bots:webhook:worker`, `boards:webhook:worker`); `internal/bots` — реализация `Queue` (поведение, заголовки
  и тесты ботов без изменений). Реплики: `wake` локальный, остальные добирают поллингом 2 с; lease 2 мин.
- **Outbox.** Изменения задачи: `change` (tasks.go) уже собирает `task_activity` транзакции → в её конце одна
  строка доставки (при наличии вебхука — один индексный lookup в tx), `seq` из `next_seq` той же строки
  (row-lock сериализует писателей доски — приемлемо). Комментарии: сообщение коммитится в `internal/messages`,
  `TaskHook` работает после коммита — строка пишется в транзакции хука сразу после; для правки/удаления
  добавляется `TaskCommentHook(kind)`. Окно потери — падение процесса между коммитом и хуком; принято,
  описано в docs/19 «Вебхук доски → Известный пробел» (хук внутри tx сообщений — бэклог).
- Типы: `task.created | task.updated` (любой kind журнала: поля, статус, исполнители, связи, вложения,
  согласования, чек-листы) `| task.archived | task.restored` (свипер — `actor: null`) `| task.moved_out`
  (исходная доска) `| task.moved_in` (целевая, задача уже с новым ключом) `| task.comment.created | .updated |
  .deleted | ping`.
- **Payload** — proto `BoardWebhookEvent` (boards.proto), protojson с `UseProtoNames` (имена полей — snake_case, как в proto, не lowerCamelCase REST) и `EmitUnpopulated` (все поля присутствуют, неустановленные сообщения — `null`, например `"actor": null` у изменений сервера; `uint64`, как `size` вложения, — строкой):
  ```json
  {"id": "<uuid доставки — ключ идемпотентности>", "version": 1, "type": "task.updated", "sequence": 42,
   "occurred_at": "…", "workspace_id": "…", "board": {"id": "…", "key": "FNG", "name": "…"},
   "actor": {"id": "…", "name": "…", "is_bot": false},
   "task": { …Task: viewer-поля (subscribed, muted, unread, viewer_state) в значениях по умолчанию, attachments и checklists пусты (счётчики остаются)… },
   "task_url": "https://…/t/FNG-12",
   "changes": [{"field": "status", "before": {…}, "after": {…}}],
   "comment": {"id", "author_id", "text", "attachments": [{"name", "size", "mime"}], "created_at", "edited_at"}}
  ```
  `task.moved_out` несёт только `id`, прежний `key` и `board_id` доски-источника и одну запись `changes` `moved_board` с `before` (полная задача — в `moved_in` целевой доски); у `ping` `sequence = 0`, `task` не задан.
  Ссылка — отдельное поле `task_url` (в `Task` поля `url` нет, контракт `Task` не засоряем); `sequence` —
  `uint32` (число в JSON; `uint64` protojson отдал бы строкой), в БД `bigint`.
  `changes` = записи `task_activity` транзакции (`field` = kind, before/after = их jsonb) — журнал и вебхук не
  расходятся по определению. `version: 1` в теле и `X-Calab-Webhook-Version: 1`: контракт меняется только
  добавлением полей; смена `version` — только при ломающем изменении, с переходным периодом. Размер ограничен
  данными (описание ≤ 20000, комментарий ≤ 4000) — ≈ ≤ 100 КБ без усечения; получатель принимает ≤ 256 КБ.
- At-least-once, порядок не гарантируется: получатель дедуплицирует по `id`, упорядочивает по `sequence`
  (монотонен в пределах доски). Пачка изменений одной транзакции — одно событие.
- **Подпись с защитой от replay сразу** (контракт новый): `X-Calab-Timestamp: <unix>`, `X-Calab-Signature:
  v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>`, получатель отвергает |now − ts| > 5 мин; плюс
  `X-Calab-Delivery: <id>`, `X-Calab-Event: <type>`, `User-Agent: Calab-Webhook/1.0`. Боты остаются на
  `sha256=…` (перевод на `v1` с переходным периодом — бэклог).
- Архив доски — задачи read-only, событий нет, очередь дорабатывается; purge — каскад.

### 5. Тарифы (владелец, 02.10)
Как CalDAV/режим музыканта (ADR-0024, `plans/limits.go`): флаг в лимитах тарифа, отказ —
`plans.FeatureError` (`409 CONFLICT`, `reason PLAN_LIMIT`, used = limit = 0), проверка на сервере в каждом
пути записи (REST и Bot API); клиент показывает замок с названием тарифа.
- Proto: `PlanLimits.checklists_disabled = 29`, `board_webhooks_disabled = 30` (24–26 — `reserved`, удалённые
  флаги). Форма «Индивидуальный» суперадмина написана руками (`AdminWindow.tsx` + `lib/plan.ts`), не из proto, и
  сейчас не передаёт флаги вовсе (как `caldav`/`musician`) — сохранение Custom пишет `false`; переключатели
  добавляет этап 4, до него «по умолчанию» для Custom означает `false`.
- **Чек-листы — с Team**: `checklists_disabled` — Free `true`; Team, Business (`PLAN_ENTERPRISE`) и
  on-prem — `false`; Custom — как сохранено (по умолчанию `false`). На тарифе без чек-листов уже созданные
  видны только для чтения (данные не удаляются, после апгрейда снова редактируемы); создание, правка,
  отметка и convert — `PLAN_LIMIT`.
- **Вебхук доски — только Business**: `board_webhooks_disabled` — Free и Team `true`; Business
  (`PLAN_ENTERPRISE`) и on-prem — `false`; Custom — как сохранено (по умолчанию `true`). Ниже Business
  настроить вебхук нельзя; при понижении тарифа вебхук **не удаляется, доставка на паузе** (новые события не
  ставятся в очередь, `BoardWebhook.paused_reason = PLAN`), после апгрейда — продолжается с новых событий.
- План-ограничение и фича доски независимы: фича `CHECKLISTS` выключает чек-листы на доске на любом тарифе;
  тариф без чек-листов делает их read-only независимо от фичи.

## Не входит в 2.0.0 (бэклог)
Выбор событий и несколько вебхуков на доску; подпись `v1` для ботов; хук комментариев внутри транзакции
сообщений; шаблоны чек-листов; исполнитель и срок у пункта; общие категории комнат и досок; настройка фич
«на всё пространство».

## Последствия
- Протокол: `boards.proto` (категории, чек-листы, фичи, вебхук, `BoardWebhookEvent`), `gateway.proto` (87–91,
  `board_categories`), `eventScope`, миграция 00059, sqlc, маршруты-заглушки `501`
  (`internal/boards/contract_stubs.go`, этапы заменяют свои строки); один агент владеет контрактом, потребители
  стартуют после его фиксации. Docs: `docs/04`, `docs/05`, `docs/19` + `19.en` (маршруты, `FEATURE_DISABLED`,
  «Вебхук доски» с payload и референсной проверкой подписи), SDK `packages/bot-sdk`, CHANGELOG 2.0.0.
- Безопасность — второе независимое ревью (CLAUDE.md п. 5): протокол (этап 0), вебхук (секреты, SSRF, вывод
  данных, подпись), производные права комнаты задачи (`TaskRoom` Go + TS, тест-векторы).
- Производительность: отметка пункта — одно `TASK_CHECKLIST_UPDATE` (+ `TASK_ACTIVITY`), без `TASK_UPDATE`;
  в сторе `checklists[taskId]` отдельно от `tasks`; строка пункта в `memo` с селектором по id; карточка
  подписана только на два счётчика. Проверка `CALABA_REACT_PROFILING=1` + `tools/perf-call.ts` на доске 200
  задач: отметка пункта перерисовывает одну карточку и секцию панели, не доску.
- Миграция 00059 только добавляет таблицы и столбцы с дефолтами (`ALTER TABLE boards ADD COLUMN … DEFAULT` —
  metadata-only на PG ≥ 11; FK `category_id` и CHECK `estimate_scale` проверяются проходом по `boards` — таблица
  ≤ 50 строк на пространство, под `lock_timeout = 10s`), `tasks` не трогает, индексы — на новых пустых таблицах
  и один частичный `boards (category_id) WHERE category_id IS NOT NULL`; безопасна на
  заполненной БД, проверяется на PG17 и PG18 (`internal/db` migrate-тест с данными).
