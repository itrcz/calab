---
title: Mailbox
description: Resetting a hosted mailbox password through a bot — check the mailbox is on the operator's hosting, then hand the person a one-time link with the new password.
order: 20.5
---

On Calab servers with mail hosting — the operator runs the company domain and the mailboxes — a bot recovers a person's mailbox password: the person asks, the bot asks Calab, Calab asks the hosting to set a new password, and the person gets a one-time link. The routes are open only to bots on the operator's list (`MAILHOST_RESET_BOTS`); on a server without mail hosting both answer `404`.

The bot never sees the address: `hosting-check` returns only the domain and flags. The bot never sees the new password either — it only gets the link; a one-time page shows the password, and the link lives 10 minutes.

## Routes

<!-- routes:mailbox -->
| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/mailbox/hosting-check` | Is the user's mailbox on the operator's hosting? → `{hosted, domain, verified}` |
| `POST` | `/api/mailbox/password-reset` | Have the hosting set a new password → `{token, redeemUrl, expiresAt}` |
| `POST` | `/api/mailbox/password/redeem` | public: the person's one-time page trades the token for `{email, password}` |
<!-- /routes -->

## Check the mailbox

`POST /api/mailbox/hosting-check {userId}` — about any user of the server, no shared workspace required. The answer:

```json
{ "hosted": true, "domain": "calab.io", "verified": true }
```

| Field | Meaning |
|---|---|
| `hosted` | the address is on the operator's hosting domains (`MAILHOST_DOMAINS`) |
| `domain` | the domain of the address — the domain, not the address itself |
| `verified` | the account's email is confirmed; without this the reset answers `403` |

```sh tab="curl"
curl -s -X POST $CALAB/api/mailbox/hosting-check -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"userId\": \"$USER\"}"
# → {"hosted": true, "domain": "calab.io", "verified": true}
```

## Reset the password

`POST /api/mailbox/password-reset {userId}` runs its checks in order and only then calls the hosting:

| Situation | Answer |
|---|---|
| the bot is not on the operator's list | `403 FORBIDDEN` |
| no such user | `404 NOT_FOUND` |
| the target is a guest or a bot | `403 FORBIDDEN` |
| no shared workspace with the target | `403 FORBIDDEN` |
| the target's email is not confirmed | `403 ERROR_CODE_EMAIL_NOT_VERIFIED` |
| the address domain is not hosted | `422 ERROR_CODE_VALIDATION`, `field: "domain"`, `reason: "DOMAIN_NOT_HOSTED"` |
| reset limit | `429` + `Retry-After` |
| no such mailbox on the hosting | `404 NOT_FOUND` |
| hosting is down or the admin token is bad | `503 ERROR_CODE_UNAVAILABLE` — retry later |

The answer is `{token, redeemUrl, expiresAt}`: the server has already set the new password on the hosting and hidden it under a one-time token for 10 minutes. Send `redeemUrl` to the person — for example, in a [direct message](./rest-dm).

```sh tab="curl"
curl -s -X POST $CALAB/api/mailbox/password-reset -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"userId\": \"$USER\"}"
# → {"token": "kQ…", "redeemUrl": "https://app.example.com/mail-reset/kQ…", "expiresAt": "2026-10-15T12:10:00Z"}
```

```js tab="JavaScript"
const r = await fetch(`${CALAB}/api/mailbox/password-reset`, {
  method: 'POST', headers: H, body: JSON.stringify({ userId }),
});
if (!r.ok) throw new Error(`reset: ${r.status}`);
const { redeemUrl } = await r.json();
await bot.send(dm.room.id, `Your new mailbox password: ${redeemUrl}`);
```

```python tab="Python"
r = requests.post(f"{CALAB}/api/mailbox/password-reset", headers=H, json={"userId": user_id})
r.raise_for_status()
# send the link to the person, e.g. in a direct message
print(r.json()["redeemUrl"])
```

## The person's page

`redeemUrl` points to `/mail-reset/<token>`. The page itself makes the single anonymous `POST /api/mailbox/password/redeem {token}` — the server answers `{email, password}` and deletes the token in the same request. The person sees the address and the new password once: monospace, with «Copy» and «Open in Calab». Opening again or an expired link is `410 ERROR_CODE_CODE_EXPIRED`; the person asks the bot for a new one. The bot never needs this route: the page calls it.

## Limits

| Limit | Value |
|---|---|
| Resets for one person | 3 per hour |
| Resets by one bot | 10 per hour |
| The link | one per 10 minutes, single-use |

> [!NOTE]
> The audit log records who asked (the bot), for whom and when. Neither the address nor the password reaches the log or the database: the password lives only inside the one-time token until the link is first opened.
