---
title: Reauthentication
description: Password confirmation and SSO confirmation — which actions need them, how long they last, and how a corporate session re-signs in.
order: 8
---

Calab distinguishes two independent proofs that the account owner is really at the keyboard. Neither replaces the other: a fresh password gives no SSO confirmation, and a fresh SSO sign-in doesn't confirm the password.

## Two kinds of confirmation

| | Password confirmation | SSO confirmation |
|---|---|---|
| What it proves | The person knows the **local** account password | The person just signed in to the organization's IdP |
| How to get it | “Confirm password” → “Current password” | “Confirm corporate sign-in” — an IdP sign-in in the system browser |
| Which sessions have it | Local account sessions only | Local account sessions and corporate sessions |
| Lifetime for regular access | Not needed | Up to 1 hour (by `auth_time` from the ID token) |
| Lifetime for administration | 5 minutes | 5 minutes (under required SSO) |
| Error when missing | `403 RECENT_AUTH_REQUIRED` | `403 SSO_REQUIRED` |

Refreshing a session extends neither confirmation.

## What needs what

| Action | Password ≤ 5 min | SSO |
|---|---|---|
| Working in an “Optional” workspace from a local account | — | — |
| Working in a “Required SSO” workspace | — | ≤ 1 h |
| Any work from a corporate session | — (no password) | ≤ 1 h |
| Linking a corporate identity | Yes | The IdP sign-in is part of linking |
| Unlinking your identity | Yes | ≤ 5 min |
| Changing the connection, policy, directory, recovery kit | Yes | ≤ 5 min if required SSO is on |
| Creating and changing OAuth clients | Yes | ≤ 5 min if required SSO is on |
| Turning on “Required SSO” | Yes | ≤ 5 min, always |
| Recovering with a code | Yes | Not required — see [recovery kit](./recovery-kit) |

When the server answers `RECENT_AUTH_REQUIRED`, the app shows “Confirm your password: this action needs a sign-in from the last 5 minutes.” and retries the action after confirmation (“Confirm again” if time runs out again).

## Password confirmation over the API

```bash tab="curl"
curl -s -X POST https://app.example.com/api/auth/local/reauth \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Origin: https://app.example.com" \
  -H "Content-Type: application/json" \
  -d '{"currentPassword": "…"}'
```

```json
{"authenticatedAt": "2026-10-14T09:00:00Z", "validUntil": "2026-10-14T09:05:00Z"}
```

The route accepts only a local account session and a request from an allowed app origin. It gives no SSO confirmation.

## Re-signing in a corporate session

A corporate session (obtained by signing in with SSO) can renew its confirmation without leaving Calab: “Confirm corporate sign-in” starts an IdP sign-in with the purpose `SSO_FLOW_PURPOSE_STEP_UP`.

Rules:

- it works only in the session's own workspace, through the current active connection, and with the **same** linked IdP identity;
- it renews only this session's SSO confirmation — it issues no new tokens, keeps the session ID and doesn't extend the session's absolute deadline;
- if the `sub`, account, connection, policy, directory status or plan changed, or the session was revoked, the re-sign-in is rejected;
- an expired or revoked session can't be revived this way: sign in again.

Guests, bots, recovery sessions and other workspaces cannot use this path.

## Sign-in freshness for OAuth apps

When a third-party app asks Calab to confirm a recent sign-in (`prompt=login` or `max_age`), Calab takes the sign-in time as follows:

- for a local account — the time of the last **password** confirmation;
- for a corporate session — the time of the last **IdP** sign-in.

So the consent screen may ask you to confirm your password, pass SSO, or both. After confirmation, consent continues in the same session. See the [consent screen](../oauth/consent).

## All lifetimes at a glance

| Item | Lifetime |
|---|---|
| Password confirmation for administration and linking | 5 minutes |
| SSO confirmation for access | 1 hour from `auth_time` |
| SSO confirmation for administration | 5 minutes |
| An unfinished IdP sign-in | 5 minutes, single use |
| Desktop sign-in completion ticket | 60 seconds, single use |
| Recovery session | 10 minutes |
| Allowed clock skew with the IdP | 60 seconds (never extends lifetimes) |
