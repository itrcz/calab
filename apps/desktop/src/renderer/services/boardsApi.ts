import { toJson, type MessageInitShape } from '@bufbuild/protobuf';
import {
  BoardCategoryResponseSchema,
  BoardWebhookPingResponseSchema,
  BoardWebhookResponseSchema,
  ConvertChecklistItemResponseSchema,
  CreateTaskMilestoneRequestSchema,
  TaskMilestoneResponseSchema,
  UpdateTaskMilestoneRequestSchema,
  CreateBoardCategoryRequestSchema,
  CreateTaskChecklistItemRequestSchema,
  CreateTaskChecklistRequestSchema,
  ListBoardCategoriesResponseSchema,
  SetBoardOrderRequestSchema,
  SetBoardOrderResponseSchema,
  SetBoardWebhookRequestSchema,
  TaskChecklistResponseSchema,
  UpdateBoardCategoryRequestSchema,
  UpdateTaskChecklistItemRequestSchema,
  UpdateTaskChecklistRequestSchema,
  BoardPermissionsResponseSchema,
  BoardResponseSchema,
  BoardViewResponseSchema,
  CreateBoardLabelRequestSchema,
  CreateBoardMilestoneRequestSchema,
  CreateBoardRequestSchema,
  CreateBoardStatusRequestSchema,
  CreateBoardViewRequestSchema,
  CreateTaskRequestSchema,
  CreateSmartTaskRequestSchema,
  CreateSmartTaskResponseSchema,
  ListBoardsResponseSchema,
  ListTasksResponseSchema,
  ListTaskNoticesResponseSchema,
  MyTasksResponseSchema,
  SearchTasksResponseSchema,
  CreateSavedTaskSearchRequestSchema,
  ListSavedTaskSearchesResponseSchema,
  SavedTaskSearchResponseSchema,
  UpdateSavedTaskSearchRequestSchema,
  SetAssigneesRequestSchema,
  SetBoardPermissionsRequestSchema,
  SetBoardPositionRequestSchema,
  SetTaskApproversRequestSchema,
  SetTaskRelationRequestSchema,
  SetTaskSubscriptionRequestSchema,
  SetTaskWatcherRequestSchema,
  TaskActivityPageSchema,
  TaskApprovalRequestSchema,
  TaskFilterSchema,
  TaskResponseSchema,
  TaskMentionAccessResponseSchema,
  UpdateBoardLabelRequestSchema,
  UpdateBoardMilestoneRequestSchema,
  UpdateBoardRequestSchema,
  UpdateBoardStatusRequestSchema,
  UpdateBoardViewRequestSchema,
  UpdateTaskRequestSchema,
  type TaskApprovalDecision,
  type TaskAssigneeInput,
  type TaskFilter,
  type TaskRelationKind,
} from '@calaba/protocol';
import { body, call, callEmpty, qs } from '../lib/api/client';
import type { Completion } from '../lib/boards/completion';

/**
 * Task boards REST (ADR-0042 §3, proto/calaba/v1/boards.proto). The one module that knows the
 * routes and request shapes of the boards contract: the rest of the client imports the entity
 * types from `@calaba/protocol` and calls these. Bodies are protojson through the generated
 * schemas (CLAUDE.md: no hand-written contract types).
 */

/** `?filter=`: the TaskFilter as protojson (one object for server, client, views and bots). */
export function filterParam(f: TaskFilter | undefined): string | undefined {
  if (!f || f.conditions.length === 0) return undefined;
  return JSON.stringify(toJson(TaskFilterSchema, f));
}

export type TaskScope = 'assigned' | 'lead' | 'created' | 'subscribed';

type AssigneeInit = Pick<TaskAssigneeInput, 'userId' | 'isLead' | 'note'>;

export const boardsApi = {
  list: (workspaceId: string, archived = false) =>
    call('GET', `/api/workspaces/${workspaceId}/boards${qs({ archived: archived ? 1 : undefined })}`, ListBoardsResponseSchema),
  /** MANAGE_WORKSPACE; 409 PLAN_LIMIT / BOARD_LIMIT, 409 CONFLICT field key (taken). */
  create: (workspaceId: string, init: MessageInitShape<typeof CreateBoardRequestSchema>) =>
    call('POST', `/api/workspaces/${workspaceId}/boards`, BoardResponseSchema, body(CreateBoardRequestSchema, init)),
  /** With the caller's personal views. */
  get: (boardId: string, signal?: AbortSignal) => call('GET', `/api/boards/${boardId}`, BoardResponseSchema, undefined, signal),
  update: (boardId: string, init: MessageInitShape<typeof UpdateBoardRequestSchema>) =>
    call('PATCH', `/api/boards/${boardId}`, BoardResponseSchema, body(UpdateBoardRequestSchema, init)),
  /** Archive; `purge` deletes for good (MANAGE_BOARD, people only). */
  remove: (boardId: string, purge = false) => callEmpty('DELETE', `/api/boards/${boardId}${qs({ purge: purge ? 1 : undefined })}`),
  /** «Сделать меня владельцем» of a former member's private board: the owner with «Владелец видит приватное». */
  takeOver: (boardId: string) => call('POST', `/api/boards/${boardId}/take-over`, BoardResponseSchema),
  /** Back from the archive (MANAGE_BOARD). */
  restore: (boardId: string) => call('POST', `/api/boards/${boardId}/restore`, BoardResponseSchema),
  /** `categoryId` set: into that category ('' = none) at `position` there (ADR-0058 §1). */
  move: (boardId: string, position: number, categoryId?: string) =>
    call('PUT', `/api/boards/${boardId}/position`, BoardResponseSchema, body(SetBoardPositionRequestSchema, { position, ...(categoryId !== undefined ? { categoryId } : {}) })),
  /** One drag & drop of the boards list (ADR-0058 §1): boards (MANAGE_BOARD each) and categories (CREATE_BOARDS). */
  setOrder: (workspaceId: string, init: MessageInitShape<typeof SetBoardOrderRequestSchema>) =>
    call('PUT', `/api/workspaces/${workspaceId}/boards/order`, SetBoardOrderResponseSchema, body(SetBoardOrderRequestSchema, init)),
  categories: {
    list: (workspaceId: string) => call('GET', `/api/workspaces/${workspaceId}/board-categories`, ListBoardCategoriesResponseSchema),
    /** CREATE_BOARDS; 409 BOARD_CATEGORY_LIMIT over 50. */
    create: (workspaceId: string, init: MessageInitShape<typeof CreateBoardCategoryRequestSchema>) =>
      call('POST', `/api/workspaces/${workspaceId}/board-categories`, BoardCategoryResponseSchema, body(CreateBoardCategoryRequestSchema, init)),
    update: (categoryId: string, init: MessageInitShape<typeof UpdateBoardCategoryRequestSchema>) =>
      call('PATCH', `/api/board-categories/${categoryId}`, BoardCategoryResponseSchema, body(UpdateBoardCategoryRequestSchema, init)),
    /** Its boards move to «без категории» at the end. */
    remove: (categoryId: string) => callEmpty('DELETE', `/api/board-categories/${categoryId}`),
  },
  /** The board webhook (ADR-0058 §4): MANAGE_BOARD + MANAGE_INTEGRATIONS, Business plan. */
  webhook: {
    get: (boardId: string, signal?: AbortSignal) => call('GET', `/api/boards/${boardId}/webhook`, BoardWebhookResponseSchema, undefined, signal),
    /** Creates, replaces or re-enables; `secret` '' = the server generates one (returned once). */
    set: (boardId: string, url: string, secret: string) =>
      call('PUT', `/api/boards/${boardId}/webhook`, BoardWebhookResponseSchema, body(SetBoardWebhookRequestSchema, { url, secret })),
    remove: (boardId: string) => callEmpty('DELETE', `/api/boards/${boardId}/webhook`),
    /** A synchronous «ping» delivery; 429 more often than once per 10 s. */
    ping: (boardId: string) => call('POST', `/api/boards/${boardId}/webhook/ping`, BoardWebhookPingResponseSchema),
  },
  permissions: (boardId: string) => call('GET', `/api/boards/${boardId}/permissions`, BoardPermissionsResponseSchema),
  setPermissions: (boardId: string, init: MessageInitShape<typeof SetBoardPermissionsRequestSchema>) =>
    call('PUT', `/api/boards/${boardId}/permissions`, BoardPermissionsResponseSchema, body(SetBoardPermissionsRequestSchema, init)),

  statuses: {
    create: (boardId: string, init: MessageInitShape<typeof CreateBoardStatusRequestSchema>) =>
      call('POST', `/api/boards/${boardId}/statuses`, BoardResponseSchema, body(CreateBoardStatusRequestSchema, init)),
    update: (boardId: string, statusId: string, init: MessageInitShape<typeof UpdateBoardStatusRequestSchema>) =>
      call('PATCH', `/api/boards/${boardId}/statuses/${statusId}`, BoardResponseSchema, body(UpdateBoardStatusRequestSchema, init)),
    /** The status's tasks move to `moveTo` first; the default status cannot be deleted. */
    remove: (boardId: string, statusId: string, moveTo: string) => callEmpty('DELETE', `/api/boards/${boardId}/statuses/${statusId}${qs({ move_to: moveTo })}`),
  },
  labels: {
    create: (boardId: string, init: MessageInitShape<typeof CreateBoardLabelRequestSchema>) =>
      call('POST', `/api/boards/${boardId}/labels`, BoardResponseSchema, body(CreateBoardLabelRequestSchema, init)),
    update: (boardId: string, labelId: string, init: MessageInitShape<typeof UpdateBoardLabelRequestSchema>) =>
      call('PATCH', `/api/boards/${boardId}/labels/${labelId}`, BoardResponseSchema, body(UpdateBoardLabelRequestSchema, init)),
    remove: (boardId: string, labelId: string) => callEmpty('DELETE', `/api/boards/${boardId}/labels/${labelId}`),
  },
  milestones: {
    create: (boardId: string, init: MessageInitShape<typeof CreateBoardMilestoneRequestSchema>) =>
      call('POST', `/api/boards/${boardId}/milestones`, BoardResponseSchema, body(CreateBoardMilestoneRequestSchema, init)),
    update: (boardId: string, milestoneId: string, init: MessageInitShape<typeof UpdateBoardMilestoneRequestSchema>) =>
      call('PATCH', `/api/boards/${boardId}/milestones/${milestoneId}`, BoardResponseSchema, body(UpdateBoardMilestoneRequestSchema, init)),
    remove: (boardId: string, milestoneId: string) => callEmpty('DELETE', `/api/boards/${boardId}/milestones/${milestoneId}`),
  },
  /** Saved task searches of the caller in a workspace (ADR-0139): the left panel's named filters. */
  savedSearches: {
    list: (workspaceId: string) => call('GET', `/api/workspaces/${workspaceId}/task-searches`, ListSavedTaskSearchesResponseSchema),
    /** 409 TASK_SEARCH_LIMIT past 50. */
    create: (workspaceId: string, init: MessageInitShape<typeof CreateSavedTaskSearchRequestSchema>) =>
      call('POST', `/api/workspaces/${workspaceId}/task-searches`, SavedTaskSearchResponseSchema, body(CreateSavedTaskSearchRequestSchema, init)),
    update: (workspaceId: string, id: string, init: MessageInitShape<typeof UpdateSavedTaskSearchRequestSchema>) =>
      call('PATCH', `/api/workspaces/${workspaceId}/task-searches/${id}`, SavedTaskSearchResponseSchema, body(UpdateSavedTaskSearchRequestSchema, init)),
    remove: (workspaceId: string, id: string) => callEmpty('DELETE', `/api/workspaces/${workspaceId}/task-searches/${id}`),
  },
  views: {
    create: (boardId: string, init: MessageInitShape<typeof CreateBoardViewRequestSchema>) =>
      call('POST', `/api/boards/${boardId}/views`, BoardViewResponseSchema, body(CreateBoardViewRequestSchema, init)),
    update: (boardId: string, viewId: string, init: MessageInitShape<typeof UpdateBoardViewRequestSchema>) =>
      call('PATCH', `/api/boards/${boardId}/views/${viewId}`, BoardViewResponseSchema, body(UpdateBoardViewRequestSchema, init)),
    remove: (boardId: string, viewId: string) => callEmpty('DELETE', `/api/boards/${boardId}/views/${viewId}`),
  },

  tasks: {
    /** One page (≤ 500, by status then position); the client loads a board page by page. */
    list: (boardId: string, p: { filter?: TaskFilter; cursor?: string; archived?: boolean; limit?: number } = {}, signal?: AbortSignal) =>
      call(
        'GET',
        `/api/boards/${boardId}/tasks${qs({ filter: filterParam(p.filter), cursor: p.cursor, archived: p.archived ? 1 : undefined, limit: p.limit })}`,
        ListTasksResponseSchema,
        undefined,
        signal,
      ),
    create: (boardId: string, init: MessageInitShape<typeof CreateTaskRequestSchema>) =>
      call('POST', `/api/boards/${boardId}/tasks`, TaskResponseSchema, body(CreateTaskRequestSchema, init)),
    /** With subtasks, related tasks, the parent and the task room. */
    get: (taskId: string, signal?: AbortSignal) => call('GET', `/api/tasks/${taskId}`, TaskResponseSchema, undefined, signal),
    /** `/t/<KEY-N>` deep links (+ the board). */
    byKey: (key: string) => call('GET', `/api/t/${encodeURIComponent(key)}`, TaskResponseSchema),
    update: (taskId: string, init: MessageInitShape<typeof UpdateTaskRequestSchema>) =>
      call('PATCH', `/api/tasks/${taskId}`, TaskResponseSchema, body(UpdateTaskRequestSchema, init)),
    archive: (taskId: string) => call('POST', `/api/tasks/${taskId}/archive`, TaskResponseSchema),
    restore: (taskId: string) => call('POST', `/api/tasks/${taskId}/restore`, TaskResponseSchema),
    /** The full list; exactly one lead when not empty. */
    setAssignees: (taskId: string, assignees: AssigneeInit[]) =>
      call('PUT', `/api/tasks/${taskId}/assignees`, TaskResponseSchema, body(SetAssigneesRequestSchema, { assignees })),
    /** ADR-0049: the full approver list (order kept) and the quorum (0 = all). */
    setApprovers: (taskId: string, userIds: string[], required: number) =>
      call('PUT', `/api/tasks/${taskId}/approvers`, TaskResponseSchema, body(SetTaskApproversRequestSchema, { userIds, required })),
    /**
     * ADR-0049: my own vote; REJECT needs a comment (≤ 500), WITHDRAW clears it. ADR-0108:
     * `onBehalfOf` — a board manager's APPROVE / WITHDRAW for that approver.
     */
    approval: (taskId: string, decision: TaskApprovalDecision, comment = '', onBehalfOf = '') =>
      call('POST', `/api/tasks/${taskId}/approval`, TaskResponseSchema, body(TaskApprovalRequestSchema, { decision, comment, onBehalfOf })),
    setRelation: (taskId: string, relatedId: string, kind: TaskRelationKind) =>
      call('PUT', `/api/tasks/${taskId}/relations`, TaskResponseSchema, body(SetTaskRelationRequestSchema, { relatedId, kind })),
    removeRelation: (taskId: string, relatedId: string, kind: TaskRelationKind) =>
      call('DELETE', `/api/tasks/${taskId}/relations${qs({ related_id: relatedId, kind })}`, TaskResponseSchema),
    /** ADR-0076: make a member a watcher (an editor of the task; 422 guest / bot without the board). */
    addWatcher: (taskId: string, userId: string) =>
      call('PUT', `/api/tasks/${taskId}/watchers`, TaskResponseSchema, body(SetTaskWatcherRequestSchema, { userId })),
    /** ADR-0076: remove a watcher (an editor, or the watcher themselves — «Перестать наблюдать»). */
    removeWatcher: (taskId: string, userId: string) =>
      call('DELETE', `/api/tasks/${taskId}/watchers${qs({ user_id: userId })}`, TaskResponseSchema),
    /** ADR-0076 §5: which of the members see the board / would get only this card if @mentioned (any viewer of the task). */
    mentionAccess: (taskId: string, userIds: string[]) =>
      call('GET', `/api/tasks/${taskId}/mention-access${qs({ user_ids: userIds.join(',') })}`, TaskMentionAccessResponseSchema),
    /** muted false = subscribed with notifications, true = «Отписаться». */
    setSubscription: (taskId: string, muted: boolean) =>
      call('PUT', `/api/tasks/${taskId}/subscription`, TaskResponseSchema, body(SetTaskSubscriptionRequestSchema, { muted })),
    /** Clears Task.unread (the boards badge). */
    markRead: (taskId: string) => callEmpty('PUT', `/api/tasks/${taskId}/read`),
    /** The feed: comments and journal rows, newest first; `before` = the oldest id seen. */
    /** only (ADR-0091 §3): `journal` — journal entries only, `comments` — messages only; a server without it sends both. */
    activity: (taskId: string, p: { before?: string; limit?: number; only?: 'journal' | 'comments' } = {}, signal?: AbortSignal) =>
      call('GET', `/api/tasks/${taskId}/activity${qs({ before: p.before, limit: p.limit, only: p.only })}`, TaskActivityPageSchema, undefined, signal),
    /** Live tasks of every board the caller sees, by key and words (the relation picker); `state` — completion (server default all). */
    search: (workspaceId: string, q: string, p: { state?: Completion; limit?: number } = {}, signal?: AbortSignal) =>
      call('GET', `/api/workspaces/${workspaceId}/tasks/search${qs({ q, state: p.state, limit: p.limit })}`, SearchTasksResponseSchema, undefined, signal),
    /** «Недавние» (CBF-179): the latest notice of each task of the workspace, newest first, ≤ 50 tasks. */
    recent: (workspaceId: string, signal?: AbortSignal) =>
      call('GET', `/api/workspaces/${workspaceId}/recent-tasks`, ListTaskNoticesResponseSchema, undefined, signal),
    /**
     * The task search (ADR-0139): text, completion, archive, one board, a filter, a sort and the
     * offset cursor; answers a page, `keyTask` (a typed key, whatever the filters) and snippets.
     */
    find: (
      workspaceId: string,
      p: { q?: string; state?: 'open' | 'done' | 'all'; archived?: '1' | 'only'; boardId?: string; filter?: TaskFilter; sort?: string; cursor?: string; limit?: number },
      signal?: AbortSignal,
    ) =>
      call(
        'GET',
        `/api/workspaces/${workspaceId}/tasks/search${qs({ q: p.q, state: p.state, archived: p.archived, board_id: p.boardId, filter: filterParam(p.filter), sort: p.sort, cursor: p.cursor, limit: p.limit })}`,
        SearchTasksResponseSchema,
        undefined,
        signal,
      ),
    /** Checklists (ADR-0058 §2); every write answers the checklist and the task's counters. */
    checklists: {
      create: (taskId: string, title: string) =>
        call('POST', `/api/tasks/${taskId}/checklists`, TaskChecklistResponseSchema, body(CreateTaskChecklistRequestSchema, { title })),
      update: (checklistId: string, init: MessageInitShape<typeof UpdateTaskChecklistRequestSchema>) =>
        call('PATCH', `/api/checklists/${checklistId}`, TaskChecklistResponseSchema, body(UpdateTaskChecklistRequestSchema, init)),
      /** Answers the counters without a checklist. */
      remove: (checklistId: string) => call('DELETE', `/api/checklists/${checklistId}`, TaskChecklistResponseSchema),
      addItem: (checklistId: string, init: MessageInitShape<typeof CreateTaskChecklistItemRequestSchema>) =>
        call('POST', `/api/checklists/${checklistId}/items`, TaskChecklistResponseSchema, body(CreateTaskChecklistItemRequestSchema, init)),
      /** text / done / position; `checklistId` moves the item to another checklist of the task. */
      updateItem: (itemId: string, init: MessageInitShape<typeof UpdateTaskChecklistItemRequestSchema>) =>
        call('PATCH', `/api/checklist-items/${itemId}`, TaskChecklistResponseSchema, body(UpdateTaskChecklistItemRequestSchema, init)),
      removeItem: (itemId: string) => call('DELETE', `/api/checklist-items/${itemId}`, TaskChecklistResponseSchema),
      /** The item becomes a subtask (SUBTASKS on, the task not a subtask itself). */
      convert: (itemId: string) => call('POST', `/api/checklist-items/${itemId}/convert`, ConvertChecklistItemResponseSchema),
    },
    /** Milestones inside a task (ADR-0063); every write answers the milestone and the task. */
    milestones: {
      create: (taskId: string, init: MessageInitShape<typeof CreateTaskMilestoneRequestSchema>) =>
        call('POST', `/api/tasks/${taskId}/milestones`, TaskMilestoneResponseSchema, body(CreateTaskMilestoneRequestSchema, init)),
      /** name / dueOn ("" clears) / position / completed (a person's toggle: no subtasks linked). */
      update: (milestoneId: string, init: MessageInitShape<typeof UpdateTaskMilestoneRequestSchema>) =>
        call('PATCH', `/api/task-milestones/${milestoneId}`, TaskMilestoneResponseSchema, body(UpdateTaskMilestoneRequestSchema, init)),
      /** Answers the task without the milestone; its subtasks lose the link. */
      remove: (milestoneId: string) => call('DELETE', `/api/task-milestones/${milestoneId}`, TaskMilestoneResponseSchema),
    },
    mine: (workspaceId: string, scope: TaskScope, open = true, signal?: AbortSignal) =>
      call('GET', `/api/me/tasks${qs({ workspace_id: workspaceId, scope, open: open ? 1 : undefined })}`, MyTasksResponseSchema, undefined, signal),
  },

  /** Where description / comment attachments of a board's tasks are uploaded. */
  uploadPath: (boardId: string): string => `/api/boards/${boardId}/files`,
  /** «Создать умную задачу» (CBF-68): files are uploaded to the workspace before a board is known. */
  workspaceUploadPath: (workspaceId: string): string => `/api/workspaces/${workspaceId}/files`,
  /** CBF-68: the model picks the board and shapes the task; 201 with the task, 409 reasons AI_*, NO_BOARDS. */
  createSmart: (workspaceId: string, init: MessageInitShape<typeof CreateSmartTaskRequestSchema>) =>
    call('POST', `/api/workspaces/${workspaceId}/smart-tasks`, CreateSmartTaskResponseSchema, body(CreateSmartTaskRequestSchema, init)),
};
