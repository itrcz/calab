---
title: AD FS 2019+
description: Connecting Active Directory Federation Services to a Calab workspace over OpenID Connect with PKCE S256.
order: 5
---

AD FS connects over OpenID Connect. Only **AD FS 2019 and newer** is supported: older versions lack PKCE `S256`, and Calab refuses sign-in without it. General requirements are on the [OpenID Connect](./oidc-generic) page.

## Know this first

| Requirement | How to check |
|---|---|
| AD FS 2019+ | `https://adfs.example.com/adfs/.well-known/openid-configuration` contains `"code_challenge_methods_supported"` with `"S256"`. If the list is missing or lacks `S256`, the connection test and sign-in fail |
| Public address or operator approval | AD FS on an internal network is reachable by Calab only if the operator allowed its URL (see [for operators](./operators)) |
| `auth_time` in the ID token | Mandatory, as for every provider |
| Client authentication | `client_secret_post` — Calab picks it for AD FS automatically |

The AD FS issuer is usually `https://adfs.example.com/adfs` — check the `issuer` field in discovery and copy it exactly.

## Step 1. An application group in AD FS

In the “AD FS Management” console:

1. “Application Groups” → “Add Application Group”.
2. The “Server application” template (a confidential client with a secret). Name — for example, `Calab`.
3. Note the **Client Identifier**.
4. Redirect URI — `https://id.example.com/api/auth/sso/callback/<connection-id>`. The connection ID appears after step 2; you can add the URI later in the application's properties.
5. “Generate a shared secret” — copy it, it's shown once.
6. Make sure the application is permitted the `openid` scope.

## Step 2. The connection in Calab

Workspace settings → “SSO settings” → “SSO connection”:

| Field | Value |
|---|---|
| “Name” | For example, “Sign in with AD FS” |
| “Provider” | “AD FS 2019+” |
| “Issuer URL” | The `issuer` value from discovery, e.g. `https://adfs.example.com/adfs` |
| “Client ID” | The Client Identifier |
| “Client secret” | The shared secret |

Click “Save”. Take `connection.id` from `GET /api/workspaces/{workspace_id}/identity` and add the redirect URI in AD FS.

<!-- screenshot: identity/connection-adfs -->

## Step 3. Link, test, activate

1. “Link corporate identity” — link your own account.
2. “Test and activate” → “Test sign-in in browser”.
3. Within 5 minutes — “Activate tested connection”.

## Directory

AD FS handles sign-in only. For Calab to learn about disabled accounts and group removals, connect the [directory](./directory) — the same Active Directory over LDAPS.

> [!NOTE]
> The “AD FS account ↔ Calab account” link and the “directory object ↔ member” link are independent. The employee makes the first one when linking; the owner makes the second one by `objectGUID`.

## Common errors

| Symptom | Cause |
|---|---|
| The test fails at once | Discovery lacks `S256` (AD FS older than 2019) or `issuer` doesn't match what you entered |
| AD FS shows a redirect URI error | The redirect URI in AD FS doesn't match the connection's address |
| “identity access denied” after sign-in | No `auth_time` in the ID token, a wrong secret, or the sign-in used a different account than the linked one |

More in [troubleshooting](./troubleshooting).
