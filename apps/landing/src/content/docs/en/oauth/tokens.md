---
title: Tokens and lifetimes
description: Formats and lifetimes of codes, access, refresh and ID tokens, refresh rotation and why access can end early.
order: 4
---

Every provider token except the ID token is **opaque**: 32 random bytes in base64url behind a type prefix. Calab stores only their SHA-256 hashes, so a token can never be recovered or shown again.

## At a glance

| What | Format | Lifetime | Notes |
|---|---|---|---|
| `client_id` | `calab_client_` + 43 characters | Until the client is deleted | A public identifier, not a secret |
| Client secret | `calab_os_` + 43 characters | No expiry; after a rotation the old one stays valid for 10 minutes | Shown once |
| Sign-in request | — | 10 minutes | The consent screen must finish within it |
| Authorization code | `calab_oc_` + 43 characters | **60 seconds**, single use | Bound to the client, `redirect_uri` and PKCE |
| Access token | `calab_oa_` + 43 characters | **up to 5 minutes** (`expires_in`) | For `/userinfo` only |
| Refresh token | `calab_or_` + 43 characters | **8 hours** at most, **30 minutes** idle | Rotated on every exchange |
| ID token | JWT, RS256 | Same as the access token | Verified with `jwks_uri` |

> [!NOTE]
> Lifetimes are upper bounds. `expires_in` can be below 300 seconds: a token never outlives the Calab session it was issued from or, in an SSO workspace, the freshness of the corporate sign-in.

## Access token

An access token opens [`/userinfo`](./userinfo-refresh-revoke) and nothing else. It **does not work** with the Calab REST API, the gateway or voice; conversely, Calab app tokens and bot tokens are refused by `/userinfo`. There is no introspection: to check a token, call `/userinfo` — `401 invalid_token` means it is no longer valid.

## Refresh tokens and rotation

A refresh token is issued only when the client has “Allow continued access” turned on **and** the person kept that box ticked on the consent screen.

- Every exchange (`grant_type=refresh_token`) returns a **new** refresh token, a new access token and a new ID token (without `nonce`). The old refresh token becomes used immediately.
- Presenting an already used refresh token again from the same client is treated as a leak: Calab **revokes the whole chain** (the grant) and the person must sign in again. There is no grace window — if a response is lost on the network, a new sign-in is required.
- Each exchange extends the idle deadline to 30 minutes, but never past the absolute 8-hour limit from sign-in.
- An exchange can **narrow** scopes (the `scope` parameter); the narrowing applies to the whole chain. Scopes can never be widened that way (`invalid_scope`).

> [!TIP]
> Keep refresh tokens on the server, refresh sequentially (not from several workers in parallel) and persist the new refresh token before you use the new access token.

## ID token

A JWT with `alg: RS256` and a `kid` header. Claims: `iss`, `sub`, `aud` (= your `client_id`), `iat`, `exp`, `auth_time`, `nonce` (code exchange only), plus `name` with the `profile` scope and `email` + `email_verified: true` with the `email` scope and a verified address. An unverified email never appears in the ID token or in `/userinfo`.

Signing keys are configured by the installation's operator; new keys are published in `jwks_uri` ahead of use and old ones stay there during the transition. Cache the JWKS (the server sends `Cache-Control: max-age=60`) and reload it once when you meet an unknown `kid`.

## Subject (`sub`)

- A random identifier (32 bytes, base64url) created for the “workspace + member” pair.
- **Stable**: it does not change when the name or email changes or the client is recreated.
- **The same** for every client of one workspace and **different** across workspaces (their issuers differ too).
- It never reveals the internal account UUID.

Use the `(iss, sub)` pair as the account key in your application.

## When access ends early

Calab re-checks everything on every code exchange, refresh and `/userinfo` call. Access (the whole grant chain) ends when:

- the person revokes it in “OAuth apps” or signs out of the Calab session they signed in from;
- the member is removed or banned from the workspace, or the directory (AD) closes their access;
- an admin changes the client's redirect URIs, origins, scopes or refresh setting, rotates its secret or deletes it;
- the workspace's SSO policy changes or the corporate sign-in proof expires;
- the Business / Enterprise plan ends or the workspace is suspended;
- the client presents a used code or refresh token again.

At `/token` this shows up as `400 invalid_grant`, at `/userinfo` as `401 invalid_token`. The right reaction is the same: start a new sign-in.
