---
title: Connecting OpenID Connect
description: Step-by-step setup of any OIDC provider (Keycloak, Okta, Authentik and others) for a workspace.
order: 3
---

This path works for any provider that supports OpenID Connect Discovery and Authorization Code with PKCE. Microsoft Entra ID and AD FS have their own pages covering their specifics: [Entra](./oidc-entra), [AD FS](./oidc-adfs).

## What Calab requires from the IdP

| Requirement | Details |
|---|---|
| Discovery | `<issuer>/.well-known/openid-configuration` is reachable over HTTPS; its `issuer` field matches the connection's Issuer URL **exactly** |
| Flow | Authorization Code + PKCE `S256`. If discovery lists `code_challenge_methods_supported`, it must include `S256` |
| ID token signature | `RS256`, keys from `jwks_uri` |
| Claims | `sub` (up to 512 characters), `aud` = Client ID, `nonce`, `iat`, `exp` and **`auth_time`** — mandatory |
| Client authentication | `client_secret_basic`; `client_secret_post` if that's all the IdP advertises. Without a secret — a public client relying on PKCE alone |
| Network | Public HTTPS addresses. An internal IdP only if the operator allowed its address (see [for operators](./operators)) |

Calab requests only the `openid` scope and sends `prompt=login` and `max_age=3600` on every sign-in. Email, name and groups from the IdP are not used: identity is determined solely by the pair “connection + `sub`”.

> [!WARNING]
> `auth_time` is mandatory for every provider. `prompt` and `max_age` travel in a URL the browser can modify, so Calab checks how recent the sign-in is only by the signed `auth_time`. Without it, sign-in and the connection test are rejected.

## Redirect URI

```text
https://id.example.com/api/auth/sso/callback/<connection-id>
```

- `https://id.example.com` is your installation's corporate sign-in origin (the `IDENTITY_PUBLIC_ORIGIN` variable; in Calab cloud it's the app address). Your operator can tell you its value.
- `<connection-id>` is the ID of the SSO connection in Calab. It appears after the connection is first saved and is returned as `connection.id` in the response of `GET /api/workspaces/{workspace_id}/identity`.

> [!NOTE]
> Changing the Issuer URL or Client ID creates a **new** connection with a new ID — register the new redirect URI in your IdP. Changing only the secret keeps the same ID.

## Step 1. The application in your IdP

1. Create an OIDC client of the “confidential” type (a web app with a secret) in your IdP. A public client also works — leave the secret field empty in Calab.
2. Allow the Authorization Code flow and PKCE `S256`.
3. Make sure the ID token includes `auth_time`.
4. Note the Issuer URL, Client ID and secret. You'll add the redirect URI in step 3.

Keycloak example: Issuer URL — `https://sso.example.com/realms/corp`; the realm's default client scopes already put `auth_time` in the ID token.

## Step 2. The SSO connection in Calab

Workspace settings → “SSO settings” → the “SSO connection” card. Confirm your password if Calab asks.

| Field | Value |
|---|---|
| “Name” | The sign-in button label employees see, 1–100 characters, e.g. “Sign in with Keycloak” |
| “Provider” | “OpenID Connect” |
| “Issuer URL” | The exact issuer, e.g. `https://sso.example.com/realms/corp` — no query or fragment |
| “Client ID” | The application ID from your IdP |
| “Client secret” | The secret from your IdP; leave blank to retain the current secret |

Click “Save”. The connection is created as a draft (`IDENTITY_CONNECTION_STATUS_DRAFT`).

<!-- screenshot: identity/connection-generic -->

## Step 3. The redirect URI in your IdP

Take `connection.id` and add the redirect URI `https://id.example.com/api/auth/sso/callback/<connection-id>` in your IdP. It must match character for character.

## Step 4. Link and test

1. In the “Link corporate identity” card, link your own corporate identity: Calab asks for your local account password and opens the IdP sign-in in the system browser. While there is no active connection, the link goes to the draft.
2. In the “Test and activate” card, click “Test sign-in in browser” and sign in to the IdP with the same identity. The test creates no session and grants no access — it only marks the connection as tested (`IDENTITY_CONNECTION_STATUS_TESTED`).
3. Within **5 minutes** of a successful test, click “Activate tested connection”. The connection becomes active (`IDENTITY_CONNECTION_STATUS_ACTIVE`); the previous active one, if any, is disabled.

> [!TIP]
> Any change to the connection resets the test. Once you save, test and activate again. Activation doesn't change the sign-in policy: you switch that separately in [modes](./modes).

## Step 5. Employees

Each employee links their identity once: they sign in to their local account, open the workspace's “SSO settings” and click “Link corporate identity”. After that they can use “Sign in with SSO” on the sign-in screen, entering the “Workspace address”.

## Rotating the secret

A new secret with the same Issuer URL and Client ID updates the same connection, but it:

- resets the test — the connection must be tested and activated again;
- immediately revokes SSO confirmations, corporate sessions and OAuth access of this connection, as well as unfinished sign-ins.

Calab warns you: “Changing the secret revokes proofs and requires sign-in again.” Plan the rotation for a quiet time; under required SSO, save a [recovery kit](./recovery-kit) first.

## Network limits

Requests to the IdP (discovery, JWKS, code exchange) have a 10-second timeout, a 1 MiB response limit and never follow redirects. Internal network addresses, loopback and cloud metadata are refused unless the operator explicitly allowed that specific URL.
