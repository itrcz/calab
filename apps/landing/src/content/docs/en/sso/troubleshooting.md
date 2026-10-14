---
title: Troubleshooting
description: Common corporate sign-in and directory errors — what the user sees, what the API returns and how to fix it.
order: 10
---

API errors use the regular `ApiError` shape — `{code, message, reason?}`, where `code` is an `ErrorCode` value (for example, `ERROR_CODE_SSO_REQUIRED`). The full code table is in the [error reference](../reference/errors).

## Identity error codes

| HTTP | `code` / `reason` | Meaning | What to do |
|---|---|---|---|
| 403 | `SSO_REQUIRED` | A fresh SSO confirmation is needed: there is none, it's older than 1 hour, or it became invalid after a connection change | “Confirm corporate sign-in” or sign in with SSO |
| 403 | `RECENT_AUTH_REQUIRED` | A password confirmation is needed (sign-in within the last 5 minutes), or a fresh SSO to turn on required mode | “Confirm password”, then retry |
| 403 | `IDENTITY_SCOPE_DENIED` | A corporate session reached outside its workspace (DMs, notes, another workspace), or the action isn't available to this role | Sign in to the local account |
| 403 | `DIRECTORY_ACCESS_DENIED` | The directory closed access: the account is disabled, deleted, outside the allowed groups, or there's been no sync for over an hour | Check the AD account and the “Last successful sync” |
| 403 | `RECOVERY_ONLY` | A recovery session tried something other than repairing the policy | Change the policy; sign in normally for anything else |
| 403 | `FORBIDDEN`, “identity access denied” | Calab rejected the IdP's answer (see below), or a different account signed in | See “The connection test fails” |
| 409 | `CONFLICT`, `reason: "PLAN_LIMIT"` | The workspace has no Business/Enterprise plan for this feature | Change the plan |
| 409 | `IDENTITY_CONFIG_CHANGED` | The settings changed while you were editing them (stale `version`) | “Refresh” and retry |
| 409 | `IDENTITY_NOT_LINKED` | The IdP account isn't linked to any account in this workspace | Sign in to the local account and “Link corporate identity” |
| 409 | `CONFLICT`, `reason: "IDENTITY_NOT_CONFIGURED"` | The server has no `IDENTITY_*` variables | Contact the operator — see [for operators](./operators) |
| 429 | — | Too many sign-in, exchange or change attempts; `Retry-After` header | Wait |
| 503 | `IDENTITY_DEPENDENCY_UNAVAILABLE` | The database, IdP or directory is temporarily unavailable | Retry later; access returns on its own |

## The connection test fails

Calab doesn't reveal the exact reason an IdP answer was rejected to the browser — that guards against probing. Go through the list:

1. **Redirect URI.** The IdP has exactly `https://id.example.com/api/auth/sso/callback/<connection-id>` registered, with the current connection's ID. After an Issuer URL or Client ID change, the ID is new.
2. **Issuer.** The `issuer` field in `<issuer>/.well-known/openid-configuration` matches “Issuer URL” character for character, including a trailing `/` if there is one.
3. **`auth_time`.** The ID token contains `auth_time`. In Entra it's an optional claim (see [Entra](./oidc-entra)). Without it the server writes an `auth_time_missing` audit event.
4. **PKCE.** If discovery lists `code_challenge_methods_supported`, it includes `S256`. For AD FS the list is mandatory.
5. **Signature.** The ID token is signed with `RS256`.
6. **The same account.** The owner runs the test with the IdP account they linked to their own Calab account.
7. **Secret.** The secret is valid and not expired. For Entra — the Value, not the Secret ID.
8. **Time.** The IdP's clock is within 60 seconds of the Calab server.
9. **Network.** The IdP is reachable over public HTTPS, or the operator added all its URLs to `IDENTITY_ENDPOINTS`; the IdP doesn't answer discovery/JWKS/token with a redirect.

## “Activate” is disabled or rejected

- The connection hasn't been tested, or changed after the test — test again.
- More than 5 minutes passed since the test — test again and activate right away.
- Under required SSO there is no valid recovery kit — generate one.

## You can't turn on “Required SSO”

All of these at once: an active tested connection, the owner's linked identity, a fresh (≤ 5 minutes) password and SSO, a valid recovery kit, and “Recovery kit saved” checked. See [modes](./modes#turning-on-required-mode).

## An employee can't sign in with SSO

| Symptom | Cause |
|---|---|
| No “Sign in with SSO” button for the workspace | No active tested connection, the workspace is suspended, or there's no plan |
| “Not linked” after the IdP sign-in | The employee hasn't done “Link corporate identity” from their local account. A matching email doesn't link |
| Sign-in succeeded but the workspace is closed | The directory closed it (`DIRECTORY_ACCESS_DENIED`), or the member is banned/removed |
| “Sign-in expired. Start again.” | The IdP sign-in wasn't finished within 5 minutes, or the desktop ticket wasn't used within 60 seconds |
| A guest can't get in | Under required SSO guest access is closed — see [modes](./modes#guests) |

## Directory

| Symptom | Cause |
|---|---|
| Settings won't save | The host isn't in `IDENTITY_DIRECTORY_HOSTS` or not in its allowed networks; the URL isn't `ldaps://…:636`; an invalid DN; more than 100 groups |
| “Directory synchronization unavailable” | No connection, the certificate failed verification, a wrong bind password, more than 100,000 entries, or the scan didn't finish within 120 seconds |
| “Directory scan returned far fewer accounts than before…” | Quarantine: the snapshot is empty or sharply smaller. Check the service account's permissions; if the drop is real, save the settings again |
| All managed members lost access | Over an hour without a successful sync, or the settings were just saved and no sync has completed yet |
| A member is re-enabled in AD but has no access | A successful sync is needed, then a new SSO sign-in. The directory never lifts a manual ban |

## Where to find details

Every connection, policy, directory and recovery action is written to the server's audit log (for example, `connection_activated`, `policy_changed`, `directory_changed`, `recovery_session_issued`). On your own installation, the operator reviews it.
