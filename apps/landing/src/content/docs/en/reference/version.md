---
title: API version
description: How to find the server version, how REST, the gateway and webhooks are versioned, and what counts as a compatible change.
order: 6
---

## GET /api/version

A public route with no authentication: the server's build version and license information.

```sh tab="curl"
curl -s https://app.example.com/api/version
```

```python tab="Python"
import requests
print(requests.get("https://app.example.com/api/version").json()["version"])
```

```json
{
  "version": "3.3.0",
  "commit": "75c4474",
  "license": "BUSL-1.1",
  "commercialLicense": "…",
  "attribution": "…",
  "url": "…",
  "product": "Calab",
  "planContact": "…"
}
```

| Field | Meaning |
|---|---|
| `version` | the server's release version; `dev` for a local build |
| `commit` | the build's short git commit; `unknown` if not stamped |
| `license` | the license's SPDX id |
| `commercialLicense` | where to obtain a commercial license |
| `attribution` · `url` | the attribution text and link clients display |
| `product` | the product name shown to people |
| `planContact` | where to ask about a paid plan |

Compare `version` with the [API changelog](../bots/changelog) to see whether the server has the capability you need.

## How the API is versioned

| Interface | Version | Rule |
|---|---|---|
| REST `/api/…` | no version in the path | only grows: new routes, fields and enum values; existing ones keep their meaning |
| Gateway | `?v=1` in the URL | new events and fields are added without a version change; an incompatible change means a new protocol version |
| Bot webhook | — | the body is `BotWebhookUpdate`; it grows with the gateway's events |
| Board webhook | the `X-Calab-Webhook-Version: 1` header and the `version` field | fields are only added |
| OAuth / OIDC | the workspace's discovery document | the provider's capabilities are listed at `/.well-known/openid-configuration` |

## Writing a compatible client

- Skip unknown fields in responses and events — they appear without notice.
- Treat unknown enum values as “other”, not as an error.
- Don't rely on the order of JSON fields or on the `message` text of errors.
- Send only request fields you know: the server ignores unknown ones, so a typo in a field name won't cause an error — check the response.
- `uint64` numbers (file sizes, `seq`) arrive as strings — keep their precision.
