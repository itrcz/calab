import { TaskNoticeKind } from '@calaba/protocol';
import type { MessageKey } from '../../i18n';

/**
 * Settings → Уведомления → «Задачи» (ADR-0089 §5): the task notification triggers in two groups,
 * saved as the list of switched-off kinds (UserSettings.taskNotifyOff, TaskNoticeKind values).
 * A row may stand for several kinds (approved + rejected); a locked row is mandatory («Всегда»).
 */
export interface TaskNotifyRow {
  id: string;
  kinds: readonly TaskNoticeKind[];
  label: MessageKey;
  hint: MessageKey;
  /** Mandatory (ADR-0049 §5): the server never stores these as switched off. */
  locked?: boolean;
}

export interface TaskNotifyGroup {
  id: 'me' | 'tasks';
  title: MessageKey;
  rows: readonly TaskNotifyRow[];
}

export const TASK_NOTIFY_GROUPS: readonly TaskNotifyGroup[] = [
  {
    id: 'me',
    title: 'tn.groupMe',
    rows: [
      { id: 'assigned', kinds: [TaskNoticeKind.ASSIGNED], label: 'tn.assigned', hint: 'tn.assignedHint' },
      { id: 'unassigned', kinds: [TaskNoticeKind.UNASSIGNED], label: 'tn.unassigned', hint: 'tn.unassignedHint' },
      { id: 'mentioned', kinds: [TaskNoticeKind.MENTIONED], label: 'tn.mentioned', hint: 'tn.mentionedHint' },
      { id: 'watcher', kinds: [TaskNoticeKind.WATCHER_ADDED], label: 'tn.watcherAdded', hint: 'tn.watcherAddedHint' },
      { id: 'approval', kinds: [TaskNoticeKind.APPROVAL_REQUESTED], label: 'tn.approvalRequested', hint: 'tn.always', locked: true },
      { id: 'rule', kinds: [TaskNoticeKind.RULE], label: 'tn.rule', hint: 'tn.ruleHint' },
      { id: 'dueSoon', kinds: [TaskNoticeKind.DUE_SOON], label: 'tn.dueSoon', hint: 'tn.dueSoonHint' },
      { id: 'overdue', kinds: [TaskNoticeKind.OVERDUE], label: 'tn.overdue', hint: 'tn.overdueHint' },
    ],
  },
  {
    id: 'tasks',
    title: 'tn.groupTasks',
    rows: [
      { id: 'comment', kinds: [TaskNoticeKind.COMMENT], label: 'tn.comment', hint: 'tn.commentHint' },
      { id: 'status', kinds: [TaskNoticeKind.STATUS], label: 'tn.status', hint: 'tn.statusHint' },
      { id: 'decision', kinds: [TaskNoticeKind.APPROVED, TaskNoticeKind.REJECTED], label: 'tn.decision', hint: 'tn.always', locked: true },
      { id: 'dueChanged', kinds: [TaskNoticeKind.DUE_CHANGED], label: 'tn.dueChanged', hint: 'tn.dueChangedHint' },
      { id: 'priority', kinds: [TaskNoticeKind.PRIORITY], label: 'tn.priority', hint: 'tn.priorityHint' },
      { id: 'milestone', kinds: [TaskNoticeKind.MILESTONE], label: 'tn.milestone', hint: 'tn.milestoneHint' },
      { id: 'moved', kinds: [TaskNoticeKind.MOVED], label: 'tn.moved', hint: 'tn.movedHint' },
      { id: 'edited', kinds: [TaskNoticeKind.EDITED], label: 'tn.edited', hint: 'tn.editedHint' },
      { id: 'attachment', kinds: [TaskNoticeKind.ATTACHMENT], label: 'tn.attachment', hint: 'tn.attachmentHint' },
      { id: 'archived', kinds: [TaskNoticeKind.ARCHIVED], label: 'tn.archived', hint: 'tn.archivedHint' },
    ],
  },
];

/** Whether a row is on: none of its kinds is switched off (a locked row is always on). */
export function rowOn(off: readonly number[], row: Pick<TaskNotifyRow, 'kinds' | 'locked'>): boolean {
  return !!row.locked || !row.kinds.some((k) => off.includes(k));
}

/**
 * The switched-off list after a row's switch: its kinds removed (on) or added (off); kinds
 * this client does not know stay as they are; sorted like the server stores them.
 */
export function withRow(off: readonly number[], row: Pick<TaskNotifyRow, 'kinds' | 'locked'>, on: boolean): number[] {
  if (row.locked) return [...off];
  const rest = off.filter((k) => !row.kinds.includes(k));
  return (on ? rest : [...rest, ...row.kinds]).sort((a, b) => a - b);
}

/** The text key of a known notice kind's details (ADR-0089): EDITED says what changed. */
export function editedKey(field: string): MessageKey {
  return field === 'title' ? 'boards.notice.editedTitle' : 'boards.notice.editedDescription';
}

/**
 * «Передавать боту» (ADR-0090 §5). The client does not know which bots have a webhook or a valid
 * token: it lists every bot member of the workspaces where I am not a guest, and the server
 * rejects the ones it cannot relay to (422 TASK_NOTIFY_BOT_UNAVAILABLE).
 */
export interface RelayWorkspace {
  /** My built-in role there is GUEST: the server does not count such a workspace. */
  guest: boolean;
  memberIds: readonly string[];
}

/** The bots I may choose: ids in workspace order, each once. */
export function relayBotIds(workspaces: readonly RelayWorkspace[], isBot: (userId: string) => boolean): string[] {
  const out: string[] = [];
  for (const ws of workspaces) {
    if (ws.guest) continue;
    for (const id of ws.memberIds) if (isBot(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Most bots one user relays to (users.task_notify_bots, ADR-0090 §1). */
export const MAX_RELAY_BOTS = 10;

/**
 * The chosen list after a bot's switch: ids the client no longer lists (a bot that left or was
 * deleted) are dropped, so the server never rejects a stale one.
 */
export function withBot(chosen: readonly string[], id: string, on: boolean, listed: readonly string[]): string[] {
  const rest = chosen.filter((b) => b !== id && listed.includes(b));
  return on ? [...rest, id] : rest;
}
