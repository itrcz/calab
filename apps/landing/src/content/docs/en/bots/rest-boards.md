---
title: Boards and tasks
description: Boards, board categories, statuses, labels, milestones, views, tasks, assignees, watchers, checklists, task milestones, the archive and automations.
order: 7
---

A bot works with task boards like a person, within the permissions of its roles and the overrides on the board. It creates and runs tasks, assigns people, comments, keeps checklists and milestones, and reads the journal and automation rules. A bot can be a task's assignee, and it can be let into a private board personally.

| Action | Permission |
|---|---|
| see a board and its tasks | `VIEW_BOARD` |
| create tasks; edit its own and those it is assigned to | `CREATE_TASKS` |
| edit, move and archive any task | `EDIT_TASKS` |
| statuses, labels, milestones, settings, board features, the board archive | `MANAGE_BOARD` |
| create a board, board categories | `CREATE_BOARDS` |
| the board journal | `MANAGE_BOARD`, `EDIT_TASKS` or `VIEW_JOURNALS` |
| the rule run log | `MANAGE_BOARD` |

## Routes

<!-- routes:boards -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/workspaces/{id}/boards` | Boards the bot sees (`?archived=1` — archived ones) → `{boards}` |
| `POST` | `/api/workspaces/{id}/boards` | Create a board → `201 {board}` (`CREATE_BOARDS`) |
| `GET` | `/api/boards/{id}` | A board with statuses, labels, milestones and views → `{board}` |
| `PATCH` | `/api/boards/{id}` | Board settings, features, estimate scale (`MANAGE_BOARD`) |
| `DELETE` | `/api/boards/{id}` | Move the board to the archive (`MANAGE_BOARD`) |
| `POST` | `/api/boards/{id}/restore` | Restore a board from the archive |
| `PUT` | `/api/boards/{id}/position` | The board's place in the list |
| `GET` | `/api/boards/{id}/permissions` | The board's permission overrides (read-only) |
| `GET` | `/api/workspaces/{id}/board-categories` | Board categories → `{categories}` |
| `POST` | `/api/workspaces/{id}/board-categories` | Create a board category (`CREATE_BOARDS`) |
| `PATCH` | `/api/board-categories/{id}` | Change a board category |
| `DELETE` | `/api/board-categories/{id}` | Delete a board category |
| `PUT` | `/api/workspaces/{id}/boards/order` | Order boards and categories in one operation |
| `POST` | `/api/boards/{id}/statuses` | Add a status (`MANAGE_BOARD`, ≤ 20) |
| `PATCH` | `/api/boards/{id}/statuses/{sid}` | Change a status |
| `DELETE` | `/api/boards/{id}/statuses/{sid}` | Delete a status (`?move_to=<sid>` — where its tasks go) |
| `POST` | `/api/boards/{id}/labels` | Add a label (≤ 50) |
| `PATCH` | `/api/boards/{id}/labels/{sid}` | Change a label |
| `DELETE` | `/api/boards/{id}/labels/{sid}` | Delete a label |
| `POST` | `/api/boards/{id}/milestones` | Add a board milestone (`MANAGE_BOARD`, ≤ 50) |
| `PATCH` | `/api/boards/{id}/milestones/{sid}` | Change a board milestone |
| `DELETE` | `/api/boards/{id}/milestones/{sid}` | Delete a board milestone |
| `GET` | `/api/boards/{id}/views` | Shared views and the bot's own → `{views}` |
| `POST` | `/api/boards/{id}/views` | Create a view |
| `PATCH` | `/api/boards/{id}/views/{sid}` | Change a view |
| `DELETE` | `/api/boards/{id}/views/{sid}` | Delete a view |
| `POST` | `/api/boards/{id}/files` | Upload a file for a task description or comment → `{file}` |
| `GET` | `/api/boards/{id}/activity` | The board journal, oldest first; `&format=csv` exports it |
| `GET` | `/api/boards/{id}/tasks` | Board tasks: `?filter=&archived=1&updated_after=&cursor=&limit=` → `{tasks, nextCursor}` |
| `POST` | `/api/boards/{id}/tasks` | Create a task → `201` `TaskResponse` (`CREATE_TASKS`) |
| `GET` | `/api/tasks/{id}` | A task with subtasks, relations, parent and comment room |
| `PATCH` | `/api/tasks/{id}` | Change task fields |
| `POST` | `/api/tasks/{id}/archive` | Archive a task |
| `POST` | `/api/tasks/{id}/restore` | Restore a task from the archive |
| `PUT` | `/api/tasks/{id}/assignees` | The full assignee list `{assignees: [{userId, isLead, note}]}` |
| `PUT` | `/api/tasks/{id}/approvers` | Approvers and the quorum (a bot is never an approver itself) |
| `PUT` | `/api/tasks/{id}/relations` | Add a relation `{relatedId, kind}` |
| `DELETE` | `/api/tasks/{id}/relations` | Remove a relation `?related_id=&kind=` |
| `PUT` | `/api/tasks/{id}/subscription` | The bot's subscription to the task `{muted}` |
| `PUT` | `/api/tasks/{id}/watchers` | Add a watcher `{userId}` (≤ 50) |
| `DELETE` | `/api/tasks/{id}/watchers` | Remove a watcher `?user_id=` |
| `PUT` | `/api/tasks/{id}/read` | Mark the task read |
| `GET` | `/api/tasks/{id}/activity` | Comments and the task journal: `?before=&limit=&only=journal\|comments` |
| `GET` | `/api/t/{key}` | A task by key `FNG-12` (with its board and room) |
| `GET` | `/api/me/tasks` | The bot's tasks: `?workspace_id=&scope=assigned\|lead\|created\|subscribed&open=1&cursor=` |
| `GET` | `/api/workspaces/{id}/tasks/search` | Search tasks by key and words: `?q=&limit=` (≤ 50) → `{tasks}` |
| `POST` | `/api/tasks/{id}/checklists` | Add a checklist `{title, position?}` |
| `PATCH` | `/api/checklists/{id}` | Change a checklist |
| `DELETE` | `/api/checklists/{id}` | Delete a checklist |
| `POST` | `/api/checklists/{id}/items` | Add an item `{text, position?}` |
| `PATCH` | `/api/checklist-items/{id}` | Change an item: `text`, `done`, `position`, `checklistId` |
| `DELETE` | `/api/checklist-items/{id}` | Delete an item |
| `POST` | `/api/checklist-items/{id}/convert` | Turn an item into a subtask |
| `POST` | `/api/tasks/{id}/milestones` | Add a task milestone `{name, dueOn?}` → `{milestone, task}` |
| `PATCH` | `/api/task-milestones/{id}` | Change a task milestone `{name?, dueOn?, position?, completed?}` |
| `DELETE` | `/api/task-milestones/{id}` | Delete a task milestone |
| `GET` | `/api/boards/{id}/rules` | The board's automation rules (`VIEW_BOARD`) |
| `GET` | `/api/rules/{id}/runs` | A rule's run log (`MANAGE_BOARD`) |
<!-- /routes -->

### Not available to bots

These routes answer a bot with `403 BOT_NOT_ALLOWED`, whatever permissions it has:

- board access `PUT /api/boards/{id}/permissions` and the final delete `DELETE /api/boards/{id}?purge=1`;
- voting on an approval `POST /api/tasks/{id}/approval` — a bot never approves tasks;
- the board webhook `/api/boards/{id}/webhook…` — it holds a secret and exports data (people set it up, see [Webhooks](./webhooks));
- creating, changing, deleting and testing automation rules: `POST /api/boards/{id}/rules`, `PATCH · DELETE /api/rules/{id}`, `POST /api/rules/{id}/test`;
- connecting a Git repository to a board `/api/boards/{id}/git`.

## Create a task

`CreateTaskRequest`: `title` (1..200), `description` (≤ 20,000, markdown-lite), `statusId` (empty = the default status), `priority` (`TASK_PRIORITY_NONE`…`TASK_PRIORITY_URGENT`), `assignees`, `labelIds`, `startOn` / `dueOn` (`YYYY-MM-DD`), `estimate`, `parentId`, `milestoneId`, `attachmentIds`, `approverIds`, `approvalRequired`, `fromMessageId` (create from a message the bot can see).

```sh tab="curl"
curl -s -X POST $CALAB/api/boards/$BOARD/tasks \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"title\": \"Renew certificates\", \"priority\": \"TASK_PRIORITY_HIGH\", \"dueOn\": \"2026-10-20\",
       \"assignees\": [{\"userId\": \"$USER\", \"isLead\": true}]}"
```

```js tab="JavaScript"
import { TaskPriority } from '@calaba/protocol';

const task = await bot.tasks.create(boardId, {
  title: 'Renew certificates',
  priority: TaskPriority.HIGH,
  dueOn: '2026-10-20',
  assignees: [{ userId, isLead: true }],
});
await bot.tasks.comment(task, 'On it. I will remind you a day before the due date.');
```

```python tab="Python"
r = requests.post(f"{CALAB}/api/boards/{board_id}/tasks", headers=H, json={
    "title": "Renew certificates", "priority": "TASK_PRIORITY_HIGH", "dueOn": "2026-10-20",
    "assignees": [{"userId": user_id, "isLead": True}],
})
task = r.json()["task"]
```

Response `201` is a `TaskResponse {task, subtasks, related, parent, room}`:

```json
{
  "task": {
    "id": "0192b7e0-0000-7000-8000-0000000000dd",
    "boardId": "0192a000-0000-7000-8000-0000000000bb",
    "number": 42,
    "key": "OPS-42",
    "title": "Renew certificates",
    "description": "",
    "statusId": "0192a000-0000-7000-8000-0000000000c1",
    "priority": "TASK_PRIORITY_HIGH",
    "assignees": [{"userId": "0191c2d3-0000-7000-8000-000000000042", "isLead": true, "note": "", "assignedBy": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b", "assignedAt": "2026-10-14T10:00:00Z"}],
    "createdBy": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
    "dueOn": "2026-10-20",
    "roomId": "0192b7e0-0000-7000-8000-0000000000ee",
    "checklistTotal": 0,
    "checklistDone": 0,
    "milestones": [],
    "taskMilestoneId": "",
    "watcherIds": [],
    "createdAt": "2026-10-14T10:00:00Z"
  },
  "subtasks": [],
  "related": []
}
```

A task comment is an ordinary message in the task's hidden room `task.roomId`: the same message routes and reactions; files go through `POST /api/boards/{id}/files`. The SDK's `bot.tasks.comment(task, text)` does this for you.

## Update and find

```js tab="JavaScript"
await bot.tasks.update(task.id, { statusId: doneStatusId });
await bot.tasks.setAssignees(task.id, [{ userId, isLead: true, note: 'owns the renewal' }]);
const found = await bot.tasks.search(wsId, 'OPS-42');
const { task: t, subtasks } = await bot.tasks.get(task.id);
const all = await bot.tasks.list(boardId);   // every page
```

```sh tab="curl"
curl -s -X PATCH $CALAB/api/tasks/$TASK -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"statusId\": \"$DONE\"}"
curl -s "$CALAB/api/workspaces/$WS/tasks/search?q=OPS-42" -H "Authorization: Bearer $TOKEN"
curl -s $CALAB/api/t/OPS-42 -H "Authorization: Bearer $TOKEN"
```

`GET /api/boards/{id}/tasks` returns up to 500 tasks per page (by status, then position); an empty `nextCursor` means the last page. `filter` is a JSON `TaskFilter {conditions, any}` (≤ 30 conditions). Archived tasks come only with `archived=1` or an “archived” condition.

## Assignees, approvers, watchers

Any human member who is not a guest can be an assignee, approver or watcher — even without access to the board, on a private board too (they then see the board only through their tasks: `Board.taskScoped`). A bot qualifies only if it sees the board, and **never** as an approver; otherwise `422`. A bot itself never sees a board through its tasks — it needs `VIEW_BOARD`. Up to 50 watchers (`409`).

## Checklists

Checklists are edited like task fields: `EDIT_TASKS`, or `CREATE_TASKS` for the bot's own tasks and those it is assigned to. They need the Team plan (`409 PLAN_LIMIT`). Limits: ≤ 10 checklists per task (`CHECKLIST_LIMIT`), ≤ 100 items per checklist (`CHECKLIST_ITEM_LIMIT`), ≤ 50 board categories per workspace (`BOARD_CATEGORY_LIMIT`); all are `409 CONFLICT` with `used`/`limit`.

```js tab="JavaScript"
const { checklist } = await bot.tasks.checklists.create(task.id, 'Before release');
await bot.tasks.checklists.addItem(checklist.id, 'Update the gateway certificate');
await bot.tasks.checklists.updateItem(itemId, { done: true });
const { task: subtask } = await bot.tasks.checklists.convertItem(itemId);   // item → subtask
```

## Task milestones

Milestones inside a task are stages with their own dates: `POST /api/tasks/{id}/milestones {name, dueOn?}`. The answer is `{milestone, task}`; milestones and progress (`milestones`, `milestoneProgress`, `taskMilestoneId`) are in every task and in the `TASK_UPDATE` event. A subtask is linked to its parent's milestone with `PATCH /api/tasks/{id} {taskMilestoneId}`.

- ≤ 20 milestones per task (`409 TASK_MILESTONE_LIMIT`); subtasks have none (`422`); a subtask links only its parent's milestone (`422`).
- While subtasks are linked, the server keeps the milestone's completion: a manual `completed` is `409 TASK_MILESTONE_AUTO`.
- The “Milestones” feature is off on the board — `409 FEATURE_DISABLED`.

```js tab="JavaScript"
const { milestone } = await bot.tasks.milestones.create(task.id, 'Testing', '2026-10-18');
await bot.tasks.milestones.update(milestone.id, { completed: true });
```

## Board features and categories

`PATCH /api/boards/{id} {setDisabledFeatures, disabledFeatures, estimateScale}` (`MANAGE_BOARD`) switches board features on and off. With a feature off, a request that **changes** its field to a non-empty value gets `409 CONFLICT`, `reason: "FEATURE_DISABLED"`, with `field` set to the field name (`estimate`, `dueOn`, `approverIds`…). Clearing the field and repeating the current value pass.

```js tab="JavaScript"
import { BoardFeature } from '@calaba/bot-sdk';

await bot.boards.setFeatures(boardId, { disabledFeatures: [BoardFeature.MILESTONES] });
const cat = await bot.boards.categories.create(wsId, 'Operations');
await bot.boards.setOrder(wsId, { boards: [{ boardId, categoryId: cat.id, position: 0 }] });
```

## Automations

A bot **reads** a board's rules (`GET /api/boards/{id}/rules`) and their run log (`GET /api/rules/{id}/runs`). Task changes made by a bot run the board's rules just like people's changes. Changes made by rules appear in the journal with an empty `actorId` and a `ruleId`.

## Gotchas

> [!NOTE]
> Closed boards apply to bots too: a bot gets onto one only through an override on that board itself (personal or by role); otherwise `404`.

> [!TIP]
> To learn about task changes without polling, listen to `taskCreate`, `taskUpdate`, `taskDelete` and `taskActivity` over the [gateway](./gateway) or [webhooks](./webhooks). A bot can also receive one person's task notifications through [task notice forwarding](./task-notices).
