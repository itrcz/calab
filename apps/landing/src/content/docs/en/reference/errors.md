---
title: Error codes
description: Every ErrorCode value of the REST API with its HTTP status, common reason values, and where to find OAuth and SSO errors.
order: 3
---

Every non-`2xx` REST response carries an `ApiError { code, message, field?, reason?, used?, limit? }` body. Branch on `code` and `reason`; `message` is for logs only. How to handle errors in a bot: [Errors and limits](../bots/errors-limits).

OAuth protocol errors (`invalid_grant`, `invalid_client` and others) use the RFC 6749 format — see [OAuth: errors](../oauth/errors). SSO sign-in errors: [SSO: troubleshooting](../sso/troubleshooting).

## ErrorCode

| `code` | HTTP | Meaning |
|---|---|---|
| `ERROR_CODE_INTERNAL` | 500 | an internal server error |
| `ERROR_CODE_BAD_REQUEST` | 400 | a malformed body or request parameters |
| `ERROR_CODE_VALIDATION` | 422 | a well-formed request with an invalid field value; `field` says which |
| `ERROR_CODE_UNAUTHENTICATED` | 401 | no token, or it is wrong, expired or revoked |
| `ERROR_CODE_FORBIDDEN` | 403 | authenticated, but a permission is missing; `reason: "BOT_NOT_ALLOWED"` — a route for people only |
| `ERROR_CODE_NOT_FOUND` | 404 | no such object — or it is hidden from the caller |
| `ERROR_CODE_CONFLICT` | 409 | a conflict: uniqueness, a limit, a state; details in `reason` |
| `ERROR_CODE_RATE_LIMITED` | 429 | a rate limit; the `Retry-After` header says how many seconds to wait |
| `ERROR_CODE_INVALID_CREDENTIALS` | 401 | sign-in failed |
| `ERROR_CODE_INVALID_REFRESH_TOKEN` | 401 | the refresh token is unknown, expired or reused |
| `ERROR_CODE_REGISTRATION_CLOSED` | 403 | registration is by invitation only |
| `ERROR_CODE_INVITE_INVALID` | 404 / 410 | the invite is unknown, expired or used up |
| `ERROR_CODE_FILE_TOO_LARGE` | 413 | the file is too large |
| `ERROR_CODE_FILE_QUOTA_EXCEEDED` | 413 | the workspace storage quota is used up (`used` / `limit` in bytes) |
| `ERROR_CODE_PAYLOAD_TOO_LARGE` | 413 | the request body is too large |
| `ERROR_CODE_UNAVAILABLE` | 503 | a temporary failure — retry later |
| `ERROR_CODE_ROOM_FULL` | 409 | the voice room is full (`used` / `limit`) |
| `ERROR_CODE_WORKSPACE_LIMIT` | 409 | the per-owner workspace limit is reached |
| `ERROR_CODE_STORAGE_FULL` | 507 | the whole server's storage is full |
| `ERROR_CODE_EMAIL_NOT_VERIFIED` | 403 | the account's email is not verified |
| `ERROR_CODE_CODE_INVALID` · `ERROR_CODE_CODE_EXPIRED` | 422 | a wrong or expired email code |
| `ERROR_CODE_NOT_PAIRED` | 409 | recording transcription isn't connected in the workspace |
| `ERROR_CODE_ALREADY_RECORDING` | 409 | the room is already being recorded |
| `ERROR_CODE_RECORDING_LIMIT` | 409 | the server runs its maximum of concurrent recordings |
| `ERROR_CODE_WORKSPACE_SUSPENDED` | 403 | the workspace is suspended: writing is refused, reading works |
| `ERROR_CODE_BANNED` | 403 | the caller is banned from the workspace |
| `ERROR_CODE_INVITE_EMAIL_MISMATCH` | 403 | the invitation was sent to another address |
| `ERROR_CODE_FILE_GONE` · `ERROR_CODE_ALREADY_UPLOADED` | 409 | a recording can't be re-uploaded |
| `ERROR_CODE_BOT_BLOCKED` | 403 | the person blocked the bot |
| `ERROR_CODE_BUSY` · `ERROR_CODE_IN_CALL` · `ERROR_CODE_CALL_NOT_ACTIVE` | 409 | one-to-one calls (not for bots) |
| `ERROR_CODE_SESSION_REVOKED` | 401 | a person's session was ended; `reason` says why |
| `ERROR_CODE_EVENT_OVER` | 410 | a meeting answer link after the meeting ended |
| `ERROR_CODE_INVITE_NOT_YET_VALID` | 409 | a meeting's guest link isn't valid yet |
| `ERROR_CODE_NO_COMMON_HOURS` | 409 | people's working hours don't overlap in the search window |
| `ERROR_CODE_TEMP_ROOM_LIMIT` | 409 | the temporary room cap (20 per workspace, or 5 per creator with `reason: "PER_USER"`) |
| `ERROR_CODE_ROOM_ARCHIVED` | 410 | an archived temporary room: reading works, writing doesn't |
| `ERROR_CODE_SIP_DISABLED` | 409 | telephony is off in the workspace |
| `ERROR_CODE_SIP_CALL_ACTIVE` | 409 | the room already has a phone call |
| `ERROR_CODE_SIP_NUMBER_NOT_ALLOWED` | 422 | the number is outside the allowed prefixes (`field: "number"`) |
| `ERROR_CODE_SIP_RATE_LIMITED` | 429 | 20 calls per hour per workspace |
| `ERROR_CODE_SIP_PROVIDER_ERROR` | 502 | the telephony provider refused the settings |
| `ERROR_CODE_SSO_REQUIRED` | 403 | the workspace requires SSO sign-in |
| `ERROR_CODE_IDENTITY_SCOPE_DENIED` | 403 | the session doesn't grant access to this workspace |
| `ERROR_CODE_DIRECTORY_ACCESS_DENIED` | 403 | the directory has cut the member's access |
| `ERROR_CODE_RECOVERY_ONLY` | 403 | a recovery session: only SSO recovery actions are allowed |
| `ERROR_CODE_IDENTITY_CONFIG_CHANGED` | 409 | the identity settings changed — reload and retry |
| `ERROR_CODE_IDENTITY_NOT_LINKED` | 409 | the account isn't linked to a corporate identity |
| `ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE` | 503 | the SSO provider or the directory is unreachable |
| `ERROR_CODE_RECENT_AUTH_REQUIRED` | 403 | reauthentication needed — see [SSO: reauthentication](../sso/reauth) |
| `ERROR_CODE_USERNAME_TAKEN` | 409 | the nickname is taken |
| `ERROR_CODE_USERNAME_INVALID` | 422 | an invalid or reserved nickname |

> [!NOTE]
> Branch on `code`, not on the HTTP status: one status covers many different causes.

## Common reason values

| `reason` | With `code` | Meaning |
|---|---|---|
| `BOT_NOT_ALLOWED` | `FORBIDDEN` | a route for people only |
| `PLAN_LIMIT` | `CONFLICT`, `ROOM_FULL`, `FILE_QUOTA_EXCEEDED` | a plan limit; `used` / `limit` |
| `PLAN_LIMITS_EXCEEDED` | `CONFLICT` | a plan change was refused: the workspace uses more than the new plan allows |
| `REACTION_LIMIT` | `CONFLICT` | at most 3 different reactions per member per message |
| `FEATURE_DISABLED` | `CONFLICT` | a board feature is off; `field` names the field |
| `CHECKLIST_LIMIT` · `CHECKLIST_ITEM_LIMIT` · `BOARD_CATEGORY_LIMIT` | `CONFLICT` | 10 checklists per task · 100 items per checklist · 50 board categories |
| `TASK_MILESTONE_LIMIT` · `TASK_MILESTONE_AUTO` | `CONFLICT` | 20 milestones per task · the server computes the milestone's completion |
| `KEYBOARD_STALE` · `BUTTON_UNAVAILABLE` | `CONFLICT` | the message keyboard changed · the button is unavailable |
| `FORM_CHANGED` · `NONCE_CONFLICT` · `FORM_TARGET_UNAVAILABLE` | `CONFLICT` | the form changed · the `nonce` was used for other content · the form's status was removed |
| `OWNER_ONLY` | `FORBIDDEN` | the workspace owner only |
| `MESSAGE_NOT_EDITABLE` · `NOT_FORWARDABLE` | `VALIDATION` | a forwarded copy can't be edited · this message can't be forwarded |
| `TASK_NOTIFY_BOT_UNAVAILABLE` | `VALIDATION` | the bot chosen for notifications is unavailable |
| `IDENTITY_NOT_CONFIGURED` | `CONFLICT` | identity (SSO, directory, OAuth provider) isn't configured on the server |
| `ADMISSION_DECLINED` · `ADMISSION_QUEUE_FULL` | `RATE_LIMITED` | the guest was declined recently · 50 guests are already waiting |
