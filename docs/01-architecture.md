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
- `room.auto_create: false`: комнаты создаёт только API — перед выдачей каждого join-токена вызывает `CreateRoom` (идемпотентно; существующая комната возвращается как есть) с `empty_timeout: 300` с.
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

Лимиты: 50 MB на файл (`MAX_FILE_SIZE_MB`), 20 вложений на сообщение, квота workspace 10 GB по умолчанию (`workspaces.storage_quota_bytes`). Файлы-сироты (не прикреплены за 24 ч) удаляются раз в час.

## Принципы

- **Единый источник состояния — gateway.** REST для мутаций и первичной загрузки, gateway для всех изменений. Клиент после `RESUME` не перезагружает всё.
- **Ничего тяжёлого в main-процессе Electron.** Медиа — в renderer.
- **Безопасность по умолчанию:** права проверяются на сервере; LiveKit-grant повторяет права; renderer без Node.
- **Наблюдаемость с первого дня:** структурированные логи (`slog`, JSON), метрики Prometheus (сервер + LiveKit), health-эндпоинты.
- **Конфигурация через env**, никаких путей/хостов в коде — это упрощает переезд на k8s.
