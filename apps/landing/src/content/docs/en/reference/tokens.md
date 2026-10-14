---
title: Token formats
description: Every token and identifier integrations deal with — prefixes, length, lifetime and where each is accepted.
order: 5
---

Every Calab secret has its own recognisable prefix. That lets secret scanners (GitHub and others) find a leaked token, and lets your code tell one kind of token from another before calling the server. The server stores only hashes of secrets — a token can never be shown again.

## Summary

| Token | Format | Lifetime | Accepted by |
|---|---|---|---|
| Bot token | `calab_bot_<bot id>_<43 characters>` | until reissued or revoked | REST (`Authorization: Bearer`), the gateway (`IDENTIFY`, `RESUME`) |
| OAuth `client_id` | `calab_client_<43 characters>` | until the client is deleted | the `client_id` parameter; not a secret |
| OAuth client secret | `calab_os_<43 characters>` | no expiry; after rotation the previous one works for 10 minutes | the token endpoint (`client_secret_basic`) |
| Authorization code | `calab_oc_<43 characters>` | 1 minute, single use | the token endpoint |
| OAuth access token | `calab_oa_<43 characters>` | up to 5 minutes | the provider's `/userinfo` only |
| OAuth refresh token | `calab_or_<43 characters>` | 8 hours, 30 minutes unused; rotated | the token endpoint |
| ID token | JWT, RS256 | same as the access token | verified by your application against `jwks_uri` |
| LiveKit token | JWT | 10 minutes | the LiveKit server (`url` from `POST /api/rooms/{id}/join`) |

43 characters are 32 random bytes in unpadded base64url.

## Bot token

```text
calab_bot_0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b_Xq3v9aT2LmN8pR4sW7yZ1bC5dF0gH6jK3nQ9uV2xE8w
```

- The bot id is the bot user's UUID; the server finds the bot with a single lookup.
- The first 6 characters of the secret show in the bot's profile as `tokenPrefix`, to tell tokens apart.
- It travels only in the `Authorization: Bearer` header and in gateway frames. Never in a URL.
- Details: [Token and permissions](../bots/auth).

To check whether a string looks like a bot token, use this regular expression:

```text
^calab_bot_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$
```

## OAuth tokens

OAuth access and refresh tokens, codes and secrets are **opaque** — don't parse them. An OAuth access token doesn't work in the Calab REST API or the gateway: it opens only the workspace provider's `/userinfo`. Conversely, bot tokens and Calab app tokens are not accepted by the OAuth provider. Details: [OAuth: tokens and lifetimes](../oauth/tokens).

## App tokens

People in the Calab app have their own session access and refresh tokens. They are an internal mechanism of the app: integrations don't need them and should never get them. For programmatic access use a bot; to sign people in to your service use [OAuth](../oauth).

> [!DANGER]
> A bot token leaked? Use “Reissue token” in “Workspace settings → Bots” right away. An OAuth client secret leaked? Rotate it in the client settings — that revokes every grant the client holds.
