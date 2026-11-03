# ADR-0158: MCP без бота — личный вход через OAuth (2026-11-03)

**Статус: предложено.** Дополняет [ADR-0114](0114-mcp-endpoint-for-bots.md) (MCP как бот) и
[ADR-0156](0156-mcp-on-behalf-and-via-mark.md) (бот от имени человека, пометка «через MCP»): в
ADR-0156 OAuth MCP был записан в «Что не делаем». Переезд разработки GPTunneL с Linear: агент
разработчика (Claude Code, Codex, Cursor) должен подключаться к Calab так же, как к Linear MCP —
адрес сервера в конфиге, «Authenticate» в клиенте, браузер, «Разрешить». Без бота, без
`MANAGE_BOTS`, без вечного токена в файле.

## Контекст
- Сейчас агент разработчика — это его бот: создать бота (право `MANAGE_BOTS`), «Делегировать права →
  Разрешить», положить токен в переменную окружения, прописать два заголовка. Токен бота живёт до
  отзыва, а с «от моего имени» это фактически пароль владельца.
- MCP-клиенты (Claude Code, Claude Desktop/claude.ai, Codex, Cursor, MCP SDK) поддерживают
  авторизацию из спецификации MCP (2025-06-18): ответ `401` с `WWW-Authenticate` → метаданные
  ресурса (RFC 9728) → метаданные сервера авторизации (RFC 8414) → динамическая регистрация
  клиента (RFC 7591) → Authorization Code + PKCE S256 (OAuth 2.1) с `resource` (RFC 8707) →
  `Authorization: Bearer` на каждом запросе, обновление по refresh token.
- OAuth-провайдер Calab (ADR-0054, ADR-0102) не подходит: клиент принадлежит одному пространству и
  заводится админом, scopes только `openid profile email`, токены провайдера по ADR-0054 не дают
  доступа к API, нет динамической регистрации, нужен Business.

## Решение
1. **Сервер авторизации MCP** — отдельный пакет `internal/mcpauth`, только для `/api/mcp`.
   Issuer — origin приложения (`PUBLIC_APP_URL`; запрос с другого origin из `PUBLIC_APP_URLS`
   получает свой origin).
   - `GET /.well-known/oauth-protected-resource/api/mcp` (и без пути) — `resource`
     = `<origin>/api/mcp`, `authorization_servers` = [`<origin>`], `scopes_supported` = [`mcp`].
   - `GET /.well-known/oauth-authorization-server` — `authorization_endpoint`
     `/api/mcp/oauth/authorize`, `token_endpoint` `/api/mcp/oauth/token`, `registration_endpoint`
     `/api/mcp/oauth/register`, `revocation_endpoint` `/api/mcp/oauth/revoke`; только `code`,
     `authorization_code` + `refresh_token`, `S256`, `token_endpoint_auth_methods` = [`none`].
   - `/api/mcp` без токена или с негодным токеном отвечает `401` с
     `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp"`.
   - Caddy отдаёт эти два `/.well-known/...` пути API, а не SPA.
2. **Регистрация** (`POST /api/mcp/oauth/register`, RFC 7591): только публичные клиенты
   (`token_endpoint_auth_method: none`), до 10 redirect URI до 512 символов: loopback
   `http://localhost`, `http://127.0.0.1`, `http://[::1]` с любым портом и путём, или **ровно** один
   из `https://`-адресов `MCP_OAUTH_REDIRECT_URIS` (по умолчанию callback веб-коннекторов
   `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`) — не весь
   хост: другой путь на нём мог бы унести код. Имя клиента — до 100 символов, без управляющих,
   bidi- и невидимых символов; на согласии показывается как названное самим клиентом. Лимиты по
   адресу (IPv6 — по /64, Valkey): регистрация 10 сразу и 10 в час, authorize 30 в минуту, token и
   revoke 60 в минуту; тела token/revoke до 8 КиБ. Клиент без выданных сессий удаляется через сутки.
3. **Согласие в приложении.** `GET /api/mcp/oauth/authorize` проверяет клиент, точное совпадение
   `redirect_uri`, `response_type=code`, PKCE S256 (`code_challenge` 43–128 символов),
   `resource` (если есть — ровно `<origin>/api/mcp`; запрос запоминает ресурс своего origin, и код
   обменивается только там же) и `scope` (пусто, `mcp` или `offline_access`; иное — `invalid_scope`). Ошибка до
   проверки `redirect_uri` — страница ошибки, после — редирект с `error`. Запрос живёт 10 минут;
   браузер, начавший его, получает cookie `__Host-calab_mcp` (4 последних запроса, как у провайдера
   ADR-0054) и редирект в SPA `/mcp/connect#<handle>`. Страница входит (или просит войти) и вызывает:
   - `POST /api/mcp/oauth/requests/{handle}/bind` — только сессия человека с authority
     `local_account` (не бот, не «от имени», не MCP-сессия, не SSO-сессия пространства, не
     recovery) и с cookie того же браузера: запрос привязывается к сессии и пользователю, ответ —
     имя клиента, куда вернётся код (loopback — «программа на этом компьютере», порт), кто входит и
     одноразовый CSRF-токен;
   - `POST /api/mcp/oauth/requests/{handle}/decision` (CSRF, та же сессия): «Разрешить» выдаёт код
     (60 секунд, один раз, хранится хэшем), «Отказать» — `error=access_denied`; ответ — адрес
     редиректа, SPA переходит на него.
   Ссылку на чужой запрос открыть нельзя: без cookie браузера-инициатора `bind` отказывает; запрос с
   чужого сайта (`Sec-Fetch-Site: cross-site` или чужой `Origin`) — тоже. Ссылку на сам `/authorize`
   переслать можно, поэтому страница говорит, куда вернётся код и когда начат запрос, и
   предупреждает: «разрешайте, только если подключение начали вы сами»; для loopback код всё равно
   уходит на компьютер жертвы.
4. **Токен** (`POST /api/mcp/oauth/token`, form): `authorization_code` проверяет код, клиента,
   `redirect_uri`, `code_verifier` и создаёт **сессию человека** (`sessions.scope = 'mcp'`,
   `sessions.mcp_client_id`, устройство «MCP · <имя клиента>», authority `local_account` без
   `local_authenticated_at`), если сессия, давшая согласие, ещё жива; повторный код отзывает
   выданную им сессию; прежние MCP-сессии того же человека и клиента отзываются (`MCP_REPLACED`),
   живых MCP-сессий у человека не больше 10. Ответ — access JWT с issuer `calaba-mcp` и claim
   `scp: "mcp"` (срок как у access-токена приложения), refresh token `mcp.<session>.<secret>`
   (ротация и обнаружение повтора — общая логика сессий, ADR-0040), `token_type: Bearer`,
   `scope: mcp`. Свой issuer и префикс refresh — чтобы сервер без этой версии (откат, старый под при
   выкатке) не принял MCP-токен за токен приложения; Down миграции сначала отзывает MCP-сессии. `refresh_token`
   обновляет только MCP-сессию этого клиента (гонка двух обновлений — `temporarily_unavailable`, не
   `invalid_grant`); `/api/auth/refresh`, `/api/auth/logout` и cookie браузера MCP-сессию не
   принимают, а MCP-эндпоинт токена — сессию приложения. `POST /api/mcp/oauth/revoke` (RFC 7009)
   отзывает MCP-сессию своего клиента по refresh token. Сессия видна и отзывается в «Настройки → Сеансы».
5. **Где действует MCP-токен.** `auth.Require` пропускает токен со `scp: mcp` только на
   `POST /api/mcp` и во внутренних вызовах инструментов (канал `mcp` в контексте, ставит только
   сервер, ADR-0156) только на маршрутах, которые вызывают инструменты (`mcp.InnerRoutes`, по шаблону
   маршрута); на любом другом — `403 MCP_TOKEN`. Токен сверяется с сессией: `scp` должен совпадать с
   `sessions.scope`. `AuthenticateToken` (gateway, совместное редактирование) MCP-токен не
   принимает. Запросы MCP-сессии ограничены как у бота (`BOT_RATE_PER_SEC`, ключ — сессия).
6. **Личность.** MCP-сессия — это сессия человека: права, политика пространства (SSO, бан, тариф,
   приостановка) — как у приложения. У неё нет свежего локального входа, поэтому маршруты с
   повторным вводом пароля закрыты; пространство с обязательным SSO MCP-сессию не пускает (в нём нет
   SSO-подтверждения). Инструменты — те же 9; запись помечается «через MCP» без бота:
   «Имя (через MCP)», `via_bot_id` пуст.
7. **Подключение**: в MCP-клиенте только адрес `https://app.calab.io/api/mcp` (Claude Code:
   `claude mcp add --transport http calab https://app.calab.io/api/mcp`, затем `/mcp` →
   Authenticate). Путь через бота (ADR-0156) остаётся для автоматизаций без человека.

## Последствия
- Подключиться может любой участник без прав на ботов; агент видит ровно то, что видит человек.
- Токен на диске клиента — refresh token MCP-сессии: живёт как сессия приложения, обновляется,
  отзывается в «Сеансах», повтор украденного отзывает сессию.
- Новые таблицы `mcp_oauth_clients`, `mcp_oauth_requests`; колонки `sessions.scope`,
  `sessions.mcp_client_id` (nullable, проверки `NOT VALID`, без сканирования); частичные индексы
  `CONCURRENTLY` (миграция 00146).
- Новый инструмент, который вызывает ещё один маршрут, добавляет его в `mcp.InnerRoutes`, иначе
  через OAuth-подключение он получит `403 MCP_TOKEN` (бота это не касается).
- Публичные маршруты регистрации и токена ограничены по IP.

## Что не делаем
- Согласие без входа в веб-приложение (device flow), запоминание согласия.
- Выбор пространств и прав на согласии: доступ — всё, что может человек, через инструменты MCP.
- MCP-токены для REST и gateway.
