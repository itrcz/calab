# Calaba 2.0: нормативный контракт Identity v1 (2026-10-01)

Основание: [ADR-0054](../adr/0054-workspace-identity.md). Владелец архитектуры — ведущий
агент; владелец DB/proto/Go-signatures — Foundation. Статус: спецификация реализации,
не отчёт о готовности. Общая ветка `identity-delivery`. Изменения только в изолированных
ветках; main/deploy не затрагиваются автоматически. Исследовательские предложения
подчиняются этому контракту. При пробеле исполнитель сообщает точный вопрос и блокирует
только зависимую часть; не выбирает новый контракт молча.

## 1. Фиксированные продуктовые границы

SSO: generic OIDC / tenant-specific Entra / AD FS 2019+; standalone workspace login и
step-up локальной сессии. Никакого JIT глобальных пользователей или linking по email.
Доступны уже приглашённые/подготовленные участники с явной связью внешней идентичности.
Для нового человека — существующий локальный onboarding, затем linking, затем SSO.
Onboarding/linking доступны через узкий bootstrap-контур без выдачи данных enforced
workspace. Этот контур не считается выполненным SSO.

LDAPS: периодическая синхронизация статуса заранее связанных участников и фильтра
допустимых групп. Группы — только прямое членство в v1, nested groups не обещаем.
Автосоздание аккаунтов, group-to-role mapping, SCIM и cloud connector вне v1.

OAuth provider: клиенты workspace, вход людей и минимальный профиль. Не доступ к API
чата, не bot token и не объект `workspace_apps`. Даже доверенный админ приложения
получает consent пользователя; скрытого admin consent в v1 нет.

SSO/AD — Business и on-prem Enterprise. Для OAuth provider принимаем те же тарифы как
явное допущение до уточнения владельца. Объём прямого LDAP ранее не подтверждён ответом
владельца; он включён в рабочий план, его можно исключить до реализации без изменения
OIDC-потоков. Ни один агент не должен расширять эти границы по аналогии с чужим продуктом.

## 2. Общая модель доступа

`Principal` содержит `user_id, session_id, authority_kind, authority_workspace_id?,
authority_connection_id?, local_authenticated_at?`. Kind: `local_account`,
`workspace_sso`, `recovery`; неизвестный/нулевой kind запрещён. Существующие сессии
мигрируют в local_account **без** нового local_authenticated_at или SSO assurance.

`CheckAccess(ctx, principal, workspace_id, operation)` возвращает allow/deny и
`reason, policy_version, membership_version, valid_until`. Operation — закрытый enum:
`read, mutate, realtime, rtc, oauth_issue, oauth_userinfo, manage_sso, manage_oauth,
manage_directory, bootstrap_link, recover_policy`. Нулевое значение запрещено.
DB/proto владелец материализует эти поля в типизированный Go-контракт и фиксирует
экспортируемые signatures до запуска consumers; строковые самодельные DTO запрещены.

Порядок проверки: живая session → authority scope → workspace exists/suspension gate →
membership/not banned → directory status/freshness для managed member → entitlement
для feature operation → policy/assurance → существующие permissions/ACL ресурса.
У guest/bot отдельная категория: они не проходят человеческий bootstrap/OAuth;
боты используют прежние permissions и дополнительно workspace suspension. Guest при
enforced не допускается независимо от приглашения. Recovery не проходит read/mutate/
realtime/rtc/oauth; только recover_policy. При неизвестном состоянии зависимостей — отказ.

Suspension gate сохраняет прежнее read-only поведение только для local_account в
текущей off/optional policy: WorkspaceRead проходит остальные gates и ACL, включая
member suspension и directory freshness. Passive gateway/READY/replay используют read,
но publication (Realtime/TYPING), mutations, RTC, OAuth и identity management запрещены.
Enforced/scoped/recovery/bot не получают исключение; GET/HEAD не подменяют mutating method.
См. ADR-0056 и точное уточнение §13.

`workspace_sso(A)` не может обратиться к B, `/api/admin/*`, глобальным credentials,
session administration, DM, notes, созданию других workspace и агрегатам вне A.
`/me` отдаёт ограниченный профиль без superadmin и связей B. Link/unlink глобального
аккаунта, local credentials и локальный superadmin требуют local_account + reauth.
Обычный local_account не обходит enforced в A, даже если имеет права owner.

`workspace_assurances(session_id,workspace_id,connection_id,identity_id,authenticated_at,
expires_at,policy_version,connection_version)` выдаётся только успешным OIDC callback.
Refresh/local password/recovery не создают и не продлевают assurance.

Для обычного доступа corporate proof ≤1 часа. Для изменения connection/policy/directory,
recovery kit и OAuth client/secret в enforced workspace нужна corporate proof ≤5 минут
плюс local reauth ≤5 минут. Bootstrap первого test/link/recovery setup при off/optional
не требует ещё не существующей assurance; включение enforced требует обеих свежих proofs.
Recovery repair вместо этого проверяет собственный одноразовый recovery proof ≤10 минут.
Optional local_account работает без SSO proof; workspace_sso всегда требует действующую
assurance и SSO entitlement, даже если policy optional.

Допускается уже подготовленный Foundation Go seam: `Evaluate(now, State, Operation)`,
`Service.CheckWorkspace`, `Loader.LoadIdentityState(ctx,sessionID,userID,workspaceID)`,
`CheckGlobal`, `CheckSession`, `RequireEntitlement`, `Principal/State/Decision/Versions`.
Перед consumers Foundation публикует явное отображение операций выше в Go constants;
оно не меняет семантику allow/deny. Постоянный on-prem grant не требует выдуманной даты
окончания подписки; возвращаемый access lease всё равно имеет конечный valid_until.

## 3. Entitlement, политика, ошибки

`identity_entitlements(workspace_id,feature,enabled,source,updated_by,updated_at)`:
features `corporate_sso`, `directory_sync`, `oauth_provider`.
Cloud: allow = enabled AND действующий Business (`enterprise` в БД).
On-prem: allow = enabled AND `IDENTITY_EDITION=enterprise` AND workspace в
`IDENTITY_ENTERPRISE_WORKSPACE_IDS` (точные UUID, не wildcard). Edition и allowlist
только env оператора. Defaults: cloud, пустой список, features выключены.
Custom/Free/Team/expired не получают allow по пустой конфигурации; nil service/error
не дают allow. Истечение проверяется по now, даже при старом enabled grant.
Назначение Business может включить grants транзакционно с audit; backfill только
существующих действующих Business, не всех старых строк.

Policy `off|optional|enforced` + version. Connection `draft|tested|active|disabled`.
Enforced включается только owner local reauth + успешный test актуальной config,
его link, свежая assurance и подтверждённый recovery kit. Любое изменение issuer,
client_id, endpoints/secret сбрасывает test, повышает connection version, отзывает
транзакции/assurances. Изменение issuer/client_id создаёт новый draft без переноса
identities по email; старая connection остаётся до явной активации замены. Ротация
secret при неизменных issuer/client_id обновляет ту же connection: version++, draft,
tested=false, немедленный отзыв её assurances/scoped sessions/provider grants и
pending flows в одной транзакции с audit/outbox. Identity tuple и connection_id
сохраняются. Это плановая ротация с повторным входом и возможным простоем, не обещание
бесшовной смены. UI предупреждает до сохранения; для enforced требуется готовый
recovery kit и обе свежие proofs до мутации. Concurrent update по старой version → 409.

Владелец с local reauth может выполнить purpose=test черновика и при enforced без
устаревшей assurance: это узкий control-plane endpoint без доступа к данным/выдачи
сессий/OAuth. Test callback фиксирует только проверенный subject владельца и время
test текущей версии; subject должен совпасть с его ранее явно привязанной identity.
Активация ротации требует local reauth ≤5min и этого успешного owner test ≤5min,
не старой инвалидированной assurance. При changed issuer/client_id действует явный
link нового subject с независимым local proof; совпавший email не является доказательством.
Неуспешный test оставляет доступ закрытым; recovery остаётся отдельным путём ремонта.
Удаление/disable active connection при enforced закрывает доступ,
не открывает пароль. Переход enforced → optional/off только явным owner recovery либо
owner local reauth + свежий SSO, с уведомлением и audit.

При downgrade данные/identities/consents сохраняются. Новые SSO/OAuth выдачи и sync
запрещены; grants/assurances инвалидируются. Enforced → effective `entitlement_locked`,
не optional. Recovery/revoke/просмотр своего статуса блокировки доступны без подписки.

REST: 401 только невалидная Calaba session; 403 `SSO_REQUIRED`, `RECENT_AUTH_REQUIRED`, `IDENTITY_SCOPE_DENIED`,
`DIRECTORY_ACCESS_DENIED`, `RECOVERY_ONLY`; 409 `PLAN_LIMIT`, `IDENTITY_CONFIG_CHANGED`,
`IDENTITY_NOT_LINKED`; 422 валидация; 503 `IDENTITY_DEPENDENCY_UNAVAILABLE`.
OAuth endpoints используют стандартные OAuth/OIDC JSON errors, не protojson envelope.
Невалидный redirect никогда не получает redirect с ошибкой — только локальный ответ.
Public discovery/login ошибки не раскрывают существование конкретного user/email.

## 4. Постоянные сроки и ограничения v1

| Объект | Значение |
|---|---|
| Local reauth для управления/linking | не старше 5 минут |
| SSO assurance | 1 час от проверенного authentication; max_age=3600, auth_time обязателен |
| Upstream state transaction / native pending flow | 5 минут, один успешный consume |
| Native completion ticket | 60 секунд, одноразовый, bound к verifier инициатора |
| OAuth request/consent | 10 минут, одноразовое решение |
| OAuth authorization code | 60 секунд, один atomic exchange |
| Provider access / ID token | не более 5 минут и не дальше срока session/assurance/entitlement |
| Provider refresh | 8 часов absolute, 30 минут idle, только пока жива исходная session/assurance |
| Recovery code / session | код 365 дней от выдачи по часам БД, одноразовый / сессия 10 минут, только policy repair |
| Clock skew при входящем ID token | 60 секунд; не продлевает внутренние deadlines |
| LDAP sync / max staleness | 5 минут / 1 час после полного успеха |
| Положительный read/WS/RTC policy cache | максимум 30 секунд, не дальше ближайшего deadline |
| Outbound HTTP | timeout 10 секунд, body до 1 MiB, redirects запрещены |
| Config/UI | name 1–100 символов, redirects 1–10, каждый до 2048 байт; до 10 origins и 20 активных клиентов/workspace |
| Случайные credentials/state/nonce | не менее 32 случайных байт, CSPRNG |

Provider revoke/deactivation проверяются из БД при issue/refresh/UserInfo, без
положительного cache. WS/RTC invalidation — событие сразу + ограниченный lease 30 с
на случай потери pubsub. При истечении lease и недоступности БД доставка закрывается,
RTC participant удаляется; отзыв обязан затронуть уже подключённых участников.
Сроки конфигурируются оператором только через валидируемые env в сторону ужесточения
этих максимумов; расширение — изменение контракта. Rate limits: begin 10/min/IP и
10/min/workspace; exchange 30/min/IP; management 30/min/user; LDAP manual sync не чаще
одного в минуту. Provider: до аутентификации — только IP-квоты без обращения к БД:
token 120/min/IP + 60/min/(client_id,IP) для public clients, authorize 60/min/IP,
UserInfo 600/min/IP, revoke 120/min/IP, discovery/JWKS/preflight 120/min/IP. После
проверки client credentials и живого code/refresh/access token — per-(client,user):
token 30/min, UserInfo 60/min (бюджет клиента растёт с числом его пользователей; аноним,
знающий public client_id, его не тратит). Квоты берутся атомарно в Valkey; при отказе
зависимости выдачи закрыты, 429 с Retry-After.
Retention provider (одна метёлка на кластер, Valkey-лок, раз в 10 минут): истёкшие
authorization requests; codes — через 24 ч после expires_at (окно replay-детекта);
access tokens — через 1 ч после истечения; grants (с их codes/refresh tokens) — через
24 ч после истечения или отзыва (включая замену при повторном согласии).

## 5. SSO flow и API

1. Пользователь выбирает workspace по slug/ссылке, получает лишь публичное имя,
   enabled/login label (не secret, не список участников). Сервер сам выбирает connection.
2. Begin — same-origin POST, purpose `login|step_up|link|test`, origin/CSRF/browser binding.
   Для link/test — local_account + recent reauth и нужная ACL; для step_up — своя session.
   Сервер сохраняет purpose, initiator, workspace, config version, state/nonce hash,
   encrypted PKCE verifier. Issuer/redirect/endpoints нельзя передать в callback.
3. Системный браузер открывает trusted authorize URL. Server callback проверяет binding,
   state/TTL/version, атомарно consumes transaction, обменивает code с S256, проверяет
   RS256/JWKS, iss/aud/azp/exp/iat/nbf/nonce/sub/auth_time; Entra ещё точный tid.
   UserInfo если нужен обязан иметь тот же sub. Не читать URL из claims/jku/x5u.
4. Сервер повторяет policy/plan/membership/directory проверки, затем либо добавляет
   assurance исходной local session, либо создаёт workspace_sso session. Unknown identity
   даёт инструкцию linking; email не является lookup для silent merge/создания пользователя.
5. Web callback сохраняет pending result и 303 на фиксированный `/sso/complete`.
   Same-origin finish POST с browser cookie завершает вход; токенов в URL нет.
   Desktop main создаёт отдельный verifier, передаёт challenge begin, открывает external
   browser. Callback выдаёт `calab://sso/complete?flow=<id>&ticket=<opaque>`; main проверяет
   свой pending flow/server origin и обменивает ticket+verifier. В renderer не попадают
   refresh/verifier/upstream tokens. Чужой процесс, перехвативший scheme, не имеет verifier.

Web transaction cookie Secure/HttpOnly/SameSite=Lax, без session credentials. Desktop
begin возвращает browser_start_url с одноразовым bootstrap handle: main открывает
его в системном браузере. GET `/api/auth/sso/browser-start` consumes handle, ставит
browser binding cookie и перенаправляет на сохранённый IdP URL; callback требует эту
cookie. Bootstrap не выдаёт credentials и не заменяет desktop verifier. Все эти ответы
no-store/no-referrer, query исключена из access logs.
Refresh workspace session — отдельная HttpOnly cookie scoped по path
`/api/auth/sso/workspaces/{workspace_id}` (разные workspace не затирают друг друга);
запрос refresh содержит workspace id, cookie и row обязаны совпасть. Локальная cookie
сохраняет прежний path и не расширяется для OAuth. Desktop использует существующий
main token broker с раздельным хранением local и workspace authority. Нельзя заменить
локальную сессию результатом SSO без явного выбора пользователя.

| Метод / путь | Контракт / доступ |
|---|---|
| GET `/api/auth/sso/workspaces/{slug}` | public descriptor: workspace_id, display_name, login_enabled, login_label; rate limit |
| POST `/api/auth/local/reauth` | local bearer + current_password → authenticated_at, valid_until; не SSO |
| GET `/api/workspaces/{id}/identity` | member: effective mode, lock_reason, entitlement, собственная assurance; owner дополнительно redacted config |
| PUT `/api/workspaces/{id}/identity/connection` | owner local reauth; version, preset, issuer, tenant_id?, client_id, secret? → redacted config; отсутствие secret сохраняет, пустой недопустим |
| POST `/api/workspaces/{id}/identity/test` | owner local reauth; создаёт purpose=test; success только после реального callback |
| POST `/api/workspaces/{id}/identity/connections/{connection_id}/activate` | owner, version; явная активация проверенной connection по §3, возвращает redacted IdentityConnection, mode не меняет |
| PUT `/api/workspaces/{id}/identity/policy` | owner local reauth + fresh assurance либо recovery; version, mode; guards из §3 |
| POST `/api/auth/sso/workspaces/{id}/begin` | purpose, client_kind web/desktop, desktop_challenge? → flow_id, browser_start_url (desktop) или authorization_url (web), expires_at |
| GET `/api/auth/sso/browser-start` | одноразовый bootstrap handle → browser binding cookie и trusted IdP redirect; только desktop initiation |
| GET `/api/auth/sso/callback/{connection_id}` | code/state/error → fixed completion; state selects saved context |
| POST `/api/auth/sso/finish` | web browser binding, flow_id → session/assurance result |
| POST `/api/auth/sso/exchange` | desktop flow_id,ticket,verifier → session/assurance result |
| POST `/api/auth/sso/workspaces/{id}/refresh` | scoped refresh rotation, authority unchanged, assurance not extended |
| POST `/api/auth/sso/workspaces/{id}/logout` | revoke this scoped session + its provider grants |
| DELETE `/api/workspaces/{id}/identity/link` | own local reauth + fresh SSO; disallow removing last owner recovery route; invalidate scoped sessions/grants |
| POST `/api/workspaces/{id}/identity/recovery-kit` | owner local reauth + fresh SSO; 10 one-time recovery codes, shown once, hashes only; rotation revokes old |
| POST `/api/auth/sso/workspaces/{id}/recover` | independent owner local login + recovery_code → recovery-only session; code atomically consumed, audit |

Recovery requires pre-existing independent owner local credential; IdP claims cannot
create/replace it. Normal global password recovery remains under local proof rules,
cannot mint workspace assurance. Lost local credential AND recovery kit requires an
audited on-prem operator/support procedure, not secret automatic fallback.

## 6. LDAPS lifecycle

Owner local reauth + fresh SSO manages `/api/workspaces/{id}/identity/directory`:
GET redacted config/status; PUT `{version,enabled,url,bind_dn,bind_password?,base_dn,
allowed_group_dns[]}`; POST `/test`; POST `/sync`; GET `/members` cursor pages;
PUT `/members/{user_id}` `{object_guid}` sets explicit directory link to an existing
member, independently of OIDC sub. Only one directory per workspace in v1.

Only `ldaps://` port 636 and operator-allowed hosts/network targets, certificate hostname
and CA validation; no insecure TLS, anonymous bind, referrals or arbitrary filter text.
Read-only bind secret encrypted. Server builds escaped filters for AD `objectGUID`,
`userAccountControl` (ACCOUNTDISABLE), `memberOf`; page 500, bounded complete scan
(100k records, 120 s deadline). objectGUID conversion uses AD binary encoding, tested
with canonical vectors. No mapping objectGUID to Entra oid/sub without explicit binding.

Each sync stages a generation, then transactionally publishes only a complete successful
snapshot; last_success_at updates at that commit. Disabled object, missing object in
complete authoritative search, or loss of direct allowed group → suspend that managed
membership and revoke its assurances/grants. Partial pages, scope/config change or
network errors never imply mass deletion. Existing directory suspensions stay suspended;
freshness expiry denies managed access. Unmanaged members are not disabled by LDAP.
Re-enabled eligible object permits a new SSO login; old grants are never resurrected.
Directory unlink/disable does not silently turn suspended users into ordinary members:
owner must explicitly detach each affected member after review, with audit.

## 7. Provider wire contract

Origin из env `IDENTITY_PUBLIC_ORIGIN` (HTTPS, no path/query/fragment); issuer `I` =
origin + `/oidc/workspaces/{uuid}`. `Host`/forwarded headers не определяют issuer.
OIDC discovery: `GET I/.well-known/openid-configuration`. OAuth RFC8414 metadata:
`GET /.well-known/oauth-authorization-server/oidc/workspaces/{uuid}`. Endpoint URLs
ниже абсолютные, принадлежат I; Caddy проксирует до SPA fallback.

| Endpoint | Семантика |
|---|---|
| GET/POST `I/authorize` | code only; GET query или POST form-urlencoded; client_id, exact redirect_uri, scope, state, nonce, code_challenge S256 |
| POST `I/token` | form-urlencoded; authorization_code или refresh_token; confidential client_secret_basic, public none |
| GET `I/jwks` | RS256 public keys only; kid/alg/use; cache max-age=60 |
| GET/POST `I/userinfo` | provider access Bearer only; no cookie/first-party/bot tokens |
| POST `I/revoke` | form token, optional hint, correct client auth; unknown token → 200; wrong client cannot revoke another |

Metadata только реально поддерживаемые scopes/flows/methods: openid/profile/email,
code/query, authorization_code/refresh_token, S256, RS256, public subjects,
client_secret_basic/none. Authorization response includes `iss=I`. Не рекламировать
logout/dynamic registration/pairwise/offline_access. `state` и `nonce` обязательны
в профиле Calaba, ≤512 байт. `prompt=login`/max_age требуют подтверждённой новой auth,
не refresh; `prompt=none` возвращает login_required/consent_required/interaction_required
при отсутствии доказательств, не открывает UI. `prompt=consent` требует нового согласия.
Неподдерживаемые request/request_uri/claims/id_token_hint явно отклоняются без fetch.
`id_token_hint` не используется для входа или выбора subject и не игнорируется с
успешным продолжением: текущий профиль не реализует проверку hint по OIDC Core §3.1.2.2.
`acr_values` принимается как необязательное предпочтение; неподдерживаемые значения
игнорируются согласно минимальному требованию OIDC Core §15.1, без ошибки только
из-за наличия параметра и без выдачи неподтверждённых `acr`/`amr` или обещания MFA.
POST authorization обязателен по OIDC Core §3.1.2.1: ограниченный form-urlencoded
body с единственным значением каждого параметра, без смешивания с query.
Он проходит те же проверки и квоты, что GET, без расширения cookie-аутентификации;
переход после POST использует 303 и не пересылает тело на redirect URI.

Client types `confidential_web|public_native|public_spa`, immutable after creation;
workspace immutable. HTTPS exact registered redirects; no wildcards, fragments,
userinfo, prefix match. Для native loopback только 127.0.0.1 или [::1], переменный port
по RFC8252, фактическая полная строка привязана к code/token; private scheme reverse-domain
допускается административной регистрацией + PKCE, не как доказательство OS ownership.
SPA CORS только registered exact origins, no credentials/wildcard. Для публичных
discovery/JWKS допускается Origin действующего `public_spa` клиента этого workspace;
запрос без Origin остаётся публичным. Metadata явно содержит
`request_uri_parameter_supported=false` и
`authorization_response_iss_parameter_supported=true`.
Token/revoke endpoint
не принимает cookie; redirect/exchange не может изменить workspace/client/scopes.

Authorize сохраняет server request, browser-binding HttpOnly cookie и отправляет на
минимальный consent экран. Он получает Calaba bearer через существующий auth flow
(при необходимости SSO step-up), затем POST `/api/oauth/requests/{id}/bind` с bearer,
cookie, Origin/CSRF. Bind закрепляет session/user/authority и snapshot клиентской revision.
POST `/api/oauth/requests/{id}/decision` принимает allow/deny + одноразовый CSRF;
сервер берёт scopes/redirect/client из сохранённого snapshot. Request consumes атомарно.
Оба endpoint доступны scoped session только для своего workspace. Смена аккаунта
создаёт новый request; consent не переносится между людьми. iframe запрещён CSP.

Code bound к issuer/workspace/client/user/session/grant/redirect/S256/config versions,
хэш в БД, consume вместе с выдачей token family в одной транзакции. Access/refresh opaque
с разными type prefix, хэши в БД; token parser не имеет fallback на Calaba JWT.
Повтор уже использованного code от корректно аутентифицированного того же client
с совпадающими workspace, redirect и PKCE возвращает `invalid_grant` и отзывает
выданный по этому code grant/token family; отзыв коммитится до ответа с ошибкой.
Это выбранное для релиза выполнение SHOULD из RFC6749 §4.1.2. Неверные credentials,
client, workspace, redirect или verifier не могут отозвать чужой grant.
Refresh rotation атомарная: повтор использованного refresh от аутентифицированного
владельца client отзывает его family; неверный client/secret не может вызвать такой DoS.
Потеря ответа требует нового входа, replay grace в provider v1 нет. Scopes только сужаются.
Refresh выдаётся только при client.refresh_enabled и явном согласии на продление.

`sub` хранится как случайные 32 bytes base64url на `(workspace,user)`, стабилен при
переименовании/email/client recreation; не перераспределяется другому user.
ID token: iss,sub,aud=client_id,iat,exp,nonce,auth_time; никаких неподтверждённых acr/amr.
UserInfo: sub всегда; profile → display name; email → только локально независимо
подтверждённый адрес + email_verified=true, иначе claim отсутствует. Ни ролей, ни списка
workspace, ни account UUID, ни upstream raw claims. Удаление consent/клиента/member,
ban, session revoke, stale directory, plan expiry и policy version mismatch проверяются
на authorize/bind/decision/code exchange/refresh/UserInfo. Пользователь отзывает grant
без платного entitlement; это не гарантирует удаление session стороннего RP.

## 8. Management API и ключи

SSO/Directory/recovery — owner + recent **local** reauth, fresh SSO где требуется.
OAuth client CRUD — builtin owner/admin + recent local reauth + required assurance;
кастомного MANAGE_INTEGRATIONS недостаточно, новый permission bit в v1 не вводится.
Role resolution использует существующую модель прав, не claims токена.

`/api/workspaces/{id}/oauth/clients`: GET list, POST create `{name,type,redirect_uris,
allowed_origins[],scopes[],refresh_enabled}` → redacted client + secret_once только
для confidential. GET/PATCH/DELETE `/{client_id}` (PATCH revision обязателен), POST
`/{client_id}/rotate-secret`. Scopes subset v1, client_id случайный, не последовательный.
DELETE — soft disable, revision++, revoke all grants. Любой security config update
invalidates pending requests/codes/grants; name-only update не требует logout.
Secret rotation возвращает новый один раз, old secret живёт 10 минут (максимум два);
отдельный revoke-old boolean немедленно закрывает overlap. Revocation пользователя:
GET `/api/me/oauth-grants`, DELETE `/api/me/oauth-grants/{id}` в его authority scope.

Client secrets — random 32 bytes, SHA-256 hash с constant-time compare (высокоэнтропийные
секреты, не пароли); пароль пользователя остаётся под существующим password hasher.
Upstream/LDAP secrets и PKCE verifier — AES-256-GCM, отдельный env keyring
`IDENTITY_ENCRYPTION_KEYS` + `IDENTITY_ENCRYPTION_ACTIVE_KID`; envelope version/kid/nonce,
AAD = purpose/workspace/record/version. Нельзя использовать JWT_SECRET или ciphertext
другого workspace. Keyring отсутствует/невалиден → feature startup error, не plaintext.

RS256 signing — отдельные operator-provided private keys `OAUTH_SIGNING_KEYS`,
`OAUTH_SIGNING_ACTIVE_KID`, минимум RSA2048; publish next до активации, сохранить old
public до истечения всех ID tokens + 60s skew + 60s JWKS cache. Private никогда в JWKS.
Разные issuer могут использовать installation keyring, но validation обязана проверять
точный issuer/audience. Rotation и restore тестируются; secrets не входят в GET/audit/logs.
HTTP safe transport проверяет DNS и фактический dial на каждом запросе; private/loopback/
link-local/metadata/IPv4-mapped IPv6 запрещены, кроме точного operator allowlist для
on-prem/изолированных тестов. Redirects не следовать; proxy env не обходит policy.

Зафиксированный seam для Crypto: `identitynet.Config/Endpoint`, `NewTransport`,
`NewClient`; Endpoint — точный полный URL, включая query, и отдельный CIDR allowlist.
Connect timeout 3s, headers 5s, total 10s; request ≤64KiB, response default 256KiB,
hard ceiling 1MiB. Loopback exception только literal URL + /32 или /128 в тестовом
operator config. Resolver/dialer injectable только trusted Go dependencies, не REST.
Signing: `New(Config{Issuer,ActiveKID,Keys,Now,MaxLifetime,ClockSkew})`,
`Sign(Claims,expectedAudience)`, `Verify(token,expectedAudience)`, `PublicJWKS/JWKSJSON`.
Expected issuer/audience приходят из trusted config/client lookup, не из claims.
Один signer на workspace issuer, неизменяемый keyring snapshot; overlap проверяет
loader при построении snapshot, Sign не принимает произвольный issuer/alg/TTL.

## 9. DB/proto: один владелец и обязательные инварианты

Все UUID в таблицах workspace-owned объектов проверяются составными FK, а не только
handler. Таблицы минимального общего контракта (физические имена фиксирует Foundation
одним коммитом и публикует mapping, consumers не генерируют SQL самостоятельно):

| Сущность | Обязательные ключи / ограничения |
|---|---|
| policy / entitlements | workspace PK / (workspace,feature) PK; монотонная version |
| OIDC connections | workspace,id composite unique; не более одной active; immutable identity при смене issuer |
| external identities | unique(connection,issuer,sub); workspace-bound user; disable flag; no email key |
| sessions extension / assurance | authority CHECK; FK assurance → matching session/identity/workspace; absolute expiry |
| SSO transactions / tickets | hash unique, purpose/binding/version/expiry, atomic pending→consumed |
| directories / directory members | one directory/workspace; unique(directory,objectGUID), member bound to workspace; sync generation |
| OAuth clients / secrets | client workspace immutable; hash secrets with kid/expiry/revoked; revision |
| OAuth subjects | unique(workspace,user), unique(workspace,sub), immutable/no reassignment |
| consent / requests / codes | bound workspace/client/user/session, scope set, versions, TTL, atomic consume |
| grants / token family / tokens | explicit revoke state, access/refresh hash unique, parent rotation, absolute/idle deadlines |
| recovery / audit / invalidation outbox | recovery hashes/consumed_at, redacted audit, durable monotonic policy/member invalidation |

Mutation + relevant version bump + audit/outbox атомарны. Логи never raw code/state/nonce/
secret/token/email claims; reverse proxy callback query redacted. Background workers
идемпотентны, bounded batch, DB leases, no per-client polling in renderer. Полный export
proto DTO в `identity.proto`/`oauth_client.proto` и extensions existing messages делают
только Foundation; OAuth standard endpoints остаются обычным JSON/form. Generated Go/TS/
sqlc коммитятся с источниками; unknown enums fail closed. Migration rollback не допускает
запуска старого auth без authority gate поверх enforced данных.

## 10. UX и observable acceptance

Настройки workspace: «Корпоративный вход» owner-only (connection/test/mode/recovery,
directory status/last success/error); «OAuth-приложения» owner/admin (создать/URI/scopes/
секрет один раз/ротация/disable). Тарифный lock объясняет Business/Enterprise. На входе
workspace — «Войти через организацию». Заблокированный A показывает reauth/lock reason,
не разлогинивает B. Consent показывает приложение, workspace, имя аккаунта, перечисленные
поля и продление, «Разрешить/Отказать». В профиле — свои grants/отзыв. Старый клиент
получает понятный отказ/обновление, не bypass. i18n ru/en/es/zh-CN, дизайн docs/08,
ручные screenshots 960×600 и 390; visual suite не запускается.

| ID | Доказательство готовности, обязательны позитивный и негативный сценарии |
|---|---|
| T01 | Free/Team/custom/expired/error deny, Business/Enterprise only in entitled workspace |
| T02 | IdP A не даёт доступ к B/DM/notes/admin/global credentials; refresh не расширяет authority |
| T03 | wrong state/nonce/iss/aud/azp/tid/PKCE/signature/expired/replay fail без session/link |
| T04 | совпавший email не объединяет account/не даёт superadmin; linking требует обе стороны |
| T05 | desktop stolen ticket без initiating verifier fail; web login CSRF/account swap fail |
| T06 | enforced password/reset/invite/guest/old client/REST resource-id/search/files не обходит |
| T07 | READY/RESUME/user fanout/redacted events/RTC move/reconnect учитывают scope; lease expiry прекращает доставку/медиа даже при потере pubsub |
| T08 | Enforced config failure/downgrade не открывает пароль; recovery одноразовый и не читает чат/не выпускает OAuth |
| T09 | LDAP disabled/deleted/group loss/stale deny targeted member; partial scan не mass delete; reenable не оживляет grants |
| T10 | OAuth wrong client/redirect/issuer/PKCE/CSRF/scope/session substitution fail; 2 concurrent code exchange → 1 success |
| T11 | refresh race/reuse revoke правильную family, чужой client не отзывает её; absolute/idle/session/assurance bounds |
| T12 | Provider token не работает в Calaba REST/WS/RTC, Calaba/bot/ID token не работает в UserInfo |
| T13 | revoke/client disable/ban/expiry немедленно закрывают UserInfo/refresh; sub stable within workspace и distinct across workspace |
| T14 | DNS rebind/redirect/private IP/proxy/IPv6 bypass fail; AAD/key rotation/JWKS не раскрывают секрет |
| T15 | Старый local login/refresh/bots/guests при SSO off не регрессируют; SQL/proto migrations PG17, no generated drift |
| T16 | Независимый RP проходит discovery+authorize+token+userinfo; fake IdP и реальные Entra/AD FS/AD результаты отмечены раздельно |

QA route inventory обязан сопоставить каждый endpoint/WS/event/SFU путь конкретному
policy call и тесту, без неклассифицированных путей. Не реализованный/не проверенный Txx
не отмечается passed. Реальные Microsoft стенды без credentials — unverified, не passed.

## 11. Разделение задач и gate реализации

| Владелец | Единоличные пути / результат |
|---|---|
| Lead | ADR-0054 и этот контракт, решение конфликтов, интеграция после evidence |
| Foundation | proto/generated, migrations/queries/sqlc, identitypolicy/identitycrypto; frozen exported Go signatures + DB mapping + unit/race/migration evidence |
| Crypto/network | только identitynet и oauthprovider/signing; policy HTTP/AAD-independent signing tests, без SQL/proto/config wiring |
| QA environment | tools/identity-test-env.sh, infra/docker/identity-test.compose.yml, infra/identity-test, route inventory/validation docs |
| SSO | новый OIDC сервис по frozen interfaces; flow/callback/link/desktop backend; не existing auth wiring |
| Directory | новый directory service/job по frozen DB; LDAP fixtures/generation/stale/revoke |
| Provider | oauthprovider кроме signing; clients/consent/code/token/userinfo/revoke |
| Integration | существующие auth/app/perm/gateway/rtc/config/events и route gates; один владелец сквозных edits |
| Client | desktop main/preload/renderer/platform/i18n; generated DTO only, не server/proto |
| Reviews | два независимых Codex reviewer: security и protocol, точный final SHA, без авторства реализации |

Порядок: этот ADR → Foundation фиксирует signatures/schema и Lead сверяет → parallel
SSO/Directory/Provider → Integration/Client → T01–T16 + R1/R2. Crypto и QA могут готовить
независимые primitives/env заранее. Foundation не подменяет архитектуру новой ADR.
Любая несовместимость текущей незавершённой работы оформляется mapping/diff к этому
контракту до продолжения зависимых edits. Готовность Foundation не равна готовности SSO.

Проверки: make gen + drift, make lint из корня, target unit/integration/race, client
typecheck/lint/unit; полный integration один раз перед merge. На каждый Txx записать
command, SHA, result/count, env; не собирать пустые «зелёные» отчёты. R1 и R2 независимо
проверяют итоговый diff, blocker/major устранены до merge. Push/deploy/tag этим документом
не выполняются. Артефакт этой задачи — спецификация, а не релиз.

## 12. Проверенные первоисточники

URI metadata для path issuer сверены раздельно: [OIDC Discovery §4](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfig)
и [RFC 8414 §3](https://www.rfc-editor.org/rfc/rfc8414.html#section-3).
Native redirects и системный браузер — [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html).
Остальные источники — в ADR-0054. Таблицы сроков/ACL/entitlements — выбранный профиль Calaba.

## 13. Уточнения ведущего при интеграции (2026-10-01)

### Приостановленный workspace: сохранение прежнего чтения

Решение лида: общий запрет suspension уточняется по ADR-0056. Только живой
local_account в текущем off/optional workspace сохраняет чтение metadata/history/
members и passive gateway/READY/replay по прежним ACL. Это не ранний allow: membership/
ban, member suspension, directory status/freshness, policy/entitlement versions и все
существующие permission checks обязательны. Enforced/workspace_sso/recovery запрещены.
Приёмные gateway leases и READY resolver используют WorkspaceRead с прежним ≤30s
и final socket/replay check. SUBSCRIBE только меняет receive subscription; TYPING
отдельно требует свежего Realtime допуска вне locks. Запись, RTC, OAuth issuance/
UserInfo, identity management и realtime publication остаются закрыты при suspension.
HTTP exception применяется только к read classification (GET/HEAD), не к mutate.
Это восстановление preexisting read-only suspension semantics docs/04, не ослабление
identity/ACL или изменение утверждений legacy TestWorkspaceSuspension.

### Совместимость гостевого admission и локальных событий

Identity lookup родителя room/message не заменяет семантику архивирования ADR-0044:
он может находить durable parent архивированной комнаты, после чего текущая identity
policy и исходный handler проверяют доступ. История временной архивированной комнаты
остаётся читаемой разрешённым участником, запись/voice сохраняют `ROOM_ARCHIVED`.
Нахождение parent само по себе не даёт доступа и не открывает permanent archived rooms.

Внутренний лимит lease cache не является новым продуктовым лимитом memberships:
READY не должен молча исчезать или обрезать разрешённые пространства при числе
memberships больше 256. Память lease state ограничивается подтверждёнными durable
memberships/подписками с удалением устаревших записей, а pending work/очереди/число
workers остаются ограниченными. Произвольные IDs из события не создают положительные
lease без проверки. Отсутствующий/истёкший lease означает подготовку с ограниченным
бюджетом вне gateway locks либо явный resync при переполнении, а не доставку без
проверки и не молчаливую потерю разрешённых событий. Финальная проверка перед записью
в socket/replay и максимум 30 секунд сохраняются.

Проверка SSO у public invite preview не обходит прежний IP rate limiter: он учитывает
и несуществующие коды до раннего отказа identity wrapper, без двойного списания
для успешного preview. Ответ enforced по-прежнему не раскрывает metadata.

Пересланное вложение сохраняет ADR-0033: чтение разрешает любая живая копия с
`VIEW_ROOM` и текущим identity-доступом к её комнате, а не обязательно workspace,
в котором хранится исходный `files` row. `files.CanRead` проверяет каждое основание
отдельно: uploader/иконки — в исходном scope, avatar — в разрешённом global либо
явном scoped profile-image scope, вложение/стикер — по доступной живой ссылке.
Отсутствие доступа к одному основанию не закрывает другое разрешённое; ошибки БД
не превращаются в разрешение. Scoped A не читает копию в B/DM и не получает uploader
bypass, recovery не читает вложения. Удаление последней доступной копии отзывает
чтение. GET/HEAD file/thumbnail могут делегировать проверку этому typed handler с
установленным `WithPolicy`; это не освобождение от identity-проверок. Остальные
route guards и запись файлов сохраняются.

T15 сохраняет ADR-0040: собственный pending/declined receipt гостя при `off`/`optional`
доступен живой локальной сессии владельца receipt, в том числе после удаления guest
membership при отказе. Это только существующий `guestView` своей записи; он не даёт
workspace lease, доступ к комнате или списку чужих заявок. Перед включением receipt
проверяется текущая durable policy: `enforced`, неизвестный режим и ошибка БД закрывают
его. `workspace_sso`/recovery не получают этот локальный канал. Уведомления решающим
сохраняют прежние room permissions и identity gate; потеря событий не исправляется
выдачей положительного lease без проверки.

Публичная карточка бота `GET /api/bots/{ref}` остаётся чтением для обычной локальной
сессии, а не bot-only endpoint. Существующий запрет bot credentials не меняется;
scoped/recovery authority не приобретает глобальный доступ. Локальный DM/call должен
доставлять прежний сигнал выхода voice state с пустым room ID. Такой сигнал не создаёт
доступ к ресурсу; неизвестные события и scoped-сессии не получают общий global fallback.

Это принятые решения по обнаруженным пробелам контракта, а не отчёт о завершении
реализации или тестов. Они обязательны для серверного и клиентского consumers.

### Завершение входа и управление connection

`SSOCompleteResponse` из auth.proto содержит `tokens`, `assurance`, `tested`.
Web finish, native exchange и recovery возвращают этот общий generated ответ.
Test не выдаёт credentials/assurance; link и step-up возвращают assurance, сохраняя
независимую локальную сессию; standalone login выдаёт scoped tokens и assurance.
Web refresh secret остаётся в HttpOnly cookie и удаляется из JSON; native получает
его только в main token broker. AbortSignal/смена аккаунта или сервера запрещают
запоздалый auth commit даже после успешного HTTP-ответа.

Активация connection — отдельный POST из §5 с её явными id/version. Policy PUT
не выбирает последний draft автоматически. Отсутствующий secret сохраняет прежний
только при неизменных issuer/client_id; смена этой пары у существующего confidential
подключения требует нового явно переданного secret. Это не переход в public client.
Свежий public client может не иметь secret. Recovery kit возвращает `codes_once`
и `expires_at`; UI показывает оба один раз и не сохраняет plaintext-коды. Истёкший
kit не позволяет включить enforced/выполнить требующую kit ротацию или восстановиться.

### Приглашения в enforced workspace

Публичный preview приглашения возвращает `SSO_REQUIRED` без имени workspace,
email или данных участников. UI сохраняет opaque invite code и предлагает локальный
вход/регистрацию. POST `/api/invites/{code}/join` доступен независимому local human
(не guest/bot/recovery/workspace_sso), проверяет обычные условия приглашения,
подтверждённый email, лимит использований и bans. Он может подготовить membership,
но не выдаёт assurance или данные пространства: `JoinWorkspaceResponse.identity_access`
содержит только workspace_id, enforced и SSO_REQUIRED; workspace/member отсутствуют.
Далее нужны свежая local reauth и явный SSO link. Регистрация/email autojoin также
могут подготовить membership без подтверждения SSO. Open join и guest join закрыты.

### Браузерный consent и cookies

Consent UI расположен на `/oauth/consent?request=<opaque handle>`. Сервер создаёт
отдельную HttpOnly/Secure/Lax browser cookie для request, ответы имеют no-store,
no-referrer и CSP frame-ancestors none. Bind получает generated `BindOAuthRequest`
с csrf_token, равным исходному handle, first-party bearer, cookie и точный Origin.
Успешный atomic bind возвращает `OAuthConsentSnapshot` с новым одноразовым csrf_token;
на сервере хранится его hash. `DecideOAuthRequest` содержит allow, allow_refresh,
csrf_token; `OAuthDecisionResponse` — redirect_url. Client/scopes/redirect берутся
только из server snapshot. Смена аккаунта требует нового request.

Прежняя локальная refresh cookie с path `/api/auth` сохраняется. При включённой
identity-конфигурации дополнительная `__Host-calab-local-session` (Path=/,
Secure/HttpOnly/Lax) служит только read-only browser resolver на authorize.
Если в ней refresh secret, resolver сравнивает текущий hash constant-time и заново
проверяет session/user в БД; не ротирует refresh и не запускает reuse detection.
Scoped refresh cookie называется `__Secure-calab-workspace-refresh-{uuid}`, имеет
точный path `/api/auth/sso/workspaces/{uuid}`, Secure/HttpOnly/Lax и не имеет Domain.
Дополнительная `__Host-calab-workspace-session-{uuid}` с Path=/ допускается только
для prompt=none в соответствующем issuer. Login/refresh/logout/account switch
согласованно обновляют/удаляют обе соответствующие cookies; expiry ограничен session.
Management/consent/обычный API по-прежнему требуют bearer; cookies не подменяют его.

Electron main выставляет доверенный Origin сохранённого HTTPS server только для
известных first-party identity маршрутов (SSO, local reauth, identity management,
OAuth clients/consent/grants). Renderer не задаёт этот Origin. Остальные API-потоки
не получают глобальной переписи заголовка; native begin/exchange соблюдают то же правило.

### Часы и границы уже открытого приложения

После получения boundary locks policy использует более позднее из app clock и
`clock_timestamp()` БД. Внутренние сроки не продлеваются допустимым JWT skew.
Выдача ограничена меньшим из app+TTL, DB+TTL и сохранённых session/assurance/grant
deadlines; новая assurance не продлевает старую grant. Проверка после ожидавшей
блокировки обязательна и для одноразовых consumes/финальной публикации LDAP snapshot.

Для изменения данных workspace внешняя REST-проверка — предварительная. Окончательный
допуск проверяется внутри той же DB-транзакции, что и запись, после общих с отзывом
workspace/user/member/session locks. Отзыв, завершившийся первым, запрещает запись;
запись, получившая допуск и lock первой, завершается до отзыва. Проверка учитывает
истечение proof во время ожидания lock. Прямые одиночные SQL mutations не исключение:
они используют явную guarded transaction/query boundary. Typed context admission hook
в db допустим без зависимости db от auth и без анализа SQL-строк; transaction-bound
policy query не вызывает hook рекурсивно. Нельзя оборачивать целый HTTP response
в транзакцию или держать lock при чтении upload/сетевых вызовах blob/LiveKit/SMTP.
Внешняя подготовка выполняется до финального DB commit; события — после commit.
Cross-workspace операции используют согласованный порядок locks или отдельные units.
Обычные mutations используют совместимый shared admission lock, revokers — exclusive;
изменения самих boundary rows выбирают exclusive заранее, без небезопасного upgrade.
Совпадение lock protocol проверяется для всех policy/member/session/directory/grant/user
revokers. Guard включается явно для классифицированного запроса, не для migrations/
loaders/background jobs. Внешние эффекты, предоставляющие доступ, требуют durable
outbox и повторной проверки dispatcher; уже выполненный remote effect не считается
откатываемым вместе с DB. Barrier tests подтверждают оба порядка commit и независимый
прогресс другого workspace.

READY.identity_access содержит причины и версии закрытых пространств участника,
но не их защищённые snapshots. UI очищает их caches/subscriptions/media, сохраняя
независимо разрешённые пространства и личные данные local session. Scoped session
не показывает недоступные глобальные действия. GET/HEAD avatar для workspace_sso(A)
разрешён только после свежего WorkspaceRead(A), если exact file id является текущим
avatar текущего non-disabled участника A или текущей иконкой A. Это не общий доступ
к файлам пользователя: старый avatar, B-only member, DM или произвольный global file
не проходят. Recovery не получает этот доступ.

Существующий операторский SUPERADMIN_EMAILS остаётся совместимым только для
независимо локально подтверждённого nonbot/nonguest local account и свежей local proof.
Постоянный UUID grant остаётся отдельным основанием. Автоматического постоянного
backfill из email нет; изменение env/email отзывает legacy-основание. SSO/recovery
и claims IdP не дают product admin, в том числе в /me, gateway и permission resolution.

### Загрузка операторской конфигурации

Полностью отсутствующая identity-конфигурация сохраняет запуск старой инсталляции:
SSO/directory/provider маршруты зарегистрированы, но отказывают: first-party `/api/*` — 409
`CONFLICT` reason `IDENTITY_NOT_CONFIGURED` (обычное состояние установки, не сбой; уточнено в 2.0.1),
RFC-эндпоинты `/oidc/*` — 503 `server_error`. Локальный
`POST /api/auth/local/reauth` — first-party password proof и работает независимо
от этих keyrings: иначе legacy product admin теряет возможность обновить обязательный
пятиминутный proof. Он сохраняет local bearer/current password, запрет bot/scoped/recovery,
rate limit и точный непустой Origin из операторских `AllowedOrigins()` либо настроенного
identity origin; никакого вывода origin из Host, wildcard или клиентской OAuth-регистрации.
Частичная/невалидная конфигурация
origin/keyrings/network policy запрещает startup. Edition/feature grants сами по себе
не означают настроенный keyring. `IDENTITY_PUBLIC_ORIGIN` — exact HTTPS origin без
path/query/fragment. `IDENTITY_ENCRYPTION_KEYS` — JSON kid→base64 AES-256 key;
`OAUTH_SIGNING_KEYS` — JSON kid→PEM RSA; active kid задаётся отдельными env из §8.
Keyring snapshots immutable и не используют JWT_SECRET.

`IDENTITY_ENDPOINTS` задаёт точные URL/CIDR/CA исключения оператора; обычные публичные
HTTPS endpoints проходят общий защищённый identitynet transport без обязательного
предварительного каталога всех публичных IdP. `IDENTITY_DIRECTORY_HOSTS` задаёт
обязательный exact host/CIDR/CA allowlist для LDAPS. Test injection допускается только
через доверенные Go dependencies. После подключений пакетов лицензии регенерируются
для фактического server binary. Результаты TLS fixtures и реального Microsoft стенда
фиксируются отдельно; отсутствие последнего не превращается в passed.

### Продолжение consent после повторной аутентификации

Ошибка bind, требующая свежей local proof или workspace SSO, не является тупиком UI:
экран согласия предоставляет повторную аутентификацию и явный повтор bind. До успешного
bind клиент не показывает непроверенные consent metadata и не выводит authority из URL.
При web SSO navigation разрешён одноразовый return context в sessionStorage только для
exact same-origin `/oauth/consent?request=<validated opaque handle>`, связанный с исходным
session id, flow и deadline. Произвольный return URL запрещён. Успешный non-login step-up
в той же сессии возвращает этот относительный маршрут и повторяет bind с исходной
HttpOnly browser cookie; consent/issuance остаются серверными решениями. Cancel, failure,
смена account/server и истечение flow очищают context. Истёкший authorization request
требует нового запуска клиентом, а не автоматического создания grant. Проверяется
navigation round trip, смена account и отказ от произвольного return URL.

[ADR-0055](../adr/0055-scoped-session-reauthentication.md) разрешает `step_up`
также для живой `workspace_sso(A)`: только тот же workspace/connection/identity и
исходная session, без новых tokens, local proof или продления session deadline.
Scope/subject/версии и отзыв проверяются на begin/callback/finish/exchange; истёкшая
session требует нового login/request. Provider `auth_time` остаётся связан с authority:
local account требует local reauth для `prompt=login`/`max_age`, scoped session — SSO.
При необходимости локальный consent проходит обе проверки; SSO не обновляет local proof.

### Инцидент 2026-10-05: сбой зависимости — не отзыв
07:19, 08:19, 08:25 и 08:36 UTC: сервер сам отключил всех участников голосовых комнат (22–27 человек за секунды, в LiveKit — `SERVICE_REQUEST_REMOVE_PARTICIPANT`), в API в ту же секунду `load room for call update: timeout: context deadline exceeded`. Механизм: проверка `rtc.EnforceIdentity` (каждые 5 с, 64 параллельных проверки по 500 мс при пуле БД в 20 соединений) трактовала любую ошибку как запрет, и одного медленного ответа БД хватало на всех разом.
- **2.3.4 (PR #111):** в RTC-проверке таймаут и 5xx — «не решено»: участник остаётся, отключение только после 30 с непрерывных неудач по той же identity (на реплику); 4xx, `ErrSessionRevoked`, `ErrDenied`, отсутствующая строка — отказ, действует сразу.
- **Следом (шлюз):** `enforceIdentitySession` — ошибка чтения членства больше не убирает пространства; `refreshWorkspaceLease`/`refreshSessionLease` при сбое зависимости сохраняют действующую лизу до её истечения (`ReadLeaseTTL` 30 с) — граница fail-closed; отказ действует сразу. Классификация — `httpx.IsDenial` (401/403/404, 409 `PLAN_LIMIT`) + `ErrDenied`/`ErrSessionRevoked`/`db.IsNotFound`.
- Не выяснено: что замедлило управляемый PostgreSQL (метрики БД и логи API в кластере). Открыто (docs/12): нагрузка самой проверки на пул БД (64 параллельных запроса каждые 5 с) и остальные вызовы `checkIdentity` (resync, боты), где ошибка всё ещё означает отказ.
