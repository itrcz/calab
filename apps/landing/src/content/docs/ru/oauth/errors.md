---
title: Ошибки
description: Коды ошибок OAuth-эндпоинтов и API управления клиентами — что означают и что делать.
order: 7
---

У провайдера два вида ошибок:

- **Протокольные** (`/authorize`, `/token`, `/userinfo`, `/revoke`, discovery, JWKS) — стандартный формат OAuth: JSON `{"error": "<code>"}` или параметр `error` в `redirect_uri`. Поля `error_description` нет — смотрите на код и HTTP-статус.
- **API приложения Calab** (`/api/workspaces/{workspace}/oauth/clients…`, `/api/me/oauth-grants…`, экран согласия) — обычный `ApiError` Calab: `{code, message, field?, reason?}`.

## Протокольные ошибки

| `error` | HTTP | Где | Что значит и что делать |
|---|---|---|---|
| `invalid_request` | 400 | все | Нет или повторяется параметр, неверный `client_id` / `redirect_uri`, нет `state` или `nonce`, неверный `code_challenge`, лишняя query-строка у `/token`, запрещённый параметр (`request`, `claims`, `id_token_hint`…). Исправьте запрос. Для неизвестного пространства в discovery/JWKS — `404`. |
| `unsupported_response_type` | 303 → redirect | `/authorize` | `response_type` не `code`. |
| `invalid_scope` | 303 → redirect / 400 | `/authorize`, `/token` | Scope вне `openid profile email`, без `openid`, шире разрешённого клиенту; на refresh — попытка расширить scopes. |
| `access_denied` | 303 → redirect | `/authorize` | Пользователь нажал «Отказать», либо у пространства нет тарифа Business / Enterprise, провайдер не включён или пространство приостановлено. |
| `login_required` | 303 → redirect | `/authorize` | При `prompt=none`: нет сессии Calab или вход слишком старый для `max_age`. Запустите обычный вход. |
| `consent_required` | 303 → redirect | `/authorize` | При `prompt=none`: согласия нет, оно покрывает меньше scopes, чем запрошено, или клиент переименован. Запустите вход без `prompt=none`. |
| `interaction_required` | 303 → redirect | `/authorize` | При `prompt=none`: нужен шаг с участием человека (например, корпоративный вход). Запустите обычный вход. |
| `temporarily_unavailable` | 429 / 303 → redirect | все | Сработал лимит запросов (см. `Retry-After`) или слишком много незавершённых входов с одного IP. Повторите позже. |
| `server_error` | 503 / 303 → redirect | все | Временный сбой или identity не настроена на этой установке. Повторите позже; если не проходит — к оператору. |
| `invalid_client` | 401 | `/token`, `/revoke` | Неверный или отключённый клиент, неверный секрет, секрет в теле вместо `Authorization: Basic`, Basic у публичного клиента. Ответ содержит `WWW-Authenticate: Basic realm="oauth"`. |
| `invalid_grant` | 400 | `/token` | Code истёк/использован/выдан другому клиенту, не совпали `redirect_uri` или `code_verifier`, refresh token недействителен, доступ отозван или права человека изменились. Начните вход заново. |
| `unsupported_grant_type` | 400 | `/token` | `grant_type` не `authorization_code` и не `refresh_token`. |
| `invalid_token` | 401 | `/userinfo` | Access token неверен, истёк или отозван. Ответ содержит `WWW-Authenticate: Bearer error="invalid_token"`. |

Ошибки `/authorize` приходят на ваш `redirect_uri` (с `state` и `iss`) только после того, как Calab проверил `client_id` и `redirect_uri`. Если проверка не прошла, ошибка `invalid_request` показывается прямо в браузере.

Токен бота в любом OAuth-эндпоинте получает `403 access_denied` (в `/userinfo` — `401 invalid_token`).

### Лимиты запросов

До аутентификации считаются запросы с IP; после проверки клиента и токена — на пару «клиент + пользователь».

| Эндпоинт | По IP | На клиента и пользователя |
|---|---|---|
| `/token` | 120/мин; публичный клиент — ещё 60/мин на `client_id` с IP | 30/мин |
| `/userinfo` | 600/мин | 60/мин |
| `/authorize` | 60/мин | — |
| `/revoke` | 120/мин | — |
| discovery, JWKS, preflight | 120/мин | — |

Превышение — `429 temporarily_unavailable` с заголовком `Retry-After` (секунды).

## Ошибки API управления и согласия

Тело — `ApiError` Calab в protojson:

```json
{
  "code": "ERROR_CODE_RECENT_AUTH_REQUIRED",
  "message": "identity access denied"
}
```

| HTTP | `code` / `reason` | Что значит |
|---|---|---|
| 401 | `ERROR_CODE_UNAUTHENTICATED` | Нет сессии или она недействительна. |
| 403 | `ERROR_CODE_RECENT_AUTH_REQUIRED` | Нужно «Подтвердить пароль» (не старше 5 минут) или войти свежим локальным входом. |
| 403 | `ERROR_CODE_SSO_REQUIRED` | Пространство требует свежий корпоративный вход — «Подтвердить корпоративный вход». |
| 403 | `ERROR_CODE_IDENTITY_SCOPE_DENIED` | Нет прав: не владелец/администратор, гость, бот или SSO-сессия другого пространства. |
| 403 | `ERROR_CODE_DIRECTORY_ACCESS_DENIED` | Каталог (AD) не допускает участника или давно не синхронизировался. |
| 403 | `ERROR_CODE_WORKSPACE_SUSPENDED` | Пространство приостановлено. |
| 403 | `ERROR_CODE_RECOVERY_ONLY` | Сессия восстановления: в ней можно только чинить политику SSO. |
| 404 | `ERROR_CODE_NOT_FOUND` | Клиент или доступ не найден. |
| 409 | `ERROR_CODE_CONFLICT`, `reason: "PLAN_LIMIT"` | Нет тарифа Business / Enterprise, 20 активных клиентов или уже два действующих секрета. |
| 409 | `ERROR_CODE_CONFLICT`, `reason: "IDENTITY_CONFIG_CHANGED"` | Клиент изменился с момента чтения (`version` устарела) или переименован во время согласия. Перечитайте и повторите. |
| 409 | `ERROR_CODE_CONFLICT`, `reason: "IDENTITY_NOT_CONFIGURED"` | На этой установке identity не настроена оператором. |
| 422 | `ERROR_CODE_VALIDATION` | Неверные поля клиента: имя, redirect URI, origins, scopes, тип. |
| 503 | `ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE` | Временно недоступна зависимость (база, каталог). Повторите позже. |

Общий справочник кодов Calab — в [Справочнике ошибок](../reference/errors).
