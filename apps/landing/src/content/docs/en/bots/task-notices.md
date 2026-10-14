---
title: Task notifications
description: A person picks a bot, and it receives exactly the task notifications Calab showed that person — for example, to forward them to another messenger.
order: 20
---

A person can hand their task notifications to a bot: the bot receives **exactly** the notifications Calab showed that person and does whatever it likes with them — forwards them to Telegram, email or a tracker. There is no setting on the bot's side: the person decides everything.

## How a person turns it on

“Settings → Notifications → “Tasks” → “Forward to a bot”” — pick one or more bots (up to 10). Under the hood it is `PATCH /api/me` with the `taskNotifyBots` field:

```json
{ "taskNotifyBots": { "botUserIds": ["0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b"] } }
```

The list is replaced as a whole. Any bot qualifies if it shares a workspace with the person and has a valid token (gateway) or a webhook. Otherwise the answer is `422 VALIDATION` with `field: "taskNotifyBots.botUserIds"` and `reason: "TASK_NOTIFY_BOT_UNAVAILABLE"`. Bots themselves and guests can't change this list.

## What the bot receives

The `taskNotice` event (`TaskNoticeRelay`) — over the gateway (the bot's socket) and the webhook:

| Field | Meaning |
|---|---|
| `workspaceId` | the task's workspace |
| `userId` | whose notification this is |
| `task` | the task as the person sees it; `subscribed`, `muted`, `unread`, `viewerState` are always `false` |
| `notice.kind` | the reason: `TASK_NOTICE_KIND_ASSIGNED`, `…_MENTIONED`, `…_COMMENT`, `…_STATUS`, `…_DUE_SOON` and others (table below) |
| `notice.actorId` | who made the change; empty for due-date reminders |
| `notice.text` | an automation rule's text, a milestone or board name, a file name — depending on `kind` |
| `notice.dueOn` · `notice.daysLeft` | the due date `YYYY-MM-DD` and days left — for due dates |
| `taskUrl` | a link to the task in the app |
| `boardKey` · `boardName` | the board's key and name |

```json
{
  "id": "0192d1a0-…",
  "botUserId": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
  "createdAt": "2026-10-12T09:00:03Z",
  "event": {
    "taskNotice": {
      "workspaceId": "0191f0c2-0000-7000-8000-00000000a001",
      "userId": "0191f0c2-7a10-7d3e-9b11-5c2f8e4a6d01",
      "task": { "id": "0192b0c0-…", "key": "OPS-42", "title": "Renew certificates", "statusId": "0192a0f0-…" },
      "notice": { "kind": "TASK_NOTICE_KIND_STATUS", "actorId": "0191c0d0-…" },
      "taskUrl": "https://app.example.com/t/OPS-42",
      "boardKey": "OPS",
      "boardName": "Operations"
    }
  }
}
```

This is how the event looks in a webhook; on the gateway it is `dispatch.taskNotice` with the same content. In the SDK it is the `taskNotice` event:

```js tab="JavaScript"
bot.on('taskNotice', async (n) => {
  const text = `${n.boardKey}: ${n.task?.title} — ${n.notice?.kind}\n${n.taskUrl}`;
  await forwardToTelegram(n.userId, text); // your delivery
});
```

## Notification kinds

| `kind` | When |
|---|---|
| `TASK_NOTICE_KIND_ASSIGNED` | the person was made an assignee or the lead |
| `TASK_NOTICE_KIND_UNASSIGNED` | they were removed from the assignees |
| `TASK_NOTICE_KIND_MENTIONED` | a mention in the description or a comment |
| `TASK_NOTICE_KIND_COMMENT` | a comment in a task they are subscribed to |
| `TASK_NOTICE_KIND_STATUS` | the status of a task they are subscribed to changed |
| `TASK_NOTICE_KIND_WATCHER_ADDED` | they were added as a watcher |
| `TASK_NOTICE_KIND_APPROVAL_REQUESTED` | their approval is needed (mandatory) |
| `TASK_NOTICE_KIND_APPROVED` · `…_REJECTED` | approved · rejected |
| `TASK_NOTICE_KIND_RULE` | an automation rule's “notify” action; the text is in `notice.text` |
| `TASK_NOTICE_KIND_DUE_SOON` | due tomorrow (`daysLeft: 1`) or today (`0`) |
| `TASK_NOTICE_KIND_OVERDUE` | past due |
| `TASK_NOTICE_KIND_DUE_CHANGED` | the due date was set, moved or removed |
| `TASK_NOTICE_KIND_PRIORITY` · `…_MILESTONE` · `…_MOVED` · `…_EDITED` · `…_ATTACHMENT` · `…_ARCHIVED` | priority, milestone, moved to another board, title or description edited, new attachment, archived |

The list may grow — treat an unknown `kind` as a generic notification with the `taskUrl` link.

## Rules

- The bot gets a notification **when and only when** the person got it: by their triggers, subscriptions, “Unsubscribe”, workspace notification level and mute. Mandatory ones — approval requests, “approved”, “rejected” — always arrive.
- Only while the bot is a member of the task's workspace. The bot does **not** need its own `VIEW_BOARD`: the person entrusted it with their notifications, private boards included.
- A deleted bot, a bot removed from the workspace, or a bot the person blocked gets nothing.
- No other bot and no workspace room ever receives `taskNotice`.

> [!WARNING]
> Through `taskNotice` a bot sees tasks of private boards it has no access to itself. Treat that data as carefully as the person would, and never post it to shared rooms.
