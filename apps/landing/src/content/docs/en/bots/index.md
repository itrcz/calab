---
title: Bots and integration API
description: A bot is a workspace member with a token; it uses the same REST API and gateway as the app, within the permissions of its roles.
order: 1
---

A Calab bot is a **user** with the `isBot` flag. It belongs to workspaces, holds roles, and sees rooms and boards under the same rules as a person; it calls the same REST API and realtime gateway as the app. There is no separate “Bot API” with its own model: a bot does what a person can, within its permissions. That makes the bot API Calab's integration API — anything an external system needs is done on behalf of a bot.

## What a bot can do

| Task | How | Chapter |
|---|---|---|
| Post to rooms and DMs, reply, react, pin | REST `/api/rooms/{id}/messages`, `/api/messages/{id}/…` | [Messages](./rest-messages), [Direct messages](./rest-dm) |
| Receive messages and events in real time | WebSocket `/gateway` or an HTTPS webhook | [Gateway](./gateway), [Webhooks](./webhooks) |
| Answer `/commands` and buttons under messages | Command registration, `inlineKeyboard` | [Commands and buttons](./commands-buttons) |
| Run boards: tasks, statuses, checklists, milestones, forms | REST `/api/boards/…`, `/api/tasks/…` | [Boards and tasks](./rest-boards), [Forms](./rest-forms) |
| Schedule meetings and check availability | REST `/api/workspaces/{id}/events`, `freebusy` | [Calendar](./rest-calendar) |
| Join voice, listen and speak | `POST /api/rooms/{id}/join` → LiveKit | [Rooms and voice](./rest-rooms) |
| Administer a workspace: rooms, roles, invites, badges | REST, by role permissions | [Workspace and members](./rest-members) |
| Upload files and stickers, search | REST | [Files](./rest-files), [Stickers](./rest-stickers), [Search](./rest-search) |
| Receive a person's task notifications | The `taskNotice` event | [Task notifications](./task-notices) |
| Reset a hosted mailbox password (on servers with mail hosting) | REST `/api/mailbox/…` | [Mailbox](./rest-mailbox) |

## How it fits together

```text
┌───────────────┐   REST  https://app.example.com/api/…   ┌──────────────┐
│               │ ──────────────────────────────────────▶ │              │
│   Your bot    │   Gateway  wss://…/gateway?v=1          │    Calab     │
│ (any language)│ ◀─────────────────────────────────────▶ │    server    │
│               │   Webhook  POST https://bot.example.com │              │
│               │ ◀────────────────────────────────────── │              │
└───────┬───────┘                                         └──────────────┘
        │  voice: url + token from POST /api/rooms/{id}/join
        ▼
   LiveKit (SFU) — the bot is an ordinary call participant
```

- **REST** is for commands: send, edit, create, read. Header: `Authorization: Bearer <bot token>`.
- **The gateway** is an event stream over WebSocket: messages, reactions, voice, tasks. One socket per token.
- **A webhook** delivers the same message and task events, but the server POSTs them to your HTTPS address. Handy for serverless; you can use it alongside the gateway.
- **Voice** bypasses our API: the bot gets a LiveKit address and token and connects with any LiveKit client (Node, Python, Go).

## Permissions work like people's

A bot sees only what `VIEW_ROOM` and `VIEW_BOARD` allow; it posts if it has `SEND_MESSAGES`; it joins voice with `CONNECT`. Restricted rooms and boards are visible to a bot only through an override on the object itself — personal or by role. By default a bot gets the member role: it reads and writes in open rooms and joins voice.

A bot with admin permissions is an admin: keep a token with `MANAGE_*`, `INVITE_*` or `VIEW_JOURNALS` like an admin's password. The server logs every administrative bot action together with the bot's owner.

## What a bot can never do

Part of the API is closed to bots whatever their roles — the server answers `403 FORBIDDEN` with `reason: "BOT_NOT_ALLOWED"`:

- **billing and plans** — balance, payments, plan changes;
- **identity** — SSO, the directory, OAuth clients and the OAuth provider, reauthentication;
- **bot management** — creating bots, tokens, other bots' avatars (even with `MANAGE_BOTS`);
- **notes**, **one-to-one calls**, **push notifications**;
- a person's account: password, email, sessions, status, notification settings;
- creating, discovering and deleting workspaces, joining by invite;
- guest links to rooms, workspace web apps, camera backgrounds;
- voting in task approvals, pressing buttons under messages;
- the workspace Disk (for now; see [Disk](./rest-disk)).

The complete list with a decision for every route is in [Bot routes](../reference/routes).

## Where to start

1. [Quickstart](./quickstart) — create a bot and send the first message.
2. [Token and permissions](./auth) — how to store the token and grant the bot what it needs.
3. [Node.js SDK](./sdk) — if you write JavaScript/TypeScript; in other languages HTTP and WebSocket are enough.
