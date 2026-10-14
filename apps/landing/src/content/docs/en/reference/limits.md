---
title: Limits
description: Rate limits for bots and integrations, message and frame sizes, plan limits and token lifetimes.
order: 4
---

Hitting a rate limit returns `429 ERROR_CODE_RATE_LIMITED` with a `Retry-After` header (seconds); a plan limit returns `409` with `reason: "PLAN_LIMIT"` and the `used` / `limit` fields. The values below are those of Calab cloud and the default settings; on a self-hosted server the operator can change them.

## Bot request rates

| What | Limit |
|---|---|
| All bot requests | 30 per second, burst 30 (`BOT_RATE_PER_SEC`) |
| Bot messages | 20 per minute across all rooms and DMs (`BOT_MESSAGES_PER_MIN`) |
| Messages to one room | 5 per 5 seconds — a common limit for everyone |
| New DMs | 10 at once, 30 per hour |
| File uploads | 30 at once, 120 per hour |
| Sticker uploads | 10 batches at once, 60 per hour |
| Email invitations | 20 at once, 30 per hour; one address at most once a day |
| Creating and editing meetings | 30 at once, 120 per hour |
| Sounds in a call | once per 2 s per bot, 5 per 10 s per room |
| Phone calls | 20 per hour per workspace |
| `TYPING` on the gateway | once per 3 s per room |

## Sizes

| What | Cap |
|---|---|
| Message text | 4000 characters |
| Attachments per message | 20 |
| `nonce` | 64 characters |
| History per request | `limit` ≤ 100 |
| Bot commands | 100; name ≤ 32, description ≤ 256 characters |
| Bot description | 512 characters; name 1–64 |
| Keyboard under a message | 5 rows × 5 buttons; `label` ≤ 80 characters, `data` ≤ 512 bytes, `allowedUserIds` ≤ 50 |
| Reactions | 3 different emoji per member per message |
| Sticker | WebP, sides ≤ 512, ≤ 512 KB (static) / ≤ 1 MB (animated); up to 50 per request, up to 120 per pack |
| Badge picture | PNG / WebP / JPEG ≤ 128 KB |
| Checklists | 10 per task, 100 items per checklist |
| Milestones inside a task | 20 per task |
| Board categories | 50 per workspace |
| Temporary rooms | 20 per workspace, 5 per creator |
| `SUBSCRIBE` | 100 rooms |

## Gateway

| What | Cap |
|---|---|
| Sockets per bot token | 1 |
| Inbound frame | 64 KiB |
| Send queue | 256 frames; overflow → `4008` |
| `TYPING` / `SUBSCRIBE` / `PRESENCE_UPDATE` | 10 in a row and 2 per second; extras are dropped |
| Flooding | more than 50 frames per second sustained → `4008` |
| Heartbeat | about 41 s; no heartbeat for 2 × the interval + 10 s → `4009` |
| `RESUME` buffer | about 5 minutes or 1000 events |

## Webhooks

| What | Value |
|---|---|
| Response | any `2xx` within 10 s |
| Retries | 1 min, 2, 4 … up to 1 hour between attempts |
| Delivery lifetime | one day |
| Disabling | after a day of failures in a row |
| Board webhook body | up to 256 KB |
| Board webhook test (`ping`) | once per 10 s |

## Plans

| Limit | Free | Team | Business |
|---|---|---|---|
| Workspace members (bots count, guests don't) | 50 | 100 | 500 |
| Bots | 1 | 5 | 20 |
| Boards | 3 | 30 | 50 |
| Forms per board | — | 5 | 20 |
| File storage | 5 GiB | 300 GiB | 1 TiB |
| People in a voice room | 5 | 15 | 50 |
| Sticker packs / stickers | 1 / 200 | no limit | no limit |
| Checklists | — | yes | yes |
| Board webhook, telephony | — | — | yes |
| Board automations | — | yes | yes |

On a self-hosted server (Enterprise) the operator sets the limits.

## Token lifetimes

| Token | Lifetime |
|---|---|
| Bot token | no expiry, until reissued or revoked |
| LiveKit token from `POST /api/rooms/{id}/join` | 10 minutes; connect within 15 s |
| OAuth access token | 5 minutes |
| OAuth authorization code | 1 minute |
| OAuth refresh token | 8 hours, or 30 minutes unused |

Details: [Token formats](./tokens) and [OAuth: tokens and lifetimes](../oauth/tokens).
