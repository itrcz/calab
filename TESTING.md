# TESTING — инструкции для тестировщика

## Identity 2.0 final acceptance

1. Лид назначает **точный итоговый SHA** после merge docs/browser evidence; текущие исторические reports не signoff. Команды ниже — план, здесь не выполнены; записать SHA/env/exit/skips и два независимых security/protocol review на нём.
2. Только отдельная QA DB/Valkey/RTC; env брать из собственного `tools/identity-test-env.sh env 18 qa` либо из выделенного coordinator harness ([правила](docs/plans/identity-v2-validation.md)), не поднимать/сбрасывать чужой. Go 1.26.x как CI, golangci-lint 2.14.0, sqlc 1.31.1; записать реальные версии.
3. Из корня: `make gen` → `git diff --exit-code -- proto apps/server/gen apps/server/internal/db/sqlc packages/protocol/src/gen`; `make lint`; `pnpm -s typecheck`; `pnpm -r test`. Ожидается без drift/errors.
4. Unit/race: `(cd apps/server && go test -race -count=1 ./internal/auth ./internal/identitypolicy ./internal/identitycrypto ./internal/identitynet ./internal/oauthprovider/... ./internal/sso ./internal/directory ./internal/gateway ./internal/rtc)`.
5. Перед полным прогоном подготовить выделенный PG17, Valkey DB15/RTC14, LiveKit и Garage S3 (`GARAGE_NAME`/порт только QA), ffmpeg/ffprobe ≥7.1; TEST_S3_* хранить приватно. Не запускать отдельные targeted integration перед тем же полным набором.
6. Один назначенный QA runner на точном чистом SHA выполняет `(cd apps/server && go test -race -tags integration -count=1 -json ./...)` один раз на PG17; миграции/identity/legacy входят в этот набор. Записать counts/durations/failures/skips; недоступно/skipped ≠ passed.
7. Повторять полный набор только после релевантной правки/сбоя; не принимать прежние branch reports за evidence. Отдельно `python3 infra/identity-test/identity-proxy-test.py`; обязательный CI проверяет только PG17 (решение владельца, 2026-10-01).
8. Реальный generic RP: `GOTOOLCHAIN=go1.26.5 IDENTITY_TEST_HARNESS=<coordinator-assigned-harness> infra/identity-test/calaba-keycloak-test.sh 18`; затем `IDENTITY_BROWSER_EXPECTED_SHA=<exact-SHA> IDENTITY_TEST_HARNESS=<same-harness> infra/identity-test/browser-identity-e2e.sh 18`. Требуется отсутствие required skips, реальный App/Keycloak и независимая RS256 проверка; discovery/JWKS fetch из зарегистрированной RP страницы проверяет browser CORS и metadata flags.
9. Один ручной QA screenshot pass новых identity экранов; готовые screenshots не повторять без layout changes/failure. Browser: local/SSO step-up → consent bind/decision; native adapter/deeplink/unit, account/server switch/cancel/expiry/arbitrary return URL отдельно от реального OS roundtrip (unverified без него). Токены/refresh/verifier не попадают в URL/renderer; visual suites выключены. Entra/AD FS/Windows AD без живого стенда — unverified.
10. Сквозные отрицательные сценарии: A enforced/B independent, scopes, invite bootstrap без данных, legacy SUPERADMIN_EMAILS source/revocation, grant expiry, REST mutation race, READY/RESUME/lost pubsub/RTC eviction и DB failure; ожидается отказ без чужих данных/side effects, lease ≤30 секунд.
11. Production activation — отдельное поручение оператору после [preflight](docs/plans/identity-v2-operator-preflight.md): Vault/config/Caddy/pins, protected backup/identity-aware fallback, synthetic success/error/parser/Referer log sentinels и recovery; затем off → optional → enforced. Реальный Microsoft стенд и незакрытые operator gates записывать как unverified/blocked.

## Как пользоваться этим файлом

- Каждый раздел самодостаточен: предусловия указаны в нём или ссылкой на раздел выше. Команды — из корня репозитория (`/Users/macbook/Documents/Projects/Calaba`), если не сказано иное.
- На каждом шаге сравнивай фактический результат с «Ожидается». Любое расхождение — в отчёт: раздел и шаг, команда или действие, фактический результат, ожидание. Код не исправляй, на стенде ничего не меняй (раздел 0.3).
- Пароли, инвайты и ключи не копируй в отчёты: только «взял из `.env.accounts`».
- Строки «Факт <дата>» — результат прошлого прогона для сравнения, не шаг. Раздел «История» в конце — устаревшее, не выполнять.
- Порядок: сначала 0 (адреса и аккаунты), затем нужный раздел по оглавлению. Время — ориентировочное, без установки инструментов.

## Оглавление

| Раздел | Что проверяет | Что нужно | ~Время |
|---|---|---|---|
| [0. Стенд, адреса, аккаунты](#0-стенд-адреса-аккаунты) | адреса стенда, где взять пароль и инвайт, правила | ssh-доступ к стенду (для пароля) | 5 мин |
| [1.1–1.2 Веб: сборка и локально](#11-сборка-и-проверка-бандла) | бандл без Electron-кода, e2e:web локально | Mac/Linux, pnpm, Docker (dev API + LiveKit) | 15 мин |
| [1.3 Веб: ручной сценарий W1–W17](#13-ручной-сценарий-w1w12-chrome-плюс-firefox-по-возможности) | вход, cookie, чат, голос, стрим, приглашения в браузере, карточка ссылки «Открыть в Calab» (W13–W17) | Chrome + Firefox, микрофон, 2 аккаунта | 30 мин |
| [1.4 Веб на стенде](#14-стенд-httpsappcalabru-и-httpsmeetgptunnelru) | статика, заголовки, CSP, e2e на app и meet | pnpm, Playwright; аккаунт из 0.2 | 20 мин |
| [2.1 Десктоп: установка](#21-установка-с-releasescalabru) | установщики с releases, подпись macOS, первый запуск | macOS / Windows / Linux | 10 мин на ОС |
| [2.2–2.5 Десктоп: автотесты](#22-предусловия-локальный-api) | e2e Electron, визуальная регрессия, a11y | Mac, pnpm, Docker (LiveKit dev) | 20 мин |
| [2.6 Десктоп: два клиента (2.1–2.34)](#26-два-клиента-на-одной-машине-онбординг-чат-голос-стрим-21234) | онбординг, чат, файлы, голос, модерация, стрим, сессии, переподключение | Mac, локальный API или стенд | 60 мин |
| [2.7–2.9 Сборка, безопасность, лицензии, клавиши](#27-сборка-из-исходников) | S.1–S.4, L.1–L.4, K.1–K.3 | Mac, pnpm | 20 мин |
| [2.10 Автообновление U.1–U.10](#210-автообновление-u1u10) | фид, автоустановка, уведомления, сон/сеть, первый реальный апдейт macOS, два релиза подряд | 2 версии в фиде (делает infra), Windows/Linux/macOS | 45 мин |
| [2.11 Только люди: эхо, PTT, Caps Lock P.1–P.14](#211-только-люди-эхо-ptt-и-caps-lock-p1p14-системный-звук-трей) | эхо на колонках, Caps Lock как PTT, звук стрима, трей | живые люди, 2–3 машины, колонки; macOS для P.1–P.8 | 40 мин |
| [2.12 Веб-камера C.1–C.6](#212-веб-камера-c1c6-v02-ветка-featwebcam) | кнопка «Камера», превью, публикация VP9 simulcast, плитки и PiP, лимит камер, модератор, «Не показывать видео», «Экономить трафик» | Mac, локальный API из `feat/webcam`, LiveKit dev; настоящая камера или `CALABA_FAKE_MEDIA=1` | 30 мин |
| [2.13 Эхо на колонках E.1–E.3](#213-эхо-на-колонках-e1e3-ветка-featecho-hardening) | «собеседник слышит себя»: предупреждение, режимы «Динамики»/«Авто», «Проверка эха», флаги AEC | 2 машины (у одной — колонки, без наушников), 2 человека, сборка из `feat/echo-hardening` | 30 мин |
| [2.13а Режим музыканта MU.1–MU.4](#213а-режим-музыканта-mu1mu4-adr-0052-ветка-featmusician-mode) | живой инструмент/пение без обработки, предупреждение про динамики, замок на Free | 2 машины, 2 человека, наушники у обоих, инструмент или голос; пространство Team и Free | 20 мин |
| [2.18 REST не зависает во время звонка AT.1–AT.4](#218-rest-не-зависает-во-время-звонка-at1at4-docs09-146) | видео-превью с перемоткой, смена Wi‑Fi, сон, блокировка API → всё грузится без перезапуска | Mac, сборка из ветки, стенд, видео ≥ 15 МБ | 20 мин |
| [3.1 Сервер: базовый прогон](#31-базовый-прогон-контракт-go-интеграционные-тесты-curl-образ) | proto, линт, unit/integration, curl: регистрация, права, refresh, rate limit | Docker, Go, buf, sqlc, jq | 20 мин |
| [3.2 Сервер: gateway, сообщения, файлы, rtc](#32-gateway-сообщения-файлы-rtc) | READY/RESUME, история, файлы, join/webhook, cookie/CSRF | как 3.1 + Node ≥ 22, LiveKit dev | 20 мин |
| [3.3 Сервер: сценарии против стенда](#33-сценарии-api-против-стенда-https) | 3.1 шаг 4 и 3.2 шаг 2 по HTTPS | jq, Node; инвайт из 0.2 | 20 мин |
| [3.4 UI-бэклог (категории, поиск, unfurl, реакции, статус, закрепы, время звонка)](#34-ui-бэклог-категории-поиск-unfurl-реакции-статус-закрепы-время-звонка) | UI-бэклог (категории, поиск, unfurl, реакции, статус, закрепы, время звонка) | Go, Docker; часть тестов — dev-LiveKit | 5 мин |
| [3.5 P0.5 (лимит комнаты, перемещение, ники, гости, AFK)](#35-p05-лимит-комнаты-перемещение-ники-гости-afk) | P0.5 (лимит комнаты, перемещение, ники, гости, AFK) | Go, Docker; часть тестов — dev-LiveKit | 5 мин |
| [3.6 Исправления security-ревью (лимиты, brute force, заголовки)](#36-исправления-security-ревью-лимиты-brute-force-заголовки) | Исправления security-ревью (лимиты, brute force, заголовки) | Go, Docker; часть тестов — dev-LiveKit | 5 мин |
| [3.7 Исправления код-ревью (H1–H2, M1–M13, L1–L16)](#37-исправления-код-ревью-h1h2-m1m13-l1l16) | Исправления код-ревью (H1–H2, M1–M13, L1–L16) | Go, Docker; часть тестов — dev-LiveKit | 5 мин |
| [3.8 Второй проход ревью (R1–R9)](#38-второй-проход-ревью-r1r9) | Второй проход ревью (R1–R9) | Go, Docker; часть тестов — dev-LiveKit | 5 мин |
| [3.9 Третий проход ревью (B1–B4)](#39-третий-проход-ревью-b1b4) | Третий проход ревью (B1–B4) | Go, Docker; часть тестов — dev-LiveKit | 5 мин |
| [3.10 Voice_started_at в событиях, упоминания, уведомления комнаты](#310-voice_started_at-в-событиях-упоминания-уведомления-комнаты) | Voice_started_at в событиях, упоминания, уведомления комнаты | Go, Docker; часть тестов — dev-LiveKit | 5 мин |
| [3.11 Серверный mute (`VoiceState.server_muted`)](#311-серверный-mute-voicestateserver_muted) | Серверный mute (`VoiceState.server_muted`) | Go, Docker; часть тестов — dev-LiveKit | 5 мин |
| [3.12 Счётчики непрочитанного в READY](#312-счётчики-непрочитанного-в-ready) | Счётчики непрочитанного в READY | Go, Docker; часть тестов — dev-LiveKit | 5 мин |
| [3.13 Смена пароля и email (`PATCH /api/me/password`, `PATCH /api/me/email`)](#313-смена-пароля-и-email-patch-apimepassword-patch-apimeemail) | Смена пароля и email (`PATCH /api/me/password`, `PATCH /api/me/email`) | Go, Docker; часть тестов — dev-LiveKit | 5 мин |
| [3.14 Версия и лицензии (`GET /api/version`, образ)](#314-версия-и-лицензии-get-apiversion-образ) | Версия и лицензии (`GET /api/version`, образ) | Go, Docker; часть тестов — dev-LiveKit | 5 мин |
| [3.15 Valkey вместо Redis (ADR-0017)](#315-valkey-вместо-redis-adr-0017) | Valkey вместо Redis (ADR-0017) | Go, Docker; часть тестов — dev-LiveKit | 5 мин |
| [3.16 Ревью 4 (M1, M2, L1–L10)](#316-ревью-4-m1-m2-l1l10) | Ревью 4 (M1, M2, L1–L10) | Go, Docker; часть тестов — dev-LiveKit | 5 мин |
| [3.17 Статус звонка и скрытые превью (P0.6)](#317-статус-звонка-и-скрытые-превью-p06) | Статус звонка и скрытые превью (P0.6) | Go, Docker; часть тестов — dev-LiveKit | 5 мин |
| [3.18 Тарифы и лимиты, суперадмин (ADR-0024)](#318-тарифы-и-лимиты-суперадмин-adr-0024) | Тарифы и лимиты, суперадмин | Go, Docker; часть тестов — dev-LiveKit, `lk` | 3 мин |
| [3.19 Запись встреч и GPTunneL (ADR-0025)](#319-запись-встреч-и-gptunnel-adr-0025) | Запись, pairing, загрузка, карточка | Go, Docker, dev-LiveKit | 2 мин |
| [3.20 Ачивки (ADR-0061)](#320-ачивки-adr-0061) | Каталог суперадмина, вручение, открытка | Go, Docker | 1 мин |
| [4. Инфра и стенд](#4-инфра-и-стенд) | контейнеры, сертификаты, `/download/`→releases, LiveKit, relay, нагрузка, защита, бэкапы | ssh к стенду (только чтение), `lk`, openssl | 45 мин |
| [Хотфикс 0.1.1: сервер (move без SFU, 499)](#server-перемещение-без-sfu-move-хотфикс-011-adr-0019) | app-level move против реального LiveKit, 499 для оборванных запросов | Go, Docker, dev-LiveKit, `lk` | 10 мин |
| [Приёмка 0.1.1: клиент H.1–H.6](#приёмка-011-хотфикс-десктопа-и-веба) | плашка соединения, диалог «Присоединиться», обводка сообщения, уведомления, 4008, перемещение | Chrome, десктоп, локальный API или стенд | 40 мин |
| [M.1 Перемещение участника (два клиента)](#client-перемещение-участника-хотфикс-011-adr-0019) | VOICE_MOVED с токеном, автотест `move.web.spec.ts` | 2 аккаунта, стенд или мок | 15 мин |
| [Личные сообщения: клиент](#client-личные-сообщения-adr-0020-ветка-featdm-client) | «Личные» в рейле, список DM, новый DM, «Написать», ⌘K, ссылки; `dm-*` снимки, `dm.web.spec.ts` | мок или 2 аккаунта на стенде | 15 мин |
| [История](#история-устаревшее--не-выполнять) | устаревшее: спайк, colaba/.ai, `/download/` до S3 | — | — |

---

## 0. Стенд, адреса, аккаунты

### 0.1 Адреса

| Адрес | Что |
|---|---|
| `https://app.calab.io` | приложение (веб-клиент) и API: REST `/api/*`, gateway `wss://app.calab.io/gateway?v=1&encoding=json`, файлы, `/healthz`, `/api/version`. `/metrics` и `/readyz` снаружи — 404. `/download/*` → 302 на `releases.calab.io` |
| `https://meet.gptunnel.ru` | алиас приложения: всё то же, что на `app.calab.io` (LiveKit и TURN у алиаса общие — `rtc.`/`turn.calab.io`) |
| `https://calab.io` | лендинг (статический сайт); кнопка «Скачать» → `https://app.calab.io/download/` → `https://releases.calab.io/` |
| `https://releases.calab.io` | установщики и фиды автообновления (`latest*.yml`), прокси в бакет S3; `/` — страница со списком файлов (до первого релиза — 404) |
| `wss://rtc.calab.io` | LiveKit signal (`https://rtc.calab.io/` → `OK`); клиентам API пока отдаёт `wss://rtc.calab.ru` (docs/06 «Домены») |
| `turn.calab.io:443` | TURN/TLS (TCP) — его раздают клиентам; TURN/UDP — `141.105.69.177:443/udp` |
| `calab.ru`, `app.`, `releases.`, `rtc.`, `turn.calab.ru` | алиасы для клиентов до 2.0.0 (4.4a): `calab.ru` → 301 на `calab.io`, остальные — то же, что `.io` |

Хост: `root@141.105.69.177`, код в `/opt/calaba`, секреты — `/opt/calaba/infra/docker/.env` (не печатать). Как поднят — `docs/06-deployment.md`, домены — `docs/10-branding.md`.

Лендинг:
```sh
for p in / /nope /download/; do curl -s -o /dev/null -w "$p %{http_code}\n" https://calab.io$p; done   # 200, 404, 302
curl -sI https://calab.io/ | grep -iE 'strict-transport|content-security|cache-control'                        # HSTS, CSP лендинга, no-cache
```

DNS — Cloudflare, записи DNS-only (proxied=false). Если локальный VPN с fake-IP DNS «не видит» имена (NXDOMAIN-кэш до 30 мин) — `curl --resolve <имя>:443:141.105.69.177 …` или проверять с машины без VPN.

> Проверки портов (`nc -zv`) делать с машины **без** VPN/TUN-прокси: TUN-режим VPN принимает любой TCP connect сам, и `nc` «успешен» даже для закрытого порта.

### 0.2 Аккаунты и инвайт

`REGISTRATION_MODE=invite` (с 2026-09-26): регистрация только с кодом приглашения. Бессрочный инвайт владельца в workspace `team` (10 использований) и пароль тестовых аккаунтов — на хосте в `/opt/calaba/infra/docker/.env.accounts` (`ssh $H 'cat /opt/calaba/infra/docker/.env.accounts'`). Тестовые аккаунты: `owner@calaba.test` (владелец `team`, комнаты `general`, `secret`, `voice`) и `bob@calaba.test` (member).

Свой аккаунт:
```sh
CODE=<invite из .env.accounts>
curl -s -XPOST $A/api/auth/register -d "{\"email\":\"me@example.com\",\"password\":\"<≥8 символов>\",\"displayName\":\"Me\",\"inviteCode\":\"$CODE\"}" | jq '.me.email'
# без inviteCode → ERROR_CODE_REGISTRATION_CLOSED 403
```
В workspace `team` — по инвайту владельца (`POST /api/workspaces/{id}/invites` с токеном owner) или создать свой (`POST /api/workspaces`). В десктоп-приложении адрес сервера — `https://app.calab.io` (или `https://meet.gptunnel.ru`).

Сбросить данные стенда (все пользователи/сообщения/файлы!) — только по согласованию: `ssh $H "$DC exec -T postgres psql -U calaba -c 'drop schema public cascade; create schema public;' && $DC exec -T valkey sh -c 'VALKEYCLI_AUTH="$REDIS_PASSWORD" valkey-cli flushall' && $DC restart api"` (+ очистить volume `calaba_files_data`).

Служебные аккаунты `e2e-app@calaba.test` и `e2e-alias@calaba.test` создаёт и использует `release.sh verify` (пароли в том же `.env.accounts`) — вручную ими не пользоваться. Пароли и инвайт в отчёты не копировать.

### 0.3 Правила на стенде и обозначения

**Нельзя трогать чужое на хосте:** `python` (pid 3695), `ffmpeg`, `chromium`, `Xvfb`, контейнеры `gromtv-broadcast`, `dcgm-exporter`. Не делать `docker system prune`, `docker compose down` вне `/opt/calaba/infra/docker`, `iptables -F`, рестарт Docker. Наш compose-проект называется `calaba`.

Обозначения в командах разделов 3–4: `D=app.calab.io` (для алиаса — `D=meet.gptunnel.ru`), `DOM=calab.io` (LiveKit и TURN: `rtc.$DOM`, `turn.$DOM`), `H=root@141.105.69.177`, `DC='cd /opt/calaba/infra/docker && docker compose'`, `A=https://$D`.

---

## 1. Веб-клиент

ADR-0015: `apps/desktop`, сборка `dist-web`.

Тот же renderer, что у десктопа, со слоем `platform = web`. Отличия от десктопа:
- refresh-токен лежит в HttpOnly-cookie `calaba_refresh` (Path=/api/auth, Secure, SameSite=Strict), access-токен — только в памяти;
- API и gateway работают на том же origin, что и страница;
- PTT работает только при активной вкладке;
- экран выбирается в стандартном окне браузера;
- файлы скачиваются через `a[download]`;
- ссылка-приглашение: `https://<домен>/join/<код>`.

### 1.1 Сборка и проверка бандла
```bash
pnpm -F @calaba/desktop build:web      # → apps/desktop/dist-web; в конце "web bundle OK: no Electron-only code"
```

### 1.2 Локально (API + LiveKit dev)
```bash
# API должен знать origin веб-клиента (CSRF / cookie / gateway):
cd apps/server && PUBLIC_APP_URL=http://localhost:4173 … go run ./cmd/server        # остальные env — как в 2.2
CALABA_WEB_PROXY=http://127.0.0.1:3000 pnpm -F @calaba/desktop preview:web          # dist-web на :4173, /api и /gateway проксируются
CALABA_WEB_URL=http://localhost:4173 pnpm -F @calaba/desktop e2e:web                # ожидается: 2 passed (chromium + firefox)
```
Для dev-режима с HMR: `pnpm -F @calaba/desktop dev:web` (порт 5174; `PUBLIC_APP_URL=http://localhost:5174`).

### 1.3 Ручной сценарий W1–W12 (Chrome, плюс Firefox по возможности)
| # | Действие | Ожидается |
|---|---|---|
| W1 | Открыть `http://localhost:4173` (или стенд) | экран входа **без** поля «Сервер» |
| W2 | Войти | главное окно. DevTools → Application → Cookies: `calaba_refresh`, HttpOnly ✓, Secure ✓, SameSite Strict. `document.cookie` в консоли её не показывает |
| W3 | Перезагрузить страницу | вход сохраняется (`POST /api/auth/refresh` → 200, новая cookie) |
| W4 | Вторая вкладка с тем же адресом | обе вкладки работают. Одновременные refresh не выбрасывают из сессии (Web Locks сериализуют ротацию) |
| W5 | Чат, картинка, файл, скачивание | как в 2.6, пункты 2.6–2.11. Превью картинок — `blob:` URL. «Скачать» сохраняет файл средствами браузера |
| W6 | Голос: клик по голосовой комнате | браузер спросит микрофон, затем «Голос подключён». Звук другого участника слышен |
| W7 | Настройки → Голос → Push-to-talk → «Назначить» → клавиша | подсказка «только когда вкладка активна». Пока вкладка в фокусе — работает. Переключились в другую вкладку — передача прекращается |
| W8 | «Показать экран» → «Начать стрим» | открывается окно выбора браузера (экран / окно / вкладка). После выбора — «В эфире». Зритель (десктоп или веб) видит плитку в углу чата |
| W9 | Зритель: развернуть и открыть во всплывающем окне | работает как в десктопе (popup-окно браузера) |
| W10 | Открыть `https://<домен>/join/<код>` без входа → «Продолжить в браузере», затем войти | сначала карточка ссылки (W13); после «Продолжить в браузере» адрес становится `/`, открывается регистрация с кодом; после входа — диалог «Присоединиться к пространству» с этим кодом |
| W11 | «Выйти» | cookie удалена, повторная загрузка страницы показывает экран входа |
| W12 | Firefox | W1–W6 и W8 (Firefox умеет AV1; если нет — стрим уходит в VP9 или VP8) |
| W13 | Карточка ссылки (docs/09 #53), **приложение Calab не установлено**: открыть `https://<домен>/join/<код>` (и `/r/<код>`) в Chrome, Firefox, Safari | карточка на фоне экрана входа: «Вас пригласили в пространство» (для `/r/` — комната, тип, «в «пространство»»), кнопки «Открыть в Calab», «Продолжить в браузере», ссылка «Скачать приложение» (→ `/download/`), галочка «Всегда открывать в приложении». «Открыть в Calab» → «Открываем Calab…», через ~2 с «Приложение не найдено»; основной становится «Продолжить в браузере», «Скачать приложение» — кнопкой. Страница никуда не уходит (Firefox — без страницы ошибки; Safari может показать своё окно «адрес недействителен» — закрыть) |
| W14 | То же, **приложение установлено** (десктоп Calab, вход выполнен) | «Открыть в Calab» → браузер спрашивает «Открыть Calab?» → приложение выходит на передний план и показывает диалог вступления (`/join/`) или «Войти в комнату …?» (`/r/`); в карточке «Ссылка передана в приложение Calab.» (и если подтверждение заняло больше 2 с — сначала «Приложение не найдено», затем после ухода фокуса то же сообщение) |
| W15 | Отметить «Всегда открывать в приложении», перезагрузить страницу ссылки | приложение пробуется сразу; в карточке «Открываем Calab… Открыть в браузере» — ссылка ведёт в веб-поток. Без приложения — «Приложение не найдено». Снять галочку — при следующем заходе автозапуска нет. Приватное окно / заблокированное хранилище — галочка просто не запоминается, ошибок нет |
| W16 | Уже вошли на вебе, открыть ссылку в той же вкладке/браузере | карточка показывается (без автоперехода); для `/join/` — с именем пространства. «Продолжить в браузере» → диалог вступления / «Войти в комнату …?» |
| W17 | Скопировать ссылку: настройки пространства → «Приглашения», настройки комнаты → «Ссылка для гостей», строка «Пригласить в комнату ›» под своей voice-комнатой (веб и десктоп) | в буфере всегда `https://<домен>/join/<код>` / `https://<домен>/r/<код>`, никогда `calab://` |

Известно: Firefox не проходит ICE до LiveKit в Docker на `127.0.0.1` (локальный dev-стенд). На стенде с публичным IP это ограничение не действует.

### 1.4 Стенд: `https://app.calab.io` и `https://meet.gptunnel.ru`
После публикации `dist-web` (infra, `sync.sh`): сценарий W1–W12 и e2e ниже. Стенд в режиме приглашений: e2e входит существующим аккаунтом (`CALABA_WEB_LOGIN`/`CALABA_WEB_PASSWORD`) или регистрируется по коду (`CALABA_WEB_INVITE`) — подробно ниже.

#### Статика, заголовки, e2e

Публикация: `pnpm -F @calaba/desktop build:web` (→ `apps/desktop/dist-web`), затем (infra) `infra/docker/sync.sh caddy` (статика уезжает в `/opt/calaba/web` без `*.map`; `caddy` в аргументах — чтобы заодно применить правки Caddyfile, для одной статики перезапуск не нужен).

```sh
for d in app.calab.io meet.gptunnel.ru; do A=https://$d
  for p in / /rooms/x /assets/missing.js /metrics /readyz /healthz /api/me; do echo "$d$p $(curl -s -o /dev/null -w '%{http_code}' $A$p)"; done
  W=$(curl -s $A/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js'); echo "$W: $(curl -sI $A/$W | grep -iE 'content-type|cache-control' | tr -d '\r' | tr '\n' ' ')"
done
curl -sI https://$D/ | grep -iE 'content-security|permissions-policy|x-content|referrer|x-frame|cache-control'
```
Ожидается: `/` и `/rooms/x` → 200 (`<title>Calab`), `/assets/missing.js` → 404 (без `immutable`), `/metrics` и `/readyz` → 404, `/healthz` → 200, `/api/me` → 401; ассеты (`index-*.js`, `mic-processor.worklet-*.js`) → `text/javascript`, `public, max-age=31536000, immutable`, `content-encoding: zstd|gzip`; на `/`: `cache-control: no-cache`, CSP с `script-src 'self' 'wasm-unsafe-eval'` и `connect-src 'self' wss://rtc.calab.io https://rtc.calab.io wss://rtc.calab.io https://rtc.calab.io`, `permissions-policy: microphone=(self), display-capture=(self), speaker-selection=(self), autoplay=(self)`, `nosniff`, `same-origin`, `DENY`.

E2E против стенда. С 2026-09-26 стенд в `invite`-режиме, поэтому спека умеет два пути:
- **вход существующим аккаунтом** (предпочтительно, не тратит использования кода): `CALABA_WEB_LOGIN` + `CALABA_WEB_PASSWORD` (например `owner@calaba.test`; пароль в `/opt/calaba/infra/docker/.env.accounts` на стенде). Каждый прогон создаёт у аккаунта новое пространство `Web <browser>-<id>`;
- **регистрация по коду**: `CALABA_WEB_INVITE=<код>` (код пространства `team` — в том же `.env.accounts`; 10 использований, каждый прогон тратит одно на браузер). Создаёт пользователя `web-<browser>-<id>@example.com`.
```sh
P=$(ssh root@141.105.69.177 "awk '\$1==\"owner@calaba.test\"{print \$2}' /opt/calaba/infra/docker/.env.accounts")   # строки файла: «email пароль»
CALABA_WEB_LOGIN=owner@calaba.test CALABA_WEB_PASSWORD="$P" CALABA_WEB_URL=https://app.calab.io pnpm -F @calaba/desktop e2e:web   # 4 passed
CALABA_WEB_FF_VOICE=1 CALABA_WEB_LOGIN=owner@calaba.test CALABA_WEB_PASSWORD="$P" CALABA_WEB_URL=https://app.calab.io pnpm -F @calaba/desktop e2e:web   # 4 passed (голос и в Firefox)
CALABA_WEB_LOGIN=owner@calaba.test CALABA_WEB_PASSWORD="$P" CALABA_WEB_URL=https://meet.gptunnel.ru pnpm -F @calaba/desktop e2e:web   # 4 passed
```
Electron-E2E так же: `CALABA_LOGIN` + `CALABA_PASSWORD` или `CALABA_INVITE`, плюс `CALABA_E2E_SERVER_URL`.
Сервер ограничивает частоту создания пространств: три прогона подряд одним аккаунтом за минуту дают «too many requests» на шаге «Создать». Поэтому между прогонами делайте паузу ≥ 1 мин или используйте для `.ru` другой аккаунт (`bob@calaba.test`). После прогонов удалите тестовые пространства `Web …` (Настройки пространства → «Удаление» или `DELETE /api/workspaces/<id>`), чтобы не засорять стенд.
Если падает на `cookie?.httpOnly` (`undefined`) — на стенде старый api без cookie-режима: `infra/docker/sync.sh api`.
Если падает на `page.goto: net::ERR_TUNNEL_CONNECTION_FAILED` / `NS_ERROR_CONNECTION_REFUSED`, а `curl --resolve app.calab.io:443:141.105.69.177 https://app.calab.io/healthz` даёт 200 — это локальный VPN/прокси (fake-IP DNS), а не стенд. Обход — конфиг `infra/docker/tools/playwright.stand.config.ts` (все имена резолвятся в IP стенда, прокси выключен; пример запуска — в его шапке): `cd apps/desktop && CALABA_FORCE_IP=141.105.69.177 CALABA_WEB_URL=https://app.calab.io CALABA_WEB_LOGIN=… CALABA_WEB_PASSWORD=… pnpm exec playwright test --config ../../infra/docker/tools/playwright.stand.config.ts`.

CSP/RNNoise вручную: открыть `https://app.calab.io`, войти, зайти в голосовую комнату, DevTools → Console. Не должно быть `Refused to …`/`Content Security Policy` и `RNNoise unavailable, falling back…` (это предупреждение пишется, если worklet с WASM не стартовал за 2 с). Допустимо: `Unrecognized feature: 'speaker-selection'` (Chrome), `401` на первый `/api/auth/refresh` до входа. В «Настройки → Голос и устройства» строка «Вероятность речи (RNNoise)» показывает проценты, а не «нет — RNNoise выключен».

---

## 2. Десктоп

Полное приложение: вход, пространства, комнаты, чат, голос, стрим, управление. Контролы описаны в `apps/desktop/README.md`. Разделы 2.2–2.10 выполнимы агентом на одном Mac, 2.11 — только для людей.

### 2.1 Установка с `releases.calab.io`

Установщики публикуются на `https://releases.calab.io/` (страница со списком; с лендинга — кнопка «Скачать»; `https://app.calab.io/download/` ведёт туда же). Файлы лежат в `releases/<версия>/`. Какой брать:

| ОС | Файл | Установка |
|---|---|---|
| macOS Apple Silicon (M1–M4) / Intel | `Calab-<версия>-arm64.dmg` / `Calab-<версия>-x64.dmg` (не знаете какой —  → «Об этом Mac»: «Чип Apple M…» = arm64) | открыть dmg, перетащить Calab в «Программы», запустить. Сборка подписана (Developer ID) и нотаризована: macOS открывает её без предупреждений об неизвестном разработчике. Если предупреждение всё же есть — это ошибка, в отчёт (`spctl -a -vv /Applications/Calab.app` → ожидается `accepted`, `source=Notarized Developer ID`) |
| Windows 10/11 x64 | `Calab-Setup-<версия>-x64.exe` | запустить; сборка **не подписана**: SmartScreen «Windows защитила ваш компьютер» → «Подробнее» → «Выполнить в любом случае» |
| Linux x64 (любой дистрибутив) | `Calab-<версия>-x86_64.AppImage` | `chmod +x Calab-*.AppImage && ./Calab-*.AppImage` (нужен FUSE 2: Ubuntu 22.04+ — `sudo apt install libfuse2`; без него: `./Calab-*.AppImage --appimage-extract-and-run`) |
| Debian/Ubuntu x64 | `calab_<версия>_amd64.deb` | `sudo apt install ./calab_*_amd64.deb`, запуск — «Calab» в меню или `calab` |

После запуска — онбординг; в поле «Сервер» по умолчанию `https://app.calab.io` (можно `https://meet.gptunnel.ru`), вход — аккаунтом из 0.2 или регистрация по коду приглашения.

Проверка целостности (если скачано с ошибками): `latest-mac.yml` / `latest-linux.yml` / `latest.yml` в корне `https://releases.calab.io/` содержат `sha512` (base64) и `size` каждого файла: `shasum -a 512 -b <файл> | cut -d' ' -f1 | xxd -r -p | base64` (macOS/Linux) должно совпасть.

Сборка (infra, не тестировщик): `apps/desktop/scripts/build-release.sh` — docs/06 «Релизы десктопа: сборка»; публикация — только GitHub Actions `release.yml` (push тега `v*`) → S3 → `https://releases.calab.io/`; `/download/` на стенде — редирект туда (docs/06 «Релизы: GitHub Actions → S3», «Релиз: runbook»).

### 2.2 Предусловия (локальный API)
```bash
pnpm install                                                     # в конце: "Rebuild Complete" (uiohook-napi)
pnpm -F @calaba/desktop typecheck && pnpm -F @calaba/desktop lint && pnpm -F @calaba/desktop test   # 46 тестов
docker compose -f infra/docker/compose.dev.yml up -d postgres valkey livekit
# API (apps/server/README.md). Для локального теста:
cd apps/server && DATABASE_URL=postgres://calaba:calaba@localhost:55432/calaba REDIS_URL=redis://localhost:56379/0 \
  JWT_SECRET=$(openssl rand -base64 48) REGISTRATION_MODE=open \
  LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_INTERNAL_URL=http://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
  go run ./cmd/server                                            # слушает 127.0.0.1:3000
```
Порты postgres и valkey смотрите в `docker ps`: в dev-compose они проброшены как 55432 и 56379. Если стенд `https://app.calab.io` поднят, вместо локального API используйте `CALABA_SERVER_URL=https://app.calab.io`.

### 2.3 Против стенда; статистика медиа
Аккаунты `owner@calaba.test` и `bob@calaba.test`, пространство «Team». Пароль лежит на сервере: `ssh root@141.105.69.177 cat /opt/calaba/infra/docker/.env.accounts`. Не копируйте его в отчёты. LiveKit (`wss://rtc.calab.io`) клиент получает из `/join` сам.
```bash
pnpm -F @calaba/desktop build                 # → apps/desktop/dist/mac-arm64/Calab.app (+ dmg/zip)
APP=apps/desktop/dist/mac-arm64/Calab.app/Contents/MacOS/Calab
# клиент А (owner, настоящие микрофон и экран):
CALABA_SERVER_URL=https://app.calab.io CALABA_USER_DATA=/tmp/cal-owner CALABA_MULTI_INSTANCE=1 "$APP" &
# клиент Б (bob; fake-медиа, чтобы не было эха на одной машине):
CALABA_SERVER_URL=https://app.calab.io CALABA_USER_DATA=/tmp/cal-bob CALABA_MULTI_INSTANCE=1 CALABA_FAKE_MEDIA=1 "$APP" &
```
Dev-режим тоже работает: `CALABA_SERVER_URL=… pnpm -F @calaba/desktop dev`. Но тест с заморозкой процесса (пункт 2.29) в dev не показателен: Vite перезагружает страницу, когда его HMR-сокет переподключается.

Включите статистику: Настройки → «Приложение» → «Статистика медиа для разработчиков». В голосовой комнате справа сверху появится панель со строками:
- `ICE: <local>→<remote> <протокол>` — путь (`host`/`srflx` — напрямую, `relay` — через TURN);
- `RTT`, `loss`;
- `total ↑↓` — весь трафик ICE;
- `mic` — битрейт микрофона;
- `send h/q <разрешение>@<fps> <kbps>/<потолок>` у стримера — слои simulcast, `(off)` = dynacast выключил слой, потому что его никто не смотрит;
- `recv …` у зрителя — принимаемый слой и декодер.

Ожидаемые значения (замер 2026-09-25, этот Mac → стенд):

| Что | Ожидается |
|---|---|
| Путь ICE | `srflx→host udp`, RTT ≈ 35 мс, потери 0 % |
| Голос | `mic` ≈ 30–45 кбит/с при речи, ≈ 0,1 кбит/с в тишине (гейт) |
| Стрим 1080p (реальный экран) | `send h 1658×1078@15`: 80–110 кбит/с на статике, до ~950 при смене картинки. `q 553×359` ≤ 250. У Б `recv 1658×1078@15`, декодер `VideoToolbox` |
| Стрим «Оригинал» | доступен, только если в комнате разрешён максимум «Оригинал» (по умолчанию в «Team» — 1080p: пресет выше недоступен в списке, а сервер урежет запрошенный). `send h 2940×1912@20–26`: 230–1800 кбит/с, CPU renderer 40–65 % ядра |
| Путь через TURN | запустить Б с `CALABA_FORCE_RELAY=1` → `ICE: relay→host udp/relay-udp`, RTT ≈ 35 мс |

Важно: окно зрителя должно быть видимым. Если окно полностью перекрыто, macOS считает страницу скрытой, adaptive stream ставит видео на паузу (`recv 0 kbps`), а стример показывает оба слоя `(off)` — это ожидаемое поведение.

### 2.4 Автоматический E2E
```bash
CALABA_E2E_SERVER_URL=http://localhost:3000 pnpm -F @calaba/desktop e2e
```
Ожидается `1 passed`. Сценарий: регистрация → пространство → комната → сообщение с markdown → голосовая комната → «Голос подключён» → отключение. Используется продакшн-сборка из `out/` (`file://`).

### 2.5 Дизайн: визуальная регрессия, layout-инварианты, a11y (docs/08, «Тесты UI»)
Самодостаточно: поднимает детерминированный мок API (`apps/desktop/e2e-support`, фиксированные данные) и продакшн-renderer из `out/`. Нужен только dev LiveKit (`pnpm infra:dev`) — для кадров голоса и стрима (второй участник «Вера» публикует статичный canvas-трек из headless Chromium).
```bash
pnpm infra:dev                                  # LiveKit на :7880 (devkey/secret)
pnpm -F @calaba/desktop e2e:visual              # сравнить с эталоном
pnpm -F @calaba/desktop e2e:visual:update       # перезаписать эталон после намеренного изменения дизайна
```
Локально ожидается `~29 passed` (остальные — `skipped`): только `dark-960` и ~25 ключевых экранов (`KEY` в `screens.spec.ts`) + join-карточка веба, 1 воркер. Полная матрица (все экраны, 4 конфигурации `dark-960`, `dark-1440`, `light-960`, `light-1440` + `misc`: обход фокуса, экраны веб-клиента, ~360 тестов) — только с `CALABA_VISUAL_ALL=1`, в nightly CI на Linux. Один экран: `-g "voice-pip$"`.
- Эталонные снимки: `apps/desktop/e2e-visual/__screenshots__/darwin/*-dark-960.png` (в репо, только ключевые экраны); полная матрица — `__screenshots__/linux/` (nightly). Порог — 0,2 % отличающихся пикселей. Снимки платформенные: эталон снят на macOS; на Linux/Windows сначала `e2e:visual:update`.
- Экраны: вход/регистрация, каждый шаг онбординга (микрофон до/после разрешения, режим VAD/PTT, запись экрана, уведомления, готово), главное окно с данными, участники, ⌘K, меню пространства, все вкладки настроек пространства/комнаты/голосовой комнаты/приложения, создание комнаты, подтверждение удаления, голос со стримом в PiP и развёрнутым (с полосой камер), камера: меню ▾, «Проверьте камеру», PiP, сетка плиток, крупная плитка, меню участника на плитке (своя камера — fake-устройство Chromium, второй участник публикует canvas как camera-трек), приветствие без пространств с диалогами «Создать пространство» и «Присоединиться». Видео и индикатор качества маскируются.
- В каждой точке, кроме снимка: layout-инварианты (нет горизонтального скролла; текст не выходит за кнопки/заголовки/строки/вкладки, обрезка только с «…»; обрезанный текст не сжат до нуля; ничего не торчит за окно; модалки по центру; PiP не пересекает композер) и axe-core WCAG 2.1 A/AA — 0 нарушений serious/critical (контраст ≥ 4,5:1).
- Детерминизм: `CALABA_VISUAL_TEST=1` — без анимаций и каретки, фиксированные статусы разрешений ОС; часы клиента зафиксированы на 2026-01-15 13:30 MSK, `TZ=Europe/Moscow`, без полос прокрутки; порт мока — 39170 для обхода фокуса, 39171+ для воркеров экранов (в worktree база 39270, см. apps/desktop/README «Parallel visual runs»).
- При падении: `apps/desktop/test-results/visual-report/index.html` (ожидаемое/фактическое/diff по каждому снимку) и `test-results/visual/*/trace.zip`.

### 2.6 Два клиента на одной машине: онбординг, чат, голос, стрим (2.1–2.34)
```bash
# клиент А (dev, HMR):
CALABA_SERVER_URL=http://localhost:3000 CALABA_USER_DATA=/tmp/cal-a CALABA_FAKE_MEDIA=1 pnpm -F @calaba/desktop dev
# клиент Б (второй экземпляр того же dev-сервера):
cd apps/desktop && ELECTRON_RENDERER_URL=http://localhost:5173 CALABA_MULTI_INSTANCE=1 CALABA_SERVER_URL=http://localhost:3000 \
  CALABA_USER_DATA=/tmp/cal-b CALABA_FAKE_MEDIA=1 ../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
```
`CALABA_FAKE_MEDIA=1` включает синтетический микрофон (бип) и тестовую «картинку» экрана. Без флага используются настоящие устройства, и macOS спросит разрешения.

| # | Действие | Ожидаемый результат |
|---|---|---|
| 2.1 | А: «Нет аккаунта? Зарегистрироваться» → email, имя, пароль (≥ 8 символов) | онбординг: «Микрофон» → «Разрешить микрофон» (индикатор уровня двигается) → «Как включать микрофон» → (macOS) «Показ экрана» → «Уведомления» → «Всё готово». Любой шаг можно пропустить («Пропустить настройку»). Затем экран «Добро пожаловать в Calaba» |
| 2.2 | А: «Создать пространство» → название → «Создать» | в левой полосе иконка пространства, в колонке секции «Текстовые / Голосовые комнаты» |
| 2.3 | А: «+» у текстовых → «общий» | комната открыта, «Добро пожаловать в #общий», справа панель участников (1 в сети) |
| 2.4 | А: меню пространства (стрелка у названия) → «Пригласить людей» → «Создать приглашение» | тост «Ссылка-приглашение скопирована», в списке появилась строка `https://<сервер>/join/<код>` (без адреса сервера — `calab://join/<код>`) |
| 2.5 | Б: регистрация с этим кодом в поле «Код приглашения» | Б сразу в пространстве. У А в панели участников «В сети — 2» |
| 2.6 | Б: открыть «общий» | до открытия название комнаты у Б жирное (непрочитанное) |
| 2.7 | Б: начать печатать | у А под полем ввода «Боб печатает…» |
| 2.8 | Б: отправить `Привет, @<имя А>! **жирный** _курсив_ \`код\` https://example.com` | у А сообщение появилось сразу. Упоминание подсвечено жёлтым, markdown отрисован. Если окно А не в фокусе — системное уведомление и отскок иконки в Dock. Над сообщением у А маркер «НОВЫЕ» |
| 2.9 | А: в пустом поле ↑ → изменить текст → Enter | у обоих текст обновился, пометка «(изменено)» |
| 2.10 | А: навести на своё сообщение → корзина → «Удалить» | у обоих сообщение исчезло |
| 2.11 | Б: скрепка → картинка + любой файл → Enter (или перетащить файлы в чат, или вставить картинку из буфера) | прогресс загрузки. У А превью картинки, по клику — полный размер. У файла карточка с размером; «Скачать» сохраняет в «Загрузки» и показывает файл в Finder |
| 2.12 | А: «+» у голосовых → «Созвон», клик по комнате | внизу колонки «Голос подключён · Созвон», значок качества зелёный, звук входа |
| 2.13 | Б: клик по «Созвон» | через ≤ 30 с (reconcile; сразу, если у LiveKit настроены webhooks) под комнатой оба участника. Говорящий (бип fake-микрофона) обведён зелёным |
| 2.14 | Б: кнопка микрофона в панели «я» | у А рядом с Бобом иконка перечёркнутого микрофона. В логе сервера `PATCH /api/voice/self 204` |
| 2.15 | А: правый клик по Бобу в голосовой комнате | меню по секциям (как в Discord): «Профиль», «Упомянуть» · громкость 0–100 %, «Заглушить для меня» ☐, «Не слышать» ☐ (голос и звук стрима), «Изменить ник», «Роли ›», «Переместить в ›» · красные «Заглушить для всех» ☐, «Отключить от комнаты» · «Копировать ID». Пункты 40 px, чекбоксы справа, меню не закрывается при переключении чекбокса |
| 2.16 | А: «Заглушить для всех» ☐ | у Б тост «Модератор выключил вам микрофон», кнопка микрофона красная |
| 2.17 | А: «Отключить от комнаты» | Б выходит из голоса с тостом «Модератор отключил вас…» |
| 2.18 | А (в голосе): значок монитора «Показать экран» → выбрать экран → «Начать стрим» | у А плашка «● В эфире · N смотрят» |
| 2.19 | Б (в той же голосовой комнате) | в углу чата плитка PiP 320×180 со стримом. У А «1 смотрит» |
| 2.20 | Б: клик по плитке (развернуть) → «В отдельное окно» → закрыть окно | стрим разворачивается над чатом в высоком качестве. Отдельное окно показывает стрим, основное — «Стрим открыт в отдельном окне». После закрытия окна стрим снова развёрнут |
| 2.21 | Б: ✕ «Не смотреть» | плитка исчезла, у А «0 смотрят» |
| 2.22 | А: «Остановить стрим» | у Б стрим пропал |
| 2.23 | Настройки (шестерёнка) → «Внешний вид» → «Светлая» | тема мгновенно светлая |
| 2.24 | Настройки → «Голос и устройства» → «Проверить» | индикатор уровня двигается, жёлтая риска — порог. С включённым RNNoise видна вероятность речи |
| 2.25 | Настройки → «Соединение» → «Проверить соединение» в голосе | API «доступен, N мс», Gateway «подключено», путь голоса, например `host → prflx, UDP` |
| 2.26 | Закрыть А и запустить снова | вход не требуется: сессия восстановлена из Keychain (`session.bin` в профиле зашифрован) |
| 2.27 | Настройки → «Сеансы» → завершить сессию Б | Б выбрасывает на экран входа с сообщением «Сессия была завершена на другом устройстве» (gateway 4010) |
| 2.28 | Остановить API на 10 с и запустить снова | жёлтая полоса «Нет соединения с сервером — переподключаемся…», затем она исчезает, пропущенные события досылаются (RESUME) |
| 2.29 | Б (собранное приложение, в голосе и в #general): найти PID renderer — `pgrep -lf 'Calab Helper \(Renderer\)'` (при двух экземплярах — в Мониторинге системы по времени запуска). `kill -STOP <pid>`, А за это время пишет сообщение, через 20 с `kill -CONT <pid>` | сообщение появилось у Б сразу (сокет пережил 20 с: это меньше двух интервалов heartbeat), голос вернулся сам за ≤ 5 с (resume LiveKit) |
| 2.30 | То же, но пауза 95 с | в логе Б (`<профиль>/logs/main.log`): `[gateway] closed 1006` → `invalid session (resumable=false)` → новый IDENTIFY. Жёлтая полоса ≤ 3 с, пропущенное сообщение на месте, голос снова «Голос подключён» через ≤ 5 с |
| 2.31 | Выключить Wi-Fi на 10 с (только на отдельной машине: на общем Mac это рвёт связь другим агентам) | то же, что в 2.30: полоса, RESUME или IDENTIFY, голос возвращается сам (переподключение LiveKit, иначе повторный `/join` с паузами 1, 2, 4… с) |
| 2.32 | ⌘K (Ctrl+K), набрать часть названия комнаты, ↓/↑, Enter | окно быстрого перехода вверху по центру, выбранная строка синяя, Enter открывает комнату, Esc закрывает |
| 2.33 | ⌘⇧M / ⌘⇧D (Ctrl+Shift+M / D) в голосе | микрофон / звук выключаются и включаются, иконки в панели «я» красные; подсказки с сочетаниями — в tooltip кнопок |
| 2.34 | Сузить окно до минимума (960×600) | окно не уже 960×600, ничего не наезжает; панель участников становится плавающей (открывается кнопкой «Участники», закрывается Esc), колонку комнат можно тянуть за правый край (200–320 px) |
| V.1 | **Переключение комнат** (docs/09 #131). А в голосе в «Созвоне»: 10 раз быстро кликать «Созвон» ↔ «Переговорка», закончить на «Переговорке» | через ≤ 5 с островок «Голос подключён · Переговорка», у Б А виден только там; Настройки → «Соединение» → «Проверить соединение»: строка «Голос: подключён, RTT N мс». Автотест: `pnpm -F @calaba/desktop exec playwright test --config playwright.visual.config.ts --project voice-switch` (нужны `build:web` и dev LiveKit) |
| V.2 | **Обрыв сети посреди переключения** (только отдельная машина). А в «Созвоне»: клик «Переговорка» и сразу выключить Wi-Fi на 40 с, затем включить | не дольше 15 с «Подключение…» (в «Соединение» — «Подключение… · N с» и последняя ошибка «… — повторяю»), затем одна повторная попытка; не вышло — тост «Не удалось подключиться к голосу: <причина>» и выход из голоса; в `main.log` — `voice: stuck connecting … (stage …)`. После включения сети клик по любой комнате подключает сразу, без перезапуска |

### 2.7 Сборка из исходников
```bash
pnpm -F @calaba/desktop build        # → apps/desktop/dist/Calab-<ver>-arm64.dmg и -mac.zip (без подписи)
open apps/desktop/dist/mac-arm64/Calab.app   # при первом запуске ПКМ → «Открыть» (приложение не подписано)
```
Ожидается: окно входа. В поле «Сервер» надо ввести адрес (по умолчанию `https://app.calab.io` из `.env.production`; переопределяется `MAIN_VITE_DEFAULT_SERVER_URL` при сборке). Логи пишутся в `~/Library/Application Support/Calaba/logs/main.log` (папка данных сохранила имя до переименования, docs/10). Ссылка `calab://join/<код>` (и старая `calaba://join/<код>`), открытая из браузера или через `open calab://join/<код>`, запускает Calab и показывает диалог входа в пространство.

### 2.8 Безопасность десктопа S.1–S.4 (ревью 2026-09-26: M2, M3, L1–L3)
| # | Проверка | Ожидается |
|---|---|---|
| S.1 | Скачать вложение из чата, затем `xattr -l ~/Downloads/<файл>` | `com.apple.quarantine: 0083;…;Calab;`. Windows: у файла есть `Zone.Identifier` (ZoneId=3) — «Свойства» → «Разблокировать» |
| S.2 | Собранное приложение, сервер `https://…` | само скачивает и ставит обновления только из фида, зашитого при сборке (`MAIN_VITE_UPDATE_FEED`, в релизе `https://releases.calab.io/`). Фид из адреса сервера (`app.X` → `https://releases.X/`, иначе `https://<сервер>/download/`) и `CALABA_UPDATE_URL` дают только уведомление «Доступна версия X — Скачать», без загрузки. Только https. Задать адрес из интерфейса нельзя. Поведение по платформам — 2.10 |
| S.3 | DevTools renderer: `await fetch('https://example.com')` | ошибка CSP (`connect-src` ограничен сервером, его поддоменами (`rtc.`) и `calaba-api:`). Голос и gateway работают. LiveKit на другом домене → `CALABA_CSP_CONNECT="wss://… https://…"` |
| S.4 | DevTools: `location.href = 'file:///etc/hosts'` или `<iframe src=…>` на внешний сайт | навигация заблокирована, `<webview>` не создаётся |

### 2.9 Лицензии L.1–L.4 и горячие клавиши K.1–K.3
| # | Проверка | Ожидается |
|---|---|---|
| L.1 | `pnpm -F @calaba/desktop build:app` / `build:web` | в выводе `third-party notices: N packages`. Сборка падает, если в бандле появилась GPL/AGPL/SSPL/EUPL. LGPL допустима только у перечисленных в скрипте: libuiohook внутри uiohook-napi, с текстами LGPL/GPL в THIRD-PARTY-NOTICES |
| L.2 | Настройки → «О программе» | карточка «Лицензия»: «Business Source License 1.1» → текст лицензии + NOTICE; «Коммерческая лицензия» → COMMERCIAL-LICENSE.md; «Лицензии сторонних компонентов» → THIRD-PARTY-NOTICES. Ниже строка «© 2026 GPTunneL · Powered by GPTunneL» со ссылкой |
| L.3 | Экран входа (веб и десктоп) | внизу та же строка, «Лицензия: Business Source License 1.1» и «Лицензии сторонних компонентов» — открывают тексты |
| L.4 | Собранный dmg: `ls Calab.app/Contents/Resources` | есть `LICENSE`, `NOTICE`, `COMMERCIAL-LICENSE.md`, `THIRD-PARTY-NOTICES.txt`. Установщик DMG/NSIS показывает лицензию |
| K.1 | Настройки → «Горячие клавиши» → «Изменить» у «Выключить микрофон» → ⌘⇧J | подпись в строке, в tooltip панели «я» и в «?» — «⌘⇧J». ⌘⇧J выключает микрофон, ⌘⇧M больше нет |
| K.2 | «Изменить» → ⌘Q / ⌘⇧D (занято «Заглушить всех») / J без ⌘ | отказ с причиной под строкой, прежнее сочетание остаётся. Esc отменяет запись |
| K.3 | «Сбросить» | вернулось сочетание по умолчанию |

### 2.10 Автообновление U.1–U.10

Логика — `apps/desktop/src/main/updateFlow.ts` (unit-тесты `updateFlow.test.ts`, `src/shared/updateFeed.test.ts` в `pnpm -F @calaba/desktop test`).

Фиды:
- **Зашитый при сборке** — `MAIN_VITE_UPDATE_FEED`. В релизе это `https://releases.calab.io/`: `apps/desktop/.env.production`, а `build-release.sh` передаёт `UPDATE_FEED`. Только из него обновление скачивается и ставится само.
- **Из адреса сервера** — `https://app.<домен>` → `https://releases.<домен>/`, любой другой адрес → `https://<сервер>/download/`. Используется, только если зашитого фида нет, и только для уведомления.
- **`CALABA_UPDATE_URL`** при запуске заменяет фид, но тоже только для уведомления.

Ссылка «Скачать» ведёт на `https://<сервер>/download/`, а без сервера — на зашитый фид.

Автоустановка работает при трёх условиях: фид зашит при сборке, переключатель включён, и платформа — Windows, Linux AppImage или macOS, собранный с `MAIN_VITE_UPDATES_SIGNED=1` (подпись + нотаризация). В остальных случаях приходит только уведомление.

Когда проверяется: через 10 с после запуска, затем каждый час (± до 5 мин, в логе `[update] periodic check every N s`), по кнопке «Проверить» (Настройки → «О программе»), а через ~5 с после выхода из сна, разблокировки экрана и появления сети — не чаще раза в 10 мин. «Проверять обновления автоматически» (Настройки → «Приложение», по умолчанию вкл.) выключен → только кнопка «Проверить». Звонок/стрим загрузку не откладывает, «Перезапустить» в звонке перезапускает сразу и возвращает в ту же комнату/звонок. Нужна собранная версия: в dev (`pnpm dev`) обновления выключены.

Переключатель: Настройки → «Приложение» → карточка «Обновления» → «Автоматически обновлять» (по умолчанию включён). Выключен → ничего не скачивается, только уведомление «Доступна версия X — Скачать». Хранится в `settings.json` рядом с логами (`autoUpdate`); рядом — «Проверять обновления автоматически» (`autoCheckUpdates`).

Лог (строки `[update]`, плюс вывод electron-updater): macOS `~/Library/Application Support/Calaba/logs/main.log`, Windows `%APPDATA%\Calaba\logs\main.log`, Linux `~/.config/Calaba/logs/main.log`. Ошибки обновления видны только там и строкой «Не удалось проверить обновления» в «О программе» — тостов нет.

| # | Проверка | Ожидается |
|---|---|---|
| U.1 | Фид: `for f in latest.yml latest-mac.yml latest-linux.yml; do curl -s -o /dev/null -w "$f %{http_code}\n" https://releases.<домен>/$f; done`, затем `curl -s https://releases.<домен>/latest-mac.yml` (и два других) | все три — 200. В каждом `version:` — опубликованная версия, в `files:`/`path:` — имена `Calab-…` (`Calab-Setup-<в>-x64.exe`; `Calab-<в>-arm64.zip` / `Calab-<в>-x64.zip`; `Calab-<в>-x86_64.AppImage`), у каждого файла `sha512` и `size`. `curl -sI https://releases.<домен>/<файл>` → 200 |
| U.2 | Windows / Linux AppImage: установить 0.1.0, войти на сервер `https://app.<домен>`; опубликовать 0.1.1 в фид; запустить (или перезапустить) Calab | в течение ~10 с в «О программе» строка «Загружается версия 0.1.1 — N %» растёт до 100, затем «Версия 0.1.1 загружена — установится при перезапуске» и кнопка «Перезапустить». В островке слева внизу — строка «Calab 0.1.1 готова» с кнопками «Перезапустить» и ✕, в меню трея — «Перезапустить для обновления 0.1.1». Нажать → приложение закрывается, ставится и запускается само; в «О программе» «Версия 0.1.1». Вариант: вернуть 0.1.0, дождаться баннера, **не нажимая** выйти (трей → «Выход» / закрыть окно на Windows) → при следующем запуске версия 0.1.1. В логе: `[update] downloaded 0.1.1`, `[update] quit and install` (для кнопки) |
| U.2a | То же, но «Автоматически обновлять» выключен | ничего не скачивается: уведомление «Доступна версия 0.1.1 — Скачать» (по клику — страница загрузки), в «О программе» «Доступна версия 0.1.1» и кнопка «Скачать». Включить переключатель → сразу начинается загрузка (как в U.2) |
| U.2b | Linux deb (`calab_0.1.0_amd64.deb`) | как U.2a независимо от переключателя: пакет обновляется вручную |
| U.3 | macOS, неподписанная сборка (без `MAIN_VITE_UPDATES_SIGNED=1`; `build-release.sh` ставит его только при `SIGN=1 NOTARIZE=1`): установлена 0.1.0, в фиде 0.1.1 | через ~10 с системное уведомление «Доступна версия 0.1.1 — Скачать» (один раз на версию, повтор проверки его не дублирует); клик открывает страницу загрузки в браузере. В «О программе» «Доступна версия 0.1.1» + «Скачать». Ничего не скачивается и не ставится само, баннера над панелью «я» нет. Подписанная сборка (`MAIN_VITE_UPDATES_SIGNED=1`) ведёт себя как U.2 |
| U.4 | Недоступный фид (например, `CALABA_UPDATE_URL=https://releases.invalid/` при запуске) | приложение работает как обычно, никаких тостов и уведомлений; в «О программе» «Не удалось проверить обновления», в логе `[update] failed` |
| U.5 | Windows, сборка **без** зашитого фида (`MAIN_VITE_UPDATE_FEED=` пустой при `pnpm build:app`), вход на сервер `https://app.<домен>`, в `https://releases.<домен>/` лежит 0.1.1. Затем то же со сборкой с фидом, но запуском с `CALABA_UPDATE_URL=https://releases.<домен>/` | в обоих случаях только уведомление «Доступна версия 0.1.1 — Скачать», ничего не скачивается, баннера «Перезапустить» нет. Клик открывает `https://app.<домен>/download/`, а не корень фида |
| U.6 | Собранная версия. Выключить сеть, запустить Calab, дождаться «Не удалось проверить обновления»; подождать 10 мин, включить сеть. Отдельно: усыпить машину на ≥ 10 мин, разбудить; заблокировать/разблокировать экран | после возврата сети, пробуждения и разблокировки — проверка через ~5 с (в логе `[update] check on online` / `resume` / `unlock`, затем `checking for update`), если прошлая была ≥ 10 мин назад; чаще — нет. Во время загрузки повторных проверок нет (при готовом «Перезапустить» — есть: вдруг вышла версия новее); то же при возврате в окно (`[update] check on focus`) |
| U.7 | **Первый реальный апдейт macOS через фид** (когда в `https://releases.calab.io/` опубликованы 0.1.0 и 0.1.1, обе подписаны и нотаризованы). На Mac (Apple Silicon или Intel — берётся своя архитектура): `apps/desktop/scripts/update-smoke.sh` (параметры: `OLD=0.1.0 NEW=0.1.1 FEED=https://releases.calab.io/ TIMEOUT=90`, `KEEP=1` — оставить папку с логом). Скрипт ставит старую версию во временную папку в `$TMPDIR` (не в «Программы»), запускает с отдельным профилем (`CALABA_USER_DATA`), реальный профиль и открытый Calab не трогает | по шагам `PASS`: фид объявляет 0.1.1 → DMG 0.1.0 скачан и распакован, версия 0.1.0 → `codesign` Developer ID, `spctl` «accepted, Notarized Developer ID» → старт 0.1.0 → в логе «Found version 0.1.1» → «[update] downloaded 0.1.1» и «nativeUpdater.update-downloaded» (Squirrel.Mac забрал обновление) за ≤ `TIMEOUT` с → после выхода (SIGTERM → обычный quit; сборки новее 1.5.0 передают обновление Squirrel.Mac только здесь, выход держится ≤ 20 с, в логе `[update] quit: installing` и `nativeUpdater.update-downloaded`; Squirrel.Mac ставит на выходе) `Info.plist` = 0.1.1 → перезапуск пишет «Calab 0.1.1 starting». Итог `RESULT: PASS`. При `FAIL` — лог `<work>/profile/logs/main.log` (с `KEEP=1`) и `~/Library/Caches/app.calaba.desktop.ShipIt/ShipIt_stderr.log` |
| U.8 | **Расписание, звонок, баннер.** Собранная версия с зашитым фидом (Windows/AppImage/подписанный macOS), установлена 0.1.0. (1) Войти в голосовую комнату, опубликовать 0.1.1, нажать «Проверить». (2) Не выходя из голоса, дождаться загрузки. (3) Закрыть баннер ✕, подождать час (или перезапустить — баннер вернётся через ~10 с). (4) Трей → «Перезапустить для обновления 0.1.1». (5) Отдельно: выключить «Проверять обновления автоматически», перезапустить | (1) сразу «Загружается версия 0.1.1» (звонок загрузку не откладывает). (2) полоса «Доступна версия 0.1.1 — обновление уже загружено · Перезапустить и обновить» (подсказка — «…вернётесь в ту же комнату или звонок») и пункт в трее. (3) баннер скрыт до следующей проверки, затем снова виден. (4) приложение ставит 0.1.1 и перезапускается. (5) в логе нет `checking for update` ни через 10 с, ни через час; «Проверить» работает |
| U.9 | **Обратно в комнату после обновления** (docs/09 #126). Собранная версия с зашитым фидом, обновление загружено. (1) В голосовой комнате «Переговорка», микрофон выключен, камера включена → полоса «Перезапустить и обновить». (2) То же в звонке 1:1 (собеседник остаётся). (3) Как (1), но пока идёт установка — войти в голос с телефона/веба. (4) Обычный запуск без обновления. (5) Как (1), но идёт показ экрана | (1) после перезапуска — снова в «Переговорке», микрофон выключен, камера выключена, тост «Вы снова в «Переговорке»»; в логе `[resume-voice] seat stored for the restart room …` и `resume voice after the update restart: join`. (2) снова в звонке, тост «Вы снова в звонке с …» (перезапуск дольше 30 с — звонок завершён сервером, ничего не происходит). (3) тост «Вы уже в голосе на другом устройстве», телефон остаётся в голосе. (4) никуда не подключается. (5) снова в комнате со звуком «переподключение», экран не показывается, тостов ошибок нет |
| U.10 | **Два релиза подряд — одно обновление до новейшей** (docs/09 #125). Собранная с зашитым фидом версия N (Windows / AppImage / подписанный macOS), фид — тестовый канал стенда или локальный (`CALABA_UPDATE_URL` не подходит — только уведомление; нужна сборка с `MAIN_VITE_UPDATE_FEED=<тестовый фид>`). (1) Опубликовать N+1, дождаться полосы «Доступна версия N+1 — обновление уже загружено». (2) Опубликовать N+2; вернуться в окно через ≥ 10 мин или «Проверить» в «О программе». (3) «Перезапустить и обновить». (4) Повторить (1)–(2) с N+2 → N+3/N+4 и в шаге (3) нажать «Перезапустить», пока N+4 ещё грузится (сразу после «Проверить»). (5) Повторить (1)–(2), а вместо (3) выйти из приложения (трей → «Выход» / ⌘Q) — один раз, пока N+2 грузится, и один раз после её загрузки | (2) полоса пропадает на время загрузки, в «О программе» «Загружается версия N+2 — …», затем полоса «Доступна версия N+2». (3) один перезапуск — запущена N+2 («О программе»), полосы нет, повторного обновления после старта нет. (4) полоса показывает прогресс N+4, после загрузки — сам перезапуск в N+4 (не в N+3). (5) выход во время загрузки: ничего не ставится, следующий запуск скачивает новейшую и после «Перезапустить» стоит она; выход после загрузки: следующий запуск — сразу N+2. Лог: `[update] feed has N+2 newer than the pending N+1 — replacing it`, `[update] downloaded N+2`, `[update] quit and install N+2`; macOS — `[update] staging N+2` и `nativeUpdater.update-downloaded` только после «Перезапустить»/выхода |

### 2.11 Только люди: эхо, PTT и Caps Lock (P.1–P.14), системный звук, трей
- **Эхо на реальных устройствах.** 3 участника, двое на колонках, говорят одновременно. Затем смена устройства вывода посреди разговора (Настройки → «Устройство вывода»). Эха быть не должно.
- **PTT.** Настройки → «Голос и устройства» → «Push-to-talk» → «Назначить» → клавиша. Удержание в любом приложении включает эфир, отпускание выключает через «Задержку отпускания» (по умолчанию 20 мс). На macOS нужны «Универсальный доступ» и «Мониторинг ввода»: если их нет, биндер показывает красную строку и кнопку «Открыть настройки ОС». Рядом с клавишей есть точка: зелёная, пока эфир включён, — удобно проверять прямо в настройках. Для замера второй клиент в той же голосовой комнате включает dev-статистику: Настройки → «Приложение» → «Статистика медиа для разработчиков», строка `total ↓… kbps`.

  | # | Действие (macOS) | Ожидается |
  |---|---|---|
  | P.1 | «Назначить» → нажать Caps Lock (в т. ч. при включённом «Caps Lock переключает раскладку») | сразу «⇪ Caps Lock», под полем «Последняя нажатая клавиша: ⇪ Caps Lock ↓ (HID; код 58, raw 0x39)». В `logs/main.log`: `[ptt] capture armed { status: 'running', … }`, `[ptt] raw { source: 'hid', keycode: 58, rawcode: '0x39', … }`, `[ptt] captured { kind: 'key', code: 58, label: '⇪ Caps Lock', source: 'hid', mode: 'hold' }`. Если строка не появилась — прислать все `[ptt] raw`/`[ptt] HID listener` из лога |
  | P.2 | В голосе: удерживать Caps Lock 3 с, отпустить (раскладка при этом может переключиться — это системное поведение) | эфир ровно пока держим, точка зелёная, у второго клиента `↓` ≈ 20–25 кбит/с; отпускание — тишина через задержку отпускания (20 мс по умолчанию). `hidutil property --get UserKeyMapping` — без Caps → F18 (ремап не нужен) |
  | P.3 | Выключить Calab «Мониторинг ввода» (Системные настройки) → перезапустить → Настройки → «Горячие клавиши» | подсказка «Caps Lock с переключением раскладки ловится только с разрешением „Мониторинг ввода“» и кнопка; появилась опция «Caps Lock не меняет регистр» (фолбэк через `hidutil`, как в 0.2.1). Вернуть разрешение → вернуться в окно: `[ptt] HID listener changed { status: 'running' }` или подсказка «перезапустите Calab» |
  | P.4 | Биндинг из 0.2.1 (ремап Caps → F18 или «переключение») после обновления | в логе `[ptt] HID listener { status: 'running' }`, `hidutil … --get` без Caps → F18; Caps Lock работает (удержание / переключение соответственно) |
  | P.5 | Закрыть Calab (⌘Q) | `hidutil … --get` пустой: раскладка вернулась. Ваш собственный маппинг, если был, остался |
  | P.6 | С включённой опцией: `kill -9` процесса Calab → Caps Lock снова печатает F18 → запустить Calab | в логе `restored the keyboard mapping left by a previous crash`, затем ремап снова применён. После ⌘Q раскладка обычная |
  | P.7 | «Назначить» → боковая кнопка мыши | «Кнопка мыши 4 (назад)». Удержание — эфир, отпускание — тишина (раньше на macOS кнопка мыши «залипала») |
  | P.8 | «Назначить» → F18 / правый ⌥ / Num 0 | «F18» / «Правый ⌥ Option» / «Num 0». Работают как удержание |
  | P.9 | Windows / Linux X11: «Назначить» → Caps Lock | «⇪ Caps Lock» без плашки: режим удержания. Linux Wayland: подсказка, что глобальные клавиши недоступны |
  | P.10 | «Голос и устройства» → PTT: ползунок «Задержка отпускания» (по умолчанию «20 мс»); «Горячие клавиши» → строка «Задержка отпускания 20 мс · Изменить» | «Изменить» открывает «Голос и устройства»; шаги 0/20/50/100/250/500/750/1000…2000 мс, подпись меняется |
  | P.11 | 20 мс: в голосе коротко нажать/отпустить клавишу, смотреть на своё кольцо и `↓` у второго клиента | кольцо и точка в биндере гаснут сразу (на глаз без задержки), у второго `↓` падает до ~0; DevTools: `[ptt] key-up → gate closed { gateMs ≈ 20 }` |
  | P.12 | 2000 мс: отпустить и в течение 2 с нажать снова | эфир не прерывается (ни щелчка, ни звука pttOff/pttOn); без повторного нажатия — выкл через 2 с |
  | P.13 | 2000 мс: отпустить и сразу нажать «Выключить микрофон» / «Отключиться» | эфир выключается сразу, не через 2 с |
  | P.14 | Биндинг «переключение»: нажать, нажать ещё раз | выкл сразу, задержка не применяется (подпись под ползунком об этом говорит) |

  P.5–P.6 и строка ниже — только для фолбэка без «Мониторинга ввода» (P.3). «Назначить» → Esc или другая клавиша: `hidutil … --get` снова без Caps → F18 (ремап держится только на время захвата).
- **Системный звук стрима (docs/09 #68, docs/02 п. 4).** А (macOS 14.2+ или Windows) и Б в одной голосовой комнате, у А наушники:
  1. А: пикер стрима — «Звук» включён по умолчанию, предупреждения нет. Начать стрим экрана со звуком.
  2. Б говорит → А **слышит** Б весь стрим (раньше при `loopbackWithMute` звук у А пропадал целиком).
  3. А включает видео/музыку в браузере → Б слышит её в стриме; свой голос в стриме Б **не слышит** (нет задержанного эха).
  4. Лог А: `[stream] system audio may include our own playback` отсутствует.
  5. А останавливает стрим → голос Б у А звучит, как до стрима; громкость других приложений не изменилась.
  6. macOS < 14.2: «Звук» по умолчанию выключен, при включении — предупреждение про эхо.
- **Уведомления и трей.** Меню трея: «Выключить микрофон», «Выключить звук», «Отключиться от голоса».

---


### 2.12 Веб-камера C.1–C.6 (v0.2, ветка `feat/webcam`)
Два клиента, как в 2.6: А и Б на одной машине. Сервер — из ветки `feat/webcam` (там `camera/request`, `VoiceState.camera`, `VOICE_CAMERA_STOP`). Кому нужна настоящая камера — запускайте клиента без `CALABA_FAKE_MEDIA` (macOS спросит разрешение «Камера»). С `CALABA_FAKE_MEDIA=1` камера — синтетическая картинка Chromium: зелёный «пакман» со счётчиком кадров.

Иконка камеры у участника в списке комнат и в колонке участников берётся из `VoiceState.camera` (webhook LiveKit `track_published`). В `compose.dev.yml` webhooks не настроены, поэтому без них иконка появится только после reconcile, до 30 с (docs/02, «Наблюдение по dev-стенду»). Плитки и PiP от этого не зависят: их источник — треки LiveKit.

Для проверки битрейтов включите «Ещё → Статистика». В оверлее строки `cam q/h/f`: слой, кодек (`VP9`), разрешение@fps, кбит/с (текущий/целевой).

| # | Действие | Ожидаемый результат |
|---|---|---|
| C.1 | А и Б в одной голосовой комнате. А: панель «Голос подключён» → кнопка «Камера» (первая из четырёх). | Первый раз открывается окно «Проверьте камеру»: превью отзеркалено, есть выбор устройства. «Включить камеру» → кнопка залита синим. У А в углу чата PiP с собой (подпись «… (вы)»). У Б через 1–2 с PiP с камерой А. В списке комнат у А появилась иконка камеры (см. оговорку про webhooks). В статистике у А: `cam` 3 слоя 320×180 / 640×360 / 1280×720, потолки 150 / 500 / 1500 кбит/с, `lim:cpu` нет. Повторное включение камеры идёт уже без превью. Превью можно открыть снова: ▾ у кнопки «Камера» → «Проверить камеру». |
| C.2 | Б тоже включает камеру. Б: клик по PiP (или «Ещё → Видео участников»). | Над чатом сетка плиток: А, Б и аватары тех, кто без камеры (у стримящего на плитке LIVE). Своя камера крупно не показывается. Говорящий обведён зелёным. Крупная плитка переключается на другого говорящего только после ~2 с его речи (короткое «ага» не переключает). Кнопка «Показать чат» возвращает чат с PiP. Клик по плитке закрепляет её крупно (синяя рамка, значок булавки, «Вернуться к сетке» сверху); повторный клик, «Вернуться к сетке» или Esc возвращают сетку. У зрителя в статистике `recv` при маленькой плитке ~320×180 или 640×360, при крупной ~1280×720 (adaptive stream). Правый клик по плитке открывает меню участника. |
| C.3 | А: «Показать экран» при включённых камерах. Б: развернуть стрим. | Стрим — главная картинка. Под ним полоса 160×90: камеры (и превью других стримов). Клик по камере в полосе переключает на сетку камер, крупно выбранную, стрим остаётся чипом «В эфире» сверху. |
| C.4 | Лимит. Настройки комнаты → «Медиа» → «Камер одновременно» = 1. А с включённой камерой; Б нажимает «Камера». | У Б тост «Достигнут лимит камер», кнопка не залита (сервер ответил 409). Tooltip кнопки у Б (когда `VoiceState.camera` дошёл, см. оговорку про webhooks): «Камера — в комнате уже 1 из 1». Значение 0 → кнопка серая с подсказкой «Камеры в этой комнате выключены». Настройки пространства → «Медиа» → «Камер одновременно» меняет значение по умолчанию (6). |
| C.5 | Модератор. А (владелец): правый клик по Б в списке комнат или на плитке → «Выключить камеру». | У А тост «Камера Б выключена». У Б тост «Модератор выключил вашу камеру», кнопка не залита, плитка Б у всех стала аватаром. Б может включить камеру снова (новый `camera/request`). У участника без `MUTE_MEMBERS` пункта нет. Настройки комнаты → «Права» → роль «Участник» → «Включать камеру»: запрет → у участника кнопка серая «Нет права включать камеру в этой комнате» (после переподключения к голосу). |
| C.6 | Экономия трафика. Б: правый клик по А → «Не показывать видео». Затем «Ещё → Экономить трафик». | После «Не показывать видео» у Б на плитке А аватар и значок «Видео скрыто», в статистике нет входящего видео А (подписка снята). Снять галочку — видео вернулось. «Экономить трафик»: принимается только камера говорящего (или выбранная крупно) и не выше 360p, остальные плитки — аватары со значком. Если выключить окно Б (свернуть или полностью перекрыть), входящее видео встаёт на паузу. |

Дополнительно, если есть слабая машина (или нагрузить CPU): в статистике у публикующего `lim:cpu` три замера подряд → тост «Камера переключена на 360p: процессор перегружен», слой `f` 640×360. Выдернуть USB-камеру во время звонка → тост «Камера отключилась», кнопка не залита. Переподключение голоса (2.30) → камера включается снова сама (новый захват, без превью). Тост «Связь восстановлена — включите камеру снова» — только если места уже нет.

Автотесты этого раздела: `pnpm -F @calaba/desktop test` (unit: `cameraLogic`, `tileLayout`, `services/camera`, меню участника), `pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts` (эндпоинты камеры в моке), `e2e:visual` (кадры `voice-camera-menu`, `camera-preview`, `voice-camera-pip`, `voice-camera-grid`, `voice-camera-focus`, `voice-camera-member-menu`, а также полоса камер в `voice-stream*`).

### 2.13 Эхо на колонках E.1–E.3 (ветка `feat/echo-hardening`)
Две машины А и Б в разных комнатах. У А — **колонки** (встроенные динамики ноутбука, громкость 70–100 %), без наушников; у Б — наушники. Оба в одной голосовой комнате. У А включена «Статистика медиа» (Настройки → Приложение): строка `aec erl … erle … dB · echo r …`, `RISK`, `duck`. Логи — `~/Library/Application Support/Calaba/logs/main.log`.

| # | Действие | Ожидается |
|---|---|---|
| E.0 | Запустить А, войти в голос, открыть `main.log` | `chromium features { enable: [ChromeWideEchoCancellation, WebRtcAudioNeuralResidualEchoEstimation, …] }` и `[renderer] [mic] capture settings {"echoCancellation":true,"autoGainControl":true,…}` |
| E.1 | А: Настройки → «Колонки и эхо» → «Наушники». Б говорит 20–30 с фразами с паузами, А молчит | Б себя не слышит — **ок**, тоста нет, `echo r` < 0,6. Если Б слышит себя: через ≈ 7–10 с у А тост «Похоже, собеседник слышит себя…» с кнопкой «Включить «Динамики»», в статистике `RISK`. Второго тоста в этом звонке нет. Записать: слышал ли Б себя, `erl/erle` (с выключенным шумоподавлением), `echo r` |
| E.2 | А: режим «Динамики». Б говорит, А пытается перебить | Пока говорит Б, в статистике `duck`. Б себя не слышит или слышит заметно тише, чем в E.1. А перебивает — Б слышит его (тише, но разборчиво). В режиме PTT у А при нажатой клавише `duck` нет. Режим «Авто» после E.1 с тостом ведёт себя как «Динамики», без тоста — как «Наушники» |
| E.3 | Вне звонка: А → «Проверка эха» → «Проверить» (3 с тихого «а-а-а» из колонок). Повторить на громкости 30 % и 100 %, в наушниках. Затем A/B флагов: перезапустить А с `CALABA_NEURAL_AEC=0`, потом с `CALABA_SYSTEM_AEC=1`, повторить E.1 | Наушники → «Эхо не обнаружено»; колонки тихо → «не обнаружено»/«Слабое»; громко вплотную к микрофону → «Слабое»/«Сильное» с советом. В `main.log` строка `echo check {level, deltaDb, corr, lagMs}`. Для A/B записать, в каком варианте Б слышит себя меньше и не «булькает» ли голос А. С `CALABA_SYSTEM_AEC=1` на macOS другие приложения становятся тише (VPIO) — это ожидаемо |

Нейросетевой оценщик: `…/Calab.app/Contents/MacOS/Calab --enable-logging=stderr 2>&1 | grep -i "residual echo"` — строки `Failed to initialize neural residual echo estimator` быть не должно (если есть — фича в этой сборке не работает, AEC3 работает как раньше). Автотесты: `pnpm -F @calaba/desktop test` (`echo.test.ts`, `echoCheck.test.ts`, `echoFeatures.test.ts`, режимы в `voice.test.ts`); снимок вкладки «Голос и устройства» — `pnpm -F @calaba/desktop e2e:visual:update -g "settings-2"` (новая карточка; агент визуальные не запускал).

### 2.13а Режим музыканта MU.1–MU.4 (ADR-0052, ветка `feat/musician-mode`)
А и Б в одной голосовой комнате пространства **Team**, оба в наушниках. У А — гитара/голос у микрофона, у Б включена «Статистика медиа».

| # | Действие | Ожидается |
|---|---|---|
| MU.1 | А играет/поёт 30 с с тихими нотами и паузами, режим выключен; затем «…» → «Режим музыканта» и то же самое | Выкл.: сустейн «съедается», хвосты обрываются. Вкл.: звук полнее, низ бас-струн на месте, тихие ноты и хвосты слышны, нет «качания» громкости. Переключение без переподключения. У Б рядом с А — гитара; у А в панели «Режим музыканта · Выключить»; в статистике А `mic … · музыкант 128` (192 для стерео-карты); в `main.log` А `capture settings {"echoCancellation":false,…,"musician":true}` |
| MU.2 | А снимает наушники, выбирает вывод «Динамики MacBook», включает режим заново | При включении — красный липкий тост «Звук идёт в динамики (…)» с «Выключить режим музыканта»; в настройках — та же плашка. Б говорит — слышит себя (ожидаемо); через ≈ 7–10 с у А тост «Собеседники слышат себя…» |
| MU.3 | А выходит из голоса и входит снова | Режим выключен, гитары у А нет |
| MU.4 | То же в пространстве **Free** | Переключатель в настройках под замком «Доступно на тарифе Team и выше», в меню «…» — пункт с замком, клик — тост с «Связаться». Войти с включённым режимом из Team-комнаты в Free-комнату — режим выключается с тем же тостом |

### 2.14 Стрим: выбор источника, свой стрим, полный экран S.5–S.7 (ветка `feat/stream-ux`, docs/09 #17–18)
Mac (лучше Retina + второй монитор), 2 клиента (2.6) в одной голосовой комнате.
| # | Проверка | Ожидается |
|---|---|---|
| S.5 | А: «Экран». Потянуть окно шире/уже | Вкладки «Весь экран» · «Приложения», открыта «Весь экран», выбран первый экран (рамка 2 px внутри карточки). Один монитор — одна крупная карточка по центру, два — сетка. Превью резкие (текст читается), через ~0,3 с после ресайза снова резкие |
| S.6 | А: «Начать стрим» | У А свой стрим в PiP/stage с бейджем «Вы стримите», без регулятора звука, «Свернуть в угол» и pop-out работают. У Б — как раньше, «1 смотрит» у А считает только Б. А: «Остановить стрим» — плитка исчезает |
| S.7 | Б: stage → «На весь экран»; затем Esc; снова — ⌃⌘F; снова — «Свернуть». Pop-out → «На весь экран» | Окно уходит в отдельный Space на своём мониторе, видно только видео + полоса (имя, «1080p · N fps», звук, «Свернуть»); через 2 с без мыши полоса и курсор скрыты. Каждый выход возвращает прежний размер окна и раскладку. Pop-out — то же для своего окна |

### 2.15 Запись встреч, клиент R.1–R.4 (ADR-0025, ветка `feat/recording-client`)
Авто: `pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts` (мок: pairing, start/stop, карточка UPLOADING → PROCESSING → DONE) и `pnpm -F @calaba/desktop e2e:visual -g "settings-gptunnel|chat-recording-card|voice-room-recording"`. Руками — сервер из 3.19 (dev-LiveKit + egress), 2 клиента (2.6), А — владелец.
| # | Проверка | Ожидается |
|---|---|---|
| R.1 | Б (участник): «…» комнаты → «Запись встречи» до подключения | Тост «Пространство не подключено к GPTunneL — попросите владельца»; у А тот же шаг — тост с кнопкой «Подключить» → вкладка «GPTunneL» |
| R.2 | А: вкладка «GPTunneL», ввести `abcdefgh` / неверный код / код из GPTunneL | Поле показывает `ABCD-EFGH`; неверный — ошибка под полем; верный — «Подключено», устройство, аккаунт, «Открыть в GPTunneL», «Отключить» (с подтверждением). У Б — только статус |
| R.3 | Оба в комнате; Б: «Запись встречи». Затем В входит в комнату | У всех «● REC» + таймер на карточке, у А/Б пилюля «● Запись» и звук старта (тумблер в «Звуки»), у А тост «Началась запись…»; В — тост «Идёт запись встречи (начал: Б)» |
| R.4 | А: «…» → «Остановить запись»; подождать обработку | REC пропал, звук стопа, тосты с причиной; в чате комнаты карточка «Встреча записана · N мин»: «Загрузка…» → «Обработка…» → «Готово» + «Открыть в GPTunneL». Настройки комнаты → «Медиа» → выключить «Разрешить запись» во время записи — стоп с тостом «её запретили в настройках комнаты», пункт меню «Запрещено» |

### 2.16 Стикеры ST.1–ST.5 (ADR-0030)
Авто: `go test -race -tags integration ./internal/app -run Sticker` (права, WebP, лимиты, события), `go test ./internal/stickers`, мок — `vitest --config e2e-support/vitest.config.ts`, снимки — `e2e:visual -g "sticker"`, `e2e:visual:mobile -g m-sticker-picker`. Файлы для руками: `apps/server/internal/stickers/testdata/*.webp` (`big.webp` 600×600 — должен отклоняться).
| # | Проверка | Ожидается |
|---|---|---|
| ST.1 | А (владелец): Настройки пространства → «Стикеры» → «Новый пак», перетащить 3 WebP, эмодзи каждому, «Загрузить» | Пак с 3 стикерами; у Б (участник) событие — пак в «Паки пространств» пикера. `big.webp` / PNG — ошибка, ничего не загружено |
| ST.2 | Б: 😊 в композере → «Стикеры» → «Добавить» пак → клик по стикеру | Сообщение-стикер 160 px без пузыря; у А — «☀️ Стикер» в уведомлении и списке DM (если в DM) |
| ST.3 | А: клик по стикеру Б | Карточка пака, «Убрать из моих»; у гостя — без кнопки; у гостя нет отправки («Гости не отправляют стикеры») |
| ST.4 | Анимированный стикер: прокрутить за экран, свернуть окно, включить «Уменьшить движение» в ОС | Играет только на экране; в остальных случаях — первый кадр; CPU окна без звонка ≤ 1 % |
| ST.5 | Суперадмин: тариф custom `sticker_packs: 1`; второй пак | Тост «Тариф пространства: не больше 1 паков стикеров» с «Связаться» |


### 2.17 «Заметки» N.1–N.6 (ADR-0039)

Авто: `go test -tags integration ./internal/app -run Notes`; `e2e-web/notes.web.spec.ts` (мок + `dist-web`); снимки `notes-shelf`, `m-notes`.
- N.1 «Личные» → «ЗАМЕТКИ» «+» → имя «Идеи», Enter → полка открыта, в шапке «📝 Идеи · Только для вас»; Esc в форме — полки нет.
- N.2 Написать заметку, прикрепить файл, закрепить, поиск ⌘F по полке — работает как в DM; галочек прочтения нет.
- N.3 Сообщение из комнаты: ⠿ в панели действий → на полку — «Сохранено в «📝 Идеи»», копия в полке; на заголовок «ЗАМЕТКИ» — в первую полку; на плитку «Личные» в рейле, удержать 0,5 с — список полок.
- N.4 Из полки: ⠿ → на строку DM / комнаты — «Переслано: …»; «Переслать…» — группа «Заметки» первая.
- N.5 Файл из Finder на строку полки — отправлен в полку; порядок полок — перетаскиванием (после перезапуска тот же).
- N.6 «⋯» → Удалить полку → подтверждение → полка и её сообщения исчезли на всех устройствах; 21-я полка — «Можно создать не больше 20 полок».

### 2.18 REST не зависает во время звонка AT.1–AT.4 (docs/09 #146)

Авто: `pnpm -F @calaba/desktop test -- apiProtocol apiStall apiReset`; живой повтор бага без сборки: `node_modules/.bin/electron --mute-audio tools/h2-stall-repro.cjs` → `HUNG`, с `HOW=signal` → `OK`, с `RESET=1` → после `closeAllConnections()` `OK`.
Сборка из ветки против стенда, в голосовой комнате; смотреть `~/Library/Application Support/Calaba/logs/main.log`.
- AT.1 В чат — видео ≥ 15 МБ; открыть превью, 10–15 раз перемотать в разные места, закрыть; повторить 3 раза. Затем открыть 5 разных комнат, доску, задачу с комментариями → всё грузится сразу, в логе нет `api request timeout`.
- AT.2 Во время звонка переключить Wi‑Fi на другую сеть (или раздать с телефона) и обратно; открыть комнаты → грузятся не дольше чем через одну задержку ~20–30 с, без перезапуска; в логе `api transport reset (network online)` или `(… timeouts in 60 s)`.
- AT.3 Закрыть крышку на 2 мин, открыть → в логе `api transport reset (power resume)`; комнаты, доска, задача грузятся, голос переподключился.
- AT.4 Перекрыть API (Little Snitch / правило `pfctl` на IP стенда) на 60 с, за это время открыть 2–3 новые комнаты → «Не удалось загрузить сообщения», в логе `api transport reset (2 timeouts in 60 s)`. Снять блокировку → эти комнаты загружаются сами (после `api transport reset` или переподключения gateway), без клика «Повторить» и без перезапуска.

## 3. Сервер

Локальные прогоны — на машине с Docker и Go (dev-compose), без стенда; 3.3 — те же curl-сценарии против стенда.

### 3.1 Базовый прогон: контракт, Go, интеграционные тесты, curl, образ
#### 0. Предусловия

```sh
go version            # ожидается go1.26+ (локально go1.27.x)
buf --version         # 1.x
sqlc version          # v1.31.x
docker info --format '{{.ServerVersion}}'   # Docker запущен
pnpm install
```

Postgres 18, Valkey 9 (совместим с Redis) и LiveKit (dev) — порты смещены, чтобы не пересекаться с чужими сервисами на машине:

```sh
docker compose -f infra/docker/compose.dev.yml up -d
docker compose -f infra/docker/compose.dev.yml ps      # postgres (55432), valkey (56379), livekit (7880-7882) — running
docker exec calaba-dev-postgres-1 psql -U calaba -c 'select uuidv7()'   # одна строка с uuid
docker exec calaba-dev-valkey-1 valkey-cli info server | grep valkey_version  # 9.x или новее
```

Чужие контейнеры/сервисы на 5432/6379 **не трогать**.

#### 1. Контракт и генерация

```sh
buf lint                     # Ожидается: пустой вывод, exit 0
make gen                     # Ожидается: exit 0
git status --porcelain apps/server/gen packages/protocol/src/gen apps/server/internal/db/sqlc
                             # Ожидается: ничего нового относительно состояния до make gen (генерация идемпотентна)
pnpm -F @calaba/protocol typecheck   # Ожидается: exit 0, без ошибок tsc
pnpm -F @calaba/protocol test        # Ожидается: 2 файла, все тесты passed
```

#### 2. Go: сборка, линт, unit-тесты

```sh
cd apps/server
gofmt -l .                   # Ожидается: пустой вывод
go vet ./... && go vet -tags integration ./...   # Ожидается: пустой вывод, exit 0
golangci-lint run --config ../../.golangci.yml --build-tags integration ./...   # Ожидается: "0 issues."
go test -race ./...          # Ожидается: ok для auth, blob, files, gateway, httpx, messages, perm, redisx, rtc, voice, workspaces; остальные [no test files]
cd ../..
```

#### 3. Интеграционные тесты

```sh
make test-integration
```

Ожидается: `ok  github.com/calaba/calaba/server/internal/app` (остальные пакеты — ok / no test files), exit 0. После прогона временных БД не остаётся:

```sh
docker exec calaba-dev-postgres-1 psql -U calaba -tAc "select count(*) from pg_database where datname like 'calaba_it_%'"   # Ожидается: 0
```

#### 4. Ручной прогон сервера через curl

Нужен `jq`. Запуск (в отдельном терминале или в фоне; порт 3900, чтобы не пересечься с другими процессами):

```sh
cd apps/server
DATABASE_URL=postgres://calaba:calaba@localhost:55432/calaba \
REDIS_URL=redis://localhost:56379/0 \
JWT_SECRET=manual-test-secret-manual-test-secret \
REGISTRATION_MODE=invite HTTP_ADDR=127.0.0.1:3900 \
go run ./cmd/server
```

Ожидается в логе (JSON): `"msg":"migration applied"` (только при первом запуске на чистой БД) и `"msg":"listening","addr":"127.0.0.1:3900"`.

**Важно:** bootstrap-регистрация без инвайта работает только на пустой БД. Если в БД уже есть пользователи (повторный прогон), шаг 4.2 вернёт 403 — тогда очисти БД и Redis: `docker exec calaba-dev-postgres-1 psql -U calaba -c 'drop schema public cascade; create schema public;'`, `docker exec calaba-dev-valkey-1 valkey-cli flushall` — и перезапусти сервер.

```sh
A=http://127.0.0.1:3900
```

Примечание: protojson намеренно вставляет случайные пробелы после `,`/`:` в JSON-ответах — сравнивай по смыслу (или через `jq`), а не побайтно. Поля с пустым значением присутствуют (`"field":""`).

4.1 Health:
```sh
curl -s $A/healthz            # {"status":"ok"}
curl -s $A/readyz             # {"postgres":"ok","redis":"ok"}
curl -s $A/metrics | grep -c calaba_http_request_duration_seconds   # число > 0 (после пары запросов)
```

4.2 Регистрация владельца (первый пользователь, без инвайта):
```sh
OWNER=$(curl -s -XPOST $A/api/auth/register -d '{"email":"owner@example.com","password":"password123","displayName":"Owner","deviceName":"curl"}')
echo $OWNER | jq '.me.email, .tokens.sessionId'      # "owner@example.com", uuid
OT=$(echo $OWNER | jq -r .tokens.accessToken); ORT=$(echo $OWNER | jq -r .tokens.refreshToken)
```
Второй пользователь без инвайта:
```sh
curl -s -w ' %{http_code}\n' -XPOST $A/api/auth/register -d '{"email":"x@example.com","password":"password123","displayName":"X"}'
# {"code":"ERROR_CODE_REGISTRATION_CLOSED",...} 403
```

4.3 Профиль:
```sh
curl -s $A/api/me -H "Authorization: Bearer $OT" | jq .me.user.displayName        # "Owner"
curl -s -XPATCH $A/api/me -H "Authorization: Bearer $OT" -d '{"statusText":"on air","settings":{"pushToTalk":true}}' | jq '.me.user.statusText, .me.settings.pushToTalk'   # "on air", true
curl -s -w ' %{http_code}\n' $A/api/me        # ERROR_CODE_UNAUTHENTICATED 401
```

4.4 Workspace + инвайт + второй пользователь:
```sh
WS=$(curl -s -XPOST $A/api/workspaces -H "Authorization: Bearer $OT" -d '{"slug":"team","name":"Team"}' | jq -r .workspace.id)
curl -s -XPOST $A/api/workspaces -H "Authorization: Bearer $OT" -d '{"slug":"team","name":"Dup"}' -w ' %{http_code}\n'   # ERROR_CODE_CONFLICT, field "slug", 409
curl -s -XPOST $A/api/workspaces -H "Authorization: Bearer $OT" -d '{"slug":"Bad Slug","name":"x"}' -w ' %{http_code}\n'  # ERROR_CODE_VALIDATION 422
CODE=$(curl -s -XPOST $A/api/workspaces/$WS/invites -H "Authorization: Bearer $OT" -d '{"maxUses":5,"expiresInSeconds":3600}' | jq -r .invite.code)
curl -s $A/api/invites/$CODE -H "Authorization: Bearer $OT" | jq .workspace.slug      # "team"
BOB=$(curl -s -XPOST $A/api/auth/register -d "{\"email\":\"bob@example.com\",\"password\":\"password123\",\"displayName\":\"Bob\",\"inviteCode\":\"$CODE\"}")
BT=$(echo $BOB | jq -r .tokens.accessToken); BID=$(echo $BOB | jq -r .me.user.id)
curl -s $A/api/workspaces -H "Authorization: Bearer $BT" | jq '.workspaces | length'  # 1
curl -s $A/api/workspaces/$WS/members -H "Authorization: Bearer $OT" | jq '[.members[].role]'   # ["WORKSPACE_ROLE_OWNER","WORKSPACE_ROLE_MEMBER"]
```

4.5 Комнаты и права:
```sh
GEN=$(curl -s -XPOST $A/api/workspaces/$WS/rooms -H "Authorization: Bearer $OT" -d '{"type":"ROOM_TYPE_TEXT","name":"general"}' | jq -r .room.id)
SEC=$(curl -s -XPOST $A/api/workspaces/$WS/rooms -H "Authorization: Bearer $OT" -d '{"type":"ROOM_TYPE_VOICE","name":"secret","isPrivate":true}' | jq -r .room.id)
VOI=$(curl -s -XPOST $A/api/workspaces/$WS/rooms -H "Authorization: Bearer $OT" -d '{"type":"ROOM_TYPE_VOICE","name":"voice","mediaOverride":{"audioBitrateKbps":64}}' | jq -r .room.id)
curl -s $A/api/rooms/$VOI -H "Authorization: Bearer $OT" | jq -c .room.media
# {"audioBitrateKbps":64,"maxStreamPreset":"SCREEN_SHARE_PRESET_H1080","maxStreams":3}
curl -s -XPOST $A/api/workspaces/$WS/rooms -H "Authorization: Bearer $BT" -d '{"type":"ROOM_TYPE_TEXT","name":"x"}' -w ' %{http_code}\n'   # ERROR_CODE_FORBIDDEN 403
curl -s $A/api/workspaces/$WS/rooms -H "Authorization: Bearer $BT" | jq '[.rooms[].name]'   # ["general","voice"] — secret скрыта
curl -s -w ' %{http_code}\n' $A/api/rooms/$SEC -H "Authorization: Bearer $BT"               # ERROR_CODE_NOT_FOUND 404
# Пускаем Боба в secret, запрещаем members стримить в voice:
curl -s -XPUT $A/api/rooms/$SEC/permissions -H "Authorization: Bearer $OT" -d "{\"overrides\":[{\"targetType\":\"PERMISSION_TARGET_TYPE_ROLE\",\"targetId\":\"member\",\"deny\":\"1\"},{\"targetType\":\"PERMISSION_TARGET_TYPE_USER\",\"targetId\":\"$BID\",\"allow\":\"1\"}]}" | jq '.room.permissionOverrides | length'   # 2
curl -s -XPUT $A/api/rooms/$VOI/permissions -H "Authorization: Bearer $OT" -d '{"overrides":[{"targetType":"PERMISSION_TARGET_TYPE_ROLE","targetId":"member","deny":"64"}]}' >/dev/null
curl -s $A/api/rooms/$SEC -H "Authorization: Bearer $BT" | jq -r .permissions   # "119"
curl -s $A/api/rooms/$VOI -H "Authorization: Bearer $BT" | jq -r .permissions   # "55"  (119 без STREAM=64)
curl -s $A/api/rooms/$VOI -H "Authorization: Bearer $OT" | jq -r .permissions   # "8191" (owner = ADMINISTRATOR: все 13 битов)
curl -s $A/api/workspaces/$WS/rooms -H "Authorization: Bearer $BT" | jq '[.rooms[].name]'   # ["general","secret","voice"]
# Недопустимый override:
curl -s -XPUT $A/api/rooms/$GEN/permissions -H "Authorization: Bearer $OT" -d '{"overrides":[{"targetType":"PERMISSION_TARGET_TYPE_ROLE","targetId":"member","allow":"1024"}]}' -w ' %{http_code}\n'   # ERROR_CODE_VALIDATION 422
# Медиа-дефолты workspace доходят до комнаты без override:
curl -s -XPATCH $A/api/workspaces/$WS -H "Authorization: Bearer $OT" -d '{"defaultMaxStreams":5}' | jq .workspace.mediaDefaults.maxStreams   # 5
curl -s $A/api/rooms/$VOI -H "Authorization: Bearer $OT" | jq .room.media.maxStreams   # 5
```

4.6 Refresh: ротация и reuse detection:
```sh
R1=$(curl -s -XPOST $A/api/auth/refresh -d "{\"refreshToken\":\"$ORT\"}" | jq -r .tokens.refreshToken)   # новый токен (≠ $ORT)
R2=$(curl -s -XPOST $A/api/auth/refresh -d "{\"refreshToken\":\"$R1\"}" | jq -r .tokens.refreshToken)
curl -s -w ' %{http_code}\n' -XPOST $A/api/auth/refresh -d "{\"refreshToken\":\"$ORT\"}"   # ERROR_CODE_INVALID_REFRESH_TOKEN 401 — повтор старого: сессия отозвана
curl -s -w ' %{http_code}\n' -XPOST $A/api/auth/refresh -d "{\"refreshToken\":\"$R2\"}"    # 401 — сессия уже отозвана
curl -s -w ' %{http_code}\n' $A/api/me -H "Authorization: Bearer $OT"                        # "session revoked" 401 — access-токен этой сессии тоже мёртв
```

4.7 Login rate limit (по умолчанию 10 попыток подряд с одного IP):
```sh
for i in $(seq 1 12); do curl -s -o /dev/null -w '%{http_code} ' -XPOST $A/api/auth/login -d '{"email":"owner@example.com","password":"wrong-password"}'; done; echo
# Ожидается: десять 401, затем 429 429
```

4.8 Logout:
```sh
OT2=$(curl -s -XPOST $A/api/auth/login -H 'X-Forwarded-For: 198.51.100.1' -d '{"email":"bob@example.com","password":"password123"}' | jq -r .tokens.accessToken)
curl -s -w '%{http_code}\n' -XPOST $A/api/auth/logout -H "Authorization: Bearer $OT2"     # 204
curl -s -w ' %{http_code}\n' $A/api/me -H "Authorization: Bearer $OT2"                     # 401
```

Остановить сервер: Ctrl+C (ожидается `"msg":"shutting down"` и выход с кодом 0).

#### 5. Docker-образ

```sh
docker build -f apps/server/Dockerfile -t calaba-api:test .
docker images calaba-api:test --format '{{.Size}}'    # ~17MB
```

### 3.2 Gateway, сообщения, файлы, rtc
Предусловия — как в разделе 3.1, шаг 0 (compose.dev поднят целиком, включая `livekit`). Нужны `jq` и Node ≥ 22 (встроенный `WebSocket`).

#### 1. Автотесты

```sh
cd apps/server
go test -race ./...                                   # все ok
make -C ../.. test-integration                        # ok  .../internal/app
go test -tags integration -count=1 -v -run 'TestGateway|TestMessages|TestRTC' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
cd ../..
```

Ожидается:
```
--- PASS: TestGatewayFlow
--- PASS: TestGatewayDeviceLimit
--- PASS: TestMessagesAndFiles
--- PASS: TestRTC
ok
```
Если вместо `PASS: TestRTC` стоит `SKIP` — не поднят LiveKit (`docker compose -f infra/docker/compose.dev.yml up -d livekit`); это ошибка окружения, повтори.

#### 2. Ручной прогон

Сервер (отдельный терминал, чистая БД — см. 3.1, шаг 4.2):

```sh
cd apps/server
DATABASE_URL=postgres://calaba:calaba@localhost:55432/calaba REDIS_URL=redis://localhost:56379/0 \
JWT_SECRET=manual-test-secret-manual-test-secret REGISTRATION_MODE=invite HTTP_ADDR=127.0.0.1:3900 \
STORAGE_PATH=/tmp/calaba-files \
LIVEKIT_URL=ws://localhost:7880 LIVEKIT_INTERNAL_URL=http://localhost:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
go run ./cmd/server
```
Ожидается в логе: `"msg":"listening",...,"storage":"fs","livekit":true`.

Клиент gateway — сохрани как `/tmp/gw.mjs`:

```js
// node /tmp/gw.mjs <access_token> [seconds] [resume_session_id resume_seq]
const [token, secs = '10', resumeId, resumeSeq] = process.argv.slice(2);
const url = (process.env.A || 'http://127.0.0.1:3900').replace(/^http/, 'ws') + '/gateway?v=1&encoding=json';
const ws = new WebSocket(url);
ws.onmessage = (m) => {
  const f = JSON.parse(m.data);
  console.log(JSON.stringify(f));
  if (f.op === 'GATEWAY_OPCODE_HELLO') {
    ws.send(JSON.stringify(resumeId
      ? { op: 'GATEWAY_OPCODE_RESUME', resume: { token, sessionId: resumeId, seq: resumeSeq } }
      : { op: 'GATEWAY_OPCODE_IDENTIFY', identify: { token } }));
    setInterval(() => ws.send(JSON.stringify({ op: 'GATEWAY_OPCODE_HEARTBEAT', heartbeat: {} })), 5000);
  }
};
ws.onclose = (e) => { console.log(JSON.stringify({ closed: e.code, reason: e.reason })); process.exit(0); };
setTimeout(() => process.exit(0), Number(secs) * 1000); // выход без close-кадра: сессию можно RESUME
```

Данные (второй терминал):

```sh
A=http://127.0.0.1:3900
OT=$(curl -s -XPOST $A/api/auth/register -d '{"email":"owner@example.com","password":"password123","displayName":"Owner"}' | jq -r .tokens.accessToken)
WS=$(curl -s -XPOST $A/api/workspaces -H "Authorization: Bearer $OT" -d '{"slug":"team","name":"Team"}' | jq -r .workspace.id)
CODE=$(curl -s -XPOST $A/api/workspaces/$WS/invites -H "Authorization: Bearer $OT" -d '{}' | jq -r .invite.code)
BT=$(curl -s -XPOST $A/api/auth/register -d "{\"email\":\"bob@example.com\",\"password\":\"password123\",\"displayName\":\"Bob\",\"inviteCode\":\"$CODE\"}" | jq -r .tokens.accessToken)
VOI=$(curl -s -XPOST $A/api/workspaces/$WS/rooms -H "Authorization: Bearer $OT" -d '{"type":"ROOM_TYPE_VOICE","name":"voice"}' | jq -r .room.id)
```

2.1 Gateway: READY и событие от REST.
```sh
node /tmp/gw.mjs $BT 3 > /tmp/bob.log & sleep 1
curl -s -XPOST $A/api/rooms/$VOI/messages -H "Authorization: Bearer $OT" -d '{"content":"hi","nonce":"n1"}' | jq -c '.message|{id,content}'
curl -s -o /dev/null -w '%{http_code}\n' -XPOST $A/api/rooms/$VOI/messages -H "Authorization: Bearer $OT" -d '{"content":"hi","nonce":"n1"}'
sleep 3; cut -c1-120 /tmp/bob.log
```
Ожидается: первый POST → `{"id":"…","content":"hi"}`; повтор с тем же nonce → `200` (а не 201). В `/tmp/bob.log` по порядку: `GATEWAY_OPCODE_HELLO` (`heartbeatIntervalMs: 41000`), `DISPATCH` `seq "1"` с `ready`, затем `DISPATCH` с `messageCreate` (ровно один, повтор не рассылается); `presenceUpdate` может встретиться между ними. `seq` строго растут.

2.2 RESUME после обрыва (скрипт вышел без close-кадра):
```sh
SID=$(grep '"ready"' /tmp/bob.log | jq -r .dispatch.ready.sessionId)
SEQ=$(grep -o '"seq":"[0-9]*"' /tmp/bob.log | tail -1 | grep -o '[0-9]*')
curl -s -XPOST $A/api/rooms/$VOI/messages -H "Authorization: Bearer $OT" -d '{"content":"while away"}' >/dev/null
node /tmp/gw.mjs $BT 2 $SID $SEQ | cut -c1-120
```
Ожидается: `HELLO`, затем `messageCreate` с текстом `while away` и `seq` = `SEQ+1`, затем `{"resumed":{"replayed":1}}`.

2.3 RESUME с неизвестной сессией:
```sh
node /tmp/gw.mjs $BT 2 01890000-0000-7000-8000-000000000000 5 | cut -c1-120
```
Ожидается: `HELLO`, затем `GATEWAY_OPCODE_INVALID_SESSION` с `"resumable":false`.

2.4 Сообщения: история и курсор.
```sh
for i in 1 2 3; do curl -s -XPOST $A/api/rooms/$VOI/messages -H "Authorization: Bearer $OT" -d "{\"content\":\"m$i\"}" >/dev/null; done
curl -s "$A/api/rooms/$VOI/messages?limit=2" -H "Authorization: Bearer $BT" | jq -c '{n:(.messages|length), first:.messages[0].content, hasMore}'
```
Ожидается: `{"n":2,"first":"m3","hasMore":true}`.

2.5 Файлы.
```sh
printf 'hello file' > /tmp/a.txt
F=$(curl -s -XPOST $A/api/workspaces/$WS/files -H "Authorization: Bearer $BT" -F file=@/tmp/a.txt)
echo $F | jq -c '.file|{name,mime,size,sha256}'
FID=$(echo $F | jq -r .file.id)
curl -s -XPOST $A/api/rooms/$VOI/messages -H "Authorization: Bearer $BT" -d "{\"content\":\"see file\",\"attachmentIds\":[\"$FID\"]}" | jq -c '.message.attachments[0].name'
curl -s -H "Authorization: Bearer $OT" -H 'Range: bytes=0-4' $A/api/files/$FID -w ' %{http_code}\n'
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $OT" -H "If-None-Match: \"$(echo $F | jq -r .file.sha256)\"" $A/api/files/$FID
head -c 60000000 /dev/zero > /tmp/big.bin; curl -s -XPOST $A/api/workspaces/$WS/files -H "Authorization: Bearer $BT" -F file=@/tmp/big.bin -w ' %{http_code}\n'
```
Ожидается: `{"name":"a.txt","mime":"text/plain","size":"10","sha256":"<64 hex>"}`; `"a.txt"`; `hello 206`; `304`; для 60 MB — `ERROR_CODE_FILE_TOO_LARGE … 413`.

2.6 Voice: join и webhook.
```sh
curl -s -XPOST $A/api/rooms/$VOI/join -H "Authorization: Bearer $BT" | jq -c '{url,identity,canSpeak,canStream,media}'
curl -s -XPOST $A/api/rtc/webhook -d '{}' -w ' %{http_code}\n'
curl -s -XPATCH $A/api/voice/self -H "Authorization: Bearer $BT" -d '{"muted":true}' -w ' %{http_code}\n'
```
Ожидается: `{"url":"ws://localhost:7880","identity":"<user>:<session>","canSpeak":true,"canStream":true,"media":{"audioBitrateKbps":32,"maxStreamPreset":"SCREEN_SHARE_PRESET_H1080","maxStreams":3}}`; webhook без подписи → `ERROR_CODE_UNAUTHENTICATED … 401`; `voice/self` без подключения к LiveKit → `ERROR_CODE_CONFLICT … 409` (голосовое состояние появляется только из webhook LiveKit; полный цикл webhook покрыт `TestRTC`).

2.7 Graceful shutdown: при открытом `node /tmp/gw.mjs $BT 30` нажми Ctrl+C в терминале сервера. Ожидается: клиент получает `GATEWAY_OPCODE_RECONNECT` и `{"closed":4000,…}` в течение ~5 с; сервер пишет `"msg":"shutting down"` и завершается с кодом 0.

2.7a Webhook'и dev-LiveKit: запусти сервер через `make dev-server` (порт 3000) и сделай `join` в voice-комнату. В логе сервера появится `"path":"/api/rtc/webhook"` со `"status":200` (событие `room_started`), в `docker logs calaba-dev-livekit-1` — строка `sent webhook`.

2.7b Веб-клиент: refresh в cookie и CSRF (сервер запусти с `PUBLIC_APP_URL=http://localhost:3900` и обращайся по `localhost`, не `127.0.0.1`: `Secure`-cookie curl хранит и отправляет только для https и localhost).
```sh
A=http://localhost:3900; J=/tmp/jar.txt; rm -f $J
curl -s -c $J -XPOST $A/api/auth/login -H 'X-Client: web' -H "Origin: $A" -d '{"email":"owner@example.com","password":"password123"}' | jq -c '{refresh:.tokens.refreshToken, hasAccess:(.tokens.accessToken|length>0)}'
grep calaba_refresh $J | awk '{print $1, $3, $4}'
curl -s -b $J -c $J -XPOST $A/api/auth/refresh -H "Origin: $A" -o /dev/null -w '%{http_code}\n'
curl -s -b $J -XPOST $A/api/auth/refresh -H 'Origin: https://evil.example.com' -w ' %{http_code}\n'
curl -s -b $J -c $J -XPOST $A/api/auth/logout -H "Origin: $A" -w '%{http_code}\n'
curl -s -b $J -XPOST $A/api/auth/refresh -H "Origin: $A" -w ' %{http_code}\n'
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example.com' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' $A/gateway
```
Ожидается:
- `{"refresh":"","hasAccess":true}` (refresh-токена в теле нет);
- `#HttpOnly_localhost /api/auth TRUE` (HttpOnly, путь, Secure);
- `200`;
- `ERROR_CODE_FORBIDDEN … 403`;
- `204`;
- `ERROR_CODE_INVALID_REFRESH_TOKEN … 401` (cookie очищена logout'ом);
- `403` (WS-апгрейд с чужого origin).

Полный сценарий (плюс домен ALT, `Sec-Fetch-Site`, десктопный режим без изменений) — тесты `TestWebCookieAuth` и `TestGatewayOrigin`.

2.8 Остановка чужого стрима модератором и публичный профиль покрыты тестами `TestRTC` (stop-stream → `VOICE_STREAM_STOP{MODERATOR}`, повтор → 404, без MUTE_MEMBERS → 403) и `TestProfileBroadcast` (смена имени приходит участникам workspace как `userUpdate.user` без email/настроек; смена только настроек не рассылается).

#### 3. Docker-образ и healthcheck
```sh
docker build -f apps/server/Dockerfile -t calaba-api:test .   # собирается; образ ~21 MB
docker run -d --rm --name calaba-hc -e HTTP_ADDR=0.0.0.0:3000 \
  -e DATABASE_URL=postgres://calaba:calaba@host.docker.internal:55432/calaba \
  -e REDIS_URL=redis://host.docker.internal:56379/4 -e JWT_SECRET=docker-test-secret-docker-test-secret calaba-api:test
sleep 3; docker exec calaba-hc /server healthcheck; echo "exit=$?"          # exit=0
docker exec -e HTTP_ADDR=127.0.0.1:3999 calaba-hc /server healthcheck; echo "exit=$?"   # ERROR ... connection refused, exit=1
docker rm -f calaba-hc
```

### 3.3 Сценарии API против стенда (HTTPS)

Разделы 3.1 (шаг 4) и 3.2 (шаг 2) выполняются против стенда как есть, с заменами:
- `A=https://app.calab.io`; сервер запускать не нужно; `/readyz` (4.1) — только на хосте: `ssh $H 'curl -s 127.0.0.1:3000/readyz'`; `/metrics` — только на хосте: `ssh $H 'curl -s 127.0.0.1:3000/metrics | grep -c ^calaba_'`.
- БД стенда не пустая, регистрация по инвайтам: регистрировать новых пользователей с `inviteCode` (инвайт владельца — в `.env.accounts`, или создать свой в своём пространстве); шаг «второй пользователь без инвайта → 403» совпадает. Email-ы брать новые (`…@calaba.test` заняты), slug workspace — новый (`team` занят → ожидаемый `409` на первом же создании).
- gateway: `A=$A node /tmp/gw.mjs $BT 4` (скрипт сам меняет `https` → `wss`).
- 2.6: `url` в ответе join — `wss://rtc.calab.ru` (`LIVEKIT_URL`, docs/06 «Домены»), `media` — по настройкам комнаты.
- 4.7 (rate limit) — последним: после него логин с этого IP ~1 мин отвечает 429. Подмена `X-Forwarded-For` не помогает (Caddy перезаписывает заголовок, api видит реальный IP).

Факт 2026-09-25 (все шаги PASS): 4.1–4.8 — ответы и коды как в 3.1; 2.1 HELLO(41000) → READY seq 1 → presenceUpdate → один messageCreate, повтор nonce → 200; 2.2 RESUME → `while away` seq 4, `{"resumed":{"replayed":1}}`; 2.3 INVALID_SESSION `resumable:false`; 2.4 `{"n":2,"first":"m3","hasMore":true}`; 2.5 upload 201, Range `hello 206`, `304`, 60 MB → 413, 20 MB upload через VPN ~1.5 с; 2.6 join → токен, webhook без подписи 401, voice/self до подключения 409.

### 3.4 UI-бэклог (категории, поиск, unfurl, реакции, статус, закрепы, время звонка)

```sh
cd apps/server
go test -race ./internal/unfurl/ ./internal/voice/        # ok
go test -tags integration -count=1 -v -run 'TestCategories|TestSearch|TestUnfurl|TestReactionsPinsStatus|TestVoiceTimes' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: пять строк `--- PASS` (TestVoiceTimes требует dev-LiveKit, иначе `SKIP`) и `ok`.

Что покрыто:
- **Категории**: CRUD, `categoryId` при создании и `PATCH` комнаты, чужая категория → 422, batch-reorder, категории в READY, удаление → `ROOM_UPDATE` с пустой категорией, у member нет прав → 403.
- **Поиск**: стемминг («кошка» находит «Кошки»), точное слово (`deploy`), `VIEW_ROOM` (bob не видит приватную комнату), фильтры `author_id`/`room_id`, курсор `before`, лимиты.
- **Unfurl**: карточка из OG-тегов, кэш (сайт не запрашивается повторно), картинка через прокси с `nosniff`, подделка подписи → 403, не-HTML → 404, ftp → 422. SSRF-блок loopback/private проверяется unit-тестом `TestFetchSSRFAndLimits`: интеграционный тест для локального сайта разрешает loopback только через тестовый хук `Deps.UnfurlAllowAddr`.
- **Реакции**: идемпотентность, `me`, события ADD/REMOVE, «не эмодзи» → 422.
- **Закрепы**: только `MANAGE_MESSAGES`, `MESSAGE_UPDATE` с `pinnedAt` и счётчиками реакций, `GET /pins`.
- **Статус**: `PRESENCE_UPDATE` со статусом, истёкший статус отдаётся пустым.
- **Время звонка**: `joined_at` в `VOICE_STATE_UPDATE`, `voice_started_at` в READY: сохраняется, пока в комнате кто-то есть, и пропадает, когда комната пуста.

Ручная проверка unfurl на реальном сайте (сервер запущен как в 3.2, `$BT` — токен). **Если на машине VPN/прокси в режиме fake-IP** (проверка: `dig +short github.com` отдаёт `198.18.x.x`), без доп. настройки SSRF-фильтр справедливо блокирует все сайты — запусти сервер с `UNFURL_ALLOW_CIDRS=198.18.0.0/15` (только dev).
```sh
curl -s "$A/api/unfurl?url=https%3A%2F%2Fgithub.com" -H "Authorization: Bearer $BT" | jq -c '{title,siteName,img:(.imageUrl|length>0)}'
curl -s -o /dev/null -w '%{http_code}\n' "$A/api/unfurl?url=http%3A%2F%2F127.0.0.1%3A3900%2Fhealthz" -H "Authorization: Bearer $BT"
curl -s -o /dev/null -w '%{http_code}\n' "$A/api/unfurl?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data" -H "Authorization: Bearer $BT"
```
Ожидается:
- карточка GitHub: `title` непустой, `img:true` (нужен выход в интернет);
- `404` — свой loopback не запрашивается;
- `404` — metadata-адрес облака заблокирован.

### 3.5 P0.5 (лимит комнаты, перемещение, ники, гости, AFK)

```sh
cd apps/server
go test ./internal/perm/ ./internal/rtc/ ./internal/gateway/ && pnpm -F @calaba/protocol test   # ok; protocol — 16 тестов
go test -tags integration -count=1 -v -run 'TestUserLimit|TestMoveMember|TestNicknames|TestGuests|TestAFKPresence' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: пять строк `--- PASS` и `ok`. `TestUserLimit` и `TestMoveMember` требуют dev-LiveKit (иначе `SKIP`); `TestMoveMember` идёт ~3 с — реальный LiveKit отвечает на перемещение отсутствующего участника по таймауту.

Что покрыто:
- **Биты прав**: тест-векторы `proto/testdata/permissions.json` (owner = 8191, у member нет MOVE_MEMBERS и MANAGE_NICKNAMES).
- **Лимит**: `409 ERROR_CODE_ROOM_FULL`; админ и второе устройство проходят; лимит для текстовой комнаты и больше 99 → 422.
- **Перемещение**:
  - без MOVE_MEMBERS → 403, цель текстовая → 422, у перемещаемого нет CONNECT в цели → 403;
  - `VOICE_MOVED` + `VOICE_STATE_UPDATE`;
  - в полную комнату: модератор без admin → 409, admin → 204;
  - JSON-тела `MoveParticipant` / `UpdateParticipant` совпадают с proto LiveKit (unit), реальный LiveKit принимает наш запрос (не auth-ошибка).
- **Ники**: свой / чужой, `allowSelfNickname=false`, событие `WORKSPACE_MEMBER_UPDATE`.
- **Гости**:
  - дефолты ссылки, превью без auth;
  - гость (c): TTL сессии 24 ч, видит одну комнату, права 51, пишет в комнату, не может создать workspace, статус и ссылку;
  - веб-cookie и Origin;
  - (b) — роль `guest`, (a) — использование не тратится;
  - `allowGuests=false` → 401, `maxUses` → 404, отзыв;
  - rate limit 5 гостей в час с IP;
  - promote → member;
  - чистка: токен → 401, сообщение сохранено, имя «Гость (удалён)», членства нет.
- **AFK**: `idle` на втором устройстве не перебивает `dnd` и `invisible`; после закрытия первого устройства — `idle`, heartbeat его не сбрасывает.

Ручной сценарий гостя (сервер как в 3.2, `$OT` — токен владельца, `$VOI` — voice-комната):
```sh
CODE=$(curl -s -XPOST $A/api/rooms/$VOI/invites -H "Authorization: Bearer $OT" -d '{}' | jq -r .invite.code)
curl -s $A/api/room-invites/$CODE | jq -c '{roomName,workspaceName,allowGuests}'
curl -s -XPOST $A/api/room-invites/$CODE/join -H 'X-Forwarded-For: 10.9.0.1' -d '{"nickname":"Гость"}' | jq -c '{roomId, isGuest:.me.user.isGuest, hasToken:(.tokens.accessToken|length>0)}'
```
Ожидается:
- `{"roomName":"voice","workspaceName":"Team","allowGuests":true}`;
- `{"roomId":"<$VOI>","isGuest":true,"hasToken":true}`.

### 3.6 Исправления security-ревью (лимиты, brute force, заголовки)

```sh
cd apps/server
go test ./internal/redisx/ ./internal/rtc/ ./internal/gateway/ ./internal/httpx/   # ok
go test -tags integration -count=1 -v -run 'TestAbuseLimits|TestLimiterFailsClosed|TestAPIHeadersAndNullOrigin' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: три строки `--- PASS` и `ok`.

Что покрыто:
- **Workspace**: коды создания `201, 201, 409 WORKSPACE_LIMIT, 429` (+ `Retry-After`), квота нового workspace — из env.
- **Хранилище**: загрузка сверх глобального потолка → `507 STORAGE_FULL`.
- **Login**: 3 неверные попытки с разных IP → 4-я (даже с верным паролем, другим IP и email в другом регистре) → `429` + `Retry-After`.
- **Redis недоступен**: лимитер отвечает `503` (fail closed).
- **`/api/*`**: заголовки `Cache-Control: no-store` и `nosniff`.
- **Gateway**: `Origin: null` без cookie → `101`, с cookie → `403`.
- **Unit**:
  - webhook без `exp` или просроченный больше чем на 5 мин отклоняется;
  - `REDIS_URL` с паролем (`redis://:s3cr%40t@host:6379/0`, `redis://user:pw@…`) разбирается rueidis;
  - `OriginAllowed` с cookie и без.

### 3.7 Исправления код-ревью (H1–H2, M1–M13, L1–L16)

```sh
cd apps/server
go test -race ./...                                                     # все ok
go test -race -tags integration -count=1 -v -run 'TestResumeAcrossInstances|TestJoinRevalidation|TestReconcileAndWebhookRetry|TestReviewFixes' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: четыре строки `--- PASS` и `ok` (нужен dev-LiveKit; `TestReconcileAndWebhookRetry` идёт ~4 с).

Что покрыто:
- **`TestResumeAcrossInstances` (H1)** — два экземпляра gateway на общем Redis:
  - обрыв на A, сообщение в разрыве, RESUME на B → сообщение досылается, затем `RESUMED`;
  - `Shutdown` B → `RECONNECT`, сообщение, RESUME на A → `INVALID_SESSION{resumable:false}`, `IDENTIFY` работает.
- **`TestJoinRevalidation` (H2)**:
  - потерял CONNECT после выдачи токена → удалён из LiveKit;
  - кикнутый → удалён;
  - `user_limit=1` и два одновременных `participant_joined` → в комнате ровно один.
- **`TestReconcileAndWebhookRetry` (M5, M6)**:
  - поздний `track_published` без участника не создаёт состояние;
  - webhook, упавший из-за занятой блокировки, при повторе обрабатывается;
  - reconcile не выкидывает свежий вход, но убирает старый отсутствующий.
- **`TestReviewFixes`**:
  - M11: правка длиннее 4000 символов → 422;
  - M1: web-refresh старой cookie после ротации → 409 без `Set-Cookie`;
  - M7: гость не видит участника вне своих комнат (REST и READY);
  - M8: гость без `ATTACH_FILES` не загружает файл;
  - M12: `PATCH` guest→member → 422;
  - L6: гостевой аккаунт с кодом приглашения → 403;
  - L4: ссылка не снимает явный deny;
  - L9: модератор без админ-битов может переслать оверрайды без изменений, но не удалить чужие;
  - L13: модератор-участник не может трогать владельца;
  - M3: флуд кадрами → 4008.
- **Unit**:
  - `frameBytes` совпадает с `proto.Marshal` кадра, событие кодируется один раз (M13);
  - пауза сохраняет порядок (M2);
  - входной token bucket (M3);
  - гостевая видимость в `wsState` (M7);
  - `events` round trip.

### 3.8 Второй проход ревью (R1–R9)

```sh
cd apps/server
go test ./internal/gateway/                                             # ok
go test -race -tags integration -count=1 -v -run 'TestLocalResumeOrdering|TestLocalResumeInvalidFirst|TestReleaseNotConfirmedForGoneSession|TestAdminMoveIntoFullRoom|TestSoftLimitAndGuestMemberAdd' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: пять строк `--- PASS` и `ok`. `TestReleaseNotConfirmedForGoneSession` идёт ~8 с (ожидание подтверждения передачи и lease).

Что покрыто:
- **`TestLocalResumeOrdering` (R1)**: 6 раундов «обрыв → RESUME на том же хабе под потоком из 40 событий». Каждый `seq` приходит строго по порядку и без пропусков, каждое событие — ровно один раз. На старом writer'е тест падал 3/3, на новом проходит.
- **`TestLocalResumeInvalidFirst` (R4)**: неудачный локальный RESUME → `INVALID_SESSION` в том же сокете, затем `IDENTIFY` в нём же.
- **`TestReleaseNotConfirmedForGoneSession` (R2)**: владелец жив, но сессию уже отпустил → передача не подтверждается → `INVALID_SESSION`.
- **`TestAdminMoveIntoFullRoom` (R3)**: админ переносит участника в полную комнату, и `participant_joined` в ней его не выкидывает.
- **`TestSoftLimitAndGuestMemberAdd` (R7, R8)**:
  - 40 `SUBSCRIBE` подряд → сокет жив, heartbeat отвечает;
  - гость получает синтетический `MEMBER_ADD` и `MEMBER_REMOVE`, когда участник становится видимым или скрытым.
- **Unit**:
  - `TestSkipSurvivesPause` (R6);
  - новый двухуровневый входной лимит (R7).
- **R9**: миграция 00005 — `CREATE INDEX CONCURRENTLY` вне транзакции; применяется в каждом интеграционном прогоне на чистой БД.

### 3.9 Третий проход ревью (B1–B4)

```sh
cd apps/server
go test -race -count=3 -v -run 'TestOverlappingPauses|TestHeldStashOverflowCloses|TestPresenceSoftExempt|TestVisibilityTransitions' ./internal/gateway/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: по три `--- PASS` на каждый из четырёх тестов и `ok`.

Что проверяется:
- **`TestOverlappingPauses` (B1)**: две пересекающиеся паузы, `resume` в прямом и обратном порядке. Порядок всегда `r7,r1,r8,r2`: каждое подготовленное событие встаёт на своё место паузы.
- **`TestHeldStashOverflowCloses` (B3)**: сокет в `hold` (RESUME читает replay), в него шлют больше 256 кадров. Ожидается закрытие `4008`, и ни одного кадра до закрытия.
- **`TestPresenceSoftExempt` (B4)**:
  - `PRESENCE_UPDATE` с новым статусом проходит сверх мягкого лимита;
  - повтор того же статуса и `TYPING` — не проходят.
- **`TestVisibilityTransitions` (B2)**:
  - кэш viewers комнаты сбрасывается при смене роли и overrides;
  - переименование комнаты (`ROOM_UPDATE` без смены overrides и категории) не запускает пересчёт гостевой видимости;
  - смена категории или overrides, а также неизвестная комната — запускают.
- Регрессия: `make test-integration` целиком (включая `TestSoftLimitAndGuestMemberAdd` и `TestLocalResumeOrdering`).

### 3.10 Voice_started_at в событиях, упоминания, уведомления комнаты

```sh
cd apps/server
go test ./internal/messages/ -run TestParseMentions -v 2>&1 | grep -E '^(--- |ok|FAIL)'
go test -race -tags integration -count=1 -v -run 'TestVoiceTimes|TestMentions|TestRoomNotificationSettings' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: `--- PASS` для каждого теста и `ok`. `TestVoiceTimes` пропускается (`SKIP`), если dev-LiveKit не запущен.

Что проверяется:
- **`TestVoiceTimes`**:
  - первый участник в пустой комнате → `ROOM_UPDATE` с `voiceStartedAt`, равным его `joined_at`;
  - переименование комнаты во время звонка → `ROOM_UPDATE` с тем же `voiceStartedAt`;
  - последний вышел → `ROOM_UPDATE` без `voiceStartedAt`.
- **`TestMentions`**:
  - `@<user_id>` и `@everyone` попадают в `GET /api/me/mentions`;
  - код в `` `…` ``, `mail@…`, упоминание себя, своё `@everyone` и упоминание в невидимой (приватной) комнате — не попадают;
  - пагинация `limit` / `before`, фильтр `workspace_id`;
  - правка, убравшая упоминание, и удаление сообщения убирают его из истории, правка с новым упоминанием — добавляет;
  - `after` → 400.
- **`TestRoomNotificationSettings`**:
  - `PUT` `MENTIONS` + `mutedUntil` → ответ, `ROOM_NOTIFICATION_UPDATE` своему устройству, настройки в новом READY (и не видны другому пользователю);
  - `mutedUntil` > 1 года и неизвестный `level` → 422, невидимая комната → 404;
  - `ALL` без `mutedUntil` → сброс, READY пустой.

### 3.11 Серверный mute (`VoiceState.server_muted`)

```sh
cd apps/server
go test -race -tags integration -count=1 -v -run TestServerMute ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: `--- PASS: TestServerMute` и `ok`. Тест пропускается (`SKIP`), если dev-LiveKit не запущен.

Что проверяется:
- участник без `MUTE_MEMBERS` не может ни заглушить другого, ни снять mute с себя (403); `PATCH /api/voice/self {muted:false}` у заглушённого → 403;
- `mute` → `VOICE_STATE_UPDATE` с `server_muted = true`, в grant нет microphone;
- микрофон, опубликованный незаглушённым, сервер глушит (`MutePublishedTrack`);
- флаг сохраняется в READY и после выхода и повторного входа (`can_speak = false`);
- `unmute` (MUTE_MEMBERS) → `server_muted = false`, microphone возвращается в grant, самостоятельный unmute снова разрешён.

### 3.12 Счётчики непрочитанного в READY

```sh
cd apps/server
go test -race -tags integration -count=1 -v -run TestReadStateCounts ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: `--- PASS: TestReadStateCounts` и `ok`.

Что проверяется:
- после маркера bob три сообщения owner'а, из них `@bob` и `@here` → `unread_count = 3`, `mention_count = 2`;
- свои сообщения owner'а не считаются (0 / 0);
- удаление сообщения с `@here` → 2 / 1;
- `PUT …/read` до последнего → 0 / 0.

### 3.13 Смена пароля и email (`PATCH /api/me/password`, `PATCH /api/me/email`)

```sh
cd apps/server
go test -race -tags integration -count=1 -v -run TestChangeCredentials ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: `--- PASS: TestChangeCredentials` и `ok`.

Что проверяется:
- неверный текущий пароль → 403, короткий новый → 422;
- успешная смена → 204: вторая сессия сразу получает 401, текущая работает, вход со старым паролем → 401, с новым → 200;
- email: занятый (в любом регистре) → 409, невалидный → 422, успех → новый email в ответе и `USER_UPDATE {me}` на устройство, вход по новому email;
- шестая проверка пароля за 15 минут → 429 (невалидные запросы не считаются);
- гость → 403 на оба эндпоинта.

### 3.14 Версия и лицензии (`GET /api/version`, образ)

```sh
cd apps/server && go test ./internal/buildinfo/ -v 2>&1 | grep -E '^(--- |ok|FAIL)'
cd ../.. && make third-party-notices && git diff --exit-code apps/server/THIRD-PARTY-NOTICES.txt
docker build -f apps/server/Dockerfile --build-arg VERSION=0.9.0-test --build-arg COMMIT=$(git rev-parse --short HEAD) -t calaba-api:check .
id=$(docker create calaba-api:check); docker export $id | tar -t | grep -E '^(LICENSE|NOTICE|COMMERCIAL-LICENSE.md|THIRD-PARTY-NOTICES.txt)$'; docker rm $id
```
Ожидается:
- unit-тест проходит;
- `make third-party-notices` завершается с кодом 0 (нет GPL/LGPL/AGPL/UNKNOWN), без дрейфа файла;
- в образе четыре файла;
- на запущенном сервере `curl -s localhost:3000/api/version` → `{"version":"…","commit":"…","license":"BUSL-1.1","commercialLicense":"https://gptunnel.ai","attribution":"Powered by GPTunneL","url":"https://gptunnel.ai"}`, в логе `listening` есть `version` и `commit`.

### 3.15 Valkey вместо Redis (ADR-0017)

```sh
docker compose -f infra/docker/compose.dev.yml up -d --remove-orphans     # заменит redis на valkey (новый volume)
docker exec calaba-dev-valkey-1 valkey-cli info server | grep -E 'valkey_version|redis_version'
cd apps/server && go test ./internal/redisx/ -v -run TestVersion 2>&1 | grep -E '^(--- |ok|FAIL)'
cd ../.. && make test-integration 2>&1 | grep internal/app
```
Ожидается:
- `valkey_version:9.x` (и `redis_version:7.2.4` — так Valkey сообщает о совместимости);
- `TestVersion` проходит: Valkey 9 и Redis 7.4 принимаются, Valkey 8 и Redis 7.2 — нет; пароль в ошибке скрыт;
- `ok … internal/app` — весь интеграционный набор против Valkey (presence на `HEXPIRE`, Lua-лимитеры, pub/sub, client-side caching).
- Сервер со старым Redis 7.2 или Valkey 8 не стартует: `need Valkey >= 9.0 or Redis >= 7.4`.

### 3.16 Ревью 4 (M1, M2, L1–L10)

```sh
cd apps/server
go test ./internal/perm/ ./internal/redisx/ ./internal/messages/ && (cd ../.. && pnpm --filter ./packages/protocol test)
go test -race -tags integration -count=1 -v -run 'TestReadStateCounts|TestMentions|TestRoomNotificationSettings|TestServerMute|TestVoiceTimes|TestChangeCredentials' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: всё `ok` / `--- PASS`.

Что проверяется:
- **M1** — `TestReadStateCounts`: комната, которую bob ни разу не открывал, есть в READY с пустым `last_read_message_id`, `unread_count = 2`, `mention_count = 1`.
- **M2** — индексы миграции 00007. Замер на seeded-БД (1M сообщений / 100 комнат / 2 % удалённых / 350k упоминаний / 2k `@everyone`; маркеры 5 и 5000 сообщений назад, у 10 комнат маркера нет): READY-запрос **82 мс → 6 мс** (медиана из 7), буферы **65 269 → 6 603**, в плане только `Index Only Scan` с `Heap Fetches: 0`.
- **L3** — `TestServerMute`: участник с `MUTE_MEMBERS` в комнате (override) получает 403 на mute: нужен уровень workspace.
- **L6** — `TestRoomNotificationSettings`: после скрытия комнаты её настройки пропадают из READY.
- **L8** — вектор `permissions.json` (`MENTION_EVERYONE` = 1<<13 у owner/admin, у member нет); `TestMentions`: `@everyone` от участника без права не попадает в упоминания.
- **L10** — `TestConnectErrorsHidePassword`: ни одна ошибка `redisx.Connect` не содержит пароль.
- **L1/L2/L4/L7/L9** — гонки. Детерминированно они не воспроизводятся, закрыты конструктивно:
  - L1: `pushGrant` после отправки перечитывает флаг и повторяет отправку;
  - L2: проверка self-unmute внутри `voice.Update` под блокировкой;
  - L4: `SELECT password_hash … FOR SHARE` в транзакции создания сессии;
  - L7: `voice.Store.OnCalls` публикует начало и конец звонка под блокировкой;
  - L9: fail closed.

  Регрессия — весь `make test-integration`.

### 3.17 Статус звонка и скрытые превью (P0.6)

```sh
cd apps/server
go test -race -tags integration -count=1 -v -run 'TestEmbedsHidden|TestVoiceStatus' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: два `--- PASS` и `ok`. `TestVoiceStatus` пропускается (`SKIP`), если dev-LiveKit не запущен.

Что проверяется:
- **`TestEmbedsHidden`**:
  - чужой без `MANAGE_MESSAGES` → 403;
  - автор скрывает → `embedsHidden = true`, `editedAt` пуст, `MESSAGE_UPDATE` в комнату и поле в истории;
  - повторный запрос возвращает превью.
- **`TestVoiceStatus`**:
  - не в звонке → 403, > 60 символов → 422, text-комната → 422;
  - участник звонка ставит «  Планёрка  » → сохраняется обрезанным, `ROOM_UPDATE` с `voiceStatus` и `voiceStartedAt`;
  - последний вышел → один `ROOM_UPDATE` без `voiceStartedAt` и с пустым `voiceStatus`, READY тоже без статуса;
  - `MANAGE_ROOM` ставит статус не будучи в звонке, пустая строка очищает.

### 3.18 Тарифы и лимиты, суперадмин (ADR-0024)

```sh
cd apps/server
go test -race -count=1 ./internal/plans/
TEST_REDIS_URL=redis://localhost:56379/1 TEST_RTC_REDIS_DB=13 go test -race -tags integration -count=1 -v -run 'TestPlan|TestAdminPlans' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: 4 `--- PASS` и `ok` (`TestPlanRoomMembersLimit`, `TestPlanMediaCaps` — `SKIP` без dev-LiveKit / `lk`). Проверяется: 6-й в комнате (и владелец) → `409 ROOM_FULL` `reason PLAN_LIMIT`; 1080p → `H720`/15 в `/stream/request`, `/camera/request`, `/join` (`media`, `planLimits`) и `Workspace.plan` в READY; `storage_mb` → `413` c `used`/`limit`; admin: не-суперадмин → 404, поиск (slug/имя/email), 422 на неверный план, `WORKSPACE_UPDATE` с лимитами, журнал; `me.isSuperadmin`, `planContact`.
Вручную: `curl -s localhost:3000/api/version | jq .planContact` → `"mailto:it@gptunnel.ai"`.

Клиент (`feat/plans-client`):
```sh
cd apps/desktop
pnpm exec vitest run src/renderer/lib/plan.test.ts src/renderer/services/plan.test.ts   # замки, тосты, форма CUSTOM
pnpm exec vitest run --config e2e-support/vitest.config.ts -t 'superadmin'             # мок: admin API, лимиты
CALABA_VISUAL_MOCK_PORT=40570 pnpm e2e:visual -g "settings-plan|admin-" --project dark-960
```
Ожидается: всё зелёное, 3 снимка совпадают. Вручную (мок/стенд, free): 1080p в пикере стрима и камере ▾ — с замком, клик → тост «Связаться»; 6-й в комнате → тост «В бесплатном тарифе до 5 человек»; суперадмин: профиль → «Администрирование», смена плана → у участников сразу меняется вкладка «Тариф».

Приостановка и баны (docs/09 #32, ветка `feat/suspend-ban`):
```sh
cd apps/server && TEST_REDIS_URL=redis://localhost:56379/10 go test -tags integration -count=1 -v -run 'TestWorkspaceSuspension|TestWorkspaceBans' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
cd ../desktop && pnpm exec vitest run src/renderer/lib/moderation.test.ts src/renderer/features/people/members.test.ts
pnpm exec vitest run --config e2e-support/vitest.config.ts -t 'suspension|bans'
CALABA_VISUAL_MOCK_PORT=41370 pnpm e2e:visual -g "admin-suspend|settings-bans|workspace-suspended" --project dark-960
```
Ожидается: 2 `--- PASS`, всё зелёное, 3 снимка совпадают. Вручную: суперадмин приостанавливает пространство → у всех плашка (у владельца — причина и «Связаться»), звонок завершается, отправка/голос/инвайты — отказ; «Забанить…» в меню участника → он пропадает, вход по инвайту — «Вход в это пространство для вас закрыт»; «Разбанить» во вкладке «Забаненные».

### 3.19 Запись встреч и GPTunneL (ADR-0025)

```sh
cd apps/server
go test -race -count=1 ./internal/gptunnel/... ./internal/rtc/ ./internal/sealbox/
TEST_REDIS_URL=redis://localhost:56379/6 TEST_RTC_REDIS_DB=5 go test -race -tags integration -count=1 -v -run 'TestRecording' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: 8 `--- PASS` (без dev-LiveKit — `SKIP`, кроме `TestRecordingBucket`). Фейки: GPTunneL (`gptunneltest`: чанки, `Content-Range`, 409/докачка) и Egress (twirp-сервер из `livekit/protocol`). Проверяется: не спарено → `409 NOT_PAIRED`; гость / `allowRecording=false` → 403; дубль → `409 ALREADY_RECORDING`; лимит → `409 RECORDING_LIMIT`; start → `ROOM_RECORDING` ACTIVE и `recordings` в READY → stop → STOPPED → `egress_ended` → карточка UPLOADING → PROCESSING → DONE (`webUrl`), файл удалён; reconcile без webhook; `insufficient_balance`, `device_revoked`, авто-стоп 4 ч / пустой звонок, janitor 7 дней.

**Записи в бакете (`STORAGE_DRIVER=s3`, docs/06 «Записи встреч в S3»):** `TestRecordingBucket` (тот же прогон; LiveKit не нужен) — egress загрузил объект `<ws>/<id>.mp4` → размер из бакета, отправка в GPTunneL кусками по 32 КБ, `done` → аудио во вложении, объект удалён; бакет не отвечает → строка остаётся `recording` до следующего reconcile, а через 30 мин после остановки → `failed` / `recorder_failed`; объекта нет → `failed` / `no_audio`, egress FAILED → `recorder_failed`. Unit: `go test ./internal/recording/ ./internal/rtc/ ./internal/blob/` — оба режима хранилища записей, запрос `StartRoomCompositeEgress` с `s3` через twirp-сервер из `livekit/protocol`, ключ с `STORAGE_S3_KEY_PREFIX`.

**Повтор после ошибки (docs/09 #40):** `TestRecordingRetry` (тот же прогон, `-run TestRecording` → 6 `--- PASS`): доставленная запись `FAILED` → `reupload` = `409 ALREADY_UPLOADED`, `recheck` → PROCESSING, при `failed: internal` и 502 опрос продолжается, затем DONE; не доставленная (`insufficient_balance`) → `recheck` = `409 CONFLICT`, `reupload` → новая запись в GPTunneL (`<id>#1`) → DONE; файл удалён с диска → `409 FILE_GONE` и карточка с `file_gone`; гость — 403, чужая комната — 404, не спарено — `409 NOT_PAIRED`. Клиент: `pnpm -F @calaba/desktop e2e:visual -g "chat-recording"` — у карточки «на балансе не хватает» кнопка «Отправить снова», у «сбой на стороне GPTunneL» — «Проверить снова». Руками (стенд): карточка «Запись не удалась» → «Проверить снова» → «Обработка…» → «Встреча записана».

**Результат и удаление (docs/09 #47, #50, docs/17):** в том же прогоне `TestRecordingResult`: после DONE карточка получает `summary`, `has_transcript`, `audio_until` и вложение `audio/mp4` (`.m4a`), локальный файл удалён; 503 от `/result` повторяется; `GET …/transcript` — участник 200 (реплики, `speaker -1` без разметки), без `VIEW_ROOM` и чужой — 404; старый GPTunneL без методов → `result_state = unavailable`, 404 на транскрипт; через 31 день janitor убирает аудио (карточка без вложения); `DELETE …/recordings/{rid}`: участник без прав — 403, без `VIEW_ROOM` — 404, запустивший — 204 → карточка `deleted_at`/`deleted_by`, файл/транскрипт — 404, `DELETE` в GPTunneL; идущая запись — 409, владелец удаляет чужую.
Клиент: `pnpm -F @calaba/desktop e2e:visual -g "chat-recording|recording-transcript"` (карточка во всю ширину, саммари «Показать всё», «Послушать запись» играет AAC/MP4 6 с, перемотка; транскрипт: поиск «эталоны» → 2, клик по реплике → плеер; удаление с подтверждением) и `e2e:visual:mobile -g "m-chat-recording"`.
Руками (стенд, после выкатки API GPTunneL): записать 1–2 мин → «Готово» → в карточке саммари, «Послушать запись» играет с перемоткой и скоростью, «Полный транскрипт» — спикеры и время, клик по реплике перематывает; «Открыть в GPTunneL» ведёт на `gptunnel.ru`; «…» → «Удалить запись» → «Запись встречи удалена» у всех.

### 3.20 Ачивки (ADR-0061)

```sh
cd apps/server
go test -race -count=1 ./internal/achievements/
go test -race -tags integration -count=1 -v -run 'TestAchievements' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: `TestPrepareAchievement`, `TestFitRect`, `TestAchievements` — PASS (LiveKit не нужен). Проверяется: картинка без прозрачности → 422 `IMAGE_NEEDS_ALPHA`, итог — 512×512 WebP с альфой, объект обрезан по видимой части и по центру; `/api/admin/achievements*` — 404 не-суперадмину, удаление вручённой → 409 `ACHIEVEMENT_IN_USE`, замена картинки — старый URL 404; `GET /api/achievements` с `ETag` → 304; вручение без `MANAGE_MEMBERS` → 403, себе → 422 `SELF_GRANT`, гостю / боту / архивной / пустое «за что» → 422, бот-токен → 403 `BOT_NOT_ALLOWED`; открытка `system.achievement` (автор — получатель) в первой открытой текстовой комнате и в «Упоминаниях» получателя, без текстовых комнат — без открытки; `achievementCount` в `WORKSPACE_MEMBER_UPDATE`; отзыв — счётчик меньше, открытка осталась; гость видит ачивки только видимых ему участников.
Руками (стенд, curl): суперадмин `POST /api/admin/achievements` (multipart `image`, `title`) → вручить `POST /api/workspaces/{id}/members/{userId}/achievements {achievementId, note, announce: true}` → в общем чате системное сообщение, у получателя — упоминание.
Клиент: `pnpm --filter @calaba/desktop exec vitest run src/renderer/lib/achievements.test.ts src/renderer/lib/tilt.test.ts src/renderer/lib/achievementPrepare.test.ts src/renderer/lib/mentions.test.ts src/renderer/features/people/GrantAchievementDialog.test.ts` — PASS. Руками (суперадмин → «Администрирование» → «Ачивки»): добавить PNG с прозрачным фоном (непрозрачный — предупреждение, сервер 422), перетащить в списке — порядок сохраняется; у вручённой «Удалить» неактивна. Меню участника → «Вручить ачивку…»: «Вручить» неактивна без «За что», ⌘↩ вручает → тост «Открыть в чате», в общем чате открытка; у получателя — упоминание и звук. Клик по картинке открытки — просмотр: блик один раз, наклон ≤ 6° за курсором, при уходе — плавно в 0; с «Уменьшить движение» — без эффектов. Профиль: ряд в карточке, секция «Достижения», «×2» при повторе, «⋯ → Отозвать».

---

## 4. Инфра и стенд

Чтение состояния стенда и внешние проверки. Всё, что меняет стенд (деплой, сброс данных, ручной бэкап), — только infra/лид. Обозначения — 0.3.

### 4.1 Деплой (infra)

```sh
infra/docker/sync.sh            # весь стек (rsync в /opt/calaba + deploy.sh)
infra/docker/sync.sh api        # только api (пересборка образа)
```
Ожидается: `Image calaba-api Built`, `Container calaba-… Started/Running`, без ошибок.

Релиз целиком (сервер, веб, лендинг, десктоп через GitHub Actions) — `infra/docker/release.sh <commit>`; только пост-проверки задеплоенного — `infra/docker/release.sh verify <commit>` (docs/06 «Релиз: runbook»). Запускает infra/лид, не тестировщик.

### 4.2 Контейнеры и API

```sh
ssh $H "$DC ps --format '{{.Name}} {{.Status}}'"
ssh $H "$DC logs api | grep -E 'migration applied|listening'"
curl -s $A/healthz; ssh $H 'curl -s 127.0.0.1:3000/readyz'
curl -s $A/api/version   # {"version":"<версия>","commit":"<sha задеплоенного коммита>",…}; commit=unknown — деплой без sync.sh
for p in /readyz /metrics; do curl -s -o /dev/null -w "$p %{http_code}\n" $A$p; done   # оба 404 снаружи
ssh $H 'docker run --rm -v calaba_files_data:/d busybox:1.37 stat -c "%u:%g %a" /d'
```
Ожидается: `calaba-api-1 Up (healthy)`, `caddy-1 Up`, `livekit-1 Up`, `postgres-1 / valkey-1 Up (healthy)`; в логе api `migration applied` (только при первом старте на пустой БД) и `"msg":"listening","addr":"127.0.0.1:3000","registration":"invite","storage":"fs","livekit":true`; `{"status":"ok"}`, `{"postgres":"ok","redis":"ok"}`, `404`; `65532:65532 750`.

### 4.3 Сертификаты и HTTPS

```sh
curl -s  https://rtc.$DOM/                                 # OK
curl -sI http://$D | head -3                             # HTTP/1.1 308 → https://$D/
curl -sI https://rtc.$DOM | grep -i alt-svc               # пусто (HTTP/3 выключен, UDP 443 — TURN)
openssl s_client -connect turn.$DOM:443 -servername turn.$DOM </dev/null 2>/dev/null \
  | grep -E 'subject=|issuer=|Verify return'
# subject=CN=turn.calab.io / issuer=… Let's Encrypt … / Verify return code: 0 (ok)
# все имена: приложение и алиасы; LiveKit и TURN — на calab.io и calab.ru
for d in app.calab.io app.calab.ru meet.gptunnel.ru; do
  echo "$d healthz=$(curl -s -o /dev/null -w %{http_code} https://$d/healthz) metrics=$(curl -s -o /dev/null -w %{http_code} https://$d/metrics) readyz=$(curl -s -o /dev/null -w %{http_code} https://$d/readyz)"
done
echo "rtc=$(curl -s https://rtc.$DOM/) turn=$(openssl s_client -connect turn.$DOM:443 -servername turn.$DOM </dev/null 2>/dev/null | grep -c 'Verify return code: 0')"
# ожидается: для каждого healthz=200 metrics=404 readyz=404; rtc=OK turn=1
ssh $H "$DC logs caddy | grep 'certificate obtained' | grep -o 'identifier\":\"[^\"]*' | sort -u"   # calab.io, app., rtc., turn., releases., meet.gptunnel.ru (только при первом выпуске; позже — openssl s_client выше)
```
`curl https://turn.$DOM` **висит** — это нормально: SNI `turn.*` уходит в layer4 → TURN, HTTP там никто не отвечает.

### 4.4 `/download/` и `releases.calab.io`

```sh
for h in app.calab.io calab.io meet.gptunnel.ru; do curl -s -o /dev/null -w "$h %{http_code} %{redirect_url}\n" https://$h/download/latest.yml; done
                                                                                   # у всех: 302 https://releases.calab.io/latest.yml
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://releases.calab.io/  # 200 text/html (список файлов); до первой публикации — 404
curl -sI https://releases.calab.io/latest.yml | grep -iE '^HTTP|cache-control'      # 200, no-cache (после публикации релиза; до неё — 404)
curl -s https://releases.calab.io/latest-mac.yml | grep -E 'url:|path:' | head -3  # пути вида releases/<версия>/Calab-…
curl -sI https://releases.calab.io/releases/<версия>/<установщик> | grep -iE '^HTTP|cache-control'   # 200, immutable
curl -s -o /dev/null -w '%{http_code}\n' -H 'Range: bytes=0-99' https://releases.calab.io/releases/<версия>/<установщик>   # 206
curl -sI https://app.calab.io/manifest.webmanifest | grep -i content-type          # application/manifest+json
```
Публикация — только GitHub Actions `release.yml` (push тега `v*`) → S3; фиды и `index.html` загружаются последними. Стенд лишь перенаправляет `/download/` (docs/06 «Релизы: GitHub Actions → S3»).

### 4.4a Алиасы `calab.ru` (клиенты до 2.0.0, docs/06 «Домены»)

```sh
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://calab.ru/en/       # 301 https://calab.io/en/
for y in latest.yml latest-mac.yml latest-linux.yml; do
  cmp <(curl -s https://releases.calab.io/$y) <(curl -s https://releases.calab.ru/$y) && echo "$y same"; done   # same ×3
curl -s https://releases.calab.ru/latest-mac.yml | grep -cE '(url|path): *https?:'  # 0 (только относительные пути)
for h in app.calab.ru/healthz rtc.calab.ru/ rtc.calab.io/; do curl -s -o /dev/null -w "$h %{http_code}\n" https://$h; done   # 200 ×3 (rtc: OK от LiveKit)
```
Десктоп 1.x с сервером `https://app.calab.ru`: обновляется до 2.0.0 и **остаётся** на `app.calab.ru` (без выхода из аккаунта, «Настройки → Сервер» не изменился); голос подключается (DevTools: нет `Refused to connect`). Чистая установка 2.0.0: сервер по умолчанию `https://app.calab.io`, голос подключается.

### 4.5 LiveKit

```sh
ssh $H "$DC logs livekit | grep -E 'using external IPs|Starting TURN|starting LiveKit' | tail -3"
ssh $H "$DC logs --since 30m livekit | grep -c 'failed to send webhook'"      # 0 (api принимает webhook)
ssh $H "ss -lntup | grep -E 'livekit|caddy'"
```
Ожидается:
- `using external IPs … ["141.105.69.177/141.105.69.177"]` — только публичный IP (docker-мосты 172.16/12 исключены).
- `Starting TURN server … "turn.portTLS":5349,"turn.externalTLS":true,…,"turn.portUDP":443`
- `starting LiveKit server … "bindAddresses":["127.0.0.1"],"rtc.portTCP":7881,"rtc.portUDP":{"Start":7882,…},"portPrometheus":6789`
- порты: udp `141.105.69.177:7882`, udp `*:443`, tcp `127.0.0.1:7880`, `127.0.0.1:6789`, `*:7881`, `*:5349` (5349 снаружи закрыт файрволом); caddy — tcp `*:80`, `*:443`.

Файрвол (только чтение!): `ssh $H 'iptables -L INPUT -n --line-numbers'` — ACCEPT tcp 80/443/7881 и udp 443/7882 стоят **выше** `DROP all`.

**Запись встреч — smoke (ADR-0025):** `ssh $H "$DC ps egress recordings-init"` — egress `Up`, init `Exited (0)`; `ssh $H "$DC logs --since 10m egress | grep -iE 'error|redis' | tail"` — без ошибок подключения к Redis; `ssh $H "$DC logs livekit | grep -i redis | tail -2"` — LiveKit с Redis. В приложении: пространство → GPTunneL → код → «Подключено»; двое в комнате → «Запись встречи» → у обоих REC; через 1–2 мин «Остановить» → в чате карточка «Загружается» → «Обрабатывается» → «Открыть в GPTunneL»; `ssh $H "docker exec calaba-api-1 ls /data/recordings/*/"` — после DONE (и забора результата) файла на volume нет, аудио — вложение карточки.

### 4.6 Voice end-to-end (токен от API → LiveKit → webhook → gateway)

`lk room join` не умеет входить с готовым токеном, поэтому используем `infra/docker/tools/relay-check.html` с токеном из `POST /api/rooms/{id}/join`:
```sh
J=$(curl -s -XPOST $A/api/rooms/$VOI/join -H "Authorization: Bearer $BT")
mkdir -p /tmp/rc && cp infra/docker/tools/relay-check.html /tmp/rc/ && echo $J | jq -r .token > /tmp/rc/token.txt
(cd /tmp/rc && python3 -m http.server 8765 --bind 127.0.0.1) &
A=$A node /tmp/gw.mjs $OT 60 > /tmp/owner.log &                     # наблюдатель — владелец
open "http://127.0.0.1:8765/relay-check.html?run=1#url=wss://rtc.$DOM&tokenfile=token.txt&mode=any"
# ~15 с спустя:
jq -c 'select(.dispatch.voiceStateUpdate)|.dispatch.voiceStateUpdate.state|{roomId,muted}' /tmp/owner.log
curl -s -XPATCH $A/api/voice/self -H "Authorization: Bearer $BT" -d '{"muted":true}' -w '%{http_code}\n'
ssh $H "$DC logs --since 2m api | grep rtc/webhook | grep -o '\"status\":[0-9]*' | sort | uniq -c"
# закрыть вкладку, ~5 с:
jq -c 'select(.dispatch.voiceStateUpdate)|.dispatch.voiceStateUpdate.state|{roomId}' /tmp/owner.log | tail -1
```
Ожидается: `voiceStateUpdate` с `roomId` = `$VOI` (`muted:true` — страница ничего не публикует); `voice/self` → `204`; webhook-и от LiveKit → `"status":200` (с `127.0.0.1`); после закрытия вкладки — `voiceStateUpdate` с `roomId:""`; `voice/self` снова `409`.

Факт 2026-09-25: всё так (join → webhook 200 → voiceStateUpdate, leave → `roomId:""`).

### 4.7 Нагрузочный тест медиа (`lk`)

```sh
brew install livekit-cli
eval "$(ssh $H 'grep ^LIVEKIT_API_ /opt/calaba/infra/docker/.env' | sed 's/^/export /')"   # ключи не светить
export LIVEKIT_URL=wss://rtc.$DOM
lk room create --empty-timeout 600 loadtest      # auto_create выключен — комнату создаём сами (обычно это делает API при join)
lk load-test --room loadtest --audio-publishers 2 --video-publishers 1 --subscribers 3 --duration 30s
lk room delete loadtest
```
Ожидается: `Total 9/9`, `Pkt. Loss 0 (0%)` (допустимо < 1%), аудио ~20 kbps на трек, видео (simulcast) ~1.2–1.3 Mbps на подписчика.

### 4.8 Принудительный relay (TURN/UDP и TURN/TLS)

Как в 4.6, но токен — `lk token create --join --room loadtest --identity relay-check --valid-for 1h | grep -oE 'eyJ[A-Za-z0-9._-]+'` (или из API join), источник медиа — `lk load-test --room loadtest --audio-publishers 1 --video-publishers 1 --subscribers 0 --duration 5m &`, и `mode=tls` / `mode=udp`.

Ожидается через ~30 с:
- `mode=tls`: `setConfiguration iceServers: [["turns:turn.calab.io:443?transport=tcp"]]`, `PASS [{"local":"relay",…,"relayProtocol":"tls",…,"bytesIn":<растёт>}]`; на сервере `ss -tn '( dport = :5349 )'` — соединения `127.0.0.1:* → 127.0.0.1:5349` (Caddy layer4 → LiveKit TURN).
- `mode=udp`: `turn:141.105.69.177:443?transport=udp`, `PASS [{"local":"relay",…,"relayProtocol":"udp",…}]`.
- `mode=any`: `"local":"host"|"srflx"|"prflx","protocol":"udp"`, remote `141.105.69.177:7882/udp`.

Факт 2026-09-25: TLS — PASS (relay/tls, RTT ~40 мс, ~5.9 MB за 30 с); UDP — PASS (relay/udp, ~5.8 MB); без ограничений — prflx/udp → :7882.

ICE/TCP (7881) без блокировки UDP не проверить. Вручную (нужен админ на клиенте или сеть без UDP):
1. Заблокировать исходящий UDP к 141.105.69.177 (macOS: `pf` `block out proto udp to 141.105.69.177`; Windows: правило брандмауэра; либо сеть/VPN «только TCP»).
2. Войти в голосовую комнату в десктоп-приложении, открыть панель статистики соединения.
3. Ожидается: протокол кандидата `tcp` (ICE/TCP 7881); если открыт только 443 — `relay` + `tls`. Звук идёт, в UI — пометка «через relay/TCP».
4. Снять блокировку — после переподключения снова `udp`.

### 4.9 Чужие процессы и ресурсы

```sh
ssh $H 'ps -p 3695 -o pid,etime; docker ps --format "{{.Names}} {{.Status}}" | grep -v ^calaba; echo ffmpeg $(pgrep -c ffmpeg) chromium $(pgrep -c chromium) xvfb $(pgrep -c Xvfb)'
ssh $H 'docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" | grep -E "NAME|calaba"'
```
Ожидается: pid 3695 жив (etime не сбросился), `gromtv-broadcast Up …`, `dcgm-exporter Up …`, ffmpeg/chromium/Xvfb ≥ 1.
Факт 2026-09-25 (простой после тестов): api ~79 MiB, livekit ~90 MiB, postgres ~39 MiB, caddy ~16 MiB, redis (сейчас valkey) ~10 MiB; CPU < 2 %.

### 4.10 Защита (security review 2026-09-26)

```sh
# контейнеры: read-only, без capabilities, no-new-privileges
ssh $H 'for c in api caddy valkey postgres; do docker inspect -f "$c ro={{.HostConfig.ReadonlyRootfs}} drop={{.HostConfig.CapDrop}} add={{.HostConfig.CapAdd}} user={{.Config.User}}" calaba-$c-1; done'
# valkey: пароль, noeviction, 512mb; пароль не виден в ps
ssh $H 'docker exec calaba-valkey-1 valkey-cli ping; docker exec calaba-valkey-1 sh -c "VALKEYCLI_AUTH=\$REDIS_PASSWORD valkey-cli config get maxmemory-policy"; ps -eo args | grep -c "[r]equirepass"'
# заголовки
curl -sI $A/ | grep -i strict-transport; curl -sI $A/api/me | grep -iE 'cache-control|nosniff|referrer'; curl -sI https://rtc.$DOM/ | grep -i strict
# регистрация закрыта
curl -s -w ' %{http_code}\n' -XPOST $A/api/auth/register -d '{"email":"x@example.com","password":"password123","displayName":"X"}'
# TURN relay ограничен (счётчики растут только при злоупотреблении); IPv6 INPUT DROP
ssh $H 'iptables -L OUTPUT -n -v | grep calaba-turn; ip6tables -S INPUT | head -1'
```
Ожидается: все четыре `ro=true drop=[ALL]`, caddy `add=[CAP_NET_BIND_SERVICE]`, valkey `user=999:1000`, postgres `user=70:70`, api `user=65532`; `NOAUTH Authentication required.`, `noeviction`, `0`; `strict-transport-security: max-age=31536000; includeSubDomains` на `$D` и `rtc.$DOM`; на `/api/me` — `cache-control: no-store`, `x-content-type-options: nosniff`, `referrer-policy: same-origin`; регистрация → `ERROR_CODE_REGISTRATION_CLOSED … 403`; два правила `calaba-turn-relay`; `-P INPUT DROP`.
Relay-check TLS/UDP (4.8) после ограничения — PASS (факт 2026-09-26: relay/tls и relay/udp, ~5 MB за 30 с, счётчики правил не выросли).

Проба relay (только для повторной проверки, делает infra): pion-клиент с кредами из JoinResponse → `CreatePermission` к `127.0.0.1`/`10.0.0.1` должен давать 403 (LiveKit), отправка на `141.105.69.177:<не 7882>` и на внешние адреса — дропаться правилами (слушатель на хосте ничего не получает). Никогда не целиться в порты соседа (9001/9002/54241/33621).

### 4.11 Бэкапы

```sh
ssh $H 'systemctl list-timers calaba-backup.timer --no-pager | sed -n 2p; journalctl -u calaba-backup.service -n 5 --no-pager -o cat; ls -lt /opt/calaba/backups/*/ | head -20'
ssh $H '/opt/calaba/infra/docker/backup/restore.sh test'       # восстановление в calaba_restore_test + сравнение + drop
ssh $H 'systemctl start calaba-backup.service'                  # внеочередной бэкап (например, перед миграцией)
```
Ожидается: таймер на ближайшие 03:30; в журнале `pg ok`, `files ok`, `WARNING: no OFFSITE_RCLONE_REMOTE` (пока нет offsite), `done …`; в каталогах `pg/ files/ caddy/ config/` свежие файлы; `restore test`: `tables restored: N`, `row counts: identical to live DB` (или diff, если данные менялись после дампа), `restore test OK (calaba_restore_test dropped)`.
Факт 2026-09-26: 12 таблиц, счётчики совпали; архив файлов распакован и сравнён `diff -r` с volume — идентично (7 файлов, владелец 65532).

### 4.12 Известные особенности

- В логах Caddy `caddy.listeners.layer4 … matching connection … EOF` — сканеры/обрывы до ClientHello, не ошибка.
- `room.auto_create: false`: комнату в LiveKit создаёт API при join (или `lk room create` в тестах); иначе `requested room does not exist`. После ухода всех участников комната удаляется (`departure_timeout` 20 с).
- Webhook-и от LiveKit идут на `http://127.0.0.1:3000/api/rtc/webhook`; тот же путь снаружи доступен через Caddy, но без подписи LiveKit → 401.

---

## История (устаревшее — не выполнять)

Промежуточные состояния и факты прошлых доменов (`colaba.gptunnel.*`, `.ai`), оставлены для справки.

<details><summary>Desktop media spike (этап 1) — заменён приложением</summary>

Экран спайка удалён: медиа-пайплайн (AEC3 → RNNoise/VAD, PTT, AV1 simulcast, getStats) теперь работает внутри приложения. Результаты замеров спайка — в docs/02, раздел «Результаты спайка». Ручные медиа-проверки — в разделе «Desktop app» ниже, пункты 2.12–2.25 и 4.

</details>

<details><summary>Веб на стенде, 2026-09-26 (обход VPN для `.ai`)</summary>

Если падает на `page.goto: net::ERR_TUNNEL_CONNECTION_FAILED` / `NS_ERROR_CONNECTION_REFUSED`, а `curl --resolve app.calab.io:443:141.105.69.177 https://colaba.gptunnel.ai/readyz` даёт 200 — это локальный VPN/прокси (fake-IP DNS, особые правила для `gptunnel.ai`), а не стенд. Обход для прогона: Chromium — `--host-resolver-rules=MAP colaba.gptunnel.ai 141.105.69.177 --proxy-server=direct://`, Firefox — prefs `network.proxy.type=0`, `network.dns.forceResolve=141.105.69.177` (через локальный playwright-конфиг, не в репо). Факт 2026-09-26: так `e2e:web` на `.ai` — 2 passed (Firefox с `CALABA_WEB_FF_VOICE=1`), на `.ru` — 2 passed без обхода.

</details>

<details><summary>Веб на стенде, факт 2026-09-25 (домены colaba.gptunnel.*)</summary>

Факт 2026-09-25: все коды/заголовки как выше на обоих доменах; e2e:web — 2 passed на `.ai` (в т.ч. с `CALABA_WEB_FF_VOICE=1`) и на `.ru`; Playwright-прогон «регистрация → голос» в Chromium и Firefox — «Голос подключён», нарушений CSP 0, предупреждения RNNoise нет (Firefox: worklet 200 `text/javascript`). Клиент на `.ru` подключается к `wss://rtc.colaba.gptunnel.ai` (основной `LIVEKIT_URL`).

</details>

<details><summary>Установка до 2026-09-26 (`/download/` на стенде, mac без подписи)</summary>

Сборки публикуются на `https://app.calab.io/download/` (листинг каталога; то же на `.ru`). Какой файл брать:

| ОС | Файл | Установка |
|---|---|---|
| macOS Apple Silicon (M1–M4) / Intel | `Calab-<версия>-arm64.dmg` / `Calab-<версия>-x64.dmg` (не знаете какой —  → «Об этом Mac»: «Чип Apple M…» = arm64) | открыть dmg, перетащить Calab в «Программы». Сборка **не подписана**: первый запуск — ПКМ по приложению → «Открыть» → «Открыть» (или `xattr -dr com.apple.quarantine /Applications/Calab.app`). Автообновление на macOS без подписи не работает — приложение только сообщает о новой версии |
| Windows 10/11 x64 | `Calab-Setup-<версия>-x64.exe` | запустить; SmartScreen «Windows защитила ваш компьютер» → «Подробнее» → «Выполнить в любом случае» (сборка не подписана) |
| Linux x64 (любой дистрибутив) | `Calab-<версия>-x86_64.AppImage` | `chmod +x Calab-*.AppImage && ./Calab-*.AppImage` (нужен FUSE 2: Ubuntu 22.04+ — `sudo apt install libfuse2`; без него: `./Calab-*.AppImage --appimage-extract-and-run`) |
| Debian/Ubuntu x64 | `calab_<версия>_amd64.deb` | `sudo apt install ./calab_*_amd64.deb`, запуск — «Calab» в меню или `calab` |

После запуска — в поле «Сервер» ввести `https://app.calab.io` (или `.ru`), войти (регистрация — по коду приглашения, см. 0.2).

Проверка целостности (если скачано с ошибками): `latest-mac.yml` / `latest-linux.yml` / `latest.yml` рядом содержат `sha512` (base64) и `size` каждого файла: `shasum -a 512 -b <файл> | cut -d' ' -f1 | xxd -r -p | base64` (macOS/Linux) должно совпасть.

Сборка (infra, не тестировщик): `apps/desktop/scripts/build-release.sh` — docs/06 «Релизы десктопа: сборка»; публикация — только GitHub Actions `release.yml` (push тега `v*`) → S3 → `https://releases.calab.io/`; `/download/` на стенде — редирект туда (docs/06 «Релизы: GitHub Actions → S3», «Релиз: runbook»).

</details>

<details><summary>Сертификаты, Факт 2026-09-25: все 6 имён</summary>

Факт 2026-09-25: все 6 имён — сертификаты LE (YE1), `readyz` 200, `/metrics` 404, `rtc` OK, TURN TLS `Verify return code: 0`.

</details>

<details><summary>Сертификаты, С 2026-09-26 приложение — на с</summary>

С 2026-09-26 приложение — на самом домене (`https://colaba.gptunnel.ai`, `https://colaba.gptunnel.ru`), имена `app.colaba.*` удалены из DNS и не обслуживаются. Факт 2026-09-26: сертификаты на `colaba.gptunnel.ai/.ru` (LE YE1), `readyz`/`healthz` 200, http → 308, SPA и ассеты как в 2a; внешняя проверка (check-host.net, узлы IR/RO/US) — 200.

</details>

<details><summary>`/download/` на стенде до S3 (2026-09-26, статика в `/srv/releases`)</summary>

```sh
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://$D/download/     # 200 text/html (листинг; пустой, пока релизов нет)
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://$D/download      # 308 https://$D/download/
curl -sI https://$D/download/latest-mac.yml | grep -iE 'content-type|cache-control'  # text/yaml, no-cache (когда релиз опубликован)
curl -sI https://$D/download/<установщик с версией> | grep -iE 'content-type|cache-control'   # application/octet-stream, immutable
curl -s -o /dev/null -w '%{http_code}\n' -H 'Range: bytes=0-99' https://$D/download/<установщик>   # 206
curl -sI https://$D/manifest.webmanifest | grep -i content-type                    # application/manifest+json (когда он есть в веб-сборке)
```
Публикация: собрать релиз в `apps/desktop/dist-release/`, затем `infra/docker/sync.sh` (или `SKIP_WEB=1 infra/docker/sync.sh`, чтобы не трогать веб). Старые файлы на стенде не удаляются.

Факт 2026-09-26 (на временных тестовых файлах, удалены): `/download/` 200 (пустой листинг), `/download` 308; `latest-mac.yml` — `text/yaml`, `no-cache`; `*.dmg` — `application/octet-stream`, `immutable`, Range → 206; `*.json` — `no-cache`; `*.webmanifest` — `application/manifest+json`; `*.svg` — `image/svg+xml`; отсутствующий файл — 404. На `.ai` и `.ru`.

</details>

<details><summary>Нагрузочный тест, факт</summary>

Факт 2026-09-25 (с мака через VPN, `wss://rtc.colaba.gptunnel.ai`, 20 с): 9/9, потерь 0 (0%), 3.7 Mbps суммарно.

</details>

## Server: перемещение без SFU-move (хотфикс 0.1.1, ADR-0019)

Нужны dev-LiveKit и `lk` CLI (`brew install livekit-cli`); без них — `SKIP`. Фейков нет: тест идёт против настоящего open-source LiveKit, который на `MoveParticipant` отвечает `not implemented`.

```sh
cd apps/server
go test -race -tags integration -count=1 -v -run TestMoveAppLevel ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)|no MoveParticipant'
```
Ожидается: строка лога `LiveKit has no MoveParticipant: moving participants at app level (ADR-0019)`, `--- PASS: TestMoveAppLevel` (~16 с) и `ok`.

Что проверяется:
- **Подготовка.** Устройство bob — настоящий участник исходной комнаты (`lk room join`).
- **`VOICE_MOVED`.** После move bob получает событие с `url`, `token`, своим `session_id` и `identity`; остальные получают `VOICE_STATE_UPDATE` с целевой комнатой.
- **Токен рабочий.** Подключение к signal-эндпоинту LiveKit (`/rtc?access_token=…`) с ним даёт `JoinResponse`: целевая комната, та же identity, `canSubscribe`.
- **Старая комната.** Через 5 с участника bob в исходной комнате LiveKit нет, хотя `lk` оставался подключён.
- **Откат.** Устройство carl, которое к цели так и не подключилось, через 15 с откатывается (`VOICE_STATE_UPDATE` с пустой комнатой); bob остаётся в целевой.

## Приёмка 0.1.1 (хотфикс десктопа и веба)

Что вошло в 0.1.1:
- плашка «Нет соединения с сервером — переподключаемся…»;
- диалог «Присоединиться к пространству»;
- обводка сообщения при фокусе с клавиатуры;
- шаг «Уведомления» в онбординге;
- закрытие gateway с кодом 4008;
- перемещение участника между голосовыми комнатами.

Сценарии H.1–H.6 независимы, выполнять можно в любом порядке.

**Где что брать:**
- Веб — `https://app.calab.io`, аккаунт из раздела 0.2.
- Десктоп — собранное приложение (раздел 2.1) или dev-сборка (2.2/2.6).
- Лог десктопа — `<профиль>/logs/main.log`. Лог веба — консоль DevTools, строки `[gateway] …`.

**Правило для общего Mac:** Wi-Fi не выключать и сеть не переключать — это рвёт связь другим агентам. Сетевые шаги (H.1.5) — только на отдельной машине.

**Автотесты перед ручной частью** (все должны быть PASS):
```sh
cd apps/desktop
npx vitest run src/renderer/lib/gateway/ src/renderer/services/links.test.ts src/renderer/services/voice.test.ts
```

### H.1 Плашка «Нет соединения с сервером — переподключаемся…»

Правило:
- плашка появляется только если связь с сервером пропала **больше чем на 3 с** после того, как приложение уже было подключено;
- исчезает сразу, как только связь восстановлена;
- при первом подключении (запуск, вход) плашки нет — вместо неё полноэкранный спиннер.

Предусловие для H.1.1–H.1.3: локальный API (раздел 2.2), собранный в бинарник, чтобы перезапуск был быстрым:
```sh
cd apps/server && go build -o /tmp/calaba-api ./cmd/server
# запускать с теми же переменными окружения, что в 2.2:
/tmp/calaba-api &
```
Клиент (десктоп или веб) вошёл и открыл любую комнату.

| # | Действие | Ожидается |
|---|---|---|
| H.1.1 | Короткий обрыв: `kill %1; /tmp/calaba-api &` (перезапуск меньше 1–2 с) | Плашка **не появляется** вообще, в том числе через 5 с после восстановления (проверяет, что старый таймер не срабатывает). В логе `[gateway] closed …`, затем RESUME или IDENTIFY. Сообщение, отправленное со второго клиента сразу после перезапуска, приходит |
| H.1.2 | Длинный обрыв: `kill %1`, подождать 10 с, `/tmp/calaba-api &` | Примерно через 3 с после остановки — жёлтая полоса «Нет соединения с сервером — переподключаемся…». После запуска API полоса исчезает сразу, как только клиент переподключился (обычно ≤ 2 с после старта API), без дополнительной задержки |
| H.1.3 | Остановить API, **потом** запустить клиент (или выйти и войти заново) | Полноэкранный спиннер подключения, полосы нет. После запуска API — обычный экран |
| H.1.4 | Сон вкладки (веб, Chrome): открыть `chrome://discards`, у вкладки Calab нажать «Freeze», подождать 2 мин (сервер за это время закроет сессию по heartbeat), вернуться на вкладку. Десктоп: усыпить Mac на 2+ мин и разбудить | Не позже чем через 5 с после возврата на вкладку или пробуждения — снова «в сети»: полоса, если и появилась, исчезла, новые сообщения приходят. Пропущенные за время сна сообщения на месте. В логе `[gateway] wake: … reconnecting now` или `wake: probing the socket` (веб), `force reconnect` (десктоп после сна) |
| H.1.5 | **Только на отдельной машине.** Сменить сеть: другой Wi-Fi или включить/выключить VPN | Восстановление ≤ 5 с после появления новой сети. Полоса — не дольше этого времени |
| H.1.6 | Лежащий сервер + переключение окон: остановить API на 60 с и всё это время часто переключаться между окном Calab и другим окном (или вкладками) | В логе не больше одного `wake: no socket, reconnecting now` за 30 с. Между ними обычные `reconnect in N ms (attempt K)` с растущей задержкой — шторма переподключений нет. После запуска API клиент возвращается сам |

### H.2 Диалог «Присоединиться к пространству»

Открыть: кнопка «Обзор» в левой колонке пространств (или «Присоединиться» на экране без пространств).

| # | Действие | Ожидается |
|---|---|---|
| H.2.1 | Посмотреть на поле | Подпись поля «Ссылка или код приглашения». Плейсхолдер строится от адреса сервера: на вебе `https://app.calab.io/join/AbC123xYz` (адрес текущей страницы), на десктопе — адрес сервера, куда выполнен вход (например, `http://localhost:3000/join/AbC123xYz`) |
| H.2.2 | Ввести `abc`, затем `https://example.com/foo` | Кнопка «Присоединиться» неактивна, Enter ничего не делает, превью нет |
| H.2.3 | Ввести `AbC123xYz` (правильная форма, но такого приглашения нет) | «Приглашение не найдено или истекло». Кнопка неактивна, Enter ничего не делает |
| H.2.4 | Создать приглашение (меню пространства → «Пригласить людей» → «Создать приглашение»). Вставить его ссылку `https://app.calab.io/join/<код>` вторым аккаунтом. Затем то же с голым `<код>` и с `calab://join/<код>` | Во всех трёх случаях появляется превью с названием пространства, кнопка активна. Enter или кнопка — вход в пространство, диалог закрывается |
| H.2.5 | Вставить ссылку на комнату `https://app.calab.io/r/<код>` | Превью комнаты, как до 0.1.1 (регрессии нет) |
| H.2.6 | Сервер без открытых пространств | Ни заголовка «Открытые пространства», ни текста «Открытых пространств нет», ни спиннера под полем |
| H.2.7 | В настройках своего пространства поставить «Доступ» → «Открытое», открыть диалог вторым аккаунтом | Заголовок «Открытые пространства» и список с этим пространством |

### H.3 Обводка сообщения (фокус)

Комната с несколькими сообщениями: свои и чужие, последнее в группе — с «хвостиком».

| # | Действие | Ожидается |
|---|---|---|
| H.3.1 | Щёлкнуть мышью по тексту сообщения, затем нажать ⌘C / Ctrl+C или стрелку | Вокруг сообщения нет ни прямоугольной рамки, ни синего кольца |
| H.3.2 | Выделить мышью часть текста сообщения, скопировать, вставить в поле ввода | Выделение работает, копируется ровно выделенное |
| H.3.3 | Правый клик по сообщению → Esc | Контекстное меню открывается и закрывается. После закрытия кольца вокруг сообщения нет |
| H.3.4 | Перетащить файл из Finder / Проводника на ленту | Загрузка файла работает, как раньше |
| H.3.5 | Щёлкнуть в поле ввода, затем Shift+Tab / Tab до сообщений | Сфокусированное сообщение слегка подсвечено цветом акцента. Синее кольцо ~2 px идёт **по форме пузыря**: скругления и хвостик, а не прямоугольником. Рядом панель действий. Текст и время на подсветке читаются, в светлой и тёмной теме. Смайлик-«стикер» (сообщение из одних эмодзи) — обычная обводка |

### H.4 Шаг «Уведомления» в онбординге

Онбординг показывается при первом входе в профиле:
- веб — новое окно инкогнито или новый профиль браузера;
- десктоп — новый `CALABA_USER_DATA=/tmp/cal-new`.

Шаг «Уведомления» идёт после «Микрофон» и «Режим» («Позже» / «Продолжить»).

Автотест веба (mock, раздел 1.2): `npx playwright test --config playwright.web.config.ts notifications` → PASS.

| # | Действие | Ожидается |
|---|---|---|
| H.4.1 | Веб, разрешение сайта «Спрашивать» (по умолчанию) | Кнопки «Позже» и «Включить уведомления». **Нет** жёлтого предупреждения «Браузер не разрешает…» |
| H.4.2 | Нажать «Включить уведомления» → «Разрешить» в запросе браузера | Зелёная строка «Уведомления включены», кнопка «Продолжить». На итоговом шаге «Уведомления» — включены |
| H.4.3 | Новое инкогнито-окно, в запросе браузера выбрать «Блокировать» (или заранее заблокировать уведомления для сайта) | Жёлтое предупреждение «Браузер не разрешает уведомления для этого сайта…», одна кнопка «Продолжить без уведомлений» |
| H.4.4 | Десктоп (новый профиль) | Кнопки «Позже» и «Включить уведомления», без предупреждения. Нажать → «Уведомления включены», приходит системное уведомление «Calab / Уведомления включены». На macOS при первом разе система спрашивает разрешение |

### H.5 Код 4008: «rate limited» — не экран «Слишком много активных устройств»

Для пользователя это выглядит так: экран «Слишком много активных устройств» появляется **только** при отказе по лимиту устройств (6-е устройство). Закрытие 4008 из-за лимита частоты или переполнения очереди — обычное переподключение с RESUME.

1. Клиент:
   ```sh
   cd apps/desktop && npx vitest run src/renderer/lib/gateway/client.test.ts -t "4008"
   ```
   Ожидается: 3 теста PASS:
   - «too many active devices» до READY → фатально;
   - «rate limited», пустая причина и «send queue overflow» → переподключение;
   - после READY → backoff и RESUME.
2. Строки сервера совпадают с тем, что ждёт клиент:
   ```sh
   grep -n 'closeGraceful(4008\|RATE_LIMITED.*"' apps/server/internal/gateway/*.go
   ```
   Ожидается: только у лимита устройств в причине есть слово `devices` («too many active devices»). У остальных — «rate limited» и «send queue overflow».
3. Лимит устройств по-прежнему работает (Docker):
   ```sh
   cd apps/server && go test -tags integration -count=1 -run TestGatewayDeviceLimit ./internal/app/
   ```
   Ожидается: `ok`.
4. Вручную: в 2.28 / H.1.2 (перезапуск API, RESUME) экрана «Слишком много активных устройств» не бывает.

### H.6 Перемещение участника

Выполнить раздел [M.1 Перемещение участника (два клиента)](#m1-перемещение-участника-два-клиента) (шаги 1–9) и автотест из него. Сверх M.1 в 0.1.1 закрыто юнит-тестами:
- не удалось подключиться по токену перемещения → одна попытка обычного `/join`;
- «Отключиться» во время переподключения → пользователь не возвращается в голос;
- второе перемещение подряд побеждает первое;
- серверный mute переживает переподключение.

Команда из блока ниже (`-t "VOICE_MOVED"`) должна показать `11 passed` (все тесты `VOICE_MOVED (ADR-0019)`).

## Client: перемещение участника (хотфикс 0.1.1, ADR-0019)

Юнит-тесты клиента (фейковый LiveKit):
```sh
cd apps/desktop && npx vitest run src/renderer/services/voice.test.ts -t "VOICE_MOVED"
```
Ожидается: 11 тестов `VOICE_MOVED (ADR-0019)` — PASS (переподключение по токену без `/join`, mute/deafen и серверный mute сохраняются, стрим остановлен + тост; без токена — старый путь с rejoin через 4 с; `leave` до/после события выигрывает; дубли, чужие устройства и перемещение в свою же комнату игнорируются; второе перемещение во время первого побеждает; при отказе токена — один запасной `/join`).

### M.1 Перемещение участника (два клиента)

Сервер с хотфиксом ADR-0019, open-source LiveKit (стенд). Клиент A — администратор (есть `MOVE_MEMBERS`), клиент B — обычный участник; лучше на разных машинах или в разных браузерах (гарнитуры, чтобы не было эха). Обе голосовые комнаты X и Y — в одном пространстве.

1. A и B заходят в голосовую комнату X, говорят — слышат друг друга.
2. A: меню участника B (правый клик по B в списке комнаты) → «Переместить в…» → Y.
   Ожидается:
   - у A: `POST …/move` → 204 (не 503); тост «Участник перемещён»; в списке комнат B переходит из X в Y;
   - у B: в течение ~1 с звонок уже в Y (панель голоса показывает Y, вид переключился на Y, если B смотрел на X); тост «<имя A> переместил(а) вас в «Y»» (или «Вас переместили в «Y»», если имя A неизвестно); звук перемещения; B слышит тех, кто в Y, его слышат в Y; в X B больше нет (через ≤ 5 с его нет и в LiveKit-комнате X);
   - у B состояние микрофона не изменилось.
3. B в Y выключает микрофон и звук (mute + deafen). A перемещает B обратно в X.
   Ожидается: B в X, микрофон и звук по-прежнему выключены (иконки в панели и в списке комнат), B никого не слышит и его не слышно; после включения — снова слышно в обе стороны.
4. Режим PTT у B: перемещение → в новой комнате PTT работает как раньше (без нажатия — тишина).
5. Серверный mute: A заглушает B («Выключить микрофон»), затем перемещает. Ожидается: в новой комнате B по-прежнему заглушён модератором, сам включить не может (тост «Микрофон выключен модератором»).
6. B показывает экран в X, A перемещает B в Y. Ожидается: стрим остановлен (у зрителей в X он пропал), тост у B «… в «Y»; стрим остановлен»; в Y стрим не запускается сам, B может запустить его заново кнопкой.
7. B открыт на двух устройствах, в голосе только одно: переносится только оно; второе устройство событие игнорирует (не подключается к голосу).
8. B нажимает «Отключиться» сразу после перемещения (в пределах ~1 с): B вне голоса, не переподключается в Y; через ~15 с сервер откатывает его voice-state (в списке комнат B нигде нет).
9. Старый сервер (без токена в `VOICE_MOVED`, LiveKit Cloud / до хотфикса): поведение прежнее — комната в панели сразу меняется на Y; если LiveKit не перенёс соединение, через ~4 с клиент сам переподключается к Y через `/join`.

Если что-то не так — у B в логах рендерера строка `voice: moved by a moderator, reconnecting to the target room`, у A — ответ `POST …/move`.

**Автотест шага 2** (`apps/desktop/e2e-web/move.web.spec.ts`, веб-клиент, два браузерных контекста в одном тесте). A заходит, при необходимости создаёт пространство «E2E web» (или `CALABA_WEB_WORKSPACE`) и голосовые комнаты «Созвон» / «Созвон 2»; если B ещё не участник — A создаёт (или переиспользует) бессрочное многоразовое приглашение, B вступает по нему. B входит в «Созвон», включает «Статистика»; A: правый клик по B в списке комнаты → «Переместить в…» → «Созвон 2». Проверяется: `POST …/move` → 204; у B в течение 10 с — тост «… переместил(а) вас в «Созвон 2»», панель голоса «Голос подключён / Созвон 2», в статистике `mic N kbps` > 0 (микрофон снова опубликован), B подключился по токену из `VOICE_MOVED` (без `POST /join`); у A — B в списке под «Созвон 2» и не под «Созвон». В конце B отключается. Firefox пропускается, если не задан `CALABA_WEB_FF_VOICE=1`.

Локально против mock (нужен dev-LiveKit на `ws://127.0.0.1:7880` из `pnpm infra:dev` и собранный `dist-web`; без переменных — фикстуры owner@ / vera@calaba.test):
```sh
cd apps/desktop
npx tsx e2e-support/mock-server.ts --port 4173 --scenario data --static dist-web --quiet &
CALABA_WEB_URL=http://127.0.0.1:4173 npx playwright test --config playwright.web.config.ts move --project chromium
kill %1
```
Против стенда (A — администратор своего пространства «E2E web», B — второй аккаунт; идемпотентно, повторные прогоны ничего не создают):
```sh
cd apps/desktop && CALABA_FORCE_IP=141.105.69.177 CALABA_WEB_URL=https://app.calab.io \
  CALABA_WEB_LOGIN=… CALABA_WEB_PASSWORD=… CALABA_WEB_LOGIN2=… CALABA_WEB_PASSWORD2=… \
  pnpm exec playwright test --config ../../infra/docker/tools/playwright.stand.config.ts move --project chromium
```
Ожидается: `1 passed`. Шаги 3–9 — вручную.

## Server: оборванные клиентом запросы (499 вместо 500)

```sh
cd apps/server
go test ./internal/httpx/ -run TestClientCanceledIsNotAServerError -v 2>&1 | grep -E '^(--- |ok|FAIL)'
go test -race -tags integration -count=1 -v -run TestEventSurvivesCanceledRequest ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: оба `--- PASS` и `ok`.

Что проверяется:
- запрос с отменённым клиентом контекстом (handler вернул `context.Canceled`) → статус `499`; в логах нет `ERROR`, есть debug «request canceled by the client»; метрика `calaba_http_request_duration_seconds` со `status="499"`, не 500;
- `context.Canceled` от внутренней работы сервера при живом клиенте остаётся `500`;
- событие, опубликованное с уже отменённым контекстом запроса, всё равно доходит до gateway (публикация не зависит от запроса).

Проверка на стенде: в логах api после reload сразу после отправки сообщения — строка `"status":499` уровня INFO вместо `ERROR … 500 "context canceled"`.

## Server: веб-камеры (v0.2, ветка `feat/webcam`)

Нужен `lk` CLI (`brew install livekit-cli`): тест публикует в dev-LiveKit настоящий camera-трек (`lk room join --publish-demo`). Без `lk` или без dev-LiveKit тест пропускается (`SKIP`).

```sh
cd apps/server
go test ./internal/rtc/ ./internal/perm/ && (cd ../.. && pnpm --filter ./packages/protocol test)
go test -race -tags integration -count=1 -v -run TestCameras ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: `ok` и `--- PASS: TestCameras` (~5 с).

Что проверяется:
- **Лимиты.** `camera_limit`: default workspace 6 → 4, override комнаты; 30 → 422 в обоих местах.
- **Join.** `can_video` и `media.camera_limit` в ответе; `camera/request` до подключения к LiveKit → 409.
- **Grant.** Настоящий участник с demo-камерой; `camera/request` → 204, в grant появляется `CAMERA`. `track_published` (CAMERA) → `VOICE_STATE_UPDATE camera = true`, флаг есть и в READY.
- **Лимит 1.** Камера второго участника → сервер глушит её, приходит `VOICE_CAMERA_STOP{LIMIT_REACHED}`.
- **Остановка модератором.**
  - Без `MUTE_MEMBERS` → 403.
  - С правом → `VOICE_CAMERA_STOP{MODERATOR}` и `camera = false`; `CAMERA` уходит из grant; трек в LiveKit заглушён или снят.
  - Повторная остановка → 404.
- **Свой `camera/stop`** снимает grant.
- **Отказы.** `camera_limit = 0` → 409; override `deny VIDEO` для member → 403 и `can_video = false`.
- **Unit.** `TestGrant` (источник `CAMERA` только при VIDEO и занятом месте), векторы `permissions.json` (VIDEO = 1<<14 у member по умолчанию).

### Веб-камеры: ревью ветки (L1, L2, L6, L7, L8)

```sh
cd apps/server
go test -race -tags integration -count=1 -v -run 'TestCamera' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: `--- PASS` для `TestCameras`, `TestCamerasConcurrentLimit`, `TestCameraLifecycle`, `TestCameraMove` и `ok`. Нужны dev-LiveKit и `lk` CLI, иначе `SKIP`.

Что проверяется:
- **`TestCamerasConcurrentLimit`** — две камеры публикуются одновременно (параллельные webhook) при `camera_limit = 1`: ровно одна запись и один `LIMIT_REACHED`.
- **`TestCameraLifecycle`**:
  - reconcile записывает живую камеру, для которой не пришёл webhook; молодую запись без трека (< 15 с) не трогает, старую удаляет (L2);
  - camera-grant переживает resync (смена прав) и stop-stream (L1);
  - stop-camera липкий: `/camera/request` → 403 до `allow-camera` (L7); при одном резерве stop-camera → 204, повтор → 404 (L8);
  - `participant_left` убирает записи, резерв и липкий стоп.
- **`TestCameraMove`**:
  - move в комнату с камерами переносит запись и grant;
  - move в комнату с `camera_limit = 0` → `VOICE_CAMERA_STOP{ROOM_POLICY}`, `camera = false`, grant без `CAMERA` (L6).
  - MoveParticipant в OSS LiveKit не реализован (`twirp … not implemented`), поэтому сторона SFU в тесте подменена (`fakeMove`), как в `TestMoveMember`.

### Веб-камеры: камера при app-level move (L6 после rebase на 0.1.1)

```sh
cd apps/server
go test -race -tags integration -count=1 -v -run 'TestCameraAppLevelMove|TestCameraMove|TestMoveAppLevel' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: три `--- PASS` и `ok`. Нужны dev-LiveKit и `lk`, иначе `SKIP`.

Что проверяется в **`TestCameraAppLevelMove`** (режим app-level задан явно, `SetSFUMove(false)`):
- **Move с включённой камерой.** Настоящий участник с demo-камерой в комнате A → move в B → `VOICE_MOVED` с токеном; в B приходит одно состояние `camera = false`, ни одного `VOICE_CAMERA_STOP`; записей камер в A и B нет, резерва нет.
- **Липкий стоп.** Устройство подключается к B по токену из `VOICE_MOVED`, запрашивает камеру (204), модератор делает stop-camera (204). Затем приходит `participant_left` старого соединения из A, а `/camera/request` всё равно отвечает 403.
- **Регрессия.** Без проверки комнаты в `dropCameras` последний запрос вернул бы 204.

Тесты с `fakeMove` (`TestCameraMove`, p05, review2, move_cancel) явно ставят `SetSFUMove(true)`, поэтому от порядка запуска не зависят.

## Параллельные интеграционные прогоны (несколько worktree / агентов)

Dev-инфраструктура (`compose.dev`) общая. Что делят параллельные прогоны `go test -tags integration`:
- **Valkey.** `internal/app` использует DB из `TEST_REDIS_URL` (по умолчанию 15), `internal/rtc` — DB `TEST_RTC_REDIS_DB` (по умолчанию 14). Каждый прогон делает FLUSHDB своей базы, а ключи лимитов (синтетические IP тестов) одинаковые. Если два прогона пишут в одну DB, один очищает данные другого, а лимиты общие — отсюда 429 в TestGuests / TestChangeCredentials / TestWebCookieAuth и пропавшее voice-state.
- **Postgres** не мешает: каждый прогон создаёт свою временную базу `calaba_it_<random>`. Отдельная admin-база нужна только для порядка.
- **LiveKit** не мешает: комнаты тестов называются по UUID workspace/room.

Правило: у каждого дерева свои номера DB. Основное дерево — 15/14 (по умолчанию). Worktree — свои: `make test-integration TEST_REDIS_DB=12 TEST_RTC_REDIS_DB=11`, или полностью, например:
```sh
docker exec calaba-dev-postgres-1 createdb -U calaba calaba_test_webcam   # один раз
make test-integration TEST_REDIS_URL=redis://localhost:56379/12 TEST_RTC_REDIS_DB=11 \
     TEST_DATABASE_URL=postgres://calaba:calaba@localhost:55432/calaba_test_webcam
```
Занятые номера: main — 15/14; `calab-webcam-server` — 12/11.

## Server: PostgreSQL 17 (ADR-0037)

```sh
docker run -d --name calab-pg17 -e POSTGRES_USER=calaba -e POSTGRES_PASSWORD=calaba -e POSTGRES_DB=calaba -p 55433:5432 postgres:17-alpine
cd apps/server
TEST_DATABASE_URL=postgres://calaba:calaba@localhost:55433/calaba go test -race -tags integration -count=1 -v \
  -run 'TestUUIDv7Polyfill|TestEnsureUUIDv7' ./internal/db/ 2>&1 | grep -E '^(--- |ok|FAIL)|created public'
cd ../.. && make test-integration TEST_DATABASE_URL=postgres://calaba:calaba@localhost:55433/calaba   # весь набор на 17
docker rm -f calab-pg17
```
Ожидается: оба `--- PASS`, одна строка `created public.uuidv7() … server_version=17.x`, весь набор `ok`. Те же два теста на dev-Postgres 18 проходят без этой строки (встроенная `uuidv7()`). Проверяется: версия 7 и вариант `10`, рост id внутри сессии (10 000 вызовов, откат транзакции), порядок по времени между сессиями (на 18 — вперемешку со встроенной), ровно одно создание функции при четырёх одновременно стартующих репликах, `users.id` по умолчанию — v7.

## Server: часовой пояс профиля (`User.timezone`)

```sh
cd apps/server
go test ./internal/users/ -run TestValidateTimezone -v 2>&1 | grep -E '^(--- |ok|FAIL)'
go test -race -tags integration -count=1 -v -run TestProfileTimezone ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: оба `--- PASS`. Проверяется:
- **Валидация.** IANA-имена принимаются, в том числе `America/Argentina/Buenos_Aires` и `UTC`. `Local`, несуществующие зоны, пути и имена не в том регистре → 422, одинаково на macOS и Linux.
- **Round-trip.** `PATCH /api/me {timezone}` → ответ и `GET /api/me`; другим участникам приходит `USER_UPDATE`, поле видно в READY-списке участников. `""` сбрасывает.
- **Образ.** База зон встроена в бинарник (`time/tzdata`): в distroless zoneinfo нет.

## Server: личные сообщения (ADR-0020, ветка `feat/dm-server`)

```sh
cd apps/server
go test -race -count=1 ./internal/perm/ ./internal/dms/ && pnpm -F @calaba/protocol test
TEST_PG_URL=postgres://calaba:calaba@localhost:55432/calaba_test_dm TEST_REDIS_URL=redis://localhost:56379/5 TEST_RTC_REDIS_DB=4 \
  go test -race -tags integration -count=1 -v -run 'TestDirectMessage' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: `ok` у юнитов (DM-векторы в `proto/testdata/permissions.json` — Go и TS) и `--- PASS` у `TestDirectMessages`, `TestDirectMessageGuests`, `TestDirectMessageRateLimit`. Проверяется:
- **Создание.** `POST /api/dms` → 201 + `DM_CREATE` обоим; повтор с любой стороны → 200, та же комната; себе → 422; без общего пространства → 404; 11-й новый DM подряд → 429.
- **Доступ.** Третий пользователь получает 404 на комнату, историю, отправку, реакции, read, закрепы, файлы DM; участник не может удалить/править чужое, менять комнату, звать в голос.
- **События и READY.** `MESSAGE_CREATE`/реакции/закреп приходят обоим с пустым `workspace_id`; typing — только подписанной сессии peer; в READY `dms[]` с peer и `unread_count = mention_count`, read-state и настройки уведомлений DM.
- **Гости.** Гостевой аккаунт: 403 на все `/api/dms*`, не кандидат, READY без DM.

## Client: личные сообщения (ADR-0020, ветка `feat/dm-client`)

```sh
cd apps/desktop && pnpm -s typecheck && pnpm -s lint && pnpm test && npx vitest run --config e2e-support/vitest.config.ts
CALABA_VISUAL_MOCK_PORT=39570 MOCK_LIVEKIT_ROOM_PREFIX=dm_ pnpm e2e:visual -g "dm-"     # dm-list / dm-chat / dm-new × 4
npx tsx e2e-support/mock-server.ts --port 39571 --static dist-web &                     # после build:web
CALABA_WEB_URL=http://127.0.0.1:39571 npx playwright test --config playwright.web.config.ts --project=chromium dm.web
```
Ожидается: всё зелёное (12 снимков, `dm.web` 1 passed). Руками (два аккаунта, стенд или мок `boris@`/`vera@calaba.test`):
- Рейл: сверху «Личные» (иконка Calab) со счётчиком непрочитанных DM; клик — слева список DM (аватар с присутствием, имя, последнее сообщение и время, счётчик), справа «Выберите переписку».
- «Новое сообщение» / «Найти или начать беседу» → поиск по имени/нику → выбор → открывается чат DM; у второго аккаунта DM появляется сразу, с непрочитанным и звуком/уведомлением (кроме «Не беспокоить» и выключенных уведомлений DM).
- «Написать» в профиле участника и в его контекстном меню открывает (или создаёт) DM; у гостя этих пунктов и «Личных» нет.
- В DM работают вложения, реакции, ответ, правка, закреп обоими; заголовок — собеседник с присутствием и «печатает…»; нет участников и голоса.
- ⌘K находит DM по имени; ссылка `https://<сервер>/dm/<id>` (контекстное меню DM → «Копировать ссылку») открывает DM в вебе, `calab://dm/<id>` — в десктопе; чужая ссылка — тост «Переписка по ссылке недоступна».
- Превью последних сообщений приходят в READY (`DmSummary.last_message`): при открытии «Личных» в Network нет запросов `…/messages?limit=1`.
- Телефон (≤ 768 px): `CALABA_MOBILE_MOCK_PORT=39572 npx playwright test --config playwright.web.config.ts --project=iphone-14 --project=pixel-7` — тест «Личные» (список DM в шторке ☰, переписка на весь экран) и прежние мобильные сценарии зелёные.

## Оптимистичный вход в голос (docs/09 P1 #8, ветка `feat/optimistic-join`)
Авто: `go test -tags integration -run TestOptimisticJoin ./internal/app/` (dev LiveKit), `-run Pending ./internal/rtc/`; клиент — `stores/voicePending.test.ts`, `services/voice.test.ts` («optimistic join…»), mock — «optimistic voice join». Снимок `voice-room-pending`.
Руками (два клиента A и B в одном пространстве):
1. A кликает голосовую комнату → A в списке сразу, у B тоже (до «Голос подключён»).
2. Медленная сеть у A (Network Link Conditioner) → через 3 с у A и B вокруг аватара A вращается кольцо, tooltip «Подключается…»; после подключения — обычный вид, кольцо речи работает.
3. У A заблокирован LiveKit (7880/7881/7882) → через 15 с A исчезает из комнаты у B.
4. Комната с лимитом 1: пока A подключается, B получает «Комната заполнена».
5. `/join` с ошибкой (сервер остановлен) → A сразу пропадает из списка, тост.
6. macOS «Уменьшить движение» → кольцо статичное.

## Выход из голоса до подключения (`/voice/leave`, ветка `fix/voice-leave`)
Авто: `go test -tags integration -run "TestVoiceLeave|TestVoiceTimes" ./internal/app/` (dev LiveKit, ~17 с), `-run "VoiceLeave|CallStartsOnConnect" ./internal/rtc/`; клиент — `services/voice.test.ts` («/voice/leave»).
Руками (A и B в одном пространстве):
1. У A заблокирован LiveKit (7880/7881/7882); A кликает комнату и сразу «Отключиться» → у B A пропадает сразу, не через 15 с; таймера звонка у комнаты нет.
2. A входит нормально → таймер стартует с «Голос подключён» (не с клика); A «Отключиться» → A пропадает у B сразу, таймер исчезает.
3. A «Отключиться» и сразу снова в ту же комнату → A остаётся в комнате (leave не отменил новый вход).

## Порядок комнат и категории (docs/09 P1 #19, ветка `feat/rooms-dnd`)
Авто: `go test -tags integration -run TestMigrationFlatRoomOrder ./internal/rooms/`, `-run "TestRoomOrderFlat|TestCategories" ./internal/app/`; клиент — `lib/roomOrder.test.ts`, `services/roomOrder.test.ts`, mock — «room order». Снимок `sidebar-drag` (`-g "sidebar-drag"`).
Руками (админ A, участник B в одном пространстве):
1. Новое пространство: ни одной категории; созданные комнаты — плоским списком.
2. A тащит комнату вверх/вниз, в категорию и обратно, тащит категорию: линия акцента, у B порядок меняется сразу; Esc во время перетаскивания — ничего не меняется.
3. Сервер остановлен → перетаскивание откатывается, тост. У B (без MANAGE_ROOM) строки не тащатся, в меню нет «Переместить».
4. Меню комнаты «Переместить вверх/вниз», «В категорию ›»; двойной клик по категории — переименование; удаление категории — комнаты внизу верхнего уровня.
5. ПКМ по пустому месту: «Скрыть заглушённые» прячет заглушённые комнаты (кроме открытой), состояние переживает перезапуск.
## Меню участника и профиль (docs/09 #20, ветка `feat/member-profile`)
Авто: `go test -tags integration -run "TestUserNotes|TestMemberSinceAndRolesFromProfile" ./internal/app/`; клиент — `pnpm -s test` (`noteSaver.test.ts`, `voice.test.ts` «per-user volume», `voiceLogic.test.ts`), mock — «member profile»; снимки `-g "members-menu|profile-dialog"` (dark 960).
Руками (A и B в одной голосовой комнате):
1. ПКМ по B (список комнаты, колонка участников, аватар/имя в чате) → одно и то же меню; «Профиль» открывает диалог: баннер, «Участник с» (две даты), роль-чип.
2. «Добавить заметку» → профиль с курсором в заметке; ввод → через ~1 с «Сохранено»; закрыть/открыть — текст на месте; у B и у третьего участника заметки A не видно.
3. Громкость B 50 % → тише; 200 % при общей громкости наушников 50 % — как 100 %; при 100 % — подпись «Выше 100 %…». Переподключение A — громкость B сохранена.
4. «Заглушить для меня» → B не слышно, у B в строке иконка «Вы заглушили»; звук стрима B остаётся.
5. Владелец: «+» → «Админ» у B; × на чипе снимает; у всех роль меняется сразу (MEMBER_UPDATE).

## Уровни уведомлений (docs/09 п. 22, ветка `feat/notify-levels`)
Авто: `go test ./internal/notifications` (88 векторов `proto/testdata/notifications.json`) и `go test -tags integration -run "NotificationSettings|MigrationWorkspaceLevels" ./internal/app/ ./internal/notifications/`; клиент — `pnpm -s test` (`notify.test.ts`, `rooms.test.ts`, `packages/protocol` notifications), mock — «workspace level»; снимок `-g "room-notify-menu"` (dark 960).
Руками (A и B в пространстве, у A окно не в фокусе):
1. B пишет в #общий без упоминания → у A нет звука/уведомления, точка и счётчик есть; `@A` → звук «Упоминание»; сообщение в DM → звук и уведомление.
2. Колокольчик комнаты → «Все сообщения» (иконка `BellRing`) → обычное сообщение даёт «Новое сообщение»; меню пространства → «Все сообщения» при комнате «Как в пространстве» — так же во всех комнатах.
3. «Заглушить → На 1 ч» в пространстве → тишина даже на `@A`, у комнат нет точки, счётчик упоминаний и бейдж Dock остаются; «Включить уведомления» возвращает.
4. Бейдж Dock/заголовок окна = упоминания + непрочитанные DM; открыть эти чаты → бейдж пропадает. Второе устройство A получает смену уровня сразу.

## Почта: подтверждение, сброс пароля, приглашения по email (ADR-0023, ветка `feat/email-server`)
Авто: `go test ./internal/mail ./internal/auth` (шаблоны × 4 локали, SMTP против фейкового сервера, коды) и `go test -tags integration -run "Email|PasswordReset|ChangeEmail|InviteLookup|MailOutbox|ChangeCredentials" ./internal/app/` (`TEST_PG_URL`/`TEST_REDIS_URL` — свои).
Руками (`pnpm infra:dev` поднимает Mailpit: письма на http://localhost:8025; `make dev-server` шлёт в него):
1. Регистрация → письмо «Код подтверждения: NNNNNN» (язык — по `Accept-Language`/`locale`); до кода `POST /api/workspaces` → 403 `EMAIL_NOT_VERIFIED`; `POST /api/auth/verify {code}` → `emailVerified: true`, создание работает.
2. 5 неверных кодов → `CODE_INVALID` ×4, затем `CODE_EXPIRED`; `verify/send` раньше 60 с → 429.
3. `password/forgot` (свой и чужой адрес) → 200 оба (`similar_account` только для того же логина на другом домене, docs/09 #137), письмо только своему; `password/reset` → 204, все устройства разлогинены, вход с новым паролем.
4. `invites/lookup` своего участника → `member: true`; неизвестного → `{}`; `invites/email` → письмо со ссылкой `/join/<code>`, шагами и кодом текстом; регистрация по ней → код подтверждения → в пространстве (ADR-0027); повтор приглашения < 24 ч → 429.
5. Письма: светлая/тёмная тема клиента, подвал «Powered by GPTunneL · calab.io».

## Client: почта (ADR-0023, ветка `feat/email-client`)
Авто: `pnpm -F @calaba/desktop test` (emailCode, reset, emailLookup), `pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts` (describe «email»), снимки `e2e:visual -g "verify-banner|invite-email|auth-forgot|web join card"`. Код в моке — всегда `123456`.
Руками (`pnpm infra:dev` + `make dev-server`, письма в Mailpit http://localhost:8025):
1. Регистрация → онбординг начинается с «Подтвердите почту»; «Позже» → плашка над чатом. Неверный код → «Осталось N попытки»; «Отправить снова» сразу → таймер из `Retry-After`.
2. До кода «Создать пространство» → диалог закрывается, плашка в фокусе с подсказкой. Верный код → плашка исчезает, тост.
3. Вход → «Забыли пароль?» → email → код из письма + новый пароль → вход; старые устройства вышли.
4. Профиль → «Изменить email» → код на новый адрес; строка «ожидает подтверждения», «Отменить» (паролем).
5. Приглашения → «Пригласить по email»: свой участник → «Уже участник»; зарегистрированный → «Добавить»; новый адрес → письмо, запись в «Отправленные», «Отозвать».
6. Ссылка из письма в вебе без входа: карточка с именем и числом участников; регистрация — email заблокирован, после неё сразу в пространстве.

## Приглашения: один код (docs/09 п. 36, ADR-0027, ветка `fix/invite-flow`)
- Сервер: `go test ./internal/mail` (3 шага + «Код приглашения: …» × 4 локали); `go test -tags integration -run 'TestInviteFlow|TestEmailInviteAutoJoin' ./internal/app/` — email-код: чужой адрес 403 `INVITE_EMAIL_MISMATCH`, регистрация без вступления → verify → `joinedWorkspaceIds` + `WORKSPACE_CREATE`, повтор (превью 200, участник 200, чужой 403, новая регистрация 404); код ссылки — вступление при регистрации.
- Клиент: `pnpm -F @calaba/desktop exec vitest run src/renderer/features/onboarding` (порядок шагов, пропуски, восстановление шага, микрофон без перезапуска); мок — describe «email».
- E2E (мок): `npx tsx e2e-support/mock-server.ts --port 41975 --scenario data --static dist-web --quiet &` → `CALABA_WEB_URL=http://127.0.0.1:41975 pnpm -F @calaba/desktop e2e:web --project=chromium link` — ожидается 3 passed (на стенде 2 новых — skipped).
- Снимки: `e2e:visual -g "onboarding|web join card"` (`onboarding-join`, `web-join-signup`).
- Руками (Mailpit): пригласить новый адрес → письмо с шагами и кодом → ссылка → «Продолжить в браузере» → карточка «Приглашение в «…»», email заблокирован, поля кода нет → регистрация → «Подтвердите почту» → код → тост «Почта подтверждена — вы в «…»», онбординг без «Присоединиться», после — пространство открыто, диалога вступления нет.
- Онбординг: порядок «Почта → Микрофон → Экран (macOS) → Уведомления → PTT → Присоединиться (нет пространств) → Готово», языкового шага нет; закрыть приложение на шаге «Экран» → при запуске тот же шаг.

## Лимит реакций (docs/09 п. 27, ветка `feat/reaction-limit`)
Авто: `go test -tags integration -run ReactionLimit ./internal/app/` (комната и DM: 3 ок, 4-я → 409 `REACTION_LIMIT`, снятие освобождает место, 8 параллельных → ровно 3); клиент — `reactionLimit.test.ts`, mock — «reactions: at most 3».
Руками: поставить 3 разные реакции → в панели при наведении остальные быстрые реакции тусклые с подсказкой, пикер показывает «Не больше 3 реакций на сообщение» и не добавляет новые; клик по своей — снимает, после этого можно добавить другую; чужие реакции на лимит не влияют.

## Срок статуса на сервере (ветка `feat/presence-until`)
- Сервер: `TEST_PG_URL=… TEST_REDIS_URL=redis://localhost:56379/4 go test -tags integration -run TestManualPresenceUntil ./internal/app/` (~16 с: ждёт sweeper) — DND/невидимый с `until` виден другим (`until`, невидимый = offline без `until`/`last_seen`), приходит в `READY.presence` и `USER_UPDATE` второму устройству; через 2 с sweeper возвращает online и чистит `users.presence_*`.
- Клиент: `pnpm -F @calaba/desktop exec vitest run src/renderer/services/presenceTimer.test.ts` — синхронизация из READY/USER_UPDATE, офлайн-выбор уходит после READY.
- Руками: два устройства одного пользователя → на первом «Не беспокоить › 15 минут» → на втором статус и «до ЧЧ:ММ» появляются сразу; закрыть оба клиента до конца срока → после входа статус «В сети».

## Закрытие окна и выход (docs/09 п. 31, ветка `fix/close-hide`)
- Авто: `pnpm -F @calaba/desktop exec vitest run src/main/lifecycle.test.ts src/main/updateFlow.test.ts`.
- Руками (macOS): войти в голос → закрыть окно крестиком → звонок и PTT продолжаются, иконка в Dock; клик по Dock → окно вернулось. ⌘Q в звонке → диалог «Вы в голосовой комнате. Выйти из Calab?»: «Отмена» — остаёмся, «Выйти» — выход; вне звонка ⌘Q выходит сразу.
- Руками (Windows/Linux): крестик → окно в трее + один раз баллон «Calab продолжает работать в трее»; клик по значку возвращает; «Выход» в меню трея в звонке — тот же диалог; «При закрытии окна: Выходить» → крестик ведёт себя как «Выход».
- Web: в звонке закрыть вкладку → браузер спрашивает «Покинуть сайт?»; вне звонка — без вопроса.

## Server: свои роли пространства (ADR-0026, ветка `feat/roles-server`)
- Авто (свои БД/Valkey): `TEST_PG_URL=…/calaba_test_roles TEST_REDIS_URL=redis://localhost:56379/12 TEST_RTC_REDIS_DB=11 go test -tags integration -run 'TestRoles|TestRoleRoomMatrix' ./internal/app/` — CRUD и ограничения (≤ 50, встроенные, иерархия, без эскалации), назначение, матрица прав комнаты с двумя ролями, READY/события, гранты LiveKit при смене ролей; `go test -tags integration -run TestMigration21Roles ./internal/db/` — 00021 up/down на фикстуре с переопределениями.
- Векторы: `go test ./internal/perm` и `pnpm -F @calaba/protocol test` (общий `proto/testdata/permissions.json`).
- Руками (curl, владелец): `POST /api/workspaces/{id}/roles {"name":"DJ","permissions":"64"}` → 201, `position` 2; `PUT …/members/{uid}/roles {"roleIds":["<DJ>"]}` → у участника в ответе `roleIds` = DJ + member; приватная комната с `allow VIEW_ROOM` для DJ → участник видит её (`ROOM_CREATE` в gateway), `DELETE …/roles/<DJ>` → `ROLE_DELETE`, `ROOM_DELETE`.
- Стенд после деплоя: старые приватные комнаты остались приватными (цель `member` переведена в id роли), гость по-прежнему видит только разрешённые комнаты.

## Client: свои роли (ADR-0026, ветка `feat/roles-client`)
- Авто: `pnpm -F @calaba/desktop exec vitest run src/renderer/lib/roles.test.ts src/renderer/lib/permissions.test.ts src/renderer/features/people` (права с несколькими ролями, старшая роль для цвета, форма роли, «Роли ›»); мок: `pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts e2e-support/mock-roles.test.ts`.
- Визуальные: `CALABA_VISUAL_MOCK_PORT=41870 MOCK_LIVEKIT_ROOM_PREFIX=role_ pnpm -F @calaba/desktop e2e:visual -g "settings-roles|settings-role-edit|members-menu"`.
- Руками (владелец): Настройки пространства → «Роли» → «Создать роль» → имя «DJ», цвет, право «Показывать экран» → вкладка «Участники с ролью» → «Добавить участника» → у участника имя стало цвета DJ, рядом точка (tooltip «DJ»).
- Перетащить DJ выше «Модератор» → порядок сохранился после перезапуска. Удалить DJ → у участника цвет пропал.
- Правый клик по участнику → «Роли ›» → чекбоксы; админ не видит «Администратор» включаемым (только владелец). Профиль → чипы, × снимает роль, «+» выдаёт.
- Права комнаты: цели — роли по имени (своя роль с точкой); allow «Видеть» для DJ в приватной комнате → держатель DJ видит комнату сразу.
- Участник со своей ролью с `MANAGE_ROLES`: видит вкладку «Роли», редактирует только роли ниже своей; попытка выдать право, которого нет у него, — строка ошибки сервера.

## Голосовые сообщения (docs/09 #43)

1. `cd apps/server && TEST_DATABASE_URL=… TEST_REDIS_URL=… go test -tags integration -run Voice ./internal/app` — ok (загрузка в комнату и DM, `422` на WebM/Vorbis/не `audio/ogg`/плохие параметры, `413` сверх лимита).
2. `pnpm -F @calaba/desktop e2e:visual -g "chat-voice-recording|chat-voice-bubble"` и `e2e:visual:mobile -g m-chat-voice` — зелёные (запись фейковым микрофоном через настоящий Opus-энкодер).
3. Вручную (десктоп): пустое поле → удерживать микрофон 3 с → отпустить: пузырь с волной, play играет в выбранные наушники/колонки. Удержать → вверх: «Отмена»/«Отправить». Удержать → влево или Esc: ничего не ушло.
4. В звонке с включённым микрофоном записать голосовое: собеседников слышно всё время, эха у них нет.
5. Телефон (веб): те же жесты касанием; iPhone на iOS 18.4+ играет, на iOS 17 — кнопка «Скачать».

## Комнаты «Только по списку» (ADR-0029, docs/09 #46)
1. `cd apps/server && TEST_DATABASE_URL=… TEST_REDIS_URL=… go test -race -tags integration -run Restricted ./internal/app` — ok (матрица: владелец / админ / админ по списку лично и ролью / участник / гость; флаг только владельцу, 403 `OWNER_ONLY`; gateway `ROOM_DELETE`/`ROOM_CREATE`, READY без комнаты и звонка).
2. Векторы: `go test ./internal/perm` и `pnpm -F @calaba/protocol test`.
3. `pnpm -F @calaba/desktop e2e:visual -g room-settings-restricted` — зелёный.
4. Вручную: владелец → приватная комната → Настройки → «Доступ» → «Только по списку»; у админа (второй аккаунт) комната пропадает сразу из списка, ⌘K, упоминаний; если он был в звонке — выкидывает.
5. «Кто видит» → «Добавить» админа → комната появляется у него, права как у участника (нет «Настроек комнаты»). Убрать × → снова пропала.
6. Админ: `PATCH /api/rooms/{id} {"restricted":false}` → 403 `OWNER_ONLY`. Снять флаг владельцем → админы снова видят комнату.

## Личные: архив и «Удалить чат» (docs/09 #51)
1. `cd apps/server && TEST_DATABASE_URL=… TEST_REDIS_URL=… go test -race -tags integration -run 'Dm|Direct' ./internal/app` — ok (`TestDmArchiveAndDelete`: архив только у себя, входящее снимает архив + `DM_STATE_UPDATE`, после удаления история/поиск/закрепы/счётчики пустые у меня и без изменений у собеседника, чужой DM → 404).
2. `pnpm -F @calaba/desktop e2e:visual -g "dm-list|dm-archive|dm-delete-confirm"` и `e2e:visual:mobile -g m-dm-list` — зелёные (свайп строки влево → «В архив»).
3. Вручную: правый клик по диалогу → «В архив» — диалог уходит в свёрнутый «Архив — 1» внизу; собеседник пишет — диалог вернулся с непрочитанным.
4. «⋯» в заголовке DM → «Удалить чат» → «Удалить»: переписка закрылась, диалога нет в списке; «Написать» ему же — лента пуста. У собеседника история на месте.
5. Собеседник пишет снова — диалог появился «чистым» с одним новым сообщением.

## Боты и Bot API, сервер (ADR-0031, docs/09 #59, фаза 1)
1. `cd apps/server && TEST_DATABASE_URL=… TEST_REDIS_URL=redis://localhost:56379/14 go test -race -tags integration -run 'Bot|Matrix|Auth' ./internal/app` — ok (`TestBotRouteTable` обходит все маршруты: без решения/`deny` → 403 `BOT_NOT_ALLOWED`; жизненный цикл токена, 4010 на сокете, лимит тарифа, права через роли и ограниченные комнаты, команды, webhook с подписью и отключением, блокировка, лимиты, `/join` + удаление из LiveKit при отзыве).
2. Unit: `go test ./internal/auth ./internal/messages ./internal/bots` (формат токена, парсер `/cmd@bot`, SSRF-политика webhook, подпись).
3. Руками (владелец, `make dev-server`): `POST /api/workspaces/{id}/bots {"displayName":"Echo","username":"echo_bot"}` → 201 с `token`; `curl -H "Authorization: Bearer <token>" …/api/me` → `isBot: true`; `…/api/me/sessions` → 403 `BOT_NOT_ALLOWED`.
4. Бот: `PUT /api/bots/me/commands {"commands":[{"name":"roll"}]}`; человек пишет `/roll 2d6` → в gateway бота `MESSAGE_CREATE.message.command {name:"roll", args:"2d6"}`, у людей поля нет.
5. Webhook: `PUT /api/bots/me/webhook {"url":"https://<публичный хост>/hook","secret":"<16+ символов>"}` → на хост приходит POST с `X-Calab-Signature: sha256=…` (проверить HMAC тела); `http://` и приватные адреса → 422.
6. `POST …/bots/{botId}/token` → старый токен 401 сразу, сокет бота закрыт 4010; `DELETE …/bots/{botId}` → бот пропал из участников и звонка.

## Показать пароль и дни рождения (docs/09 #75, #76)
1. `pnpm -F @calaba/desktop test -- PasswordInput birthday` — ok (глаз: type/aria-pressed; «сегодня» по поясу, 29 февраля, возраст).
2. `cd apps/server && go test ./internal/birthdays && TEST_DATABASE_URL=… TEST_REDIS_URL=redis://localhost:56379/4 go test -race -tags integration -run 'Birthday' ./internal/app` — ok (PATCH/валидация/скрытие, воркер: 09:00 по поясу, дедуп, UTC без пояса; `GET …/birthdays`).
3. `pnpm -F @calaba/desktop e2e:visual -g "auth-login|profile-birthday|chat-birthday-card"` — зелёные.
4. Вручную: вход — глаз в поле пароля показывает/прячет, Enter входит; «Профиль → День рождения» 15 / март / 1996 — у коллеги в профиле «🎂 15 марта · 30 лет»; «Скрыть от других» — строка у коллеги пропала.
5. Сегодняшняя дата + локальное время ≥ 09:00 → в течение часа (или после рестарта сервера) в первой текстовой комнате карточка «🎂 Сегодня день рождения у …!», у имени в списке участников и в голосе 🎂; «Настройки пространства → Участники» — «Ближайшие дни рождения».

## Windows: системный звук стрима (docs/09 #122, требует проверки на Windows)
1. Windows 11 (`winver` ≥ 22000): звонок из 3 человек — A (Windows, стримит), B и C говорят. A: «Показать экран» → переключатель «Звук» включён по умолчанию, предупреждения нет → запустить стрим с YouTube в фоне.
2. B говорит: C слышит B **один раз** (без второго, задержанного голоса из стрима); A слышит B и C нормально; музыка YouTube у B и C слышна. Лог A (`%APPDATA%/Calab/logs`): нет `system audio may include our own playback`.
3. Windows 10 (19045): в пикере «Звук» выключен по умолчанию; при включении — жёлтое предупреждение «Windows 10: звук участников тоже попадёт в стрим…». Со звуком голоса B у C слышны дважды (ожидаемо), без звука — один раз.
4. Остановить стрим: у A голоса собеседников и системный звук не пропадают.

## Календарь и встречи (1.0.0, ADR-0038)

Главная фича релиза — проверяется тщательно. Автоматическая матрица (что за каким тестом закреплено, честные пробелы) — `docs/20-calendar-testing.md`; здесь только ручные сценарии.

Предусловия: `pnpm infra:dev` (LiveKit + Mailpit, письма на http://localhost:8025) + `make dev-server` или стенд; аккаунты `owner@calaba.test` (организатор, роль owner) и `bob@calaba.test` (участник) в пространстве «Team»; «внешний участник» — любой адрес не из пространства, например `ext@example.com` (локально письма ловит Mailpit; на стенде и для C.16 — настоящий внешний ящик, C.16 отдельно). Для часовых поясов — второй клиент/профиль с `TZ=Asia/Krasnoyarsk` (Б, +7) рядом с А (`TZ=Europe/Moscow`, +3, аккаунт `owner`), как `TZ=Europe/Moscow` в 2.5. RSVP-ссылка внешнего участника, гостевая ссылка и `.ics` — по ADR-0038 (дополнение о внешних участниках; если у реализации другой путь/формат ссылки — исправить сценарий и этот файл вместе).

| # | Сценарий | Ожидается |
|---|---|---|
| C.1 | А: иконка календаря в шапке → «+ Встреча»: название, время (шаг 15 мин), комната `voice`, участники Bob (обязательный) + `ext@example.com` (внешний, необязательный), описание, «Записывать встречу» вкл → «Создать» | Запись в `events`/`event_attendees` (внешний — email без `user_id`); `EVENT_CREATE` Bob; иконка в шапке показывает число встреч сегодня; письма в Mailpit Bob и `ext@example.com` — тема «Встреча: <название> — <дата>», вложение `invite.ics` (`METHOD:REQUEST`, `UID=<id>@calab`, `SEQUENCE:0`, `DTSTART` в UTC) |
| C.2 | А: изменить время начала → «Сохранить» | `EVENT_UPDATE`; Bob и `ext@example.com` получают новое письмо с обновлённым временем и `invite.ics` `SEQUENCE:1` (тот же `UID`, `METHOD:REQUEST`); карточка встречи обновилась у всех, кто видит комнату, без перезахода |
| C.3 | А: «Отменить» → подтверждение | `EVENT_DELETE`, `cancelled_at` заполнен; письмо `CANCEL` (`METHOD:CANCEL`, тот же `UID`, `SEQUENCE` ещё +1) обоим; встреча пропадает из дневного вида и из счётчика иконки |
| C.4 | Bob (в приложении): карточка встречи → «Приму», затем «Может быть», затем «Отклоню» | Каждый раз `PUT /api/events/{id}/rsvp` → 200 (встреча с `my_status`) и `EVENT_RSVP` организатору и всем, кто видит комнату, без реконнекта; статус Bob переживает перезаход; счётчики статусов на карточке А обновляются |
| C.5 | Открыть письмо `ext@example.com` в Mailpit → ссылки/кнопки RSVP «Приму / Отклоню / Может быть» в письме → перейти по каждой (без входа — внешний без аккаунта) | Страница подтверждения статуса без входа в приложение; статус `event_attendees` меняется, у А `EVENT_RSVP` и обновление карточки; повторный переход по той же ссылке идемпотентен (тот же статус, без ошибки) |
| C.6 | Сохранить ссылку из C.5, отменить встречу (C.3) или дождаться истечения срока ссылки → перейти по ней | `410 Gone`, страница «Ссылка больше не действительна»; статус участника не меняется |
| C.7 | Bob: Настройки → Уведомления → чипы напоминаний «5» и «15», «Напоминать при DND» выкл. Встреча через ~6 мин с Bob. Повторить со включённым DND у Bob | За ~5 мин до начала — `EVENT_REMINDER{minutes:5}` → нативное уведомление «Через 5 минут: <название> · <комната>» с действием «Перейти в комнату», клик подключает к голосу; при DND и выключенной настройке уведомления нет, при включённой (по умолчанию) — приходит поверх DND |
| C.8 | Создать встречу в комнате `voice` через ~16 мин, дождаться T-15 | Строка комнаты получает значок календаря и подпись «<название> в HH:MM» (`ROOM_EVENT_ACTIVE`); клик → карточка (тема, описание, участники со статусами, время в своей зоне, RSVP, «Перейти»); «Перейти» подключает к голосу; после конца встречи значок исчезает (`ROOM_EVENT_ENDED`) |
| C.9 | Встреча с `record=true` в комнате `voice`; А входит в окне [начало−15 мин; конец] | Островок предлагает «Начать запись встречи «…»?» (не автоматически); подтверждение запускает запись (ADR-0025); после старта запись привязана к вхождению (`event_recordings`, `recording_id` в списке встреч и повторный `ROOM_EVENT_ACTIVE`), карточка встречи показывает запись/саммари/«Полный транскрипт»; вход вне окна или без `record` — предложения нет |
| C.10 | Создать 4 встречи с повтором «каждый день» / «каждую неделю» / «раз в две недели» / «каждый месяц», у каждой `until` через 3 вхождения; `GET .../events?from&to` на окно 3 месяца | Ровно 3 вхождения на каждую, последнее ≤ `until`, дальше пусто; дневной вид показывает их в нужных днях; «Отменить это вхождение» пишет `event_exceptions` и убирает только один день (остальные остаются); правка времени всей серии меняет все вхождения одинаково (в v1 нет правки одного вхождения) |
| C.11 | А `TZ=Europe/Berlin`: еженедельная встреча по понедельникам 20:00, начало до 25.10.2026 (переход на зимнее время), `until` после 02.11.2026 | Вхождения до и после перехода показывают одно и то же локальное 20:00 Europe/Berlin у А, но разные UTC (18:00 → 19:00): сервер хранит `starts_at` в UTC и пересчитывает смещение по вхождению, а не наивным +7 дней |
| C.12 | А (`owner`, `TZ=Europe/Moscow`, +3) создаёт встречу на 15:00 своего времени; Bob — клиент с `TZ=Asia/Krasnoyarsk` (+7) | Карточка и `.ics` у А — 15:00; у Bob та же встреча — 19:00 (та же UTC-отметка); `DTSTART`/`DTEND` в `.ics` — UTC (`Z`), приложение календаря получателя пересчитывает само (повторяющаяся встреча в зоне с летним временем — `TZID` + `VTIMEZONE`) |
| C.13 | Встреча с внешним участником в обычной (не `restricted`) комнате: перейти по гостевой ссылке из письма в окне [−15 мин; конец] и вне его. Повторить для встречи в `restricted`-комнате (ADR-0029) | В окне встречи ссылка вводит внешнего гостем прямо в комнату без регистрации (поток ADR-0016); вне окна — «Ссылка станет активной за 15 минут до начала» или аналог; фактическое поведение (сервер 29.09): ссылка создаётся, только если у организатора `MANAGE_ROOM` в комнате (иначе в карточке `guest_links = false`, письмо без ссылки); вход по ней — как по обычной гостевой ссылке ADR-0016 (персональное переопределение `VIEW_ROOM`/`CONNECT`/`SPEAK`/`SEND_MESSAGES`, в `restricted`-комнате тоже); до окна — `409 INVITE_NOT_YET_VALID` с `not_before` в превью |
| C.14 | Мобильный веб (390 px или телефон): шторка → иконка календаря → день → встреча | Дневной вид и карточка встречи — полноэкранно, как чат/DM в шторке; те же данные и кнопки RSVP, что на десктопе |
| C.15 | Десктоп установлен и вход выполнен: клик по `https://<APP_HOST>/e/<id>` в письме | Как W14: браузер спрашивает «Открыть Calab?», приложение на передний план открывает карточку встречи (не диалог вступления); без приложения — веб-версия сразу на карточке; чужой/неизвестный `id` — «Встреча не найдена» |
| C.16 | Настоящий внешний почтовый ящик (не Mailpit) получает письма из C.1/C.2/C.3 → открыть `invite.ics` в Apple Calendar (macOS/iOS) и импортировать в Google Calendar | Оба показывают тему, время в зоне получателя, комнату/ссылку, организатора и участников; повтор после C.2 обновляет то же событие (`UID` тот же, `SEQUENCE` больше — не дубликат); `.ics` из C.3 (`CANCEL`) убирает событие из календаря получателя |
| C.17 | curl с Bearer разных ролей: member создаёт встречу без комнаты (ок); другой member правит чужую (403); admin с `MANAGE_WORKSPACE` правит чужую встречу с комнатой без `MANAGE_ROOM` (ок); организатор комнаты с `MANAGE_ROOM` правит встречу в своей комнате (ок); гость → `GET .../events` (403 или пустой список — календарь гостям не виден); бот-токен → `GET .../events` 200 (`botAllow`), `POST .../events` → 403 `BOT_NOT_ALLOWED` | Сервер отклоняет/пропускает точно по правам ADR-0038 п. 2, а не только клиент прячет UI |
| C.18 | curl `POST .../events`: 101 участник, 21 внешний адрес, `title` 121 символ, `description` 4001 символ | Каждый — отказ (422/аналог) на превышении лимита (100 участников, 20 внешних, 120/4000 символов), не молчаливая обрезка |
| C.19 | Внешний адрес без аккаунта (встреча с комнатой, организатор с `MANAGE_ROOM`): в письме нажать ссылку на встречу (`/e/<id>?t=…`) в приватном окне до окна и за 10 мин до начала | Страница встречи без входа: название, время в зоне браузера, описание, комната, свой ответ и кнопки «Приму / Может быть / Отклоню» (ответ сохраняется, у организатора обновляется статус); до окна — «ссылка станет активной за 15 минут до начала», в окне — «Присоединиться» ведёт в комнату гостем; других участников на странице нет; `curl -X POST /api/event-rsvp` с токеном из этой ссылки → 400 |
| C.20 | Внешний из C.19 вошёл в комнату гостем; кликнуть `https://<APP_HOST>/e/<id>` у него; затем организатор меняет название и отменяет встречу | У гостя у комнаты значок встречи и карточка (название, время, описание, счётчики — без списка участников и без RSVP); ссылка `/e/<id>` открывает эту карточку; правка приходит сразу, после отмены значок пропадает, `/e/<id>` — «Встреча не найдена»; календарь (иконка, день) гостю недоступен |
| C.21 | Дневной вид (владелец, 29.09, d&d): свою встречу перетащить на 2 ч позже, растянуть за нижний край, бросить в строку «весь день», бросить на завтра в мини-календаре (и стрелками ←/→ во время переноса); чужую — попробовать перетащить; протянуть по пустой сетке; ПКМ по блоку; клавиши N / T / ← → / Delete; участника из списка справа — в диалог и на карточку, голосовую комнату из списка слева — в поле «Комната» | Шаг 15 мин, «призрак» с временем, после броска блок сразу на новом месте (у других — по `EVENT_UPDATE`), ошибка сервера возвращает его с тостом; чужая не двигается (курсор «нельзя», подсказка про организатора); протягивание открывает диалог с диапазоном, клик — 30 мин; меню блока = действия карточки; Delete спрашивает подтверждение; брошенный участник / комната добавляются (подсветка цели); на телефоне перетаскивания нет — те же действия в карточке |
| C.22 | «Настройки → Календарь»: рабочие часы 09:00–18:00 пн–пт; `curl GET /api/workspaces/<ws>/freebusy?users=<я>,<коллега>&from&to` (окно ≤ 14 дней) | У каждого `timezone`, `work_hours`, занятость; чужая невидимая встреча — без `event_id`, отклонённая — не занята; гость/бот — 403, 21 человек или 15 дней — 422 |
| C.23 | `POST …/freebusy/suggest` на двоих (60 мин, «в рабочие часы»), затем с `room_id` занятой комнаты, затем коллеге рабочие дни только сб–вс | До 10 окон с шагом 15 мин в пересечении часов, без чужих встреч; комната исключает свои встречи; без общих часов — 409 `NO_COMMON_HOURS` |
| C.24 | Подключить CalDAV (Яндекс/iCloud, пароль приложения): `POST /api/me/caldav`, выбрать календарь `PUT {calendarHref, import:true}`, «Синхронизировать» | Список календарей без пароля в ответе; неверный пароль — 422 `password`; через ≤ 15 мин (или sync) у коллеги в freebusy `EXTERNAL` без названий; «Отключить» — занятость пропала |
| C.25 | Включить `push`, создать встречу, изменить, отклонить чужую, отменить свою | Встреча появилась во внешнем календаре (без повторных писем участникам), правка обновила её, отказ и отмена убрали; сервер недоступен — после 5 попыток ошибка в настройках |

Автотесты: `docs/20-calendar-testing.md` (Go-интеграционные `internal/app/events_*_integration_test.go`, unit десктопа, Playwright e2e против мока, прод-smoke).

## Подтверждение входа гостей (1.0.0)

Сервер (ADR-0040; клиент — отдельная задача, до него — curl + `wscat`/devtools). Owner `owner@calaba.test`, member `bob@calaba.test`; голосовая комната `voice` пространства «Team».

| # | Сценарий | Ожидается |
|---|---|---|
| G.1 | Owner: `PATCH /api/rooms/{voice} {guestApproval:true}`, ссылка без `requireApproval`; превью `GET /api/room-invites/{code}` | `Room.guestApproval = true` (`ROOM_UPDATE`), `requiresApproval: true` в превью |
| G.2 | Аноним по ссылке с ником «Гость» | `201` + `admission.status = PENDING`; у owner `ROOM_ADMISSION_REQUEST`, у bob — нет; READY гостя: `pendingAdmissions[0]` с `roomName`, комнаты `voice` нет; `GET /api/rooms/{voice}/messages` и `POST …/join` — `404` |
| G.3 | Owner: `POST /api/rooms/{voice}/admissions/{guest} {status: ADMITTED, displayName: "Анна (Ромашка)", badgeId}` | `200`; гость получает `ROOM_ADMISSION_DECIDED ADMITTED` и `ROOM_CREATE`, права = биты ссылки; имя и бейдж в списке участников |
| G.4 | Второй гость стучит → owner `DECLINED`; гость стучит снова | Гостю `DECIDED DECLINED` и `WORKSPACE_DELETE` (членство снято); повторный стук ≤ 10 мин — `429 ADMISSION_DECLINED` |
| G.5 | Третий гость стучит и ждёт 30 мин (или `DELETE /api/rooms/{voice}/admissions/me`) | Через ≤ 30,5 мин `DECIDED DECLINED` с `noAnswer: true`, стучать можно сразу; отмена — `204`, решающим `DECIDED CANCELLED` |
| G.6 | Ссылка с `requireApproval:false` в той же комнате; bob → `POST …/admissions/{guest}`; бот-токен → `GET` / `POST` admissions | Гость входит сразу; bob — `403`; бот: `GET` по правам, `POST` — `403 BOT_NOT_ALLOWED` |

Автотесты: `go test -tags integration ./internal/app -run GuestAdmission`, unit `internal/guests/admissions_test.go`, мок `e2e-support/mock-admissions.test.ts`.

## Доски задач (1.1.0)

Сервер (ADR-0042; клиент — своя ветка, до него — curl + devtools). Owner `owner@calaba.test`, member `bob@calaba.test`, пространство «Team»; матрица автотестов — `docs/21-boards-testing.md`.

| # | Сценарий | Ожидается |
|---|---|---|
| K.1 | Owner: `POST /api/workspaces/{id}/boards {name:"Fintech Next Gen", template: DEVELOPMENT}`, второй с тем же названием, третий с `key:"1X"` | `201`, ключ `FNG` и 6 статусов; второй — `FNG2`; `422`; bob — `403` |
| K.2 | Bob: `GET …/boards`, `PATCH /api/boards/{id}` | Видит доску с битами `VIEW_BOARD \| CREATE_TASKS`; правка — `403` |
| K.3 | Приватная доска; owner даёт bob `VIEW_BOARD` лично, потом роли, потом снимает | Без доступа — `404` и нет в списке; с доступом bob получает `BOARD_CREATE` без перезахода, после снятия — `BOARD_DELETE` |
| K.4 | Гость комнаты: `GET …/boards`, `GET /api/boards/{id}`, `GET /api/rooms/{task.roomId}/messages` | `403`, `404`, `404`; в READY досок нет |
| K.5 | Бот-токен: список, `POST …/tasks` с ботом-исполнителем, `PUT …/permissions`, `DELETE …?purge=1` | `200`, `201`, `403 BOT_NOT_ALLOWED` ×2 |
| K.6 | Три задачи (вторая «после первой»), два `isLead` в исполнителях, подзадача подзадачи | `FNG-1..3`, позиции по порядку; `422`; `422` |
| K.7 | `PATCH {statusId, beforeTaskId}` 100 раз между двумя соседями | Порядок верный, колонка перенумерована (позиции шагом 1024) |
| K.8 | Задачу в «В работе», затем в «Готово», затем обратно в Todo | `startedAt` один раз; `completedAt/completedBy` ставятся и снимаются |
| K.9 | Bob правит чужую задачу, свою, назначенную на себя; с `EDIT_TASKS` — чужую | `403`, `200`, `200`, `200` |
| K.10 | `GET /api/tasks/{id}/activity`, `GET /api/boards/{id}/activity?format=csv` | Записи журнала и комментарии одной лентой (новые первыми); CSV с ключами задач; bob — `403` |
| K.11 | Комментарий в `task.roomId`: реакция, закреп (owner), поиск `?q=`, файл через `POST /api/boards/{id}/files`, пересылка из/в задачу | Всё как в чате; bob закрепить не может (`403`); комнаты задачи нет в READY и `GET …/rooms` |
| K.12 | `GET …/tasks?filter=` «мои», «просрочено» (`DUE_ON BEFORE today`), «без исполнителя», текст, `any` | Ровно подходящие задачи; битый фильтр — `422` |
| K.13 | Виды: общий (owner), личный (bob), вид по умолчанию | Bob — общий `403`; личный видит только bob; `defaultViewId` — только общий |
| K.14 | `GET /api/me/tasks?scope=lead&open=1`, `GET …/tasks/search?q=FNG-1`, `GET /api/t/fng-1` | Свои задачи; точное совпадение первым; задача с доской и комнатой |
| K.15 | «Создать задачу из сообщения» из общей комнаты и из приватной, которую bob не видит | Описание начинается с цитаты и ссылки `/m/<room>/<message>`; `404` |
| K.16 | `PATCH {boardId}` bob и owner (MANAGE_BOARD на обеих) | Bob — `403`; новый ключ `OTH-1`, запись `moved_board`, старая доска получает `TASK_DELETE` |
| K.17 | Архивировать / восстановить задачу; завершённую 31 день назад — ждать метёлку (или `auto_archive_days`) | Нет в списке, есть в `?archived=1`, комната только для чтения; метёлка архивирует, журнал `archived {auto:true}` |
| K.18 | Назначить bob, прокомментировать, сменить статус; bob: «Задачи» = «Упоминания», затем «Отписаться» | `TASK_UPDATE` с `notice` ASSIGNED / COMMENT / STATUS в `user:<bob>`, `unreadTaskIds` в READY, `PUT …/read` снимает; при «Упоминания» — только `@bob`; отписка глушит комментарии |
| K.19 | В чате ссылка `https://<APP_HOST>/t/FNG-1` и `/b/<id>`; от bob — на приватную | `GET /api/unfurl` — карточка задачи/доски без HTTP-запроса; невидимое — `404` |
| K.20 | Тариф Free: четвёртая доска; удалить статус без `move_to` и дефолтный | `409 PLAN_LIMIT`; `422`; `409` |
| K.21 | Клиент: доска → `3` (таймлайн), «Неделя»; потянуть полосу на 2 дня, край — на день, чип из «Без дат» — на шкалу; вехой — влево; клик по полосе | Полосы двигаются по дням, `PATCH` только изменившихся дат (у одной даты — одна дата), красная точка у задачи с поздним блокирующим, веха — `PATCH milestones`; панель задачи. Телефон: только прокрутка |
| K.22 | Клиент: правый клик по сообщению в комнате → «Создать задачу», сменить доску, создать; открыть ссылку `/m/…` из описания | Заголовок — первая строка без разметки, `POST … fromMessageId`, в описании цитата и ссылка; ссылка открывает комнату и прокручивает к сообщению; в следующий раз выбрана та же доска |
| K.23 | Клиент: в чате `https://<APP_HOST>/t/CAL-3` и `/b/<id>`; сменить статус CAL-3 на доске; клик по карточке. Меню пространства → Уведомления → «Задачи: ничего»; архивировать доску → «Архив» → «Восстановить» | Карточка: ключ, заголовок, статус, исполнители, срок; статус обновляется без перезагрузки; клик — режим досок и панель; `PUT …/notifications {taskLevel}`; доска возвращается в список |
| K.24 | Доска по карточкам (ADR-0059): приватная доска без bob; owner ставит bob исполнителем SCP-1, carol — согласующей SCP-2 | bob: `BOARD_CREATE` (`taskScoped`, `permissions 0`), затем `TASK_CREATE`, уведомление «назначен»; в списке досок, ⌘K, «Мои задачи», unfurl — только SCP-1; SCP-2 — `404`; «+ Задача», виды, журнал, доступ — `403`; правка и комментарий SCP-1 — `200`; carol голосует и комментирует, правка — `403` |
| K.25 | Owner снимает bob с SCP-1; закрывает доску (`restricted`); зовёт гостя или бота без доступа | bob: `TASK_DELETE`, затем `BOARD_DELETE`; carol теряет доску; назначение на закрытой доске, гостя, бота — `422` |
| K.26 | Клиент (K.24): bob — список досок и канбан, открыть SCP-1; carol — открыть SCP-2; у owner открыть пикер исполнителей; owner снимает bob | У bob чип «Только мои карточки», нет «+ Задача» / `C` / ⋯ → настройки / «Сохранить как вид» / панели массовых действий; в SCP-1 правка и комментарии, у carol поля read-only, видны голосование и комментарии; в пикере у не видящих доску подпись «увидит только эту карточку», на закрытой доске disabled «закрытая доска»; после снятия панель закрывается, доска исчезает из списка |

Автотесты: `go test -tags integration ./internal/app -run 'Board|Task'`, unit `internal/boards`, векторы `pnpm -F @calaba/protocol test`.

## Bot inline buttons (ADR-0047)
1. Bot sends text with an author-bound keyboard; only that author can press it.
2. Press: local pending then accepted, whole keyboard disabled; no automatic chat message.
3. Bot receives one private callback with authenticated user and saved data; another bot/human receives none.
4. Retry a timed-out press with the same nonce: same id, no new outbox entry; bot dedupes effects by callback id.
5. Text edit invalidates the old revision; keyboard-only edit preserves text; empty keyboard removes buttons.
6. Stale click refreshes the visible draft without executing its new button; new revision enables deliberate press.
7. Disabled/foreign buttons, lost access, blocked/revoked bot, removed last shared DM workspace, cleared/deleted message reject.
8. Forward keeps text but no active keyboard; ordinary human create/edit still works and cannot forge buttons.
9. `go test -race -tags integration ./internal/app -run 'TestInline|TestBotRouteTable'`; `pnpm -F @calaba/bot-sdk test`.
10. Visual: `e2e:visual -g chat-inline-buttons`, `e2e:visual:mobile -g m-chat-inline-buttons --project webkit-iphone-14`; behaviour: visual project `inline-buttons`.

## Расширенный Bot API (ADR-0051, docs/09 #153)
1. Авто: `cd apps/server && TEST_REDIS_URL=redis://localhost:56379/11 go test -tags integration -count=1 ./internal/app -run 'TestBotAPIv2|TestBotRouteTable|TestEventBots'` — ok; `pnpm -F @calaba/bot-sdk test`.
2. Руками (`make dev-server`, владелец создаёт бота Echo, `TOKEN=calab_bot_…`, `WS`, голосовая `VOICE`, участник `BOB`): роль «Бот-админ» с `MANAGE_NICKNAMES`, `MANAGE_EVENTS`, `INVITE_MEMBERS` → назначить боту. В карточке роли — жёлтое предупреждение «Роль есть у 1 бота…».
3. Встреча: `curl -X POST $CALAB/api/workspaces/$WS/events -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"title":"Бот-встреча","roomId":"'$VOICE'","startsAt":"2026-10-05T09:00:00Z","endsAt":"2026-10-05T09:30:00Z","attendees":[{"userId":"'$BOB'","required":true},{"email":"x@example.com"}]}'` → 201, `organizerId` = бот, бота нет в `attendees`. В Mailpit (:8025) письмо на x@example.com: «<пространство> (от имени бота Echo) приглашает…», без гостевой ссылки; у Боба встреча в календаре.
4. `PATCH /api/events/<id> {"title":"Перенесли"}` → 200; `PUT /api/events/<id>/rsvp` → 403 `BOT_NOT_ALLOWED`; `DELETE /api/events/<id>` → 204.
5. Переименовать: `curl -X PATCH $CALAB/api/workspaces/$WS/members/$BOB -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"nickname":"Боря"}'` → 200, ник сменился у всех.
6. Профиль: `curl $CALAB/api/workspaces/$WS/members/$BOB -H "Authorization: Bearer $TOKEN"` → `member` + `openTasks` (задачи Боба только с досок, видимых боту; задача закрытой доски не видна).
7. Инвайт: `curl -X POST $CALAB/api/workspaces/$WS/invites -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"maxUses":1}'` → 201 с `code`; ссылка `/join/<code>` пускает нового человека. Снять у роли `INVITE_MEMBERS` → тот же запрос 403 (не `BOT_NOT_ALLOWED`).
8. `GET …/freebusy?users=$BOB&from=…&to=…` → 200, в `busy` нет `title`; `POST …/invites/lookup` → 403 `BOT_NOT_ALLOWED`.
9. В логе сервера на шаги 3–5 и 7 — строки `bot action` с `bot_id` и `bot_owner`.


### Identity 2.0: совместимость локальных событий и чтения

- Go 1.26.8: gateway race units проверяют собственный receipt без membership, A/B isolation, версии/expiry, final socket/replay и bounded cold preparation с resync при overload.
- На отдельной PG18 БД/Redis выполнить App race с фильтром `TestIdentityCompatibility.*|TestIdentityFileReferences.*|TestForwardMessages|TestIdentityProfileImagesRequireCurrentScopedMembership`.
- READY сохраняет все 258 разрешённых memberships; удалённые memberships и истёкшие receipts удаляются из lease state.
- Operator-off local reauth принимает только local bearer/password и точный непустой trusted Origin, сохраняет limiter; bot/scoped/recovery запрещены, SSO остаётся 503.
- Архивная временная комната: разрешённая history читается, POST/voice дают ROOM_ARCHIVED; существующий message-edit handler сохраняет 404. Permanent archive, B и recovery не открываются.
- Invite preview учитывает неизвестные коды и не списывает успешный preview дважды; GET/HEAD file/thumbnail используют каждую разрешённую live reference через WithPolicy/CanRead.

- Suspended workspace: `TestWorkspaceSuspension|TestIdentitySuspensionLocalReadIsolation|TestGatewayFlow` (PG18 race) сохраняют local off/optional history/member/READY; проверяют scoped/recovery/enforced/ACL/directory-denials и запрет TYPING при receive lease (ADR-0056).

### Built-in Calab Stikers (ADR-0057)

- `go test ./internal/builtinstickers ./internal/stickers ./internal/pbconv ./internal/messages` in `apps/server`: embedded WebP validation and public allowlist/cache.
- PG17 + Valkey 9/Redis 7.4: `go test -tags integration -run 'Test(BuiltinStickers|Sticker)' ./internal/app` with isolated TEST_PG_URL / TEST_REDIS_URL.
- Desktop Vitest: `src/renderer/lib/{stickers,builtinStickers,stickerSuggest}.test.ts`; build:web + build:app include the same 16 assets.
- Manual: fresh account → stickers → Calab Stikers; emoji search, send to room and DM, reload history, view pack, check fixed built-in label in My stickers.
- Guest with SEND_MESSAGES: send and forward succeed; without SEND_MESSAGES: send rejected. Free workspace: custom pack allowance unchanged.
- Unknown asset ID: 404; public built-in route never serves uploads.
