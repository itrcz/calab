---
title: Поток входа (Authorization Code + PKCE)
description: Пошаговый вход «через Calab» — от кнопки в вашем приложении до проверенного ID token и профиля.
order: 3
---

Calab поддерживает один поток — **Authorization Code с PKCE S256**. Он одинаков для всех типов клиентов; разница только в том, как клиент аутентифицируется на `/token`.

В примерах:

| Значение | Пример |
|---|---|
| Issuer пространства | `https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa` |
| `client_id` | `calab_client_e07JrYTVpGfRYJ0pQaF6yzkME6S9W856DgsKNWOKvgE` |
| Секрет (только веб с сервером) | `calab_os_VWMV4RGIRsisgKhdE7ohFW_QoAdNWS4n9GkM3Ty1kb4` |
| `redirect_uri` | `https://crm.example.com/auth/calab/callback` |

## Схема

<svg role="img" aria-labelledby="oauth-flow-title-ru" viewBox="0 0 780 510" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="inherit" font-size="12" fill="currentColor">
  <title id="oauth-flow-title-ru">Последовательность входа через Calab: браузер, приложение, /authorize, экран согласия, /token, /userinfo</title>
  <defs>
    <marker id="oauth-flow-arrow-ru" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="none" stroke="currentColor" stroke-width="1.2">
    <rect x="5" y="14" width="110" height="36" rx="6"/>
    <rect x="135" y="14" width="110" height="36" rx="6"/>
    <rect x="265" y="14" width="110" height="36" rx="6"/>
    <rect x="395" y="14" width="110" height="36" rx="6"/>
    <rect x="525" y="14" width="110" height="36" rx="6"/>
    <rect x="655" y="14" width="110" height="36" rx="6"/>
  </g>
  <g text-anchor="middle" font-weight="600">
    <text x="60" y="37">Браузер</text>
    <text x="190" y="37">Приложение</text>
    <text x="320" y="37">/authorize</text>
    <text x="450" y="37">Согласие</text>
    <text x="580" y="37">/token</text>
    <text x="710" y="37">/userinfo</text>
  </g>
  <g stroke="currentColor" stroke-width="1" stroke-dasharray="3 5" opacity="0.45">
    <line x1="60" y1="50" x2="60" y2="500"/>
    <line x1="190" y1="50" x2="190" y2="500"/>
    <line x1="320" y1="50" x2="320" y2="500"/>
    <line x1="450" y1="50" x2="450" y2="500"/>
    <line x1="580" y1="50" x2="580" y2="500"/>
    <line x1="710" y1="50" x2="710" y2="500"/>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="1.4" marker-end="url(#oauth-flow-arrow-ru)">
    <line x1="60" y1="85" x2="186" y2="85"/>
    <line x1="190" y1="122" x2="64" y2="122" stroke-dasharray="6 4"/>
    <line x1="60" y1="159" x2="316" y2="159"/>
    <line x1="320" y1="196" x2="446" y2="196" stroke-dasharray="6 4"/>
    <line x1="60" y1="233" x2="446" y2="233"/>
    <line x1="450" y1="270" x2="64" y2="270" stroke-dasharray="6 4"/>
    <line x1="60" y1="307" x2="186" y2="307"/>
    <line x1="190" y1="344" x2="576" y2="344"/>
    <line x1="580" y1="381" x2="194" y2="381" stroke-dasharray="6 4"/>
    <line x1="190" y1="438" x2="706" y2="438"/>
    <line x1="710" y1="475" x2="194" y2="475" stroke-dasharray="6 4"/>
  </g>
  <g>
    <text x="68" y="79">1. «Войти через Calab»</text>
    <text x="68" y="116">2. 302 → /authorize</text>
    <text x="68" y="153">3. GET /authorize (PKCE, state, nonce)</text>
    <text x="328" y="190">4. 303 → согласие</text>
    <text x="68" y="227">5. вход в Calab и «Разрешить»</text>
    <text x="68" y="264">6. 303 → redirect_uri?code&amp;state&amp;iss</text>
    <text x="68" y="301">7. code, state, iss</text>
    <text x="198" y="338">8. POST /token: code + code_verifier</text>
    <text x="198" y="375">9. access_token, id_token, refresh_token</text>
    <text x="198" y="404" opacity="0.75">проверить state, iss, подпись и nonce в id_token</text>
    <text x="198" y="432">10. GET /userinfo, Authorization: Bearer access_token</text>
    <text x="198" y="469">11. sub, name, email</text>
  </g>
</svg>

Сплошные стрелки — запросы, пунктир — ответы и перенаправления. Шаги 3–6 проходят в браузере пользователя; шаги 8–11 — сервер-сервер (для SPA и нативных приложений — прямо из клиента).

## Шаг 1. Подготовьте PKCE, state и nonce

Для каждой попытки входа сгенерируйте и сохраните в сессии вашего приложения:

- `code_verifier` — 43–128 символов из `A–Z a–z 0–9 - . _ ~` (обычно 32 случайных байта в base64url);
- `code_challenge` = `BASE64URL(SHA-256(code_verifier))` без `=` — ровно 43 символа;
- `state` — случайная строка 1–512 байт, защита от CSRF;
- `nonce` — случайная строка 1–512 байт, привязывает ID token к этой попытке.

> [!NOTE]
> В профиле Calab `state` и `nonce` **обязательны** в каждом запросе (в OIDC Core `nonce` для code flow необязателен). Без них — `invalid_request`.

```sh tab="curl"
# Пример генерации в shell (openssl ≥ 1.1)
CODE_VERIFIER=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=')
STATE=$(openssl rand -hex 16)
NONCE=$(openssl rand -hex 16)
```

```js tab="JavaScript"
import { createHash, randomBytes } from 'node:crypto';

const codeVerifier = randomBytes(32).toString('base64url');
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
const state = randomBytes(16).toString('hex');
const nonce = randomBytes(16).toString('hex');
// сохраните codeVerifier, state и nonce в серверной сессии пользователя
```

```python tab="Python"
import base64, hashlib, secrets

code_verifier = secrets.token_urlsafe(32)
code_challenge = base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode()).digest()).rstrip(b"=").decode()
state = secrets.token_hex(16)
nonce = secrets.token_hex(16)
# сохраните code_verifier, state и nonce в серверной сессии пользователя
```

## Шаг 2. Отправьте пользователя на `/authorize`

Перенаправьте браузер на `authorization_endpoint`:

```text
https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa/authorize
  ?response_type=code
  &client_id=calab_client_e07JrYTVpGfRYJ0pQaF6yzkME6S9W856DgsKNWOKvgE
  &redirect_uri=https%3A%2F%2Fcrm.example.com%2Fauth%2Fcalab%2Fcallback
  &scope=openid%20profile%20email
  &state=4f1c2a…
  &nonce=9b7e30…
  &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
  &code_challenge_method=S256
```

| Параметр | Обязателен | Значение |
|---|---|---|
| `response_type` | да | `code` |
| `client_id` | да | Из настроек клиента |
| `redirect_uri` | да | Точно один из зарегистрированных |
| `scope` | да | `openid` и по желанию `profile`, `email` — не шире, чем разрешено клиенту |
| `state`, `nonce` | да | 1–512 байт |
| `code_challenge` | да | 43 символа base64url |
| `code_challenge_method` | да | `S256` (`plain` не поддерживается) |
| `response_mode` | нет | Только `query` |
| `prompt` | нет | `login`, `consent`, их сочетание или `none` (только отдельно) |
| `max_age` | нет | Секунды; требует, чтобы вход в Calab был не старше |

Каждый параметр — ровно один раз. `request`, `request_uri`, `claims`, `id_token_hint`, `resource` и `audience` отклоняются с `invalid_request`; `acr_values` принимается, но игнорируется. Можно отправить те же параметры формой `POST` (`application/x-www-form-urlencoded`, без query-строки).

## Шаг 3. Пользователь входит и соглашается

Calab перенаправляет браузер на экран согласия по адресу identity (`https://id.example.com/oauth/consent?request=…`). Если человек не вошёл в Calab — сначала обычный вход; если пространство требует SSO — подтверждение через корпоративный IdP. Затем экран «Разрешить вход в приложение?» с названием приложения, пространством, именем аккаунта и запрошенными данными. Подробности — [Экран согласия](./consent).

Запрос на вход живёт **10 минут**.

## Шаг 4. Примите ответ на `redirect_uri`

Успех:

```text
https://crm.example.com/auth/calab/callback
  ?code=calab_oc_Laufm1V1F0gnbG0nHG4NcwvsM6wHkhQOmk4AH8CzCSw
  &state=4f1c2a…
  &iss=https%3A%2F%2Fid.example.com%2Foidc%2Fworkspaces%2F0192a000-0000-7000-8000-0000000000aa
```

Отказ или ошибка — тот же адрес с `error` вместо `code` (например, `error=access_denied`), тоже со `state` и `iss`.

Обязательно проверьте:

1. `state` совпадает с сохранённым в сессии;
2. `iss` равен issuer этого пространства (защита от подмены провайдера, RFC 9207).

> [!WARNING]
> Если `client_id` или `redirect_uri` неверны, Calab **не** перенаправляет никуда, а показывает ошибку `invalid_request` прямо в браузере — чтобы не отправить код на чужой адрес.

## Шаг 5. Обменяйте code на токены

`POST` на `token_endpoint`, тело — `application/x-www-form-urlencoded`, без query-строки:

| Параметр | Значение |
|---|---|
| `grant_type` | `authorization_code` |
| `code` | Из шага 4 |
| `redirect_uri` | Тот же, что в шаге 2, байт в байт |
| `code_verifier` | Из шага 1 |
| `client_id` | Только для публичных клиентов (SPA, нативные) |

Конфиденциальный клиент аутентифицируется **только** заголовком `Authorization: Basic base64(client_id:secret)` (обе части предварительно URL-кодируются по RFC 6749). `client_secret` в теле и `client_assertion` не принимаются (`invalid_client`). Параметр `scope` в обмене кода запрещён.

```sh tab="curl"
curl -s https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa/token \
  -u 'calab_client_e07JrYTVpGfRYJ0pQaF6yzkME6S9W856DgsKNWOKvgE:calab_os_VWMV4RGIRsisgKhdE7ohFW_QoAdNWS4n9GkM3Ty1kb4' \
  -d grant_type=authorization_code \
  -d code=calab_oc_Laufm1V1F0gnbG0nHG4NcwvsM6wHkhQOmk4AH8CzCSw \
  --data-urlencode redirect_uri=https://crm.example.com/auth/calab/callback \
  -d code_verifier="$CODE_VERIFIER"
```

```js tab="JavaScript"
const issuer = 'https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa';
const basic = Buffer.from(
  `${encodeURIComponent(process.env.CALAB_CLIENT_ID)}:${encodeURIComponent(process.env.CALAB_CLIENT_SECRET)}`,
).toString('base64');

const res = await fetch(`${issuer}/token`, {
  method: 'POST',
  headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: req.query.code,
    redirect_uri: 'https://crm.example.com/auth/calab/callback',
    code_verifier: session.codeVerifier,
  }),
});
if (!res.ok) throw new Error(`token: ${res.status} ${(await res.json()).error}`);
const tokens = await res.json();
```

```python tab="Python"
import os, requests

issuer = "https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa"
res = requests.post(
    f"{issuer}/token",
    auth=(os.environ["CALAB_CLIENT_ID"], os.environ["CALAB_CLIENT_SECRET"]),
    data={
        "grant_type": "authorization_code",
        "code": request.args["code"],
        "redirect_uri": "https://crm.example.com/auth/calab/callback",
        "code_verifier": session["code_verifier"],
    },
    timeout=10,
)
res.raise_for_status()
tokens = res.json()
```

Для публичного клиента уберите заголовок `Authorization` и добавьте `client_id` в тело.

Ответ:

```json
{
  "access_token": "calab_oa_TvZdRRrAeU21FG2au71ffTJmnZjhaX536xpn9Kw1S9o",
  "token_type": "Bearer",
  "expires_in": 300,
  "scope": "email openid profile",
  "refresh_token": "calab_or_g7KMt03Mx5dxElMQi0aw3v-eG08Xrqf6Pv9QQNDSjZQ",
  "id_token": "eyJhbGciOiJSUzI1NiIsImtpZCI6Ik…"
}
```

`refresh_token` есть только если у клиента включено «Разрешить продолжение доступа» **и** пользователь согласился на это. Код одноразовый и живёт **60 секунд**; повторное предъявление уже использованного кода тем же клиентом отзывает всё, что было по нему выдано.

## Шаг 6. Проверьте ID token

ID token — JWT, подписанный RS256. Возьмите ключ по `kid` из `jwks_uri` и проверьте:

| Claim | Проверка |
|---|---|
| `iss` | Равен issuer пространства |
| `aud` | Равен вашему `client_id` |
| `exp`, `iat` | Токен не истёк (живёт столько же, сколько access token — до 5 минут) |
| `nonce` | Равен сохранённому в шаге 1 |
| `auth_time` | Когда человек на самом деле входил — используйте с `max_age` |

Пример полезной нагрузки:

```json
{
  "iss": "https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa",
  "sub": "7qCZMpOp2e-PYx7A9VRiAGUu8o-MF1kgOZG0umGs_HM",
  "aud": "calab_client_e07JrYTVpGfRYJ0pQaF6yzkME6S9W856DgsKNWOKvgE",
  "iat": 1792141200,
  "exp": 1792141500,
  "auth_time": 1792140900,
  "nonce": "9b7e30…",
  "name": "Анна Петрова",
  "email": "anna@example.com",
  "email_verified": true
}
```

Идентифицируйте человека по паре **(`iss`, `sub`)**, а не по email: `sub` постоянен для участника в этом пространстве, email может поменяться или отсутствовать. `acr` и `amr` Calab не выдаёт.

```js tab="JavaScript"
import { createRemoteJWKSet, jwtVerify } from 'jose';

const jwks = createRemoteJWKSet(new URL(`${issuer}/jwks`));
const { payload } = await jwtVerify(tokens.id_token, jwks, {
  issuer,
  audience: process.env.CALAB_CLIENT_ID,
  algorithms: ['RS256'],
});
if (payload.nonce !== session.nonce) throw new Error('nonce mismatch');
const accountKey = `${payload.iss}|${payload.sub}`;
```

```python tab="Python"
import jwt  # PyJWT ≥ 2.4

jwks = jwt.PyJWKClient(f"{issuer}/jwks")
key = jwks.get_signing_key_from_jwt(tokens["id_token"])
claims = jwt.decode(tokens["id_token"], key.key, algorithms=["RS256"],
                    audience=os.environ["CALAB_CLIENT_ID"], issuer=issuer)
if claims["nonce"] != session["nonce"]:
    raise ValueError("nonce mismatch")
account_key = f'{claims["iss"]}|{claims["sub"]}'
```

## Шаг 7 (необязательно). Запросите профиль

Если нужны свежие данные — `GET /userinfo` с access token. Подробно и про продление доступа — [UserInfo, refresh и revoke](./userinfo-refresh-revoke).

## Тихий повторный вход

`prompt=none` выдаёт код без интерфейса, если у человека есть живая сессия Calab в этом браузере и он уже давал согласие этому клиенту на те же scopes. Иначе Calab сразу вернётся на `redirect_uri` с одной из ошибок: `login_required`, `consent_required` или `interaction_required` — и тогда запустите обычный вход.

## Готовые библиотеки

Calab следует OIDC Discovery, поэтому обычно достаточно указать issuer пространства, `client_id`, секрет и redirect URI. Убедитесь, что библиотека: включает PKCE S256, отправляет `nonce`, для веб-клиента использует `client_secret_basic` и проверяет параметр `iss` в ответе авторизации.
