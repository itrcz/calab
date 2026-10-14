---
title: Register a client
description: Create an OAuth client in workspace settings, choose its type, redirect URIs and scopes, and rotate its secret.
order: 2
---

A client is the record of your application in one workspace: the name people see, its type, the exact redirect addresses and which profile data it may receive. A workspace owner or admin creates it in the Calab app.

## Before you start

- The workspace is on the **Business** plan (or an on-prem **Enterprise** installation with the provider enabled). Otherwise the tab is locked.
- You are a workspace **owner or admin**, signed in with a **local account** (not a corporate SSO session).
- Your password was confirmed **within the last 5 minutes**. Calab asks you to “Confirm password” when that confirmation is older.
- If the workspace uses “Required SSO”, you also need a fresh (≤ 5 minutes) corporate sign-in — the “Confirm corporate sign-in” button.

## Create a client

1. Open **Workspace settings → “OAuth clients”** and click **“Create client”**.
2. Fill in the form:

| Field | What to enter | Constraints |
|---|---|---|
| “Name” (the “Application” section) | The name people see on the consent screen | 1–100 characters |
| “Client type” | “Web app with server”, “Native app” or “Browser app (SPA)” | Cannot be changed later |
| “Redirect URIs (one per line)” | The exact addresses Calab sends the user back to with a `code` | 1–10 URIs; no `*`, `#`, whitespace or credentials in the URL |
| “Allowed origins (one per line)” | SPA only: origins whose browser code calls `/token`, `/userinfo`, `/revoke` | Up to 10, `https://host[:port]` only, no path |
| “Profile access” | `openid` (always) plus optionally `profile` and `email` | — |
| “Allow continued access” | Whether refresh tokens may be issued | Each person still decides on the consent screen |

3. Save. Calab shows the `client_id` (`calab_client_…`) and, for a web app with a server, a **secret** (`calab_os_…`).

> [!WARNING]
> The secret is shown **once**; Calab keeps only its hash. Put it into your server's secret store right away. If you lose it, rotate the secret (below).

### Redirect URI rules

- Matching is **byte-exact**: path, case, trailing `/` and query string must equal a registered URI. No prefixes, no wildcards.
- Web and SPA clients: `https://` only.
- Native apps may also use:
  - loopback `http://127.0.0.1:{port}/…` or `http://[::1]:{port}/…` — the port may change between runs (RFC 8252), everything else must match; `localhost` is not accepted;
  - a private reverse-domain scheme with a path, such as `com.example.crm:/oauth/callback`.

### Limits

- Up to **20** active clients per workspace (`409`, `reason: "PLAN_LIMIT"`).
- A confidential client has at most **two** valid secrets at a time.

## Editing a client

Renaming is harmless: existing access keeps working, and people see the new name on the consent screen at their next sign-in (a silent `prompt=none` sign-in returns `consent_required` until the person approves the new name).

Changing **redirect URIs, origins, scopes or “Allow continued access”** is a security change: Calab **revokes all access issued to this client** and cancels sign-ins in progress. People have to sign in again.

## Rotating the secret

“Rotate secret” issues a new secret (shown once) and:

- by default keeps the old secret valid for **10 more minutes** — enough to roll out the new configuration;
- with “Revoke old secret immediately” the old secret stops working at once.

> [!WARNING]
> Rotation is a security change: every grant issued to this client (refresh and access tokens) is revoked immediately, regardless of the 10-minute window. The window only covers the client authenticating itself at `/token`.

If two secrets are already valid, wait for the old one to expire or use “Revoke old secret immediately”.

## Deleting a client

“Delete” disables the client: its secrets and all issued access are revoked, and `/authorize` and `/token` start answering with errors. The `client_id` is never reused.

## Management API

The same actions exist over REST. This is the Calab app API and it requires a **person's session** (owner or admin) under the same conditions as above. Bot tokens and OAuth tokens are rejected, and state-changing requests are accepted only from Calab's own origin. Automate through the UI; the table is here to explain the model.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/workspaces/{workspace}/oauth/clients` | List the workspace's clients |
| `POST` | `/api/workspaces/{workspace}/oauth/clients` | Create a client → `201 {client, secretOnce}` |
| `GET` | `/api/workspaces/{workspace}/oauth/clients/{client}` | One client (by record `id` or `clientId`) |
| `PATCH` | `/api/workspaces/{workspace}/oauth/clients/{client}` | Full snapshot of editable fields + the expected `version` |
| `DELETE` | `/api/workspaces/{workspace}/oauth/clients/{client}` | Disable the client → `204` |
| `POST` | `/api/workspaces/{workspace}/oauth/clients/{client}/rotate-secret` | Rotate the secret `{revokeOld}` → `{client, secretOnce, oldSecretValidUntil}` |

Create request (protojson, lowerCamelCase fields):

```json
{
  "name": "Acme CRM",
  "type": "OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB",
  "redirectUris": ["https://crm.example.com/auth/calab/callback"],
  "allowedOrigins": [],
  "scopes": ["openid", "profile", "email"],
  "refreshEnabled": true
}
```

`201` response:

```json
{
  "client": {
    "id": "0192a0f1-5c3e-7b21-9d4a-6e8f0a1b2c3d",
    "workspaceId": "0192a000-0000-7000-8000-0000000000aa",
    "clientId": "calab_client_e07JrYTVpGfRYJ0pQaF6yzkME6S9W856DgsKNWOKvgE",
    "name": "Acme CRM",
    "type": "OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB",
    "redirectUris": ["https://crm.example.com/auth/calab/callback"],
    "scopes": ["email", "openid", "profile"],
    "refreshEnabled": true,
    "version": "1",
    "createdAt": "2026-10-14T09:00:00Z"
  },
  "secretOnce": "calab_os_VWMV4RGIRsisgKhdE7ohFW_QoAdNWS4n9GkM3Ty1kb4"
}
```

`PATCH` takes the whole `{version, name, redirectUris, allowedOrigins, scopes, refreshEnabled}`. If `version` is stale (someone changed the client first), the answer is `409` with `reason: "IDENTITY_CONFIG_CHANGED"`: reload the client and retry.

## Next steps

- [Sign-in flow](./flow) — how to use the `client_id` and the secret.
- [Errors](./errors) — management API error codes.
