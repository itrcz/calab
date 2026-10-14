---
title: UserInfo, refresh и revoke
description: Получить профиль по access token, продлить доступ refresh token и отозвать токен.
order: 5
---

Три эндпоинта, которые понадобятся после входа. Все они находятся под issuer пространства:

```text
https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa/{userinfo|token|revoke}
```

## UserInfo

`GET` или `POST` `/userinfo` с access token в заголовке `Authorization: Bearer`. Токен в query-строке или теле не принимается, query-строка вообще запрещена.

```sh tab="curl"
curl -s https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa/userinfo \
  -H 'Authorization: Bearer calab_oa_TvZdRRrAeU21FG2au71ffTJmnZjhaX536xpn9Kw1S9o'
```

```js tab="JavaScript"
const res = await fetch(`${issuer}/userinfo`, {
  headers: { Authorization: `Bearer ${tokens.access_token}` },
});
if (res.status === 401) {
  // токен истёк или доступ отозван — обновите токены или начните вход заново
}
const profile = await res.json();
```

```python tab="Python"
res = requests.get(f"{issuer}/userinfo",
                   headers={"Authorization": f"Bearer {tokens['access_token']}"}, timeout=10)
if res.status_code == 401:
    ...  # токен истёк или доступ отозван — обновите токены или начните вход заново
profile = res.json()
```

Ответ:

```json
{
  "sub": "7qCZMpOp2e-PYx7A9VRiAGUu8o-MF1kgOZG0umGs_HM",
  "name": "Анна Петрова",
  "email": "anna@example.com",
  "email_verified": true
}
```

| Claim | Когда есть |
|---|---|
| `sub` | Всегда; тот же, что в ID token |
| `name` | Scope `profile` |
| `email`, `email_verified` | Scope `email` и адрес подтверждён в Calab |

Ошибка — `401` с `{"error": "invalid_token"}` и заголовком `WWW-Authenticate: Bearer error="invalid_token"`: токен неверен, истёк или доступ отозван.

## Refresh

`POST /token` с `grant_type=refresh_token`. Аутентификация клиента — та же, что при обмене кода: `Authorization: Basic` для веб-приложения с сервером, `client_id` в теле для публичного клиента.

| Параметр | Значение |
|---|---|
| `grant_type` | `refresh_token` |
| `refresh_token` | Последний полученный refresh token |
| `scope` | Необязательно: подмножество текущих scopes, чтобы сузить доступ |
| `client_id` | Только публичные клиенты |

```sh tab="curl"
curl -s https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa/token \
  -u 'calab_client_e07JrYTVpGfRYJ0pQaF6yzkME6S9W856DgsKNWOKvgE:calab_os_VWMV4RGIRsisgKhdE7ohFW_QoAdNWS4n9GkM3Ty1kb4' \
  -d grant_type=refresh_token \
  -d refresh_token=calab_or_g7KMt03Mx5dxElMQi0aw3v-eG08Xrqf6Pv9QQNDSjZQ
```

```js tab="JavaScript"
const res = await fetch(`${issuer}/token`, {
  method: 'POST',
  headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: stored.refreshToken }),
});
if (res.status === 400 && (await res.clone().json()).error === 'invalid_grant') {
  // доступ закончился — отправьте пользователя на новый вход
}
const next = await res.json();
await saveTokens(next); // сохраните новый refresh_token сразу: прежний больше не действует
```

```python tab="Python"
res = requests.post(f"{issuer}/token",
                    auth=(os.environ["CALAB_CLIENT_ID"], os.environ["CALAB_CLIENT_SECRET"]),
                    data={"grant_type": "refresh_token", "refresh_token": stored["refresh_token"]},
                    timeout=10)
if res.status_code == 400 and res.json().get("error") == "invalid_grant":
    ...  # доступ закончился — отправьте пользователя на новый вход
next_tokens = res.json()
save_tokens(next_tokens)  # сохраните новый refresh_token сразу: прежний больше не действует
```

Ответ — такой же, как при обмене кода: новые `access_token`, `refresh_token` и `id_token` (без `nonce`). Правила ротации и почему повтор отзывает всю цепочку — в [Токены и сроки](./tokens#refresh-token-и-ротация).

## Revoke

`POST /revoke` (RFC 7009) — когда пользователь выходит из вашего приложения или отключает интеграцию. Тело — форма с параметром `token` (access или refresh token), аутентификация клиента — как на `/token`. `token_type_hint` не нужен: тип определяется по префиксу.

```sh tab="curl"
curl -s -o /dev/null -w '%{http_code}\n' \
  https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa/revoke \
  -u 'calab_client_e07JrYTVpGfRYJ0pQaF6yzkME6S9W856DgsKNWOKvgE:calab_os_VWMV4RGIRsisgKhdE7ohFW_QoAdNWS4n9GkM3Ty1kb4' \
  -d token=calab_or_g7KMt03Mx5dxElMQi0aw3v-eG08Xrqf6Pv9QQNDSjZQ
# 200
```

```js tab="JavaScript"
await fetch(`${issuer}/revoke`, {
  method: 'POST',
  headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token: stored.refreshToken }),
});
```

```python tab="Python"
requests.post(f"{issuer}/revoke",
              auth=(os.environ["CALAB_CLIENT_ID"], os.environ["CALAB_CLIENT_SECRET"]),
              data={"token": stored["refresh_token"]}, timeout=10)
```

- Отзыв **любого** токена цепочки (access или refresh) закрывает весь grant: и refresh, и все access token этой цепочки.
- Ответ — `200` с пустым телом, даже если токен неизвестен, уже отозван или принадлежит другому клиенту (так требует RFC 7009). Ошибку вы получите только при неверной аутентификации клиента (`401 invalid_client`) или пустом `token` (`400 invalid_request`).
- Revoke закрывает доступ вашего приложения, но не завершает сессию человека в самом Calab.

## Браузерные приложения (SPA) и CORS

`/token`, `/userinfo` и `/revoke` отвечают на CORS-запросы только с origins, зарегистрированных у SPA-клиента в «Разрешённые origins». Preflight (`OPTIONS`) разрешает методы `GET, POST` и заголовки `Authorization, Content-Type`; cookies не используются. Discovery и JWKS доступны без `Origin` всем, а с `Origin` — только origins действующих SPA-клиентов этого пространства.
