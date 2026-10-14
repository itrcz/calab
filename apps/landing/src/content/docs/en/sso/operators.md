---
title: For operators
description: IDENTITY_* and OAUTH_* variables for your own Calab installation — keys, origin, network approvals and plans.
order: 9
---

This page is for people who run Calab on their own servers. In Calab cloud everything is already set up: a workspace owner just needs the Business plan.

Corporate sign-in, the directory and the [OAuth provider](../oauth) are turned on together by a set of environment variables. The full deployment guide (Docker Compose, Caddy, LiveKit, mail) lives in the operator documentation for your installation; this page covers only what relates to identity.

## On or off

- **None of the variables below set** — identity is off. The server starts, the SSO and OAuth `/api/...` routes answer `409 CONFLICT` with `reason: "IDENTITY_NOT_CONFIGURED"`, and `/oidc/...` answers `503 server_error`. The app shows “Corporate sign-in and OAuth are not configured on this server”.
- **Some variables set, or an invalid value** — the server refuses to start and names the variable in the error. There is no partially enabled identity.
- `IDENTITY_PUBLIC_ORIGIN` and both keyrings with active `kid`s are always required together; the network lists may stay empty.

## Variables

| Variable | Required | Meaning |
|---|---|---|
| `IDENTITY_PUBLIC_ORIGIN` | Yes | The exact HTTPS origin with no path, query, fragment or trailing `/`, e.g. `https://id.example.com`. The SSO redirect URI and the OAuth issuer are built from it |
| `IDENTITY_ENCRYPTION_KEYS` | Yes | A JSON object `kid → key`: standard base64 of exactly 32 random bytes (AES-256). Encrypts IdP secrets and the directory bind password. Up to 32 keys; must not equal `JWT_SECRET` |
| `IDENTITY_ENCRYPTION_ACTIVE_KID` | Yes | The `kid` used to encrypt new data. Other keys stay for decryption |
| `OAUTH_SIGNING_KEYS` | Yes | A JSON object `kid → RSA private key PEM` (2048–8192 bits, newlines escaped as `\n`). Signs the OAuth provider's ID tokens; only public parts are published in JWKS |
| `OAUTH_SIGNING_ACTIVE_KID` | Yes | The `kid` of the key that signs new tokens |
| `IDENTITY_ENDPOINTS` | No | A JSON array of exceptions for IdPs on an internal network — see below |
| `IDENTITY_DIRECTORY_HOSTS` | For the directory | A JSON array of approved domain controllers — see below |
| `IDENTITY_EDITION` | No | `cloud` (default) or `enterprise` for your own installation with an Enterprise license |
| `IDENTITY_ENTERPRISE_WORKSPACE_IDS` | With `enterprise` | Comma-separated exact UUIDs of the workspaces that get SSO, directory and OAuth |

> [!DANGER]
> Once enabled, `IDENTITY_PUBLIC_ORIGIN` **never changes**: it is part of the token issuer and of redirect URIs registered with IdPs and in OAuth clients. Domain aliases and `Host`/`X-Forwarded-*` headers do not change the issuer.

### Generating keys

```bash
# 32 random bytes for IDENTITY_ENCRYPTION_KEYS
openssl rand -base64 32

# An RSA key for OAUTH_SIGNING_KEYS
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out oauth-signing.pem
```

```bash
IDENTITY_PUBLIC_ORIGIN=https://id.example.com
IDENTITY_ENCRYPTION_KEYS='{"enc-2026-10":"<base64 of 32 bytes>"}'
IDENTITY_ENCRYPTION_ACTIVE_KID=enc-2026-10
OAUTH_SIGNING_KEYS='{"sig-2026-10":"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"}'
OAUTH_SIGNING_ACTIVE_KID=sig-2026-10
IDENTITY_EDITION=enterprise
IDENTITY_ENTERPRISE_WORKSPACE_IDS=0192a000-0000-7000-8000-0000000000aa
```

Keep the keys in a secrets manager, apart from `JWT_SECRET`, and include them in backups together with the database: without the encryption key, stored IdP and directory secrets can't be decrypted.

### Rotating keys

- **Encryption:** add a new `kid` to `IDENTITY_ENCRYPTION_KEYS`, then switch `IDENTITY_ENCRYPTION_ACTIVE_KID`. Remove an old key only after the data it encrypted has been rewritten.
- **Signing:** add the new key to `OAUTH_SIGNING_KEYS` ahead of time — it appears in JWKS and clients get to cache it. Then switch `OAUTH_SIGNING_ACTIVE_KID`. Keep the old key until the ID tokens it signed have expired (at most 5 minutes).

## Network

By default Calab reaches IdPs only at public HTTPS addresses: 10-second timeout, responses up to 1 MiB, no redirects and no proxy from the environment. Private networks, loopback and cloud metadata addresses are refused.

### An IdP on an internal network — `IDENTITY_ENDPOINTS`

An exception is set for an **exact full URL**. For an internal IdP, list all its addresses from discovery: discovery itself, `authorization_endpoint`, `token_endpoint` and `jwks_uri`.

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

| Field | Meaning |
|---|---|
| `url` | The exact HTTPS URL |
| `approved_cidrs` | If set, the address the host name resolves to must fall within these networks — for both public and private addresses |
| `private_cidrs` | Private networks this URL may reach |
| `ca_pem` | Your own root certificate if the IdP is signed by an internal CA |
| `workspace_ids` | UUIDs of the workspaces the exception applies to |

An entry with `private_cidrs` and no `workspace_ids` is allowed only with `IDENTITY_EDITION=enterprise`; in the cloud edition the server won't start.

### Domain controllers — `IDENTITY_DIRECTORY_HOSTS`

Without an entry for its host, the [directory](./directory) can't be configured — even at a public address.

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

- `host` — the lowercase host name, no port or trailing dot; must match the host in “LDAPS URL”.
- `networks` — a non-empty list of networks where this host may live.
- `ca_pem` — if set, **only** this CA is trusted; system roots are not used.
- `workspace_ids` — the workspaces allowed to use this host. Without it the host is open to every workspace of the installation — only with `IDENTITY_EDITION=enterprise`.

## Access by plan

SSO, directory and OAuth provider features are turned on per workspace:

- **cloud** (`IDENTITY_EDITION=cloud`) — the workspace needs an active Business plan;
- **your own installation** (`IDENTITY_EDITION=enterprise`) — the workspace UUID in `IDENTITY_ENTERPRISE_WORKSPACE_IDS`.

Free, Team, an expired plan, or a workspace outside the list get no access. A downgrade doesn't lift required SSO — see [modes](./modes#turning-it-off-and-downgrades).

## Proxies and logs

- The `/oidc/workspaces/...` and `/.well-known/oauth-authorization-server/oidc/workspaces/...` routes must reach the API **before** the web client's static fallback.
- Redirect URIs carry one-time `code` and `state` values. Exclude the query string from reverse proxy and load balancer access logs for `/api/auth/sso/...`, `/oidc/...` and `/oauth/consent`.

## Checks after enabling

1. `GET https://id.example.com/oidc/workspaces/<workspace-id>/.well-known/openid-configuration` returns JSON whose `issuer` equals `https://id.example.com/oidc/workspaces/<workspace-id>` (for a workspace with the plan).
2. The workspace's “SSO settings” tab no longer says “not configured on this server”.
3. Pilot: “Optional” mode, SSO sign-in on web and desktop, corporate sign-in confirmation, recovery kit. “Required SSO” only after recovery has been checked.
