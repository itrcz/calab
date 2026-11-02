# 01 — Архитектура

## Цели

- Voice-first общение команды: зашёл в комнату — сразу слышишь всех, задержка минимальна.
- Текстовые чаты с файлами, история, presence.
- Стрим экрана 720p / 1080p / original, до 3 стримов в комнате.
- Максимальная проходимость сети: за VPN, корпоративными файрволами, симметричным NAT.
- Эффективный трафик: клиент получает только то, что реально рендерит.
- Эхоподавление без компромиссов при нескольких говорящих.
- Self-hosted: один сервер сейчас (docker compose), Kubernetes потом.
- MVP: 20–30 одновременных пользователей, до 3 видеостримов в комнате.

## Компоненты

```
┌──────────────────────────────── Desktop (Electron) ─────────────────────────────┐
│  main: окна, tray, global PTT (uiohook), desktopCapturer, автообновление         │
│  preload: узкий contextBridge API                                                 │
│  renderer (React): UI, store, REST-клиент, WS-gateway клиент, livekit-client      │
│    audio pipeline: mic → AudioWorklet(RNNoise+VAD) → LiveKit; remote → <audio>    │
└───────────┬───────────────────────────┬──────────────────────────┬───────────────┘
            │ HTTPS (REST)              │ WSS (gateway)            │ WebRTC (UDP/TCP/TURN)
            ▼                           ▼                          ▼
┌──────────────────── Caddy (:443, :80, TURN/UDP :443) — SNI-роутинг ─────────────┐
│  app.<domain>  → HTTPS terminate → api 127.0.0.1:3000 (/api, /gateway)          │
│  rtc.<domain>  → HTTPS terminate → livekit:7880 (signal WS)                     │
│  turn.<domain> → layer4: TLS terminate → livekit:5349 (TURN, external_tls)      │
└──────────┬───────────────────────────────────────────────────┬──────────────────┘
           ▼                                                   ▼
┌──── apps/server (Go) ──────┐                       ┌──── LiveKit SFU ─────────┐
│  REST API (net/http)       │  webhooks (room/      │  host network            │
│  WS gateway (coder/ws)     │◄─ participant events) │  UDP mux :7882           │
│  auth, permissions         │                       │  ICE/TCP :7881           │
│  LiveKit token issuer      │──── server SDK ──────►│  TURN/UDP :443 (host)    │
│  files: stream ↔ MinIO     │                       │  TURN :5349 (за Caddy)   │
└────┬──────────┬────────────┘                       └───────────┬──────────────┘
     ▼          ▼                                                ▼
 PostgreSQL   Redis (pub/sub между инстансами gateway,        Redis (LiveKit
 (данные)     буфер событий для RESUME, presence, rate-limit)  multi-node, позже)
     ▼
   MinIO (файлы/аватары/превью; не публичный, только через API)
```

### Desktop (`apps/desktop`)

- **Electron 44**, `electron-vite`, React 19, TypeScript, Zustand для состояния, TanStack Query для REST.
- Три процесса строго разделены: `main` (Node, привилегии), `preload` (мост), `renderer` (без Node, `contextIsolation`, `sandbox`).
- Главные обязанности `main`:
  - Global push-to-talk с keydown/keyup через `uiohook-napi` (у `globalShortcut` нет keyup).
  - `session.setDisplayMediaRequestHandler` — собственный пикер источников экрана, loopback системного звука.
  - Tray, автозапуск, автообновление (`electron-updater`, позже), single-instance lock, deep links `calaba://`.
- `renderer` — весь UI и вся медиа-логика (livekit-client работает в renderer, это обычный Chromium).
- **Движок почты** ([ADR-0088](adr/0088-mail-client.md)) — четвёртый процесс: `utilityProcess` (`src/main/mail/engine.ts` → `out/main/mailEngine.js`), IMAP/SMTP, локальная база и кэш тел писем. Main форкает его лениво (первый `mail:*`-запрос или существующий аккаунт), перезапускает при падении с паузой 1 → 60 с и убивает при выходе; сам ничего тяжёлого не делает.
- Renderer говорит с движком только через `mail:request` / `mail:event` (preload `calaba.mail`, `Platform.mail?: MailApi`); main сверяет имя метода по `mailMethods`, назначает свои id, ждёт ответ в срок метода (`MAIL_METHOD_TIMEOUT_MS`: 25–60 с, иначе `TIMEOUT`; `ENGINE_DOWN` — процесс упал) и раздаёт события окнам. Контракт — `src/shared/mail.ts`; в вебе и на телефоне `mail` нет. Для разработки — mock в renderer (`CALABA_MAIL_MOCK=1 pnpm dev:desktop`).

### Server (`apps/server`)

- **Go**, один статический бинарник = REST + WS gateway (stateless, горизонтально масштабируется через Redis). `net/http` + `coder/websocket`, `pgx` + `sqlc` (типизированный SQL без ORM), `goose`-миграции, `rueidis`.
- Пакеты: `internal/auth`, `users`, `workspaces`, `rooms`, `messages`, `files`, `rtc` (токены LiveKit, webhooks), `gateway`, `perm`.
- Контракт — protobuf в `proto/` (`buf`): те же message-типы генерируются в TS для клиента. Gateway — бинарный protobuf, REST — JSON (`protojson`).
- Цель по задержке: gateway-событие от REST-мутации до всех сокетов < 5 мс внутри инстанса; память процесса < 50 MB при 30 пользователях.
- Gateway-сессия = сокет устройства, переживающий реконнект (`RESUME`). Устройство = auth-сессия (лимит устройств, голос, identity); у веба gateway-сессия на каждую вкладку (`Identify.tab_id`, до 8 на auth-сессию, лишняя вытесняется `4011`), у десктопа и ботов — одна на auth-сессию (docs/05 «Вкладки браузера», #40).
- Presence — в Redis по gateway-сессиям (`presence:<user>`: статус и клиент из `Identify.device` — платформа и версия, `presence:seen` — последняя активность и её клиент); `Presence` отдаёт агрегат, в т. ч. `client_version`/`client_platform` самой свежей сессии (офлайн — последней активной, скрытые как `last_seen` при «невидимке»; docs/09 #143).
- LiveKit-токены выдаёт только сервер: в grant пишем ровно те права, что есть у пользователя в комнате (`canPublish`, `canPublishSources: [mic, screen]`, `canSubscribe`).

### Protocol (`proto/` + `packages/protocol`)

- `proto/calaba/v1/*.proto` — единственный источник правды контракта: REST-сообщения, события gateway, enum прав, пресеты.
- `packages/protocol` — TS-сторона: сгенерированные типы (`protobuf-es`) + `computePermissions` + константы; Go-сторона генерируется в `apps/server/gen`.
- Логика прав реализована на обоих языках и проверяется общими тест-векторами `proto/testdata/permissions.json`.

### LiveKit

- Официальный образ, host network, конфиг-шаблон `infra/docker/livekit/livekit.yaml.tpl` (рендерится `deploy.sh`).
- Одна LiveKit-room = одна voice-комната Calaba. Имя room = `ws_<workspaceId>_room_<roomId>`.
- `room.auto_create: true`: обычные комнаты создаёт API — перед выдачей каждого join-токена вызывает `CreateRoom` (идемпотентно; существующая комната возвращается как есть) с `empty_timeout: 300` с. Автосоздание нужно входящим звонкам (ADR-0117): LiveKit SIP по правилу `SIPDispatchRuleIndividual` заводит абонента в новую комнату `sipin_<пространство>_…` со случайным суффиксом, создать её заранее API не может; при `false` сервер отвечает 404 и абонент слышит «занято». Войти в комнату без токена нельзя, токены выдают только API и LiveKit SIP по нашему правилу.
- Participant identity = `<user_id>:<session_id>` — один пользователь может быть в комнате с нескольких устройств (см. docs/05).
- Webhooks `participant_joined/left`, `track_published/unpublished` → сервер обновляет voice-state и рассылает по gateway (кто в какой комнате, кто стримит).

## Ключевые потоки

### Вход в голосовую комнату

1. Клиент `POST /api/rooms/:id/join` → сервер проверяет право `CONNECT` и что сессия не отозвана, вызывает `CreateRoom` (идемпотентно, `empty_timeout` 300 с), выдаёт LiveKit JWT (TTL 10 мин, только на подключение, identity `<user_id>:<session_id>`).
2. Клиент `room.connect(rtcUrl, token, { adaptiveStream: true, dynacast: true })`.
3. Публикует mic-трек (Opus, DTX, in-band FEC; RED — только по опции «нестабильная сеть»). Screen — только по действию пользователя и при праве `STREAM`.
4. LiveKit шлёт webhook → сервер → gateway `VOICE_STATE_UPDATE` всем в workspace.
5. UI показывает участников комнаты по данным gateway (не по LiveKit) — единый источник для всех, включая тех, кто не в комнате.

### Сообщение в чат

1. `POST /api/rooms/:id/messages` (текст + attachments ids + `nonce`) → сервер сохраняет в Postgres (`id` = `uuidv7()`, генерирует Postgres — порядок = порядок коммитов) → публикует в Redis → все инстансы gateway рассылают `MESSAGE_CREATE` подписчикам workspace с правом `VIEW_ROOM`.
2. Optimistic UI: клиент показывает сообщение сразу с `nonce`, заменяет на серверное по совпадению `nonce`. Повторный POST с тем же `nonce` (ретрай после обрыва) возвращает уже созданное сообщение — идемпотентно (`UNIQUE (author_id, nonce)`).

### Файлы

Файлы идут **через API** и хранятся в `blob.Store` (драйвер `fs` на локальном volume; `s3` — позже, ADR-0011).

1. `POST /api/workspaces/:id/files` (multipart, потоково) → сервер проверяет `ATTACH_FILES`, лимиты и квоту, стримит в хранилище, по пути считая sha256 и определяя тип по содержимому → `files` запись → `fileId`.
2. Для `image/*` сервер генерирует превью (≤ 512 px по большей стороне, WebP) вторым объектом; `GET /api/files/:id/thumbnail`.
3. Клиент прикрепляет `fileId` к сообщению (до 20 вложений; файл — только к одному сообщению).
4. Скачивание — `GET /api/files/:id` с проверкой прав (`VIEW_ROOM` комнаты, где файл прикреплён) и поддержкой `Range`/ETag. Требует `Authorization` → клиент грузит через fetch и показывает через blob URL.
5. Перетаскивание картинки из чата/лайтбокса в Finder/Проводник сохраняет оригинал под его именем (`features/chat/imageDragOut.ts`). Десктоп: по нажатию мыши main качает оригинал через `calaba-api://` (тот же прокси, токен и HTTP-кэш, URL строится в main из проверенного UUID, ответ только `image/*`, ≤ 512 МБ) во временную папку `<temp>/calab-drag/<pid>/<n>/<имя>` (своя папка 0700 на каждую загрузку; вытесненная загрузка отменяется) (имя через `shared/fileName.ts`, карантин/Mark-of-the-Web как у загрузок, LRU 8 файлов, удаляется при выходе и при следующем старте), на `dragstart` — `webContents.startDrag` (`main/dragOut.ts`, IPC `files:drag-prepare`/`files:drag-start`). Веб: тип `DownloadURL` (Chromium) с blob: оригинала из кэша медиа. Пока идёт такой drag, свои зоны сброса файлов его игнорируют (`lib/dragOut.ts`). Пункт меню «Скачать картинку» — обычная загрузка вложения (`platform.files.download`).

Лимиты: 1 GB на файл (`MAX_FILE_SIZE_MB`; суперадмин переопределяет на пространство вместе с частотой загрузок, ADR-0155), 20 вложений на сообщение, квота workspace 10 GB по умолчанию (`workspaces.storage_quota_bytes`). Файлы-сироты (не прикреплены за 24 ч) удаляются раз в час.

### Диск

Папки и файлы пространства (ADR-0094), пакет `internal/disk`. Файл диска — обычная строка `files` плюс `disk_items`; загрузка `POST /api/workspaces/:id/disk/upload?parent=` идёт через `files.UploadWith` (квота и строка элемента в одной транзакции, занятое имя → «имя (2)»), скачивание — тот же `GET /api/files/:id` (`files.CanRead`: `DISK_VIEW` на элемент). Права каждого запроса — `perm.ComputeDiskItem` по цепочке предков (`internal/diskacl`); нет `DISK_VIEW` → 404, менять элемент (имя, перенос, корзина, доступ, ссылка) может его владелец или `DISK_MANAGE`, создавать в папке — `DISK_WRITE` на неё. Структурные изменения одного пространства идут под `LockDiskTree` (имена, циклы, глубина ≤ 32). Удаление навсегда — одна транзакция: строки `files` поддерева, их элементы и `ReleaseQuota`, байты из хранилища — после коммита (сборщик сирот этих строк уже не видит). Публичная ссылка файла — анонимные `GET /api/public/disk/:code`, `/content` (Range, `no-store`, `X-Robots-Tag: noindex`), `/thumbnail` с лимитами Redis на IP. После каждого изменения в канал пространства уходят `DISK_ITEM_UPSERT` / `DISK_ITEM_REMOVE` с цепочкой доступа элемента (служебное поле): шлюз считает по ней права каждого получателя и вырезает её, не видящий элемент событие не получает, потерявший доступ получает `REMOVE`. Журнал — `disk_activity` (переименования склеиваются за 5 мин). Воркер `disk.TrashSweep` раз в час удаляет навсегда корни корзины старше `disk_trash_days` (по умолчанию — никогда).

### Вики

Страницы пространства (ADR-0096), пакет `internal/wiki`, цепочки доступа — `internal/wikiacl` (то же дерево, что у Диска: `perm.ComputeWikiPageIn`; нет `WIKI_VIEW` → 404; `WIKI_WRITE` правит содержимое и создаёт подстраницы, структура — переименовать, иконка, обложка, перенос, корзина, доступ, ссылка — владелец страницы или `WIKI_MANAGE`). REST — `/api/workspaces/:id/wiki/{pages,trash/empty,activity,settings}` и `/api/wiki/pages/:id/{…}` (wiki.proto); перенос — под `LockWikiTree`, без циклов, глубина ≤ 32, `position` — индекс среди новых соседей. Картинки и вложения — `POST /api/wiki/pages/:id/files` через `files.UploadWith` в `wiki_page_files` (квота пространства; читаются через `GET /api/files/:id` с `WIKI_VIEW` на страницу); удаление навсегда — строки `files` поддерева и `ReleaseQuota` в транзакции, байты после коммита (как у Диска). События дерева — `WIKI_PAGE_UPSERT/REMOVE` с цепочкой доступа, шлюз фильтрует по получателю и вырезает её. Содержимое — Yjs-документ, который сервер не разбирает: отдельный сокет `GET /api/wiki/pages/:id/sync` (docs/05 «Вики: сокет синхронизации») хранит снимок + обновления после него (`wiki_page_snapshots`, `wiki_page_updates`, `seq` из `wiki_pages.next_seq`), ретранслирует кадры между экземплярами через Valkey-канал `wiki:<pageId>` (одна подписка на страницу на экземпляр, пока есть сокеты), просит снимок (`COMPACT_REQUEST`) при > 500 обновлений или > 1 МиБ; снимок обновляет текст для поиска, превью и раз в ≥ 5 мин — версию (`wiki_page_versions`, ≤ 200). Публичная ссылка — анонимные `GET /api/public/wiki/:code` (страница, при `include_children` — оглавление ветки без `restricted`), `/state` (снимок + обновления), `/files/:fileId` (только файлы ветки), `noindex`, `no-store`, лимиты Redis на IP. Поиск — раздел `wiki` (`SearchWikiPages` + фильтр по цепочкам). Воркер `wiki.TrashSweep` раз в час по `wiki_trash_days`.

### Холст

Бесконечное рабочее поле пространства (ADR-0126, вторая итерация — ADR-0127), пакет `internal/canvas`, цепочки доступа — `internal/canvasacl`: дерево папок и холстов с теми же правами, что у Вики (`perm.ComputeCanvasItemIn`, биты `CANVAS_VIEW/WRITE/MANAGE` 41–43; нет `CANVAS_VIEW` → 404; `CANVAS_WRITE` правит содержимое холста и создаёт элементы в папке, структуру — переименовать, перенос, корзина, доступ — владелец или `CANVAS_MANAGE`; приватные холсты и `perm.Detached` — как у Вики). REST — `/api/workspaces/:id/canvas/{items,trash/empty,activity,settings}` и `/api/canvas/items/:id/{…}` (canvas.proto), события `CANVAS_ITEM_UPSERT/REMOVE` с цепочкой доступа (шлюз фильтрует по получателю; боты в v1 их не получают). Содержимое — Yjs-документ, который сервер не разбирает: сокет `GET /api/canvas/items/:id/sync` — тот же ретранслятор `internal/ysync`, что у Вики (docs/05 «Вики: сокет синхронизации»): снимок ≤ 4 МиБ + обновления после него (`canvas_snapshots`, `canvas_updates`), канал Valkey `canvas:<id>`, версии (`canvas_versions`, раз в ≥ 10 мин и только при изменении, ≤ 50). Поиск — раздел `canvas`; воркер `canvas.TrashSweep` раз в час по `canvas_trash_days` (по 5 корней в транзакции, блокировка дерева области между ними свободна; сбойная область остаётся до следующего прогона, остальные чистятся). Комментарии (ADR-0127, волна 4) — серверная сущность `canvas_comments` рядом с Yjs-документом, не внутри него: REST `…/canvas/items/{id}/comments`, события `CANVAS_COMMENT_UPSERT/DELETE` (цепочка доступа холста) и `CANVAS_COMMENT_MENTION` (пользовательский канал, через `notifications`). Голосование и таймер — в самом документе (`meta.vote`, `votes`, `meta.timer`); сервер их не разбирает, право записи проверяет сокет. Публичная ссылка только для чтения (ADR-0127, волна 5а, `canvas_links`): анонимные `GET /api/public/canvas/{code}` и сокет `GET /api/public/canvas/{code}/sync` — режим зрителя того же `internal/ysync` (`Hub.ServeViewer`): без токена, без `AWARENESS` и `COMPACT_REQUEST`, любой входящий кадр — закрытие 4013. Файлов (картинок, рисования от руки) и ботов в холсте нет (боты — `botDeny`). Телефон («Ещё» → «Холст»): просмотр по умолчанию; «Править» при `CANVAS_WRITE` включает правку касанием в том же `CanvasView` (`phoneEdit`); без записи — только просмотр.

### Личный звонок на номер (телефония)

ADR-0137 §3 — зеркало принятого входящего (ADR-0117): `POST /api/workspaces/:id/sip/calls {number}` (`PLACE_CALLS` пространства, не гость, не бот, лимиты политики) → строка `sip_calls` (`origin = personal`), ключ занятости звонящего, своя LiveKit-комната `sipout_<ws>_<call id>` (`CreateRoom`, `empty_timeout 30`), ответ — токен `sipout-caller:<user>` (микрофон, подписка, data для DTMF). Клиент входит с ним (`voice.join(..., {call: true})`, пауза голосовой комнаты — ADR-0133); вебхук `participant_joined` звонящего в `sipout_*` (`SIPHook.Outbound`, голосовое состояние не трогается) — только тогда `CreateSIPParticipant` в эту комнату (`wait_until_answered`, Caller ID пространства), чтобы ответивший абонент не попал в пустую комнату. Не вошёл за 15 с — `FAILED not_connected`; вышел и не вернулся за 30 с — `ENDED lost`; абонент положил — `remote`; `DELETE …/sip/calls/:cid` — звонящий или `MANAGE_INTEGRATIONS`. Конец освобождает ключ занятости и закрывает комнату; страховка — общий `Sweep`. `SIP_CALL_UPDATE` (с именем из контактов) — в канал звонящего; запись (ADR-0131) пишет комнату `sipout_*` — только две стороны.

## Принципы

- **Единый источник состояния — gateway.** REST для мутаций и первичной загрузки, gateway для всех изменений. Клиент после `RESUME` не перезагружает всё.
- **Ничего тяжёлого в main-процессе Electron.** Медиа — в renderer.
- **Безопасность по умолчанию:** права проверяются на сервере; LiveKit-grant повторяет права; renderer без Node.
- **Наблюдаемость с первого дня:** структурированные логи (`slog`, JSON), метрики Prometheus (сервер + LiveKit), health-эндпоинты.
- **Конфигурация через env**, никаких путей/хостов в коде — это упрощает переезд на k8s.
