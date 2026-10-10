# apps/server — Calab API + gateway (Go)

Один статический бинарник: REST API, WS gateway, выдача LiveKit-токенов, файлы. Архитектура — `docs/01-architecture.md`, данные и права — `docs/04-data-model.md`, протокол — `docs/05-realtime-protocol.md`, решения — `docs/adr/` (ADR-0007, 0008, 0009, 0011).

## Структура

```
cmd/server            main: `serve` (по умолчанию) | `migrate [status]` | `healthcheck` (GET /readyz на HTTP_ADDR, exit 0/1 — для healthcheck в distroless-образе)
internal/config       env → Config (caarlos0/env), валидация
internal/app          сборка зависимостей и роутера, фоновые задачи (используется main и интеграционными тестами)
internal/httpx        ApiError, protojson, middleware (request-id, client IP, access log + метрики, recover)
internal/db           pgxpool, goose-миграции (embed, pg_advisory_lock), транзакции
internal/db/migrations/*.sql   схема (goose)
internal/db/queries/*.sql      запросы (sqlc) → internal/db/sqlc (сгенерировано, коммитится)
internal/redisx       rueidis-клиент (проверка версии: Valkey ≥ 9.0 или Redis ≥ 7.4), token bucket rate limiter (Lua)
internal/events       публикация DispatchEvent в Redis pub/sub (16-байтный id события + protobuf)
internal/auth         argon2id, access JWT, refresh-ротация + reuse detection, middleware, /api/auth/*
internal/users        /api/me
internal/profile      рассылка USER_UPDATE (Me — своим устройствам, публичный User — в workspace пользователя)
internal/workspaces   workspaces, участники, роли, инвайты, снапшот workspace (READY / WORKSPACE_CREATE)
internal/rooms        комнаты, медиа-настройки, overrides прав, фильтрация по VIEW_ROOM
internal/messages     история (курсор по uuidv7), идемпотентная отправка по nonce, правка/удаление, read state
internal/files        загрузка потоком в blob.Store (sha256, лимит, квота), WebP-превью, скачивание с Range/ETag, чистка сирот
internal/blob         blob.Store + драйвер fs (ADR-0011)
internal/guests       ссылки на комнату и гостевые аккаунты (ADR-0016): превью, вход по сценариям a/b/c, promote, чистка неактивных
internal/unfurl       превью ссылок (OpenGraph) и прокси их картинок: SSRF-защита, кэш в Redis, подписанные ссылки
internal/voice        voice state в Redis (по сессии устройства, агрегация по пользователю), стримы
internal/rtc          LiveKit (свой минимальный клиент, ADR-0013): токены и grant'ы, stream/request, voice/self, модерация, webhook, reconcile, синхронизация прав
internal/gateway      WS gateway: HELLO/IDENTIFY/RESUME/HEARTBEAT, seq + буфер для RESUME, presence, typing, fan-out
internal/perm         Compute (зеркало computePermissions) + Resolver (роль+overrides из БД, кэш на запрос)
internal/pbconv       строки БД → proto-сообщения, маппинг enum ↔ текст в БД
internal/health       /healthz, /readyz
gen/calaba/v1         Go из proto (buf, коммитится)
```

Правила: права проверяются только через `perm.Resolver` / `perm.Compute`; строки БД в proto — только через `pbconv`; события — после коммита транзакции через `events.Publisher` (в app он обёрнут `rtc.SyncPublisher`, который после изменений прав/ролей/членства/сессий обновляет grant'ы в LiveKit или отключает участников).

## Запуск локально

```sh
pnpm install && make gen                  # из корня репо (генерация идемпотентна)
pnpm infra:dev                            # postgres 18 (:55432), valkey 9 (:56379), livekit --dev (:7880)
make dev-server                           # дефолты под compose.dev: REGISTRATION_MODE=open, LiveKit devkey/secret
```

LiveKit в compose.dev работает с `infra/docker/livekit/livekit.dev.yaml`: ключи `devkey`/`secret` и webhook на `http://host.docker.internal:3000/api/rtc/webhook`, то есть на `make dev-server`. Поэтому voice state в dev обновляется сразу, без ожидания reconcile.

Порты dev-стенда смещены (55432, 56379): на машинах разработчиков 5432/6379 часто заняты чужими Postgres/Redis (в т.ч. нативным Redis < 7.4 — сервер с ним не стартует).

KV-хранилище — **Valkey (совместим с Redis)**, ADR-0017. В коде и переменных остаётся имя протокола: `REDIS_URL`, пакет `redisx`, ключ `redis` в `/readyz`.

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `HTTP_ADDR` | `127.0.0.1:3000` | адрес HTTP (REST + `/gateway`) |
| `DATABASE_URL` | — (обязательна) | Postgres 18 (`uuidv7()`) |
| `REDIS_URL` | — (обязательна) | `redis://host:port/db`, с паролем — `redis://:pass@host:port/db` (спецсимволы в пароле URL-кодировать); **Valkey ≥ 9.0** (или Redis ≥ 7.4): HEXPIRE для presence |
| `REDIS_KEY_PREFIX` | пусто | пространство имён всех ключей и каналов pub/sub API в Valkey, например `calab:` (буквы, цифры, `._-:`, в конце `:`): для Valkey, общего с другими приложениями, под ACL-пользователем `~calab:* &calab:*` (docs/06 «Общий Valkey»); пусто — прежние имена |
| `JWT_SECRET` | — (обязательна, ≥ 32 байт) | подпись access JWT (HS256) |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | `24h` / `8760h` | время жизни access JWT / сессии (скользящее, 1 год); отзыв мгновенный при любых сроках (docs/04 «Auth») |
| `REGISTRATION_MODE` | `invite` | `open` \| `invite` (без кода — только первый пользователь сервера) |
| `EMAIL_VERIFICATION` | `required` | `required` \| `optional` (ADR-0065). `required` — неподтверждённая почта: 403 `EMAIL_NOT_VERIFIED` на создание пространств, приглашения, ботов, новые DM, внешних участников встреч (ADR-0023). `optional` — ничего не блокирует, кода при регистрации нет (кроме приглашённых по почте); адрес остаётся неподтверждённым и не считается доказанным (поиск/добавление по почте, вступление по email-приглашению, OAuth `email`, суперадмин). Без `SMTP_HOST` не влияет: адреса подтверждены сразу |
| `AUTH_RATE_BURST` / `AUTH_RATE_PER_MINUTE` | `10` / `10` | token bucket по IP на login и register |
| `LOGIN_ACCOUNT_ATTEMPTS` | `10` | попыток входа на один email за 15 мин с любых IP (429 + `Retry-After`) |
| `MAX_WORKSPACES_PER_USER` | `5` | сколько workspace может принадлежать одному пользователю (409 `WORKSPACE_LIMIT`) |
| `WORKSPACE_CREATES_PER_HOUR` | `3` | создание workspace на пользователя в час |
| `DEFAULT_WORKSPACE_QUOTA_BYTES` | `10737418240` (10 GiB) | квота нового workspace |
| `STORAGE_MAX_TOTAL_BYTES` | `53687091200` (50 GiB) | потолок всех файлов сервера (507 `STORAGE_FULL`); метрика `calaba_storage_used_bytes` |
| `TRUSTED_PROXIES` | `127.0.0.1/32,::1/128` | кому верить в `X-Forwarded-For` (Caddy) |
| `PUBLIC_APP_URL` | `http://localhost:3000` | внешний URL веб-клиента; его origin разрешён для cookie-auth (CSRF) и WS-апгрейда |
| `PUBLIC_APP_URL_ALT` | — | запасной домен веб-клиента (совместимость), разрешён так же |
| `PUBLIC_APP_URLS` | — | все origin веб-клиента через запятую (`https://app.calab.io,https://colaba.gptunnel.ai,…`); разрешённый список = `PUBLIC_APP_URL` + `PUBLIC_APP_URL_ALT` + этот; `PUBLIC_APP_URL` остаётся основным (ссылки) |
| `LOG_LEVEL` | `info` | `debug`\|`info`\|`warn`\|`error`, JSON в stdout |
| `MIGRATE_ON_START` | `true` | применять миграции при `serve` |
| `STORAGE_DRIVER` / `STORAGE_PATH` | `fs` / `./data/files` (образ: `/data/files`) | хранилище файлов (ADR-0011): `fs` — каталог, `s3` — бакет S3 (`STORAGE_S3_*`, docs/06 «Файлы в S3») |
| `MAX_FILE_SIZE_MB` | `50` | лимит файла; поток обрывается при превышении → 413 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` (образ: статическая сборка 8.0 в `/usr/local/bin`) | HEIC → JPEG (`POST /api/files/convert`, нужен ffmpeg ≥ 7.1); не найдены → 501, клиент говорит «HEIC не поддерживается» |
| `LIVEKIT_URL` | — | URL для клиентов (`wss://rtc.<domain>`, dev `ws://localhost:7880`) |
| `LIVEKIT_INTERNAL_URL` | — | URL для API (`http://127.0.0.1:7880`) |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | — | задаются все четыре LIVEKIT_* или ни одной (тогда voice-эндпоинты → 503) |
| `LIVEKIT_MAX_PARTICIPANTS` | `50` | `max_participants` комнаты LiveKit |
| `PLAN_FREE_LIMITS` / `PLAN_TEAM_LIMITS` | встроенные (ADR-0024) | JSON поверх дефолтов тарифа, напр. `{"room_members":5,"stream_max_preset":"h720","stream_max_fps":15,"storage_mb":1024}`; 0 / `""` = без лимита; неверный JSON — сервер не стартует |
| `PLAN_CONTACT_URL` / `PLAN_CONTACT_EMAIL` | — / `it@gptunnel.ai` | куда писать за подпиской (`plan_contact` в READY и `/api/version`): URL, иначе `mailto:` |
| `SUPERADMIN_EMAILS` | — | email суперадминов через запятую: `/api/admin/*`, `me.is_superadmin` |
| `UNFURL_ALLOW_CIDRS` | — | только dev: диапазоны, которые превью ссылок может запрашивать, хотя они не публичные (VPN с fake-IP, напр. `198.18.0.0/15`); loopback/link-local всё равно запрещены |
| `SMTP_HOST` | — | почта (ADR-0023); пусто = без почты: адреса считаются подтверждёнными, почтовые эндпоинты → 503. Можно `host:port` |
| `SMTP_PORT` | по `SMTP_TLS` | 465 `tls` / 587 `starttls` / 25 `none` |
| `SMTP_TLS` | `starttls` | `tls` (implicit, 465) \| `starttls` \| `none` (только Mailpit / локальный релей) |
| `SMTP_USER` / `SMTP_PASSWORD` | — | AUTH PLAIN (только по TLS); пусто = без AUTH |
| `SMTP_FROM` | — | обязателен при `SMTP_HOST`: `Calab <noreply@calab.io>` |
| `MAIL_PER_ADDRESS_PER_HOUR` / `MAIL_PER_HOUR` | `3` / `200` | писем на адрес и на сервер в час (Valkey) |
| `MAIL_EVENTS_PER_ADDRESS_PER_HOUR` | `10` | писем встреч (приглашение/изменение/отмена) на адрес в час — отдельно от кодов |
| `CALDAV_SYNC_INTERVAL` | `15m` | как часто импортируется занятость подключённого CalDAV-календаря пользователя (ADR-0041), 1m..24h |
| `GPTUNNEL_API_URL` | `https://gptunnel.ai` | запись встреч (ADR-0025): API устройств GPTunneL (pairing, загрузка, статус) |
| `RECORDING_MAX_CONCURRENT` | `3` | одновременных записей на сервер (egress ≈ 0.5 CPU на запись) |
| `RECORDINGS_PATH` / `RECORDING_EGRESS_DIR` | `./data/recordings` / `/out` | том записей глазами API и контейнера egress (один volume); при `STORAGE_DRIVER=s3` не нужны: egress загружает записи в бакет файлов (docs/06 «Записи встреч в S3») |
| `GATEWAY_HEARTBEAT_INTERVAL` | `41s` | интервал heartbeat (presence TTL = 2×) |
| `GATEWAY_MAX_SESSIONS_PER_USER` | `5` | лимит устройств с активным gateway |

## Оплата: Точка (RU, ₽; ADR-0083)

Второй эквайер рядом со Stripe: рынок `ru`, валюта RUB, ручное пополнение картой МИР или по СБП
через платёжную ссылку банка с чеком 54-ФЗ (облачная касса Точки). Все флаги выключены по
умолчанию; прод не включает их без отдельного решения.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `BILLING_TOCHKA_ENABLED` | `false` | адаптер Точки: новые оплаты, вебхук, опрос; нужен `BILLING_ENABLED` и `BILLING_PROVIDERS=stripe:global,tochka:ru` |
| `TOCHKA_API_TOKEN` | — | JWT-ключ мерчанта (Bearer). Только в секретах; не логируется |
| `TOCHKA_CUSTOMER_CODE` / `TOCHKA_MERCHANT_ID` | — | код клиента (9 символов) и торговая точка (15 цифр); чужие операции не принимаются |
| `TOCHKA_API_URL` | `https://enter.tochka.com/uapi` | песочница `https://enter.tochka.com/sandbox/v2` отвечает заготовками (только формат) |
| `TOCHKA_TAX_SYSTEM` / `TOCHKA_VAT_TYPE` | `usn_income` / `none` | система налогообложения и НДС в чеке (оферта: ООО «Громтех», АУСН, без НДС) |
| `TOCHKA_WEBHOOK_PUBLIC_KEY` | ключ в адаптере | JWK банка для RS256 вебхуков; ротация — массив `[старый, новый]` и выкладка |
| `TOCHKA_CLIENT_ID` | `iss` токена | client_id для API вебхуков |

Лимиты ручного пополнения 150..500 000 ₽ (матрица `provider.DefaultMatrix`, проверка на сервере).
Суперадмин закрывает эквайер для новых клиентов в «Оплата → Эквайеры» без выкладки
(`PUT /api/admin/billing/providers/{id}`); уже оплатившие продолжают платить через него.

Шаги оператора (`server tochka …` читает только `TOCHKA_*`, токен не печатает):

1. `server tochka key` — закреплённый ключ вебхуков совпадает с опубликованным банком.
2. Выкатить сервер с `BILLING_TOCHKA_ENABLED=true`, затем `server tochka webhook set https://app.calab.io/api/billing/tochka/webhook`.
   Один URL на `client_id`; банк шлёт тестовый вебхук и сохраняет URL, только если получил 200
   (с выключенной Точкой маршрут отвечает 501 — регистрация не пройдёт). Проверка: `server tochka webhook get` / `webhook test`.
3. Без вебхуков всё работает опросом: открытые оплаты опрашиваются через 30 с, 1, 2, 4, 8 мин, затем раз в 15 мин.
   Не-200 банк повторяет 30 раз раз в 10 с и бросает — деньги дойдут опросом.

## Фоновые задачи (в каждом инстансе, с блокировками там, где нужен один исполнитель)

- gateway: подписка на Redis pub/sub, lease инстанса, sweeper presence (15 с, лок в Redis);
- files: чистка файлов-сирот раз в час (не прикреплены > 24 ч, не аватар/иконка; `pg_try_advisory_xact_lock`);
- rtc: reconcile voice state с LiveKit раз в 30 с (лок в Redis);
- billing (при `BILLING_ENABLED`): inbox вебхуков, сверка раз в 5 мин, опрос открытых оплат провайдеров без вебхуков об отказе (Точка, раз в 15 с ищет должные), суточные списания (`FOR UPDATE SKIP LOCKED`).

При SIGTERM gateway рассылает `RECONNECT` с разбросом до 5 с и отдаёт сессии (их можно `RESUME` на любом инстансе), затем останавливается HTTP.

## Сборка, версия, лицензии

- Проект — Business Source License 1.1 (`LICENSE`, `NOTICE`, `COMMERCIAL-LICENSE.md` в корне). Образ кладёт их в `/`, туда же — `/THIRD-PARTY-NOTICES.txt` (лицензии Go-зависимостей).
- `GET /api/version` (без авторизации) → `{product: "Calab", version, commit, license, commercialLicense, attribution, url}`. Клиенты показывают `attribution` в «О программе» — этого требует NOTICE.
- Версия и коммит зашиваются при сборке: `ARG VERSION` / `ARG COMMIT` в Dockerfile → `-ldflags -X …/internal/buildinfo.{Version,Commit}`. compose передаёт `CALABA_VERSION` / `CALABA_COMMIT` из окружения (на хосте нет `.git`, поэтому значение задаёт вызывающий: `CALABA_COMMIT=$(git rev-parse --short HEAD)`). Локальный `go build` из git-checkout берёт коммит из VCS-информации Go.
- `make third-party-notices` пересобирает `THIRD-PARTY-NOTICES.txt` из модулей, реально слинкованных в бинарник образа: `go list -deps ./cmd/server` всегда для `GOOS=linux GOARCH=amd64 CGO_ENABLED=0` (цель Dockerfile), независимо от ОС машины — набор зависит от платформы (`prometheus/procfs` только linux). `go test ./tools/notices` проверяет, что файл совпадает с генерацией при любом хосте (дрейф ловится и в CI). Это делает `tools/notices`: файлы LICENSE/NOTICE модуля и его подкаталогов первого уровня (так попадает и `lib/LICENSE.libwebp`, встроенный в `gen2brain/webp`). На GPL/LGPL/AGPL или нераспознанной лицензии команда падает. Запускать после изменения зависимостей и коммитить результат.

## Миграции

- goose, SQL в `internal/db/migrations`, встраиваются в бинарник. `serve` применяет их при старте под `pg_advisory_lock`; для k8s-job — `server migrate`, статус — `server migrate status`.
- Новая миграция: `0000N_name.sql` с `-- +goose Up` / `-- +goose Down`, затем `make gen`.

## Кодогенерация

`make gen` из корня: `buf generate` (Go → `gen/`, TS → `packages/protocol/src/gen`) и `sqlc generate`. Плагины локальные: `protoc-gen-go` — `tool` в `go.mod`, `protoc-gen-es` — devDependency `packages/protocol`. Сгенерированный код коммитится; CI проверяет дрейф.

## Тесты

```sh
make test                  # unit: go test ./... + pnpm -r test
make test-integration      # нужен pnpm infra:dev (postgres :55432, valkey :56379, livekit :7880)
                           # TEST_DATABASE_URL, TEST_REDIS_URL (DB 15 очищается!), TEST_LIVEKIT_URL / TEST_LIVEKIT_INTERNAL_URL
                           # TEST_REDIS_KEY_PREFIX: пространство имён Valkey для тестов, по умолчанию calab:; пустое значение — без него
make lint                  # go vet + golangci-lint (+ pnpm lint)
```

Интеграционные тесты (`-tags integration`, `internal/app`) создают временную БД `calaba_it_<random>`, поднимают приложение целиком в `httptest` (включая gateway и фоновые задачи) и удаляют БД. Тесты rtc пропускаются (`SKIP`), если dev-LiveKit недоступен. Valkey в них по умолчанию с пространством имён `calab:` (`REDIS_KEY_PREFIX`): после прогона SCAN проверяет, что в тестовой базе нет ни одного ключа вне него, — ключ, собранный мимо `redisx.Key`, роняет прогон.
