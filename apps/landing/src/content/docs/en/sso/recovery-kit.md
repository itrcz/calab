---
title: Recovery kit
description: One-time recovery codes — how the owner regains control of the policy when the IdP is unavailable.
order: 6
---

Required SSO means nobody gets into the workspace without the IdP — the owner included. If the IdP breaks, a secret expires or the application is deleted, you need a fallback. That's the recovery kit: 10 one-time codes that let the owner relax the sign-in policy and fix the connection.

## What a code gives you

| | |
|---|---|
| Who can use it | Only the owner who generated the kit, and only from their **local** password account |
| What it grants | A **10-minute** recovery session |
| What you can do in it | Only switch the policy to “Optional” or “Off” |
| What you can't | Read chats, see members, issue OAuth tokens, turn on “Required SSO” |
| Code lifetime | 365 days from generation (server clock) |
| Reuse | No: each code works once |

In the app a recovery session is labeled “Recovery mode: policy repair only, without chats or applications.” Each code use and each policy change is recorded in the audit log.

## Generate a kit

1. Workspace settings → “SSO settings” → “Sign-in policy” → the “Account recovery” section.
2. Click “Generate recovery kit”. Calab asks you to confirm your password; if required SSO is already on, also to pass SSO (both within the last 5 minutes).
3. Save the 10 codes right away: “Save now. These values are shown once and are not stored in the app.” The expiry is shown next to them as “Valid until”.
4. Check “Recovery kit saved”. Without it you can't turn on “Required SSO”.

<!-- screenshot: identity/recovery-kit -->

> [!DANGER]
> Calab stores only hashes of the codes and cannot show them again. Keep the codes apart from the owner's password — for example, in a safe or in another responsible person's password manager.

Generating a new kit **revokes all previous codes**. Renew the kit before it expires: after 365 days the old codes stop working.

## Recover the policy

When the workspace is locked and SSO fails:

1. Sign in to the owner's **local** account with the password (“Sign in to your local account”).
2. On the locked workspace screen, choose “Recover policy”.
3. Confirm your password and enter the “Recovery code”.
4. Within 10 minutes, switch “Sign-in policy” to “Optional” or “Off”.
5. Fix the connection (a new secret, a corrected issuer), test and activate it, generate a new recovery kit, and only then turn “Required SSO” back on.

Over the API, steps 3–4 are `POST /api/auth/sso/workspaces/{workspace_id}/recover` with the body `{"recoveryCode": "…"}` (the response holds the recovery session tokens), then `PUT /api/workspaces/{workspace_id}/identity/policy` with `{"version": "…", "mode": "IDENTITY_POLICY_MODE_OPTIONAL"}`.

## If both the password and the codes are lost

An email password reset doesn't create an SSO confirmation and doesn't bypass required mode. If the owner has lost both the local account password and the recovery kit, there is no self-service path: in the cloud, contact Calab support; on your own installation, contact your operator. The procedure is manual, verified and audited.

> [!WARNING]
> The owner can't unlink their own corporate identity while required SSO is on or while there is no valid recovery kit — otherwise the workspace would be left with no way to recover.
