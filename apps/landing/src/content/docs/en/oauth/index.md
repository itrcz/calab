---
title: OAuth 2 and OpenID Connect
description: Sign in “with Calab” to your own services — an OpenID Connect provider with one issuer per workspace.
order: 1
---

Calab can act as an **OpenID Connect provider**. Your application — a CRM, a portal, an internal tool — shows a “Sign in with Calab” button, the member approves, and the application receives a signed statement of who that person is in a specific workspace: a stable identifier, a display name and, when allowed, a verified email address.

It is the standard **Authorization Code + PKCE (S256)** flow, so any certified OIDC library works: `openid-client` for Node.js, `Authlib` for Python, Spring Security, ASP.NET and so on.

## What your application gets

| Scope | What it gives |
|---|---|
| `openid` | Required. The member's stable `sub` in this workspace and an ID token. |
| `profile` | `name` — the member's display name. |
| `email` | `email` and `email_verified: true` — only when the address is verified in Calab. An unverified address is never sent. |

That is all. The provider **does not grant access to the Calab API**: an OAuth access token is rejected by the REST API, the gateway and voice. Roles, the list of workspaces, the internal account UUID and data from the corporate IdP are not exposed either.

> [!NOTE]
> Need to read messages, tasks or rooms on behalf of a service? That is a job for a [bot](../bots), not for OAuth. OAuth is sign-in and a minimal profile only.

## One issuer per workspace

An OAuth client belongs to exactly one workspace, and every workspace has its own issuer:

```text
https://id.example.com/oidc/workspaces/{workspace_id}
```

`https://id.example.com` is the identity origin of your Calab installation (the operator variable `IDENTITY_PUBLIC_ORIGIN`; in most installations it is the same as the app address). `{workspace_id}` is the workspace UUID in lower case. The issuer never depends on `Host` headers and does not change once identity is enabled.

Metadata is published at two addresses — for OIDC Discovery and for RFC 8414:

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

## Endpoints

| Method | Path (relative to the issuer) | Purpose |
|---|---|---|
| `GET` | `/.well-known/openid-configuration` | Provider metadata |
| `GET` | `/jwks` | Public RS256 keys to verify ID tokens (cached for 60 s) |
| `GET`, `POST` | `/authorize` | Starts sign-in in the user's browser |
| `POST` | `/token` | Exchanges a code or a refresh token for tokens |
| `GET`, `POST` | `/userinfo` | The profile for an access token |
| `POST` | `/revoke` | Token revocation (RFC 7009) |

## Who can use it

- **Plan.** The provider is available to workspaces on the **Business** plan (cloud) and in **Enterprise** (on-prem) installations where the operator enabled it for the workspace. On Free and Team, or once a plan ends, no new sign-ins are issued: `/authorize` answers `access_denied`.
- **Who creates clients.** The workspace owner or an admin — in “Workspace settings → OAuth clients”. See [Register a client](./register-client).
- **Who can sign in.** Workspace members. Guests and bots never go through OAuth sign-in: bots have their own access model, see [bot authentication](../bots/auth).
- **Required SSO.** When the workspace uses “Required SSO”, the member confirms a sign-in through the corporate IdP before the consent screen — see [SSO modes](../sso/modes).

## Client types

| Type (API) | In the app | Authentication at `/token` | Redirect URIs |
|---|---|---|---|
| `OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB` | “Web app with server” | `client_secret_basic` (the secret in an `Authorization: Basic` header) | `https://` only |
| `OAUTH_CLIENT_TYPE_PUBLIC_SPA` | “Browser app (SPA)” | `none` (PKCE only) | `https://` only; browser requests from allowed origins |
| `OAUTH_CLIENT_TYPE_PUBLIC_NATIVE` | “Native app” | `none` (PKCE only) | `https://`, loopback `http://127.0.0.1` / `http://[::1]` on any port, a private scheme such as `com.example.app:/callback` |

PKCE S256 is required for **every** client type, confidential ones included.

## What is not supported

- `client_credentials`, the password grant, implicit and hybrid flows — Authorization Code only.
- Dynamic client registration — clients are created by hand in workspace settings.
- Token introspection — access tokens are opaque; validate one by calling [`/userinfo`](./userinfo-refresh-revoke).
- `offline_access`, API scopes, pairwise subjects, single logout, `request` / `request_uri` / `claims`.
- SAML and SCIM.

## Next steps

1. [Register a client](./register-client) — create a client and get a `client_id`.
2. [Sign-in flow](./flow) — step by step, with a diagram and code.
3. [Tokens and lifetimes](./tokens) — what lives how long and why a token can stop working.
4. [Security checklist](./security) — before you go to production.
