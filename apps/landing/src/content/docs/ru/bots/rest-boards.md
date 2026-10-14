---
title: Доски и задачи
description: Доски, категории досок, статусы, метки, вехи, представления, задачи, исполнители, наблюдатели, чек-листы, вехи задачи, архив и автоматизации.
order: 7
---

Бот работает с досками задач как человек — в пределах прав своих ролей и переопределений на доске. Он может создавать и вести задачи, назначать исполнителей, комментировать, вести чек-листы и вехи, читать журнал и правила автоматизации. Бот может быть исполнителем задачи, а на закрытую доску его можно пустить лично.

| Действие | Право |
|---|---|
| видеть доску и её задачи | `VIEW_BOARD` |
| создавать задачи; править свои и те, где бот исполнитель | `CREATE_TASKS` |
| править, перемещать и архивировать любые задачи | `EDIT_TASKS` |
| статусы, метки, вехи, настройки, функции доски, архив доски | `MANAGE_BOARD` |
| создать доску, категории досок | `CREATE_BOARDS` |
| журнал доски | `MANAGE_BOARD`, `EDIT_TASKS` или `VIEW_JOURNALS` |
| журнал запусков правил | `MANAGE_BOARD` |

## Маршруты

<!-- routes:boards -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/workspaces/{id}/boards` | Доски, которые видит бот (`?archived=1` — архивные) → `{boards}` |
| `POST` | `/api/workspaces/{id}/boards` | Создать доску → `201 {board}` (`CREATE_BOARDS`) |
| `GET` | `/api/boards/{id}` | Доска со статусами, метками, вехами, представлениями → `{board}` |
| `PATCH` | `/api/boards/{id}` | Настройки доски, функции, шкала оценок (`MANAGE_BOARD`) |
| `DELETE` | `/api/boards/{id}` | Отправить доску в архив (`MANAGE_BOARD`) |
| `POST` | `/api/boards/{id}/restore` | Вернуть доску из архива |
| `PUT` | `/api/boards/{id}/position` | Место доски в списке |
| `GET` | `/api/boards/{id}/permissions` | Переопределения прав доски (чтение) |
| `GET` | `/api/workspaces/{id}/board-categories` | Категории досок → `{categories}` |
| `POST` | `/api/workspaces/{id}/board-categories` | Создать категорию досок (`CREATE_BOARDS`) |
| `PATCH` | `/api/board-categories/{id}` | Изменить категорию досок |
| `DELETE` | `/api/board-categories/{id}` | Удалить категорию досок |
| `PUT` | `/api/workspaces/{id}/boards/order` | Порядок досок и категорий за одну операцию |
| `POST` | `/api/boards/{id}/statuses` | Добавить статус (`MANAGE_BOARD`, ≤ 20) |
| `PATCH` | `/api/boards/{id}/statuses/{sid}` | Изменить статус |
| `DELETE` | `/api/boards/{id}/statuses/{sid}` | Удалить статус (`?move_to=<sid>` — куда перенести задачи) |
| `POST` | `/api/boards/{id}/labels` | Добавить метку (≤ 50) |
| `PATCH` | `/api/boards/{id}/labels/{sid}` | Изменить метку |
| `DELETE` | `/api/boards/{id}/labels/{sid}` | Удалить метку |
| `POST` | `/api/boards/{id}/milestones` | Добавить веху доски (`MANAGE_BOARD`, ≤ 50) |
| `PATCH` | `/api/boards/{id}/milestones/{sid}` | Изменить веху доски |
| `DELETE` | `/api/boards/{id}/milestones/{sid}` | Удалить веху доски |
| `GET` | `/api/boards/{id}/views` | Общие представления и свои → `{views}` |
| `POST` | `/api/boards/{id}/views` | Создать представление |
| `PATCH` | `/api/boards/{id}/views/{sid}` | Изменить представление |
| `DELETE` | `/api/boards/{id}/views/{sid}` | Удалить представление |
| `POST` | `/api/boards/{id}/files` | Загрузить файл для описания или комментария задачи → `{file}` |
| `GET` | `/api/boards/{id}/activity` | Журнал доски, старые сверху; `&format=csv` — выгрузка |
| `GET` | `/api/boards/{id}/tasks` | Задачи доски: `?filter=&archived=1&updated_after=&cursor=&limit=` → `{tasks, nextCursor}` |
| `POST` | `/api/boards/{id}/tasks` | Создать задачу → `201` `TaskResponse` (`CREATE_TASKS`) |
| `GET` | `/api/tasks/{id}` | Задача с подзадачами, связями, родителем и комнатой комментариев |
| `PATCH` | `/api/tasks/{id}` | Изменить поля задачи |
| `POST` | `/api/tasks/{id}/archive` | Архивировать задачу |
| `POST` | `/api/tasks/{id}/restore` | Вернуть задачу из архива |
| `PUT` | `/api/tasks/{id}/assignees` | Исполнители целиком `{assignees: [{userId, isLead, note}]}` |
| `PUT` | `/api/tasks/{id}/approvers` | Согласующие и кворум (сам бот согласующим не бывает) |
| `PUT` | `/api/tasks/{id}/relations` | Добавить связь `{relatedId, kind}` |
| `DELETE` | `/api/tasks/{id}/relations` | Удалить связь `?related_id=&kind=` |
| `PUT` | `/api/tasks/{id}/subscription` | Подписка бота на задачу `{muted}` |
| `PUT` | `/api/tasks/{id}/watchers` | Добавить наблюдателя `{userId}` (≤ 50) |
| `DELETE` | `/api/tasks/{id}/watchers` | Убрать наблюдателя `?user_id=` |
| `PUT` | `/api/tasks/{id}/read` | Отметить задачу прочитанной |
| `GET` | `/api/tasks/{id}/activity` | Комментарии и журнал задачи: `?before=&limit=&only=journal\|comments` |
| `GET` | `/api/t/{key}` | Задача по ключу `FNG-12` (с доской и комнатой) |
| `GET` | `/api/me/tasks` | Задачи бота: `?workspace_id=&scope=assigned\|lead\|created\|subscribed&open=1&cursor=` |
| `GET` | `/api/workspaces/{id}/tasks/search` | Поиск задач по ключу и словам: `?q=&limit=` (≤ 50) → `{tasks}` |
| `POST` | `/api/tasks/{id}/checklists` | Добавить чек-лист `{title, position?}` |
| `PATCH` | `/api/checklists/{id}` | Изменить чек-лист |
| `DELETE` | `/api/checklists/{id}` | Удалить чек-лист |
| `POST` | `/api/checklists/{id}/items` | Добавить пункт `{text, position?}` |
| `PATCH` | `/api/checklist-items/{id}` | Изменить пункт: `text`, `done`, `position`, `checklistId` |
| `DELETE` | `/api/checklist-items/{id}` | Удалить пункт |
| `POST` | `/api/checklist-items/{id}/convert` | Превратить пункт в подзадачу |
| `POST` | `/api/tasks/{id}/milestones` | Добавить веху задачи `{name, dueOn?}` → `{milestone, task}` |
| `PATCH` | `/api/task-milestones/{id}` | Изменить веху задачи `{name?, dueOn?, position?, completed?}` |
| `DELETE` | `/api/task-milestones/{id}` | Удалить веху задачи |
| `GET` | `/api/boards/{id}/rules` | Правила автоматизации доски (`VIEW_BOARD`) |
| `GET` | `/api/rules/{id}/runs` | Журнал запусков правила (`MANAGE_BOARD`) |
<!-- /routes -->

### Недоступно ботам

На эти маршруты бот получает `403 BOT_NOT_ALLOWED`, даже с подходящими правами:

- доступ к доске `PUT /api/boards/{id}/permissions` и окончательное удаление `DELETE /api/boards/{id}?purge=1`;
- голосование в согласовании `POST /api/tasks/{id}/approval` — бот не согласует задачи;
- вебхук доски `/api/boards/{id}/webhook…` — он хранит секрет и выгружает данные (настраивают люди, см. [Вебхуки](./webhooks));
- создание, изменение, удаление и тест правил автоматизации: `POST /api/boards/{id}/rules`, `PATCH · DELETE /api/rules/{id}`, `POST /api/rules/{id}/test`;
- подключение Git-репозитория к доске `/api/boards/{id}/git`.

## Создать задачу

`CreateTaskRequest`: `title` (1..200), `description` (≤ 20 000, markdown-lite), `statusId` (пусто — статус по умолчанию), `priority` (`TASK_PRIORITY_NONE`…`TASK_PRIORITY_URGENT`), `assignees`, `labelIds`, `startOn` / `dueOn` (`YYYY-MM-DD`), `estimate`, `parentId`, `milestoneId`, `attachmentIds`, `approverIds`, `approvalRequired`, `fromMessageId` (создать из сообщения, которое бот видит).

```sh tab="curl"
curl -s -X POST $CALAB/api/boards/$BOARD/tasks \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"title\": \"Продлить сертификаты\", \"priority\": \"TASK_PRIORITY_HIGH\", \"dueOn\": \"2026-10-20\",
       \"assignees\": [{\"userId\": \"$USER\", \"isLead\": true}]}"
```

```js tab="JavaScript"
import { TaskPriority } from '@calaba/protocol';

const task = await bot.tasks.create(boardId, {
  title: 'Продлить сертификаты',
  priority: TaskPriority.HIGH,
  dueOn: '2026-10-20',
  assignees: [{ userId, isLead: true }],
});
await bot.tasks.comment(task, 'Взял в работу, напомню за день до срока.');
```

```python tab="Python"
r = requests.post(f"{CALAB}/api/boards/{board_id}/tasks", headers=H, json={
    "title": "Продлить сертификаты", "priority": "TASK_PRIORITY_HIGH", "dueOn": "2026-10-20",
    "assignees": [{"userId": user_id, "isLead": True}],
})
task = r.json()["task"]
```

Ответ `201` — `TaskResponse {task, subtasks, related, parent, room}`:

```json
{
  "task": {
    "id": "0192b7e0-0000-7000-8000-0000000000dd",
    "boardId": "0192a000-0000-7000-8000-0000000000bb",
    "number": 42,
    "key": "OPS-42",
    "title": "Продлить сертификаты",
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

Комментарий к задаче — обычное сообщение в её скрытой комнате `task.roomId`: те же маршруты сообщений, реакции и файлы через `POST /api/boards/{id}/files`. SDK `bot.tasks.comment(task, text)` делает это сам.

## Изменить и найти

```js tab="JavaScript"
await bot.tasks.update(task.id, { statusId: doneStatusId });
await bot.tasks.setAssignees(task.id, [{ userId, isLead: true, note: 'отвечает за продление' }]);
const found = await bot.tasks.search(wsId, 'OPS-42');
const { task: t, subtasks } = await bot.tasks.get(task.id);
const open = await bot.tasks.list(boardId);   // все страницы
```

```sh tab="curl"
curl -s -X PATCH $CALAB/api/tasks/$TASK -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"statusId\": \"$DONE\"}"
curl -s "$CALAB/api/workspaces/$WS/tasks/search?q=OPS-42" -H "Authorization: Bearer $TOKEN"
curl -s $CALAB/api/t/OPS-42 -H "Authorization: Bearer $TOKEN"
```

`GET /api/boards/{id}/tasks` отдаёт до 500 задач за страницу (по статусу, затем по позиции); `nextCursor` пустой — последняя страница. `filter` — JSON `TaskFilter {conditions, any}` (≤ 30 условий). Архивные задачи — только с `archived=1` или условием «в архиве».

## Исполнители, согласующие, наблюдатели

Исполнителем, согласующим или наблюдателем может быть любой участник-человек, кроме гостей, — даже без доступа к доске, в том числе на закрытой доске (тогда он видит доску только через свои задачи: `Board.taskScoped`). Бот — только если видит доску, и **никогда** не согласующий; иначе `422`. Сам бот никогда не видит доску через задачи — ему нужен `VIEW_BOARD`. Наблюдателей — до 50 (`409`).

## Чек-листы

Чек-листы правятся как поля задачи: `EDIT_TASKS`, или `CREATE_TASKS` для своих задач и задач, где бот исполнитель. Нужен тариф Team (`409 PLAN_LIMIT`). Лимиты: ≤ 10 чек-листов на задачу (`CHECKLIST_LIMIT`), ≤ 100 пунктов в чек-листе (`CHECKLIST_ITEM_LIMIT`), ≤ 50 категорий досок в пространстве (`BOARD_CATEGORY_LIMIT`); все — `409 CONFLICT` с `used`/`limit`.

```js tab="JavaScript"
const { checklist } = await bot.tasks.checklists.create(task.id, 'Перед релизом');
await bot.tasks.checklists.addItem(checklist.id, 'Обновить сертификат на шлюзе');
await bot.tasks.checklists.updateItem(itemId, { done: true });
const { task: subtask } = await bot.tasks.checklists.convertItem(itemId);   // пункт → подзадача
```

## Вехи задачи

Вехи внутри задачи — этапы со своими сроками: `POST /api/tasks/{id}/milestones {name, dueOn?}`. Ответ — `{milestone, task}`; вехи и прогресс (`milestones`, `milestoneProgress`, `taskMilestoneId`) есть в каждой задаче и в событии `TASK_UPDATE`. Подзадачу привязывают к вехе родителя: `PATCH /api/tasks/{id} {taskMilestoneId}`.

- ≤ 20 вех на задачу (`409 TASK_MILESTONE_LIMIT`); у подзадач вех нет (`422`); подзадача привязывается только к вехе своего родителя (`422`).
- Пока к вехе привязаны подзадачи, её выполнение ведёт сервер: ручной `completed` — `409 TASK_MILESTONE_AUTO`.
- Функция «Вехи» выключена на доске — `409 FEATURE_DISABLED`.

```js tab="JavaScript"
const { milestone } = await bot.tasks.milestones.create(task.id, 'Тестирование', '2026-10-18');
await bot.tasks.milestones.update(milestone.id, { completed: true });
```

## Функции доски и категории

`PATCH /api/boards/{id} {setDisabledFeatures, disabledFeatures, estimateScale}` (`MANAGE_BOARD`) включает и выключает функции доски. Если функция выключена, запрос, который **меняет** её поле на непустое значение, получает `409 CONFLICT`, `reason: "FEATURE_DISABLED"`, `field` — имя поля (`estimate`, `dueOn`, `approverIds`…). Очистка поля и повтор текущего значения проходят.

```js tab="JavaScript"
import { BoardFeature } from '@calaba/bot-sdk';

await bot.boards.setFeatures(boardId, { disabledFeatures: [BoardFeature.MILESTONES] });
const cat = await bot.boards.categories.create(wsId, 'Операции');
await bot.boards.setOrder(wsId, { boards: [{ boardId, categoryId: cat.id, position: 0 }] });
```

## Автоматизации

Бот **читает** правила доски (`GET /api/boards/{id}/rules`) и журнал их запусков (`GET /api/rules/{id}/runs`). Изменения задач, которые делает бот, запускают правила доски так же, как изменения людей. Изменения, сделанные правилами, попадают в журнал с пустым `actorId` и заполненным `ruleId`.

## Подводные камни

> [!NOTE]
> Закрытые доски действуют и для ботов: бот попадает на такую доску только через переопределение на самой доске (лично или по роли), иначе `404`.

> [!TIP]
> Чтобы узнавать об изменениях задач без опроса, слушайте события `taskCreate`, `taskUpdate`, `taskDelete`, `taskActivity` через [Gateway](./gateway) или [Вебхуки](./webhooks). Уведомления конкретного человека о задачах бот может получать через [пересылку уведомлений](./task-notices).
