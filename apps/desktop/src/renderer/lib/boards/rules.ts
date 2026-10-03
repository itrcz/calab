import { create } from '@bufbuild/protobuf';
import {
  BoardStatusType,
  RuleActionSchema,
  RuleAssigneesMode,
  RuleGitEvent,
  RuleRecipients,
  RuleSpecialUser,
  RuleTriggerSchema,
  TaskApprovalState,
  TaskPriority,
  type BoardRule,
  type BoardStatus,
  type RuleAction,
  type RuleTrigger,
} from '@calaba/protocol';
import { t, type MessageKey } from '../../i18n';
import { EMPTY_FILTER, activeConds, fromTaskFilter, type FilterState } from './filter';

/**
 * Board automation rules on the client (ADR-0060 §2, §6): the trigger / action kinds the editor
 * offers, blank values per kind, the editor's validation (the server validates again — 422 with
 * the field), the eight client-side templates and the rules store's pure transitions. Pure.
 */

export type TriggerKind = NonNullable<RuleTrigger['kind']['case']>;
export type ActionKind = NonNullable<RuleAction['kind']['case']>;

export const TRIGGER_KINDS: readonly TriggerKind[] = [
  'taskCreated',
  'statusChanged',
  'approvalChanged',
  'assigneesChanged',
  'labelChanged',
  'priorityChanged',
  'checklistCompleted',
  'commentCreated',
  'git',
  'dueIn',
  'overdue',
  'stale',
];

export const ACTION_KINDS: readonly ActionKind[] = [
  'setStatus',
  'setAssignees',
  'setLabels',
  'setPriority',
  'setDue',
  'setApprovers',
  'addChecklist',
  'comment',
  'notifyRoom',
  'notifyDm',
  'createSubtasks',
  'archive',
];

/** Scheduled triggers that need the board's due dates (409 FEATURE_DISABLED otherwise). */
export const DUE_TRIGGERS: ReadonlySet<TriggerKind> = new Set(['dueIn', 'overdue']);

export const MAX_ACTIONS = 5;
export const MAX_RULES = 20;
export const MAX_NAME = 60;
export const MAX_TEMPLATE = 2000;
export const MAX_RULE_USERS = 10;

export const GIT_EVENTS: ReadonlyArray<{ v: RuleGitEvent; label: MessageKey }> = [
  { v: RuleGitEvent.UNSPECIFIED, label: 'rules.git.any' },
  { v: RuleGitEvent.BRANCH_CREATED, label: 'rules.git.branch' },
  { v: RuleGitEvent.PR_OPENED, label: 'rules.git.prOpened' },
  { v: RuleGitEvent.PR_MERGED, label: 'rules.git.prMerged' },
  { v: RuleGitEvent.PR_CLOSED, label: 'rules.git.prClosed' },
  { v: RuleGitEvent.COMMIT_PUSHED, label: 'rules.git.commit' },
];

export const ASSIGNEE_MODES: ReadonlyArray<{ v: RuleAssigneesMode; label: MessageKey }> = [
  { v: RuleAssigneesMode.SET, label: 'rules.mode.set' },
  { v: RuleAssigneesMode.ADD, label: 'rules.mode.add' },
  { v: RuleAssigneesMode.REMOVE, label: 'rules.mode.remove' },
  { v: RuleAssigneesMode.CLEAR, label: 'rules.mode.clear' },
];

export const RECIPIENTS: ReadonlyArray<{ v: RuleRecipients; label: MessageKey }> = [
  { v: RuleRecipients.ASSIGNEES, label: 'rules.to.assignees' },
  { v: RuleRecipients.LEAD, label: 'rules.to.lead' },
  { v: RuleRecipients.CREATOR, label: 'rules.to.creator' },
  { v: RuleRecipients.APPROVERS, label: 'rules.to.approvers' },
];

export const SPECIAL_USERS: ReadonlyArray<{ v: RuleSpecialUser; label: MessageKey }> = [
  { v: RuleSpecialUser.UNSPECIFIED, label: 'rules.specialNone' },
  { v: RuleSpecialUser.CREATOR, label: 'rules.specialCreator' },
  { v: RuleSpecialUser.ACTOR, label: 'rules.specialActor' },
];

// ------------------------------------------------------------------ blanks

/** A trigger of `kind` with its default parameters. */
export function blankTrigger(kind: TriggerKind): RuleTrigger {
  switch (kind) {
    case 'approvalChanged':
      return create(RuleTriggerSchema, { kind: { case: kind, value: { state: TaskApprovalState.APPROVED } } });
    case 'labelChanged':
      return create(RuleTriggerSchema, { kind: { case: kind, value: { added: true } } });
    case 'dueIn':
      return create(RuleTriggerSchema, { kind: { case: kind, value: { days: 1 } } });
    case 'overdue':
      return create(RuleTriggerSchema, { kind: { case: kind, value: { days: 0 } } });
    case 'stale':
      return create(RuleTriggerSchema, { kind: { case: kind, value: { days: 14 } } });
    default:
      return create(RuleTriggerSchema, { kind: { case: kind, value: {} } });
  }
}

/** An action of `kind` with its default parameters (required fields left for the user). */
export function blankAction(kind: ActionKind): RuleAction {
  switch (kind) {
    case 'setAssignees':
      return create(RuleActionSchema, { kind: { case: kind, value: { mode: RuleAssigneesMode.ADD } } });
    case 'setPriority':
      return create(RuleActionSchema, { kind: { case: kind, value: { priority: TaskPriority.HIGH } } });
    case 'setDue':
      return create(RuleActionSchema, { kind: { case: kind, value: { daysFromNow: 1 } } });
    case 'notifyDm':
      return create(RuleActionSchema, { kind: { case: kind, value: { to: RuleRecipients.ASSIGNEES } } });
    default:
      return create(RuleActionSchema, { kind: { case: kind, value: {} } });
  }
}

// ------------------------------------------------------------------ the editor's draft

export interface RuleDraft {
  name: string;
  enabled: boolean;
  trigger: RuleTrigger;
  condition: FilterState;
  actions: RuleAction[];
}

export function draftOf(r: BoardRule): RuleDraft {
  return {
    name: r.name,
    enabled: r.enabled,
    trigger: r.trigger ?? blankTrigger('taskCreated'),
    condition: r.condition ? fromTaskFilter(r.condition) : EMPTY_FILTER,
    actions: [...r.actions],
  };
}

export const emptyDraft = (): RuleDraft => ({ name: '', enabled: true, trigger: blankTrigger('statusChanged'), condition: EMPTY_FILTER, actions: [blankAction('setStatus')] });

/** Where an editor problem is shown: the name, the trigger, the action list or one action. */
export type IssueAt = 'name' | 'trigger' | 'actions' | `action:${number}`;

export interface RuleIssue {
  at: IssueAt;
  key: MessageKey;
}

/** Code points, as the server counts (utf8.RuneCountInString). */
function runes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) i++;
    n++;
  }
  return n;
}

const textOk = (s: string, max: number): boolean => s.trim().length > 0 && runes(s) <= max;
const lines = (xs: readonly string[]): string[] => xs.map((x) => x.trim()).filter(Boolean);

/** The editor's checks (the server's validateRule, ADR-0060 §3, minus references). */
export function validateDraft(d: RuleDraft): RuleIssue[] {
  const out: RuleIssue[] = [];
  if (!textOk(d.name, MAX_NAME)) out.push({ at: 'name', key: 'rules.err.name' });
  const tr = d.trigger.kind;
  if (!tr.case) out.push({ at: 'trigger', key: 'rules.err.trigger' });
  else if ((tr.case === 'dueIn' || tr.case === 'overdue') && tr.value.days > 30) out.push({ at: 'trigger', key: 'rules.err.days' });
  else if (tr.case === 'stale' && (tr.value.days < 1 || tr.value.days > 90)) out.push({ at: 'trigger', key: 'rules.err.days' });
  if (d.actions.length < 1 || d.actions.length > MAX_ACTIONS) out.push({ at: 'actions', key: 'rules.err.actions' });
  d.actions.forEach((a, i) => {
    const key = actionIssue(a);
    if (key) out.push({ at: `action:${i}`, key });
  });
  return out;
}

/** The first problem of one action, or null. */
export function actionIssue(a: RuleAction): MessageKey | null {
  const k = a.kind;
  switch (k.case) {
    case undefined:
      return 'rules.err.actions';
    case 'setStatus':
      return k.value.statusId ? null : 'rules.err.status';
    case 'setAssignees': {
      const v = k.value;
      if (v.mode === RuleAssigneesMode.UNSPECIFIED) return 'rules.err.mode';
      if (v.userIds.length > MAX_RULE_USERS) return 'rules.err.users';
      if (v.mode !== RuleAssigneesMode.CLEAR && v.userIds.length === 0 && v.special === RuleSpecialUser.UNSPECIFIED) return 'rules.err.users';
      return null;
    }
    case 'setLabels':
      return k.value.addIds.length + k.value.removeIds.length > 0 ? null : 'rules.err.labels';
    case 'setDue':
      return k.value.clear || k.value.daysFromNow <= 365 ? null : 'rules.err.days';
    case 'setApprovers':
      return k.value.userIds.length <= MAX_RULE_USERS ? null : 'rules.err.users';
    case 'addChecklist': {
      const items = lines(k.value.items);
      return textOk(k.value.name, 100) && items.length <= 100 && items.every((x) => runes(x) <= 500) ? null : 'rules.err.checklist';
    }
    case 'comment':
      return textOk(k.value.template, MAX_TEMPLATE) ? null : 'rules.err.text';
    case 'notifyRoom':
      if (!k.value.roomId) return 'rules.err.room';
      return textOk(k.value.template, MAX_TEMPLATE) ? null : 'rules.err.text';
    case 'notifyDm':
      if (k.value.to === RuleRecipients.UNSPECIFIED) return 'rules.err.to';
      return textOk(k.value.template, MAX_TEMPLATE) ? null : 'rules.err.text';
    case 'createSubtasks': {
      const titles = lines(k.value.titles);
      return titles.length >= 1 && titles.length <= 10 && titles.every((x) => runes(x) <= 200) ? null : 'rules.err.subtasks';
    }
    default:
      return null;
  }
}

/**
 * Multi-line fields (checklist items, subtask titles) keep empty lines while typing; the wire
 * form drops them. Returns the actions as they are sent.
 */
export function wireActions(list: readonly RuleAction[]): RuleAction[] {
  return list.map((a) => {
    const k = a.kind;
    if (k.case === 'addChecklist') return { ...a, kind: { case: k.case, value: { ...k.value, name: k.value.name.trim(), items: lines(k.value.items) } } };
    if (k.case === 'createSubtasks') return { ...a, kind: { case: k.case, value: { ...k.value, titles: lines(k.value.titles) } } };
    return a;
  });
}

/** The draft has a condition worth sending (complete conditions only). */
export const hasCondition = (f: FilterState): boolean => activeConds(f).length > 0;

/** A 422 field «actions[2].setStatus.statusId» → where the editor shows it. */
export function issueAtField(field: string | undefined): IssueAt | null {
  if (!field) return null;
  const m = /^actions\[(\d+)\]/.exec(field);
  if (m) return `action:${Number(m[1])}`;
  if (field.startsWith('actions')) return 'actions';
  if (field.startsWith('trigger')) return 'trigger';
  if (field === 'name') return 'name';
  return null;
}

// ------------------------------------------------------------------ templates (ADR-0060 §2)

export type TemplateId = 'approvedToWork' | 'rejectedBack' | 'checklistDone' | 'prOpenedReview' | 'prMergedDone' | 'overdueUrgent' | 'newTaskAssign' | 'staleRemind';

export const TEMPLATES: ReadonlyArray<{ id: TemplateId; label: MessageKey }> = [
  { id: 'approvedToWork', label: 'rules.tpl.approvedToWork' },
  { id: 'rejectedBack', label: 'rules.tpl.rejectedBack' },
  { id: 'checklistDone', label: 'rules.tpl.checklistDone' },
  { id: 'prOpenedReview', label: 'rules.tpl.prOpenedReview' },
  { id: 'prMergedDone', label: 'rules.tpl.prMergedDone' },
  { id: 'overdueUrgent', label: 'rules.tpl.overdueUrgent' },
  { id: 'newTaskAssign', label: 'rules.tpl.newTaskAssign' },
  { id: 'staleRemind', label: 'rules.tpl.staleRemind' },
];

const REVIEW = /ревью|review|revisi[oó]n|审|評/i;

/** The board's first status (by position) of a type, or of a name pattern; '' when none. */
export function statusLike(statuses: readonly Pick<BoardStatus, 'id' | 'name' | 'type' | 'position'>[], type: BoardStatusType | null, name?: RegExp): string {
  const list = [...statuses].sort((a, b) => a.position - b.position);
  if (name) {
    const byName = list.find((s) => name.test(s.name));
    if (byName) return byName.id;
  }
  return type === null ? '' : (list.find((s) => s.type === type)?.id ?? '');
}

const act = (init: Parameters<typeof create<typeof RuleActionSchema>>[1]): RuleAction => create(RuleActionSchema, init);
const trg = (init: Parameters<typeof create<typeof RuleTriggerSchema>>[1]): RuleTrigger => create(RuleTriggerSchema, init);

/**
 * A template as a draft for this board: statuses resolved by type / name where the board has
 * one, otherwise left empty for the user (the editor then asks for it).
 */
export function fromTemplate(id: TemplateId, statuses: readonly Pick<BoardStatus, 'id' | 'name' | 'type' | 'position'>[]): RuleDraft {
  const base = { name: t(TEMPLATES.find((x) => x.id === id)?.label ?? 'rules.new'), enabled: true, condition: EMPTY_FILTER };
  const done = statusLike(statuses, BoardStatusType.COMPLETED);
  const setStatus = (statusId: string): RuleAction => act({ kind: { case: 'setStatus', value: { statusId } } });
  switch (id) {
    case 'approvedToWork':
      return { ...base, trigger: trg({ kind: { case: 'approvalChanged', value: { state: TaskApprovalState.APPROVED } } }), actions: [setStatus(statusLike(statuses, BoardStatusType.STARTED))] };
    case 'rejectedBack':
      return {
        ...base,
        trigger: trg({ kind: { case: 'approvalChanged', value: { state: TaskApprovalState.REJECTED } } }),
        actions: [act({ kind: { case: 'setAssignees', value: { mode: RuleAssigneesMode.SET, special: RuleSpecialUser.CREATOR } } }), setStatus(statusLike(statuses, BoardStatusType.UNSTARTED))],
      };
    case 'checklistDone':
      return { ...base, trigger: trg({ kind: { case: 'checklistCompleted', value: {} } }), actions: [setStatus(done)] };
    case 'prOpenedReview':
      return { ...base, trigger: trg({ kind: { case: 'git', value: { event: RuleGitEvent.PR_OPENED } } }), actions: [setStatus(statusLike(statuses, null, REVIEW))] };
    case 'prMergedDone':
      return { ...base, trigger: trg({ kind: { case: 'git', value: { event: RuleGitEvent.PR_MERGED } } }), actions: [setStatus(done)] };
    case 'overdueUrgent':
      return {
        ...base,
        trigger: trg({ kind: { case: 'overdue', value: { days: 0 } } }),
        actions: [act({ kind: { case: 'setPriority', value: { priority: TaskPriority.URGENT } } }), act({ kind: { case: 'comment', value: { template: t('rules.tpl.overdueText') } } })],
      };
    case 'newTaskAssign':
      return { ...base, trigger: trg({ kind: { case: 'taskCreated', value: {} } }), actions: [act({ kind: { case: 'setAssignees', value: { mode: RuleAssigneesMode.ADD } } })] };
    case 'staleRemind':
      return { ...base, trigger: trg({ kind: { case: 'stale', value: { days: 14 } } }), actions: [act({ kind: { case: 'notifyDm', value: { to: RuleRecipients.ASSIGNEES, template: t('rules.tpl.staleText') } } })] };
  }
}

// ------------------------------------------------------------------ store transitions

export interface RulesData {
  /** Rules by id (every loaded board's). */
  rules: Readonly<Record<string, BoardRule>>;
  /** Board id → its rule ids by position; only boards whose rules were loaded. */
  order: Readonly<Record<string, readonly string[]>>;
}

export const EMPTY_RULES: RulesData = { rules: {}, order: {} };

const byPosition = (rules: Readonly<Record<string, BoardRule>>) => (a: string, b: string): number => {
  const x = rules[a];
  const y = rules[b];
  return (x?.position ?? 0) - (y?.position ?? 0) || (a < b ? -1 : 1);
};

/** GET /boards/{id}/rules: the board's list replaces what was known. */
export function setBoardRules(d: RulesData, boardId: string, list: readonly BoardRule[]): RulesData {
  const rules: Record<string, BoardRule> = {};
  for (const [id, r] of Object.entries(d.rules)) if (r.boardId !== boardId) rules[id] = r;
  for (const r of list) rules[r.id] = d.rules[r.id] && sameRule(d.rules[r.id] as BoardRule, r) ? (d.rules[r.id] as BoardRule) : r;
  const ids = list.map((r) => r.id).sort(byPosition(rules));
  const prev = d.order[boardId];
  return { rules, order: { ...d.order, [boardId]: prev && prev.length === ids.length && prev.every((x, i) => x === ids[i]) ? prev : ids } };
}

/** BOARD_RULE_UPDATE / a REST answer: one rule replaced; the order list changes only when a position does. */
export function upsertRule(d: RulesData, r: BoardRule): RulesData {
  const prev = d.rules[r.id];
  const rules = { ...d.rules, [r.id]: r };
  const ids = d.order[r.boardId];
  // A board whose list is not loaded keeps only the rule (names for the activity feed).
  if (!ids) return { ...d, rules };
  if (prev && prev.position === r.position && ids.includes(r.id)) {
    // A position move of another rule (PATCH shifts the others): re-sort only when needed.
    return { ...d, rules };
  }
  const next = [...ids.filter((x) => x !== r.id), r.id].sort(byPosition(rules));
  return { rules, order: { ...d.order, [r.boardId]: next } };
}

export function removeRule(d: RulesData, ruleId: string, boardId?: string): RulesData {
  const r = d.rules[ruleId];
  const board = boardId ?? r?.boardId;
  const rules = { ...d.rules };
  delete rules[ruleId];
  if (!board || !d.order[board]) return { ...d, rules };
  return { rules, order: { ...d.order, [board]: (d.order[board] ?? []).filter((x) => x !== ruleId) } };
}

/** A local reorder (drag & drop): positions 0..n-1 in the new order, optimistic until PATCH answers. */
export function reorderRules(d: RulesData, boardId: string, ids: readonly string[]): RulesData {
  const rules = { ...d.rules };
  ids.forEach((id, i) => {
    const r = rules[id];
    if (r && r.position !== i) rules[id] = { ...r, position: i };
  });
  return { rules, order: { ...d.order, [boardId]: [...ids] } };
}

function sameRule(a: BoardRule, b: BoardRule): boolean {
  return a.updatedAt?.seconds === b.updatedAt?.seconds && a.updatedAt?.nanos === b.updatedAt?.nanos && a.runsCount === b.runsCount && a.lastError === b.lastError && a.position === b.position && a.enabled === b.enabled;
}

/** Moves `id` to `index` in `ids` (the dragged rule / action). */
export function moveTo<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, x as T);
  return out;
}
