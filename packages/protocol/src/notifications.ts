// Notification levels (docs/05 «Уведомления», docs/09 item 22). Mirrors Go
// apps/server/internal/notifications; both are tested against proto/testdata/notifications.json.
import { NotificationLevel } from './gen/calaba/v1/room_pb.js';

/**
 * The level that decides for a room: its own unless INHERIT (the room default), else the
 * workspace's (default MENTIONS). A DM has no workspace: every message notifies (ALL) unless
 * the DM is set to NONE.
 */
export function effectiveNotificationLevel(
  room: NotificationLevel | undefined,
  workspace: NotificationLevel | undefined,
  dm: boolean,
): NotificationLevel {
  const r = !room ? NotificationLevel.INHERIT : room;
  if (dm) return r === NotificationLevel.NONE ? r : NotificationLevel.ALL;
  if (r !== NotificationLevel.INHERIT) return r;
  return !workspace || workspace === NotificationLevel.INHERIT ? NotificationLevel.MENTIONS : workspace;
}

/** What happened in a task, as far as notifications are concerned (ADR-0042 §4, ADR-0089). */
export type TaskNotifyKind =
  | 'assigned'
  | 'mentioned'
  | 'comment'
  | 'status'
  | 'approval_requested'
  | 'approved'
  | 'rejected'
  | 'rule'
  | 'unassigned'
  | 'watcher_added'
  | 'due_soon'
  | 'overdue'
  | 'due_changed'
  | 'priority'
  | 'milestone'
  | 'moved'
  | 'edited'
  | 'attachment'
  | 'archived';

/** Kinds addressed to the recipient («Мне лично», ADR-0089 §1): ALL and MENTIONS, no subscription needed. */
export const TASK_DIRECT_KINDS: readonly TaskNotifyKind[] = ['assigned', 'mentioned', 'rule', 'unassigned', 'watcher_added', 'due_soon', 'overdue'];

/** Kinds that cannot be switched off (ADR-0089 §2). */
export const TASK_MANDATORY_KINDS: readonly TaskNotifyKind[] = ['approval_requested', 'approved', 'rejected'];

/** One task change by someone else, as seen by one recipient. */
export interface TaskNotifyFacts {
  kind: TaskNotifyKind;
  /** The workspace's «Задачи» level (WorkspaceNotificationSettings.taskLevel); unset = ALL. */
  level?: NotificationLevel;
  /** The recipient has a subscription (auto or manual). */
  subscribed: boolean;
  /** «Отписаться». */
  muted: boolean;
  /** The workspace's muted_until is in the future. */
  workspaceMuted: boolean;
  /** APPROVED / REJECTED to the task's creator or lead assignee (ADR-0049 §5): bypasses levels and mutes. */
  mandatory?: boolean;
  /** The recipient switched this kind off (UserSettings.taskNotifyOff, ADR-0089); no effect on mandatory notices. */
  off?: boolean;
}

/**
 * Whether a task change notifies the recipient (Go notifications.TaskNotifies). Approvals
 * (ADR-0049 §5) are mandatory: APPROVAL_REQUESTED always, APPROVED / REJECTED with `mandatory`.
 * Otherwise nothing for a kind switched off (ADR-0089), with NONE or a muted workspace; the
 * kinds addressed to the recipient with ALL and MENTIONS, even unsubscribed; the rest with ALL,
 * to subscribers who did not mute the task.
 */
export function taskNotifies(f: TaskNotifyFacts): boolean {
  if (f.kind === 'approval_requested' || (f.mandatory && (f.kind === 'approved' || f.kind === 'rejected'))) {
    return true;
  }
  const level = !f.level ? NotificationLevel.ALL : f.level;
  if (f.off || f.workspaceMuted || level === NotificationLevel.NONE) return false;
  if (TASK_DIRECT_KINDS.includes(f.kind)) return level === NotificationLevel.ALL || level === NotificationLevel.MENTIONS;
  return level === NotificationLevel.ALL && f.subscribed && !f.muted;
}

/** Facts about one incoming message from someone else, as seen by its recipient. */
export interface NotifyFacts {
  dm: boolean;
  /** @<me>, or an @everyone / @here its author may use. */
  mention: boolean;
  room?: NotificationLevel;
  workspace?: NotificationLevel;
  /** The room's muted_until is in the future. */
  roomMuted: boolean;
  /** The workspace's muted_until is in the future (no effect on a DM). */
  workspaceMuted: boolean;
}

/**
 * Whether the message may make a sound or a system notification. Unread / mention counters
 * do not depend on it; «не беспокоить» and per-device toggles apply on top.
 */
export function levelNotifies(f: NotifyFacts): boolean {
  if (f.roomMuted || (!f.dm && f.workspaceMuted)) return false;
  switch (effectiveNotificationLevel(f.room, f.workspace, f.dm)) {
    case NotificationLevel.ALL:
      return true;
    case NotificationLevel.MENTIONS:
      return f.mention;
    default:
      return false;
  }
}
