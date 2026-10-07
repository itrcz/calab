import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { BoardStatusType, type BoardStatus } from '@calaba/protocol';
import { ChevronDown, ChevronRight, Ellipsis, EyeOff, Palette, Plus, Star, Trash2, Eye, Shapes } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Virtuoso } from 'react-virtuoso';
import { useShallow } from 'zustand/react/shallow';
import { InlineAdd } from '../../components/CreateButton';
import { Button, Modal, Select, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { blockedStatusIds } from '../../lib/boards/approvals';
import type { FilterState, MatchCtx } from '../../lib/boards/filter';
import { dropIndex } from '../../lib/boards/position';
import { createStatus, deleteStatus, gateText, moveStatus, moveTask, updateStatus } from '../../services/boards';
import { taskPermsOf, useBoards } from '../../stores/boards';
import { myUserId } from '../../stores/session';
import { prefsOf, useBoardsUi } from '../../stores/boardsUi';
import { toast } from '../../stores/toasts';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { columnsOf, hasBit, visibleColumn, CREATE_TASKS, MANAGE_BOARD } from './model';
import { TaskCard } from './TaskCard';
import { useMatchCtx } from './useBoardView';
import { PALETTE, STATUS_TYPES, STATUS_TYPE_LABEL, StatusIcon, colorCss } from './visuals';

/** Above this many cards a column is virtualized (ADR-0042 §5). */
export const VIRTUAL_MIN = 200;
/** Pixels of movement before a press becomes a drag (a click stays a click). */
const DRAG_THRESHOLD = 6;
const EDGE = 48;

type DragKind = { kind: 'card'; id: string; from: string } | { kind: 'column'; id: string };
/** A drag in progress: what, and the overlay's width / grab offset / start point. */
type Drag = DragKind & { w: number; dx: number; dy: number; x: number; y: number };

const NO_BLOCK: ReadonlySet<string> = new Set();

/**
 * Columns a dragged card may not drop into (ADR-0049: a task not approved yet does not go
 * «further»): read from the store at drag start, the same rule as the status menus.
 */
function blockedFor(taskId: string): ReadonlySet<string> {
  const s = useBoards.getState();
  const task = s.tasks[taskId];
  return task ? blockedStatusIds(task, s.boards[task.boardId]?.statuses ?? []) : NO_BLOCK;
}
interface CardTarget {
  statusId: string;
  index: number;
}

/**
 * The kanban (ADR-0042 §5, as in Linear): a column per status in order, drag and drop of cards
 * between and inside columns (fractional position, optimistic, rolled back on refusal) and of
 * columns by their header, «+» per column, «+ Колонка», hidden columns on the right. The drag
 * lives in this component (pointer events, no library): the overlay moves by transform through a
 * ref, state changes only when the drop target changes, the store is written once on drop.
 */
export function Kanban({ boardId, workspaceId }: { boardId: string; workspaceId: string }): ReactNode {
  const prefs = useBoardsUi((s) => prefsOf(s, boardId));
  const statuses = useBoards(useShallow((s) => s.boards[boardId]?.statuses ?? NONE));
  const perms = useBoards((s) => s.boards[boardId]?.permissions);
  const ctx = useMatchCtx(boardId);
  const cols = useMemo(() => columnsOf({ statuses } as never, prefs), [statuses, prefs]);
  const manage = hasBit(perms, MANAGE_BOARD);
  const canCreate = hasBit(perms, CREATE_TASKS);

  const scroller = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [colLine, setColLine] = useState<number | null>(null);
  const [cardTarget, setCardTarget] = useState<CardTarget | null>(null);
  const [colTarget, setColTarget] = useState<number | null>(null);
  const press = useRef<{ kind: DragKind; x: number; y: number; dx: number; dy: number; w: number; started: boolean } | null>(null);
  // The drag's forbidden columns (approvals): fixed for the drag, dims those columns.
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(NO_BLOCK);
  const blockedRef = useRef<ReadonlySet<string>>(NO_BLOCK);
  const suppressClick = useRef(false);
  const pointer = useRef({ x: 0, y: 0 });
  const raf = useRef(0);

  const cardTargetAt = useCallback((x: number, y: number, dragged: string): CardTarget | null => {
    const col = document
      .elementsFromPoint(x, y)
      .map((n) => n.closest<HTMLElement>('[data-column]'))
      .find((n): n is HTMLElement => !!n);
    if (!col) return null;
    const statusId = col.dataset.column ?? '';
    const cards = [...col.querySelectorAll<HTMLElement>('[data-card]')].filter((n) => n.dataset.card !== dragged);
    const middles = cards.map((n) => {
      const r = n.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    // A virtualized column: indexes of the rendered cards count from the first one shown.
    const first = Number(cards[0]?.dataset.index ?? 0);
    return { statusId, index: first + dropIndex(middles, y) };
  }, []);

  const colTargetAt = useCallback((x: number): number => {
    const heads = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-column]') ?? [])];
    const centers = heads.map((n) => {
      const r = n.getBoundingClientRect();
      return r.left + r.width / 2;
    });
    return dropIndex(centers, x);
  }, []);

  const dropCard = (id: string, tgt: CardTarget): void => {
    const s = useBoards.getState();
    const f = prefsOf(useBoardsUi.getState(), boardId).filter;
    const visible = visibleColumn(s, boardId, tgt.statusId, f, ctx).filter((x) => x !== id);
    const afterId = visible[tgt.index - 1] ?? '';
    const beforeId = visible[tgt.index] ?? '';
    const task = s.tasks[id];
    if (!task) return;
    // Dropped where it was: nothing to send.
    if (task.statusId === tgt.statusId) {
      const all = visibleColumn(s, boardId, tgt.statusId, f, ctx);
      const at = all.indexOf(id);
      if (at >= 0 && (all[at - 1] ?? '') === afterId && (all[at + 1] ?? '') === beforeId) return;
    }
    void moveTask(id, tgt.statusId, afterId, beforeId);
  };

  /** The column drop line's x in the scroller (between the columns at index `i`). */
  const lineX = (i: number): number | null => {
    const el = scroller.current;
    if (!el) return null;
    const heads = [...el.querySelectorAll<HTMLElement>('[data-column]')];
    const box = el.getBoundingClientRect();
    const r = heads[i]?.getBoundingClientRect() ?? heads[heads.length - 1]?.getBoundingClientRect();
    if (!r) return null;
    return (heads[i] ? r.left - 6 : r.right + 6) - box.left + el.scrollLeft;
  };

  // Pointer tracking while pressed / dragging (window listeners: the pointer leaves the card).
  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const p = press.current;
      if (!p) return;
      pointer.current = { x: e.clientX, y: e.clientY };
      if (!p.started) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
        p.started = true;
        if (p.kind.kind === 'card') {
          blockedRef.current = blockedFor(p.kind.id);
          setBlocked(blockedRef.current);
        }
        setDrag({ ...p.kind, w: p.w, dx: p.dx, dy: p.dy, x: e.clientX, y: e.clientY });
      }
      if (overlay.current) overlay.current.style.transform = `translate(${e.clientX - p.dx}px, ${e.clientY - p.dy}px)`;
      if (p.kind.kind === 'card') {
        const hit = cardTargetAt(e.clientX, e.clientY, p.kind.id);
        // A forbidden column is not a target: no drop line there.
        const tgt = hit && blockedRef.current.has(hit.statusId) ? null : hit;
        setCardTarget((cur) => (cur?.statusId === tgt?.statusId && cur?.index === tgt?.index ? cur : tgt));
      } else {
        const i = colTargetAt(e.clientX);
        setColTarget((cur) => (cur === i ? cur : i));
        setColLine(lineX(i));
      }
    };
    const end = (commit: boolean): void => {
      const p = press.current;
      press.current = null;
      cancelAnimationFrame(raf.current);
      if (!p?.started) return;
      suppressClick.current = true;
      window.setTimeout(() => (suppressClick.current = false), 0);
      if (commit) {
        const { x, y } = pointer.current;
        if (p.kind.kind === 'card') {
          const tgt = cardTargetAt(x, y, p.kind.id);
          const task = useBoards.getState().tasks[p.kind.id];
          // Dropped on a forbidden column: the card stays where it was, the toast says why.
          if (tgt && blockedRef.current.has(tgt.statusId)) {
            if (task) toast.error(gateText(task));
          } else if (tgt) dropCard(p.kind.id, tgt);
        } else {
          const i = colTargetAt(x);
          const ids = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-column]') ?? [])].map((n) => n.dataset.column ?? '');
          const from = ids.indexOf(p.kind.id);
          const to = i > from ? i - 1 : i;
          if (from >= 0 && to !== from) {
            // Hidden columns keep their places: the index is among all statuses.
            const all = [...statuses].sort((a, b) => a.position - b.position).map((s) => s.id);
            const anchor = ids.filter((x2) => x2 !== p.kind.id)[to];
            const idx = anchor ? all.filter((x2) => x2 !== p.kind.id).indexOf(anchor) : all.length - 1;
            void moveStatus(boardId, p.kind.id, Math.max(0, idx));
          }
        }
      }
      blockedRef.current = NO_BLOCK;
      setBlocked(NO_BLOCK);
      setDrag(null);
      setCardTarget(null);
      setColTarget(null);
      setColLine(null);
    };
    const up = (): void => end(true);
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && press.current?.started) {
        e.preventDefault();
        e.stopPropagation();
        end(false);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', () => end(false));
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
    };
    // dropCard reads the store at drop time; statuses / boardId change the column math.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardTargetAt, colTargetAt, statuses, boardId]);

  // Auto-scroll near the board's left / right edges and a column's top / bottom while dragging.
  useEffect(() => {
    if (!drag) return;
    const tick = (): void => {
      const el = scroller.current;
      const { x, y } = pointer.current;
      if (el) {
        const r = el.getBoundingClientRect();
        if (x < r.left + EDGE) el.scrollLeft -= 12;
        else if (x > r.right - EDGE) el.scrollLeft += 12;
        const list = document
          .elementsFromPoint(x, y)
          .map((n) => n.closest<HTMLElement>('[data-column-list]'))
          .find((n): n is HTMLElement => !!n);
        if (list) {
          const lr = list.getBoundingClientRect();
          if (y < lr.top + EDGE) list.scrollTop -= 12;
          else if (y > lr.bottom - EDGE) list.scrollTop += 12;
        }
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [drag]);

  /** Press on a card (event delegation from the column): a drag starts after 6 px. */
  const onCardPointerDown = useCallback(
    (e: ReactPointerEvent, taskId: string, statusId: string): void => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button:not([data-task]), input, [role=menu]')) return;
      const task = useBoards.getState().tasks[taskId];
      // Per-task bits: a scoped assignee drags his own cards (ADR-0059).
      if (!task || !hasBit(taskPermsOf(useBoards.getState(), task, myUserId()), CREATE_TASKS)) return;
      const card = (e.currentTarget as HTMLElement).getBoundingClientRect();
      press.current = { kind: { kind: 'card', id: taskId, from: statusId }, x: e.clientX, y: e.clientY, dx: e.clientX - card.left, dy: e.clientY - card.top, w: card.width, started: false };
      pointer.current = { x: e.clientX, y: e.clientY };
    },
    [],
  );

  const onHeaderPointerDown = useCallback(
    (e: ReactPointerEvent, statusId: string): void => {
      if (!manage || e.button !== 0 || (e.target as HTMLElement).closest('button, input')) return;
      const head = (e.currentTarget as HTMLElement).getBoundingClientRect();
      press.current = { kind: { kind: 'column', id: statusId }, x: e.clientX, y: e.clientY, dx: e.clientX - head.left, dy: e.clientY - head.top, w: head.width, started: false };
      pointer.current = { x: e.clientX, y: e.clientY };
    },
    [manage],
  );

  const onClickCapture = (e: React.MouseEvent): void => {
    if (suppressClick.current) {
      e.stopPropagation();
      e.preventDefault();
    }
  };


  return (
    <div
      ref={scroller}
      className="relative flex min-h-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden px-4 pb-3 pt-3 mobile:snap-x mobile:snap-mandatory mobile:scroll-px-4 mobile:px-4"
      onClickCapture={onClickCapture}
      data-testid="kanban"
    >
      {cols.shown.map((s) => (
        <KanbanColumn
          key={s.id}
          boardId={boardId}
          workspaceId={workspaceId}
          status={s}
          filter={prefs.filter}
          ctx={ctx}
          manage={manage}
          canCreate={canCreate}
          dropAt={cardTarget?.statusId === s.id ? cardTarget.index : null}
          draggingId={drag?.kind === 'card' ? drag.id : null}
          columnDragging={drag?.kind === 'column' && drag.id === s.id}
          blocked={blocked.has(s.id)}
          onCardPointerDown={onCardPointerDown}
          onHeaderPointerDown={onHeaderPointerDown}
          statuses={statuses}
        />
      ))}
      {manage ? <AddColumn boardId={boardId} /> : null}
      {cols.hidden.length ? <HiddenColumns boardId={boardId} list={cols.hidden} filter={prefs.filter} ctx={ctx} /> : null}
      {colLine !== null && colTarget !== null ? <div aria-hidden className="pointer-events-none absolute inset-y-3 z-10 w-0.5 rounded-full bg-accent" style={{ left: colLine }} data-testid="column-drop-line" /> : null}
      {drag
        ? createPortal(
            <div
              ref={overlay}
              aria-hidden
              className="pointer-events-none fixed left-0 top-0 z-[var(--z-popover)] opacity-95 shadow-[var(--shadow-popover)]"
              style={{ width: drag.w, transform: `translate(${drag.x - drag.dx}px, ${drag.y - drag.dy}px)` }}
              data-testid="drag-overlay"
            >
              {drag.kind === 'card' ? (
                <TaskCard id={drag.id} workspaceId={workspaceId} boardId={boardId} />
              ) : (
                <div className="mat-popover flex h-9 items-center gap-2 rounded-[var(--radius-card)] px-3 text-control font-semibold">
                  {(() => {
                    const s = statuses.find((x) => x.id === drag.id);
                    return s ? (
                      <>
                        <StatusIcon type={s.type} color={s.color} /> {s.name}
                      </>
                    ) : null;
                  })()}
                </div>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

const NONE: BoardStatus[] = [];

// ------------------------------------------------------------------ column

const KanbanColumn = memo(function KanbanColumn({
  boardId,
  workspaceId,
  status,
  filter,
  ctx,
  manage,
  canCreate,
  dropAt,
  draggingId,
  columnDragging,
  blocked,
  onCardPointerDown,
  onHeaderPointerDown,
  statuses,
}: {
  boardId: string;
  workspaceId: string;
  status: BoardStatus;
  filter: FilterState;
  ctx: MatchCtx;
  manage: boolean;
  canCreate: boolean;
  dropAt: number | null;
  draggingId: string | null;
  columnDragging: boolean;
  /** A card is dragged that may not go here (approvals): dimmed, not a target. */
  blocked: boolean;
  onCardPointerDown: (e: ReactPointerEvent, taskId: string, statusId: string) => void;
  onHeaderPointerDown: (e: ReactPointerEvent, statusId: string) => void;
  statuses: readonly BoardStatus[];
}): ReactNode {
  const ids = useBoards(useShallow((s) => visibleColumn(s, boardId, status.id, filter, ctx)));
  const shown = draggingId ? ids.filter((x) => x !== draggingId) : ids;
  const virtual = ids.length > VIRTUAL_MIN;
  const add = (): void => useBoardsUi.getState().openCreate({ boardId, statusId: status.id });

  const card = (id: string, i: number): ReactNode => (
    <div key={id} className="relative" data-card={id} data-index={i}>
      {dropAt === i ? <DropLine /> : null}
      <div onPointerDown={(e) => onCardPointerDown(e, id, status.id)} className={cx(draggingId === id && 'hidden')}>
        <TaskCard id={id} workspaceId={workspaceId} boardId={boardId} />
      </div>
    </div>
  );

  return (
    <section
      className={cx(
        'flex w-[280px] shrink-0 flex-col rounded-[var(--radius-panel)] bg-[color-mix(in_srgb,var(--color-fill)_45%,transparent)] transition-opacity duration-[var(--motion-fast)] mobile:w-[min(85vw,320px)] mobile:snap-start',
        (columnDragging || blocked) && 'opacity-40',
      )}
      data-column={status.id}
      data-blocked={blocked || undefined}
      aria-label={status.name}
      data-testid="kanban-column"
    >
      <ColumnHeader boardId={boardId} status={status} count={ids.length} manage={manage} canCreate={canCreate} onAdd={add} onPointerDown={onHeaderPointerDown} statuses={statuses} />
      <div className="scrollbar-thin relative flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-1.5" data-column-list>
        {virtual ? (
          <Virtuoso style={{ height: '100%' }} data={shown} computeItemKey={(_, id) => id} itemContent={(i, id) => <div className="pb-1.5">{card(id, i)}</div>} increaseViewportBy={400} />
        ) : (
          shown.map((id, i) => card(id, i))
        )}
        {dropAt !== null && dropAt >= shown.length ? <DropLine /> : null}
        {canCreate ? (
          <button
            type="button"
            onClick={add}
            className="flex h-8 shrink-0 items-center justify-center rounded-[var(--radius-card)] text-muted opacity-0 transition-opacity duration-[var(--motion-fast)] hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/column:opacity-100 [section:hover_&]:opacity-100"
            aria-label={t('boards.addTaskTo', { status: status.name })}
          >
            <Plus className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>
    </section>
  );
});

function DropLine(): ReactNode {
  return <div aria-hidden className="pointer-events-none absolute -top-[4px] left-1 right-1 z-10 h-0.5 rounded-full bg-accent" data-testid="card-drop-line" />;
}

function ColumnHeader({
  boardId,
  status,
  count,
  manage,
  canCreate,
  onAdd,
  onPointerDown,
  statuses,
}: {
  boardId: string;
  status: BoardStatus;
  count: number;
  manage: boolean;
  canCreate: boolean;
  onAdd: () => void;
  onPointerDown: (e: ReactPointerEvent, statusId: string) => void;
  statuses: readonly BoardStatus[];
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const hide = (): void => {
    const p = prefsOf(useBoardsUi.getState(), boardId);
    useBoardsUi.getState().setPrefs(boardId, { hidden: [...p.hidden, status.id] });
  };
  return (
    <div className={cx('flex h-10 shrink-0 items-center gap-2 pl-3 pr-1.5', manage && 'cursor-grab active:cursor-grabbing')} onPointerDown={(e) => onPointerDown(e, status.id)} data-testid="column-header">
      <StatusIcon type={status.type} color={status.color} />
      {editing ? (
        <InlineName
          value={status.name}
          max={32}
          onDone={(name) => {
            setEditing(false);
            if (name && name !== status.name) void updateStatus(boardId, status.id, { name });
          }}
        />
      ) : (
        <h3 className="min-w-0 truncate text-control font-semibold" onDoubleClick={() => manage && setEditing(true)} title={status.name}>
          {status.name}
        </h3>
      )}
      <span className="text-caption tabular-nums text-muted" data-testid="column-count">
        {count}
      </span>
      {status.isDefault ? (
        <Tip label={t('boards.defaultStatus')}>
          <Star className="size-3 text-faint" aria-label={t('boards.defaultStatus')} />
        </Tip>
      ) : null}
      <span className="flex-1" />
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <button type="button" aria-label={t('boards.columnMenu')} className="grid size-7 place-items-center mobile:tap-size rounded-[var(--radius-icon)] text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-active" data-testid="column-menu">
            <Ellipsis className="size-4" aria-hidden />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={cx(menuBox, 'w-56')} align="end" sideOffset={4} collisionPadding={16}>
            {manage ? (
              <>
                <Dropdown.Item className={menuItem} onSelect={() => setEditing(true)}>
                  {t('boards.rename')}
                </Dropdown.Item>
                <Dropdown.Sub>
                  <Dropdown.SubTrigger className={cx(menuItem, 'data-[state=open]:not-data-[highlighted]:bg-hover')}>
                    <Palette className="size-4" aria-hidden /> <span className="flex-1">{t('boards.color')}</span> <ChevronRight className="size-4" aria-hidden />
                  </Dropdown.SubTrigger>
                  <Dropdown.Portal>
                    <Dropdown.SubContent className={cx(menuBox, 'w-auto min-w-0 p-2')} sideOffset={4} collisionPadding={16}>
                      <div className="grid grid-cols-6 gap-1.5">
                        {PALETTE.map((c) => (
                          <Dropdown.Item
                            key={c}
                            onSelect={() => void updateStatus(boardId, status.id, { color: c })}
                            className={cx('size-6 cursor-default rounded-full outline-none ring-offset-2 ring-offset-[var(--color-popover)] data-[highlighted]:ring-2 data-[highlighted]:ring-accent', c === status.color && 'ring-2 ring-fg')}
                            style={{ background: colorCss(c) }}
                            aria-label={colorCss(c)}
                          />
                        ))}
                      </div>
                    </Dropdown.SubContent>
                  </Dropdown.Portal>
                </Dropdown.Sub>
                <Dropdown.Sub>
                  <Dropdown.SubTrigger className={cx(menuItem, 'data-[state=open]:not-data-[highlighted]:bg-hover')}>
                    <Shapes className="size-4" aria-hidden /> <span className="flex-1">{t('boards.statusType')}</span> <ChevronRight className="size-4" aria-hidden />
                  </Dropdown.SubTrigger>
                  <Dropdown.Portal>
                    <Dropdown.SubContent className={cx(menuBox, 'w-52')} sideOffset={4} collisionPadding={16}>
                      {STATUS_TYPES.map((ty) => (
                        <Dropdown.Item key={ty} className={menuItem} onSelect={() => ty !== status.type && void updateStatus(boardId, status.id, { type: ty })}>
                          <StatusIcon type={ty} color={status.color} /> {t(STATUS_TYPE_LABEL[ty] ?? 'boards.type.unstarted')}
                        </Dropdown.Item>
                      ))}
                    </Dropdown.SubContent>
                  </Dropdown.Portal>
                </Dropdown.Sub>
                {!status.isDefault ? (
                  <Dropdown.Item className={menuItem} onSelect={() => void updateStatus(boardId, status.id, { isDefault: true })}>
                    <Star className="size-4" aria-hidden /> {t('boards.makeDefault')}
                  </Dropdown.Item>
                ) : null}
              </>
            ) : null}
            <Dropdown.Item className={menuItem} onSelect={hide}>
              <EyeOff className="size-4" aria-hidden /> {t('boards.hideColumn')}
            </Dropdown.Item>
            {manage && !status.isDefault && statuses.length > 1 ? (
              <>
                <Dropdown.Separator className={menuSeparator} />
                <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => setDeleting(true)}>
                  <Trash2 className="size-4" aria-hidden /> {t('common.delete')}
                </Dropdown.Item>
              </>
            ) : null}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      {canCreate ? (
        <InlineAdd label={t('boards.addTaskTo', { status: status.name })} onClick={onAdd} data-testid="column-add" />
      ) : null}
      {deleting ? <DeleteStatusDialog boardId={boardId} status={status} statuses={statuses} onClose={() => setDeleting(false)} /> : null}
    </div>
  );
}

/** An inline name field: Enter / blur saves, Esc cancels. */
export function InlineName({ value, max, onDone, placeholder, className }: { value: string; max: number; onDone: (v: string | null) => void; placeholder?: string; className?: string }): ReactNode {
  const [v, setV] = useState(value);
  const done = useRef(false);
  const finish = (out: string | null): void => {
    if (done.current) return;
    done.current = true;
    onDone(out === null ? null : out.trim());
  };
  return (
    <input
      autoFocus
      value={v}
      maxLength={max}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(v);
        if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(v)}
      className={cx('selectable h-7 min-w-0 flex-1 rounded-[var(--radius-row)] border border-accent bg-elev px-2 text-control font-semibold text-fg outline-none', className)}
      data-testid="inline-name"
    />
  );
}

/** «Удалить статус»: its tasks move to another status first. */
export function DeleteStatusDialog({ boardId, status, statuses, onClose }: { boardId: string; status: BoardStatus; statuses: readonly BoardStatus[]; onClose: () => void }): ReactNode {
  const others = statuses.filter((s) => s.id !== status.id);
  const [to, setTo] = useState(others.find((s) => s.isDefault)?.id ?? others[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('boards.deleteStatusTitle', { name: status.name })}
      description={t('boards.deleteStatusText')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            busy={busy}
            disabled={!to}
            onClick={() => {
              setBusy(true);
              void deleteStatus(boardId, status.id, to).then((ok) => {
                setBusy(false);
                if (ok) onClose();
              });
            }}
            data-testid="delete-status-confirm"
          >
            {t('common.delete')}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5 text-caption text-muted">
        {t('boards.moveTasksTo')}
        <Select value={to} onChange={(e) => setTo(e.target.value)} data-testid="delete-status-target">
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </label>
    </Modal>
  );
}

function AddColumn({ boardId }: { boardId: string }): ReactNode {
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex w-[240px] shrink-0 flex-col pt-1">
      {adding ? (
        <div className="flex h-10 items-center gap-2 rounded-[var(--radius-panel)] bg-[color-mix(in_srgb,var(--color-fill)_45%,transparent)] px-2">
          <StatusIcon type={BoardStatusType.UNSTARTED} color={0xaeaeb2} />
          <InlineName
            value=""
            max={32}
            placeholder={t('boards.columnName')}
            onDone={(name) => {
              setAdding(false);
              if (name) void createStatus(boardId, { name, type: BoardStatusType.UNSTARTED, color: 0xaeaeb2 });
            }}
          />
        </div>
      ) : (
        <Button variant="ghost" className="justify-start" onClick={() => setAdding(true)} data-testid="add-column">
          <Plus className="size-4" aria-hidden /> {t('boards.addColumn')}
        </Button>
      )}
    </div>
  );
}

/** «Скрытые» (Linear): hidden columns with their counts; a click shows the column again. */
function HiddenColumns({ boardId, list, filter, ctx }: { boardId: string; list: BoardStatus[]; filter: FilterState; ctx: MatchCtx }): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex w-[220px] shrink-0 flex-col gap-1.5 pt-1" data-testid="hidden-columns">
      <button type="button" onClick={() => setOpen(!open)} className="flex h-8 items-center gap-1.5 px-2 text-caption font-medium text-muted hover:text-fg" aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        {t('boards.hiddenColumns')}
      </button>
      {open
        ? list.map((s) => <HiddenColumn key={s.id} boardId={boardId} status={s} filter={filter} ctx={ctx} />)
        : null}
    </div>
  );
}

function HiddenColumn({ boardId, status, filter, ctx }: { boardId: string; status: BoardStatus; filter: FilterState; ctx: MatchCtx }): ReactNode {
  const n = useBoards((s) => visibleColumn(s, boardId, status.id, filter, ctx).length);
  const show = (): void => {
    const p = prefsOf(useBoardsUi.getState(), boardId);
    const done = status.type === BoardStatusType.COMPLETED || status.type === BoardStatusType.CANCELLED;
    useBoardsUi.getState().setPrefs(boardId, { hidden: p.hidden.filter((x) => x !== status.id), ...(done ? { showCompleted: true } : {}) });
  };
  return (
    <button
      type="button"
      onClick={show}
      data-column-hidden={status.id}
      className="flex h-10 items-center gap-2 rounded-[var(--radius-card)] border border-line bg-elev px-3 text-left text-control hover:border-[var(--color-fill-hover)]"
      title={t('boards.showColumn')}
    >
      <StatusIcon type={status.type} color={status.color} />
      <span className="min-w-0 flex-1 truncate">{status.name}</span>
      <span className="text-caption tabular-nums text-muted">{n}</span>
      <Eye className="size-3.5 text-faint" aria-hidden />
    </button>
  );
}
