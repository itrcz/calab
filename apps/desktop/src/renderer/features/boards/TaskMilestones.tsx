import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { CalendarPlus, Check, ChevronDown, CircleCheck, CircleDashed, Ellipsis, Pencil, Plus, Trash2, X } from 'lucide-react';
import { memo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { confirmAction } from '../../components/Confirm';
import { IconButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import { MAX_TASK_MILESTONES, MILESTONE_NAME_MAX, addRowKey, isAuto, milestoneState, subtaskProgress, type MilestoneState } from '../../lib/boards/milestones';
import { createTaskMilestone, deleteTaskMilestone, moveTaskMilestone, updateTaskMilestone } from '../../services/boards';
import { milestoneChipOf, taskMilestonesOf, useBoards } from '../../stores/boards';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { DateMenu, useToday } from './menus';
import { formatDue } from './visuals';

/** A milestone row dragged inside the panel (native drag: dragover cannot read the data). */
const DRAG_MS = 'application/x-calab-task-milestone';
let dragging: { taskId: string; id: string } | null = null;

/**
 * «Вехи» of the task panel (ADR-0063 §5, Linear's project milestones): a collapsible section with
 * «+»; the add row — diamond, name, our date menu, ✕ ✓ (↩ saves, Esc cancels); a row per
 * milestone — the diamond (filled: completed, red outline: overdue; a click toggles while no
 * subtask is linked), the name, the date, the linked subtasks' «3/5», «⋯» (rename, date, mark,
 * delete) and drag to reorder. Re-renders (CLAUDE.md «Ререндеры»): the section subscribes to the
 * ids, each row (memo) to its milestone by id — the store keeps unchanged milestones by
 * reference across TASK_UPDATEs, so a change re-renders one row and the header's counter.
 */
export function TaskMilestones({ taskId, canEdit }: { taskId: string; canEdit: boolean }): ReactNode {
  const ids = useBoards(useShallow((s) => taskMilestonesOf(s, taskId).map((m) => m.id)));
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  if (!ids.length && !canEdit) return null;
  const full = ids.length >= MAX_TASK_MILESTONES;
  return (
    <section className="flex flex-col rounded-[var(--radius-card)] border border-line" aria-label={t('boards.ms.title')} data-testid="task-milestones">
      <div className="flex h-10 items-center gap-1 pl-3 pr-1.5">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={t('boards.ms.toggle')} className="flex h-7 items-center gap-1.5 rounded-[var(--radius-row)] pr-1.5 text-control font-semibold text-fg hover:text-fg" data-testid="milestones-toggle">
          {t('boards.ms.title')}
          <ChevronDown className={cx('size-3.5 text-muted transition-transform duration-[var(--motion-fast)]', !open && '-rotate-90')} aria-hidden />
        </button>
        <Chip taskId={taskId} />
        <span className="flex-1" />
        {canEdit ? (
          <IconButton
            label={t('boards.ms.add')}
            size="sm"
            disabled={full}
            onClick={() => {
              setOpen(true);
              setAdding(true);
            }}
            data-testid="milestone-add"
          >
            <Plus className="size-4" aria-hidden />
          </IconButton>
        ) : null}
      </div>
      {open ? (
        <div className="flex flex-col px-1 pb-1">
          {!ids.length && !adding ? <p className="px-2 pb-2 text-caption text-muted" data-testid="milestones-empty">{t('boards.ms.empty')}</p> : null}
          {adding ? <AddRow taskId={taskId} onDone={() => setAdding(false)} /> : null}
          {ids.map((id) => (
            <MilestoneRow key={id} taskId={taskId} id={id} canEdit={canEdit} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** «2/4» completed of all: a leaf with a primitive selector. */
function Chip({ taskId }: { taskId: string }): ReactNode {
  const text = useBoards((s) => milestoneChipOf(s, taskId));
  return text ? <span className="text-caption tabular-nums text-muted" data-testid="milestones-progress">{text}</span> : null;
}

/** The diamond of a milestone: filled when completed, a red outline when overdue. */
export function MilestoneDiamond({ state, size = 12 }: { state: MilestoneState; size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className="shrink-0">
      <path
        d="M6 1 L11 6 L6 11 L1 6 Z"
        strokeWidth={1.6}
        strokeLinejoin="round"
        className={cx(state === 'done' ? 'fill-[var(--color-accent)] stroke-[var(--color-accent)]' : 'fill-none', state === 'overdue' ? 'stroke-[var(--color-red)]' : state === 'open' ? 'stroke-[var(--color-muted)]' : '')}
      />
    </svg>
  );
}

/** The add row: name, target date, ✕ ✓. Enter saves, Esc cancels; the row stays for the next one. */
function AddRow({ taskId, onDone }: { taskId: string; onDone: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const today = useToday();
  const save = async (): Promise<void> => {
    const v = name.trim();
    if (!v || busy) return;
    setBusy(true);
    const ok = await createTaskMilestone(taskId, v, due);
    setBusy(false);
    if (!ok) return;
    setName('');
    setDue('');
    input.current?.focus();
  };
  return (
    <div className="flex h-10 items-center gap-2 rounded-[var(--radius-row)] bg-[color-mix(in_srgb,var(--color-fill)_45%,transparent)] pl-2 pr-1" data-testid="milestone-add-row">
      <MilestoneDiamond state="open" />
      <input
        ref={input}
        autoFocus
        value={name}
        maxLength={MILESTONE_NAME_MAX}
        placeholder={t('boards.ms.namePlaceholder')}
        aria-label={t('boards.ms.namePlaceholder')}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          const k = addRowKey(e.key, name);
          if (k) e.preventDefault();
          if (k === 'save') void save();
          else if (k === 'cancel') onDone();
        }}
        className="selectable h-7 min-w-0 flex-1 bg-transparent text-control text-fg outline-none placeholder:text-faint"
        data-testid="milestone-name-input"
      />
      <DateMenu value={due} onPick={setDue} title={t('boards.ms.targetDate')} align="end">
        {due ? (
          <button type="button" className="h-7 shrink-0 rounded-[var(--radius-row)] px-2 text-control tabular-nums text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-active" data-testid="milestone-date">
            {formatDue(due, today)}
          </button>
        ) : (
          <IconButton label={t('boards.ms.targetDate')} size="sm" data-testid="milestone-date">
            <CalendarPlus className="size-4" aria-hidden />
          </IconButton>
        )}
      </DateMenu>
      <IconButton label={t('boards.ms.cancel')} size="sm" onClick={onDone} data-testid="milestone-cancel">
        <X className="size-4" aria-hidden />
      </IconButton>
      <IconButton label={t('boards.ms.save')} size="sm" disabled={!name.trim() || busy} onClick={() => void save()} data-testid="milestone-save">
        <Check className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
}

const MilestoneRow = memo(function MilestoneRow({ taskId, id, canEdit }: { taskId: string; id: string; canEdit: boolean }): ReactNode {
  const m = useBoards((s) => taskMilestonesOf(s, taskId).find((x) => x.id === id));
  const today = useToday();
  const [renaming, setRenaming] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [drop, setDrop] = useState<'before' | 'after' | null>(null);
  if (!m) return null;
  const state = milestoneState(m, today);
  const auto = isAuto(m);
  const progress = subtaskProgress(m);
  const toggle = canEdit && !auto ? (): void => void updateTaskMilestone(taskId, id, { completed: !m.completedAt }) : undefined;
  const remove = async (): Promise<void> => {
    if (await confirmAction(t('boards.ms.deleteTitle', { name: m.name }), t('boards.ms.deleteText'), t('common.delete'))) void deleteTaskMilestone(taskId, id);
  };
  const onDragOver = (e: DragEvent): void => {
    if (!canEdit || dragging?.taskId !== taskId || dragging.id === id) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    const at = e.clientY < box.top + box.height / 2 ? 'before' : 'after';
    if (drop !== at) setDrop(at);
  };
  const onDrop = (e: DragEvent): void => {
    const at = drop;
    setDrop(null);
    const d = dragging;
    if (!d || d.taskId !== taskId || !at) return;
    e.preventDefault();
    dragging = null;
    const rest = taskMilestonesOf(useBoards.getState(), taskId).filter((x) => x.id !== d.id);
    const i = rest.findIndex((x) => x.id === id);
    if (i >= 0) moveTaskMilestone(taskId, d.id, at === 'before' ? i : i + 1);
  };
  const stateText = state === 'done' ? t('boards.ms.done') : state === 'overdue' ? t('boards.ms.overdue') : '';
  return (
    <div
      draggable={canEdit && !renaming}
      onDragStart={(e) => {
        dragging = { taskId, id };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DRAG_MS, id);
      }}
      onDragEnd={() => {
        dragging = null;
        setDrop(null);
      }}
      onDragOver={onDragOver}
      onDragLeave={() => setDrop(null)}
      onDrop={onDrop}
      title={canEdit ? t('boards.ms.drag') : undefined}
      className="group/ms relative flex h-9 items-center gap-2 rounded-[var(--radius-row)] pl-2 pr-1 hover:bg-[color-mix(in_srgb,var(--color-fill)_40%,transparent)]"
      data-testid="milestone-row"
      data-state={state}
    >
      {drop ? <span aria-hidden className={cx('pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-accent', drop === 'before' ? 'top-0' : 'bottom-0')} /> : null}
      <button
        type="button"
        role="checkbox"
        aria-checked={!!m.completedAt}
        aria-label={stateText ? `${m.name} · ${stateText}` : m.name}
        disabled={!toggle}
        onClick={toggle}
        title={auto ? t('boards.ms.autoHint') : undefined}
        className="tap-hit grid size-5 shrink-0 place-items-center rounded-[var(--radius-icon)] enabled:hover:bg-hover disabled:cursor-default"
        data-testid="milestone-diamond"
      >
        <MilestoneDiamond state={state} />
      </button>
      {renaming ? (
        <input
          autoFocus
          defaultValue={m.name}
          maxLength={MILESTONE_NAME_MAX}
          aria-label={t('boards.ms.rename')}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            setRenaming(false);
            const v = e.currentTarget.value.trim();
            if (v && v !== m.name) void updateTaskMilestone(taskId, id, { name: v });
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              e.currentTarget.value = m.name;
              e.currentTarget.blur();
            }
          }}
          className="selectable h-7 min-w-0 flex-1 rounded-[var(--radius-row)] border border-accent bg-elev px-2 text-control outline-none"
          data-testid="milestone-rename"
        />
      ) : (
        <span className={cx('min-w-0 flex-1 truncate text-control', state === 'done' ? 'text-muted' : 'text-fg')} onDoubleClick={canEdit ? () => setRenaming(true) : undefined} data-testid="milestone-name">
          {m.name}
        </span>
      )}
      {progress ? (
        <span className="shrink-0 text-caption tabular-nums text-muted" title={t('boards.ms.subtasks', { done: m.done, total: m.total })} data-testid="milestone-progress">
          {progress}
        </span>
      ) : null}
      <DateMenu value={m.dueOn} onPick={(d) => d !== m.dueOn && void updateTaskMilestone(taskId, id, { dueOn: d })} title={t('boards.ms.targetDate')} open={dateOpen} onOpenChange={setDateOpen} align="end">
        <button
          type="button"
          disabled={!canEdit}
          className={cx('h-7 shrink-0 rounded-[var(--radius-row)] px-1.5 text-caption tabular-nums enabled:hover:bg-hover data-[state=open]:bg-active', state === 'overdue' ? 'text-danger-text' : 'text-muted', !m.dueOn && 'opacity-0 group-hover/ms:opacity-100 data-[state=open]:opacity-100')}
          data-testid="milestone-due"
        >
          {m.dueOn ? formatDue(m.dueOn, today) : <CalendarPlus className="size-3.5" aria-label={t('boards.ms.targetDate')} />}
        </button>
      </DateMenu>
      {canEdit && !renaming ? (
        <Dropdown.Root modal={false}>
          <Dropdown.Trigger asChild>
            <button type="button" aria-label={t('boards.ms.menu', { name: m.name })} className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/ms:opacity-100 data-[state=open]:opacity-100" data-testid="milestone-menu">
              <Ellipsis className="size-4" aria-hidden />
            </button>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content className={cx(menuBox, 'w-60')} sideOffset={4} align="end" collisionPadding={16}>
              <Dropdown.Item className={menuItem} onSelect={() => setRenaming(true)}>
                <Pencil className="size-4" aria-hidden /> {t('boards.ms.rename')}
              </Dropdown.Item>
              <Dropdown.Item className={menuItem} onSelect={() => setDateOpen(true)}>
                <CalendarPlus className="size-4" aria-hidden /> {t('boards.ms.setDate')}
              </Dropdown.Item>
              <Dropdown.Item className={menuItem} disabled={auto} onSelect={() => void updateTaskMilestone(taskId, id, { completed: !m.completedAt })} title={auto ? t('boards.ms.autoHint') : undefined} data-testid="milestone-toggle">
                {m.completedAt ? <CircleDashed className="size-4" aria-hidden /> : <CircleCheck className="size-4" aria-hidden />} {m.completedAt ? t('boards.ms.reopen') : t('boards.ms.complete')}
              </Dropdown.Item>
              <Dropdown.Separator className={menuSeparator} />
              <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void remove()} data-testid="milestone-delete">
                <Trash2 className="size-4" aria-hidden /> {t('common.delete')}
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      ) : null}
    </div>
  );
});
