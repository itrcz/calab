---
title: Disk
description: The workspace Disk API for bots — coming soon.
order: 14
---

> [!NOTE]
> **Coming soon.** Bots currently have no access to the workspace Disk: every Disk route (`/api/workspaces/{id}/disk/…`, `/api/disk/items/…`) answers a bot with `403 FORBIDDEN`, `reason: "BOT_NOT_ALLOWED"`, and roles give a bot no Disk permissions. A Disk and Wiki API for bots is planned — watch the [changelog](./changelog). Meanwhile, a bot uploads files for messages and tasks through [Files](./rest-files).
