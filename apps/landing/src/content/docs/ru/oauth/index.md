---
title: OAuth 2 и OpenID Connect
description: Вход «через Calab» в ваши сервисы — провайдер OpenID Connect с issuer на каждое пространство.
order: 1
---

Calab умеет быть **провайдером OpenID Connect**. Ваше приложение — CRM, портал, внутренний сервис — показывает кнопку «Войти через Calab», участник подтверждает вход, а приложение получает проверенную подпись того, кто он такой в конкретном пространстве: постоянный идентификатор, имя и (если разрешено) подтверждённый email.

Это стандартный поток **Authorization Code + PKCE (S256)**, поэтому подойдёт любая сертифицированная OIDC-библиотека: `openid-client` для Node.js, `Authlib` для Python, Spring Security, ASP.NET и т. д.

## Что получает приложение

| Scope | Что даёт |
|---|---|
| `openid` | Обязателен. Постоянный `sub` участника в этом пространстве и ID token. |
| `profile` | `name` — отображаемое имя участника. |
| `email` | `email` и `email_verified: true` — только если адрес подтверждён в Calab. Неподтверждённый адрес не передаётся вовсе. |

И всё. Провайдер **не даёт доступа к API Calab**: access token из OAuth не принимается ни REST API, ни gateway, ни голосом. Роли, список пространств, внутренний UUID аккаунта и данные из корпоративного IdP приложение тоже не получает.

> [!NOTE]
> Нужен доступ к сообщениям, задачам или комнатам от имени сервиса? Это задача для [бота](../bots), а не для OAuth. OAuth — только вход и минимальный профиль.

## Issuer — у каждого пространства свой

Клиент OAuth принадлежит ровно одному пространству, и у каждого пространства свой issuer:

```text
https://id.example.com/oidc/workspaces/{workspace_id}
```

`https://id.example.com` — адрес identity вашей установки Calab (переменная оператора `IDENTITY_PUBLIC_ORIGIN`, в большинстве установок совпадает с адресом приложения). `{workspace_id}` — UUID пространства в нижнем регистре. Issuer не зависит от заголовков `Host` и не меняется после включения identity.

Метаданные публикуются по двум адресам — для OIDC Discovery и для RFC 8414:

```sh
curl -s https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa/.well-known/openid-configuration
curl -s https://id.example.com/.well-known/oauth-authorization-server/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa
```

```json
{
  "issuer": "https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa",
  "authorization_endpoint": "https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa/authorize",
  "token_endpoint": "https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa/token",
  "userinfo_endpoint": "https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa/userinfo",
  "revocation_endpoint": "https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa/revoke",
  "jwks_uri": "https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa/jwks",
  "scopes_supported": ["openid", "profile", "email"],
  "response_types_supported": ["code"],
  "response_modes_supported": ["query"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "none"],
  "revocation_endpoint_auth_methods_supported": ["client_secret_basic", "none"],
  "code_challenge_methods_supported": ["S256"],
  "claims_supported": ["iss", "sub", "aud", "iat", "exp", "nonce", "auth_time", "name", "email", "email_verified"],
  "request_uri_parameter_supported": false,
  "authorization_response_iss_parameter_supported": true
}
```

## Эндпоинты

| Метод | Путь (от issuer) | Назначение |
|---|---|---|
| `GET` | `/.well-known/openid-configuration` | Метаданные провайдера |
| `GET` | `/jwks` | Публичные ключи RS256 для проверки ID token (кэш 60 с) |
| `GET`, `POST` | `/authorize` | Начало входа: браузер пользователя |
| `POST` | `/token` | Обмен code и refresh token на токены |
| `GET`, `POST` | `/userinfo` | Профиль по access token |
| `POST` | `/revoke` | Отзыв токена (RFC 7009) |

## Кто может пользоваться

- **Тариф.** Провайдер доступен пространствам на тарифе **Business** (в облаке) и в установках **Enterprise** (on-prem), где оператор включил его для пространства. На Free и Team, а также после окончания тарифа новые входы не выдаются: `/authorize` возвращает `access_denied`.
- **Кто создаёт клиентов.** Владелец или администратор пространства — в «Настройки пространства → OAuth-клиенты». Подробно — [Регистрация клиента](./register-client).
- **Кто может войти.** Участники пространства. Гости и боты не проходят OAuth-вход: у ботов своя модель доступа, см. [аутентификацию ботов](../bots/auth).
- **Обязательный SSO.** Если в пространстве включён режим «Обязательный SSO», участник перед согласием подтверждает вход через корпоративный IdP — см. [режимы SSO](../sso/modes).

## Типы клиентов

| Тип (в API) | В интерфейсе | Аутентификация на `/token` | Redirect URI |
|---|---|---|---|
| `OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB` | «Веб-приложение с сервером» | `client_secret_basic` (секрет в заголовке `Authorization: Basic`) | только `https://` |
| `OAUTH_CLIENT_TYPE_PUBLIC_SPA` | «Браузерное приложение (SPA)» | `none` (только PKCE) | только `https://`; запросы из браузера — с разрешённых origins |
| `OAUTH_CLIENT_TYPE_PUBLIC_NATIVE` | «Нативное приложение» | `none` (только PKCE) | `https://`, loopback `http://127.0.0.1` / `http://[::1]` с любым портом, собственная схема вида `com.example.app:/callback` |

PKCE S256 обязателен для **всех** типов, включая конфиденциальные.

## Чего нет

- `client_credentials`, password grant, implicit и hybrid flow — только Authorization Code.
- Динамическая регистрация клиентов — клиенты создаются вручную в настройках пространства.
- Introspection — access token непрозрачен; проверяйте его вызовом [`/userinfo`](./userinfo-refresh-revoke).
- `offline_access`, API-scopes, pairwise subject, единый выход (single logout), `request` / `request_uri` / `claims`.
- SAML и SCIM.

## Дальше

1. [Регистрация клиента](./register-client) — создать клиент и получить `client_id`.
2. [Поток входа](./flow) — пошагово, с диаграммой и примерами кода.
3. [Токены и сроки](./tokens) — что живёт сколько и почему токен может перестать работать.
4. [Чек-лист безопасности](./security) — перед запуском в продакшен.
