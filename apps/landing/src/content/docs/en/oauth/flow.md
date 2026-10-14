---
title: Sign-in flow (Authorization Code + PKCE)
description: Sign in “with Calab” step by step — from the button in your app to a verified ID token and profile.
order: 3
---

Calab supports a single flow — **Authorization Code with PKCE S256**. It is the same for every client type; the only difference is how the client authenticates at `/token`.

The examples use:

| Value | Example |
|---|---|
| Workspace issuer | `https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa` |
| `client_id` | `calab_client_e07JrYTVpGfRYJ0pQaF6yzkME6S9W856DgsKNWOKvgE` |
| Secret (web app with server only) | `calab_os_VWMV4RGIRsisgKhdE7ohFW_QoAdNWS4n9GkM3Ty1kb4` |
| `redirect_uri` | `https://crm.example.com/auth/calab/callback` |

## Diagram

<svg role="img" aria-labelledby="oauth-flow-title-en" viewBox="0 0 780 510" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="inherit" font-size="12" fill="currentColor">
  <title id="oauth-flow-title-en">Sign-in with Calab sequence: browser, client app, /authorize, consent screen, /token, /userinfo</title>
  <defs>
    <marker id="oauth-flow-arrow-en" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
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
    <text x="60" y="37">Browser</text>
    <text x="190" y="37">Your app</text>
    <text x="320" y="37">/authorize</text>
    <text x="450" y="37">Consent</text>
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
  <g fill="none" stroke="currentColor" stroke-width="1.4" marker-end="url(#oauth-flow-arrow-en)">
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
    <text x="68" y="79">1. “Sign in with Calab”</text>
    <text x="68" y="116">2. 302 → /authorize</text>
    <text x="68" y="153">3. GET /authorize (PKCE, state, nonce)</text>
    <text x="328" y="190">4. 303 → consent</text>
    <text x="68" y="227">5. sign in to Calab, click “Allow”</text>
    <text x="68" y="264">6. 303 → redirect_uri?code&amp;state&amp;iss</text>
    <text x="68" y="301">7. code, state, iss</text>
    <text x="198" y="338">8. POST /token: code + code_verifier</text>
    <text x="198" y="375">9. access_token, id_token, refresh_token</text>
    <text x="198" y="404" opacity="0.75">check state, iss, the signature and nonce of id_token</text>
    <text x="198" y="432">10. GET /userinfo, Authorization: Bearer access_token</text>
    <text x="198" y="469">11. sub, name, email</text>
  </g>
</svg>

Solid arrows are requests, dashed ones are responses and redirects. Steps 3–6 happen in the user's browser; steps 8–11 are server to server (for SPAs and native apps — directly from the client).

## Step 1. Prepare PKCE, state and nonce

For every sign-in attempt, generate and keep in your app's session:

- `code_verifier` — 43–128 characters from `A–Z a–z 0–9 - . _ ~` (typically 32 random bytes in base64url);
- `code_challenge` = `BASE64URL(SHA-256(code_verifier))` without `=` padding — exactly 43 characters;
- `state` — a random 1–512 byte string that protects against CSRF;
- `nonce` — a random 1–512 byte string that binds the ID token to this attempt.

> [!NOTE]
> In the Calab profile, `state` and `nonce` are **required** on every request (OIDC Core makes `nonce` optional for the code flow). Without them you get `invalid_request`.

```sh tab="curl"
# Generating the values in a shell (openssl ≥ 1.1)
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
// keep codeVerifier, state and nonce in the user's server-side session
```

```python tab="Python"
import base64, hashlib, secrets

code_verifier = secrets.token_urlsafe(32)
code_challenge = base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode()).digest()).rstrip(b"=").decode()
state = secrets.token_hex(16)
nonce = secrets.token_hex(16)
# keep code_verifier, state and nonce in the user's server-side session
```

## Step 2. Send the user to `/authorize`

Redirect the browser to the `authorization_endpoint`:

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

| Parameter | Required | Value |
|---|---|---|
| `response_type` | yes | `code` |
| `client_id` | yes | From the client settings |
| `redirect_uri` | yes | Exactly one of the registered URIs |
| `scope` | yes | `openid`, optionally `profile` and `email` — no wider than the client allows |
| `state`, `nonce` | yes | 1–512 bytes |
| `code_challenge` | yes | 43 base64url characters |
| `code_challenge_method` | yes | `S256` (`plain` is not supported) |
| `response_mode` | no | `query` only |
| `prompt` | no | `login`, `consent`, both, or `none` (on its own) |
| `max_age` | no | Seconds; the Calab sign-in must be no older than this |

Each parameter appears exactly once. `request`, `request_uri`, `claims`, `id_token_hint`, `resource` and `audience` are rejected with `invalid_request`; `acr_values` is accepted and ignored. You may also send the same parameters as a form `POST` (`application/x-www-form-urlencoded`, no query string).

## Step 3. The user signs in and approves

Calab redirects the browser to the consent screen on the identity origin (`https://id.example.com/oauth/consent?request=…`). A person who is not signed in to Calab signs in first; if the workspace requires SSO, they confirm through the corporate IdP. Then they see “Allow sign-in to application?” with the application name, the workspace, their account name and the requested data. See [Consent screen](./consent).

A sign-in request lives for **10 minutes**.

## Step 4. Handle the response at `redirect_uri`

Success:

```text
https://crm.example.com/auth/calab/callback
  ?code=calab_oc_Laufm1V1F0gnbG0nHG4NcwvsM6wHkhQOmk4AH8CzCSw
  &state=4f1c2a…
  &iss=https%3A%2F%2Fid.example.com%2Foidc%2Fworkspaces%2F0192a000-0000-7000-8000-0000000000aa
```

A refusal or an error arrives at the same address with `error` instead of `code` (for example `error=access_denied`), again with `state` and `iss`.

Always check that:

1. `state` matches the one kept in the session;
2. `iss` equals this workspace's issuer (mix-up protection, RFC 9207).

> [!WARNING]
> If `client_id` or `redirect_uri` is wrong, Calab does **not** redirect anywhere; it shows an `invalid_request` error in the browser instead, so a code is never sent to an unregistered address.

## Step 5. Exchange the code for tokens

`POST` to the `token_endpoint` with an `application/x-www-form-urlencoded` body and no query string:

| Parameter | Value |
|---|---|
| `grant_type` | `authorization_code` |
| `code` | From step 4 |
| `redirect_uri` | Byte-for-byte the same as in step 2 |
| `code_verifier` | From step 1 |
| `client_id` | Public clients only (SPA, native) |

A confidential client authenticates **only** with `Authorization: Basic base64(client_id:secret)` (each part URL-encoded first, per RFC 6749). `client_secret` in the body and `client_assertion` are refused (`invalid_client`). The `scope` parameter is not allowed in a code exchange.

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

For a public client, drop the `Authorization` header and add `client_id` to the body.

Response:

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

`refresh_token` is present only when the client has “Allow continued access” turned on **and** the person agreed to it. A code is single-use and lives for **60 seconds**; presenting an already used code again from the same client revokes everything issued for it.

## Step 6. Verify the ID token

The ID token is a JWT signed with RS256. Pick the key by `kid` from `jwks_uri` and check:

| Claim | Check |
|---|---|
| `iss` | Equals the workspace issuer |
| `aud` | Equals your `client_id` |
| `exp`, `iat` | Not expired (it lives as long as the access token — up to 5 minutes) |
| `nonce` | Equals the value from step 1 |
| `auth_time` | When the person actually signed in — use it with `max_age` |

Example payload:

```json
{
  "iss": "https://id.example.com/oidc/workspaces/0192a000-0000-7000-8000-0000000000aa",
  "sub": "7qCZMpOp2e-PYx7A9VRiAGUu8o-MF1kgOZG0umGs_HM",
  "aud": "calab_client_e07JrYTVpGfRYJ0pQaF6yzkME6S9W856DgsKNWOKvgE",
  "iat": 1792141200,
  "exp": 1792141500,
  "auth_time": 1792140900,
  "nonce": "9b7e30…",
  "name": "Anna Peters",
  "email": "anna@example.com",
  "email_verified": true
}
```

Identify the person by the **(`iss`, `sub`)** pair, not by email: `sub` is stable for a member within this workspace, while the email may change or be absent. Calab does not issue `acr` or `amr`.

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
import jwt  # PyJWT >= 2.4

jwks = jwt.PyJWKClient(f"{issuer}/jwks")
key = jwks.get_signing_key_from_jwt(tokens["id_token"])
claims = jwt.decode(tokens["id_token"], key.key, algorithms=["RS256"],
                    audience=os.environ["CALAB_CLIENT_ID"], issuer=issuer)
if claims["nonce"] != session["nonce"]:
    raise ValueError("nonce mismatch")
account_key = f'{claims["iss"]}|{claims["sub"]}'
```

## Step 7 (optional). Fetch the profile

For fresh data, call `GET /userinfo` with the access token. Details, and how to keep access going, are in [UserInfo, refresh and revoke](./userinfo-refresh-revoke).

## Silent re-authentication

`prompt=none` issues a code without any UI when the person has a live Calab session in this browser and has already consented to this client for the same scopes. Otherwise Calab immediately returns to `redirect_uri` with `login_required`, `consent_required` or `interaction_required` — start a normal sign-in then.

## Off-the-shelf libraries

Calab follows OIDC Discovery, so you usually only need the workspace issuer, the `client_id`, the secret and the redirect URI. Make sure the library enables PKCE S256, sends a `nonce`, uses `client_secret_basic` for a web client and checks the `iss` parameter of the authorization response.
