---
title: Microsoft Entra ID
description: Registering an app in Entra ID, the mandatory auth_time claim and connecting it to a Calab workspace.
order: 4
---

Microsoft Entra ID (formerly Azure AD) connects over OpenID Connect with two additions: the issuer is bound to a specific tenant, and `auth_time` has to be enabled manually as an optional claim. General requirements are on the [OpenID Connect](./oidc-generic) page.

## Know this first

- **A specific tenant only.** The Issuer URL must be exactly `https://login.microsoftonline.com/<tenant-id>/v2.0`. The `common`, `organizations` and `consumers` addresses are not accepted. Calab also checks the `tid` claim of every ID token against the configured Tenant ID.
- **`auth_time` isn't sent by default.** In Entra v2 it must be added as an optional claim. Without it, sign-in is rejected.
- **Client authentication** is `client_secret_post` (Calab picks it for Entra automatically).

## Step 1. Register the application

In the Microsoft Entra admin center:

1. “App registrations” → “New registration”.
2. Name — for example, `Calab`. Supported account types — “Accounts in this organizational directory only” (single tenant).
3. Redirect URI — the “Web” platform, address `https://id.example.com/api/auth/sso/callback/<connection-id>`. The connection ID appears after step 3; you can register the app without a URI and add it later under “Authentication”.
4. Click “Register” and note the **Application (client) ID** and **Directory (tenant) ID** on the “Overview” page.

## Step 2. Secret and `auth_time`

1. “Certificates & secrets” → “New client secret”. Copy the **Value** (not the Secret ID) — it's shown once.
2. “Token configuration” → “Add optional claim” → token type **ID** → check `auth_time` → “Add”.

> [!WARNING]
> Without the `auth_time` optional claim, the connection test and employee sign-ins fail with “identity access denied”. The server writes an `auth_time_missing` audit event that your operator can find for this connection.

## Step 3. The connection in Calab

Workspace settings → “SSO settings” → “SSO connection”:

| Field | Value |
|---|---|
| “Name” | For example, “Sign in with Microsoft” |
| “Provider” | “Microsoft Entra ID” |
| “Issuer URL” | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| “Tenant ID” | The Directory (tenant) ID in canonical lowercase form: `00000000-0000-0000-0000-000000000000` |
| “Client ID” | The Application (client) ID |
| “Client secret” | The secret Value from step 2 |

Click “Save”. Then take `connection.id` from `GET /api/workspaces/{workspace_id}/identity` and add the redirect URI under the Entra app's “Authentication”.

<!-- screenshot: identity/connection-entra -->

> [!NOTE]
> The tenant ID in the Issuer URL and in the “Tenant ID” field must match. If they differ, Calab won't save the connection.

## Step 4. Link, test, activate

As with any OIDC provider:

1. “Link corporate identity” — link your own Entra account.
2. “Test and activate” → “Test sign-in in browser”.
3. Within 5 minutes — “Activate tested connection”.

Then choose a mode under “Sign-in policy” — see [modes](./modes).

## Secret expiry

Entra secrets expire. Set a reminder: before expiry, create a new secret in Entra, enter it in “Client secret”, then test and activate the connection again. Rotation revokes current SSO confirmations — see [rotating the secret](./oidc-generic#rotating-the-secret).

## Common errors

| Symptom | Cause |
|---|---|
| The connection won't save | The issuer isn't tenant-specific, the Tenant ID doesn't match the issuer, or the Tenant ID isn't in canonical form |
| “identity access denied” on test | No `auth_time` optional claim; redirect URI not registered; signed in with an account from another tenant |
| AADSTS50011 in the browser | The redirect URI in Entra doesn't match `https://id.example.com/api/auth/sso/callback/<connection-id>` |

More in [troubleshooting](./troubleshooting).
