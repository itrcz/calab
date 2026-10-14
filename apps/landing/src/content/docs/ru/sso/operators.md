---
title: Для операторов
description: Переменные IDENTITY_* и OAUTH_* для собственной установки Calab — ключи, origin, сетевые разрешения и тарифы.
order: 9
---

Эта страница — для тех, кто разворачивает Calab на своих серверах. В облаке Calab всё уже настроено: владельцу пространства достаточно тарифа Business.

Корпоративный вход, каталог и [OAuth-провайдер](../oauth) включаются вместе набором переменных окружения. Полное руководство по развёртыванию (Docker Compose, Caddy, LiveKit, почта) — в операторской документации к установке; здесь — только то, что относится к идентификации.

## Включено или выключено

- **Ни одной переменной из списка ниже** — идентификация выключена. Сервер запускается, маршруты `/api/...` для SSO и OAuth отвечают `409 CONFLICT` с `reason: "IDENTITY_NOT_CONFIGURED"`, а `/oidc/...` — `503 server_error`. Приложение показывает «Корпоративный вход и OAuth не настроены на этом сервере».
- **Часть переменных или неверное значение** — сервер не запустится и назовёт переменную в ошибке. Частично включённой идентификации не бывает.
- `IDENTITY_PUBLIC_ORIGIN` и оба набора ключей с активными `kid` нужны всегда вместе; сетевые списки можно оставить пустыми.

## Переменные

| Переменная | Обязательна | Значение |
|---|---|---|
| `IDENTITY_PUBLIC_ORIGIN` | Да | Точный HTTPS origin без пути, query, фрагмента и завершающего `/`, например `https://id.example.com`. Из него строятся адрес возврата SSO и issuer OAuth |
| `IDENTITY_ENCRYPTION_KEYS` | Да | JSON-объект `kid → ключ`: стандартный base64 ровно 32 случайных байт (AES-256). Шифрует секреты IdP и пароль bind каталога. До 32 ключей; не может совпадать с `JWT_SECRET` |
| `IDENTITY_ENCRYPTION_ACTIVE_KID` | Да | `kid`, которым шифруются новые данные. Остальные ключи остаются для расшифровки |
| `OAUTH_SIGNING_KEYS` | Да | JSON-объект `kid → RSA private key PEM` (2048–8192 бит, переводы строк экранированы `\n`). Подписывают ID token OAuth-провайдера; в JWKS публикуются только открытые части |
| `OAUTH_SIGNING_ACTIVE_KID` | Да | `kid` ключа, которым подписываются новые токены |
| `IDENTITY_ENDPOINTS` | Нет | JSON-массив исключений для IdP во внутренней сети — см. ниже |
| `IDENTITY_DIRECTORY_HOSTS` | Для каталога | JSON-массив разрешённых контроллеров домена — см. ниже |
| `IDENTITY_EDITION` | Нет | `cloud` (по умолчанию) или `enterprise` для собственной установки с лицензией Enterprise |
| `IDENTITY_ENTERPRISE_WORKSPACE_IDS` | При `enterprise` | Через запятую — точные UUID пространств, которым доступны SSO, каталог и OAuth |

> [!DANGER]
> `IDENTITY_PUBLIC_ORIGIN` после включения **не меняется никогда**: он входит в issuer токенов и в адреса возврата, зарегистрированные у IdP и в OAuth-клиентах. Алиасы домена и заголовки `Host`/`X-Forwarded-*` issuer не меняют.

### Генерация ключей

```bash
# 32 случайных байта для IDENTITY_ENCRYPTION_KEYS
openssl rand -base64 32

# RSA-ключ для OAUTH_SIGNING_KEYS
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out oauth-signing.pem
```

```bash
IDENTITY_PUBLIC_ORIGIN=https://id.example.com
IDENTITY_ENCRYPTION_KEYS='{"enc-2026-10":"<base64 32 байт>"}'
IDENTITY_ENCRYPTION_ACTIVE_KID=enc-2026-10
OAUTH_SIGNING_KEYS='{"sig-2026-10":"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"}'
OAUTH_SIGNING_ACTIVE_KID=sig-2026-10
IDENTITY_EDITION=enterprise
IDENTITY_ENTERPRISE_WORKSPACE_IDS=0192a000-0000-7000-8000-0000000000aa
```

Ключи храните в менеджере секретов, отдельно от `JWT_SECRET`, и включайте в резервные копии вместе с базой: без ключа шифрования сохранённые секреты IdP и каталога не расшифровать.

### Ротация ключей

- **Шифрование:** добавьте новый `kid` в `IDENTITY_ENCRYPTION_KEYS`, переключите `IDENTITY_ENCRYPTION_ACTIVE_KID`. Старый ключ удаляйте, только когда данные, зашифрованные им, перезаписаны.
- **Подпись:** заранее добавьте новый ключ в `OAUTH_SIGNING_KEYS` — он появится в JWKS, и клиенты успеют его закешировать. Потом переключите `OAUTH_SIGNING_ACTIVE_KID`. Старый ключ держите, пока не истекут выданные им ID token (не больше 5 минут).

## Сеть

По умолчанию Calab ходит к IdP только по публичным HTTPS-адресам: таймаут 10 секунд, ответ до 1 МиБ, без редиректов и без прокси из окружения. Частные сети, loopback и адреса метаданных облака запрещены.

### IdP во внутренней сети — `IDENTITY_ENDPOINTS`

Исключение задаётся для **точного полного URL**. Для внутреннего IdP перечислите все его адреса из discovery: сам discovery, `authorization_endpoint`, `token_endpoint` и `jwks_uri`.

```json
[
  {
    "url": "https://adfs.example.com/adfs/.well-known/openid-configuration",
    "private_cidrs": ["10.20.0.0/16"],
    "ca_pem": "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----\n",
    "workspace_ids": ["0192a000-0000-7000-8000-0000000000aa"]
  }
]
```

| Поле | Значение |
|---|---|
| `url` | Точный HTTPS URL |
| `approved_cidrs` | Если задан, адрес, в который разрешается имя хоста, обязан попадать в эти сети — и для публичных, и для частных адресов |
| `private_cidrs` | Частные сети, в которые разрешено ходить по этому URL |
| `ca_pem` | Свой корневой сертификат, если IdP подписан внутренним CA |
| `workspace_ids` | UUID пространств, для которых действует исключение |

Запись с `private_cidrs` без `workspace_ids` допустима только при `IDENTITY_EDITION=enterprise`; в облачной редакции сервер не запустится.

### Контроллеры домена — `IDENTITY_DIRECTORY_HOSTS`

Без записи для хоста [каталог](./directory) не настроить — даже для публичного адреса.

```json
[
  {
    "host": "dc1.corp.example.com",
    "networks": ["10.20.0.0/16"],
    "ca_pem": "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----\n",
    "workspace_ids": ["0192a000-0000-7000-8000-0000000000aa"]
  }
]
```

- `host` — имя хоста строчными буквами, без порта и точки в конце; должно совпадать с хостом в «LDAPS URL».
- `networks` — непустой список сетей, где может находиться этот хост.
- `ca_pem` — если задан, доверяется **только** этому CA; системные корни не используются.
- `workspace_ids` — пространства, которым разрешён хост. Без него хост доступен всем пространствам установки — только при `IDENTITY_EDITION=enterprise`.

## Доступ по тарифам

Функции SSO, каталога и OAuth-провайдера включаются для конкретного пространства:

- **облако** (`IDENTITY_EDITION=cloud`) — пространству нужен действующий тариф Business;
- **собственная установка** (`IDENTITY_EDITION=enterprise`) — UUID пространства в `IDENTITY_ENTERPRISE_WORKSPACE_IDS`.

Free, Team, истёкший тариф или пространство вне списка доступа не получают. Понижение тарифа не снимает обязательный SSO — см. [режимы](./modes#выключение-и-понижение).

## Прокси и логи

- Маршруты `/oidc/workspaces/...` и `/.well-known/oauth-authorization-server/oidc/workspaces/...` должны идти на API **до** fallback статики веб-клиента.
- Адреса возврата содержат одноразовые `code` и `state`. Исключите query-строку из журналов доступа обратного прокси и балансировщика для `/api/auth/sso/...`, `/oidc/...` и `/oauth/consent`.

## Проверка после включения

1. `GET https://id.example.com/oidc/workspaces/<workspace-id>/.well-known/openid-configuration` отвечает JSON с `issuer`, равным `https://id.example.com/oidc/workspaces/<workspace-id>` (для пространства с тарифом).
2. В настройках пространства вкладка «Настройка SSO» больше не показывает «не настроено на сервере».
3. Пилот: режим «По выбору», вход через SSO в вебе и десктопе, подтверждение корпоративного входа, recovery kit. «Обязательный SSO» — только после проверки восстановления.
