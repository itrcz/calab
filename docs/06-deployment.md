# 06 — Деплой

Production API/web сейчас выпускаются через [`images.yml`](../.github/workflows/images.yml)
и GitHub Deployment `calab-prod`; конфигурацией управляет платформа кластера.
Для 2.0 сначала закрыть [identity gates](#identity-20-настройка-и-приёмка).
Compose/SSH ниже — отдельная self-hosted установка и исторический запасной путь,
не второй параллельный деплой production.

## Docker compose на одном хосте

Тестовый стенд: `root@141.105.69.177` (Debian 13, 32 vCPU, 123 GB RAM, 1.2 TB свободно, Docker 29, Compose v5).

**На хосте уже крутится GPU-задача** (`python` pid 3695 ~40 % RAM, `ffmpeg`, headless `chromium`, `Xvfb`; порты 8000/8001/8190/8210–8213/8300/8400/9100/9400, UDP 9001/9002). **Не трогаем.** Наши порты (80/443/7881/7882) с ними не пересекаются. RAM: ставим лимиты контейнерам (postgres 2G, api 1G, livekit 4G) чтобы не конкурировать; логи контейнеров ротируются.

Состав `infra/docker/compose.yml`:

| Сервис | Образ | Сеть | Заметки |
|---|---|---|---|
| caddy | своя сборка `infra/docker/caddy/Dockerfile` (`caddy:2.11.4` + `caddy-l4` v0.1.2, обе версии запинены; `entrypoint.sh` собирает списки хостов из `DOMAIN`/`DOMAIN_ALT`/`DOMAIN_LEGACY`) | host | 80/443 TCP, ACME, `Caddyfile`, layer4 как listener wrapper (SNI `turn.*`), h3 выключен |
| livekit | `livekit/livekit-server:v1.13` | host | signal 7880 (только 127.0.0.1), 7881/tcp, 7882/udp, TURN 443/udp, TURN 5349 (`external_tls`; слушает `*:5349` — LiveKit не умеет bind для TURN, снаружи закрыт файрволом), metrics 6789 (127.0.0.1) |
| api | `apps/server/Dockerfile` (Go → distroless static, nonroot) | **host**, `HTTP_ADDR=127.0.0.1:3000` | ходит в Postgres/Valkey/LiveKit по 127.0.0.1; миграции сам при старте; файлы — `STORAGE_DRIVER=fs`, volume `files_data` → `/data/files` (ADR-0011; каталог создан в образе с владельцем nonroot 65532, свежий named volume наследует его — отдельный chown не нужен); healthcheck — `/server healthcheck` |
| postgres | `postgres:18-alpine` | bridge, `127.0.0.1:5432` | PostgreSQL 18 или 17 (ADR-0037): на 18 `uuidv7()` встроенная, на 17 API до миграций сам создаёт `public.uuidv7()` — нужен `CREATE` в схеме `public`, как и для миграций (есть у владельца базы). Управляемый кластер: база в UTF-8 с `LC_CTYPE` не `C`, иначе поиск и `citext` не понижают регистр кириллицы; расширение `citext` (миграция 00001) может понадобиться включить в настройках кластера. **`pg_trgm`** (миграция 00064, единый поиск ADR-0062) — trusted extension: на PostgreSQL 13+ его создаёт владелец базы, отдельных прав не нужно; если роль API не владелец и не суперпользователь, миграция падает с `no privilege to create extension pg_trgm` — оператор один раз выполняет `CREATE EXTENSION pg_trgm;` в этой базе суперпользователем и перезапускает API (миграция продолжит с `IF NOT EXISTS`). На управляемом кластере расширение может требовать включения в списке разрешённых. Volume на `/var/lib/postgresql` |
| valkey | `valkey/valkey:9-alpine` — Valkey, совместим с Redis (ADR-0017) | bridge, `127.0.0.1:6379` | AOF, volume `valkey_data`; healthcheck `valkey-cli ping` |
| egress | `livekit/egress:v1.14.1` (digest запинен; совместим с livekit-server 1.13) | host | запись встреч (ADR-0025): audio-only room composite без Chrome → MP4 в volume `recordings_data` (`/out`); с LiveKit — через Valkey (DB 1) и ws `127.0.0.1:7880`; лимит 4 CPU / 4 GB; внутренний порт шаблонов 7980 (снаружи закрыт файрволом) |
| recordings-init | образ valkey (one-shot) | none | делает `recordings_data` владением api (65532) до старта api/egress |

Почему api в host network: API обращается к LiveKit (`127.0.0.1:7880`, signal слушает только loopback), а LiveKit шлёт webhook на `127.0.0.1:3000`. Из bridge-сети это требовало бы `host.docker.internal` и правил файрвола для `docker0`; в host network всё идёт по loopback, наружу API не торчит (слушает только 127.0.0.1).

MinIO нет (ADR-0011): образ `minio/minio` удалён с Docker Hub, сторонние сборки не берём; файлы API пишет драйвером `fs` в volume `calaba_files_data`. Драйвер `s3` (Yandex Object Storage / Garage / Ceph RGW) — для k8s и нескольких реплик API, см. «Файлы в S3: драйвер `s3`» ниже.

Имя compose-проекта задано явно (`name: calaba`, dev — `calaba-dev`): контейнеры и volume называются `calaba-*`/`calaba_*`, `--remove-orphans` не заденет чужие проекты на общем хосте.

Логи всех сервисов — драйвер `json-file` с ротацией (`max-size: 50m`, `max-file: 5`), чтобы не забить диск общего стенда.

### Конфигурация и деплой

- Секреты — в `infra/docker/.env` на хосте (не в репо), шаблон — `.env.example`.
- **Сроки токенов**: `ACCESS_TOKEN_TTL` (по умолчанию `24h`) и `REFRESH_TOKEN_TTL` (`8760h` = 1 год, скользящий: каждый refresh продлевает) — в `.env`, compose передаёт их api. Отзыв сессии мгновенный при любых сроках (docs/04 «Auth»); свой сервер со строгими требованиями может ужесточить, напр. `ACCESS_TOKEN_TTL=15m`, `REFRESH_TOKEN_TTL=720h` (валидация: access ≥ 1m, refresh ≥ access).
- LiveKit-конфиг — шаблон `infra/docker/livekit/livekit.yaml.tpl`. В нём подставляются **только** `${DOMAIN}` и `${LIVEKIT_API_KEY}` (`envsubst '${DOMAIN} ${LIVEKIT_API_KEY}'`) → `livekit.gen.yaml` (в `.gitignore`). Ключ/секрет LiveKit приходят через env `LIVEKIT_KEYS`, в файл не пишутся.
- `deploy.sh [сервисы…]` — загружает `.env`, рендерит `livekit.gen.yaml`, выполняет `docker compose up -d --build --remove-orphans [сервисы…]`. Если отрендеренный конфиг LiveKit изменился — перезапускает `livekit` (bind-mount: compose сам изменения содержимого не замечает). Caddyfile вшит в образ → подхватывается через `--build`.
- **`SYNC_REF=<ref>`** — деплоить закоммиченное состояние (чистый `git archive`), а не рабочее дерево; обязательно, когда в дереве чужая незакоммиченная работа (иначе она уедет на стенд). Артефакты веба/релизов (не в git) берутся из рабочего дерева. Пример: `SYNC_REF=HEAD SKIP_WEB=1 SKIP_RELEASES=1 infra/docker/sync.sh api`.
- **Версия сборки** для `GET /api/version`: `sync.sh` передаёт `CALABA_COMMIT` (короткий sha `SYNC_REF`, либо `HEAD`, с суффиксом `-dirty`, если синхронизируется грязное дерево в `apps/server`/`infra`/`proto`/`packages`) и `CALABA_VERSION` (`VERSION=` или `apps/desktop/package.json`) → `deploy.sh` → build args образа api.
- Деплой на стенд — с машины разработчика, **git на хосте нет**: `infra/docker/sync.sh [сервисы…]` = `rsync` рабочего дерева в `/opt/calaba` (без `node_modules`, `.git`, `dist`, `.env*`, `livekit.gen.yaml`; `--delete`, исключённые пути защищены) + `ssh … /opt/calaba/infra/docker/deploy.sh [сервисы…]`. `SYNC_ONLY=1` — только синхронизация; `STAND_HOST`/`STAND_DIR` переопределяют хост/каталог. CI (GitHub Actions) позже будет собирать образы.
- Миграции (`goose`) API выполняет **автоматически при старте** под `pg_advisory_lock` — при нескольких репликах мигрирует только одна, остальные ждут. Отдельного шага `migrate` при деплое нет (для k8s та же команда доступна как job).
- Детектор говорящих LiveKit (секция `audio` шаблона: `active_level: 40`, `update_interval: 150`, см. docs/02 «Индикация речи собеседников») читается только при старте: изменение вступает в силу после перезапуска `livekit` — `deploy.sh` делает это сам при изменении отрендеренного конфига (короткий обрыв медиа, выкатывать в релизное окно).
- LiveKit работает одной нодой, но с Redis (Valkey, DB 1, пароль — env `REDIS_PASSWORD` контейнера, в файл не рендерится): без него egress недоступен (ADR-0025). **Первый деплой с записью встреч перезапускает LiveKit** (изменился отрендеренный конфиг) — короткий обрыв звонков, выкатывать в релизное окно; порядок: `deploy.sh valkey livekit egress api`.
- **Запись встреч (ADR-0025).** env api: `GPTUNNEL_API_URL` (по умолчанию `https://gptunnel.ru`), `GPTUNNEL_WEB_URL` (`https://gptunnel.ru`: ссылки GPTunneL на `app.gptunnel.ai` показываются на нём, docs/17), `RECORDING_KEEP_DAYS` (30: столько дней аудио готовой записи висит вложением карточки, считается в квоту пространства как вложения), `RECORDING_MAX_CONCURRENT` (3; одна запись ≈ 0.5 CPU egress), `RECORDINGS_PATH=/data/recordings` + `RECORDING_EGRESS_DIR=/out` (один volume `recordings_data` в двух контейнерах; с `STORAGE_DRIVER=s3` volume не нужен — «Записи встреч в S3»). Диск: AAC ~128 кбит/с ≈ 60 МБ/ч, ≤ 4 ч на запись → ≤ ~250 МБ; после `done` файл переезжает в хранилище вложений (S3/fs) и удаляется с volume, из хранилища — через `RECORDING_KEEP_DAYS`; неудачные — с volume через 7 дней; volume в бэкапы не входит (записи временные). Проверка на стенде — smoke из TESTING «Запись встреч». Подключение пространства — код из GPTunneL в настройках пространства.
- **Временные комнаты (ADR-0044).** env api: `TEMP_ROOM_RETENTION_DAYS` (90, 1..3650): через столько дней после закрытия архивная временная комната удаляется вместе с историей (вложения — обычной чисткой сирот).
- **Саундборд (ADR-0036).** Звуки пространства сервер перекодирует `ffmpeg` (Ogg/Opus 48 кГц моно, −16 LUFS, ≤ 5 с). Используется тот же статический ffmpeg 8.0 образа api, что и для HEIC (`FFMPEG_PATH` / `FFPROBE_PATH`, нужен ≥ 7.1 с ffprobe; локально — `brew install ffmpeg`), в его единственном слоте конвертации, таймаут 20 с. Без него добавление звука отвечает 503, остальное (встроенные звуки, проигрывание) работает. В CI интеграционные тесты берут тот же бинарник из образа `mwader/static-ffmpeg`.
- **Боты (ADR-0031).** env api: `BOT_RATE_PER_SEC` (30 запросов в секунду на бота), `BOT_MESSAGES_PER_MIN` (20 сообщений в минуту на бота); лимит ботов на пространство — ключ `bots` в `PLAN_FREE_LIMITS` / `PLAN_TEAM_LIMITS` / `PLAN_BUSINESS_LIMITS` (по умолчанию 1 / 5 / 20; self-hosted Enterprise — настраивает оператор, без ключа лимиты тарифов Free действуют по умолчанию). Webhook-и ботов уходят с api-контейнера наружу по https (только публичные адреса), нужен исходящий доступ в интернет.

Подготовка хоста (одноразово):
```
# файрвол — только ДОБАВИТЬ ACCEPT в INPUT перед финальным DROP (никакого flush!), подробности — docs/03-network.md.
# На стенде: iptables(nf_tables), сохранение в /etc/iptables/rules.v4 (iptables-restore.service). Уже сделано:
tcp dport {80, 443, 7881} accept
udp dport {443, 7882} accept
# sysctl (на стенде уже 16 MB)
net.core.rmem_max=8388608  net.core.wmem_max=8388608
# пакеты
apt install gettext-base rsync   # envsubst для deploy.sh, rsync для sync.sh
mkdir -p /opt/calaba
```

### Телефония SIP (ADR-0046)

Выключена по умолчанию: без `SIP_ENABLED=1` контейнер `sip` не поднимается и порты не открыты.

1. Файрвол — три правила из docs/03 «SIP» (5060 udp/tcp, 10000–10200/udp), сохранить `rules.v4`.
2. `.env`: `SIP_ENABLED=1` → `infra/docker/deploy.sh` — рендерит `livekit/sip.yaml.tpl` в `SIP_CONFIG_BODY` (в нём пароль Valkey, на диск не пишется) и включает compose-профиль `sip` (`livekit/sip:v1.14.0`, совместим с `livekit-server v1.13.7`: тот же коммит `livekit/protocol`; обновлять парой).
3. Проверка: `docker compose logs sip | grep 'service ready'`; `ss -lun | grep 5060`.
4. Аккаунт провайдера — в приложении: Настройки пространства → «Телефония» (хост, транспорт, логин/пароль, Caller ID, разрешённые префиксы — для РФ `+7`), «Проверить подключение» звонит на Caller ID на 5 с (звонок платный, виден в журнале). Роли, которым можно звонить, получают `PLACE_CALLS`.
5. Выключить: `SIP_ENABLED=0` + `deploy.sh` (контейнер удаляется), правила файрвола — убрать.

### Стенд: как он поднят (2026-09-25)

- Код: `/opt/calaba` (копия рабочего дерева через `sync.sh`), секреты: `/opt/calaba/infra/docker/.env` (`chmod 600`, root; сгенерированы `openssl rand` по `.env.example`, `REGISTRATION_MODE=open`). `sync.sh` этот файл никогда не перезаписывает и не удаляет.
- Ключ/секрет LiveKit для тестов (`lk`, load-test) брать оттуда: `ssh root@141.105.69.177 'grep ^LIVEKIT_API_ /opt/calaba/infra/docker/.env'` — не коммитить и не вставлять в отчёты.
- **Домены (docs/10-branding.md; с 2.0.0 — `calab.io` + алиасы `calab.ru`, см. «Домены: calab.io…» ниже):** схема — `DOMAIN=calab.io` (`rtc.calab.io`, `turn.calab.io`; TURN анонсируется по нему), `APP_HOST=app.calab.io` (веб-клиент, API, gateway, `/download/`), `LANDING_HOST=calab.io` (статика `apps/landing/out` → `/opt/calaba/landing`, bind `../../landing:/srv/landing:ro`; там же `/download/` — те же релизы), `DOMAIN_ALT=meet.gptunnel.ru` и `DOMAIN_LEGACY=app.calab.ru` — дополнительные хосты приложения (их `rtc.`/`turn.` тоже обслуживаются на переходный период). `entrypoint.sh` Caddy собирает из этого списки хостов и генерирует сайт лендинга (`/tmp/landing.caddy`, пустой при `LANDING_HOST=`); `PUBLIC_APP_URL=https://${APP_HOST}`, `PUBLIC_APP_URL_ALT=https://${DOMAIN_ALT}` (до серверного `PUBLIC_APP_URLS` origin `DOMAIN_LEGACY` не проходит CSRF/Origin-проверку веб-клиента — десктоп не затронут).
  - **Состояние 2026-09-26:** стенд на `calab.ru` (делегирование `.ru` ~08:22): `.env` — `DOMAIN=calab.ru`, `APP_HOST=app.calab.ru`, `LANDING_HOST=calab.ru`, `DOMAIN_ALT=meet.gptunnel.ru`, `DOMAIN_LEGACY=` (пусто), `RELEASES_HOST=releases.calab.ru`, `S3_PUBLIC_URL=https://storage.yandexcloud.net/calaba` (бакет `calaba`, Yandex Object Storage, публичное чтение). Сертификаты LE: `calab.ru`, `app.`, `rtc.`, `turn.`, `releases.calab.ru`, `meet.gptunnel.ru`; LiveKit анонсирует `turn.calab.ru`; `PUBLIC_APP_URLS=https://app.calab.ru,https://meet.gptunnel.ru` (чужой Origin — 403); `/download/…` на приложении и лендинге → 302 на `releases.calab.ru` (прокси в бакет). Лендинг опубликован (`apps/landing`, b9467d1). Алиасы `colaba.gptunnel.ai/.ru` и их `rtc.`/`turn.` сняты (DNS-записи удалены, Caddy их не обслуживает; старые сертификаты просто истекут).
  - Лендинг: не SPA — `/foo` → `foo.html` или `foo/index.html` (static export с `trailingSlash`), неизвестный путь → `404.html` со статусом 404; `/_next/static/*` — `immutable` только если файл есть, страницы — `no-cache`; CSP лендинга допускает inline-скрипты (`script-src 'self' 'unsafe-inline'` — гидрация Next.js static export без сервера для nonce), без connect-целей кроме self; HSTS, `X-Frame-Options DENY`, `Permissions-Policy` без камеры/микрофона. `sync.sh`: `LANDING_DIST` (по умолчанию `apps/landing/out`), `SKIP_LANDING=1`; без сборки — заглушка.
- История: до переименования (2026-09-25…26) стенд жил на `colaba.gptunnel.ai` (основной) + `colaba.gptunnel.ru`; сертификаты Let's Encrypt на все имена выпускает Caddy (volume `calaba_caddy_data`).
- DNS — Cloudflare (зоны `gptunnel.ai`, `gptunnel.ru`), A-записи `colaba` (приложение), `rtc.colaba`, `turn.colaba` → 141.105.69.177, **proxied=false** (DNS-only), TTL auto. Токен Cloudflare — только у владельца/в локальном `.env` репо (`CFTOKEN`, gitignored), на сервер не копируется.
- Весь стек (с api) поднят 2026-09-25: `infra/docker/sync.sh` без аргументов; отдельный сервис — `infra/docker/sync.sh api`. Миграции применились при старте api.
- Регистрация **только по приглашению** (`REGISTRATION_MODE=invite`, с 2026-09-26 — security review H2); бессрочный инвайт владельца в workspace `team` (10 использований) — в `/opt/calaba/infra/docker/.env.accounts` (строка `invite`). Тестовые аккаунты `owner@calaba.test` / `bob@calaba.test` (workspace `team`), пароль — `/opt/calaba/infra/docker/.env.accounts` (600; `sync.sh` не трогает `.env*`). 
- Снаружи через Caddy доступны только `<домен>` (API + веб-клиент; `/metrics` и `/readyz` закрыты — 404, изнутри `127.0.0.1:3000/metrics`, `127.0.0.1:3000/readyz`; снаружи для мониторинга — `/healthz`), `rtc.*` (signal), `turn.*` (TURN/TLS).

### Защита стенда (security review 2026-09-26)

- Контейнеры api/caddy/postgres/valkey: `read_only: true` + tmpfs `/tmp`, `cap_drop: [ALL]`, `no-new-privileges`. Caddy — только `NET_BIND_SERVICE` (80/443); postgres и valkey запускаются сразу своими пользователями (`70:70`, `999:1000`) — без gosu и без capabilities; api — distroless nonroot 65532. LiveKit пока без этого (host network, TURN на 443/udp) — TODO.
- Лимиты памяти: api 1G, caddy 512m, postgres 2G, valkey 768m (`maxmemory 512mb`), livekit 4G.
- Valkey: пароль (`REDIS_PASSWORD` в `.env`, в `REDIS_URL` api), пароль передаётся через конфиг в tmpfs, а не в argv (не виден в `ps` на общем хосте); `maxmemory-policy noeviction` — сессии/отзывы/буферы gateway нельзя терять молча (при нехватке — ошибки записи, видно в логах).
- Переезд стенда Redis 7.4 → Valkey 9.1 — 2026-09-26: бэкап, `docker stop calaba-redis-1` (порт 127.0.0.1:6379 должен освободиться до старта valkey), `SYNC_REF=HEAD infra/docker/sync.sh valkey api` (`--remove-orphans` удалил контейнер redis), новый volume `calaba_valkey_data` (Valkey не читает RDB 12 Redis 7.4 — там только временное состояние: отзывы токенов, лимиты, presence, буферы gateway; клиенты переподключаются, сессии в Postgres сохраняются). Проверено: `NOAUTH` без пароля, `noeviction`/512mb, `HEXPIRE`/`HTTL` работают, пароль не виден в `ps`, вход/gateway/голос/webhook — OK; после проверки удалены `calaba_redis_data` и образ `redis:7.4-alpine`.
- Диск: `STORAGE_MAX_TOTAL_BYTES` = 50 GiB на все загрузки (плюс квоты пространств и лимит пространств на пользователя — на стороне api).
- Заголовки: HSTS `max-age=31536000; includeSubDomains` на `<домен>` и `rtc.<домен>` (без preload — зоны `gptunnel.*` не наши); на `/api/*` — `Referrer-Policy: same-origin` (Caddy), `Cache-Control: no-store` и `nosniff` ставит сам api.
- Образы запинены по digest (compose, Dockerfile Caddy и api, CI); обновления — Dependabot (`.github/dependabot.yml`: actions, gomod, npm, docker, docker-compose), в CI — `govulncheck`, Actions по SHA, golangci-lint запинен.
- Файрвол: TURN-relay ограничен (docs/03 «TURN relay»), IPv6 INPUT — политика DROP (`/etc/iptables/rules.v6`, `ip6tables-restore.service`).

### Общий Valkey (`REDIS_KEY_PREFIX`)

По умолчанию API занимает свой Valkey целиком (как в compose выше). Чтобы делить один Valkey с другими приложениями, API нужны пространство имён и свой ACL-пользователь:

- `REDIS_KEY_PREFIX=calab:` — с ним **все** ключи и **все** каналы pub/sub API начинаются с префикса (`calab:voice:ws:<id>`, `calab:rl:auth:<ip>`, `calab:ws:<workspace_id>`, `calab:gw:ctl:<instance>`, `calab:plans:changed`…). Пусто (по умолчанию) — прежние имена байт в байт, существующие данные не затрагиваются. Формат: буквы, цифры, `.`, `_`, `-`, `:`, в конце обязательно `:`, до 64 байт — без символов glob и так, чтобы `~calab:*` не захватил ключи соседа `calabash:…`.
- Префикс меняют на всех инстансах API одним деплоем: инстансы с разными префиксами не видят событий друг друга. Для API смена префикса — как пустой Valkey: presence, voice, буферы gateway, лимиты и маркеры отзыва остаются под старыми именами и истекают по TTL, клиенты переподключаются, сессии живут в Postgres.
- Gateway с префиксом подписан одним шаблоном `PSUBSCRIBE calab:*` (без префикса — прежние `ws:*`, `user:*`, `session:revoked:*` и свой `gw:ctl:<instance>`): шаблон PSUBSCRIBE Valkey сверяет с ACL буквально, а не как glob, и пользователю с `&calab:*` разрешён ровно `calab:*` (`PSUBSCRIBE calab:ws:*` получит `NOPERM`).
- База одна: номер из `REDIS_URL` (по умолчанию 0). Сам API базу не переключает; `SELECT` клиент (rueidis) шлёт один раз при подключении и только если в `REDIS_URL` база ≠ 0. `SCAN`/`KEYS`, `FLUSHDB`, `CONFIG` API не вызывает.
- LiveKit и egress со своей базой (DB 1 в compose) и своими ключами префикс не затрагивает; для общего Valkey им нужен отдельный пользователь.

ACL-пользователь API (одной строкой; в `users.acl` — те же правила после `user calab`):

```
ACL SETUSER calab on >ПАРОЛЬ resetkeys resetchannels ~calab:* &calab:* db=0 -@all
  +ping +info +cluster|shards +cluster|slots
  +client|tracking +client|caching +client|setinfo +multi +exec
  +get +set +del +exists +expire +pexpire +pttl
  +hset +hmget +hgetall +hvals +hdel +hlen +hexists +hexpire
  +sadd +srem +smembers +sismember
  +zadd +zrem +zscore +zcard +zrange +zrangebyscore +zremrangebyscore
  +rpush +ltrim +lrange
  +eval +evalsha +time
  +publish +subscribe +unsubscribe +psubscribe +punsubscribe
```

и `REDIS_URL=redis://calab:ПАРОЛЬ@<хост>:6379/0`. Список собран по коду (`B().<Команда>()`, `redis.call` в Lua-скриптах, рукопожатие rueidis):

| Команды | Зачем |
|---|---|
| `ping`, `info` | старт: связь и версия (`INFO server`, ADR-0017); `/readyz`; keepalive клиента |
| `client\|tracking`, `client\|caching`, `multi`, `exec`, `pttl` | client-side caching RESP3 (`DoCache`: отзыв сессии и токен бота на каждом запросе): `CLIENT TRACKING ON OPTIN` при подключении, на промах — `CLIENT CACHING YES`, `MULTI`, `PTTL`, `GET`, `EXEC` |
| `client\|setinfo` | имя и версия библиотеки при подключении: ошибку клиент пропускает, но без права каждое подключение оставляет запись в `ACL LOG` |
| `cluster\|shards`, `cluster\|slots` | при подключении клиент проверяет, не кластер ли это (`CLUSTER SHARDS` на сервере версии ≥ 8, иначе `CLUSTER SLOTS`): одиночный сервер отвечает ошибкой, и клиент работает в обычном режиме. Без права исход тот же, но через `NOPERM` и с записью в `ACL LOG` на каждое подключение |
| строки, хэши (`hexpire` — TTL поля сессии в presence), множества, sorted sets, списки | presence, voice, звонки 1:1, буфер и lease gateway, маркеры отзыва, лимиты, кэш превью ссылок, локи воркеров |
| `eval`, `evalsha` | Lua-скрипты (token bucket, локи, привязка устройства, лимит стримов, переходы звонка): `EVALSHA`, при `NOSCRIPT` — `EVAL`; `SCRIPT LOAD` не используется. Ключи скрипты получают только через `KEYS` |
| `pexpire`, `hmget`, `hexists`, `zscore`, `zcard`, `zremrangebyscore`, `time` | вызываются только внутри Lua-скриптов — ACL проверяет и их |
| `publish`, `subscribe`, `unsubscribe`, `psubscribe`, `punsubscribe` | события gateway, отзыв сессий, управление между инстансами, сброс кэша тарифов |

`HELLO` и `AUTH` в ACL не нужны (разрешены всегда). `db=0` появился в Valkey 9.1: на Valkey 9.0 и Redis его убрать — там базы ACL не разделяет, изоляция только по ключам и каналам. База не 0 — `db=<номер>` и `+select`.

Проверено на Valkey 9.1.2 (2026-09-28): сервер под этим пользователем как есть (`db=0`) стартует, регистрирует, пускает в gateway, доставляет события и закрывает сокет отозванной сессии, в `ACL LOG` ни одного отказа; интеграционные тесты `internal/app` и `internal/rtc` с `TEST_REDIS_KEY_PREFIX=calab:` проходят под ним же плюс права самой тестовой обвязки (`FLUSHDB`, `CLIENT LIST`, `SELECT`, `SCAN`, `HGET`, ключи аренды баз `calaba:it:db:*`), единственный отказ — намеренная публикация теста вне пространства имён.

### Веб-клиент на `<домен>` (ADR-0015)

- Маршруты Caddy на каждом `<домен>` (приложение живёт на самом домене, без префикса `app.`): `/metrics` → 404; `/api/*`, `/gateway`, `/healthz`, `/readyz` → `reverse_proxy 127.0.0.1:3000`; остальное — SPA-статика из `/srv/web` (`file_server`, `try_files {path} /index.html`).
- Статика: на хосте `/opt/calaba/web` (bind mount `../../web:/srv/web:ro` в caddy). `sync.sh`: если локально есть `apps/desktop/dist-web/index.html` — `rsync --delete-after --delay-updates` в `/opt/calaba/web` (новые ассеты появляются раньше нового `index.html`, старые удаляются после); иначе при пустом каталоге кладёт заглушку `infra/docker/web-placeholder/index.html` («Calaba web — скоро»). Основной `rsync` репо каталог `/web/` не трогает. Caddy при обновлении статики не перезапускается.
- Кэш: `/assets/*` (хэшированные файлы Vite) — `public, max-age=31536000, immutable` только если файл существует (отсутствующий ассет — 404 без долгого кэша, не `index.html`); всё остальное (`index.html`, SPA-маршруты) — `no-cache`.
- Заголовки на статике: `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' wss://rtc.<каждый домен> https://rtc.<каждый домен>; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-src https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` (`'wasm-unsafe-eval'` — RNNoise WASM в mic-worklet; `frame-src` — iframe веб-приложения пространства, ADR-0050 §6; список rtc-origin-ов собирает `entrypoint.sh` из всех доменов — клиент на `.ru` ходит в `rtc.<DOMAIN>`, т.к. API отдаёт основной `LIVEKIT_URL`; `https://rtc.*` — для `/rtc/validate` livekit-client), `Permissions-Policy: microphone=(self), display-capture=(self), speaker-selection=(self), autoplay=(self)` (Chrome пишет в консоль безвредное предупреждение `Unrecognized feature: 'speaker-selection'` — фича есть только в Firefox), `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, без `Server`. CSP подтверждена клиентом; прогон 2026-09-25 в Chromium и Firefox — нарушений нет.
- Сжатие: `encode zstd gzip` только на статике (ответы API, в т.ч. файлы с Range, не трогаются). JS ~1.3 MB → ~0.4 MB; mic-worklet (RNNoise WASM внутри) ~1.9 MB → ~1.7 MB.
- `sync.sh` не публикует `*.map`.
- API разрешает браузерные origin-ы из `PUBLIC_APP_URLS` (список через запятую) плюс `PUBLIC_APP_URL` и `PUBLIC_APP_URL_ALT` (cookie-refresh, CSRF-проверка, upgrade gateway). `DOMAIN_LEGACY` в этот список **не входит** — веб-клиент по legacy-именам работать не будет (десктоп — будет).
- Манифест PWA: `*.webmanifest` отдаётся как `application/manifest+json` (в MIME-таблице Go его нет — Caddy ставит заголовок явно), `*.svg` — `image/svg+xml`.
- Публикация статики без перезапуска: `infra/docker/sync.sh` (если `apps/desktop/dist-web` есть локально). Флаг `SKIP_WEB=1` — не трогать опубликованную статику (например, пока сборка не готова).

### Релизы десктопа: `/download/` (фид electron-updater)

- `https://<домен>/download/` → статика из `/opt/calaba/releases` (bind mount `../../releases:/srv/releases:ro` в caddy), листинг каталога (`file_server browse`) включён только здесь; `/download` → 308 на `/download/`. Это же — фид electron-updater старых сборок (generic provider, `url: https://<app host>/download/`; с `RELEASES_HOST` — 302 туда).
- Кэш: `latest*.yml`, `*.yaml`, `*.json` и листинги — `no-cache` (меняются на месте); установщики и `*.blockmap` (версия в имени) — `public, max-age=31536000, immutable`. Типы: `*.yml` — `text/yaml`, `*.dmg/*.AppImage/*.deb/*.exe/*.blockmap` — `application/octet-stream` (в MIME-таблице Go их нет), `*.zip` — `application/zip`. Range (206) работает — докачка и differential-обновления. Сжатие здесь выключено.
- Публикация: `sync.sh` — если локально есть `apps/desktop/dist-release/`, копирует `*.dmg *.zip *.AppImage *.deb *.exe *.blockmap latest*.yml *.json` в `/opt/calaba/releases` **без `--delete`** (старые версии остаются доступными) и с `--delay-updates` (`latest*.yml` появляется вместе с установщиками, updater не увидит ссылку на ещё не залитый файл). `SKIP_RELEASES=1` — пропустить. Основной `rsync` репо каталог `/releases/` не трогает. Удалять старые версии — вручную на хосте.
- Имена файлов с версией обязательны (immutable-кэш): перезалить тот же файл с тем же именем нельзя — только новая версия.
- Клиент: кроме фоновой автозагрузки, «О программе» → «Скачать и установить X» качает то же обновление по запросу (IPC `app:download-update`; только фид сборки и платформа, где установка возможна — иначе «Скачать» открывает страницу загрузки), затем «Перезапустить и обновить» (`quitAndInstall` после ожидания refresh, docs/09 #89/#93).
- Проверки и ожидаемые выводы — `TESTING.md`, раздел «Стенд».

### Релизы десктопа: сборка

Все три ОС собираются с одного Mac (Apple Silicon): `apps/desktop/scripts/build-release.sh [mac] [linux] [win]` (без аргументов — все). На Apple Silicon Linux/Windows собираются на x86_64-хосте: `BUILD_DOCKER_HOST=ssh://root@141.105.69.177` (стенд, согласовано; без эмуляции, в разы быстрее и не забивает диск мака образом 4.7 GB).

- **Источник** — чистый `git archive` коммита `SRC_REF` (по умолчанию `HEAD`) во временном каталоге (`WORK_DIR`, по умолчанию `$TMPDIR/calaba-release`): незакоммиченные правки в релиз не попадают, рабочее дерево и `node_modules` разработчика не трогаются. Требование: коммит должен ставиться `pnpm install --frozen-lockfile` (lockfile в синхроне с `package.json`). Версия — из `apps/desktop/package.json`; `VERSION=1.2.3` переопределяет её только в экспорте (`npm version --no-git-tag-version`).
- **Нативный `uiohook-napi`** — только наша пропатченная сборка (`patches/uiohook-napi@1.5.5.patch`): `electron-builder.yml` исключает upstream-prebuilds и включает `buildDependenciesFromSource`. Скрипт проверяет, что патч применён, и **валит сборку, если в пакете нет `.node`** (`ptt.ts` импортирует модуль статически — без него main падает при старте).
- **macOS** — нативно, `electron-builder --mac`: отдельные **arm64 и x64** (dmg + zip; так задано в `electron-builder.yml`, фид отдаёт подходящий). Модуль компилируется из исходников под каждую арх (x64 — кросс-компиляцией на Apple Silicon); скрипт проверяет `lipo -archs` каждого `Calaba.app` (arm64 / x86_64). Требуется Xcode Command Line Tools.
- **Linux (AppImage + deb, x64)** — в Docker `electronuserland/builder:wine` (Ubuntu 22.04, Node 24; запинен по digest): исходники копируются в контейнер (без `node_modules`), `pnpm install --frozen-lockfile --ignore-scripts`, `electron-vite build`, установка X11-заголовков, `electron-builder --linux` с `npmRebuild` — `uiohook` компилируется под Electron в контейнере. Затем **smoke** в том же контейнере: AppImage распаковывается (squashfs по смещению из ELF), приложение стартует под Xvfb, проверка — процесс жив через 20 с и есть X-окно «Calaba» (`xwininfo`); `SMOKE=0` — пропустить.
- **Удалённый хост** (`BUILD_DOCKER_HOST`, для Windows-только — `WIN_DOCKER_HOST`): исходники, скрипт контейнера и env-файл уходят `rsync` в `/tmp/calaba-release-<pid>-<platform>`, контейнер запускается одной ssh-сессией (`docker run -i … bash -s < script`; `DOCKER_HOST=ssh://` открывает много сессий и упирается в `MaxStartups` sshd) с `--cpus 4 --memory 6g --cpu-shares 128 --blkio-weight 10` (`REMOTE_CPUS`/`REMOTE_MEMORY`), артефакты возвращаются, каталог удаляется; ssh/rsync — с повторами. Кэши — docker volumes `calaba-release-pnpm-store`, `calaba-release-electron-cache` на хосте сборки; образ остаётся для повторов.
- **Windows (NSIS, x64)** — только на x86_64-хосте (`BUILD_DOCKER_HOST`): на Apple Silicon NSIS под wine невозможен (стаб 32-битный, Rosetta в Docker — только x86_64, qemu-i386 падает). Нативный модуль: node-gyp не умеет собирать win32 вне Windows, поэтому **для Windows (решение 2026-09-26, вариант b) в пакет возвращается upstream N-API prebuild `prebuilds/win32-x64`** — наш патч меняет только darwin-код libuiohook (+ константа, используемая там же), на Windows модуль идентичен. Задано в `electron-builder.yml` как `win.files` FileSet (`[{from: ., filter: [prebuilds, prebuilds/win32-x64/**]}]`) — для node_modules electron-builder берёт из строковых `files` только исключения, включение возможно лишь FileSet-ом; для коммитов без этой настройки скрипт генерирует то же в `electron-builder.win.yml` (`extends: ./electron-builder.yml`) внутри копии исходников. Для macOS/Linux политика «только пропатченная сборка из исходников» не меняется. Проверка скрипта «в пакете есть `.node`» остаётся (в инсталляторе ровно `app.asar.unpacked/node_modules/uiohook-napi/prebuilds/win32-x64/uiohook-napi.node`).
- **CI: `.github/workflows/release.yml`** (репозиторий `github.com/itrcz/calab`, `RELEASE_REPO`; фид по умолчанию `https://releases.calab.io/`) — по тегу `v*` или вручную (`workflow_dispatch`, `version`, `publish_stand`): матрица macos-latest (arm64 + x64), ubuntu-22.04, windows-latest — везде нативно, поэтому пропатченный модуль компилируется из исходников и на Windows (MSVC раннера), без override. Артефакты → GitHub Release (`gh release create`, для ручного запуска — draft) и, если заданы секреты `STAND_SSH_KEY`/`STAND_HOST`/`STAND_KNOWN_HOSTS` (отдельный deploy-пользователь с правом записи только в `/opt/calaba/releases`, host key запинен), — `rsync --delay-updates` без `--delete` на `/download/`. Там же — место для подписи (stage 4). Actions запинены по SHA.
- **Результат** — `apps/desktop/dist-release/` (в `.gitignore`): `Calab-<ver>-arm64.dmg/.zip`, `Calab-<ver>-x64.dmg/.zip`, `Calab-<ver>-x86_64.AppImage`, `calab_<ver>_amd64.deb`, `Calab-Setup-<ver>-x64.exe` (продукт — Calab, docs/10; внутренние имена `calaba-*` остаются), `*.blockmap`, `latest-mac.yml`, `latest-linux.yml`, `latest.yml`. Имена без пробелов и с версией (`/download/` кэширует установщики как immutable). В `app-update.yml`/`latest*.yml` — generic-фид `UPDATE_URL` (по умолчанию `https://releases.calab.io/`).
- **Публикация** — `SKIP_WEB=1 infra/docker/sync.sh` (копирует `dist-release` в `/opt/calaba/releases`, без удаления старых версий). Перед публикацией поднять версию (`VERSION=`): electron-updater обновляет только на бо́льшую.
- **Замеры (2026-09-26, коммит 63524d5, v0.0.1):** macOS arm64+x64 — 48 с (прогретый кэш Electron); dmg 125/129 MB, zip 125/128 MB. Linux на стенде — 2 мин 15 с (с компиляцией uiohook и smoke); AppImage 122 MB, deb 97 MB. Windows на стенде — 55 с (с upstream prebuild win32-x64); NSIS 109 MB, не подписан. Нагрузка стенда во время сборок: load average 3.3 → 3.9–4.7 из 32 CPU, GPU-задача не затронута.

**Подписи нет** (сборки для тестов):
- macOS: `identity: null` → Gatekeeper: «приложение от неустановленного разработчика» — открыть через ПКМ → «Открыть» (или `xattr -dr com.apple.quarantine /Applications/Calaba.app`). Автообновление на macOS **без подписи не работает** (Squirrel.Mac проверяет подпись) — клиент только сообщает о новой версии. Нужно от владельца: **Apple Developer Program** (99 $/год) → сертификат *Developer ID Application* (.p12 → `CSC_LINK`, `CSC_KEY_PASSWORD`) и нотаризация (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` или App Store Connect API key); в `electron-builder.yml` убрать `identity: null`, включить `notarize`. Hardened runtime и entitlements уже настроены.
- Windows: без подписи SmartScreen «Windows защитила ваш компьютер» → «Подробнее» → «Выполнить в любом случае»; репутация копится только у подписанных сборок. Нужно: сертификат подписи кода (OV/EV; с 2023 ключ только на токене/HSM — практичнее облачная подпись: Azure Trusted Signing, SSL.com eSigner, DigiCert KeyLocker) → `win.azureSignOptions`/`signtoolOptions` в `electron-builder.yml`, секреты в env. Облачную подпись удобно делать в том же Windows-раннере CI.
- Linux: подпись не нужна (AppImage/deb без подписи — норма; при желании GPG-подпись .deb/репозитория).

### Релизы: GitHub Actions → S3 → releases.calab.io

Основной путь выпуска (решение владельца 2026-09-26): сборка в GitHub Actions на нативных раннерах, хранение в S3-совместимом бакете, фид автообновления `https://releases.calab.io/` (сборки до 2.0.0 — `https://releases.calab.ru/`, тот же бакет; «Домены: calab.io…»). `build-release.sh`/`release.sh` с Mac остаются запасным путём и для проверок стенда.

**Выпуск:** `git tag v0.1.0 && git push origin v0.1.0` → `.github/workflows/release.yml`:
1. `build` — матрица macos-latest (arm64 + x64), ubuntu-22.04 (AppImage + deb), windows-latest (NSIS); пропатченный `uiohook` компилируется из исходников везде; проверка «в пакете есть `.node`».
2. `github-release` — GitHub Release `v0.1.0` со всеми файлами (`gh release create`, репозиторий `itrcz/calab`).
3. `publish-s3` — в бакет: `releases/<version>/` ← установщики и `*.blockmap` (`Cache-Control: public, max-age=31536000, immutable`); затем **последними** в корень — `latest-mac.yml`, `latest-linux.yml`, `latest.yml` (их `url:`/`path:` переписаны на `releases/<version>/…`, `sha512` не меняется) и `index.html` со ссылками (`no-cache`). Клиент никогда не увидит фид, ссылающийся на ещё не залитый файл. Затем (только стабильные версии, без `-rc…`) — **`latest/`**: server-side copy (`aws s3 cp s3://…/releases/<ver>/… s3://…/latest/…`, без повторной загрузки) под стабильными именами `Calab-mac-arm64.dmg`, `Calab-mac-x64.dmg`, `Calab-win-x64.exe`, `Calab-linux-x86_64.AppImage`, `calab-linux-amd64.deb` (`no-cache`, `Content-Disposition` с версионным именем) и последним `latest/VERSION` с номером. Фиды `latest*.yml` это не трогает.
4. `publish-stand` — запасной: только если S3-секретов нет — `rsync` на стенд в `/opt/calaba/releases` (плоско, как раньше). Если нет ни тех, ни других — сборка есть в GitHub Release, публикации нет (warning).
Ручной запуск (`workflow_dispatch`): `version`, `publish` (по умолчанию нет); Release создаётся черновиком.

**Подпись — только с валидным материалом.** Шаг `signing setup` декодирует base64 и проверяет: `.p12` открывается своим паролем (`openssl pkcs12 -passin`, с `-legacy`-фолбэком), `.p8` — валидный приватный ключ (`openssl pkey`). Отсутствует / заглушка / неверный пароль → сборка **без подписи** с notice, не падение (проверено на 6 сценариях: заглушка, валидный + нотаризация, валидный без .p8, неверный пароль, Windows валидный/неверный).
- macOS: `APPLE_CERT_P12_BASE64` + `APPLE_CERT_PASSWORD` → CI удаляет `identity: null` из `electron-builder.yml` в своей копии и подписывает (Developer ID Application: SCRIPTHEADS, TOO, Team `3KGZ3829US`); `APPLE_TEAM_ID` передаётся в окружение (notarytool); нотаризация (`-c.mac.notarize=true`) — только если валидны `APPLE_API_KEY_BASE64` + `APPLE_API_KEY_ID` + **`APPLE_API_ISSUER`** (Issuer ID пока нет → подпись без нотаризации, warning; Gatekeeper на других машинах такую сборку всё равно не пропустит без «Открыть» — нужна нотаризация).
- Локальная проверка подписи: `SIGN=1 MAC_ARCH=arm64 SRC_REF=WORKTREE build-release.sh mac` — берёт identity из login keychain (или `cert/developerID_full.p12` + `APPLE_CERT_PASSWORD` из `.env`), без нотаризации и по умолчанию без secure timestamp (`SIGN_TIMESTAMP=1` — с ним; из-за локального VPN сервер меток времени Apple периодически не отвечает на сотни запросов подряд, а один промах валит codesign). Временный keychain electron-builder (путь `CSC_LINK`) на свежей macOS не работает (`security set-key-partition-list … SecKeychainUnlock`), поэтому локально — identity из login keychain.
- Windows: `WIN_CERT_P12_BASE64` + `WIN_CERT_PASSWORD` → signtool на windows-раннере.
Материал передаётся в electron-builder файлами из `RUNNER_TEMP` через `GITHUB_ENV` (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY*`).

**Фид `releases.calab.io` (Caddy):** хост `RELEASES_HOST` (по умолчанию `releases.<DOMAIN>`; пусто — выключен) и `RELEASES_HOST_ALIASES` (тот же фид, напр. `releases.calab.ru`). Если задан `S3_PUBLIC_URL` — публичный базовый URL бакета (Yandex Object Storage path-style `https://storage.yandexcloud.net/<bucket>` или virtual-hosted без пути) — `reverse_proxy` в него (`Host` апстрима, префикс пути из URL), `/` → `index.html` (при заданном `LANDING_HOST` — редирект на лендинг, см. ниже); `*.yml` и `index.html` — `no-cache`, остальное — `immutable` (заголовки ставит Caddy поверх ответа S3). Без S3 — раздаёт `/srv/releases` (то же, что `/download/`). При заданном `RELEASES_HOST` `/download/*` на приложении и лендинге — **302 на тот же путь** хоста релизов: старые клиенты с фидом `<сервер>/download/` продолжают обновляться (electron-updater разрешает `releases/<ver>/…` относительно своего фида и идёт по редиректу). Исключения из «тот же путь» (`/tmp/download.caddy`, генерирует `entrypoint.sh`): `/download/mac-arm64|mac-x64|win|linux|deb` → 302 на `https://<RELEASES_HOST>/latest/<файл>`; `/download/` (и `/download` через 308) — по `User-Agent`: `Macintosh` → mac-arm64, `Windows` → win, `Linux`/`X11` (кроме Android/ChromeOS) → AppImage, иначе → `https://<LANDING_HOST>/#download`. На самом хосте релизов корень, листинги (`*/`) и `/index.html` → 302 на `https://<LANDING_HOST>/#download` (если лендинг задан); `latest/*` — `no-cache` и `Access-Control-Allow-Origin: *` (лендинг читает `latest/VERSION`; его CSP `connect-src` включает `RELEASES_HOST`). Лендинг ссылается прямо на `latest/<файл>` и сам выбирает ОС в браузере. Без `RELEASES_HOST` (локальный `/srv/releases`) коротких путей нет. DNS: `releases.calab.ru` A → 141.105.69.177 (Cloudflare, DNS-only) — заведён вместе с зоной; `releases.calab.io` — CNAME на него (2026-10-02). На стенде до переключения на calab.ru `RELEASES_HOST=` (пусто, `/download/` локально).

**Что нужно от владельца** (в корневой `.env` репо — не коммитится; имена ключей — как у владельца):
| Ключ | Что |
|---|---|
| `S3_ENDPOINT`, `S3_REGION` (по умолчанию `ru-central1`), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Yandex Object Storage: бакет и ключ сервисного аккаунта **с правом записи в этот бакет** (сейчас — AccessDenied, выясняет лид); бакет — **публичное чтение** объектов |
| `S3_PUBLIC_URL` | публичный базовый URL бакета — для Caddy на стенде (`infra/docker/.env`), в GitHub не нужен |
| `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD` | Developer ID Application (.p12, base64) — Apple Developer Program |
| `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | ключ App Store Connect API (.p8, base64) для нотаризации |
| `WIN_CERT_P12_BASE64`, `WIN_CERT_PASSWORD` | сертификат подписи кода Windows (.pfx/.p12, base64) |
| `GITHUB_TOKEN` | только для авторизации `gh` в `set-secrets.sh`; в секреты **не** кладётся |
| `STAND_SSH_KEY`, `STAND_HOST`, `STAND_KNOWN_HOSTS` | (необязательно) запасная публикация на стенд — отдельный deploy-пользователь |
На стенд (`infra/docker/.env`): `RELEASES_HOST=releases.calab.io`, `RELEASES_HOST_ALIASES=releases.calab.ru`, `S3_PUBLIC_URL=…` → `sync.sh caddy`.

**Секреты в GitHub:** `infra/ci/set-secrets.sh [--dry-run] [.env]` — читает `.env` без `source` (никакого выполнения), берёт только ключи из таблицы (прочее, напр. `CFTOKEN`, игнорирует), ставит через `gh secret set --repo itrcz/calab`; авторизация — `GITHUB_TOKEN` из `.env`/окружения (как `GH_TOKEN`) или `gh auth login`. Для base64-сертификатов сообщает `valid`/`INVALID (…)` (та же проверка, что в workflow), значения не печатает; `--dry-run` — только имена, длины и валидность. Секреты передаются в `gh secret set` через stdin (флаг `--body -` сохранил бы буквальный «-» — так было до исправления, из-за чего rc.4/rc.5 собрались без подписи). На 2026-09-26 поставлены S3 (5) и Apple (6, включая `APPLE_TEAM_ID`); Windows — без сертификата, собирается неподписанным.

### Релиз 2.0.0: текущий порядок

Выпущено 2026-10-02 с PR #52 + исправлениями ревью (`34c2270a`): первое ревью (4 направления) и второе
независимое security-ревью исправлений — без blocker/major; CI на PostgreSQL 17 зелёный. Порядок ниже
сохраняется для следующих identity-релизов.

1. На конечном SHA: scope/ADR сверены, нет blocker/major, генерация без drift,
   обязательные CI checks и целевые PG17 проверки зелёные, один полный server
   integration прогон и два независимых review подтверждены на этом SHA.
   Исторические результаты и skipped тесты не заменяют эти evidence.
2. Оператор закрывает [preflight](plans/identity-v2-operator-preflight.md): источник
   platform manifests, полный keyring/config, DB+key backup, cluster Caddy port/pins,
   все front-proxy/logging gates и identity-aware fallback. Это отдельная доставка
   конфигурации, не действие `images.yml`. Изменения production — только в
   разрешённое лидом окно. Начальный режим workspace — off.
3. Назначенный релизный агент проверяет диск, CHANGELOG **этого commit** и usage
   evidence; затем только по поручению лида публикует тег `v2.0.0` с этим SHA.
   Версии инжектируются из тега/`VERSION` при сборке, package versions в исходниках
   для этой подготовки не поднимаются. Дождаться зелёного CI тега до image rollout.
4. `release.yml` собирает установщики/черновик Release и update feeds;
   `images.yml` создаёт `calab-prod` с API/web digests после зелёного tag CI.
   Проверить фактические rollout/readiness обоих компонентов и `/api/version`,
   а не только факт создания Deployment. Не запускать поверх этого SSH `deploy`.
5. Проверить smoke API/web, identity routing, synthetic log sentinels, pilot
   SSO/consent/revoke/recovery, установщики и checksums, версии трёх `latest*.yml`,
   опубликованный GitHub Release с CHANGELOG того же SHA. Optional pilot разрешён
   после этих gates; enforced — после проверки recovery и живого целевого IdP.
6. Завершить выпуск анонсом через существующего бота по точной версии:
   `tools/release-announce.py 2.0.0` из релизного commit либо отдельным
   `STEPS=announce VERSION=2.0.0 infra/docker/release.sh <release-commit>`.
   `nonce=release-2.0.0` делает повтор идемпотентным; записать posted/updated/unchanged,
   message id и по возможности прочитать сообщение обратно. Skipped, отсутствие
   токена/прав или непроверенная доставка — незавершённый анонс, не успех релиза.
   Обычный выпуск не использует `--all`/`--purge`.

Эта подготовка не создаёт тег, Release, Deployment или сообщение бота. Команды
ниже описывают действия будущего авторизованного релизного агента.

### Исторический compose/SSH runbook (v0.1.0, отдельная установка)

Одна команда на один коммит (`infra/docker/release.sh`); запуск — по решению лида, с указанием коммита и **отдельного compose-окружения**. Этот путь выкатывает API/веб/лендинг с Mac на стенд и не управляет текущим production-кластером. Полный запуск нельзя использовать для текущего 2.0 production: он создаёт неконтролируемый второй деплой. Установщики публикует GitHub Actions → S3 → `https://releases.calab.io/`; для кластерного релиза из `release.sh` допустим отдельно порученный шаг публикации/анонса, без SSH deploy.

```sh
VERSION=0.1.0 infra/docker/release.sh <commit>          # preflight → web → deploy → (verify ∥ desktop) → announce
RELEASE_SERIAL=1 VERSION=0.1.0 infra/docker/release.sh <commit>   # прежний порядок: verify, потом тег
infra/docker/release.sh verify <commit>                  # только пост-проверки того, что задеплоено
STEPS="deploy verify" VERSION=0.1.0 infra/docker/release.sh <commit>   # часть шагов
STEPS="preflight build" VERSION=0.1.0 infra/docker/release.sh <commit> # локальная сборка всех ОС для проверки (не публикуется)
```

| Шаг | Что делает | Стоп-условие |
|---|---|---|
| preflight | тег `v$VERSION` свободен локально и в `origin`; в коммите есть `release.yml`; `gh` видит `itrcz/calab` (`GITHUB_TOKEN` из `.env` как `GH_TOKEN`); `pnpm install --frozen-lockfile --lockfile-only` на экспорте коммита; ≥ 5 GB свободно локально (≥ 15 GB с шагом `build`); стенд доступен; снимок чужой GPU-задачи; **бэкап до** | любое — выход |
| build | *(не по умолчанию)* `build-release.sh mac linux win` с `SIGN=1 NOTARIZE=1`, `SRC_REF=<commit>`, Linux/Windows на стенде → `$WORK_DIR/dist-release`; только для проверки, не публикуется | ошибка сборки |
| web | чистый экспорт коммита (`git archive` + `pnpm install --frozen-lockfile`, переиспользуется от `build`) → `build:web` → `dist-web`; при `LANDING_HOST` — `pnpm -F @calaba/landing build` → `apps/landing/out` | нет `index.html` |
| deploy | `sync.sh` с `SYNC_REF=<commit>`, `VERSION`, `WEB_DIST` и `LANDING_DIST` из этого экспорта (лендинг — всегда из релизного коммита, не из рабочей копии), `SKIP_RELEASES=1`: весь стек (api с build info; неизменённые сервисы не трогаются), веб, лендинг | ошибка деплоя |
| verify | все HTTP-проверки и e2e — напрямую на IP стенда (`curl --resolve`, принудительный DNS в браузере); smoke на `app.calab.io`, `meet.gptunnel.ru` и `LEGACY_APP_HOST` (`app.calab.ru`): `/healthz`, `/api/version` = `$VERSION/<commit>`, TLS (curl проверяет цепочку и имя, срок — из сертификата); лендинг — 200; `/download/latest.yml` на приложении, алиасе и лендинге — 302 на `https://releases.calab.io/latest.yml`; `rtc.` — 200, `/readyz` изнутри; `e2e:web` **только на `app.calab.io` и только Chromium** (Firefox и алиас — в nightly), аккаунт `e2e-app@calaba.test`, пространства `Web …` удаляются; сценарий перемещения M.1 (`move.web.spec.ts`, если есть в коммите; второй аккаунт `e2e-app2@calaba.test`; спек переиспользует «E2E web»); спеки и конфиг — из экспорта релизного коммита, не из рабочей копии; аккаунты создаются один раз по инвайту владельца, пароли — только в `.env.accounts`; relay-check tls/udp/any с токеном join из API + публикатор `lk load-test`; нет ERROR в api и «failed to send webhook» в LiveKit; чужая GPU-задача та же; **бэкап после** | считаются провалы |
| desktop | только если провалов нет: `git tag -a v$VERSION <commit>` и `git push origin v$VERSION` → ждёт прогон `release.yml` этого тега (опрос раз в 20 с, ~8 мин; нотаризация mac бывает до 60 мин). **По умолчанию тег пушится сразу после deploy, verify (~3 мин) идёт, пока собирается `release.yml`**: цепочка короче на время verify. Провал verify после тега — громкое сообщение; прогон `release.yml` отменяется, если `publish-s3` ещё не начался (иначе сказано, что фид уже может отдавать версию), GitHub Release остаётся черновиком, анонса нет; тег остаётся (следующая версия или `git push origin :refs/tags/v$VERSION`). `RELEASE_SERIAL=1` — прежний порядок; затем фид на `releases.calab.io` (через IP стенда; `latest*.yml` — только относительные URL и байт-в-байт как на `LEGACY_RELEASES_HOST` = `releases.calab.ru`): `latest-mac/linux.yml`, `latest.yml` с `version: $VERSION`, каждый файл из них — 200 и размер из yml (≥ 5 файлов), `sha512` пересчитан **на стенде** (скачивает с `releases.calab.ru`); затем публикует GitHub Release токеном владельца: `release.yml` оставляет его черновиком (токен Actions получает 403 при публикации релиза тега, коммит которого меняет `.github/workflows`, — v0.1.0), тело — секция версии из `CHANGELOG.md`; если черновика нет — создаёт релиз из артефактов прогона; проверка: опубликован (не draft) | считаются провалы |
| announce | только если провалов нет и задан `CALAB_RELEASE_BOT_TOKEN` (иначе «announce: skipped»): бот публикует секцию версии из `CHANGELOG.md` релизного коммита в комнату «Calab - что нового? ✨» — `tools/release-announce.py` | ошибка HTTP — провал |

**Анонс релиза.** `tools/release-announce.py <версия> [--dry-run]` (python3, только stdlib) берёт секцию `## [<версия>]` из `CHANGELOG.md`. **Если в секции есть блок `### Коротко` (3–7 однострочных пунктов простым языком, без ADR/env/миграций; с 2.0 его пишет агент подготовки релиза), публикуется только он:** «🚀 **Calab <версия>** — <дата>», пункты «• …», «Обновление придёт само», без ссылок (владелец, 03.10) (цель ≤ ~800 символов; «Коротко» длиннее 4000 — ошибка, а не обрезка). «Коротко» никогда не входит в полный рендер. Без блока (старые версии, `--all`) — прежнее поведение: сообщение в markdown-lite чата: «🚀 **Calab <версия>** — <дата>», разделы «Добавлено» ✨, «Изменено» 🔧, «Исправлено» 🐞 строками «• …», пустая строка до и после каждого заголовка раздела и перед финальной строкой (ссылки вида `(#82)`/`(ADR-…)` и хвосты «Миграция NNNNN» убираются, раздел «Обновление» не публикуется), в конце — «Обновление придёт само»; длиннее 4000 символов — целые пункты отбрасываются с конца, «…и ещё пунктов: N — полный список в CHANGELOG.md». Комнату ищет по точному имени (`CALAB_RELEASE_ROOM`) среди пространств бота через Bot API (docs/19); не видит — просит админа добавить бота в пространство и дать `VIEW_ROOM` + `SEND_MESSAGES`. `nonce = release-<версия>`: повторный запуск не создаёт дубль (сервер дедуплицирует по автору и nonce и возвращает прежний пост), а правит его (`PATCH /api/messages/{id}`) до текущего шаблона — в логе «posted» / «updated» / «unchanged»; nonce удалённого поста занят навсегда (409), поэтому берётся следующий `release-<версия>-r2`, … `--all` публикует все выпущенные версии из CHANGELOG (без `[Unreleased]`), от старой к новой, раз в ~1 с (лимит сообщений 1/с). `--purge --yes` перед этим удаляет все сообщения комнаты: свои — всегда, чужие — если у бота `MANAGE_MESSAGES`, иначе печатает id/дату/первую строку для ручного удаления; без `--yes` не запускается, шаг `announce` в release.sh публикует только свою версию и никогда не чистит. `--env-file <путь>` читает `CALAB_*` из dotenv, не печатая значений. Токен — `CALAB_RELEASE_BOT_TOKEN` в корневом `.env` (release.sh читает его сам, не печатает); `CALAB_API_URL` — по умолчанию `https://$APP_HOST`. Руками: `STEPS=announce VERSION=<версия> infra/docker/release.sh <commit>`.

Логи e2e/relay/публикатора/Actions — рядом с `WORK_DIR` (`$TMPDIR/calaba-release-<ver>.*`). Секреты читаются по ssh в переменные и не печатаются. Нужны локально: `pnpm`, `gh`, `lk` (livekit-cli), Playwright-браузеры (`pnpm -F @calaba/desktop exec playwright install chromium firefox`); для `build` — Xcode CLT и сертификаты из `cert/`.

### Смена / добавление домена

1. A-записи `<домен>`, `rtc.<домен>`, `turn.<домен>` → 141.105.69.177, в Cloudflare — **DNS-only** (AAAA не заводить, пока нет IPv6 на хосте и правил для него). Проверить с машины без VPN (или DoH: `curl -s -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=turn.<домен>&type=A'`): VPN с fake-IP DNS и кэшем NXDOMAIN (SOA min 1800 с в зонах Cloudflare) может «не видеть» свежие записи до 30 мин.
2. На хосте в `/opt/calaba/infra/docker/.env`: `DOMAIN=<основной>`, `DOMAIN_ALT=<запасной или пусто>`; на время переезда старый основной — в `DOMAIN_LEGACY`, чтобы старые клиенты не оборвались.
3. `infra/docker/sync.sh` (или на хосте `deploy.sh`): Caddy пересоздаётся с новыми списками хостов и выпускает сертификаты; `livekit.gen.yaml` перерендерится (`turn.domain`) → LiveKit перезапустится сам (короткий обрыв медиа); API получит новые `PUBLIC_APP_URL`/`PUBLIC_APP_URL_ALT`/`LIVEKIT_URL`.
4. Клиентам — новый адрес сервера. Когда старые клиенты переехали — убрать `DOMAIN_LEGACY`, `sync.sh caddy`. Старые сертификаты в volume просто истекут.
5. Лимиты Let's Encrypt. Если упрёмся: задать `email` в глобальном блоке Caddyfile — тогда Caddy при неудаче LE автоматически пробует ZeroSSL (без email фолбэк на ZeroSSL не работает); либо явно `acme_ca`/`issuer zerossl`.

Домены стенда — см. «Стенд: как он поднят» и docs/10-branding.md.

### Домены: `calab.io` — основной, `calab.ru` — вечный алиас (с 2.0.0)

Решение владельца 2026-10-02: основной домен — `calab.io` (`calab.io`, `app.`, `releases.`, `rtc.`, `turn.calab.io`; почта `noreply@calab.io`). Каждый хост `.ru` продолжает работать как алиас — **без срока**: в установленных клиентах он зашит или сохранён.

| Хост `.ru` | Почему нельзя выключать | Как обслуживается |
|---|---|---|
| `app.calab.ru` | сохранённый сервер десктопа до 2.0.0 и веб-сессии; cookies и сессии привязаны к origin | тот же API/веб (`PUBLIC_APP_URLS` содержит оба origin) |
| `releases.calab.ru` | фид автообновления, зашитый в сборки до 2.0.0 | тот же бакет, **тот же контент, без редиректа** |
| `rtc.calab.ru`, `turn.calab.ru` | CSP сборок до 2.0.0 знает только `*.calab.ru` | тот же LiveKit |
| `calab.ru` | старые ссылки | 301 на `https://calab.io` тот же путь |

Правила:
1. **Сохранённый адрес сервера никогда не мигрируется автоматически** (выход из аккаунта). Новый адрес по умолчанию (`MAIN_VITE_DEFAULT_SERVER_URL=https://app.calab.io`) действует только при первом запуске; сессия из keychain восстанавливается на свой origin.
2. **CSP десктопа** (`apps/desktop/src/shared/csp.ts`): соседние хосты выводятся из сохранённого origin (`app.calab.ru` → `*.calab.ru`, `app.calab.io` → `*.calab.io`), никогда не до публичного суффикса; `MAIN_VITE_CSP_CONNECT` в `.env.production` перечисляет `rtc.`/`turn.` **обоих** семейств (тест `csp.test.ts` читает этот файл).
3. **`LIVEKIT_URL` остаётся `wss://rtc.calab.ru`**, пока есть десктоп-сборки старше 2.0.0: их CSP не пустит на `rtc.calab.io`. Сборки ≥ 2.0.0 пускают оба. Переключать на `rtc.calab.io` — только когда доля < 2.0.0 пренебрежима (решение владельца). В compose — `RTC_PUBLIC_HOST`.
4. **Фид:** новые сборки — `https://releases.calab.io/` (`release.yml` `UPDATE_URL`, `build-release.sh`), старые — `https://releases.calab.ru/`; оба проксируют один бакет. В `latest*.yml` — **только относительные** `url:`/`path:` (`releases/<ver>/…`): каждый клиент разрешает их от своего фида. `publish-s3` падает на абсолютном URL; `release.sh` (desktop) сверяет байты `latest*.yml` на обоих хостах.
5. **Preflight релиза:** первый джоб `release.yml` проверяет TLS/HTTP `UPDATE_URL`, `latest.yml` на обоих фидах, `APP_ORIGIN/api/version` и сайт; провал — сборка не начинается (тег не выпустит клиентов на мёртвый хост).
6. **`IDENTITY_PUBLIC_ORIGIN=https://app.calab.io`.** Identity в проде ещё не включён, поэтому issuer меняется сейчас; **после включения он не меняется никогда** (issuer в токенах и регистрациях у IdP). `app.calab.ru` — не алиас issuer.
7. **Веб-клиент:** `app.calab.ru` и `app.calab.io` — разные origin (разные сессии и localStorage); редиректа между ними нет.
8. **Почта:** `SMTP_FROM="Calab <noreply@calab.io>"`; SPF/DKIM/DMARC для `calab.io` (см. «Почта»).

Compose (стенд/self-host): `APP_HOST=app.calab.io`, `LANDING_HOST=calab.io`, `RELEASES_HOST=releases.calab.io`, `DOMAIN=calab.io`, `DOMAIN_LEGACY=app.calab.ru`, `DOMAIN_ALIASES=calab.ru` (rtc./turn.), `RTC_PUBLIC_HOST=rtc.calab.ru`, `LANDING_HOST_ALIASES=calab.ru` (301), `RELEASES_HOST_ALIASES=releases.calab.ru` (тот же фид). Кластер (конфигурация вне репо) — те же правила: сертификаты и vhost'ы на все `.io` и `.ru` имена, `PUBLIC_APP_URL=https://app.calab.io`, `PUBLIC_APP_URLS` с обоими origin, `LIVEKIT_URL=wss://rtc.calab.ru`.

## Dev локально (macOS)

`infra/docker/compose.dev.yml`: postgres, valkey, livekit (dev-режим: `--dev`, ключи `devkey/secret`, без TLS, UDP mux 7882, Valkey DB 1), egress (в сетевом пространстве livekit; файлы — `apps/server/data/recordings`, это `RECORDINGS_PATH` API по умолчанию). Образ egress ~1.5 ГБ: `docker compose -f infra/docker/compose.dev.yml up -d` без имён сервисов его скачает — если запись не нужна, поднимать `postgres valkey livekit mailpit`. API и Electron — на хосте через pnpm; файлы API в dev — `STORAGE_DRIVER=fs` с локальным каталогом (`infra/docker/data/` в `.gitignore`). LiveKit в Docker на macOS не имеет host-сети → для локальных тестов медиа между двумя машинами в LAN LiveKit лучше запускать бинарником (`brew install livekit`), в Docker — только для одного клиента на localhost.

## Прод: Kubernetes (с 2026-10-02)

Продакшен работает в Kubernetes на PostgreSQL 17 (решение владельца, 2026-10-02). Релизы идут так: тег `v*` → зелёный CI → `.github/workflows/images.yml` (образы API и веба) → GitHub Deployment `calab-prod` → кластер забирает заявку сам (подробнее ниже). Конфигурация кластера (манифесты, Vault, Caddy, ingress) живёт вне этого репозитория; известные факты — в [операторском preflight](plans/identity-v2-operator-preflight.md). Расположение манифестов, число реплик, схема бэкапов БД кластера, версия и топология LiveKit/TURN в проде: TODO владелец.

Docker compose в этом документе — тестовый стенд и вариант self-host; он остаётся на PostgreSQL 18 и не равен проду. Что давало бесшовный переход и остаётся в силе: всё через env, API stateless, `/healthz` `/readyz`, миграции при старте под `pg_advisory_lock` (безопасно для нескольких реплик), файлы и записи встреч — драйвер `s3` при нескольких репликах, gateway — pub/sub через Redis.

Не использовать: private/serverless кластеры (NAT ломает WebRTC), LB перед 7881.

### Образы API и веба, выкатка в прод (`.github/workflows/images.yml`)

После зелёного `ci` релизного тега `v*` workflow `images` собирает `apps/server/Dockerfile` на том же коммите
(версия сервера — тег, как у `release.sh`), рядом собирает веб-клиент и лендинг теми же командами, что
`release.sh`, в образ `infra/docker/web-image` (Caddy, его конфиг «за прокси» и статика) и пушит оба
образа в прод-реестр. Ключей в GitHub нет: OIDC-токен job'а меняется на короткий IAM-токен сервисного
аккаунта, которому разрешён только пуш в репозитории calab этого реестра. Затем workflow создаёт GitHub
Deployment `calab-prod` с digest обоих образов в payload: API и веб релиза выкатываются вместе.

- В кластер workflow не ходит. Выкатку делает кластер сам: забирает заявку, проверяет её и меняет образ по
  digest. Не раскаталось — возвращает прежний образ. Принимаются только заявки, созданные этим workflow
  для коммитов из `main`.
- История заявок — вкладка Deployments репо. По [операторскому preflight](plans/identity-v2-operator-preflight.md) текущий consumer не публикует GitHub deployment statuses, выкатывает компоненты последовательно и при ошибке может оставить смешанные версии. Требуются Kubernetes readiness и фактические digests API/web плюс version smoke; успешная заявка/CronJob сами по себе не подтверждают выкатку.
- Откат — только на согласованный identity-aware digest с совместимой БД, ключами и platform config. После активации identity нельзя перезапускать старый успешный `images`, если он возвращает pre-identity бинарник. Down guard миграции не защищает от image-only rollback.
- `YC_REGISTRY` и `YC_CI_SA_ID` — секреты репо: публичные логи их маскируют. Это не ключи, но внутренние id в
  открытых логах не нужны.
- Конфиг Caddy едет в образе веба: `Caddyfile.behind-proxy` (TLS снимает прокси перед ним, HTTP на
  `BEHIND_PROXY_PORT`, по умолчанию 8080; API — `API_UPSTREAM`; без `rtc.`/`turn.`) и общий с `Caddyfile` стенда
  `sites.caddy`. Правка `infra/docker/caddy/` попадает в прод с релизом; хосты и адреса — env кластера.
  `images` проверяет конфиг в собранном образе (`caddy validate` на тестовых хостах) до пуша.
- Прогоны идут строго по одному (`concurrency`), поэтому заявки создаются в порядке коммитов.

### Identity 2.0: настройка и приёмка

Контракт: [ADR-0054](adr/0054-workspace-identity.md), [Identity v1](plans/release-2.0-identity.md).
Фактическая инфраструктура и оставшиеся operator inputs:
[production preflight](plans/identity-v2-operator-preflight.md). Ревью пройдены (2.0.0); включение в проде —
отдельный шаг оператора: без `IDENTITY_*`/`OAUTH_*` identity выключена (`/api/*` identity-маршруты — 409 `CONFLICT` reason `IDENTITY_NOT_CONFIGURED`, клиент показывает «не настроено на сервере»; `/oidc/*` — 503 `server_error`), политика пространств
по умолчанию «Выключена» — пилот `optional`, `enforced` только после проверки recovery (ADR-0054).

#### Grants, тарифы и ключи

Доступ требует **положительного grant именно текущего workspace** для каждого
`corporate_sso`, `directory_sync`, `oauth_provider`. В cloud дополнительно нужен
действующий Business (`PLAN_ENTERPRISE`, SQL `enterprise`); в on-prem —
`IDENTITY_EDITION=enterprise` и точный UUID в `IDENTITY_ENTERPRISE_WORKSPACE_IDS`.
По умолчанию edition cloud, список пуст, features off. Free/Team, истёкший план
и custom без Business/Enterprise основания не дают доступ. Управление тарифом
не заменяет настройку зависимостей. OAuth provider на тех же тарифах — допущение
ADR-0054, не дополнительное подтверждение владельца. Downgrade блокирует выдачи,
не делает enforced необязательным; recovery и отзыв своего grant доступны.

| Env | Требование оператора |
| --- | --- |
| `IDENTITY_PUBLIC_ORIGIN` | Точный HTTPS origin без path/query/fragment или завершающего `/`. Для текущей платформы — `https://app.calab.io` (решение владельца 2026-10-02, до включения identity; после включения не меняется никогда); Host/forwarded headers и алиасы (`app.calab.ru`) issuer не меняют. |
| `IDENTITY_ENCRYPTION_KEYS` | JSON object `kid` → standard base64 ровно 32 независимых AES-256 bytes; шифрует upstream/LDAPS secrets и verifier с workspace/AAD. |
| `IDENTITY_ENCRYPTION_ACTIVE_KID` | Идентификатор ключа для новых ciphertext; остальные нужные decrypt keys сохраняются. |
| `OAUTH_SIGNING_KEYS` | JSON object `kid` → RSA PEM (2048–8192 bits, JSON-escaped newlines); private для подписи, public для prepublish/overlap. |
| `OAUTH_SIGNING_ACTIVE_KID` | Выбирает private RSA key; JWKS содержит только публичные части. |
| `IDENTITY_ENDPOINTS` | При необходимости JSON array `{url, approved_cidrs, private_cidrs, ca_pem, workspace_ids}`: исключение для точного полного HTTPS URL; обычные публичные IdP проходят защищённый transport без предварительного каталога всех URL. `workspace_ids` — точные UUID пространств, к connection которых исключение применяется (для остальных URL остаётся public-only). Запись с `private_cidrs` без `workspace_ids` допустима только при `IDENTITY_EDITION=enterprise` (on-prem); в cloud — отказ при старте. |
| `IDENTITY_DIRECTORY_HOSTS` | Для LDAPS обязательный JSON array `{host, networks, ca_pem, workspace_ids}`: exact lowercase hostname и непустой CIDR allowlist, доверенная CA при необходимости. `workspace_ids` — точные UUID пространств, которым разрешён этот хост (настройка и sync других отклоняются). Без `workspace_ids` хост открыт всем пространствам установки — только при `IDENTITY_EDITION=enterprise` (on-prem); в cloud — отказ при старте. Пример: `[{"host":"dc1.corp.example","networks":["10.20.0.0/16"],"workspace_ids":["<workspace uuid>"]}]`. |

Ключи предоставляет оператор, отдельно от `JWT_SECRET`; здесь нет secret values.
Никаких insecure TLS, proxy-env обходов, loopback/metadata целей в production или
редиректов upstream transport. Семь dependency env полностью отсутствуют → новый
бинарник в существующей установке запускается с identity routes, возвращающими 409 `IDENTITY_NOT_CONFIGURED` (`/oidc/*` — 503 `server_error`); частичная/невалидная
конфигурация запрещает startup. Network arrays можно оставить пустыми, когда
частные IdP/каталог не нужны, но origin и оба keyring с active kid нужны вместе.

В текущем кластере keyrings/active kids доставляются **строками** из полного
Vault KV v2 map `kv/app/calab` через `timenote/calab-env-sync` в `calab-env`.
Не добавлять Secret-only keys: reconciler удаляет отсутствующие в Vault значения.
JSON нельзя хранить вложенным Vault object: synchronizer превратит его в Python
dict string, которую Go не прочитает. Origin/edition/network config — из platform
источника `calab-api`; избегать одинаковых env names в ConfigMap/Secret.
ConfigMap-only правка не меняет env-sync checksum и требует отдельного rollout.
Stage полного config до нового identity-aware binary: эти две доставки не атомарны.
CronJob success не равен доставке: проверить API readiness обеих реплик, реальный
`env-sync/env-checksum`, approved digests и public kids, не печатая private keys.
Источник актуальных platform manifests всё ещё не установлен: проверенный remote
main кандидата `script-heads/cloud-infra` не содержит Calab/env-sync filename paths.

#### Upgrade, routing и logging gates

Перед rollout — protected DB backup вместе с restorable keyrings/Vault version и
проверка восстановления в отдельной БД. Миграция `00055` выполняется при старте
API под advisory lock; требуются evidence PG17 на конечном SHA. Старые
сессии становятся `local_account` без свежего `local_authenticated_at` и assurance:
для linking/admin нужен повторный независимый локальный вход/reauth. Старый клиент
не поддерживает scope/bootstrap/consent UX; обновить web/desktop до identity-пилота.

Платформа отдельно переносит provider `/oidc/workspaces/*` и
`/.well-known/oauth-authorization-server/oidc/workspaces/*` **до SPA fallback**, а
также no-store/no-referrer/frame-ancestors и безопасное логирование из infra change.
Cluster Caddy — stock 2.11.4, HTTP `:8080`, upstream `api:3000`; host-network
`caddy-l4` config не копируется туда целиком. Проверить rendering и обновить
`UPSTREAM_PINS` `timenote/calab-deploy` по repo Caddyfile/entrypoint на release SHA.
Pin check происходит после rollout и не откатывает уже запущенные образы.

В preflight front ingress Nginx логирует request/Referer, в том числе в error logs;
выключение access logs и правки Caddy этого не закрывают. До активации платформа
должна принять Calab-scoped error isolation и доказать защиту ранних parser errors,
upstream failures, LB/collectors на всех app aliases (варианты и ограничения — в
preflight). Тестировать только synthetic code/state/ticket/request/consent/path/
Referer sentinels. Gate пока открыт; текущему shared controller глобальные logging
settings здесь не меняются. После rollout проверить реальные digests обеих реплик
API/web: mixed versions и timeout rollback не являются успешной приёмкой.

#### SSO, каталог и bootstrap

1. Выдать нужные grants, оставить policy off; owner делает local reauth (≤5 минут).
   Зарегистрировать у IdP exact callback
   `https://app.calab.io/api/auth/sso/callback/<connection-id>` для текущей установки;
   для self-hosted — её доверенный origin. Connection задаёт issuer/client id,
   provider и secret для confidential подключения, затем явные link → test → activate текущих
   id/version. Test не выдаёт сессию, смена draft не активирует её автоматически.
2. Провести optional pilot web/native login и local step-up: `(connection,issuer,sub)`
   связан явно, равный email ничего не объединяет. `workspace_sso(A)` не открывает
   B, DM, заметки, global credentials/admin; local session сохраняется при step-up.
   Generic fixture evidence с Keycloak 26.4.7 — [отдельный RP run](plans/identity-v2-keycloak-evidence.md)
   на более раннем commit. Встроенные scopes `basic` + `profile` + `email` дают
   требуемый `auth_time`. `auth_time` обязателен для всех IdP, включая Entra: `max_age` и
   `prompt=login` идут в URL, который браузер может изменить, поэтому свежесть входа
   доказывает только подписанный `auth_time` (`iat` доказывает лишь живую сессию IdP).
   Entra v2 выдаёт его только как optional claim — в app registration: Token configuration
   → Add optional claim → ID → `auth_time`. Без него вход и тест connection отклоняются
   (клиент видит 403 «identity access denied»), причина — запись audit
   `auth_time_missing` (outcome `denied`) по этой connection.
   PKCE: если discovery перечисляет `code_challenge_methods_supported`, там обязан быть
   `S256`; AD FS обязан его перечислять; generic может не перечислять — S256 всё равно
   отправляется, а тест connection пишет в audit `connection_tested_pkce_unadvertised`.
   Live Entra/AD FS/Windows AD acceptance отсутствует. Entra требует exact
   tenant-specific issuer/tid, AD FS 2019+ — S256; целевой живой Microsoft стенд
   проверяется отдельно, а не объявляется passed. Link идёт в активную connection
   (в draft — только если активной нет или пользователь уже связан с активной), test —
   в последний draft.
3. Для LDAPS — read-only bind, `ldaps://host:636`, проверяемый сертификат/hostname,
   явная связь immutable AD `objectGUID` с существующим member. Allowed groups
   учитываются и транзитивно (вложенные группы, `LDAP_MATCHING_RULE_IN_CHAIN`
   1.2.840.113556.1.4.1941, вычисляет DC); JIT, group-to-role, SCIM/cloud connector
   отсутствуют. Continuation referrals (base DN в корне домена → DNS-партиции)
   игнорируются и не открываются. Если у хоста задан `ca_pem`, доверяется только этот CA
   (системный пул не используется). Disabled/missing в полном снимке или потеря allowed
   group закрывают managed доступ. Sync 5 минут, stale после 1 часа; неполный
   scan/ошибка сети не означает массовое удаление. Полный, но пустой снимок или резкое
   сокращение (> 20 % и ≥ 2 объектов либо связанных активных участников) помещается в
   карантин: прежнее состояние сохраняется, `last_error` объясняет причину; принять
   реальное крупное изменение — повторно сохранить настройки каталога (первый scan
   новой версии не проверяется). Disable/unlink каталога не снимает suspensions автоматически: нужен
   явный audited detach после проверки, затем новый вход; old grants не оживают.
4. Проверить recovery kit (10 codes, показаны один раз, срок 365 дней), сохранить
   у независимого владельца; перед enforced нужны его свежие local и SSO proofs
   (≤5 минут), проверенная активная connection и действующий kit. Проверить обычные
   REST, READY/RESUME, файлы и уже открытый RTC при отзыве/потере pubsub, а не только
   новый login endpoint. Assurance максимум 1 час; refresh её не продлевает.

CalDAV push, удержанный политикой, удаляет ранее выгруженную копию встречи и
догоняет (повторный push) после возвращения SSO assurance — проверка раз в 10 минут,
запись в Valkey до 30 дней.

Enforced invite preview возвращает `SSO_REQUIRED` без данных workspace. Локальный
verified human может завершить приглашение/onboarding и подготовить membership;
`JoinWorkspaceResponse.identityAccess` содержит workspace id, enforced/reason,
а защищённые workspace/member отсутствуют. Дальше нужны local reauth и явный link,
затем SSO. Bootstrap не даёт assurance, guest/open join при enforced закрыты.

`SUPERADMIN_EMAILS` — отзывное legacy-основание: только independently local verified
nonbot/nonguest account со свежим local proof. Env/email-change revocation сохраняется;
UUID grant отдельный, автоматического постоянного backfill из email нет. SSO/recovery
и IdP claims не получают product admin даже в `/me`, gateway и permission resolution.

#### OAuth clients и точный DTO contract

Issuer: `${IDENTITY_PUBLIC_ORIGIN}/oidc/workspaces/{workspace_uuid}`. Client принадлежит
одному workspace; CRUD — builtin owner/admin с recent local reauth и требуемой
assurance, одного custom MANAGE_INTEGRATIONS недостаточно. Types из generated
`OAuthClientType`: confidential web (`client_secret_basic`), public native/SPA (`none`).
Exact registered redirects, S256, обязательные state/nonce, explicit user consent;
**nonce обязателен и в code flow** (OIDC Core §3.1.2.1 делает его там необязательным —
наш профиль строже): authorize без `state` или `nonce` (1–512 байт) отвечает
`invalid_request`; RP сверяет `nonce` в ID token и `state`/`iss` в redirect;
scopes только `openid profile email`. Email claim только независимо локально verified;
`sub` opaque/stable внутри workspace, разные workspace имеют разные subjects.
Нет API scopes, client_credentials, offline_access, SAML, dynamic registration/SLO.

First-party management/consent JSON — generated proto DTO, lowerCamelCase поля
и generated enum names, не самодельные interfaces. Источники:
[`auth.proto`](../proto/calaba/v1/auth.proto), [`identity.proto`](../proto/calaba/v1/identity.proto),
[`oauth_client.proto`](../proto/calaba/v1/oauth_client.proto). В частности, connection
использует `provider`, `clientSecret`, `version` (не design-proposal `preset/secret`);
OAuth client update использует `version` (не `revision`); optional secret отсутствует
для сохранения прежнего при той же issuer/client pair, пустой недопустим.

- Web finish/native exchange/recovery: `SSOCompleteResponse {tokens, assurance, tested}`.
  Standalone login даёт scoped tokens; link/step-up — assurance исходной local session;
  test — только tested. Web refresh secret в HttpOnly cookie, не JSON; native — в main broker.
- Native begin: `SSOBeginResponse {flowId, browserStartUrl, authorizationUrl, expiresAt}`;
  browserStartUrl несёт одноразовый bootstrap handle для browser cookie. Handoff
  ticket (60 секунд) требует verifier main-процесса, не выдаёт токены через deep link.
- Consent URL `/oauth/consent?request=<opaque handle>` связывает HttpOnly browser cookie
  и серверный snapshot. `POST /api/oauth/requests/{id}/bind`: bearer + exact Origin +
  `BindOAuthRequest {csrfToken: <initial handle>}`; только после успешного bind UI
  показывает `OAuthConsentSnapshot`. Его **новый** csrfToken идёт в
  `DecideOAuthRequest {allow, allowRefresh, csrfToken}`; ответ `OAuthDecisionResponse {redirectUrl}`.
  Scopes/client/redirect берутся с сервера; смена account требует нового request.
  Повторный bind той же session разрешён (перезагрузка страницы): csrfToken ротируется.
  Если клиента переименовали после bind, decision отвечает 409 `IDENTITY_CONFIG_CHANGED` —
  страница делает bind заново и показывает новое имя. Незавершённых requests не больше
  4 на браузер (вытесненные из cookie удаляются) и 100 на IP; сверх — redirect
  `temporarily_unavailable`. Повторное согласие заменяет grant только этого устройства;
  сужение scopes или смена решения о refresh закрывает grants клиента на всех устройствах.
  Reauth/step-up возвращает только exact same-origin consent route в той же session;
  arbitrary return URL запрещён, истёкший request (10 минут) требует нового authorize.
- Recovery kit: `IdentityRecoveryKitResponse {codesOnce, expiresAt}`; не сохранять
  plaintext в клиентских caches/logs. Provider token/UserInfo/revoke используют
  стандартный OAuth JSON/form, не protojson и не first-party/bot/session tokens.

Provider code 60 секунд, access/ID ≤5 минут с учётом исходных deadlines; refresh
только с включённым client и явным consent, максимум 8 часов absolute/30 минут idle.
Replay от правильного client отзывает family, retry grace нет: после потерянного
ответа нужен новый вход. User revoke не зависит от платного entitlement. Уже выданный
ID token и session стороннего RP нельзя мгновенно отозвать: RP отвечает за её срок.

#### Ротация, recovery и restore

Encryption: добавить новый kid вместе со старыми, доставить всем репликам, переключить
active kid; старые удалять лишь после re-encryption всех зависимых ciphertext.
Signing: prepublish next public key в JWKS всех реплик, дождаться минимум 60 секунд
cache, затем доставить private key/active kid всем репликам. Old public key сохранять
не меньше последнего old ID token TTL (≤5 минут) + 60 секунд skew + 60 секунд cache.
Keyring snapshots immutable: изменение env требует контролируемого rollout.

Upstream secret rotation той же issuer/client pair сохраняет tuple, но version++,
draft и отзыв assurances/scoped sessions/provider grants/pending flows происходят
сразу: возможен простой. Подготовить kit, свежие proofs и окно; после сохранения
owner с local reauth проходит новый test и явную activate, не полагается на старую
assurance. Новый issuer/client требует нового draft/явного link и нового secret;
email и secret старой connection не наследуются. OAuth client secret — показ один
раз, overlap 10 минут (или revokeOld для немедленного отзыва); security config
changes инвалидируют grants/requests/codes, name-only rename этого не требует.

IdP outage/downgrade не открывают enforced данные. Recovery: независимый local login
владельца + одноразовый code → 10 минут только policy repair, без чатов/RTC/OAuth.
Переход в optional/off — явный audited owner action; при потере local credential
**и** kit — только отдельная audited operator/support процедура, не скрытый bypass.
Restore выполнять с DB и нужными decrypt/public/private keyring версиями; проверить
в изоляции ciphertext, public kids/JWKS, отзыв и восстановление до открытия трафика.
Down guard не делает pre-identity image безопасным; fallback обязан проверять
authority/policy. Не отключать enforcement автоматически ради rollback.

### Почта (ADR-0023)
- **Открытая регистрация без кода** (владелец, 05.10, ADR-0065): `REGISTRATION_MODE=open` + `EMAIL_VERIFICATION=optional` в `.env` (compose передаёт обе; по умолчанию `invite` / `required`). Код из письма тогда ничего не блокирует: регистрация без письма, подтвердить адрес можно в настройках профиля; приглашённых по почте по-прежнему просят подтвердить адрес, чтобы вступить. Лимиты против спама — ADR-0065 «Злоупотребления».
- `.env` стенда: `SMTP_HOST=mail.unne.ai`, `SMTP_PORT=465`, `SMTP_TLS=tls`, `SMTP_USER` = `SMTP_FROM`-адрес, `SMTP_PASSWORD`, `SMTP_FROM="Calab <noreply@calab.io>"`. Проверка: регистрация → письмо с кодом; в логах API `mail sent` / `mail: giving up`.
- **Владелец, DNS `calab.io`** (отправитель с 2.0.0): SPF `v=spf1 include:<SPF почтового сервера mail.unne.ai> -all` (или `a:mail.unne.ai`); DKIM — TXT `<selector>._domainkey.calab.io` с публичным ключом, которым подписывает mail.unne.ai (на mail.unne.ai — ключ для домена `calab.io`); DMARC `_dmarc.calab.io` → `v=DMARC1; p=quarantine; rua=mailto:<ящик отчётов>` (начать с `p=none` на неделю). Записи `calab.ru` не удалять, пока в очередях/ответах могут быть письма со старого адреса.

### Файлы в S3: драйвер `s3` (ADR-0011)

Несколько реплик API не могут делить том драйвера `fs`, поэтому в Kubernetes файлы лежат в бакете S3-совместимого хранилища: `STORAGE_DRIVER=s3`. Основная цель — Yandex Object Storage (`https://storage.yandexcloud.net`, регион `ru-central1`); подходят Garage, Ceph RGW и другие S3-совместимые хранилища (в CI драйвер проверяется против Garage). Compose-стенд остаётся на `fs`.

| Переменная | По умолчанию | Что |
|---|---|---|
| `STORAGE_DRIVER` | `fs` | `s3` — файлы в бакете |
| `STORAGE_S3_ENDPOINT` | — (обязательна) | адрес S3 API: `https://storage.yandexcloud.net`; Garage — `http(s)://<хост>:3900` |
| `STORAGE_S3_REGION` | `us-east-1` | регион подписи SigV4: Yandex — `ru-central1`, Garage — `s3_region` из его конфига |
| `STORAGE_S3_BUCKET` | — (обязательна) | бакет **без публичного доступа**: файлы отдаёт только API после проверки прав |
| `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | — (обязательны) | статический ключ сервисного аккаунта; секрет — только в Secret кластера, не в git |
| `STORAGE_S3_KEY_PREFIX` | — | общий бакет: все объекты под `<префикс>/` (сегменты `[A-Za-z0-9._-]` через `/`) |
| `STORAGE_S3_FORCE_PATH_STYLE` | `true` | адреса `<endpoint>/<bucket>/<key>`; `false` — virtual-hosted (`<bucket>.<хост>/<key>`) |

Переменные `S3_*` без `STORAGE_` — это бакет публичных релизов десктопа (Caddy, GitHub Actions), к файлам пользователей отношения не имеют.

- **Права ключа:** чтение, запись и удаление объектов плюс список бакета; в Yandex Object Storage — роль `storage.editor`, выданная на сам бакет, а не на каталог. Без права на список S3 отвечает на отсутствующий объект 403, а не 404, и API считает это ошибкой, а не «файла нет».
- **Старт:** API проверяет бакет (`HeadBucket`, до 10 с) и не стартует при неверном адресе, бакете или ключе. `/readyz` бакет не проверяет.
- **Загрузка:** объект появляется только целиком: файл до 5 МиБ уходит одним `PutObject`, больше — multipart по 5 МиБ, две части параллельно (в памяти API до ~20 МиБ на идущую загрузку). Ошибка чтения или несовпадение размера отменяют multipart (`AbortMultipartUpload`). На случай падения пода посреди загрузки в бакете нужно правило жизненного цикла: удалять незавершённые multipart-загрузки через 1 день (`AbortIncompleteMultipartUpload`).
- **Отдача:** метаданные — `HeadObject`, байты — `GetObject` с `Range` от нужного смещения и только при чтении: перемотка аудио и видео, докачка не качают объект с начала. Запросы одного чтения идут с `If-Match` по ETag: объект, заменённый посреди чтения, даёт ошибку, а не смесь двух версий.
- **Квоты:** `STORAGE_MAX_TOTAL_BYTES` и квоты пространств считаются по размерам файлов в Postgres, а не по месту на диске или в бакете, поэтому для `fs` и `s3` одинаковы; миниатюры в них не входят.
- **Бэкап:** `backup.sh` копирует только volume драйвера `fs`; бакет — версионированием или репликацией средствами хранилища (TODO владелец).
- **Переезд с `fs`:** ключи те же (`<workspace_id>/<file_id>`, плюс `.thumb` и `.thumb1024`): скопировать содержимое `STORAGE_PATH` в бакет под префикс (`rclone copy /data/files <remote>:<bucket>/<префикс> --exclude '.tmp-*'`) и переключить `STORAGE_DRIVER`.
- **Проверка:** `apps/server/internal/blob/testdata/garage.sh` поднимает Garage и печатает `TEST_S3_*`, затем `go test -tags integration ./internal/blob/`; в CI то же делает шард `go integration rest`.

### Записи встреч в S3 (`STORAGE_DRIVER=s3`, ADR-0025)

С драйвером `fs` API и egress делят volume записей (`RECORDINGS_PATH` / `RECORDING_EGRESS_DIR`). Если API работает отдельно от медиа-хоста (API в Kubernetes, LiveKit и egress на своём сервере), общего диска нет — поэтому с `STORAGE_DRIVER=s3` записи идут через бакет файлов:

- **Как:** в запросе записи (`StartRoomCompositeEgress`) API передаёт egress бакет и ключ из `STORAGE_S3_*`. Egress пишет запись во временный файл у себя и по окончании загружает её объектом `<STORAGE_S3_KEY_PREFIX>/<workspace>/<recording>.mp4` — ровно тот ключ, который читает хранилище файлов. В базе (`room_recordings.file`) по-прежнему `<workspace>/<recording>.mp4`, как на volume. Дальше всё как с volume: размер — `HeadObject`, отправка в GPTunneL кусками — `GetObject` с `Range`, после `done` запись копируется во вложение карточки, объект удаляется. Манифест egress (`<egress id>.json`) в бакет не пишется. `RECORDINGS_PATH` и `RECORDING_EGRESS_DIR` не используются и не проверяются.
- **Медиа-хосту нужно:** исходящий доступ от контейнера egress к `STORAGE_S3_ENDPOINT` — по тому же адресу, что у API (API передаёт egress свой; внутренний адрес хранилища, недоступный с медиа-хоста, не подойдёт); место под временный файл записи в контейнере egress (`/home/egress/tmp`, до ~250 МБ на идущую запись). Volume `recordings_data` и `recordings-init` не нужны. В конфиге egress не задавать `storage:` с `prefix` — egress добавляет его к ключу, и API объекта не найдёт.
- **Ключ бакета** уходит в запросе к LiveKit (`LIVEKIT_INTERNAL_URL`) и от LiveKit к egress через его Valkey (psrpc). В `EgressInfo` (webhook, `ListEgress`) egress заменяет ключ и секрет заглушками, API их не логирует. Поэтому `LIVEKIT_INTERNAL_URL` между хостами — только HTTPS или частная сеть, Valkey LiveKit — не публичный, ключ — с правами только на этот бакет (как в «Файлы в S3»).
- **Сбои:** бакет не отвечает — API ничего не решает о записи: конец egress разбирается снова при reconcile (каждые 15 с), но не дольше 30 мин после остановки — потом запись `failed` (`recorder_failed`), чтобы комната не оставалась «записывается» (объект, если он есть, janitor уберёт через 7 дней); отправка в GPTunneL повторяется по обычному расписанию. Egress не смог загрузить файл (сеть, права) — после его конца объекта нет, карточка «Запись не удалась». Ключ API без права на список бакета получает на отсутствующий объект 403 вместо 404 — для записей это «бакет не отвечает» (см. «Права ключа» выше).
- **Уборка:** janitor удаляет объекты записей по базе, как файлы на volume. «Бесхозные» `.mp4` в бакете он не ищет: `blob.Store` не умеет листинг, а листать весь бакет файлов ради `.mp4` каждый час дороже пользы. Остаются только объекты записей пространства, удалённого раньше, чем janitor убрал запись (до 7 дней после неё), — docs/12.
- **Проверка:** `go test ./internal/recording/ ./internal/rtc/` (unit: оба режима, запрос к egress через twirp-сервер из `livekit/protocol`), `go test -tags integration -run TestRecordingBucket ./internal/app/` (запись в бакете: загрузка, повтор при недоступном бакете, объекта нет).

## Наблюдаемость

- LiveKit: `/metrics` Prometheus на `127.0.0.1:6789` (`prometheus.port` в шаблоне; `bind_addresses: 127.0.0.1` действует и на него, снаружи порт ещё и закрыт файрволом). Проверка с хоста: `curl -s 127.0.0.1:6789/metrics | grep -c '^livekit_'` (сейчас ~60 метрик). **Скрейп пока не настроен.** Prometheus на самом хосте нет: `prometheus-node-exporter` (:9100) скрейпит внешний Prometheus из подсетей Yandex Cloud (`84.201.128.0/18`, `51.250.0.0/17`, `178.154.192.0/18` — разрешены в iptables только для 9100/9400). Варианты подключения, по возрастанию изменений:
  1. Отдать метрики через Caddy: `rtc.<domain>` → `handle /metrics` → `reverse_proxy 127.0.0.1:6789` с `basic_auth` (или `remote_ip` этих подсетей); у внешнего Prometheus job `scheme: https`, `metrics_path: /metrics`, target `rtc.<domain>`. Файрвол и конфиг LiveKit не трогаем — предпочтительно.
  2. Отдельный порт: `prometheus.port` на публичном интерфейсе нельзя без смены `bind_addresses` (он же signal) → не делать.
  Дашборд — официальный LiveKit Grafana dashboard.
- API: `slog` JSON-логи, `/metrics` (client_golang): активные сокеты, события/с, латентность REST и fan-out. Только с хоста (`127.0.0.1:3000/metrics`); на `<домен>` Caddy отвечает 404. Подключать к внешнему Prometheus тем же способом, что и LiveKit (отдельный путь в Caddy с `basic_auth`).
- Клиент: crash-репорты (Sentry self-hosted — позже), локальный лог в `userData/logs`.

## Резервные копии

Работает на стенде с 2026-09-26: host systemd `calaba-backup.timer` (ежедневно 03:30 ± 5 мин, `Persistent=true` — пропущенный запуск догоняется) → `calaba-backup.service` → `infra/docker/backup/backup.sh`. Юниты лежат в репо (`infra/docker/backup/calaba-backup.{service,timer}`), на хост ставятся `install -m 644 … /etc/systemd/system/ && systemctl enable --now calaba-backup.timer`.

| Что | Куда (`/opt/calaba/backups`, 700 root) | Как |
|---|---|---|
| Postgres | `pg/calaba-<ts>.dump` | `pg_dump -Fc` через `docker exec`, проверка `pg_restore --list`, атомарный rename |
| Загруженные файлы (`calaba_files_data`) | `files/files-<ts>.tar.zst` | `tar` + `zstd` (файлы неизменяемы после записи — живой tar консистентен) |
| Caddy (`calaba_caddy_data`: ACME-аккаунт, сертификаты) | `caddy/caddy-<ts>.tar.zst` | чтобы после потери диска не упереться в лимиты LE |
| Секреты стенда (`infra/docker/.env`, `.env.accounts`) | `config/env-<ts>.tar.zst` | без них восстановленный стенд — другой (JWT, пароли БД/Redis, ключи LiveKit) |

- Ретенция 14 дней (`RETENTION_DAYS`), `.part`-остатки чистятся. Лог — `journalctl -u calaba-backup.service`. Предупреждение в журнал, если на ФС < 10 % свободно.
- **Offsite: TODO владелец.** Локальные копии спасают от логических ошибок (кривая миграция, удалённое пространство), но не от потери диска/хоста. `backup.sh` уже умеет: `OFFSITE_RCLONE_REMOTE=<remote:path>` в `infra/docker/.env` → `rclone sync` каталога бэкапов (rclone поставить на хост). Remote должен быть **rclone crypt** (в копиях секреты и данные пользователей).
- Восстановление — `infra/docker/backup/restore.sh`:
  - `restore.sh test [dump]` — восстановить в отдельную БД `calaba_restore_test`, сравнить число строк по всем таблицам с живой БД, удалить. Проверено 2026-09-26: 12 таблиц, счётчики совпали. Делать раз в месяц (TODO: отдельный таймер).
  - `restore.sh pg <dump>` — заменить живую БД (останавливает api, спрашивает подтверждение).
  - `restore.sh files <tar.zst>` — заменить файлы (останавливает api, `chown 65532`). Архив файлов проверен распаковкой: `diff -r` с живым volume — идентично.
  - Caddy/секреты — вручную: `zstd -dc … | tar -x` в volume `calaba_caddy_data` / в `infra/docker/`.
  - **Биллинг после `restore.sh pg`** (ADR-0080 §7, T7): в восстановленной базе может не быть уже
    отправленных автопополнений — новая попытка списала бы второй раз. До старта api задать
    `BILLING_AUTO_TOPUP_REQUIRE_RECONCILE=restore-<дата-время>` (каждый раз новый маркер), после
    старта суперадмином (свежий вход) — `POST /api/admin/billing/auto-topup/reconcile`
    `{"reason":"restore <дата>","requestId":"<uuid>"}`: зачисляет найденные у Stripe PI за 48 h и
    снимает паузу на всех инстансах. Ответ 503 — Stripe недоступен, повторить с новым `requestId`.
    Переменную можно убрать при следующем деплое. Ручные пополнения и webhook пауза не трогает.
- Основной `rsync` в `sync.sh` каталог `/backups/` не трогает (иначе `--delete` стёр бы копии).
- Перенос базы с PostgreSQL 18 на 17 (ADR-0037): `pg_dump` пишет `DEFAULT uuidv7()` без схемы при пустом `search_path`, и на 17 такой дамп не восстанавливается (`function uuidv7() does not exist`). В пустой базе на 17 сначала выполнить `apps/server/internal/db/uuidv7.sql`, затем восстановить дамп со схемой в DEFAULT: `pg_restore -f - calaba.dump | sed 's/DEFAULT uuidv7()/DEFAULT public.uuidv7()/' | psql -v ON_ERROR_STOP=1 -d <база>`. Проверено 2026-09-28 (18.6 → 17.11): данные и `goose_db_version` на месте, `server migrate` ничего не применяет, новые id — v7.
