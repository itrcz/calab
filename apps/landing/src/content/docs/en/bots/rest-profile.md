---
title: Bot profile
description: The bot's account and profile — name, avatar, description, command list, webhook and command hints in a room.
order: 16
---

A bot is a user with the `isBot` flag. Of the account settings it can change only its name, avatar and description (“about”); everything else — password, email, status, time zone, notifications — exists for people only. The `/api/bots/me…` routes are for bots only: they accept nothing but a bot token.

## Routes

<!-- routes:profile -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/me` | The bot's account: `{me: {user: {…, isBot: true}, …}}` |
| `PATCH` | `/api/me` | Only `displayName` and `avatarFileId` (`""` removes the avatar) |
| `POST` | `/api/me/avatar` | Upload an avatar (multipart `file`) |
| `GET` | `/api/bots/me` | The bot's profile: `username`, description, commands, webhook state → `{bot}` |
| `PATCH` | `/api/bots/me` | Change `{displayName?, description?}` → `{bot}` |
| `PUT` | `/api/bots/me/commands` | Replace the command list, see [Commands and buttons](./commands-buttons) |
| `GET` | `/api/bots/me/webhook` | The bot webhook's state, see [Webhooks](./webhooks) |
| `PUT` | `/api/bots/me/webhook` | Enable the webhook `{url, secret}` |
| `DELETE` | `/api/bots/me/webhook` | Disable the webhook → `204` |
| `GET` | `/api/rooms/{id}/bot-commands` | Commands of the room's bots (hints on `/`) → `{bots}` (`VIEW_ROOM`) |
<!-- /routes -->

### Not available to bots

- Password, email, email verification, sessions, status, username availability: `PATCH /api/me/password`, `PATCH /api/me/email`, `POST /api/auth/verify…`, `/api/me/sessions…`, `PATCH /api/me/status`, `GET /api/usernames/{name}/available`.
- `PATCH /api/me` fields other than name and avatar (`statusText`, `settings`, `timezone`, `locale`, `birthday`, `phone`, `username`, notification settings) — `403 BOT_NOT_ALLOWED`.
- Push notifications: `/api/me/push-capabilities`, `/api/me/push-devices…`, `/api/me/push-resolve`.
- Bot management — creating, tokens, deleting, the avatar from the “Bots” settings, the `GET /api/bots/{ref}` card: `/api/workspaces/{id}/bots…`. People do this — the bot's owner or a role with `MANAGE_BOTS`; `MANAGE_BOTS` on the bot's own role changes nothing.

## Profile

`Bot`:

| Field | Description |
|---|---|
| `user` | The bot's account (`isBot: true`); `user.username` is the bot's `username` |
| `username` | Unique `[a-z0-9_]{3,32}`: command addressing `/cmd@username`, the link `/bots/<username>` |
| `ownerUserId` | The bot's owner |
| `workspaceId` | The home workspace: where the bot was created and is managed |
| `description` | “About”, ≤ 512 characters |
| `commands` | Registered commands |
| `tokenPrefix` | The first characters of the current token's secret, to tell tokens apart; the token itself is never shown again. Empty — the token was revoked |
| `createdAt`, `revokedAt` | Creation; revocation |
| `webhook` | The webhook's state |

```sh tab="curl"
curl -s $CALAB/api/bots/me -H "Authorization: Bearer $TOKEN"
```

```js tab="JavaScript"
const profile = await bot.fetchMe();
await bot.updateProfile({ displayName: 'On-call', description: 'Reminds about on-call shifts and task due dates' });
```

```python tab="Python"
r = requests.patch(f"{CALAB}/api/bots/me", headers=H,
                   json={"displayName": "On-call", "description": "Reminds about on-call shifts and task due dates"})
```

```json
{
  "bot": {
    "user": {"id": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b", "displayName": "On-call", "isBot": true, "username": "duty"},
    "username": "duty",
    "ownerUserId": "0191c2d3-0000-7000-8000-000000000042",
    "workspaceId": "0191f0aa-0000-7000-8000-000000000001",
    "description": "Reminds about on-call shifts and task due dates",
    "commands": [{"name": "duty", "description": "Who is on call today"}],
    "tokenPrefix": "Xq3v9a",
    "createdAt": "2026-09-27T10:00:00Z",
    "webhook": {"url": "", "enabled": false}
  }
}
```

`displayName` is 1..64 characters.

## Avatar

```sh tab="curl"
curl -s -X POST $CALAB/api/me/avatar -H "Authorization: Bearer $TOKEN" -F file=@avatar.png
```

```python tab="Python"
with open("avatar.png", "rb") as f:
    requests.post(f"{CALAB}/api/me/avatar", headers=H, files={"file": ("avatar.png", f, "image/png")})
```

People can change the bot's avatar too — its owner or a role with `MANAGE_BOTS` in the bot's home workspace, in the “Bots” settings.

## Command hints in a room

`GET /api/rooms/{id}/bot-commands` → `{bots: [{botUserId, username, commands}]}` — the commands of every bot in the room; this is how the app suggests commands when you type `/`. A bot can use it to avoid clashing with its neighbours' commands.

> [!NOTE]
> A bot can be a member of several workspaces: an admin of another workspace adds it through the `/bots/<username>` link. Its token, deletion and avatar are managed only in the home workspace.
