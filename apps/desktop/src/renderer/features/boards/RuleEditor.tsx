import * as Popover from '@radix-ui/react-popover';
import {
  BoardFeature,
  BoardStatusType,
  RoomType,
  RuleAssigneesMode,
  TaskApprovalState,
  type Board,
  type BoardRule,
  type RuleAction,
  type RuleTestResponse,
  type RuleTrigger,
} from '@calaba/protocol';
import {
  Archive,
  Bell,
  CalendarClock,
  CircleDot,
  Flag,
  FlaskConical,
  GripVertical,
  ListChecks,
  ListTree,
  MessageSquare,
  Plus,
  Send,
  ShieldCheck,
  Tag,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Input, Modal, Select, Spinner, Toggle, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { featureOn } from '../../lib/boards/features';
import {
  ACTION_KINDS,
  ASSIGNEE_MODES,
  DUE_TRIGGERS,
  GIT_EVENTS,
  MAX_ACTIONS,
  MAX_NAME,
  MAX_RULE_USERS,
  MAX_TEMPLATE,
  RECIPIENTS,
  SPECIAL_USERS,
  TRIGGER_KINDS,
  blankAction,
  blankTrigger,
  moveTo,
  validateDraft,
  type ActionKind,
  type IssueAt,
  type RuleDraft,
  type TriggerKind,
} from '../../lib/boards/rules';
import { ensureBoardTasks } from '../../services/boards';
import { createRule, saveRule, testRule } from '../../services/automations';
import { useBoards } from '../../stores/boards';
import { roomsOfWorkspace, useRooms } from '../../stores/rooms';
import { memberName } from '../../stores/workspaces';
import { ConditionChips, FilterPopover } from './FilterBar';
import { ApproverMenu, ChoiceMenu, LabelMenu, type Choice } from './menus';
import { Dot, PRIORITIES, PRIORITY_LABEL, STATUS_TYPES, STATUS_TYPE_LABEL, StatusIcon } from './visuals';

/**
 * The rule editor (ADR-0060 §6, docs/08 «Доски»): a 560 px sheet with three blocks — **Когда**
 * (the trigger and its parameters: status / label chips, days), **Если** (the board filter's
 * chips and popover, «+ условие»), **Тогда** (≤ 5 actions, each a row: grip, kind, parameters,
 * ×; dragged to reorder). Below: «Проверить на задаче…» (a dry run of the saved rule on a task
 * of the board) and «Сохранить». Problems show under their block after the first save attempt;
 * a 422 of the server lands on the block its field names. `readOnly`: below Team.
 */
export function RuleEditor({ board, rule, initial, readOnly, onClose }: { board: Board; rule: BoardRule | null; initial: RuleDraft; readOnly: boolean; onClose: () => void }): ReactNode {
  const [d, setD] = useState<RuleDraft>(initial);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<{ at: IssueAt | null; text: string } | null>(null);
  const [savedId, setSavedId] = useState(rule?.id ?? '');
  const [dirty, setDirty] = useState(false);
  const [test, setTest] = useState<{ key: string; res: RuleTestResponse } | null>(null);
  const issues = useMemo(() => validateDraft(d), [d]);
  const issueAt = (at: IssueAt): string | null => {
    if (server && server.at === at) return server.text;
    if (!tried) return null;
    const i = issues.find((x) => x.at === at);
    return i ? t(i.key) : null;
  };
  const set = (patch: Partial<RuleDraft>): void => {
    setD((cur) => ({ ...cur, ...patch }));
    setDirty(true);
    setServer(null);
  };
  const save = async (): Promise<void> => {
    setTried(true);
    if (issues.length) return;
    setBusy(true);
    const r = savedId ? await saveRule(board.workspaceId, savedId, d) : await createRule(board.workspaceId, board.id, d);
    setBusy(false);
    if ('rule' in r) {
      setSavedId(r.rule.id);
      setDirty(false);
      onClose();
      return;
    }
    if (r.error) setServer(r.error);
  };
  const dueOff = !featureOn(board.disabledFeatures, BoardFeature.DUE_DATE);
  const footer = (
    <div className="flex w-full flex-wrap items-center gap-2">
      <TestButton board={board} ruleId={savedId} dirty={dirty} onResult={setTest} />
      <span className="flex-1" />
      <Button variant="secondary" onClick={onClose}>
        {t('common.cancel')}
      </Button>
      {readOnly ? null : (
        <Button busy={busy} onClick={() => void save()} data-testid="rule-save">
          {t('common.save')}
        </Button>
      )}
    </div>
  );
  return (
    <Modal open onClose={onClose} medium title={rule ? t('rules.editTitle') : t('rules.new')} footer={footer}>
      <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-4" data-testid="rule-editor">
        <div className="flex items-end gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-caption font-medium text-muted">{t('rules.name')}</span>
            <Input value={d.name} maxLength={MAX_NAME} placeholder={t('rules.namePlaceholder')} onChange={(e) => set({ name: e.target.value })} data-testid="rule-name" autoFocus={!rule} />
          </label>
          <span className="flex h-7 items-center gap-2 text-caption text-muted">
            {t('rules.enabled')}
            <Toggle label={t('rules.enabled')} checked={d.enabled} onChange={(v) => set({ enabled: v })} disabled={readOnly} />
          </span>
        </div>
        <Problem text={issueAt('name')} />
        {server && server.at === null ? <Problem text={server.text} /> : null}

        <Block title={t('rules.when')} testId="rule-when">
          <Select
            value={d.trigger.kind.case ?? ''}
            onChange={(e) => set({ trigger: blankTrigger(e.target.value as TriggerKind) })}
            aria-label={t('rules.when')}
            data-testid="rule-trigger"
          >
            {TRIGGER_KINDS.map((k) => (
              <option key={k} value={k} disabled={dueOff && DUE_TRIGGERS.has(k) && d.trigger.kind.case !== k}>
                {t(`rules.k.${k}` as MessageKey)}
              </option>
            ))}
          </Select>
          <TriggerParams board={board} trigger={d.trigger} onChange={(trigger) => set({ trigger })} />
          <Problem text={issueAt('trigger')} />
        </Block>

        <Block title={t('rules.if')} hint={t('rules.ifHint')} testId="rule-if">
          <IfBlock board={board} draft={d} onChange={(condition) => set({ condition })} readOnly={readOnly} />
        </Block>

        <Block title={t('rules.then')} testId="rule-then">
          <Actions board={board} actions={d.actions} onChange={(actions) => set({ actions })} issueAt={issueAt} readOnly={readOnly} />
          <Problem text={issueAt('actions')} />
        </Block>
      </fieldset>
      {test ? <TestResult taskKey={test.key} res={test.res} onClose={() => setTest(null)} /> : null}
    </Modal>
  );
}

function Block({ title, hint, children, testId }: { title: string; hint?: string; children: ReactNode; testId: string }): ReactNode {
  return (
    <section className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-[var(--color-card)] p-3" data-testid={testId}>
      <h3 className="flex items-baseline gap-2 text-control font-semibold">
        {title}
        {hint ? <span className="text-caption font-normal text-faint">{hint}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function Problem({ text }: { text: string | null }): ReactNode {
  return text ? (
    <p className="text-caption text-danger-text" role="alert">
      {text}
    </p>
  ) : null;
}

const chipBtn = 'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-line px-2.5 text-control text-fg hover:bg-hover data-[state=open]:bg-active disabled:opacity-50';

function Labeled({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex min-h-7 flex-wrap items-center gap-2">
      <span className="w-28 shrink-0 text-caption text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------------ pickers

/** A status chip with a menu; `any`: the first row is «Любой статус» (''). */
function StatusPick({ board, value, onPick, any = false, testId }: { board: Board; value: string; onPick: (id: string) => void; any?: boolean; testId?: string }): ReactNode {
  const groups = useMemo(() => {
    const items: Choice[] = [...board.statuses]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ id: s.id, search: [s.name], label: s.name, icon: <StatusIcon type={s.type} color={s.color} />, checked: s.id === value }));
    return [{ id: 's', label: '', items: any ? [{ id: '__any', search: [t('rules.anyStatus')], label: t('rules.anyStatus'), checked: !value }, ...items] : items }];
  }, [board.statuses, value, any]);
  const cur = board.statuses.find((s) => s.id === value);
  return (
    <ChoiceMenu groups={groups} onPick={(c) => onPick(c.id === '__any' ? '' : c.id)} placeholder={t('boards.menu.status')} label={t('boards.f.status')} testId="rule-status-menu">
      <button type="button" className={chipBtn} data-testid={testId}>
        {cur ? (
          <>
            <StatusIcon type={cur.type} color={cur.color} /> <span className="truncate">{cur.name}</span>
          </>
        ) : (
          <span className="text-muted">{any ? t('rules.anyStatus') : t('rules.choose')}</span>
        )}
      </button>
    </ChoiceMenu>
  );
}

/** One label (trigger) — «Любой лейбл» first. */
function LabelPick({ board, value, onPick }: { board: Board; value: string; onPick: (id: string) => void }): ReactNode {
  const groups = useMemo(() => {
    const items: Choice[] = [...board.labels].sort((a, b) => a.position - b.position).map((l) => ({ id: l.id, search: [l.name], label: l.name, icon: <Dot color={l.color} />, checked: l.id === value }));
    return [{ id: 'l', label: '', items: [{ id: '__any', search: [t('rules.anyLabel')], label: t('rules.anyLabel'), checked: !value }, ...items] }];
  }, [board.labels, value]);
  const cur = board.labels.find((l) => l.id === value);
  return (
    <ChoiceMenu groups={groups} onPick={(c) => onPick(c.id === '__any' ? '' : c.id)} placeholder={t('boards.addLabel')} label={t('boards.f.label')}>
      <button type="button" className={chipBtn}>
        {cur ? (
          <>
            <Dot color={cur.color} /> <span className="truncate">{cur.name}</span>
          </>
        ) : (
          <span className="text-muted">{t('rules.anyLabel')}</span>
        )}
      </button>
    </ChoiceMenu>
  );
}

/** Several labels (actions): chips of the chosen ones + the board's label menu. */
function LabelsPick({ board, value, onChange }: { board: Board; value: readonly string[]; onChange: (ids: string[]) => void }): ReactNode {
  const chosen = board.labels.filter((l) => value.includes(l.id));
  return (
    <>
      {chosen.map((l) => (
        <span key={l.id} className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line px-2 text-caption">
          <Dot color={l.color} /> {l.name}
        </span>
      ))}
      <LabelMenu boardId={board.id} value={value} canCreate={false} onToggle={(id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])}>
        <button type="button" className={cx(chipBtn, 'text-muted')} aria-label={t('boards.addLabel')}>
          <Plus className="size-3.5" aria-hidden /> {chosen.length ? null : t('rules.choose')}
        </button>
      </LabelMenu>
    </>
  );
}

/** People (≤ 10): names + the approver picker (members, no guests or bots). */
function PeoplePick({ workspaceId, boardId, value, onChange }: { workspaceId: string; boardId: string; value: readonly string[]; onChange: (ids: string[]) => void }): ReactNode {
  return (
    <>
      {value.map((id) => (
        <span key={id} className="inline-flex h-6 items-center gap-1 rounded-full border border-line pl-2 pr-0.5 text-caption">
          {memberName(workspaceId, id)}
          <button type="button" aria-label={t('common.delete')} onClick={() => onChange(value.filter((x) => x !== id))} className="grid size-5 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <ApproverMenu workspaceId={workspaceId} boardId={boardId} value={value} onToggle={(id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : value.length < MAX_RULE_USERS ? [...value, id] : [...value])}>
        <button type="button" className={cx(chipBtn, 'text-muted')} aria-label={t('rules.people')} data-testid="rule-people">
          <Plus className="size-3.5" aria-hidden /> {value.length ? null : t('rules.choose')}
        </button>
      </ApproverMenu>
    </>
  );
}

function DaysInput({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (n: number) => void }): ReactNode {
  return (
    <Input
      type="number"
      min={min}
      max={max}
      value={String(value)}
      onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
      className="w-20"
      aria-label={t('rules.days')}
      data-testid="rule-days"
    />
  );
}

function TextArea({ value, onChange, rows = 3, placeholder, max = MAX_TEMPLATE, label }: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; max?: number; label: string }): ReactNode {
  return (
    <textarea
      value={value}
      rows={rows}
      maxLength={max}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
      className="selectable w-full resize-y rounded-[var(--radius-control)] border border-line bg-elev px-2.5 py-1.5 text-body text-fg outline-none focus-visible:border-accent"
    />
  );
}

// ------------------------------------------------------------------ «Когда»

type TriggerOf<K extends TriggerKind> = Extract<RuleTrigger['kind'], { case: K }>['value'];

function withTrigger<K extends TriggerKind>(tr: RuleTrigger, kind: K, patch: Partial<TriggerOf<K>>): RuleTrigger {
  return { ...tr, kind: { case: kind, value: { ...(tr.kind.value as TriggerOf<K>), ...patch } } as RuleTrigger['kind'] };
}

function TriggerParams({ board, trigger, onChange }: { board: Board; trigger: RuleTrigger; onChange: (tr: RuleTrigger) => void }): ReactNode {
  const k = trigger.kind;
  switch (k.case) {
    case 'statusChanged':
      return (
        <>
          <Labeled label={t('rules.from')}>
            <StatusPick board={board} any value={k.value.fromStatusId} onPick={(id) => onChange(withTrigger(trigger, 'statusChanged', { fromStatusId: id }))} />
          </Labeled>
          <Labeled label={t('rules.to')}>
            <StatusPick board={board} any value={k.value.toStatusId} onPick={(id) => onChange(withTrigger(trigger, 'statusChanged', { toStatusId: id }))} testId="rule-to-status" />
          </Labeled>
          <Labeled label={t('rules.toType')}>
            <Select className="w-48" value={String(k.value.toType)} onChange={(e) => onChange(withTrigger(trigger, 'statusChanged', { toType: Number(e.target.value) }))} aria-label={t('rules.toType')}>
              <option value={BoardStatusType.UNSPECIFIED}>{t('rules.anyType')}</option>
              {STATUS_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {t(STATUS_TYPE_LABEL[ty] ?? 'boards.type.unstarted')}
                </option>
              ))}
            </Select>
          </Labeled>
        </>
      );
    case 'approvalChanged':
      return (
        <Select className="w-56" value={String(k.value.state)} onChange={(e) => onChange(withTrigger(trigger, 'approvalChanged', { state: Number(e.target.value) }))} aria-label={t('rules.k.approvalChanged')}>
          <option value={TaskApprovalState.APPROVED}>{t('rules.stateApproved')}</option>
          <option value={TaskApprovalState.REJECTED}>{t('rules.stateRejected')}</option>
          <option value={TaskApprovalState.UNSPECIFIED}>{t('rules.stateAny')}</option>
        </Select>
      );
    case 'assigneesChanged':
      return (
        <div className="flex flex-wrap gap-1.5">
          {(['added', 'removed', 'lead'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={k.value[f]}
              onClick={() => onChange(withTrigger(trigger, 'assigneesChanged', { [f]: !k.value[f] }))}
              className={cx('h-7 rounded-full px-2.5 text-control', k.value[f] ? 'bg-accent-strong text-accent-fg' : 'border border-line text-muted hover:bg-hover hover:text-fg')}
            >
              {t(f === 'added' ? 'rules.added' : f === 'removed' ? 'rules.removed' : 'rules.lead')}
            </button>
          ))}
        </div>
      );
    case 'labelChanged':
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          <Select className="w-32" value={k.value.added ? '1' : '0'} onChange={(e) => onChange(withTrigger(trigger, 'labelChanged', { added: e.target.value === '1' }))} aria-label={t('rules.k.labelChanged')}>
            <option value="1">{t('rules.added')}</option>
            <option value="0">{t('rules.removed')}</option>
          </Select>
          <LabelPick board={board} value={k.value.labelId} onPick={(id) => onChange(withTrigger(trigger, 'labelChanged', { labelId: id }))} />
        </div>
      );
    case 'priorityChanged':
      return (
        <Select
          className="w-48"
          value={k.value.toPriority === undefined ? '' : String(k.value.toPriority)}
          onChange={(e) => {
            const v = e.target.value;
            const value = v === '' ? {} : { toPriority: Number(v) };
            onChange({ ...trigger, kind: { case: 'priorityChanged', value: { ...k.value, ...value, ...(v === '' ? { toPriority: undefined } : {}) } } });
          }}
          aria-label={t('boards.f.priority')}
        >
          <option value="">{t('rules.anyPriority')}</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {t(PRIORITY_LABEL[p] ?? 'boards.prio.none')}
            </option>
          ))}
        </Select>
      );
    case 'git':
      return (
        <Select className="w-56" value={String(k.value.event)} onChange={(e) => onChange(withTrigger(trigger, 'git', { event: Number(e.target.value) }))} aria-label={t('rules.k.git')} data-testid="rule-git-event">
          {GIT_EVENTS.map((g) => (
            <option key={g.v} value={g.v}>
              {t(g.label)}
            </option>
          ))}
        </Select>
      );
    case 'dueIn':
    case 'overdue':
      return (
        <Labeled label={t('rules.days')}>
          <DaysInput value={k.value.days} min={0} max={30} onChange={(n) => onChange(withTrigger(trigger, k.case, { days: n }))} />
        </Labeled>
      );
    case 'stale':
      return (
        <Labeled label={t('rules.days')}>
          <DaysInput value={k.value.days} min={1} max={90} onChange={(n) => onChange(withTrigger(trigger, 'stale', { days: n }))} />
        </Labeled>
      );
    default:
      return null;
  }
}

// ------------------------------------------------------------------ «Если»

function IfBlock({ board, draft, onChange, readOnly }: { board: Board; draft: RuleDraft; onChange: (f: RuleDraft['condition']) => void; readOnly: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <ConditionChips board={board} workspaceId={board.workspaceId} filter={draft.condition} setFilter={onChange} noMe>
      {readOnly ? null : (
        <FilterPopover board={board} workspaceId={board.workspaceId} filter={draft.condition} setFilter={onChange} open={open} setOpen={setOpen} label={t('rules.if')} noMe>
          <Popover.Trigger asChild>
            <button type="button" className={cx(chipBtn, 'text-muted')} data-testid="rule-add-cond">
              <Plus className="size-3.5" aria-hidden /> {t('rules.addCond')}
            </button>
          </Popover.Trigger>
        </FilterPopover>
      )}
    </ConditionChips>
  );
}

// ------------------------------------------------------------------ «Тогда»

const ACTION_ICON: Record<ActionKind, LucideIcon> = {
  setStatus: CircleDot,
  setAssignees: UserRound,
  setLabels: Tag,
  setPriority: Flag,
  setDue: CalendarClock,
  setApprovers: ShieldCheck,
  addChecklist: ListChecks,
  comment: MessageSquare,
  notifyRoom: Send,
  notifyDm: Bell,
  createSubtasks: ListTree,
  archive: Archive,
};

/** Actions of a disabled board feature are not offered for new rows. */
const ACTION_FEATURE: Partial<Record<ActionKind, BoardFeature>> = {
  setPriority: BoardFeature.PRIORITY,
  setLabels: BoardFeature.LABELS,
  setDue: BoardFeature.DUE_DATE,
  setApprovers: BoardFeature.APPROVALS,
  addChecklist: BoardFeature.CHECKLISTS,
  comment: BoardFeature.COMMENTS,
  createSubtasks: BoardFeature.SUBTASKS,
};

function Actions({ board, actions, onChange, issueAt, readOnly }: { board: Board; actions: RuleAction[]; onChange: (a: RuleAction[]) => void; issueAt: (at: IssueAt) => string | null; readOnly: boolean }): ReactNode {
  const drag = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const offered = ACTION_KINDS.filter((k) => {
    const f = ACTION_FEATURE[k];
    return f === undefined || featureOn(board.disabledFeatures, f);
  });
  const drop = (to: number): void => {
    const from = drag.current;
    drag.current = null;
    setOver(null);
    if (from === null || from === to || from + 1 === to) return;
    onChange(moveTo(actions, from, from < to ? to - 1 : to));
  };
  return (
    <div className="flex flex-col gap-2">
      {actions.map((a, i) => (
        <div
          key={i}
          className={cx('relative flex flex-col gap-2 rounded-[var(--radius-row)] border border-line bg-elev p-2', over === i && 'before:absolute before:-top-[5px] before:left-0 before:right-0 before:h-0.5 before:rounded-full before:bg-accent')}
          onDragOver={(e: DragEvent) => {
            if (drag.current === null) return;
            e.preventDefault();
            setOver(i);
          }}
          onDrop={(e) => {
            e.preventDefault();
            drop(i);
          }}
          data-testid="rule-action"
        >
          <div className="flex items-center gap-2">
            {readOnly ? null : (
              <span
                draggable
                onDragStart={(e) => {
                  drag.current = i;
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => {
                  drag.current = null;
                  setOver(null);
                }}
                onKeyDown={(e) => {
                  if (e.altKey && e.key === 'ArrowUp' && i > 0) onChange(moveTo(actions, i, i - 1));
                  if (e.altKey && e.key === 'ArrowDown' && i < actions.length - 1) onChange(moveTo(actions, i, i + 1));
                }}
                tabIndex={0}
                role="button"
                aria-label={t('rules.moveAction')}
                title={t('rules.drag')}
                className="grid size-6 cursor-grab place-items-center rounded-[var(--radius-icon)] text-faint hover:bg-hover hover:text-fg"
              >
                <GripVertical className="size-4" aria-hidden />
              </span>
            )}
            <ActionGlyph kind={a.kind.case} />
            <Select
              className="w-56"
              value={a.kind.case ?? ''}
              onChange={(e) => onChange(actions.map((x, j) => (j === i ? blankAction(e.target.value as ActionKind) : x)))}
              aria-label={t('rules.then')}
              data-testid="rule-action-kind"
            >
              {ACTION_KINDS.map((k) => (
                <option key={k} value={k} disabled={!offered.includes(k) && a.kind.case !== k}>
                  {t(`rules.a.${k}` as MessageKey)}
                </option>
              ))}
            </Select>
            <span className="flex-1" />
            {readOnly ? null : (
              <button
                type="button"
                aria-label={t('rules.removeAction')}
                disabled={actions.length < 2}
                onClick={() => onChange(actions.filter((_, j) => j !== i))}
                className="grid size-6 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg disabled:opacity-30"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            )}
          </div>
          <ActionParams board={board} action={a} onChange={(next) => onChange(actions.map((x, j) => (j === i ? next : x)))} />
          <Problem text={issueAt(`action:${i}`)} />
        </div>
      ))}
      {readOnly ? null : (
        <div
          className={cx('relative flex items-center gap-2', over === actions.length && 'before:absolute before:-top-[5px] before:left-0 before:right-0 before:h-0.5 before:rounded-full before:bg-accent')}
          onDragOver={(e) => {
            if (drag.current === null) return;
            e.preventDefault();
            setOver(actions.length);
          }}
          onDrop={(e) => {
            e.preventDefault();
            drop(actions.length);
          }}
        >
          <Button variant="secondary" size="sm" disabled={actions.length >= MAX_ACTIONS} onClick={() => onChange([...actions, blankAction(offered.includes('comment') ? 'comment' : 'setStatus')])} data-testid="rule-add-action">
            <Plus className="size-3.5" aria-hidden /> {t('rules.addAction')}
          </Button>
          {actions.length >= MAX_ACTIONS ? <span className="text-caption text-faint">{t('rules.actionsMax')}</span> : null}
        </div>
      )}
    </div>
  );
}

function ActionGlyph({ kind }: { kind: ActionKind | undefined }): ReactNode {
  const Icon = kind ? ACTION_ICON[kind] : CircleDot;
  return <Icon className="size-4 shrink-0 text-muted" aria-hidden />;
}

type ActionOf<K extends ActionKind> = Extract<RuleAction['kind'], { case: K }>['value'];

function withAction<K extends ActionKind>(a: RuleAction, kind: K, patch: Partial<ActionOf<K>>): RuleAction {
  return { ...a, kind: { case: kind, value: { ...(a.kind.value as ActionOf<K>), ...patch } } as RuleAction['kind'] };
}

const linesOf = (s: string): string[] => s.split('\n');

function ActionParams({ board, action, onChange }: { board: Board; action: RuleAction; onChange: (a: RuleAction) => void }): ReactNode {
  const k = action.kind;
  const ws = board.workspaceId;
  switch (k.case) {
    case 'setStatus':
      return (
        <Labeled label={t('rules.to')}>
          <StatusPick board={board} value={k.value.statusId} onPick={(id) => onChange(withAction(action, 'setStatus', { statusId: id }))} testId="rule-action-status" />
        </Labeled>
      );
    case 'setAssignees':
      return (
        <>
          <Labeled label={t('rules.a.setAssignees')}>
            <Select className="w-40" value={String(k.value.mode)} onChange={(e) => onChange(withAction(action, 'setAssignees', { mode: Number(e.target.value) }))} aria-label={t('rules.a.setAssignees')}>
              {ASSIGNEE_MODES.map((m) => (
                <option key={m.v} value={m.v}>
                  {t(m.label)}
                </option>
              ))}
            </Select>
          </Labeled>
          {k.value.mode === RuleAssigneesMode.CLEAR ? null : (
            <>
              <Labeled label={t('rules.people')}>
                <PeoplePick boardId={board.id} workspaceId={ws} value={k.value.userIds} onChange={(ids) => onChange(withAction(action, 'setAssignees', { userIds: ids, leadUserId: ids.includes(k.value.leadUserId) ? k.value.leadUserId : '' }))} />
              </Labeled>
              <Labeled label={t('rules.special')}>
                <Select className="w-48" value={String(k.value.special)} onChange={(e) => onChange(withAction(action, 'setAssignees', { special: Number(e.target.value) }))} aria-label={t('rules.special')}>
                  {SPECIAL_USERS.map((u) => (
                    <option key={u.v} value={u.v}>
                      {t(u.label)}
                    </option>
                  ))}
                </Select>
              </Labeled>
            </>
          )}
        </>
      );
    case 'setLabels':
      return (
        <>
          <Labeled label={t('rules.labelsAdd')}>
            <LabelsPick board={board} value={k.value.addIds} onChange={(ids) => onChange(withAction(action, 'setLabels', { addIds: ids, removeIds: k.value.removeIds.filter((x) => !ids.includes(x)) }))} />
          </Labeled>
          <Labeled label={t('rules.labelsRemove')}>
            <LabelsPick board={board} value={k.value.removeIds} onChange={(ids) => onChange(withAction(action, 'setLabels', { removeIds: ids, addIds: k.value.addIds.filter((x) => !ids.includes(x)) }))} />
          </Labeled>
        </>
      );
    case 'setPriority':
      return (
        <Labeled label={t('boards.f.priority')}>
          <Select className="w-48" value={String(k.value.priority)} onChange={(e) => onChange(withAction(action, 'setPriority', { priority: Number(e.target.value) }))} aria-label={t('boards.f.priority')}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(PRIORITY_LABEL[p] ?? 'boards.prio.none')}
              </option>
            ))}
          </Select>
        </Labeled>
      );
    case 'setDue':
      return (
        <Labeled label={t('rules.dueDays')}>
          {k.value.clear ? null : <DaysInput value={k.value.daysFromNow} min={0} max={365} onChange={(n) => onChange(withAction(action, 'setDue', { daysFromNow: n }))} />}
          <label className="inline-flex items-center gap-2 text-caption text-muted">
            <Toggle label={t('rules.dueClear')} checked={k.value.clear} onChange={(v) => onChange(withAction(action, 'setDue', { clear: v }))} />
            {t('rules.dueClear')}
          </label>
        </Labeled>
      );
    case 'setApprovers':
      return (
        <>
          <Labeled label={t('rules.people')}>
            <PeoplePick boardId={board.id} workspaceId={ws} value={k.value.userIds} onChange={(ids) => onChange(withAction(action, 'setApprovers', { userIds: ids, required: Math.min(k.value.required, ids.length) }))} />
          </Labeled>
          {k.value.userIds.length > 1 ? (
            <Labeled label={t('rules.required')}>
              <Select className="w-32" value={String(k.value.required)} onChange={(e) => onChange(withAction(action, 'setApprovers', { required: Number(e.target.value) }))} aria-label={t('rules.required')}>
                <option value={0}>{t('rules.requiredAll')}</option>
                {k.value.userIds.slice(1).map((_, i) => (
                  <option key={i} value={i + 1}>
                    {i + 1}
                  </option>
                ))}
              </Select>
            </Labeled>
          ) : null}
        </>
      );
    case 'addChecklist':
      return (
        <>
          <Input value={k.value.name} maxLength={100} placeholder={t('rules.checklistName')} onChange={(e) => onChange(withAction(action, 'addChecklist', { name: e.target.value }))} aria-label={t('rules.checklistName')} />
          <TextArea label={t('rules.itemsHint')} placeholder={t('rules.itemsHint')} value={k.value.items.join('\n')} max={50_000} onChange={(v) => onChange(withAction(action, 'addChecklist', { items: linesOf(v) }))} />
        </>
      );
    case 'comment':
      return <TemplateField value={k.value.template} onChange={(v) => onChange(withAction(action, 'comment', { template: v }))} />;
    case 'notifyRoom':
      return (
        <>
          <Labeled label={t('rules.room')}>
            <RoomPick workspaceId={ws} value={k.value.roomId} onPick={(id) => onChange(withAction(action, 'notifyRoom', { roomId: id }))} />
          </Labeled>
          <TemplateField value={k.value.template} onChange={(v) => onChange(withAction(action, 'notifyRoom', { template: v }))} />
        </>
      );
    case 'notifyDm':
      return (
        <>
          <Labeled label={t('rules.recipients')}>
            <Select className="w-48" value={String(k.value.to)} onChange={(e) => onChange(withAction(action, 'notifyDm', { to: Number(e.target.value) }))} aria-label={t('rules.recipients')}>
              {RECIPIENTS.map((r) => (
                <option key={r.v} value={r.v}>
                  {t(r.label)}
                </option>
              ))}
            </Select>
          </Labeled>
          <TemplateField value={k.value.template} onChange={(v) => onChange(withAction(action, 'notifyDm', { template: v }))} />
        </>
      );
    case 'createSubtasks':
      return <TextArea label={t('rules.subtasksHint')} placeholder={t('rules.subtasksHint')} value={k.value.titles.join('\n')} max={5000} onChange={(v) => onChange(withAction(action, 'createSubtasks', { titles: linesOf(v) }))} />;
    default:
      return null;
  }
}

function TemplateField({ value, onChange }: { value: string; onChange: (v: string) => void }): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <TextArea label={t('rules.text')} value={value} onChange={onChange} />
      <span className="text-caption text-faint">{t('rules.vars')}</span>
    </div>
  );
}

/** A text room of the workspace (the author must be able to post there — the server checks). */
function RoomPick({ workspaceId, value, onPick }: { workspaceId: string; value: string; onPick: (id: string) => void }): ReactNode {
  const rooms = useRooms(useShallow((s) => roomsOfWorkspace(s.byId, workspaceId).filter((r) => r.type === RoomType.TEXT).map((r) => `${r.id}\u0000${r.name}`)));
  return (
    <Select className="w-56" value={value} onChange={(e) => onPick(e.target.value)} aria-label={t('rules.room')}>
      <option value="">{t('rules.choose')}</option>
      {rooms.map((x) => {
        const [id = '', name = ''] = x.split('\u0000');
        return (
          <option key={id} value={id}>
            # {name}
          </option>
        );
      })}
    </Select>
  );
}

// ------------------------------------------------------------------ the dry run

/**
 * «Проверить на задаче…»: a task of the board → POST /rules/{id}/test (the saved rule; nothing
 * changes) → «совпало / не совпало» and what each action would do, problems in red.
 */
function TestButton({ board, ruleId, dirty, onResult }: { board: Board; ruleId: string; dirty: boolean; onResult: (r: { key: string; res: RuleTestResponse }) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ids = useBoards(useShallow((s) => (open ? Object.values(s.tasks).filter((x) => x.boardId === board.id && !x.archivedAt).map((x) => x.id) : [])));
  const groups = useMemo(() => {
    const tasks = useBoards.getState().tasks;
    const items: Choice[] = ids.flatMap((id) => {
      const x = tasks[id];
      return x ? [{ id, search: [x.key, x.title], label: `${x.key} ${x.title}` }] : [];
    });
    return [{ id: 't', label: '', items }];
  }, [ids]);
  const run = async (taskId: string): Promise<void> => {
    setBusy(true);
    const res = await testRule(ruleId, taskId);
    setBusy(false);
    if (res) onResult({ key: useBoards.getState().tasks[taskId]?.key ?? '', res });
  };
  return (
    <ChoiceMenu
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (v) void ensureBoardTasks(board.id);
        }}
        groups={groups}
        onPick={(c) => void run(c.id)}
        placeholder={t('boards.menu.task')}
        label={t('rules.testPick')}
        width={320}
        side="top"
        testId="rule-test-menu"
      >
        <Button variant="secondary" disabled={!ruleId || busy} title={!ruleId ? t('rules.testSaveFirst') : dirty ? t('rules.testDirty') : undefined} data-testid="rule-test">
          {busy ? <Spinner className="size-3.5" /> : <FlaskConical className="size-3.5" aria-hidden />} {t('rules.test')}
        </Button>
      </ChoiceMenu>
  );
}

/** The dry run's answer under the blocks: the condition held or not, then each action (problems red). */
function TestResult({ taskKey, res, onClose }: { taskKey: string; res: RuleTestResponse; onClose: () => void }): ReactNode {
  return (
    <section className="mt-4 flex flex-col gap-2 rounded-[var(--radius-card)] border border-line p-3" aria-live="polite" data-testid="rule-test-result" data-matches={res.matches}>
      <div className="flex items-start gap-2">
        <FlaskConical className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <p className={cx('min-w-0 flex-1 text-body font-medium', res.matches ? 'text-[var(--color-green-text)]' : 'text-danger-text')}>{res.matches ? t('rules.testMatch', { key: taskKey }) : t('rules.testNoMatch', { key: taskKey })}</p>
        <button type="button" aria-label={t('common.close')} onClick={onClose} className="grid size-6 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
        <ul className="flex flex-col divide-y divide-[var(--color-card-line)] overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">
          {res.actions.map((a, i) => (
            <li key={i} className="flex flex-col gap-0.5 px-3 py-2">
              <span className="flex items-center gap-2 text-body">
                <ActionGlyph kind={toKind(a.kind)} />
                {a.summary || t(`rules.a.${toKind(a.kind) ?? 'setStatus'}` as MessageKey)}
              </span>
              {a.problem ? <span className="text-caption text-danger-text">{a.problem}</span> : null}
            </li>
          ))}
        </ul>
    </section>
  );
}

/** "set_status" → 'setStatus'. */
function toKind(snake: string): ActionKind | undefined {
  const camel = snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as ActionKind;
  return ACTION_KINDS.includes(camel) ? camel : undefined;
}
