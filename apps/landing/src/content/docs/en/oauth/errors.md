---
title: Errors
description: Error codes of the OAuth endpoints and the client management API — what they mean and what to do.
order: 7
---

The provider has two kinds of errors:

- **Protocol errors** (`/authorize`, `/token`, `/userinfo`, `/revoke`, discovery, JWKS) use the standard OAuth shape: JSON `{"error": "<code>"}` or an `error` parameter on `redirect_uri`. There is no `error_description` — rely on the code and the HTTP status.
- **Calab app API errors** (`/api/workspaces/{workspace}/oauth/clients…`, `/api/me/oauth-grants…`, the consent screen) use Calab's usual `ApiError`: `{code, message, field?, reason?}`.

## Protocol errors

| `error` | HTTP | Where | Meaning and what to do |
|---|---|---|---|
| `invalid_request` | 400 | all | A parameter is missing or repeated, `client_id` / `redirect_uri` is wrong, `state` or `nonce` is missing, `code_challenge` is malformed, `/token` got a query string, a forbidden parameter was sent (`request`, `claims`, `id_token_hint`…). Fix the request. An unknown workspace in discovery/JWKS gives `404`. |
| `unsupported_response_type` | 303 → redirect | `/authorize` | `response_type` is not `code`. |
| `invalid_scope` | 303 → redirect / 400 | `/authorize`, `/token` | A scope outside `openid profile email`, no `openid`, or wider than the client allows; on refresh — an attempt to widen scopes. |
| `access_denied` | 303 → redirect | `/authorize` | The person clicked “Deny”, or the workspace has no Business / Enterprise plan, the provider is not enabled, or the workspace is suspended. |
| `login_required` | 303 → redirect | `/authorize` | With `prompt=none`: no Calab session, or the sign-in is too old for `max_age`. Start a normal sign-in. |
| `consent_required` | 303 → redirect | `/authorize` | With `prompt=none`: no consent, consent for fewer scopes, or the client was renamed. Start a sign-in without `prompt=none`. |
| `interaction_required` | 303 → redirect | `/authorize` | With `prompt=none`: a step needs the person (a corporate sign-in, for example). Start a normal sign-in. |
| `temporarily_unavailable` | 429 / 303 → redirect | all | A rate limit was hit (see `Retry-After`) or one IP has too many unfinished sign-ins. Retry later. |
| `server_error` | 503 / 303 → redirect | all | A temporary failure, or identity is not configured on this installation. Retry later; if it persists, contact the operator. |
| `invalid_client` | 401 | `/token`, `/revoke` | Unknown or disabled client, wrong secret, a secret in the body instead of `Authorization: Basic`, Basic on a public client. The response carries `WWW-Authenticate: Basic realm="oauth"`. |
| `invalid_grant` | 400 | `/token` | The code expired, was used or belongs to another client; `redirect_uri` or `code_verifier` does not match; the refresh token is invalid; access was revoked or the person's rights changed. Start a new sign-in. |
| `unsupported_grant_type` | 400 | `/token` | `grant_type` is neither `authorization_code` nor `refresh_token`. |
| `invalid_token` | 401 | `/userinfo` | The access token is wrong, expired or revoked. The response carries `WWW-Authenticate: Bearer error="invalid_token"`. |

`/authorize` errors reach your `redirect_uri` (with `state` and `iss`) only after Calab has validated `client_id` and `redirect_uri`. When that validation fails, `invalid_request` is shown in the browser instead.

A bot token at any OAuth endpoint gets `403 access_denied` (`401 invalid_token` at `/userinfo`).

### Rate limits

Before authentication, requests are counted per IP; after the client and the token are verified — per “client + user” pair.

| Endpoint | Per IP | Per client and user |
|---|---|---|
| `/token` | 120/min; public clients also 60/min per `client_id` and IP | 30/min |
| `/userinfo` | 600/min | 60/min |
| `/authorize` | 60/min | — |
| `/revoke` | 120/min | — |
| discovery, JWKS, preflight | 120/min | — |

Going over gives `429 temporarily_unavailable` with a `Retry-After` header (seconds).

## Management and consent API errors

The body is a Calab `ApiError` in protojson:

```json
{
  "code": "ERROR_CODE_RECENT_AUTH_REQUIRED",
  "message": "identity access denied"
}
```

| HTTP | `code` / `reason` | Meaning |
|---|---|---|
| 401 | `ERROR_CODE_UNAUTHENTICATED` | No session, or it is invalid. |
| 403 | `ERROR_CODE_RECENT_AUTH_REQUIRED` | “Confirm password” (within 5 minutes) or sign in locally again. |
| 403 | `ERROR_CODE_SSO_REQUIRED` | The workspace requires a fresh corporate sign-in — “Confirm corporate sign-in”. |
| 403 | `ERROR_CODE_IDENTITY_SCOPE_DENIED` | Not allowed: not an owner/admin, a guest, a bot, or an SSO session of another workspace. |
| 403 | `ERROR_CODE_DIRECTORY_ACCESS_DENIED` | The directory (AD) does not admit the member or has not synced for too long. |
| 403 | `ERROR_CODE_WORKSPACE_SUSPENDED` | The workspace is suspended. |
| 403 | `ERROR_CODE_RECOVERY_ONLY` | A recovery session: it can only repair the SSO policy. |
| 404 | `ERROR_CODE_NOT_FOUND` | The client or grant does not exist. |
| 409 | `ERROR_CODE_CONFLICT`, `reason: "PLAN_LIMIT"` | No Business / Enterprise plan, 20 active clients, or two valid secrets already. |
| 409 | `ERROR_CODE_CONFLICT`, `reason: "IDENTITY_CONFIG_CHANGED"` | The client changed since you read it (stale `version`) or was renamed during consent. Reload and retry. |
| 409 | `ERROR_CODE_CONFLICT`, `reason: "IDENTITY_NOT_CONFIGURED"` | The operator has not configured identity on this installation. |
| 422 | `ERROR_CODE_VALIDATION` | Invalid client fields: name, redirect URIs, origins, scopes, type. |
| 503 | `ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE` | A dependency (database, directory) is temporarily unavailable. Retry later. |

The full list of Calab codes is in the [error reference](../reference/errors).
