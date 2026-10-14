import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight, Ellipsis, FolderInput, GitFork, ListChecks, Pencil, Plus, Trash2 } from 'lucide-react';
import { memo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { confirmAction } from '../../components/Confirm';
import { PlanLock } from '../../components/PlanLock';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { planHas } from '../../lib/plan';
import {
  addChecklistItem,
  convertChecklistItem,
  createChecklist,
  deleteChecklist,
  deleteChecklistItem,
  editChecklistItem,
  moveChecklistItem,
  renameChecklist,
  toggleChecklistItem,
} from '../../services/boards';
import { checklistProgress, checklistsOf, useBoards } from '../../stores/boards';
import { useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';

/** ≤ 10 checklists per task, ≤ 100 items each, titles ≤ 100, items ≤ 500 (ADR-0058 §2). */
const MAX_CHECKLISTS = 10;
const MAX_ITEMS = 100;
const TITLE_MAX = 100;
const TEXT_MAX = 500;

/** An item dragged inside the panel (native drag: the id is kept here — dragover cannot read data). */
const DRAG_ITEM = 'application/x-calab-checklist-item';
let dragging: { taskId: string; itemId: string } | null = null;

/**
 * Checklists of the task panel (ADR-0058 §2): several named checklists, each with its items —
 * tick, edit in place, drag to reorder or into another checklist, «Сделать подзадачей», delete.
 * Re-renders (CLAUDE.md «Ререндеры»): the section subscribes to the checklist ids only, each
 * checklist (memo) to its own object, each item row (memo, primitive props) to its item by id —
 * the store keeps unchanged items by reference, so a tick re-renders one row, its checklist's
 * header and the counters, nothing else of the panel. Writes follow the task's rights; a plan
 * without checklists (Free) shows them read-only with a lock naming Team (ADR-0058 §5).
 */
export function Checklists({ taskId, workspaceId, canEdit, subtasks }: { taskId: string; workspaceId: string; canEdit: boolean; subtasks: boolean }): ReactNode {
  const ids = useBoards(useShallow((s) => checklistsOf(s, taskId).map((c) => c.id)));
  const planOk = useWorkspaces((s) => planHas(s.byId[workspaceId]?.ws.plan, 'checklists'));
  const editable = canEdit && planOk;
  const [adding, setAdding] = useState(false);
  if (!ids.length && !canEdit) return null;
  const addButton = (
    <button
      type="button"
      disabled={!editable || ids.length >= MAX_CHECKLISTS}
      onClick={() => setAdding(true)}
      className="flex h-8 items-center gap-1.5 self-start rounded-[var(--radius-row)] px-2 text-control text-muted hover:bg-hover hover:text-fg disabled:hover:bg-transparent"
      data-testid="checklist-add"
    >
      <Plus className="size-3.5" aria-hidden /> {t('boards.cl.add')}
    </button>
  );
  return (
    <section className="flex flex-col gap-2" aria-label={t('boards.cl.title')} data-testid="task-checklists">
      <h3 className="flex items-center gap-1.5 text-caption font-semibold text-muted">
        <ListChecks className="size-3.5" aria-hidden /> {t('boards.cl.title')}
        <Progress taskId={taskId} />
      </h3>
      {ids.map((id) => (
        <ChecklistBlock key={id} taskId={taskId} id={id} canEdit={editable} subtasks={subtasks} />
      ))}
      {adding ? (
        <LineInput
          placeholder={t('boards.cl.titlePlaceholder')}
          initial={ids.length ? '' : t('boards.cl.defaultTitle')}
          max={TITLE_MAX}
          testId="checklist-title-input"
          onSubmit={(v) => {
            setAdding(false);
            if (v) void createChecklist(taskId, v);
          }}
        />
      ) : canEdit && !planOk ? (
        <PlanLock plan="team" testId="checklists-lock">
          {addButton}
        </PlanLock>
      ) : editable ? (
        addButton
      ) : null}
    </section>
  );
}

/** «3/7» of the whole task: a leaf with a primitive selector. */
function Progress({ taskId }: { taskId: string }): ReactNode {
  const text = useBoards((s) => checklistProgress(s, taskId));
  return text ? <span className="font-normal tabular-nums" data-testid="checklists-progress">{text}</span> : null;
}

const ChecklistBlock = memo(function ChecklistBlock({ taskId, id, canEdit, subtasks }: { taskId: string; id: string; canEdit: boolean; subtasks: boolean }): ReactNode {
  const c = useBoards((s) => checklistsOf(s, taskId).find((x) => x.id === id));
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [over, setOver] = useState(false);
  if (!c) return null;
  const done = c.items.filter((x) => x.done).length;
  const total = c.items.length;
  const remove = async (): Promise<void> => {
    if (!total || (await confirmAction(t('boards.cl.deleteTitle', { title: c.title }), t('boards.cl.deleteText'), t('common.delete')))) void deleteChecklist(taskId, id);
  };
  // A drop on the checklist's foot (or an empty checklist): the end of it.
  const onDragOver = (e: DragEvent): void => {
    if (!canEdit || dragging?.taskId !== taskId) return;
    e.preventDefault();
    if (!over) setOver(true);
  };
  const onDrop = (e: DragEvent): void => {
    setOver(false);
    const d = dragging;
    if (!d || d.taskId !== taskId) return;
    e.preventDefault();
    dragging = null;
    void moveChecklistItem(taskId, d.itemId, id, c.items.filter((x) => x.id !== d.itemId).length);
  };
  return (
    <div className="flex flex-col rounded-[var(--radius-card)] border border-line py-1" data-testid="checklist" data-checklist={id}>
      <div className="group/clh flex min-h-8 items-center gap-2 pl-3 pr-1">
        {renaming ? (
          <LineInput
            initial={c.title}
            max={TITLE_MAX}
            placeholder={t('boards.cl.titlePlaceholder')}
            testId="checklist-rename"
            onSubmit={(v) => {
              setRenaming(false);
              if (v) void renameChecklist(taskId, id, v);
            }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-control font-semibold" onDoubleClick={canEdit ? () => setRenaming(true) : undefined} data-testid="checklist-title">
            {c.title}
          </span>
        )}
        {total ? (
          <span className="shrink-0 text-caption tabular-nums text-muted" data-testid="checklist-count">
            {done}/{total}
          </span>
        ) : null}
        {canEdit && !renaming ? (
          <Dropdown.Root modal={false}>
            <Dropdown.Trigger asChild>
              <button type="button" aria-label={t('boards.cl.menu', { title: c.title })} className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/clh:opacity-100 data-[state=open]:opacity-100" data-testid="checklist-menu">
                <Ellipsis className="size-4" aria-hidden />
              </button>
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content className={cx(menuBox, 'w-52')} sideOffset={4} align="end" collisionPadding={16}>
                <Dropdown.Item className={menuItem} onSelect={() => setRenaming(true)}>
                  <Pencil className="size-4" aria-hidden /> {t('boards.cl.rename')}
                </Dropdown.Item>
                <Dropdown.Separator className={menuSeparator} />
                <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void remove()} data-testid="checklist-delete">
                  <Trash2 className="size-4" aria-hidden /> {t('common.delete')}
                </Dropdown.Item>
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
        ) : null}
      </div>
      {total ? (
        <div className="mx-3 mb-1 h-1 overflow-hidden rounded-full bg-[var(--color-fill)]" aria-hidden>
          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round((done / total) * 100)}%` }} />
        </div>
      ) : null}
      <div className="flex flex-col">
        {c.items.map((x) => (
          <ItemRow key={x.id} taskId={taskId} checklistId={id} itemId={x.id} canEdit={canEdit} subtasks={subtasks} />
        ))}
      </div>
      {canEdit ? (
        <div onDragOver={onDragOver} onDragLeave={() => setOver(false)} onDrop={onDrop} className={cx('px-1', over && 'rounded-[var(--radius-row)] ring-2 ring-accent')}>
          {adding ? (
            <LineInput
              placeholder={t('boards.cl.itemPlaceholder')}
              max={TEXT_MAX}
              keepOpen
              testId="checklist-item-input"
              onSubmit={(v) => {
                if (v === null) setAdding(false);
                else if (v) void addChecklistItem(taskId, id, v);
              }}
            />
          ) : (
            <button
              type="button"
              disabled={total >= MAX_ITEMS}
              onClick={() => setAdding(true)}
              className="flex h-7 w-full items-center gap-1.5 rounded-[var(--radius-row)] px-2 text-left text-control text-muted hover:bg-hover hover:text-fg disabled:hover:bg-transparent"
              data-testid="checklist-item-add"
            >
              <Plus className="size-3.5" aria-hidden /> {t('boards.cl.addItem')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
});

const ItemRow = memo(function ItemRow({ taskId, checklistId, itemId, canEdit, subtasks }: { taskId: string; checklistId: string; itemId: string; canEdit: boolean; subtasks: boolean }): ReactNode {
  const item = useBoards((s) => checklistsOf(s, taskId).find((c) => c.id === checklistId)?.items.find((x) => x.id === itemId));
  const [editing, setEditing] = useState(false);
  const [drop, setDrop] = useState<'before' | 'after' | null>(null);
  if (!item) return null;
  const onDragOver = (e: DragEvent): void => {
    if (!canEdit || dragging?.taskId !== taskId || dragging.itemId === itemId) return;
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
    e.stopPropagation();
    dragging = null;
    const items = checklistsOf(useBoards.getState(), taskId).find((c) => c.id === checklistId)?.items.filter((x) => x.id !== d.itemId) ?? [];
    const i = items.findIndex((x) => x.id === itemId);
    if (i >= 0) void moveChecklistItem(taskId, d.itemId, checklistId, at === 'before' ? i : i + 1);
  };
  return (
    <div
      draggable={canEdit && !editing}
      onDragStart={(e) => {
        dragging = { taskId, itemId };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DRAG_ITEM, itemId);
      }}
      onDragEnd={() => {
        dragging = null;
        setDrop(null);
      }}
      onDragOver={onDragOver}
      onDragLeave={() => setDrop(null)}
      onDrop={onDrop}
      className="group/cli relative flex min-h-8 items-start gap-2 rounded-[var(--radius-row)] px-3 py-1 hover:bg-[color-mix(in_srgb,var(--color-fill)_40%,transparent)]"
      data-testid="checklist-item"
      data-done={item.done || undefined}
    >
      {drop ? <span aria-hidden className={cx('pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-accent', drop === 'before' ? 'top-0' : 'bottom-0')} /> : null}
      <button
        type="button"
        role="checkbox"
        aria-checked={item.done}
        aria-label={item.text}
        disabled={!canEdit}
        onClick={() => void toggleChecklistItem(taskId, itemId, !item.done)}
        className={cx(
          'tap-hit mt-[3px] grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors duration-[var(--motion-fast)] disabled:cursor-default',
          item.done ? 'border-accent bg-accent text-accent-fg' : 'border-[var(--color-fill-hover)] hover:border-accent',
        )}
        data-testid="checklist-check"
      >
        {item.done ? <Check className="size-3" strokeWidth={3} aria-hidden /> : null}
      </button>
      {editing ? (
        <LineInput
          initial={item.text}
          max={TEXT_MAX}
          testId="checklist-item-edit"
          onSubmit={(v) => {
            setEditing(false);
            if (v) void editChecklistItem(taskId, itemId, v);
          }}
        />
      ) : (
        <span
          role={canEdit ? 'button' : undefined}
          tabIndex={canEdit ? 0 : undefined}
          onClick={canEdit ? () => setEditing(true) : undefined}
          onKeyDown={(e) => canEdit && e.key === 'Enter' && setEditing(true)}
          className={cx('selectable min-w-0 flex-1 whitespace-pre-wrap break-words pt-px text-control', item.done ? 'text-muted line-through' : 'text-fg', canEdit && 'cursor-text')}
          data-testid="checklist-item-text"
        >
          {item.text}
        </span>
      )}
      {canEdit && !editing ? (
        <Dropdown.Root modal={false}>
          <Dropdown.Trigger asChild>
            <button type="button" aria-label={t('boards.cl.itemMenu')} className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/cli:opacity-100 data-[state=open]:opacity-100" data-testid="checklist-item-menu">
              <Ellipsis className="size-4" aria-hidden />
            </button>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content className={cx(menuBox, 'w-60')} sideOffset={4} align="end" collisionPadding={16}>
              {subtasks ? (
                <Dropdown.Item className={menuItem} onSelect={() => void convertChecklistItem(taskId, itemId)} data-testid="checklist-item-convert">
                  <GitFork className="size-4" aria-hidden /> {t('boards.cl.convert')}
                </Dropdown.Item>
              ) : null}
              <MoveTargets taskId={taskId} checklistId={checklistId} itemId={itemId} />
              <Dropdown.Separator className={menuSeparator} />
              <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void deleteChecklistItem(taskId, itemId)} data-testid="checklist-item-delete">
                <Trash2 className="size-4" aria-hidden /> {t('common.delete')}
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      ) : null}
    </div>
  );
});

/** «Перенести в ›» the task's other checklists (mounted only while the item menu is open). */
function MoveTargets({ taskId, checklistId, itemId }: { taskId: string; checklistId: string; itemId: string }): ReactNode {
  const others = useBoards(useShallow((s) => checklistsOf(s, taskId).filter((c) => c.id !== checklistId).map((c) => `${c.id}\u0000${c.title}`)));
  if (!others.length) return null;
  return (
    <Dropdown.Sub>
      <Dropdown.SubTrigger className={cx(menuItem, 'data-[state=open]:not-data-[highlighted]:bg-hover')}>
        <FolderInput className="size-4" aria-hidden /> <span className="flex-1">{t('boards.cl.moveTo')}</span> <ChevronRight className="size-4" aria-hidden />
      </Dropdown.SubTrigger>
      <Dropdown.Portal>
        <Dropdown.SubContent className={cx(menuBox, 'w-56')} sideOffset={4} collisionPadding={16}>
          {others.map((x) => {
            const [id = '', title = ''] = x.split('\u0000');
            return (
              <Dropdown.Item
                key={id}
                className={menuItem}
                onSelect={() => {
                  const n = checklistsOf(useBoards.getState(), taskId).find((c) => c.id === id)?.items.length ?? 0;
                  void moveChecklistItem(taskId, itemId, id, n);
                }}
              >
                <span className="truncate">{title}</span>
              </Dropdown.Item>
            );
          })}
        </Dropdown.SubContent>
      </Dropdown.Portal>
    </Dropdown.Sub>
  );
}

/**
 * A one-line field: Enter submits (`keepOpen`: clears and stays for the next item), leaving it
 * submits, Esc cancels (`onSubmit(null)`). Keys do not reach the board's hotkeys.
 */
function LineInput({ initial = '', placeholder, max, keepOpen = false, testId, onSubmit }: { initial?: string; placeholder?: string; max: number; keepOpen?: boolean; testId: string; onSubmit: (v: string | null) => void }): ReactNode {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const submit = (value: string | null): void => {
    if (done.current) return;
    if (keepOpen && value?.trim()) {
      onSubmit(value.trim());
      setV('');
      return;
    }
    done.current = true;
    // An empty Enter (or Esc) in the keep-open field closes it: a finished field must not stay on screen.
    onSubmit(keepOpen || value === null ? null : value.trim());
  };
  return (
    <input
      autoFocus
      value={v}
      maxLength={max}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => {
        // Leaving the field keeps what was typed (an item is added), then closes it.
        if (keepOpen && v.trim() && !done.current) onSubmit(v.trim());
        submit(keepOpen ? null : v);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          submit(v);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          submit(null);
        }
      }}
      aria-label={placeholder ?? t('boards.cl.title')}
      className="selectable h-7 min-w-0 flex-1 rounded-[var(--radius-row)] border border-accent bg-elev px-2 text-control outline-none"
      data-testid={testId}
    />
  );
}
