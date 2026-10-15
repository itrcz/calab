---
title: Errors and limits
description: The REST error format, common bot error codes and what to do about them, rate and plan limits, retries and idempotency.
order: 22
---

## Error format

Every non-`2xx` response carries an `ApiError` body:

```json
{
  "code": "ERROR_CODE_FORBIDDEN",
  "message": "not available for bots",
  "field": "",
  "reason": "BOT_NOT_ALLOWED"
}
```

| Field | Meaning |
|---|---|
| `code` | a code from the `ErrorCode` enum — branch on it |
| `message` | text for logs, not for parsing: the wording may change |
| `field` | the request field (lowerCamelCase) for `ERROR_CODE_VALIDATION` and some conflicts |
| `reason` | a refinement when a code has several causes: `BOT_NOT_ALLOWED`, `PLAN_LIMIT`, `FEATURE_DISABLED`… |
| `used` · `limit` | the counter and the cap, when the error is about a limit |

The full code list is in [Error codes](../reference/errors).

## Common bot errors

| HTTP | `code` / `reason` | Meaning | What to do |
|---|---|---|---|
| 400 | `ERROR_CODE_BAD_REQUEST` | malformed JSON or parameters | fix the request |
| 401 | `ERROR_CODE_UNAUTHENTICATED` | no token, or it is wrong, revoked or reissued | stop and get a new token |
| 403 | `ERROR_CODE_FORBIDDEN`, `reason: "BOT_NOT_ALLOWED"` | a route for people only | don't retry — see [what is closed to bots](./auth#always-closed-to-bots) |
| 403 | `ERROR_CODE_FORBIDDEN` | a missing permission; `message` names it | give the bot a role or an override |
| 403 | `ERROR_CODE_BOT_BLOCKED` | the person blocked the bot | stop writing to that person |
| 403 | `ERROR_CODE_WORKSPACE_SUSPENDED` | the workspace is suspended: writing is refused, reading works | wait until it is lifted |
| 404 | `ERROR_CODE_NOT_FOUND` | no such object — or it is hidden from the bot | check `VIEW_ROOM` / `VIEW_BOARD` and overrides |
| 409 | `ERROR_CODE_CONFLICT`, `reason: "PLAN_LIMIT"` | a plan limit (`used` / `limit`) | free up room or change the plan |
| 409 | `ERROR_CODE_CONFLICT`, `reason: "REACTION_LIMIT"` | at most 3 different reactions per member per message | remove a reaction |
| 409 | `ERROR_CODE_CONFLICT`, `reason: "FEATURE_DISABLED"` (`field`) | a board feature is off and the request sets its field | drop the field or turn the feature on |
| 409 | `ERROR_CODE_ROOM_FULL` | the voice room is full | wait |
| 413 | `ERROR_CODE_FILE_TOO_LARGE` · `…_FILE_QUOTA_EXCEEDED` · `…_PAYLOAD_TOO_LARGE` | size or quota | shrink the file |
| 422 | `ERROR_CODE_VALIDATION` (`field`) | an invalid field value | fix the field |
| 429 | `ERROR_CODE_RATE_LIMITED` + `Retry-After` | a rate limit | wait `Retry-After` seconds and retry with the same `nonce` |
| 503 | `ERROR_CODE_UNAVAILABLE` | a temporary failure | retry with backoff |

> [!NOTE]
> `404` instead of `403` is deliberate: the server doesn't reveal that an object exists if the bot may not see it. A restricted room without an override for the bot looks like it doesn't exist.

## Limits

| What | Value |
|---|---|
| Bot requests | 30 per second (burst 30) |
| Bot messages | 20 per minute across all rooms and DMs, plus the common 5 messages per 5 s per room |
| New DMs | 10 at once, 30 per hour |
| Mailbox password resets | 3 per hour per person, 10 per hour per bot |
| File uploads | 30 at once, 120 per hour; size and quota by plan |
| A message | up to 4000 characters, up to 20 attachments, `nonce` up to 64 characters |
| Commands | up to 100, name up to 32 characters, description up to 256 |
| Gateway | 1 socket per token, frames up to 64 KiB |
| Bots per workspace | by plan: Free 1, Team 5, Business 20; a bot also takes a member seat |

Requests per second and messages per minute are plenty for integrations but not for mass mailing. On a self-hosted server the operator can change the bot limits with `BOT_RATE_PER_SEC` and `BOT_MESSAGES_PER_MIN`. All limits: [Limits](../reference/limits).

## Retries and idempotency

- **`429`** — wait `Retry-After` seconds and retry. The SDK does this itself up to `maxRetries` times.
- **`5xx` and network drops** — retry with exponential backoff.
- **Messages** — send them with a `nonce`: a retry with the same `nonce` returns the message already created (`200`) instead of a duplicate.
- **Forms** — submit with a stable UUID `nonce`: identical submissions create one task.
- **Events** (gateway, webhook) may arrive twice — dedupe by delivery `id`, `seq` or press `id`.
- **`4xx`** other than `429` — don't retry without changing the request.

```js tab="JavaScript"
async function call(url, init, tries = 5) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, init);
    if (res.status !== 429 && res.status < 500) return res;
    if (i === tries - 1) return res;
    const wait = Number(res.headers.get('Retry-After')) || 2 ** i;
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}
```

```python tab="Python"
import time, requests

def call(method, url, tries=5, **kw):
    for i in range(tries):
        r = requests.request(method, url, **kw)
        if r.status_code != 429 and r.status_code < 500 or i == tries - 1:
            return r
        time.sleep(float(r.headers.get("Retry-After", 2 ** i)))
```

## FAQ

**The bot doesn't see a room or messages.** It lacks `VIEW_ROOM`: the room is private, restricted (only through an override on it), or the bot's role grants no access. Check the roles and the room's overrides.

**The bot doesn't answer `/cmd`.** Nobody registered the command, or several bots in the room did — write `/cmd@username`. Messages written by bots are never commands.

**Do I need the gateway if I have a webhook?** No. A webhook bot works through REST and the webhook and counts as online while it makes requests. Voice events, though, arrive only over the gateway.

**Two processes with one token?** No — the second pushes the first out. To scale, use a webhook with processing by `id`, or several bots.

**Does the bot hear itself in a call?** No: LiveKit never sends a participant its own tracks. The SDK skips the bot's own messages and reactions by default (`receiveOwn: true` turns them on).
