import { create as createMsg, type MessageInitShape } from '@bufbuild/protobuf';
import {
  ApproverState,
  BoardViewKind,
  Permission,
  PresenceStatus,
  TaskApproverSchema,
  TaskAssigneeSchema,
  TaskNoticeKind,
  TaskSchema,
  type Board,
  type BoardCategory,
  type BoardFeature,
  type BoardView,
  type BoardWebhook,
  type EstimateScale,
  type TaskChecklist,
  type CreateTaskRequestSchema,
  type DispatchEvent,
  type Room,
  type Task,
  type TaskApprovalDecision,
  type TaskPriority,
  type TaskRelationKind,
  type UpdateTaskRequestSchema,
  type TaskActivity,
  type TaskResponse,
  type TaskUpdate,
  type WorkspaceSnapshot,
} from '@calaba/protocol';
import { t, type MessageKey } from '../i18n';
import { ApiError } from '../lib/api/client';
import { approvedCount, blockedStatusIds, quorumOf, rejecters } from '../lib/boards/approvals';
import { draftsOf, type AssigneeDraft } from '../lib/boards/assignees';
import { toTaskFilter, type FilterState } from '../lib/boards/filter';
import { between, byPosition } from '../lib/boards/position';
import { countItems, itemPosition, toggledItem, withItem } from '../lib/boards/checklists';
import { boardLayout, boardPlacements } from '../lib/boards/categories';
import { countsUnread } from '../lib/boards/reducers';
import { planCategoryMove, planNewCategoryFirst, planRoomMove, type RoomTarget } from '../lib/roomOrder';
import { reportPlanError } from './plan';
import { log } from '../lib/log';
import { platform } from '../platform';
import { useAutomations } from '../stores/automations';
import { checklistsOf, useBoards, workspaceBoards, workspaceCategories } from '../stores/boards';
import { MY_TASKS, prefsOf, useBoardsUi, type BoardPrefs, type ViewKind } from '../stores/boardsUi';
import { prefs } from '../stores/prefs';
import { useRooms } from '../stores/rooms';
import { myUserId, useSession } from '../stores/session';
import { toast, useToasts } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { memberName } from '../stores/workspaces';
import { create } from 'zustand';
import { boardsApi, type TaskScope } from './boardsApi';

/**
 * Task boards (ADR-0042): READY / gateway events 75–81 into stores/boards.ts, loading a board's
 * tasks page by page, the open task's detail and room, and every mutation — optimistic, rolled
 * back with a toast when the server refuses. Components never call the API directly.
 */

// ------------------------------------------------------------------ task detail (the panel)

export interface TaskDetail {
  subtasks: string[];
  related: string[];
  parentId: string;
  roomId: string;
  loaded: boolean;
}

interface DetailState {
  byTask: Readonly<Record<string, TaskDetail>>;
  /** «Мои задачи»: the list per workspace + scope (task ids, newest update first). */
  mine: Readonly<Record<string, { ids: string[]; loading: boolean }>>;
  reset: () => void;
}

export const useTaskDetails = create<DetailState>()((set) => ({
  byTask: {},
  mine: {},
  reset: () => set({ byTask: {}, mine: {} }),
}));

/** Task rooms known to the client: kept apart so a READY (which resets the rooms) restores them. */
const taskRooms = new Map<string, Room>();

function rememberRoom(room: Room | undefined): void {
  if (!room) return;
  taskRooms.set(room.id, room);
  useRooms.getState().upsert(room);
  if (room.lastMessageId) useRooms.getState().setLastMessage(room.id, room.lastMessageId);
}

/** Sign-out: nothing of the boards stays. */
export function resetBoards(): void {
  taskRooms.clear();
  useBoards.getState().reset();
  useAutomations.getState().reset();
  useTaskDetails.getState().reset();
  useBoardsUi.setState({ active: false, taskId: null, focused: null, selected: {}, menu: null, createFor: null, settingsFor: null });
}

// ------------------------------------------------------------------ READY / events

/** WorkspaceSnapshot.boards / unread_task_ids (READY, WORKSPACE_CREATE). */
export function applySnapshotBoards(snap: WorkspaceSnapshot): void {
  const wsId = snap.workspace?.id;
  if (!wsId) return;
  const s = useBoards.getState();
  s.setWorkspaceBoards(wsId, snap.boards);
  s.setWorkspaceCategories(wsId, snap.boardCategories);
  s.setUnread(wsId, snap.unreadTaskIds);
}

/** READY resets the rooms store: the task rooms the client knows go back into it. */
export function restoreTaskRooms(): void {
  for (const room of taskRooms.values()) useRooms.getState().upsert(room);
}

/**
 * After READY (a fresh session may have missed events): loaded boards reloaded, the open task
 * refetched, a pending deep link opened.
 */
export function onBoardsReady(): void {
  const { load } = useBoards.getState();
  for (const [boardId, st] of Object.entries(load)) if (st === 'ready' && useBoards.getState().boards[boardId]) void ensureBoardTasks(boardId, true);
  const open = useBoardsUi.getState().taskId;
  if (open) void loadTask(open);
  takePendingLink();
}

/**
 * After main reset the API connections (docs/09 #146): boards whose tasks failed to load and the
 * open task (its detail / comments room) load again, without a click.
 */
export function retryFailedBoardLoads(): void {
  const { load } = useBoards.getState();
  for (const [boardId, st] of Object.entries(load)) if (st === 'error' && useBoards.getState().boards[boardId]) void ensureBoardTasks(boardId, true);
  const open = useBoardsUi.getState().taskId;
  if (open && !useTaskDetails.getState().byTask[open]?.loaded) void loadTask(open);
}

export function dropWorkspaceBoards(workspaceId: string): void {
  const s = useBoards.getState();
  for (const b of Object.values(s.boards)) if (b.workspaceId === workspaceId) s.removeBoard(b.id);
  s.setWorkspaceCategories(workspaceId, []);
  s.setUnread(workspaceId, []);
}

/** Gateway events 75–81 and 87–91 (ADR-0058). Returns false for any other event. */
export function applyBoardEvent(ev: DispatchEvent['event']): boolean {
  const s = useBoards.getState();
  switch (ev.case) {
    case 'boardCreate':
    case 'boardUpdate':
      if (ev.value.board) s.upsertBoard(ev.value.board, true);
      return true;
    case 'boardDelete': {
      // The open task panel of this board closes with it (ADR-0059: the last card of a scoped viewer went).
      const ui = useBoardsUi.getState();
      const open = ui.taskId ? s.tasks[ui.taskId] : undefined;
      s.removeBoard(ev.value.boardId);
      if (open?.boardId === ev.value.boardId) ui.openTask(null);
      if (ui.boardOf[ev.value.workspaceId] === ev.value.boardId) ui.openBoard(ev.value.workspaceId, MY_TASKS);
      return true;
    }
    case 'taskCreate':
      if (ev.value.task) onTask(ev.value.task);
      return true;
    case 'taskUpdate':
      if (ev.value.task) onTask(ev.value.task);
      if (ev.value.notice) notifyTask(ev.value);
      return true;
    case 'taskDelete': {
      // Purged, or a scoped viewer lost the card (ADR-0059: TASK_DELETE without `purged` = the card is gone for him).
      const scoped = !!s.boards[ev.value.boardId]?.taskScoped;
      s.removeTask(ev.value.taskId);
      if (useBoardsUi.getState().taskId === ev.value.taskId && (ev.value.purged || scoped)) useBoardsUi.getState().openTask(null);
      return true;
    }
    case 'taskActivity':
      if (ev.value.activity) s.appendActivity(ev.value.activity);
      return true;
    case 'boardCategoryCreate':
    case 'boardCategoryUpdate':
      if (ev.value.category) s.upsertCategory(ev.value.category);
      return true;
    case 'boardCategoryDelete':
      s.removeCategory(ev.value.categoryId);
      return true;
    // No TASK_UPDATE for checklists: the counters come in the event (ADR-0058 §2).
    case 'taskChecklistUpdate':
      s.upsertChecklist(ev.value.taskId, ev.value.checklist, ev.value.checklistTotal, ev.value.checklistDone);
      return true;
    case 'taskChecklistDelete':
      s.removeChecklist(ev.value.taskId, ev.value.checklistId, ev.value.checklistTotal, ev.value.checklistDone);
      return true;
    default:
      return false;
  }
}

function onTask(task: Task): void {
  const s = useBoards.getState();
  // Tasks of boards not loaded are kept only when something shows them (panel, my tasks, a
  // subtask list): otherwise the store would grow with every event of every board.
  if (s.load[task.boardId] !== 'ready' && !s.tasks[task.id]) {
    const ids = Object.entries(s.unread).filter(([, ws]) => ws === task.workspaceId).map(([id]) => id);
    if (task.viewerState && countsUnread(task)) s.setUnread(task.workspaceId, [...ids, task.id]);
    else if (task.completedAt && s.unread[task.id]) s.setUnread(task.workspaceId, ids.filter((id) => id !== task.id));
    return;
  }
  s.upsertTask(task);
}

/** A task notification (TaskUpdate.notice): a system notification unless I am looking at it. */
function notifyTask(u: TaskUpdate): void {
  const task = u.task;
  const n = u.notice;
  if (!task || !n || n.actorId === myUserId()) return;
  if (prefs().presence === PresenceStatus.DND) return;
  const visible = document.hasFocus() && useBoardsUi.getState().taskId === task.id;
  if (visible) return;
  const what = noticeText(task, n.kind, n.actorId, n.text);
  try {
    const note = new Notification(`${task.key} · ${task.title}`, { body: what, silent: true, tag: `task:${task.id}` });
    note.onclick = () => {
      window.focus();
      openTaskAnywhere(task);
    };
  } catch {
    // notifications unavailable
  }
  platform.app.attention();
}

/**
 * The text of a task notice (system notification). Approvals (ADR-0049 §5) are mandatory: the
 * server sends them past the task level and «Отписаться»; the reminder has no actor.
 */
export function noticeText(task: Pick<Task, 'workspaceId' | 'approvers'>, kind: TaskNoticeKind, actorId: string, text = ''): string {
  const actor = actorId ? memberName(task.workspaceId, actorId) : '';
  switch (kind) {
    case TaskNoticeKind.ASSIGNED:
      return t('boards.notice.assigned', { name: actor });
    case TaskNoticeKind.MENTIONED:
      return t('boards.notice.mentioned', { name: actor });
    case TaskNoticeKind.COMMENT:
      return t('boards.notice.comment', { name: actor });
    case TaskNoticeKind.APPROVAL_REQUESTED:
      return actor ? t('boards.notice.approvalRequested', { name: actor }) : t('boards.notice.approvalReminder');
    case TaskNoticeKind.APPROVED:
      return t('boards.notice.approved');
    // ADR-0060: the «notify» action of an automation rule — its rendered text.
    case TaskNoticeKind.RULE:
      return text ? t('boards.notice.rule', { text }) : t('rules.noticeDefault');
    case TaskNoticeKind.REJECTED: {
      const who = task.approvers.find((a) => a.state === ApproverState.REJECTED && (!actorId || a.userId === actorId));
      const name = memberName(task.workspaceId, who?.userId ?? actorId);
      return who?.comment ? t('boards.notice.rejectedWhy', { name, comment: who.comment }) : t('boards.notice.rejected', { name });
    }
    default:
      return t('boards.notice.status', { name: actor });
  }
}

// ------------------------------------------------------------------ loading

const inflight = new Map<string, Promise<void>>();

/** Loads a board's live tasks (page by page, ≤ 500 each) unless already loaded. */
export function ensureBoardTasks(boardId: string, force = false): Promise<void> {
  const s = useBoards.getState();
  if (!force && (s.load[boardId] === 'ready' || s.load[boardId] === 'loading')) return inflight.get(boardId) ?? Promise.resolve();
  const run = (async () => {
    if (s.load[boardId] !== 'ready') s.setLoad(boardId, 'loading');
    try {
      const all: Task[] = [];
      let cursor = '';
      for (let page = 0; page < 20; page++) {
        const r = await boardsApi.tasks.list(boardId, cursor ? { cursor } : {});
        all.push(...r.tasks);
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      useBoards.getState().setBoardTasks(boardId, all);
      useBoards.getState().setLoad(boardId, 'ready');
    } catch (e) {
      log.warn('board tasks failed', e);
      useBoards.getState().setLoad(boardId, 'error');
    } finally {
      inflight.delete(boardId);
    }
  })();
  inflight.set(boardId, run);
  return run;
}

/** The board with my personal views (READY carries the shared ones only). */
export async function loadBoard(boardId: string): Promise<void> {
  try {
    const r = await boardsApi.get(boardId);
    if (r.board) useBoards.getState().upsertBoard(r.board);
  } catch (e) {
    log.warn('board failed', e);
  }
}

/** `full`: GET /tasks/{id} (or by key) — the only answer that carries the checklists. */
function applyTaskResponse(r: TaskResponse, full = false): void {
  const s = useBoards.getState();
  if (r.board) s.upsertBoard(r.board);
  const extra = [...r.subtasks, ...r.related, ...(r.parent ? [r.parent] : [])];
  s.upsertTasks([...(r.task ? [r.task] : []), ...extra]);
  if (full && r.task) {
    s.setChecklists(r.task.id, r.task.checklists);
    // Git links (ADR-0060 §4) come only with the full task, like the checklists.
    useAutomations.getState().setGitLinks(r.task.id, r.task.gitLinks, true);
  }
  if (r.room) rememberRoom(r.room);
  const task = r.task;
  if (!task) return;
  const prev = useTaskDetails.getState().byTask[task.id];
  const detail: TaskDetail = {
    subtasks: r.subtasks.length || !prev ? r.subtasks.sort(byPosition).map((x) => x.id) : prev.subtasks,
    related: r.related.length || !prev ? r.related.map((x) => x.id) : prev.related,
    parentId: task.parentId,
    roomId: r.room?.id ?? prev?.roomId ?? task.roomId,
    loaded: prev?.loaded || !!r.room,
  };
  useTaskDetails.setState((st) => ({ byTask: { ...st.byTask, [task.id]: detail } }));
}

/** The open task: full detail, its room (comments) and the unread mark cleared. */
export async function loadTask(taskId: string): Promise<Task | null> {
  try {
    const r = await boardsApi.tasks.get(taskId);
    applyTaskResponse(r, true);
    if (r.task?.unread) void markTaskRead(r.task);
    return r.task ?? null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      toast.error(t('boards.err.notFound'));
      if (useBoardsUi.getState().taskId === taskId) useBoardsUi.getState().openTask(null);
    } else log.warn('task failed', e);
    return null;
  }
}

async function markTaskRead(task: Task): Promise<void> {
  useBoards.getState().upsertTask({ ...task, unread: false, viewerState: true });
  try {
    await boardsApi.tasks.markRead(task.id);
  } catch (e) {
    log.warn('task read failed', e);
  }
}

/** «Мои задачи» (GET /me/tasks). */
export async function loadMyTasks(workspaceId: string, scope: TaskScope): Promise<void> {
  const key = `${workspaceId}|${scope}`;
  useTaskDetails.setState((s) => ({ mine: { ...s.mine, [key]: { ids: s.mine[key]?.ids ?? [], loading: true } } }));
  try {
    const r = await boardsApi.tasks.mine(workspaceId, scope, true);
    useBoards.getState().upsertTasks(r.tasks);
    useTaskDetails.setState((s) => ({ mine: { ...s.mine, [key]: { ids: r.tasks.map((x) => x.id), loading: false } } }));
  } catch (e) {
    log.warn('my tasks failed', e);
    useTaskDetails.setState((s) => ({ mine: { ...s.mine, [key]: { ids: s.mine[key]?.ids ?? [], loading: false } } }));
  }
}

// ------------------------------------------------------------------ navigation

/** Opens a board of the active workspace (boards mode on). */
export function openBoard(workspaceId: string, boardId: string): void {
  useBoardsUi.getState().openBoard(workspaceId, boardId);
  // A phone: the pick closes the drawer (one layer at a time, ADR-0021).
  if (useUi.getState().navDrawer) useUi.getState().setNavDrawer(false);
  if (boardId !== MY_TASKS) {
    void ensureBoardTasks(boardId);
  }
}

/** Opens a task wherever it is: its workspace, its board, the panel. */
export function openTaskAnywhere(task: Pick<Task, 'id' | 'workspaceId' | 'boardId'>): void {
  const ui = useUi.getState();
  if (ui.activeWorkspaceId !== task.workspaceId) ui.setWorkspace(task.workspaceId);
  const bu = useBoardsUi.getState();
  if (!bu.active || (bu.boardOf[task.workspaceId] !== task.boardId && bu.boardOf[task.workspaceId] !== MY_TASKS)) openBoard(task.workspaceId, task.boardId);
  bu.setActive(true);
  bu.openTask(task.id);
  void loadTask(task.id);
}

/** The shareable link of a task: https://<server>/t/<KEY-N>. */
export function taskLink(key: string): string {
  const serverUrl = useSession.getState().serverUrl;
  const web = import.meta.env.VITE_PLATFORM === 'web' && typeof location !== 'undefined' ? location.origin : '';
  const origin = [serverUrl, web].map((s) => s.trim().replace(/\/+$/, '')).find((s) => /^https?:\/\//.test(s));
  return `${origin ?? ''}/t/${key}`;
}

export function boardLink(id: string): string {
  return taskLink('').replace(/\/t\/$/, `/b/${id}`);
}

export function copyText(text: string, done: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast.success(done),
    (e: unknown) => toast.fail(e),
  );
}

export const copyTaskLink = (key: string): void => copyText(taskLink(key), t('boards.linkCopied'));
export const copyTaskKey = (key: string): void => copyText(key, t('boards.keyCopied', { key }));

let pending: { kind: 'board' | 'task'; id: string } | null = null;

/** `/b/<id>` and `/t/<KEY-N>` (web path, calab:// deep link): opened once READY is in. */
export function openBoardLink(kind: 'board' | 'task', id: string): void {
  pending = { kind, id };
  if (import.meta.env.VITE_PLATFORM === 'web' && typeof location !== 'undefined' && /^\/(b|t)\//.test(location.pathname)) {
    try {
      history.replaceState(null, '', '/');
    } catch {
      // not fatal
    }
  }
  if (useSession.getState().ready) takePendingLink();
}

function takePendingLink(): void {
  const p = pending;
  pending = null;
  if (!p) return;
  if (p.kind === 'board') {
    const b = useBoards.getState().boards[p.id];
    if (!b) {
      toast.error(t('boards.err.boardNotFound'));
      return;
    }
    const ui = useUi.getState();
    if (ui.activeWorkspaceId !== b.workspaceId) ui.setWorkspace(b.workspaceId);
    openBoard(b.workspaceId, b.id);
    return;
  }
  void (async () => {
    try {
      const r = await boardsApi.tasks.byKey(p.id);
      applyTaskResponse(r, true);
      if (r.task) openTaskAnywhere(r.task);
    } catch (e) {
      log.warn('task link failed', e);
      toast.error(t('boards.err.notFound'));
    }
  })();
}

// ------------------------------------------------------------------ task mutations

/** A local change of a task: the fields the UI edits in place. */
export interface TaskPatch {
  title?: string;
  description?: string;
  statusId?: string;
  priority?: TaskPriority;
  estimate?: number;
  startOn?: string;
  dueOn?: string;
  parentId?: string;
  milestoneId?: string;
  labelIds?: string[];
}

function wireOf(p: TaskPatch): MessageInitShape<typeof UpdateTaskRequestSchema> {
  const { labelIds, ...rest } = p;
  return { ...rest, ...(labelIds ? { setLabels: true, labelIds } : {}) };
}

/** JSON field names of FEATURE_DISABLED (`ApiError.field`) → the field's name in the UI. */
const FEATURE_FIELD: Record<string, MessageKey> = {
  estimate: 'boards.f.estimate',
  startOn: 'boards.f.startOn',
  dueOn: 'boards.f.dueOn',
  priority: 'boards.f.priority',
  labelIds: 'boards.f.label',
  milestoneId: 'boards.f.milestone',
  parentId: 'boards.subtasks',
  relatedId: 'boards.relations',
  attachmentIds: 'boards.feat.attachments',
  approverIds: 'boards.feat.approvals',
  approvalRequired: 'boards.feat.approvals',
  decision: 'boards.feat.approvals',
};

/**
 * A refusal by a board feature (409 FEATURE_DISABLED, ADR-0058 §3) or by the plan (409 PLAN_LIMIT:
 * checklists below Team, the webhook below Business — ADR §5): a toast, true. False otherwise.
 */
export function reportFeatureError(e: unknown, workspaceId?: string): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.reason === 'FEATURE_DISABLED') {
    const key = e.field ? FEATURE_FIELD[e.field] : undefined;
    toast.error(key ? t('boards.err.featureOff', { name: t(key) }) : t('boards.err.featureOffAny'));
    return true;
  }
  if (e.reason === 'PLAN_LIMIT') return reportPlanError(e, workspaceId ?? useUi.getState().activeWorkspaceId);
  return false;
}

function fail(e: unknown, task?: Task): void {
  if (reportFeatureError(e, task?.workspaceId)) return;
  if (e instanceof ApiError && e.reason === 'TASK_APPROVAL_REQUIRED' && task) toast.error(gateText(task, e.extra.used, e.extra.limit));
  else if (e instanceof ApiError && e.status === 403) toast.error(t('boards.err.forbidden'));
  else toast.fail(e, t('boards.err.save'));
}

/**
 * Why a task may not go further (ADR-0049 §6): «Отклонено: <имя>» after a veto, else «Нужно
 * согласование: 1 из 2» (`used` / `limit` of a 409 when there is one, else from the task).
 */
export function gateText(task: Pick<Task, 'workspaceId' | 'approvers' | 'approvalRequired'>, used?: number, limit?: number): string {
  const vetoed = rejecters(task);
  if (vetoed.length) return t('boards.gate.rejected', { name: vetoed.map((u) => memberName(task.workspaceId, u)).join(', ') });
  return t('boards.gate.pending', { n: used ?? approvedCount(task), m: limit ?? quorumOf(task) });
}

/** A status change the approval gate refuses: a toast, nothing is sent (the server would say 409). */
function gated(task: Task, statusId: string): boolean {
  if (statusId === task.statusId) return false;
  const statuses = useBoards.getState().boards[task.boardId]?.statuses ?? [];
  if (!blockedStatusIds(task, statuses).has(statusId)) return false;
  toast.error(gateText(task));
  return true;
}

/** Optimistic PATCH: the card changes at once, the answer replaces it, a refusal rolls back. */
export async function updateTask(taskId: string, patch: TaskPatch): Promise<void> {
  const s = useBoards.getState();
  const prev = s.tasks[taskId];
  if (!prev) return;
  if (patch.statusId !== undefined && gated(prev, patch.statusId)) return;
  s.upsertTask({ ...prev, ...patch });
  try {
    const r = await boardsApi.tasks.update(taskId, wireOf(patch));
    if (r.task) useBoards.getState().upsertTask(r.task);
  } catch (e) {
    const cur = useBoards.getState().tasks[taskId];
    if (cur) useBoards.getState().upsertTask({ ...cur, ...pick(prev, Object.keys(patch) as (keyof TaskPatch)[]) });
    fail(e, cur ?? prev);
  }
}

function pick(t: Task, keys: (keyof TaskPatch)[]): Partial<Task> {
  const out: Partial<Task> = {};
  for (const k of keys) (out as Record<string, unknown>)[k] = t[k];
  return out;
}

/**
 * A kanban / list move: `statusId` and the neighbours it lands between (as the viewer sees the
 * column; '' = an end). The position is computed locally for the optimistic order; the server
 * gets the neighbours and computes its own (TASK_UPDATE confirms).
 */
export async function moveTask(taskId: string, statusId: string, afterId: string, beforeId: string): Promise<void> {
  const s = useBoards.getState();
  const prev = s.tasks[taskId];
  if (!prev || gated(prev, statusId)) return;
  const a = afterId ? s.tasks[afterId] : undefined;
  const b = beforeId ? s.tasks[beforeId] : undefined;
  const position = between(a?.position ?? null, b?.position ?? null);
  s.upsertTask({ ...prev, statusId, position });
  try {
    const r = await boardsApi.tasks.update(taskId, { statusId, afterTaskId: afterId, beforeTaskId: beforeId });
    if (r.task) useBoards.getState().upsertTask(r.task);
  } catch (e) {
    const cur = useBoards.getState().tasks[taskId];
    if (cur) useBoards.getState().upsertTask({ ...cur, statusId: prev.statusId, position: prev.position });
    fail(e, cur ?? prev);
  }
}

/** PUT the full assignee list (optimistic; the lead invariant is kept by lib/boards/assignees). */
export async function setAssignees(taskId: string, list: AssigneeDraft[]): Promise<void> {
  const s = useBoards.getState();
  const prev = s.tasks[taskId];
  if (!prev) return;
  const drafts = draftsOf(list);
  const me = myUserId();
  s.upsertTask({
    ...prev,
    assignees: drafts.map((d) => {
      const was = prev.assignees.find((a) => a.userId === d.userId);
      return was ? { ...was, isLead: d.isLead, note: d.note } : createMsg(TaskAssigneeSchema, { userId: d.userId, isLead: d.isLead, note: d.note, assignedBy: me });
    }),
  });
  try {
    const r = await boardsApi.tasks.setAssignees(taskId, drafts);
    if (r.task) useBoards.getState().upsertTask(r.task);
  } catch (e) {
    const cur = useBoards.getState().tasks[taskId];
    if (cur) useBoards.getState().upsertTask({ ...cur, assignees: prev.assignees });
    fail(e);
  }
}

// ------------------------------------------------------------------ approvals (ADR-0049)

function approversError(e: ApiError): string {
  return e.field === 'required' || e.field === 'approvalRequired' ? t('boards.err.quorum') : t('boards.err.approvers');
}

/**
 * PUT the full approver list and the quorum (optimistic: kept votes stay, new approvers pending;
 * the answer carries the server's approval state).
 */
export async function setApprovers(taskId: string, userIds: string[], required: number): Promise<void> {
  const s = useBoards.getState();
  const prev = s.tasks[taskId];
  if (!prev) return;
  const me = myUserId();
  s.upsertTask({
    ...prev,
    approvalRequired: required,
    approvers: userIds.map((u) => prev.approvers.find((a) => a.userId === u) ?? createMsg(TaskApproverSchema, { userId: u, state: ApproverState.PENDING, addedBy: me })),
  });
  try {
    const r = await boardsApi.tasks.setApprovers(taskId, userIds, required);
    if (r.task) useBoards.getState().upsertTask(r.task);
  } catch (e) {
    const cur = useBoards.getState().tasks[taskId];
    if (cur) useBoards.getState().upsertTask({ ...cur, approvers: prev.approvers, approvalRequired: prev.approvalRequired });
    if (e instanceof ApiError && e.status === 422) toast.error(approversError(e));
    else if (e instanceof ApiError && e.status === 409) toast.error(t('boards.err.archivedTask'));
    else fail(e);
  }
}

/** My vote (APPROVE / REJECT with a comment / WITHDRAW). Resolves true when the server took it. */
export async function voteApproval(taskId: string, decision: TaskApprovalDecision, comment = ''): Promise<boolean> {
  try {
    const r = await boardsApi.tasks.approval(taskId, decision, comment);
    if (r.task) useBoards.getState().upsertTask(r.task);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 422) toast.error(t('boards.err.rejectComment'));
    else if (e instanceof ApiError && e.status === 403) toast.error(t('boards.err.notApprover'));
    else if (e instanceof ApiError && e.status === 404) toast.error(t('boards.err.notFound'));
    else fail(e);
    return false;
  }
}

/** Creates a task; the answer goes into the board (TASK_CREATE confirms it again, harmless). */
export async function createTask(boardId: string, init: MessageInitShape<typeof CreateTaskRequestSchema>): Promise<Task | null> {
  try {
    const r = await boardsApi.tasks.create(boardId, init);
    if (r.task) {
      useBoards.getState().upsertTask(r.task);
      return r.task;
    }
  } catch (e) {
    if (e instanceof ApiError && e.reason === 'BOARD_TASK_LIMIT') toast.error(t('boards.err.taskLimit'));
    else if (e instanceof ApiError && e.reason === 'TASK_APPROVAL_REQUIRED') toast.error(t('boards.err.createApproval'));
    else if (e instanceof ApiError && e.status === 422 && (e.field?.startsWith('approverIds') || e.field === 'approvalRequired')) toast.error(approversError(e));
    else fail(e);
  }
  return null;
}

export async function archiveTask(taskId: string): Promise<void> {
  const s = useBoards.getState();
  const prev = s.tasks[taskId];
  if (!prev) return;
  s.removeTask(taskId);
  if (useBoardsUi.getState().taskId === taskId) useBoardsUi.getState().openTask(null);
  try {
    await boardsApi.tasks.archive(taskId);
    useToasts.getState().push('info', t('boards.archived', { key: prev.key }), { label: t('boards.undo'), run: () => void restoreTask(taskId) });
  } catch (e) {
    useBoards.getState().upsertTask(prev);
    fail(e);
  }
}

export async function restoreTask(taskId: string): Promise<void> {
  try {
    const r = await boardsApi.tasks.restore(taskId);
    if (r.task) useBoards.getState().upsertTask(r.task);
  } catch (e) {
    fail(e);
  }
}

/** «Дублировать»: a copy with the same properties, «(копия)» in the title, right after it. */
export async function duplicateTask(taskId: string): Promise<Task | null> {
  const src = useBoards.getState().tasks[taskId];
  if (!src) return null;
  return createTask(src.boardId, {
    title: t('boards.copyTitle', { title: src.title }).slice(0, 200),
    description: src.description,
    statusId: src.statusId,
    priority: src.priority,
    assignees: src.assignees.map((a) => ({ userId: a.userId, isLead: a.isLead, note: a.note })),
    labelIds: src.labelIds,
    startOn: src.startOn,
    dueOn: src.dueOn,
    estimate: src.estimate,
    parentId: src.parentId,
    milestoneId: src.milestoneId,
    afterTaskId: src.id,
  });
}

export async function moveTaskToBoard(taskId: string, boardId: string): Promise<void> {
  try {
    const r = await boardsApi.tasks.update(taskId, { boardId });
    if (r.task) {
      useBoards.getState().removeTask(taskId);
      useBoards.getState().upsertTask(r.task);
      toast.success(t('boards.movedTo', { key: r.task.key }));
    }
  } catch (e) {
    fail(e);
  }
}

export async function setSubscription(taskId: string, muted: boolean): Promise<void> {
  const prev = useBoards.getState().tasks[taskId];
  if (prev) useBoards.getState().upsertTask({ ...prev, subscribed: true, muted, viewerState: true });
  try {
    const r = await boardsApi.tasks.setSubscription(taskId, muted);
    if (r.task) useBoards.getState().upsertTask(r.task);
  } catch (e) {
    if (prev) useBoards.getState().upsertTask({ ...prev, viewerState: true });
    fail(e);
  }
}

export async function setRelation(taskId: string, relatedId: string, kind: TaskRelationKind, on: boolean): Promise<void> {
  try {
    const r = on ? await boardsApi.tasks.setRelation(taskId, relatedId, kind) : await boardsApi.tasks.removeRelation(taskId, relatedId, kind);
    applyTaskResponse(r);
    if (on) useTaskDetails.setState((s) => {
      const d = s.byTask[taskId];
      return d && !d.related.includes(relatedId) ? { byTask: { ...s.byTask, [taskId]: { ...d, related: [...d.related, relatedId] } } } : {};
    });
  } catch (e) {
    fail(e);
  }
}

/** The description's attachments (uploads to the board, `set_attachments`): the full list. */
export async function setTaskAttachments(taskId: string, ids: string[]): Promise<void> {
  try {
    const r = await boardsApi.tasks.update(taskId, { setAttachments: true, attachmentIds: ids });
    if (r.task) useBoards.getState().upsertTask(r.task);
    await loadTask(taskId);
  } catch (e) {
    fail(e);
  }
}

/** The journal of the task (the panel's activity rows): the newest page, oldest first. */
export async function loadActivity(taskId: string): Promise<TaskActivity[]> {
  try {
    const r = await boardsApi.tasks.activity(taskId, { limit: 100 });
    return r.items.flatMap((i) => (i.item.case === 'activity' ? [i.item.value] : [])).reverse();
  } catch (e) {
    log.warn('task activity failed', e);
    return [];
  }
}

/** Bulk actions of the list (status, priority, labels, assignee, archive): one request per task. */
export async function bulkUpdate(ids: readonly string[], patch: TaskPatch): Promise<void> {
  // A status for many: the tasks the approval gate holds stay, one toast names them.
  const s = useBoards.getState();
  const held = patch.statusId === undefined ? [] : ids.filter((id) => {
    const x = s.tasks[id];
    return !!x && x.statusId !== patch.statusId && blockedStatusIds(x, s.boards[x.boardId]?.statuses ?? []).has(patch.statusId ?? '');
  });
  if (held.length) toast.error(t('boards.gate.bulk', { keys: held.map((id) => s.tasks[id]?.key ?? '').join(', ') }));
  await Promise.all(ids.filter((id) => !held.includes(id)).map((id) => updateTask(id, patch)));
}

export async function bulkArchive(ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map((id) => archiveTask(id)));
}

// ------------------------------------------------------------------ board mutations

function boardFail(e: unknown): void {
  if (e instanceof ApiError && (e.reason === 'FEATURE_DISABLED' || (e.reason === 'PLAN_LIMIT' && !/\bboards?\b/i.test(e.message))) && reportFeatureError(e)) return;
  if (e instanceof ApiError && (e.reason === 'PLAN_LIMIT' || e.reason === 'BOARD_LIMIT')) toast.error(t('boards.err.boardLimit'));
  else if (e instanceof ApiError && e.field === 'key') toast.error(t('boards.err.keyTaken'));
  else toast.fail(e, t('boards.err.save'));
}

async function boardCall(p: Promise<{ board?: Board | undefined }>): Promise<Board | null> {
  try {
    const r = await p;
    if (r.board) useBoards.getState().upsertBoard(r.board);
    return r.board ?? null;
  } catch (e) {
    boardFail(e);
    return null;
  }
}

export const createBoard = (workspaceId: string, init: Parameters<typeof boardsApi.create>[1]): Promise<Board | null> => boardCall(boardsApi.create(workspaceId, init));
export const updateBoard = (boardId: string, init: Parameters<typeof boardsApi.update>[1]): Promise<Board | null> => boardCall(boardsApi.update(boardId, init));
export const createStatus = (boardId: string, init: Parameters<typeof boardsApi.statuses.create>[1]): Promise<Board | null> => boardCall(boardsApi.statuses.create(boardId, init));
export const updateStatus = (boardId: string, id: string, init: Parameters<typeof boardsApi.statuses.update>[2]): Promise<Board | null> =>
  boardCall(boardsApi.statuses.update(boardId, id, init));
export const createLabel = (boardId: string, init: Parameters<typeof boardsApi.labels.create>[1]): Promise<Board | null> => boardCall(boardsApi.labels.create(boardId, init));
export const updateLabel = (boardId: string, id: string, init: Parameters<typeof boardsApi.labels.update>[2]): Promise<Board | null> =>
  boardCall(boardsApi.labels.update(boardId, id, init));
export const createMilestone = (boardId: string, init: Parameters<typeof boardsApi.milestones.create>[1]): Promise<Board | null> =>
  boardCall(boardsApi.milestones.create(boardId, init));
export const updateMilestone = (boardId: string, id: string, init: Parameters<typeof boardsApi.milestones.update>[2]): Promise<Board | null> =>
  boardCall(boardsApi.milestones.update(boardId, id, init));

/** Status order: optimistic (the column moves at once). */
export async function moveStatus(boardId: string, statusId: string, index: number): Promise<void> {
  const b = useBoards.getState().boards[boardId];
  if (!b) return;
  const list = [...b.statuses].sort((x, y) => x.position - y.position);
  const from = list.findIndex((s) => s.id === statusId);
  if (from < 0 || from === index) return;
  const [moved] = list.splice(from, 1);
  if (!moved) return;
  list.splice(index, 0, moved);
  useBoards.getState().upsertBoard({ ...b, statuses: list.map((s, i) => ({ ...s, position: i })) });
  const r = await boardCall(boardsApi.statuses.update(boardId, statusId, { position: index }));
  if (!r) useBoards.getState().upsertBoard(b);
}

async function removeCall(p: Promise<void>, boardId: string): Promise<boolean> {
  try {
    await p;
    await loadBoard(boardId);
    return true;
  } catch (e) {
    boardFail(e);
    return false;
  }
}

export const deleteStatus = (boardId: string, id: string, moveTo: string): Promise<boolean> => removeCall(boardsApi.statuses.remove(boardId, id, moveTo), boardId);
export const deleteLabel = (boardId: string, id: string): Promise<boolean> => removeCall(boardsApi.labels.remove(boardId, id), boardId);
export const deleteMilestone = (boardId: string, id: string): Promise<boolean> => removeCall(boardsApi.milestones.remove(boardId, id), boardId);

/** The workspace's archived boards (those the viewer manages: the server lists only them). */
export async function listArchivedBoards(workspaceId: string): Promise<Board[]> {
  try {
    return (await boardsApi.list(workspaceId, true)).boards;
  } catch (e) {
    toast.fail(e);
    return [];
  }
}

/** Back from the archive (MANAGE_BOARD): the board returns to the list. */
export async function restoreBoard(boardId: string): Promise<Board | null> {
  try {
    const r = await boardsApi.restore(boardId);
    if (r.board) useBoards.getState().upsertBoard(r.board);
    return r.board ?? null;
  } catch (e) {
    boardFail(e);
    return null;
  }
}

/** Archive (restorable) or delete for good (`purge`). */
export async function removeBoard(boardId: string, purge: boolean): Promise<boolean> {
  try {
    await boardsApi.remove(boardId, purge);
    const b = useBoards.getState().boards[boardId];
    useBoards.getState().removeBoard(boardId);
    if (b && useBoardsUi.getState().boardOf[b.workspaceId] === boardId) useBoardsUi.getState().openBoard(b.workspaceId, MY_TASKS);
    return true;
  } catch (e) {
    boardFail(e);
    return false;
  }
}

// ------------------------------------------------------------------ views

const KIND: Record<ViewKind, BoardViewKind> = { kanban: BoardViewKind.KANBAN, list: BoardViewKind.LIST, timeline: BoardViewKind.TIMELINE };
const KIND_BACK: Record<number, ViewKind> = { [BoardViewKind.KANBAN]: 'kanban', [BoardViewKind.LIST]: 'list', [BoardViewKind.TIMELINE]: 'timeline' };

/** «Сохранить как вид»: the current filter, view, grouping and sort under a name. */
export async function saveView(boardId: string, name: string, shared: boolean, p: BoardPrefs): Promise<BoardView | null> {
  try {
    const r = await boardsApi.views.create(boardId, {
      name,
      kind: KIND[p.kind],
      filter: toTaskFilter(p.filter),
      groupBy: p.groupBy === 'none' ? '' : p.groupBy,
      sort: p.sort,
      shared,
    });
    const v = r.view;
    if (v) {
      const b = useBoards.getState().boards[boardId];
      if (b) useBoards.getState().upsertBoard({ ...b, views: [...b.views.filter((x) => x.id !== v.id), v] });
      useBoardsUi.getState().setPrefs(boardId, { viewId: v.id });
    }
    return v ?? null;
  } catch (e) {
    toast.fail(e, t('boards.err.save'));
    return null;
  }
}

export async function deleteView(boardId: string, viewId: string): Promise<void> {
  try {
    await boardsApi.views.remove(boardId, viewId);
    const b = useBoards.getState().boards[boardId];
    if (b) useBoards.getState().upsertBoard({ ...b, views: b.views.filter((x) => x.id !== viewId) });
    if (prefsOf(useBoardsUi.getState(), boardId).viewId === viewId) useBoardsUi.getState().setPrefs(boardId, { viewId: '' });
  } catch (e) {
    toast.fail(e, t('boards.err.save'));
  }
}

/** Applies a saved view to the board's prefs. */
export function applyView(boardId: string, v: BoardView, fromFilter: (f: BoardView['filter']) => FilterState): void {
  const groupBy = (v.groupBy || 'status') as BoardPrefs['groupBy'];
  useBoardsUi.getState().setPrefs(boardId, {
    viewId: v.id,
    kind: KIND_BACK[v.kind] ?? 'kanban',
    filter: fromFilter(v.filter),
    groupBy,
    sort: (v.sort.replace(/^-/, '') || 'manual') as BoardPrefs['sort'],
  });
}

/** A detached Task (a draft for the create dialog's preview), for typed helpers. */
export function blankTask(boardId: string): Task {
  return createMsg(TaskSchema, { boardId });
}

export function clearWorkspaceBoards(workspaceId: string): void {
  const tasks = new Set(
    Object.values(useBoards.getState().tasks)
      .filter((task) => task.workspaceId === workspaceId)
      .map((task) => task.id),
  );
  for (const [id, room] of taskRooms) if (room.workspaceId === workspaceId) taskRooms.delete(id);
  useTaskDetails.setState((s) => ({
    byTask: Object.fromEntries(Object.entries(s.byTask).filter(([id]) => !tasks.has(id))),
    mine: Object.fromEntries(Object.entries(s.mine).filter(([id]) => !tasks.has(id))),
  }));
}

// ------------------------------------------------------------------ board features (ADR-0058 §3)

/** Switches the board's features (the whole disabled set) — optimistic; BOARD_UPDATE confirms. */
export async function setBoardFeatures(boardId: string, disabled: BoardFeature[]): Promise<void> {
  const prev = useBoards.getState().boards[boardId];
  if (!prev) return;
  useBoards.getState().upsertBoard({ ...prev, disabledFeatures: disabled });
  const r = await boardCall(boardsApi.update(boardId, { setDisabledFeatures: true, disabledFeatures: disabled }));
  if (!r) useBoards.getState().upsertBoard({ ...(useBoards.getState().boards[boardId] ?? prev), disabledFeatures: prev.disabledFeatures });
}

export async function setEstimateScale(boardId: string, scale: EstimateScale): Promise<void> {
  const prev = useBoards.getState().boards[boardId];
  if (!prev || prev.estimateScale === scale) return;
  useBoards.getState().upsertBoard({ ...prev, estimateScale: scale });
  const r = await boardCall(boardsApi.update(boardId, { estimateScale: scale }));
  if (!r) useBoards.getState().upsertBoard({ ...(useBoards.getState().boards[boardId] ?? prev), estimateScale: prev.estimateScale });
}

// ------------------------------------------------------------------ board categories (ADR-0058 §1)

function categoryFail(e: unknown): void {
  if (e instanceof ApiError && e.reason === 'BOARD_CATEGORY_LIMIT') toast.error(t('boards.cat.limit'));
  else if (e instanceof ApiError && e.status === 403) toast.error(t('boards.err.forbidden'));
  else toast.fail(e, t('boards.err.save'));
}

/** The list's containers as the viewer sees them (empty categories included: a place to drop). */
function liveLayout(workspaceId: string): ReturnType<typeof boardLayout> {
  const s = useBoards.getState();
  return boardLayout(workspaceBoards(s.boards, workspaceId), workspaceCategories(s.categories, workspaceId), true);
}

/**
 * Applies a reorder at once and sends it as one request (PUT …/boards/order); a refusal brings the
 * previous boards and categories back. The answer (and the BOARD_UPDATE / BOARD_CATEGORY_UPDATE
 * events that follow) is the final word.
 */
async function commitBoardOrder(workspaceId: string, boards: Array<{ boardId: string; categoryId: string; position: number }>, categories: Array<{ categoryId: string; position: number }>): Promise<boolean> {
  if (!boards.length && !categories.length) return true;
  const s = useBoards.getState();
  const prevBoards: Board[] = [];
  const prevCats: BoardCategory[] = [];
  for (const p of boards) {
    const b = s.boards[p.boardId];
    if (!b) continue;
    prevBoards.push(b);
    s.upsertBoard({ ...b, position: p.position, categoryId: p.categoryId });
  }
  for (const p of categories) {
    const c = s.categories[p.categoryId];
    if (!c) continue;
    prevCats.push(c);
    s.upsertCategory({ ...c, position: p.position });
  }
  try {
    const r = await boardsApi.setOrder(workspaceId, { boards, categories });
    const after = useBoards.getState();
    for (const b of r.boards) after.upsertBoard(b, true);
    for (const c of r.categories) after.upsertCategory(c);
    return true;
  } catch (e) {
    const after = useBoards.getState();
    for (const b of prevBoards) after.upsertBoard(b);
    for (const c of prevCats) after.upsertCategory(c);
    categoryFail(e);
    return false;
  }
}

/**
 * Moves a board (drag & drop, «Переместить в категорию»): one request. When every board the move
 * renumbers is mine to manage — PUT …/boards/order with the changed placements; otherwise (a
 * neighbour I may not manage) PUT /boards/{id}/position with the category: the server shifts the
 * others itself, MANAGE_BOARD is needed on the moved board only.
 */
export async function moveBoardTo(workspaceId: string, boardId: string, to: RoomTarget): Promise<boolean> {
  const s = useBoards.getState();
  const layout = liveLayout(workspaceId);
  const placed: Record<string, { id: string; position: number; categoryId: string }> = {};
  for (const b of workspaceBoards(s.boards, workspaceId)) placed[b.id] = { id: b.id, position: b.position, categoryId: b.categoryId };
  const plan = boardPlacements(planRoomMove(layout, placed, boardId, to));
  if (!plan.length) return true;
  if (plan.every((p) => hasManage(s.boards[p.boardId]))) return commitBoardOrder(workspaceId, plan, []);
  const prev = s.boards[boardId];
  if (!prev) return false;
  const categoryId = to.categoryId ?? '';
  s.upsertBoard({ ...prev, categoryId, position: to.index });
  try {
    const r = await boardsApi.move(boardId, to.index, categoryId);
    if (r.board) useBoards.getState().upsertBoard(r.board);
    return true;
  } catch (e) {
    useBoards.getState().upsertBoard(prev);
    categoryFail(e);
    return false;
  }
}

const hasManage = (b: Board | undefined): boolean => !!b && (b.permissions & BigInt(Permission.MANAGE_BOARD)) !== 0n;

/** Moves a category among the categories (CREATE_BOARDS). */
export function moveBoardCategory(workspaceId: string, categoryId: string, index: number): Promise<boolean> {
  const plan = planCategoryMove(workspaceCategories(useBoards.getState().categories, workspaceId), categoryId, index);
  return commitBoardOrder(workspaceId, [], plan);
}

/** A new category goes on top of the categories (as rooms, owner 28.09). */
export async function createBoardCategory(workspaceId: string, name: string): Promise<BoardCategory | null> {
  try {
    const r = await boardsApi.categories.create(workspaceId, { name });
    const cat = r.category;
    if (!cat) return null;
    const others = workspaceCategories(useBoards.getState().categories, workspaceId);
    useBoards.getState().upsertCategory(cat);
    await commitBoardOrder(workspaceId, [], planNewCategoryFirst(others, cat));
    return cat;
  } catch (e) {
    categoryFail(e);
    return null;
  }
}

/** Inline rename: optimistic, the old name back on a refusal. */
export async function renameBoardCategory(categoryId: string, name: string): Promise<void> {
  const prev = useBoards.getState().categories[categoryId];
  if (!prev || !name || name === prev.name) return;
  useBoards.getState().upsertCategory({ ...prev, name });
  try {
    const r = await boardsApi.categories.update(categoryId, { name });
    if (r.category) useBoards.getState().upsertCategory(r.category);
  } catch (e) {
    useBoards.getState().upsertCategory(prev);
    categoryFail(e);
  }
}

/** Deletes a category: its boards go to «без категории» (BOARD_UPDATE for each follows). */
export async function deleteBoardCategory(categoryId: string): Promise<boolean> {
  try {
    await boardsApi.categories.remove(categoryId);
    useBoards.getState().removeCategory(categoryId);
    return true;
  } catch (e) {
    categoryFail(e);
    return false;
  }
}

// ------------------------------------------------------------------ checklists (ADR-0058 §2)

function checklistFail(e: unknown, workspaceId: string | undefined): void {
  if (reportFeatureError(e, workspaceId)) return;
  if (e instanceof ApiError && e.reason === 'CHECKLIST_LIMIT') toast.error(t('boards.cl.limit'));
  else if (e instanceof ApiError && e.reason === 'CHECKLIST_ITEM_LIMIT') toast.error(t('boards.cl.itemLimit'));
  else if (e instanceof ApiError && e.status === 403) toast.error(t('boards.err.forbidden'));
  else toast.fail(e, t('boards.err.save'));
}

const wsOfTask = (taskId: string): string | undefined => useBoards.getState().tasks[taskId]?.workspaceId;

/** A checklist answer into the store (the checklist and the task's counters). */
function applyChecklist(taskId: string, r: { checklist?: TaskChecklist | undefined; checklistTotal: number; checklistDone: number }): void {
  useBoards.getState().upsertChecklist(taskId, r.checklist, r.checklistTotal, r.checklistDone);
}

/** The checklist that holds an item (and the task of it), from the loaded checklists. */
function findItem(taskId: string, itemId: string): { list: TaskChecklist; index: number } | null {
  for (const c of checklistsOf(useBoards.getState(), taskId)) {
    const index = c.items.findIndex((x) => x.id === itemId);
    if (index >= 0) return { list: c, index };
  }
  return null;
}

/** Puts a changed checklist locally with the counters recomputed (optimistic). */
function localChecklist(taskId: string, next: TaskChecklist): void {
  const lists = checklistsOf(useBoards.getState(), taskId).map((c) => (c.id === next.id ? next : c));
  const n = countItems(lists);
  useBoards.getState().upsertChecklist(taskId, next, n.total, n.done);
}

export async function createChecklist(taskId: string, title: string): Promise<TaskChecklist | null> {
  try {
    const r = await boardsApi.tasks.checklists.create(taskId, title);
    applyChecklist(taskId, r);
    return r.checklist ?? null;
  } catch (e) {
    checklistFail(e, wsOfTask(taskId));
    return null;
  }
}

export async function renameChecklist(taskId: string, checklistId: string, title: string): Promise<void> {
  const prev = checklistsOf(useBoards.getState(), taskId).find((c) => c.id === checklistId);
  if (!prev || !title || title === prev.title) return;
  localChecklist(taskId, { ...prev, title });
  try {
    applyChecklist(taskId, await boardsApi.tasks.checklists.update(checklistId, { title }));
  } catch (e) {
    localChecklist(taskId, prev);
    checklistFail(e, wsOfTask(taskId));
  }
}

export async function deleteChecklist(taskId: string, checklistId: string): Promise<void> {
  try {
    const r = await boardsApi.tasks.checklists.remove(checklistId);
    useBoards.getState().removeChecklist(taskId, checklistId, r.checklistTotal, r.checklistDone);
  } catch (e) {
    checklistFail(e, wsOfTask(taskId));
  }
}

export async function addChecklistItem(taskId: string, checklistId: string, text: string): Promise<boolean> {
  try {
    applyChecklist(taskId, await boardsApi.tasks.checklists.addItem(checklistId, { text }));
    return true;
  } catch (e) {
    checklistFail(e, wsOfTask(taskId));
    return false;
  }
}

/** Ticks / unticks an item: the row and the counters change at once, the answer confirms. */
export async function toggleChecklistItem(taskId: string, itemId: string, done: boolean): Promise<void> {
  const at = findItem(taskId, itemId);
  const item = at?.list.items[at.index];
  if (!at || !item || item.done === done) return;
  localChecklist(taskId, withItem(at.list, toggledItem(item, done, myUserId())));
  try {
    applyChecklist(taskId, await boardsApi.tasks.checklists.updateItem(itemId, { done }));
  } catch (e) {
    const cur = findItem(taskId, itemId);
    const now = cur?.list.items[cur.index];
    if (cur && now) localChecklist(taskId, withItem(cur.list, { ...now, done: item.done, doneBy: item.doneBy }));
    checklistFail(e, wsOfTask(taskId));
  }
}

export async function editChecklistItem(taskId: string, itemId: string, text: string): Promise<void> {
  const at = findItem(taskId, itemId);
  const item = at?.list.items[at.index];
  if (!at || !item || !text || text === item.text) return;
  localChecklist(taskId, withItem(at.list, { ...item, text }));
  try {
    applyChecklist(taskId, await boardsApi.tasks.checklists.updateItem(itemId, { text }));
  } catch (e) {
    const cur = findItem(taskId, itemId);
    const now = cur?.list.items[cur.index];
    if (cur && now) localChecklist(taskId, withItem(cur.list, { ...now, text: item.text }));
    checklistFail(e, wsOfTask(taskId));
  }
}

export async function deleteChecklistItem(taskId: string, itemId: string): Promise<void> {
  try {
    applyChecklist(taskId, await boardsApi.tasks.checklists.removeItem(itemId));
  } catch (e) {
    checklistFail(e, wsOfTask(taskId));
  }
}

/**
 * Drag & drop of an item: to `index` of checklist `toId` (another checklist of the task moves it
 * there). The position is between the new neighbours; the rows move at once.
 */
export async function moveChecklistItem(taskId: string, itemId: string, toId: string, index: number): Promise<void> {
  const lists = checklistsOf(useBoards.getState(), taskId);
  const at = findItem(taskId, itemId);
  const target = lists.find((c) => c.id === toId);
  const item = at?.list.items[at.index];
  if (!at || !item || !target) return;
  const position = itemPosition(target.items, itemId, index);
  const same = at.list.id === toId;
  if (same && target.items.filter((x) => x.id !== itemId && x.position < item.position).length === index) return;
  const moved = { ...item, position, checklistId: toId };
  const before = lists;
  if (same) localChecklist(taskId, withItem(at.list, moved));
  else {
    localChecklist(taskId, { ...at.list, items: at.list.items.filter((x) => x.id !== itemId) });
    localChecklist(taskId, { ...target, items: [...target.items, moved].sort((a, b) => a.position - b.position) });
  }
  try {
    applyChecklist(taskId, await boardsApi.tasks.checklists.updateItem(itemId, { position, ...(same ? {} : { checklistId: toId }) }));
  } catch (e) {
    for (const c of before) localChecklist(taskId, c);
    checklistFail(e, wsOfTask(taskId));
  }
}

/** «Сделать подзадачей»: the item leaves its checklist, the new subtask joins the panel's list. */
export async function convertChecklistItem(taskId: string, itemId: string): Promise<void> {
  try {
    const r = await boardsApi.tasks.checklists.convert(itemId);
    applyChecklist(taskId, r);
    const sub = r.task;
    if (sub) {
      useBoards.getState().upsertTask(sub);
      useTaskDetails.setState((st) => {
        const d = st.byTask[taskId];
        return d && !d.subtasks.includes(sub.id) ? { byTask: { ...st.byTask, [taskId]: { ...d, subtasks: [...d.subtasks, sub.id] } } } : {};
      });
      toast.success(t('boards.cl.converted', { key: sub.key }));
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 422) toast.error(t('boards.cl.convertNested'));
    else checklistFail(e, wsOfTask(taskId));
  }
}

// ------------------------------------------------------------------ webhook (ADR-0058 §4)

export interface WebhookState {
  webhook: BoardWebhook | null;
  /** The signing secret, only right after a save (shown once). */
  secret: string;
}

function webhookFail(e: unknown, workspaceId: string): void {
  if (reportFeatureError(e, workspaceId)) return;
  if (e instanceof ApiError && e.status === 422) toast.error(e.field === 'secret' ? t('boards.hook.badSecret') : t('boards.hook.badUrl'));
  else if (e instanceof ApiError && e.status === 403) toast.error(t('boards.err.forbidden'));
  else if (e instanceof ApiError && e.status === 429) toast.error(t('boards.hook.tooOften'));
  else toast.fail(e, t('boards.err.save'));
}

export async function loadWebhook(boardId: string, signal?: AbortSignal): Promise<BoardWebhook | null> {
  const r = await boardsApi.webhook.get(boardId, signal);
  return r.webhook ?? null;
}

export async function saveWebhook(workspaceId: string, boardId: string, url: string, secret: string): Promise<WebhookState | null> {
  try {
    const r = await boardsApi.webhook.set(boardId, url, secret);
    return { webhook: r.webhook ?? null, secret: r.secret };
  } catch (e) {
    webhookFail(e, workspaceId);
    return null;
  }
}

export async function deleteWebhook(workspaceId: string, boardId: string): Promise<boolean> {
  try {
    await boardsApi.webhook.remove(boardId);
    return true;
  } catch (e) {
    webhookFail(e, workspaceId);
    return false;
  }
}

/** «Проверить»: the receiver's answer in a toast. */
export async function pingWebhook(workspaceId: string, boardId: string): Promise<boolean> {
  try {
    const r = await boardsApi.webhook.ping(boardId);
    if (r.ok) toast.success(t('boards.hook.pingOk', { status: r.status }));
    else toast.error(r.status ? t('boards.hook.pingStatus', { status: r.status }) : t('boards.hook.pingFail', { error: r.error || '—' }));
    return r.ok;
  } catch (e) {
    webhookFail(e, workspaceId);
    return false;
  }
}
