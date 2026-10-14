---
title: Token and permissions
description: The bot token format, how to send, reissue and revoke it; how bot permissions work and what is always closed to bots.
order: 3
---

## The token

A bot token looks like this:

```text
calab_bot_0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b_Xq3v9aT2LmN8pR4sW7yZ1bC5dF0gH6jK3nQ9uV2xE8w
└──┬────┘ └───────────────┬──────────────────┘ └────────────────┬────────────────────┘
  prefix           bot id (UUID)                    secret: 43 base64url characters
```

- The `calab_bot_` prefix lets secret scanners (GitHub and others) recognise a leaked token.
- The server stores only a `sha256` hash of the secret, so a token can never be shown again. The bot's profile shows the first 6 characters of the secret (`tokenPrefix`) to tell tokens apart.
- A token doesn't expire on its own: it works until it is reissued or revoked.

### How to send it

| Where | How |
|---|---|
| REST | the `Authorization: Bearer <token>` header |
| Gateway | the `token` field of the `IDENTIFY` (or `RESUME`) frame |

**Never** put the token in a URL, a query string or a webhook body — only in those two places.

```sh
curl -s https://app.example.com/api/me -H "Authorization: Bearer $TOKEN"
```

### Reissue and revoke

In “Workspace settings → Bots”, the bot's owner or a member with `MANAGE_BOTS` in the bot's home workspace can:

- **“Reissue token”** — get a new token; the old one stops working immediately.
- **“Revoke token”** — switch the bot off without a new token, until it is reissued.
- **“Delete bot”** — the bot leaves every workspace and call; its messages stay.

What happens to the old token:

| Channel | Result |
|---|---|
| REST | `401 UNAUTHENTICATED` |
| Gateway | the socket closes with `4010`; don't reconnect |
| Voice | the bot leaves its calls |

> [!NOTE]
> Token checks are cached for at most 30 seconds, but reissuing or revoking drops the cache — the old token stops working at once.

### One token, one process

A token is one gateway “device”. A second process with the same token pushes the first one out: the first socket closes with `4000` and the reason `replaced by a new session`. Run one process per token. To scale processing, use a [webhook](./webhooks) with idempotent handling by `id`, or several bots.

## Permissions

A bot is a workspace member, and its permissions are computed exactly like a person's: workspace roles plus overrides on a room or a board.

- **By default** a bot gets the member role: it sees open rooms, writes in them and joins voice.
- **Need more?** Give the bot a role with the permissions it needs: `MANAGE_MESSAGES` for moderation, `CREATE_TASKS` / `EDIT_TASKS` for boards, `INVITE_MEMBERS` for invites, and so on.
- **Need less?** Deny the permission with a room override.
- **Restricted rooms and boards** are visible to a bot only through an override on the object itself — personal or by role, as for people. Otherwise the answer is `404`.

Every REST chapter lists the permissions its routes need. Without one the server answers `403 FORBIDDEN`, and `message` names the missing permission.

### A bot with admin permissions is an admin

A bot token whose roles grant `MANAGE_*`, `INVITE_*` or `VIEW_JOURNALS` acts as an admin with those permissions. Keep such a token like an admin's password and reissue it at the slightest doubt. The role editor warns when admin permissions go to a role that bots hold. The server logs every administrative bot action — the route, the response status, the bot and its owner.

### A bot in several workspaces

A bot is created in one — **home** — workspace, where it is managed (token, deletion). An admin of another workspace can add the bot: “Workspace settings → Bots → Add a bot from another workspace” by its `username`, or through the `/bots/<username>` link. In each workspace the bot's permissions are its own, by its roles there.

### Blocking by people

A person can “Block bot” — the bot then can't write to them in direct messages: new DMs and messages in an existing DM get `403 BOT_BLOCKED`.

## Always closed to bots

These routes answer a bot with `403 FORBIDDEN` and `reason: "BOT_NOT_ALLOWED"` — whatever its roles:

| Area | What exactly |
|---|---|
| Billing | balance, payments, payment methods, auto top-up, changing and stopping a plan |
| Identity | SSO and directory settings, OAuth clients, the OAuth provider (`/oidc/…`), OAuth grants, reauthentication |
| Bot management | creating, adding and deleting bots, their tokens and avatars — even with `MANAGE_BOTS` |
| Account | sessions, password, email, email verification, status, choosing a username, notes about people, bot blocks |
| Workspaces | creating, discovering, deleting, joining by invite, notification settings |
| Invites | looking an account up by address and adding an account directly (invite links and email invites are open) |
| Rooms | guest links, notification settings, waiting for admission as a guest |
| Voice | one-to-one calls (call, accept, decline) |
| Notes | notes shelves entirely |
| Push | device registration and everything push |
| Tasks | voting in approvals, board access, purging a board, the board webhook, changing automations, Git links |
| Messages | pressing buttons under messages (that is a person's action) |
| Calendar | answering invitations (RSVP), “today”, CalDAV and external calendars |
| Other | Disk, camera backgrounds, workspace web apps, telephony settings and journal, recording transcription settings, granting achievements, the birthday table and setting birthdays, deleting and re-uploading recordings, link previews, superadmin |

The exact route list is in [Bot routes](../reference/routes).

## Good practice

- Keep the token in a secret store (Vault, CI environment variables), not in code.
- Give the bot the least it needs: a dedicated role for the job beats an admin role.
- Use a separate bot for admin jobs, so a token with broad permissions lives in fewer processes.
- Keep the webhook secret apart from the token and verify the signature of every delivery — see [Webhooks](./webhooks).
