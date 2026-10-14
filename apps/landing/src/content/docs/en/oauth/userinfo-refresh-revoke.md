---
title: UserInfo, refresh and revoke
description: Fetch the profile with an access token, keep access going with a refresh token and revoke tokens.
order: 5
---

Three endpoints you need after sign-in. All of them live under the workspace issuer:

```text
https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa/{userinfo|token|revoke}
```

## UserInfo

`GET` or `POST` `/userinfo` with the access token in an `Authorization: Bearer` header. A token in the query string or the body is not accepted, and any query string is refused.

```sh tab="curl"
curl -s https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa/userinfo \
  -H 'Authorization: Bearer calab_oa_TvZdRRrAeU21FG2au71ffTJmnZjhaX536xpn9Kw1S9o'
```

```js tab="JavaScript"
const res = await fetch(`${issuer}/userinfo`, {
  headers: { Authorization: `Bearer ${tokens.access_token}` },
});
if (res.status === 401) {
  // the token expired or access was revoked — refresh, or start a new sign-in
}
const profile = await res.json();
```

```python tab="Python"
res = requests.get(f"{issuer}/userinfo",
                   headers={"Authorization": f"Bearer {tokens['access_token']}"}, timeout=10)
if res.status_code == 401:
    ...  # the token expired or access was revoked — refresh, or start a new sign-in
profile = res.json()
```

Response:

```json
{
  "sub": "7qCZMpOp2e-PYx7A9VRiAGUu8o-MF1kgOZG0umGs_HM",
  "name": "Anna Peters",
  "email": "anna@example.com",
  "email_verified": true
}
```

| Claim | Present when |
|---|---|
| `sub` | Always; the same as in the ID token |
| `name` | The `profile` scope |
| `email`, `email_verified` | The `email` scope and the address is verified in Calab |

An error is `401` with `{"error": "invalid_token"}` and a `WWW-Authenticate: Bearer error="invalid_token"` header: the token is wrong, expired or its access was revoked.

## Refresh

`POST /token` with `grant_type=refresh_token`. Client authentication is the same as for the code exchange: `Authorization: Basic` for a web app with a server, `client_id` in the body for a public client.

| Parameter | Value |
|---|---|
| `grant_type` | `refresh_token` |
| `refresh_token` | The latest refresh token you received |
| `scope` | Optional: a subset of the current scopes, to narrow access |
| `client_id` | Public clients only |

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
  // access has ended — send the user to a new sign-in
}
const next = await res.json();
await saveTokens(next); // persist the new refresh_token right away: the old one is dead
```

```python tab="Python"
res = requests.post(f"{issuer}/token",
                    auth=(os.environ["CALAB_CLIENT_ID"], os.environ["CALAB_CLIENT_SECRET"]),
                    data={"grant_type": "refresh_token", "refresh_token": stored["refresh_token"]},
                    timeout=10)
if res.status_code == 400 and res.json().get("error") == "invalid_grant":
    ...  # access has ended — send the user to a new sign-in
next_tokens = res.json()
save_tokens(next_tokens)  # persist the new refresh_token right away: the old one is dead
```

The response looks like the code exchange: a new `access_token`, `refresh_token` and `id_token` (without `nonce`). Rotation rules, and why a replay revokes the whole chain, are in [Tokens and lifetimes](./tokens#refresh-tokens-and-rotation).

## Revoke

`POST /revoke` (RFC 7009) — when the person signs out of your application or disconnects the integration. The body is a form with a `token` parameter (an access or refresh token); the client authenticates as at `/token`. `token_type_hint` is not needed: the type is known from the prefix.

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

- Revoking **any** token of a chain (access or refresh) closes the whole grant: the refresh token and every access token of that chain.
- The answer is `200` with an empty body even when the token is unknown, already revoked or belongs to another client (as RFC 7009 requires). You only get an error for failed client authentication (`401 invalid_client`) or an empty `token` (`400 invalid_request`).
- Revoke ends your application's access; it does not sign the person out of Calab itself.

## Browser apps (SPA) and CORS

`/token`, `/userinfo` and `/revoke` answer CORS requests only from origins registered on an SPA client under “Allowed origins”. The preflight (`OPTIONS`) allows `GET, POST` and the `Authorization, Content-Type` headers; cookies are never used. Discovery and JWKS are public without an `Origin` header, and with one only for origins of active SPA clients of this workspace.
