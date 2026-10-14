---
title: Workspace and members
description: The bot's workspaces, members and their profiles, nicknames, roles, bans, badges, achievements, birthdays and invites.
order: 6
---

A bot is a member of a workspace with the member role; roles give it more permissions, exactly as for a person. Through these routes a bot reads who is in the workspace and their profiles, and with admin permissions it renames members, assigns roles, gives badges, bans and invites new people.

| Action | Permission |
|---|---|
| workspaces, members, a member's profile, roles, badges, achievements | workspace member |
| change workspace settings | `MANAGE_WORKSPACE` |
| a member's nickname, give / take a badge | `MANAGE_NICKNAMES` |
| remove a member, ban, promote a guest to member, built-in role, the badge library | `MANAGE_MEMBERS` |
| assign roles to a member | `MANAGE_MEMBERS` or `MANAGE_ROLES` (only roles below your own) |
| create, change, delete roles, role order | `MANAGE_ROLES` |
| invite links and email invites | `INVITE_MEMBERS` |

## Routes

<!-- routes:members -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/workspaces` | The bot's workspaces → `{workspaces}` |
| `GET` | `/api/workspaces/{id}` | One workspace → `{workspace}` |
| `PATCH` | `/api/workspaces/{id}` | Change the name, address, media settings (`MANAGE_WORKSPACE`) |
| `GET` | `/api/workspaces/{id}/members` | Members → `{members}` |
| `GET` | `/api/workspaces/{id}/members/{userId}` | A member's profile and open tasks → `{member, openTasks}` (`@me` = the bot) |
| `PATCH` | `/api/workspaces/{id}/members/{userId}` | Nickname `{nickname}` (`MANAGE_NICKNAMES`) or built-in role `{role}` (`MANAGE_MEMBERS`) |
| `DELETE` | `/api/workspaces/{id}/members/{userId}` | Remove a member from the workspace (`MANAGE_MEMBERS`) |
| `POST` | `/api/workspaces/{id}/members/{userId}/promote` | Promote a guest to member (`MANAGE_MEMBERS`) |
| `PUT` | `/api/workspaces/{id}/members/{userId}/roles` | A member's roles `{roleIds}` |
| `GET` | `/api/workspaces/{id}/roles` | Workspace roles → `{roles}` |
| `POST` | `/api/workspaces/{id}/roles` | Create a role `{name, color, permissions, mentionable}` (`MANAGE_ROLES`) |
| `PATCH` | `/api/workspaces/{id}/roles/{roleId}` | Change a role (`MANAGE_ROLES`) |
| `DELETE` | `/api/workspaces/{id}/roles/{roleId}` | Delete a role (`MANAGE_ROLES`) |
| `PUT` | `/api/workspaces/{id}/roles/order` | Role order (`MANAGE_ROLES`) |
| `GET` | `/api/workspaces/{id}/bans` | Bans → `{bans}` (`MANAGE_MEMBERS`) |
| `POST` | `/api/workspaces/{id}/bans` | Ban `{userId, reason}` (`MANAGE_MEMBERS`) |
| `DELETE` | `/api/workspaces/{id}/bans/{userId}` | Lift a ban (`MANAGE_MEMBERS`) |
| `GET` | `/api/workspaces/{id}/badges` | The badge library → `{badges}` |
| `POST` | `/api/workspaces/{id}/badges` | Create a badge `{name, fileId}` (`MANAGE_MEMBERS`) |
| `PATCH` | `/api/workspaces/{id}/badges/{badgeId}` | Change a badge (`MANAGE_MEMBERS`) |
| `DELETE` | `/api/workspaces/{id}/badges/{badgeId}` | Delete a badge (`MANAGE_MEMBERS`) |
| `PUT` | `/api/workspaces/{id}/members/{userId}/badge` | Give a badge `{badgeId}`; `""` takes it away (`MANAGE_NICKNAMES`) |
| `GET` | `/api/workspaces/{id}/achievements` | The workspace's achievement catalog → `{achievements}` |
| `GET` | `/api/workspaces/{id}/members/{userId}/achievements` | A member's achievements → `{items}` |
| `GET` | `/api/workspaces/{id}/birthdays` | Upcoming birthdays `?days=` (1..31, default 7) → `{birthdays}` |
| `GET` | `/api/workspaces/{id}/invites` | Invite links → `{invites}` (`INVITE_MEMBERS`) |
| `POST` | `/api/workspaces/{id}/invites` | Create a link `{maxUses, expiresInSeconds}` (`INVITE_MEMBERS`) |
| `DELETE` | `/api/workspaces/{id}/invites/{inviteId}` | Delete a link (`INVITE_MEMBERS`) |
| `GET` | `/api/workspaces/{id}/invites/email` | Email invites → `{invites}` (`INVITE_MEMBERS`) |
| `POST` | `/api/workspaces/{id}/invites/email` | Invite an address `{email, role?}` (`INVITE_MEMBERS`) |
| `DELETE` | `/api/workspaces/{id}/invites/email/{inviteId}` | Revoke an email invite (`INVITE_MEMBERS`) |
<!-- /routes -->

### Not available to bots

- Creating or deleting a workspace, discovering and joining open workspaces: `POST /api/workspaces`, `DELETE /api/workspaces/{id}`, `GET /api/workspaces/discover`, `POST /api/workspaces/{id}/join`, `POST /api/invites/{code}/join`.
- Looking an account up by address and adding an account without its consent: `POST /api/workspaces/{id}/invites/lookup`, `POST /api/workspaces/{id}/members`.
- The table of all members' birthdays and setting a birthday: `GET /api/workspaces/{id}/members/birthdays`, `PATCH /api/workspaces/{id}/members/{userId}/birthday`.
- The achievement catalog and granting are for people: `POST /api/workspaces/{id}/achievements`, `PATCH · DELETE /api/achievements/{id}`, `POST /api/workspaces/{id}/members/{userId}/achievements`, `DELETE …/achievements/{grantId}`.
- Workspace notifications (`PUT /api/workspaces/{id}/notifications`), workspace web apps (`/api/workspaces/{id}/apps`, `/api/workspace-apps/…`), private notes about users (`/api/users/{id}/note`).
- Billing, bot management, sign-in settings (SSO, directory, OAuth clients) — see [Errors and limits](./errors-limits).

## Members

`GET /api/workspaces/{id}/members` returns `WorkspaceMember` items: `user`, `role` (the built-in role, e.g. `WORKSPACE_ROLE_MEMBER`), `nickname`, `joinedAt`, `roleIds`, `badgeId`, `achievementCount`. Bots have `user.isBot = true`; `user.username` is the global nickname (a bot's is its `username`).

> [!NOTE]
> Bots never receive people's email addresses or phone numbers — not over REST, the gateway or webhooks.

```sh tab="curl"
curl -s $CALAB/api/workspaces -H "Authorization: Bearer $TOKEN"
curl -s $CALAB/api/workspaces/$WS/members -H "Authorization: Bearer $TOKEN"
```

```js tab="JavaScript"
const workspaces = await bot.workspaces();
const members = await bot.members(roomId);   // members of this room's workspace
```

```json
{
  "members": [
    {
      "workspaceId": "0191f0aa-0000-7000-8000-000000000001",
      "user": {"id": "0191c2d3-0000-7000-8000-000000000042", "displayName": "Anna", "isBot": false, "username": "anna", "timezone": "Europe/London"},
      "role": "WORKSPACE_ROLE_MEMBER",
      "nickname": "Anna (sales)",
      "joinedAt": "2026-06-01T09:00:00Z",
      "roleIds": ["0191f0aa-0000-7000-8000-0000000000e1"],
      "badgeId": "",
      "achievementCount": 2
    }
  ]
}
```

### A member's profile

`GET /api/workspaces/{id}/members/{userId}` (`@me` = the bot) → `{member, openTasks}`: name, nickname, roles, badge, status, time zone, birthday (a hidden one is not sent) and the open tasks the person is assigned to — only from boards the bot sees (≤ 50).

```js tab="JavaScript"
const { member, openTasks } = await bot.members.get(wsId, userId);
await bot.members.setNickname(wsId, userId, 'Bob (sales)');   // '' clears it
```

```sh tab="curl"
curl -s $CALAB/api/workspaces/$WS/members/$USER -H "Authorization: Bearer $TOKEN"
# {"member": {…}, "openTasks": [{"key": "FNG-12", "title": "Report", …}]}
curl -s -X PATCH $CALAB/api/workspaces/$WS/members/$USER -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"nickname": "Bob (sales)"}'      # → {"member": {…}}
```

## Badges

A badge is a picture next to a member's name (`WorkspaceMember.badgeId` points into the library). The picture is the bot's own upload to this workspace: PNG, WebP or JPEG up to 128 KB. A badge can be given only to a person (not a bot) whose top role is below the bot's top role.

```js tab="JavaScript"
import { readFile } from 'node:fs/promises';

const badge = await bot.badges.create(wsId, 'Mentor', { name: 'mentor.webp', data: await readFile('mentor.webp') });
await bot.badges.set(wsId, userId, badge.id);   // '' takes it away
```

```sh tab="curl"
curl -s -X PUT $CALAB/api/workspaces/$WS/members/$USER/badge -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"badgeId\": \"$BADGE\"}"
```

There are also `bot.badges.list`, `bot.badges.update` and `bot.badges.delete`.

## Achievements

A bot reads the catalog (`GET …/achievements`: archived ones carry `archivedAt`; the response has an `ETag`; the 512×512 WebP picture is `GET /api/files/{fileId}`) and a member's live achievements: `{items: [{id, achievementId, note, grantedBy, grantedAt, messageId, roomId}]}`, newest first. Only people grant and revoke achievements.

## Birthdays

`GET /api/workspaces/{id}/birthdays?days=7` lists members whose birthday falls within the next `days` days (1..31, default 7), soonest first: `{birthdays: [{userId, birthday: {day, month, year?}, inDays}]}` (`inDays: 0` means today). Hidden birthdays and bots are left out. Handy for a congratulations bot.

## Invites

An invite link: `{maxUses, expiresInSeconds}` (0 = unlimited) → `201 {invite: {code, …}}`; the link for people is `https://app.example.com/join/<code>`. An email invite `{email}`: the mail comes from the workspace marked “on behalf of bot X”; the same address at most once a day; only the owner may invite an admin (`role: "WORKSPACE_ROLE_ADMIN"`).

```js tab="JavaScript"
const invite = await bot.invites.create(wsId, { maxUses: 1, expiresInSeconds: 86400 });
await bot.invites.email(wsId, 'new.colleague@example.com');
```

```sh tab="curl"
curl -s -X POST $CALAB/api/workspaces/$WS/invites -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"maxUses": 1, "expiresInSeconds": 86400}'
# → 201 {"invite": {"id": "…", "code": "k3Zq…", "maxUses": 1, "uses": 0, "expiresAt": "…"}}
```

```python tab="Python"
r = requests.post(f"{CALAB}/api/workspaces/{ws_id}/invites/email", headers=H,
                  json={"email": "new.colleague@example.com"})
r.raise_for_status()
```

There are also `bot.invites.list`, `bot.invites.delete`, `bot.invites.listEmail` and `bot.invites.deleteEmail`.

## Gotchas

> [!DANGER]
> **A bot with admin permissions is an admin.** A token whose roles give `MANAGE_*`, `INVITE_*` or `VIEW_JOURNALS` acts as an admin with those permissions: keep it like an admin's password and reissue it when in doubt. The role editor warns when such permissions go to a role that bots hold. Every administrative bot action is written to the server log together with the bot's owner.

> [!NOTE]
> A bot's changes to members follow the same hierarchy as people's: a bot cannot remove, ban or rename someone whose top role is not below its own.
