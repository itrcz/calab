import * as Popover from '@radix-ui/react-popover';
import { type BoardStatus, type EstimateScale, type TaskPriority } from '@calaba/protocol';
import { Check, ChevronLeft, ChevronRight, CircleSlash, Diamond, Plus, Send, UserRound } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Avatar } from '../../components/Avatar';
import { PickerPanel } from '../../components/picker/Picker';
import type { PickerGroup, PickerItem } from '../../components/picker/pickerModel';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { addDays, addMonths, dayKey, formatMonth, monthGrid, monthOf, weekStart, weekdayNames } from '../../lib/calendar/time';
import { MAX_APPROVERS } from '../../lib/boards/approvals';
import { estimateName, isSized, scaleValues } from '../../lib/boards/features';
import { autoFocusAllowed } from '../../lib/mobile';
import { createLabel } from '../../services/boards';
import { accessChoice, pickerAccess, type PickerAccess } from '../../lib/boards/access';
import { useBoards } from '../../stores/boards';
import { useUi } from '../../stores/ui';
import { useWorkspaces } from '../../stores/workspaces';
import { nameOf } from '../people/members';
import { useToday } from '../calendar/MiniCalendar';
import { doneType } from './model';
import { Dot, PALETTE, PRIORITIES, PRIORITY_LABEL, PriorityIcon, StatusIcon, colorCss, formatDue } from './visuals';

/**
 * Property menus of a task (ADR-0042 §5, as in Linear): status, priority, assignees, labels,
 * milestone, estimate and due date — each a popover opened in place (a card element, a panel
 * row, a list cell, the create dialog's chips, a hotkey), keyboard-driven (search by typing,
 * ↑↓, Enter; digits in the status / priority menus), closed by Esc. Pure pickers: the caller
 * applies the choice (services/boards.ts).
 */

export interface Choice extends PickerItem {
  label: string;
  icon?: ReactNode;
  checked?: boolean;
  /** Muted text before the check (counts). */
  note?: string;
  /** Secondary caption after the name («увидит только эту карточку», ADR-0059); `title` is its tooltip. */
  caption?: string;
  title?: string;
}

interface MenuShell {
  children: ReactNode;
  /** Controlled open state (hotkeys); uncontrolled when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
}

function useOpen(p: MenuShell): [boolean, (v: boolean) => void] {
  const [own, setOwn] = useState(false);
  const open = p.open ?? own;
  const set = (v: boolean): void => {
    if (p.open === undefined) setOwn(v);
    p.onOpenChange?.(v);
  };
  return [open, set];
}

/** The popover every property menu uses: a search field over choice rows (PickerPanel). */
export function ChoiceMenu({
  groups,
  onPick,
  placeholder,
  label,
  digits = false,
  multi = false,
  width = 260,
  testId,
  onInput,
  footer,
  ...shell
}: MenuShell & {
  groups: ReadonlyArray<PickerGroup<Choice>>;
  onPick: (c: Choice) => void;
  placeholder: string;
  label: string;
  digits?: boolean;
  /** Several choices: a pick keeps the menu open (labels, assignees). */
  multi?: boolean;
  width?: number;
  testId?: string;
  onInput?: (text: string) => void;
  footer?: ReactNode;
}): ReactNode {
  const [open, setOpen] = useOpen(shell);
  const input = useRef<HTMLInputElement>(null);
  const index = useMemo(() => {
    const m = new Map<string, number>();
    let n = 0;
    for (const g of groups) for (const c of g.items) if (!c.disabled) m.set(`${g.id}:${c.id}`, ++n);
    return m;
  }, [groups]);
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger asChild>{shell.children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={shell.side ?? 'bottom'}
          align={shell.align ?? 'start'}
          sideOffset={4}
          collisionPadding={8}
          aria-label={label}
          data-testid={testId}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (autoFocusAllowed()) input.current?.focus();
          }}
          // A card under the menu must not receive the click that closes it.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="mat-popover anim-in z-[var(--z-modal-popover)] flex flex-col rounded-[var(--radius-card)] p-1.5"
          style={{ width, maxHeight: 'var(--radix-popover-content-available-height)' }}
        >
          <PickerPanel<Choice>
            groups={groups}
            inputRef={input}
            autoFocus={false}
            placeholder={placeholder}
            label={label}
            digits={digits}
            height={320}
            {...(onInput ? { onInput } : {})}
            onSelect={(c) => {
              onPick(c);
              if (!multi) setOpen(false);
            }}
            renderItem={(c, active) => (
              <>
                {c.icon ? <span className="grid size-5 shrink-0 place-items-center">{c.icon}</span> : null}
                <span className="min-w-0 flex-1 truncate" {...(c.title ? { title: c.title } : {})}>
                  {c.label}
                </span>
                {c.caption ? <span className={cx('shrink-0 text-caption', active ? 'opacity-75' : 'text-muted')}>{c.caption}</span> : null}
                {c.note ? <span className={cx('shrink-0 text-caption tabular-nums', active ? 'opacity-75' : 'text-muted')}>{c.note}</span> : null}
                {c.checked ? <Check className="size-3.5 shrink-0" aria-label={t('boards.selected')} /> : <span className="size-3.5 shrink-0" />}
                {digits ? (
                  <span className={cx('w-3 shrink-0 text-right text-caption tabular-nums', active ? 'opacity-75' : 'text-faint')}>
                    {(() => {
                      const n = [...index.entries()].find(([k]) => k.endsWith(`:${c.id}`))?.[1] ?? 0;
                      return n > 0 && n < 10 ? n : '';
                    })()}
                  </span>
                ) : null}
              </>
            )}
          />
          {footer}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ------------------------------------------------------------------ status / priority

/**
 * `blocked`: statuses the task may not go to now (ADR-0049: not approved yet) — shown disabled
 * with the hint «нужно согласование».
 */
export function StatusMenu({ boardId, value, onPick, blocked, ...shell }: MenuShell & { boardId: string; value: string; onPick: (statusId: string) => void; blocked?: ReadonlySet<string> | undefined }): ReactNode {
  const statuses = useBoards(useShallow((s) => s.boards[boardId]?.statuses ?? NO_STATUSES));
  const groups = useMemo(
    () => [
      {
        id: 's',
        label: '',
        items: [...statuses]
          .sort((a, b) => a.position - b.position)
          .map((s): Choice => {
            const off = !!blocked?.has(s.id);
            return { id: s.id, search: [s.name], label: s.name, icon: <StatusIcon type={s.type} color={s.color} />, checked: s.id === value, ...(off ? { disabled: true, note: t('boards.gate.hint') } : {}) };
          }),
      },
    ],
    [statuses, value, blocked],
  );
  return <ChoiceMenu {...shell} groups={groups} onPick={(c) => onPick(c.id)} placeholder={t('boards.menu.status')} label={t('boards.f.status')} digits testId="status-menu" />;
}

const NO_STATUSES: BoardStatus[] = [];

export function PriorityMenu({ value, onPick, ...shell }: MenuShell & { value: TaskPriority; onPick: (p: TaskPriority) => void }): ReactNode {
  const groups = useMemo(
    () => [
      {
        id: 'p',
        label: '',
        items: PRIORITIES.map((p): Choice => ({ id: String(p), search: [t(PRIORITY_LABEL[p] ?? 'boards.prio.none')], label: t(PRIORITY_LABEL[p] ?? 'boards.prio.none'), icon: <PriorityIcon priority={p} />, checked: p === value })),
      },
    ],
    [value],
  );
  return <ChoiceMenu {...shell} groups={groups} onPick={(c) => onPick(Number(c.id))} placeholder={t('boards.menu.priority')} label={t('boards.f.priority')} digits testId="priority-menu" />;
}

// ------------------------------------------------------------------ assignees

/** Open tasks per member on the board (the «Назначить…» counts, as in Linear). */
function useAssigneeCounts(boardId: string, open: boolean): Record<string, number> {
  const tasks = useBoards((s) => (open ? s.tasks : null));
  const board = useBoards((s) => s.boards[boardId]);
  return useMemo(() => {
    const out: Record<string, number> = {};
    if (!tasks || !board) return out;
    const done = new Set(board.statuses.filter((s) => doneType(s.type)).map((s) => s.id));
    for (const x of Object.values(tasks)) {
      if (x.boardId !== boardId || x.archivedAt || done.has(x.statusId)) continue;
      for (const a of x.assignees) out[a.userId] = (out[a.userId] ?? 0) + 1;
    }
    return out;
  }, [tasks, board, boardId]);
}

export function AssigneeMenu({
  workspaceId,
  boardId,
  value,
  onToggle,
  onNone,
  ...shell
}: MenuShell & { workspaceId: string; boardId: string; value: readonly string[]; onToggle: (userId: string) => void; onNone: () => void }): ReactNode {
  const [open, setOpen] = useOpen(shell);
  // Only while open: a closed menu on every card must not re-render on presence / voice changes.
  const members = useWorkspaces((s) => (open ? s.byId[workspaceId]?.members : undefined));
  const roles = useWorkspaces((s) => (open ? s.byId[workspaceId]?.roles : undefined));
  const board = useBoards((s) => (open ? s.boards[boardId] : undefined));
  const counts = useAssigneeCounts(boardId, open);
  const openDialog = useUi((s) => s.openDialog);
  const groups = useMemo((): Array<PickerGroup<Choice>> => {
    // ADR-0059: every non-guest member (a bot only when it sees the board).
    const access = new Map<string, PickerAccess>();
    const list = Object.values(members ?? {}).filter((m) => {
      if (!m.user) return false;
      const a = pickerAccess(board, roles ?? [], m);
      access.set(m.user.id, a);
      return a !== 'hidden' || value.includes(m.user.id);
    });
    const person = (id: string, name: string, fileId: string): Choice => ({
      id,
      search: [name],
      label: name,
      icon: <Avatar userId={id} name={name} {...(fileId ? { fileId } : {})} size={20} />,
      checked: value.includes(id),
      note: String(counts[id] ?? 0),
      ...accessChoice(access.get(id), value.includes(id)),
    });
    const chosen = list.filter((m) => value.includes(m.user?.id ?? '')).map((m) => person(m.user?.id ?? '', nameOf(m), m.user?.avatarFileId ?? ''));
    const others = list
      .filter((m) => !value.includes(m.user?.id ?? ''))
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
      .map((m) => person(m.user?.id ?? '', nameOf(m), m.user?.avatarFileId ?? ''));
    return [
      { id: 'none', label: '', items: [{ id: '__none', search: [t('boards.noAssignee')], label: t('boards.noAssignee'), icon: <CircleSlash className="size-4 text-muted" />, checked: value.length === 0, note: '' }] },
      { id: 'chosen', label: '', items: chosen },
      { id: 'members', label: t('boards.members'), items: others },
      { id: 'invite', label: t('boards.newUser'), items: [{ id: '__invite', search: [t('boards.inviteAssign')], label: t('boards.inviteAssign'), icon: <Send className="size-4 text-muted" /> }] },
    ];
  }, [members, roles, board, value, counts]);
  return (
    <ChoiceMenu
      {...shell}
      open={open}
      onOpenChange={setOpen}
      multi
      width={340}
      groups={groups}
      onPick={(c) => {
        if (c.id === '__none') onNone();
        else if (c.id === '__invite') {
          setOpen(false);
          openDialog({ kind: 'workspace-settings', workspaceId, tab: 'invites' });
        } else onToggle(c.id);
      }}
      placeholder={t('boards.menu.assign')}
      label={t('boards.f.assignee')}
      testId="assignee-menu"
    />
  );
}

/**
 * «+ Согласующий» (ADR-0049): the assignee picker's people — members who see the workspace, no
 * guests, no bots — at most 10 (the rest disabled once full). The server checks board access.
 */
export function ApproverMenu({
  workspaceId,
  boardId,
  value,
  onToggle,
  ...shell
}: MenuShell & { workspaceId: string; boardId: string; value: readonly string[]; onToggle: (userId: string) => void }): ReactNode {
  const [open, setOpen] = useOpen(shell);
  const members = useWorkspaces((s) => (open ? s.byId[workspaceId]?.members : undefined));
  const roles = useWorkspaces((s) => (open ? s.byId[workspaceId]?.roles : undefined));
  const board = useBoards((s) => (open ? s.boards[boardId] : undefined));
  const groups = useMemo((): Array<PickerGroup<Choice>> => {
    const full = value.length >= MAX_APPROVERS;
    const access = new Map<string, PickerAccess>();
    const list = Object.values(members ?? {}).filter((m) => {
      if (!m.user) return false;
      const a = pickerAccess(board, roles ?? [], m);
      access.set(m.user.id, a);
      // A bot only when it sees the board; a guest never (ADR-0059).
      return a !== 'hidden' && (!m.user.isBot || a === 'ok');
    });
    const person = (id: string, name: string, fileId: string): Choice => {
      const on = value.includes(id);
      const acc = accessChoice(access.get(id), on);
      return {
        ...acc,
        id,
        search: [name],
        label: name,
        icon: <Avatar userId={id} name={name} {...(fileId ? { fileId } : {})} size={20} />,
        checked: on,
        ...(full && !on ? { disabled: true, note: t('boards.approversMax') } : {}),
      };
    };
    const chosen = value.flatMap((id) => {
      const m = list.find((x) => x.user?.id === id);
      return m ? [person(id, nameOf(m), m.user?.avatarFileId ?? '')] : [];
    });
    const others = list
      .filter((m) => !value.includes(m.user?.id ?? ''))
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
      .map((m) => person(m.user?.id ?? '', nameOf(m), m.user?.avatarFileId ?? ''));
    return [
      { id: 'chosen', label: '', items: chosen },
      { id: 'members', label: t('boards.members'), items: others },
    ];
  }, [members, roles, board, value]);
  return (
    <ChoiceMenu
      {...shell}
      open={open}
      onOpenChange={setOpen}
      multi
      width={340}
      groups={groups}
      onPick={(c) => onToggle(c.id)}
      placeholder={t('boards.approverMenu')}
      label={t('boards.approvals')}
      testId="approver-menu"
    />
  );
}

// ------------------------------------------------------------------ labels

export function LabelMenu({ boardId, value, onToggle, canCreate, ...shell }: MenuShell & { boardId: string; value: readonly string[]; onToggle: (labelId: string) => void; canCreate: boolean }): ReactNode {
  const labels = useBoards(useShallow((s) => s.boards[boardId]?.labels ?? NO_LABELS));
  const [text, setText] = useState('');
  const [open, setOpen] = useOpen(shell);
  // A closed menu forgets its query (derived during render, no effect round trip).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setText('');
  }
  const groups = useMemo((): Array<PickerGroup<Choice>> => {
    const items = [...labels]
      .sort((a, b) => a.position - b.position)
      .map((l): Choice => ({ id: l.id, search: [l.name], label: l.name, icon: <Dot color={l.color} />, checked: value.includes(l.id) }));
    const q = text.trim();
    const exists = labels.some((l) => l.name.toLowerCase() === q.toLowerCase());
    const create: Choice[] = canCreate && q && !exists ? [{ id: '__create', search: [q], label: t('boards.createLabel', { name: q }), icon: <Plus className="size-4 text-muted" /> }] : [];
    return [
      { id: 'l', label: '', items },
      { id: 'c', label: '', items: create },
    ];
  }, [labels, value, text, canCreate]);
  return (
    <ChoiceMenu
      {...shell}
      open={open}
      onOpenChange={setOpen}
      multi
      groups={groups}
      onInput={setText}
      onPick={(c) => {
        if (c.id !== '__create') {
          onToggle(c.id);
          return;
        }
        const name = text.trim();
        const color = PALETTE[(labels.length * 5 + 2) % PALETTE.length] ?? 0x0a84ff;
        void createLabel(boardId, { name, color }).then((b) => {
          const made = b?.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
          if (made) onToggle(made.id);
        });
      }}
      placeholder={t('boards.menu.label')}
      label={t('boards.f.label')}
      testId="label-menu"
    />
  );
}

const NO_LABELS: never[] = [];

// ------------------------------------------------------------------ milestone / estimate

export function MilestoneMenu({ boardId, value, onPick, ...shell }: MenuShell & { boardId: string; value: string; onPick: (id: string) => void }): ReactNode {
  const list = useBoards(useShallow((s) => s.boards[boardId]?.milestones ?? NO_LABELS));
  const today = useToday();
  const groups = useMemo(
    () => [
      { id: 'none', label: '', items: [{ id: '', search: [t('boards.noMilestone')], label: t('boards.noMilestone'), icon: <CircleSlash className="size-4 text-muted" />, checked: !value }] },
      {
        id: 'm',
        label: '',
        items: [...list]
          .sort((a, b) => a.position - b.position)
          .map((m): Choice => ({ id: m.id, search: [m.name], label: m.name, icon: <Diamond className="size-3.5 text-muted" />, checked: m.id === value, note: m.dueOn ? formatDue(m.dueOn, today) : '' })),
      },
    ],
    [list, value, today],
  );
  return <ChoiceMenu {...shell} groups={groups} onPick={(c) => onPick(c.id)} placeholder={t('boards.menu.milestone')} label={t('boards.f.milestone')} testId="milestone-menu" />;
}

/** An estimate as the board's scale shows it: «5 б.», «M» (ADR-0058 §3). */
export function estimateLabel(n: number, scale: EstimateScale | undefined): string {
  return isSized(n, scale) ? estimateName(n, scale) : t('boards.points', { n: estimateName(n, scale) });
}

/** The board's scale (ADR-0058 §3); a value outside it (the scale changed) stays listed while set. */
export function EstimateMenu({ value, onPick, scale, ...shell }: MenuShell & { value: number; onPick: (n: number) => void; scale?: EstimateScale | undefined }): ReactNode {
  const groups = useMemo(() => {
    const values = scaleValues(scale);
    const list = value && !values.includes(value) ? [...values, value].sort((a, b) => a - b) : values;
    return [
      {
        id: 'e',
        label: '',
        items: [0, ...list].map((n): Choice => ({ id: String(n), search: [n ? estimateName(n, scale) : t('boards.noEstimate'), n ? String(n) : ''], label: n ? estimateLabel(n, scale) : t('boards.noEstimate'), checked: n === value })),
      },
    ];
  }, [value, scale]);
  return <ChoiceMenu {...shell} groups={groups} onPick={(c) => onPick(Number(c.id))} placeholder={t('boards.menu.estimate')} label={t('boards.f.estimate')} digits testId="estimate-menu" />;
}

// ------------------------------------------------------------------ dates

/** A due / start date popover: presets and a month grid (keyboard: arrows move, Enter picks). */
export function DateMenu({ value, onPick, title, ...shell }: MenuShell & { value: string; onPick: (day: string) => void; title: string }): ReactNode {
  const [open, setOpen] = useOpen(shell);
  const today = useToday();
  const [month, setMonth] = useState(monthOf(value || today));
  const [focus, setFocus] = useState(value || today);
  // Opening shows the chosen day's month again (derived during render).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setMonth(monthOf(value || today));
      setFocus(value || today);
    }
  }
  const first = weekStart();
  const grid = useMemo(() => monthGrid(month, first), [month, first]);
  const pick = (d: string): void => {
    onPick(d);
    setOpen(false);
  };
  const presets: Array<[string, string]> = [
    [t('boards.date.today'), today],
    [t('boards.date.tomorrow'), addDays(today, 1)],
    [t('boards.date.nextWeek'), addDays(today, 7)],
  ];
  const move = (n: number): void => {
    const next = addDays(focus, n);
    setFocus(next);
    if (monthOf(next) !== month) setMonth(monthOf(next));
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger asChild>{shell.children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={shell.side ?? 'bottom'}
          align={shell.align ?? 'start'}
          sideOffset={4}
          collisionPadding={8}
          aria-label={title}
          data-testid="date-menu"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            const k: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
            if (e.key in k) {
              e.preventDefault();
              move(k[e.key] ?? 0);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(focus);
            }
          }}
          className="mat-popover anim-in z-[var(--z-modal-popover)] w-[260px] rounded-[var(--radius-card)] p-2 text-body"
        >
          <div className="flex flex-wrap gap-1 pb-2">
            {presets.map(([label, d]) => (
              <button key={label} type="button" onClick={() => pick(d)} className="h-6 rounded-full bg-hover px-2 text-caption text-fg hover:bg-[var(--color-fill-hover)]">
                {label}
              </button>
            ))}
            {value ? (
              <button type="button" onClick={() => pick('')} className="h-6 rounded-full px-2 text-caption text-danger-text hover:bg-hover" data-testid="date-clear">
                {t('boards.date.clear')}
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-1 pb-1">
            <span className="flex-1 pl-1 text-control font-semibold">{formatMonth(month)}</span>
            <button type="button" aria-label={t('cal.prevMonth')} onClick={() => setMonth(addMonths(month, -1))} className="grid size-6 place-items-center rounded-[var(--radius-icon)] text-muted hover:bg-hover hover:text-fg">
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <button type="button" aria-label={t('cal.nextMonth')} onClick={() => setMonth(addMonths(month, 1))} className="grid size-6 place-items-center rounded-[var(--radius-icon)] text-muted hover:bg-hover hover:text-fg">
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </div>
          <div className="grid grid-cols-7 text-center text-micro text-faint">
            {weekdayNames(first).map((d, i) => (
              <span key={i} className="py-1">
                {d}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7" role="grid" aria-label={formatMonth(month)}>
            {grid.map((d) => {
              const other = monthOf(d) !== month;
              const sel = d === value;
              const isToday = d === today;
              return (
                <button
                  key={d}
                  type="button"
                  tabIndex={-1}
                  onClick={() => pick(d)}
                  aria-pressed={sel}
                  data-day={d}
                  className={cx(
                    'mx-auto grid size-8 place-items-center rounded-full text-control tabular-nums',
                    sel ? 'bg-accent-strong text-accent-fg' : isToday ? 'font-semibold text-accent-text' : other ? 'text-faint' : 'text-fg',
                    !sel && 'hover:bg-hover',
                    d === focus && !sel && 'ring-1 ring-accent',
                  )}
                >
                  {Number(d.slice(8))}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Today's key (re-exported for board modules that show due dates). */
export { useToday, dayKey };

/** A 20 px avatar of a member (cards, rows, chips). */
export function MemberAvatar({ workspaceId, userId, size = 20 }: { workspaceId: string; userId: string; size?: number }): ReactNode {
  const m = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]);
  const name = m ? nameOf(m) : '';
  return m ? <Avatar userId={userId} name={name} {...(m.user?.avatarFileId ? { fileId: m.user.avatarFileId } : {})} size={size} /> : <UserRound className="shrink-0 text-muted" style={{ width: size, height: size }} aria-hidden />;
}

export { colorCss };
