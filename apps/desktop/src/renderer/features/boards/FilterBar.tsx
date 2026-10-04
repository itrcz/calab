import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { TaskField, TaskOp, WorkspaceRole, type Board } from '@calaba/protocol';
import { ArrowLeft, Check, CircleSlash, Filter, X } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { PickerPanel } from '../../components/picker/Picker';
import type { PickerGroup } from '../../components/picker/pickerModel';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { addCond, quickOn, removeCond, resolveDay, setCond, toggleQuick, toggleValue, type Cond, type FilterState, type QuickChip } from '../../lib/boards/filter';
import { estimateName, fieldOff, scaleValues } from '../../lib/boards/features';
import { APPROVAL_VALUES, DATE_PRESETS, FILTER_FIELDS, RELATION_VALUES, fieldDef, opLabel, opNeedsValue, type FieldDef } from '../../lib/boards/filterFields';
import { autoFocusAllowed } from '../../lib/mobile';
import { useBoards } from '../../stores/boards';
import { prefsOf, useBoardsUi } from '../../stores/boardsUi';
import { useWorkspaces } from '../../stores/workspaces';
import { nameOf } from '../people/members';
import { menuBox, menuItem } from '../shell/menu';
import type { Choice } from './menus';
import { useToday } from './menus';
import { useDisabledFeatures } from './useBoardView';
import { Dot, PRIORITIES, PRIORITY_LABEL, PriorityIcon, STATUS_TYPES, STATUS_TYPE_LABEL, STATUS_TYPE_TOKEN, StatusIcon, formatDue } from './visuals';

/**
 * The universal filter (ADR-0042 §3/§5, owner: «фильтры разные обязательно нужны, можно как-то
 * универсально»; Linear «Add Filter»): «Фильтр» (F) opens the field list with a search, a field
 * opens its values (checkboxes, presets, text); applied conditions are chips «Поле · операция ·
 * значения» — a click on the operation switches it, on the values re-opens them, × removes;
 * «все условия / любое», quick chips «Мои / Просрочено / Без исполнителя». Built from the field
 * registry (lib/boards/filterFields.ts): a new field needs no code here unless it is a new kind.
 */
export function useFilter(boardId: string): [FilterState, (f: FilterState) => void] {
  const filter = useBoardsUi((s) => prefsOf(s, boardId).filter);
  const set = (f: FilterState): void => useBoardsUi.getState().setPrefs(boardId, { filter: f });
  return [filter, set];
}

// ------------------------------------------------------------------ values of a field

interface ValueChoice extends Choice {
  value: string;
  /** Picking it sets this op too (EMPTY «Без исполнителя», presets). */
  op?: TaskOp;
}

function useValueChoices(def: FieldDef, board: Board | undefined, workspaceId: string, cond: Cond | null, noMe: boolean): ValueChoice[] {
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const today = useToday();
  return useMemo(() => {
    const on = (v: string): boolean => !!cond?.values.includes(v);
    const c = (value: string, label: string, icon?: ReactNode, op?: TaskOp): ValueChoice => ({ id: `${op ?? ''}:${value}`, value, label, search: [label], ...(icon ? { icon } : {}), checked: op !== undefined ? cond?.op === op : on(value), ...(op !== undefined ? { op } : {}) });
    switch (def.kind) {
      case 'status':
        return [...(board?.statuses ?? [])].sort((a, b) => a.position - b.position).map((s) => c(s.id, s.name, <StatusIcon type={s.type} color={s.color} />));
      case 'statusType':
        return STATUS_TYPES.map((ty) => c(STATUS_TYPE_TOKEN[ty] ?? '', t(STATUS_TYPE_LABEL[ty] ?? 'boards.type.unstarted'), <StatusIcon type={ty} color={0x8e8e93} />));
      case 'user': {
        const list = Object.values(members ?? {}).filter((m) => m.user && m.role !== WorkspaceRole.GUEST);
        const people = list
          .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
          .map((m) => c(m.user?.id ?? '', nameOf(m), <Avatar userId={m.user?.id ?? ''} name={nameOf(m)} {...(m.user?.avatarFileId ? { fileId: m.user.avatarFileId } : {})} size={20} />));
        const extra = def.field === TaskField.ASSIGNEE || def.field === TaskField.LEAD ? [c('', t('boards.noAssignee'), <CircleSlash className="size-4 text-muted" />, TaskOp.EMPTY)] : [];
        return [...(noMe ? [] : [c('me', t('boards.me'))]), ...extra, ...people];
      }
      case 'priority':
        return PRIORITIES.map((p) => c(String(p), t(PRIORITY_LABEL[p] ?? 'boards.prio.none'), <PriorityIcon priority={p} />));
      case 'label':
        return [c('', t('boards.noLabels'), <CircleSlash className="size-4 text-muted" />, TaskOp.EMPTY), ...[...(board?.labels ?? [])].sort((a, b) => a.position - b.position).map((l) => c(l.id, l.name, <Dot color={l.color} />))];
      case 'milestone':
        return [c('', t('boards.noMilestone'), <CircleSlash className="size-4 text-muted" />, TaskOp.EMPTY), ...(board?.milestones ?? []).map((m) => c(m.id, m.name))];
      case 'relation':
        return RELATION_VALUES.map((r) => c(r, t(`boards.rel.${r}` as 'boards.rel.blocks')));
      case 'task':
        return [c('', t('boards.hasParent'), undefined, TaskOp.NOT_EMPTY), c('', t('boards.noParent'), undefined, TaskOp.EMPTY)];
      case 'number':
        return [...scaleValues(board?.estimateScale).map((n) => c(String(n), `> ${estimateName(n, board?.estimateScale)}`, undefined, TaskOp.GT)), c('', t('boards.noEstimate'), undefined, TaskOp.EMPTY)];
      case 'bool':
        return [c('true', t('boards.yes')), c('false', t('boards.no'))];
      case 'approval':
        return APPROVAL_VALUES.map((a) => c(a.value, t(a.label)));
      case 'date':
        return [
          c('today', t('boards.date.overdue'), undefined, TaskOp.BEFORE),
          c('week_end', t('boards.date.dueThisWeek'), undefined, TaskOp.BEFORE),
          c('+7d', t('boards.date.next7'), undefined, TaskOp.BEFORE),
          c('month_end', t('boards.date.dueThisMonth'), undefined, TaskOp.BEFORE),
          c('today', t('boards.date.fromToday'), undefined, TaskOp.AFTER),
          c('', t('boards.date.none'), undefined, TaskOp.EMPTY),
          c('', t('boards.date.any'), undefined, TaskOp.NOT_EMPTY),
        ].map((x, i) => ({ ...x, id: `${i}` }));
      case 'datetime':
        // Instants go to the server as from / to: relative presets are frozen to dates at pick time.
        return DATE_PRESETS.filter((p) => p.value.startsWith('-')).map((p, i) => ({ ...c(resolveDay(p.value, today), t(p.label), undefined, TaskOp.AFTER), id: `d${i}` }));
      default:
        return [];
    }
  }, [def, board, members, cond, today, noMe]);
}

/** The values list of one field; `onChange` receives the edited condition. */
function ValuePanel({ def, board, workspaceId, cond, onChange, onBack, noMe = false }: { def: FieldDef; board: Board | undefined; workspaceId: string; cond: Cond | null; onChange: (c: Cond) => void; onBack?: () => void; noMe?: boolean }): ReactNode {
  const choices = useValueChoices(def, board, workspaceId, cond, noMe);
  const [text, setText] = useState(cond?.field === TaskField.TEXT ? (cond.values[0] ?? '') : '');
  const input = useRef<HTMLInputElement>(null);
  const base: Cond = cond ?? { field: def.field, op: def.op, values: [] };
  if (def.kind === 'text') {
    return (
      <div className="flex flex-col gap-2 p-1">
        {onBack ? <BackRow def={def} onBack={onBack} /> : null}
        <input
          ref={input}
          autoFocus={autoFocusAllowed()}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && text.trim()) onChange({ ...base, op: TaskOp.CONTAINS, values: [text.trim()] });
          }}
          placeholder={t('boards.textPlaceholder')}
          className="selectable h-8 w-full rounded-[var(--radius-control)] border border-line bg-elev px-2.5 text-body outline-none focus-visible:border-accent"
          data-testid="filter-text"
        />
      </div>
    );
  }
  const groups: Array<PickerGroup<ValueChoice>> = [{ id: 'v', label: '', items: choices }];
  return (
    <div className="flex min-h-0 flex-col gap-1">
      {onBack ? <BackRow def={def} onBack={onBack} /> : null}
      <PickerPanel<ValueChoice>
        groups={groups}
        placeholder={t(def.label)}
        label={t(def.label)}
        height={300}
        onSelect={(c) => {
          if (c.op !== undefined) {
            onChange({ ...base, op: c.op, values: c.value ? [c.value] : [] });
            return;
          }
          // A plain value: back to the field's default op after an EMPTY / NOT_EMPTY choice.
          const op = opNeedsValue(base.op) ? base.op : def.op;
          onChange(toggleValue({ ...base, op, values: opNeedsValue(base.op) ? base.values : [] }, c.value));
        }}
        renderItem={(c, active) => (
          <>
            {c.icon ? <span className="grid size-5 shrink-0 place-items-center">{c.icon}</span> : null}
            <span className="min-w-0 flex-1 truncate">{c.label}</span>
            <span className={cx('grid size-4 shrink-0 place-items-center rounded-[4px] border', c.checked ? 'border-transparent bg-accent-strong text-accent-fg' : active ? 'border-current' : 'border-[var(--color-fill-hover)]')}>
              {c.checked ? <Check className="size-3" aria-hidden /> : null}
            </span>
          </>
        )}
        testId="filter-values"
      />
    </div>
  );
}

function BackRow({ def, onBack }: { def: FieldDef; onBack: () => void }): ReactNode {
  const Icon = def.icon;
  return (
    <button type="button" onClick={onBack} className="flex h-7 items-center gap-2 rounded-[var(--radius-row)] px-1.5 text-caption font-medium text-muted hover:bg-hover hover:text-fg">
      <ArrowLeft className="size-3.5" aria-hidden />
      <Icon className="size-3.5" aria-hidden />
      {t(def.label)}
    </button>
  );
}

// ------------------------------------------------------------------ «Фильтр» button

interface FieldChoice extends Choice {
  def: FieldDef;
}

/** «Фильтр» (F): the field list, then the chosen field's values. */
export function FilterButton({ boardId, workspaceId, compact = false }: { boardId: string; workspaceId: string; compact?: boolean }): ReactNode {
  const open = useBoardsUi((s) => s.filterOpen);
  const setOpen = useBoardsUi((s) => s.setFilterOpen);
  const board = useBoards((s) => s.boards[boardId]);
  const [filter, setFilter] = useFilter(boardId);
  return (
    <FilterPopover board={board} workspaceId={workspaceId} filter={filter} setFilter={setFilter} open={open} setOpen={setOpen} label={t('boards.filter')}>
      <Tip label={t('boards.filter')} shortcut="F">
        <Popover.Trigger asChild>
          <button
            type="button"
            className={cx('inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-control text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg', compact && 'px-2')}
            data-testid="filter-button"
          >
            <Filter className="size-3.5" aria-hidden />
            {compact ? null : t('boards.filter')}
          </button>
        </Popover.Trigger>
      </Tip>
    </FilterPopover>
  );
}

/**
 * The field list → values popover over any filter value (the board's filter, a rule's «Если»
 * block, ADR-0060 §6). `children` holds the `Popover.Trigger`. `noMe`: no «Я» among people (a
 * rule has no viewer).
 */
export function FilterPopover({
  board,
  workspaceId,
  filter,
  setFilter,
  open,
  setOpen,
  label,
  noMe = false,
  children,
}: {
  board: Board | undefined;
  workspaceId: string;
  filter: FilterState;
  setFilter: (f: FilterState) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  label: string;
  noMe?: boolean;
  children: ReactNode;
}): ReactNode {
  const [field, setField] = useState<TaskField | null>(null);
  const [index, setIndex] = useState<number>(-1);
  const input = useRef<HTMLInputElement>(null);
  // Fields of a disabled board feature are not offered (ADR-0058 §3).
  const disabled = board?.disabledFeatures;
  const fields = useMemo((): Array<PickerGroup<FieldChoice>> => {
    const Icon = (d: FieldDef): ReactNode => <d.icon className="size-4 text-muted" aria-hidden />;
    return [{ id: 'f', label: '', items: FILTER_FIELDS.filter((d) => !d.hidden && !fieldOff(disabled, d.field)).map((d) => ({ id: String(d.field), def: d, label: t(d.label), search: [t(d.label)], icon: Icon(d) })) }];
  }, [disabled]);
  const def = field !== null ? fieldDef(field) : undefined;
  const cond = index >= 0 ? (filter.conds[index] ?? null) : null;
  const change = (c: Cond): void => {
    if (index >= 0) setFilter(setCond(filter, index, c));
    else {
      const next = addCond(filter, c.field, c.values);
      setFilter(setCond(next, next.conds.length - 1, c));
      setIndex(next.conds.length - 1);
    }
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setField(null);
          setIndex(-1);
        }
      }}
      modal={false}
    >
      {children}
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (autoFocusAllowed()) input.current?.focus();
          }}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label={label}
          className="mat-popover anim-in z-[var(--z-modal-popover)] flex w-[280px] flex-col rounded-[var(--radius-card)] p-1.5"
          style={{ maxHeight: 'var(--radix-popover-content-available-height)' }}
          data-testid="filter-menu"
        >
          {def ? (
            <ValuePanel
              def={def}
              board={board}
              workspaceId={workspaceId}
              cond={cond}
              onChange={change}
              noMe={noMe}
              onBack={() => {
                setField(null);
                setIndex(-1);
              }}
            />
          ) : (
            <PickerPanel<FieldChoice>
              groups={fields}
              inputRef={input}
              autoFocus={false}
              placeholder={t('boards.addFilter')}
              label={label}
              height={360}
              onSelect={(c) => {
                setField(c.def.field);
                setIndex(-1);
              }}
              renderItem={(c) => (
                <>
                  <span className="grid size-5 shrink-0 place-items-center">{c.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                </>
              )}
              testId="filter-fields"
            />
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ------------------------------------------------------------------ chips

function valueText(c: Cond, board: Board | undefined, workspaceId: string, today: string): string {
  const def = fieldDef(c.field);
  if (!def || !opNeedsValue(c.op)) return '';
  const name = (v: string): string => {
    switch (def.kind) {
      case 'status':
        return board?.statuses.find((s) => s.id === v)?.name ?? '?';
      case 'statusType': {
        const ty = STATUS_TYPES.find((x) => STATUS_TYPE_TOKEN[x] === v);
        return ty ? t(STATUS_TYPE_LABEL[ty] ?? 'boards.type.unstarted') : v;
      }
      case 'user': {
        if (v === 'me') return t('boards.me');
        const m = useWorkspaces.getState().byId[workspaceId]?.members[v];
        return m ? nameOf(m) : '?';
      }
      case 'priority':
        return t(PRIORITY_LABEL[Number(v)] ?? 'boards.prio.none');
      case 'label':
        return board?.labels.find((l) => l.id === v)?.name ?? '?';
      case 'milestone':
        return board?.milestones.find((m) => m.id === v)?.name ?? '?';
      case 'relation':
        return t(`boards.rel.${v}` as 'boards.rel.blocks');
      case 'bool':
        return v === 'true' ? t('boards.yes') : t('boards.no');
      case 'approval': {
        const a = APPROVAL_VALUES.find((x) => x.value === v);
        return a ? t(a.label) : v;
      }
      case 'date':
      case 'datetime': {
        const preset = DATE_PRESETS.find((p) => p.value === v);
        return preset ? t(preset.label) : formatDue(resolveDay(v, today), today);
      }
      default:
        return v;
    }
  };
  const vals = c.values.filter((v) => v !== '');
  if (vals.length > 2) return t('boards.nValues', { first: name(vals[0] ?? ''), n: vals.length - 1 });
  return vals.map(name).join(', ');
}

/** The applied conditions, «все / любое», quick chips, «Сбросить». */
export function FilterChips({ boardId, workspaceId }: { boardId: string; workspaceId: string }): ReactNode {
  const [filter, setFilter] = useFilter(boardId);
  const board = useBoards((s) => s.boards[boardId]);
  if (filter.conds.length === 0) return null;
  return <ConditionChips board={board} workspaceId={workspaceId} filter={filter} setFilter={setFilter} className="px-4 pb-2" />;
}

/** Condition chips of any filter value (the board's, a rule's «Если» block); `children` after them. */
export function ConditionChips({ board, workspaceId, filter, setFilter, className, noMe = false, children }: { board: Board | undefined; workspaceId: string; filter: FilterState; setFilter: (f: FilterState) => void; className?: string; noMe?: boolean; children?: ReactNode }): ReactNode {
  const today = useToday();
  return (
    <div className={cx('flex min-w-0 flex-wrap items-center gap-1.5', className)} data-testid="filter-chips">
      {filter.conds.map((c, i) => (
        <FilterChip key={i} cond={c} board={board} workspaceId={workspaceId} noMe={noMe} text={valueText(c, board, workspaceId, today)} onChange={(n) => setFilter(setCond(filter, i, n))} onRemove={() => setFilter(removeCond(filter, i))} />
      ))}
      {filter.conds.length > 1 ? (
        <button
          type="button"
          onClick={() => setFilter({ ...filter, any: !filter.any })}
          className="h-6 rounded-full px-2 text-caption text-muted hover:bg-hover hover:text-fg"
          data-testid="filter-any"
          title={t('boards.anyHint')}
        >
          {filter.any ? t('boards.anyCond') : t('boards.allConds')}
        </button>
      ) : null}
      {filter.conds.length > 0 ? (
        <button type="button" onClick={() => setFilter({ conds: [], any: false })} className="h-6 rounded-full px-2 text-caption text-muted hover:bg-hover hover:text-fg" data-testid="filter-reset">
          {t('common.reset')}
        </button>
      ) : null}
      {children}
    </div>
  );
}

function FilterChip({ cond, board, workspaceId, text, onChange, onRemove, noMe }: { cond: Cond; board: Board | undefined; workspaceId: string; text: string; onChange: (c: Cond) => void; onRemove: () => void; noMe: boolean }): ReactNode {
  const def = fieldDef(cond.field);
  const [open, setOpen] = useState(false);
  if (!def) return null;
  const Icon = def.icon;
  const seg = 'inline-flex h-6 items-center gap-1 px-2 hover:bg-hover';
  // A condition on a disabled feature still filters (the server counts it as is, ADR-0058 §3).
  const off = fieldOff(board?.disabledFeatures, cond.field);
  return (
    <span className={cx('inline-flex h-6 max-w-full items-center overflow-hidden rounded-full border text-caption text-fg', off ? 'border-dashed border-line' : 'border-line')} title={off ? t('boards.feat.chipOffHint') : undefined} data-testid="filter-chip" data-off={off || undefined}>
      <span className="inline-flex h-6 items-center gap-1 pl-2 pr-1.5 text-muted">
        <Icon className="size-3.5" aria-hidden />
        {t(def.label)}
        {off ? <span className="text-faint">· {t('boards.feat.chipOff')}</span> : null}
      </span>
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <button type="button" className={cx(seg, 'border-l border-line text-muted')} data-testid="filter-chip-op">
            {t(opLabel(cond.op, cond.values.length))}
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={cx(menuBox, 'w-48')} sideOffset={4} align="start">
            {def.ops.map((op) => (
              <Dropdown.Item key={op} className={menuItem} onSelect={() => onChange({ ...cond, op, values: opNeedsValue(op) ? cond.values : [] })}>
                {cond.op === op ? <Check className="size-3.5" aria-hidden /> : <span className="size-3.5" />}
                {t(opLabel(op, cond.values.length))}
              </Dropdown.Item>
            ))}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      {opNeedsValue(cond.op) ? (
        <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
          <Popover.Trigger asChild>
            <button type="button" className={cx(seg, 'min-w-0 border-l border-line font-medium')} data-testid="filter-chip-values">
              <span className="truncate">{text || t('boards.chooseValue')}</span>
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="start" sideOffset={4} collisionPadding={8} onKeyDown={(e) => e.stopPropagation()} className="mat-popover anim-in z-[var(--z-modal-popover)] flex w-[280px] flex-col rounded-[var(--radius-card)] p-1.5">
              <ValuePanel def={def} board={board} workspaceId={workspaceId} cond={cond} onChange={onChange} noMe={noMe} />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
      <button type="button" onClick={onRemove} aria-label={t('boards.removeFilter')} className="grid h-6 w-6 place-items-center border-l border-line text-muted hover:bg-hover hover:text-fg" data-testid="filter-chip-remove">
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}

const QUICK: ReadonlyArray<{ chip: QuickChip; label: 'boards.quick.mine' | 'boards.quick.overdue' | 'boards.quick.unassigned' | 'boards.quick.approval' }> = [
  { chip: 'mine', label: 'boards.quick.mine' },
  { chip: 'overdue', label: 'boards.quick.overdue' },
  { chip: 'unassigned', label: 'boards.quick.unassigned' },
  { chip: 'approval', label: 'boards.quick.approval' },
];

/** «Мои», «Просрочено», «Без исполнителя», «Ждут моего согласования» (ADR-0049). */
export function QuickChips({ boardId }: { boardId: string }): ReactNode {
  const [filter, setFilter] = useFilter(boardId);
  const disabled = useDisabledFeatures(boardId);
  return (
    <div className="flex shrink-0 items-center gap-1" role="group" aria-label={t('boards.quick')}>
      {QUICK.map((q) => {
        const on = quickOn(filter, q.chip);
        // «Просрочено» needs due dates, «Ждут моего согласования» approvals (ADR-0058 §3); an applied one stays to switch off.
        if (!on && ((q.chip === 'overdue' && fieldOff(disabled, TaskField.DUE_ON)) || (q.chip === 'approval' && fieldOff(disabled, TaskField.APPROVER_PENDING)))) return null;
        return (
          <button
            key={q.chip}
            type="button"
            aria-pressed={on}
            onClick={() => setFilter(toggleQuick(filter, q.chip))}
            className={cx('h-7 rounded-full px-2.5 text-control transition-colors duration-[var(--motion-fast)]', on ? 'bg-accent-strong text-accent-fg' : 'text-muted hover:bg-hover hover:text-fg')}
            data-testid={`quick-${q.chip}`}
          >
            {t(q.label)}
          </button>
        );
      })}
    </div>
  );
}

