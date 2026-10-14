import { BoardStatusType, RuleAssigneesMode, RuleGitEvent, RuleRecipients, RuleSpecialUser, TaskApprovalState, TaskPriority, type BoardRule, type RuleAction, type RuleTrigger } from '@calaba/protocol';
import { t, type MessageKey } from '../../i18n';

/**
 * The one-line summary of an automation rule (ADR-0060 §6): «Когда статус → «Готово» → тогда
 * приоритет → Срочно, комментарий». Generated from the rule's structure; names of statuses,
 * labels, people and rooms come from `ctx` (the board / workspace the caller knows), a reference
 * that no longer resolves shows «?». ADR-0060 wanted this in packages/protocol for bots too; the
 * client keeps it here with its i18n. Pure.
 */
export interface SummaryCtx {
  status: (id: string) => string | undefined;
  label: (id: string) => string | undefined;
  user: (id: string) => string | undefined;
  room: (id: string) => string | undefined;
}

const PRIORITY: Record<number, MessageKey> = {
  [TaskPriority.NONE]: 'boards.prio.none',
  [TaskPriority.LOW]: 'boards.prio.low',
  [TaskPriority.MEDIUM]: 'boards.prio.medium',
  [TaskPriority.HIGH]: 'boards.prio.high',
  [TaskPriority.URGENT]: 'boards.prio.urgent',
};

const STATUS_TYPE: Record<number, MessageKey> = {
  [BoardStatusType.BACKLOG]: 'boards.type.backlog',
  [BoardStatusType.UNSTARTED]: 'boards.type.unstarted',
  [BoardStatusType.STARTED]: 'boards.type.started',
  [BoardStatusType.COMPLETED]: 'boards.type.completed',
  [BoardStatusType.CANCELLED]: 'boards.type.cancelled',
};

const GIT: Record<number, MessageKey> = {
  [RuleGitEvent.UNSPECIFIED]: 'rules.sum.git',
  [RuleGitEvent.BRANCH_CREATED]: 'rules.sum.branch',
  [RuleGitEvent.PR_OPENED]: 'rules.sum.prOpened',
  [RuleGitEvent.PR_MERGED]: 'rules.sum.prMerged',
  [RuleGitEvent.PR_CLOSED]: 'rules.sum.prClosed',
  [RuleGitEvent.COMMIT_PUSHED]: 'rules.sum.commit',
};

const RECIPIENT: Record<number, MessageKey> = {
  [RuleRecipients.ASSIGNEES]: 'rules.sum.to.assignees',
  [RuleRecipients.LEAD]: 'rules.sum.to.lead',
  [RuleRecipients.CREATOR]: 'rules.sum.to.creator',
  [RuleRecipients.APPROVERS]: 'rules.sum.to.approvers',
};

export const priorityName = (p: TaskPriority): string => t(PRIORITY[p] ?? 'boards.prio.none');
const or = (s: string | undefined): string => s ?? '?';

/** «статус → «Готово»», «открыт PR», «просрочена на 2 дн.»… */
export function triggerText(tr: RuleTrigger | undefined, ctx: SummaryCtx): string {
  const k = tr?.kind;
  switch (k?.case) {
    case 'taskCreated':
      return t('rules.sum.created');
    case 'statusChanged': {
      const v = k.value;
      if (v.fromStatusId && v.toStatusId) return t('rules.sum.statusFromTo', { from: or(ctx.status(v.fromStatusId)), to: or(ctx.status(v.toStatusId)) });
      if (v.toStatusId) return t('rules.sum.statusTo', { to: or(ctx.status(v.toStatusId)) });
      if (v.fromStatusId) return t('rules.sum.statusFrom', { from: or(ctx.status(v.fromStatusId)) });
      if (v.toType) return t('rules.sum.statusType', { type: t(STATUS_TYPE[v.toType] ?? 'boards.type.unstarted') });
      return t('rules.sum.status');
    }
    case 'approvalChanged':
      return t(k.value.state === TaskApprovalState.APPROVED ? 'rules.sum.approved' : k.value.state === TaskApprovalState.REJECTED ? 'rules.sum.rejected' : 'rules.sum.approval');
    case 'assigneesChanged': {
      const v = k.value;
      const parts = [v.added ? t('rules.sum.assigneeAdded') : '', v.removed ? t('rules.sum.assigneeRemoved') : '', v.lead ? t('rules.sum.leadChanged') : ''].filter(Boolean);
      return parts.length ? parts.join(t('rules.sum.or')) : t('rules.sum.assignees');
    }
    case 'labelChanged': {
      const v = k.value;
      if (!v.labelId) return t(v.added ? 'rules.sum.anyLabelAdded' : 'rules.sum.anyLabelRemoved');
      return t(v.added ? 'rules.sum.labelAdded' : 'rules.sum.labelRemoved', { name: or(ctx.label(v.labelId)) });
    }
    case 'priorityChanged':
      return k.value.toPriority === undefined ? t('rules.sum.priority') : t('rules.sum.priorityTo', { to: priorityName(k.value.toPriority) });
    case 'checklistCompleted':
      return t('rules.sum.checklist');
    case 'commentCreated':
      return t('rules.sum.comment');
    case 'git':
      return t(GIT[k.value.event] ?? 'rules.sum.git');
    case 'dueIn':
      return k.value.days === 0 ? t('rules.sum.dueToday') : t('rules.sum.dueIn', { n: k.value.days });
    case 'overdue':
      return k.value.days <= 1 ? t('rules.sum.overdue') : t('rules.sum.overdueBy', { n: k.value.days });
    case 'stale':
      return t('rules.sum.stale', { n: k.value.days });
    default:
      return t('rules.sum.none');
  }
}

function people(ids: readonly string[], special: RuleSpecialUser, ctx: SummaryCtx): string {
  const names = ids.map((id) => or(ctx.user(id)));
  if (special === RuleSpecialUser.CREATOR) names.push(t('rules.sum.creator'));
  if (special === RuleSpecialUser.ACTOR) names.push(t('rules.sum.actor'));
  return names.join(', ') || '?';
}

/** «статус → «В работе»», «назначить: Аня, автор», «уведомить исполнителей»… */
export function actionText(a: RuleAction, ctx: SummaryCtx): string {
  const k = a.kind;
  switch (k.case) {
    case 'setStatus':
      return t('rules.sum.setStatus', { to: k.value.statusId ? or(ctx.status(k.value.statusId)) : '?' });
    case 'setAssignees': {
      const v = k.value;
      if (v.mode === RuleAssigneesMode.CLEAR) return t('rules.sum.assignClear');
      const names = people(v.userIds, v.special, ctx);
      return t(v.mode === RuleAssigneesMode.SET ? 'rules.sum.assign' : v.mode === RuleAssigneesMode.REMOVE ? 'rules.sum.assignRemove' : 'rules.sum.assignAdd', { names });
    }
    case 'setLabels': {
      const list = [...k.value.addIds.map((id) => `+${or(ctx.label(id))}`), ...k.value.removeIds.map((id) => `−${or(ctx.label(id))}`)].join(' ');
      return t('rules.sum.labels', { list: list || '?' });
    }
    case 'setPriority':
      return t('rules.sum.setPriority', { to: priorityName(k.value.priority) });
    case 'setDue':
      if (k.value.clear) return t('rules.sum.dueClear');
      return k.value.daysFromNow === 0 ? t('rules.sum.dueSetToday') : t('rules.sum.dueSet', { n: k.value.daysFromNow });
    case 'setApprovers':
      return k.value.userIds.length ? t('rules.sum.approvers', { names: people(k.value.userIds, RuleSpecialUser.UNSPECIFIED, ctx) }) : t('rules.sum.noApprovers');
    case 'addChecklist':
      return t('rules.sum.checklistAdd', { name: k.value.name || '?' });
    case 'comment':
      return t('rules.sum.commentAdd');
    case 'notifyRoom':
      return t('rules.sum.notifyRoom', { room: k.value.roomId ? or(ctx.room(k.value.roomId)) : '?' });
    case 'notifyDm':
      return t('rules.sum.notifyDm', { to: t(RECIPIENT[k.value.to] ?? 'rules.sum.to.assignees') });
    case 'createSubtasks':
      return t('rules.sum.subtasks', { n: k.value.titles.filter((x) => x.trim()).length });
    case 'archive':
      return t('rules.sum.archive');
    default:
      return t('rules.sum.unknown');
  }
}

/** «Когда <trigger>[, если N усл.] → тогда <action>, <action>». */
export function ruleSummary(rule: Pick<BoardRule, 'trigger' | 'condition' | 'actions'>, ctx: SummaryCtx): string {
  const conds = rule.condition?.conditions.length ?? 0;
  const trig = triggerText(rule.trigger, ctx);
  const when = conds > 0 ? t('rules.sumIf', { when: trig, n: conds }) : trig;
  const then = rule.actions.length ? rule.actions.map((a) => actionText(a, ctx)).join(', ') : t('rules.sum.none');
  return t('rules.sum', { when, then });
}
