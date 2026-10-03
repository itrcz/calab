import { ChevronRight } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { BoardFeature, type BoardMilestone } from '@calaba/protocol';
import { Button, Segmented, cx } from '../../components/ui';
import { t } from '../../i18n';
import { dateTimeFormat } from '../../lib/format';
import { useMobile } from '../../lib/mobile';
import {
  DAY_PX,
  GROUP_ROW,
  barBox,
  datePatch,
  dayNum,
  dayWindow,
  daysOf,
  dragSpan,
  isWeekend,
  isoDay,
  lateBlockers,
  placePatch,
  rowWindow,
  scaleRange,
  spanOf,
  timelineRows,
  type DragMode,
  type Span,
  type TimelineGroup,
  type Zoom,
} from '../../lib/boards/timeline';
import { updateMilestone, updateTask } from '../../services/boards';
import { useBoards } from '../../stores/boards';
import { prefsOf, useBoardsUi } from '../../stores/boardsUi';
import { myUserId } from '../../stores/session';
import { memberName } from '../../stores/workspaces';
import { EmptyBoard } from './ListView';
import { MemberAvatar, useToday } from './menus';
import { MANAGE_BOARD, hasBit, mayEditTask, visibleTasks } from './model';
import { useFeatureOn, useMatchCtx } from './useBoardView';
import { useTaskPerms } from './useTaskPerms';
import { StatusIcon, colorCss } from './visuals';

/**
 * Timeline (Gantt) of a board (ADR-0042 §5, docs/08 «Доски задач»): the dated tasks as rows (a
 * sticky list on the left, bars in the status colour on the scale), week / month / quarter zoom,
 * the today line, weekends muted, milestones as diamonds, a red marker on a bar whose blocker
 * ends after it starts, grouping by assignee / milestone. D&D: a bar moves, its edges change the
 * start / due date, a milestone moves, a task from «Без дат» gets a day — the store is written
 * on drop only (updateTask, optimistic). Rows and the scale's ticks render for the visible window
 * only; a phone gets it read-only. Math: lib/boards/timeline.ts.
 */

const ROW = 32;
const HEAD = 44;
const LANE = 20;

type Drag =
  | { kind: 'bar'; id: string; mode: DragMode; x: number; delta: number; moved: boolean }
  | { kind: 'ms'; id: string; x: number; delta: number; moved: boolean }
  | { kind: 'place'; id: string; x: number; y: number; moved: boolean };

const NO_MS: BoardMilestone[] = [];
const ZOOMS: Zoom[] = ['week', 'month', 'quarter'];
const GROUPS: TimelineGroup[] = ['none', 'assignee', 'milestone'];

export function Timeline({ boardId, workspaceId }: { boardId: string; workspaceId: string }): ReactNode {
  const mobile = useMobile();
  const prefs = useBoardsUi((s) => prefsOf(s, boardId));
  const zoom = prefs.zoom ?? 'month';
  const group = prefs.tlGroup ?? 'none';
  const px = DAY_PX[zoom];
  const left = mobile ? 132 : 248;
  const ctx = useMatchCtx(boardId);
  const milestones = useBoards(useShallow((s) => s.boards[boardId]?.milestones ?? NO_MS));
  const manage = useBoards((s) => hasBit(s.boards[boardId]?.permissions, MANAGE_BOARD));
  const today = dayNum(useToday());
  // What rows / range read, as a primitive: an edit of a title leaves the rows as they are.
  const shape = useBoards((s) => {
    const b = s.boards[boardId];
    if (!b) return '';
    let out = '';
    for (const x of visibleTasks(s, b, prefs, ctx)) out += `${x.id}|${x.startOn}|${x.dueOn}|${x.number}|${x.assignees.find((a) => a.isLead)?.userId ?? ''}|${x.milestoneId};`;
    return out;
  });
  const { rows, undated, range } = useMemo(() => {
    const s = useBoards.getState();
    const b = s.boards[boardId];
    const list = b ? visibleTasks(s, b, prefs, ctx) : [];
    const days: number[] = [];
    for (const x of list) days.push(dayNum(x.startOn), dayNum(x.dueOn));
    for (const m of milestones) days.push(dayNum(m.dueOn));
    return { ...timelineRows(list, group), range: scaleRange(days, today) };
    // `shape` stands for the tasks read through getState().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, group, boardId, prefs, ctx, milestones, today]);
  const head = HEAD + (milestones.length ? LANE : 0);
  const origin = range.start;
  const days = range.end - range.start + 1;

  // ---- the visible window (rows, days); state changes only when the window does.
  const scroller = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ first: 0, last: 30, d0: origin, d1: origin + 90 });
  const sync = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const r = rowWindow(el.scrollTop, el.clientHeight - head, ROW, rows.length);
    // Days in whole weeks: horizontal scrolling re-renders the scale once a week of travel.
    const q = px * 7;
    const d = dayWindow(Math.max(0, Math.floor(el.scrollLeft / q) * q - q), el.clientWidth + 3 * q, px, range);
    setWin((w) => (w.first === r.first && w.last === r.last && w.d0 === d.start && w.d1 === d.end ? w : { first: r.first, last: r.last, d0: d.start, d1: d.end }));
  }, [rows.length, head, px, range]);
  const frame = useRef(0);
  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      sync();
    });
  }, [sync]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useLayoutEffect(() => {
    sync();
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => sync());
    ro.observe(el);
    return () => ro.disconnect();
  }, [sync]);
  // A new board / zoom: today a few days from the left edge.
  const placed = useRef('');
  const scrollToToday = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, (today - origin - (zoom === 'week' ? 4 : zoom === 'month' ? 6 : 21)) * px);
  }, [today, origin, zoom, px]);
  useLayoutEffect(() => {
    const k = `${boardId}|${zoom}`;
    if (placed.current === k) return;
    placed.current = k;
    scrollToToday();
  }, [boardId, zoom, scrollToToday]);

  // ---- drag: local until the drop, then one PATCH.
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const geo = useRef({ px, origin, left });
  useLayoutEffect(() => {
    geo.current = { px, origin, left };
  }, [px, origin, left]);
  const setD = (d: Drag | null): void => {
    dragRef.current = d;
    setDrag(d);
  };
  const onBarDown = useCallback((e: ReactPointerEvent, id: string, mode: DragMode) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const d: Drag = { kind: 'bar', id, mode, x: e.clientX, delta: 0, moved: false };
    dragRef.current = d;
    setDrag(d);
  }, []);
  const onMsDown = useCallback((e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const d: Drag = { kind: 'ms', id, x: e.clientX, delta: 0, moved: false };
    dragRef.current = d;
    setDrag(d);
  }, []);
  const onPlaceDown = useCallback((e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const d: Drag = { kind: 'place', id, x: e.clientX, y: e.clientY, moved: false };
    dragRef.current = d;
    setDrag(d);
  }, []);
  const active = drag !== null;
  useEffect(() => {
    if (!active) return;
    const move = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === 'place') {
        const moved = d.moved || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4;
        setD({ ...d, moved, x: moved ? e.clientX : d.x, y: moved ? e.clientY : d.y });
        return;
      }
      const moved = d.moved || Math.abs(e.clientX - d.x) > 3;
      const delta = daysOf(e.clientX - d.x, geo.current.px);
      if (moved !== d.moved || delta !== d.delta) setD({ ...d, moved, delta });
    };
    const up = (e: PointerEvent): void => {
      const d = dragRef.current;
      setD(null);
      if (!d) return;
      const s = useBoards.getState();
      if (d.kind === 'bar') {
        const task = s.tasks[d.id];
        const span = task ? spanOf(task) : null;
        if (!d.moved) useBoardsUi.getState().openTask(d.id);
        else if (task && span && d.delta) {
          const patch = datePatch(task, dragSpan(span, d.mode, d.delta));
          if (Object.keys(patch).length) void updateTask(d.id, patch);
        }
      } else if (d.kind === 'ms') {
        const ms = s.boards[boardId]?.milestones.find((m) => m.id === d.id);
        if (ms && d.moved && d.delta) void updateMilestone(boardId, ms.id, { dueOn: isoDay(dayNum(ms.dueOn) + d.delta) });
      } else if (!d.moved) useBoardsUi.getState().openTask(d.id);
      else {
        const el = scroller.current;
        const box = el?.getBoundingClientRect();
        const g = geo.current;
        if (el && box && e.clientX > box.left + g.left && e.clientX < box.right && e.clientY > box.top && e.clientY < box.bottom) {
          const day = g.origin + Math.floor((e.clientX - box.left - g.left + el.scrollLeft) / g.px);
          void updateTask(d.id, placePatch(day));
        }
      }
    };
    const key = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setD(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
    };
  }, [active, boardId]);

  const [undatedOpen, setUndatedOpen] = useState(true);
  // Dates of a switched-off feature are not written (ADR-0058 §3): the bars stay, read-only.
  const startOn = useFeatureOn(boardId, BoardFeature.START_DATE);
  const dueOn = useFeatureOn(boardId, BoardFeature.DUE_DATE);
  if (rows.length === 0 && undated.length === 0) return <EmptyBoard />;
  const readOnly = mobile || !startOn || !dueOn;
  const barDrag = drag?.kind === 'bar' && drag.moved ? drag : null;
  const msDrag = drag?.kind === 'ms' && drag.moved ? drag : null;
  const shownRows = rows.slice(win.first, win.last);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="timeline">
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto px-3 scrollbar-none">
        <Segmented value={zoom} options={ZOOMS.map((z) => ({ value: z, label: t(`boards.tl.${z}`) }))} onChange={(z) => useBoardsUi.getState().setPrefs(boardId, { zoom: z })} label={t('boards.tl.zoom')} />
        {mobile ? null : (
          <Segmented
            value={group}
            options={GROUPS.map((g) => ({ value: g, label: t(g === 'none' ? 'boards.group.none' : g === 'assignee' ? 'boards.group.assignee' : 'boards.group.milestone') }))}
            onChange={(g) => useBoardsUi.getState().setPrefs(boardId, { tlGroup: g })}
            label={t('boards.groupBy')}
          />
        )}
        <Button variant="secondary" onClick={scrollToToday} data-testid="timeline-today">
          {t('boards.tl.today')}
        </Button>
      </div>
      <div ref={scroller} onScroll={onScroll} className="scrollbar-thin relative min-h-0 flex-1 overflow-auto border-t border-line" aria-label={t('boards.view.timeline')} data-testid="timeline-scroll">
        <div className="relative" style={{ width: left + days * px, height: head + rows.length * ROW, minHeight: '100%' }}>
          <Grid origin={origin} px={px} left={left} d0={win.d0} d1={win.d1} today={today} />
          <Scale origin={origin} px={px} left={left} d0={win.d0} d1={win.d1} zoom={zoom} head={head} width={left + days * px}>
            {milestones.length ? (
              <div className="absolute inset-x-0 bottom-0 h-5" data-testid="timeline-milestones">
                {milestones.map((m) => (
                  <MilestoneMark key={m.id} m={m} origin={origin} px={px} left={left} delta={msDrag?.id === m.id ? msDrag.delta : 0} draggable={manage && !readOnly} onDown={onMsDown} />
                ))}
              </div>
            ) : null}
          </Scale>
          {shownRows.map((id, i) =>
            id.startsWith(GROUP_ROW) ? (
              <GroupRow key={id} k={id.slice(GROUP_ROW.length)} group={group} top={head + (win.first + i) * ROW} left={left} boardId={boardId} workspaceId={workspaceId} />
            ) : (
              <TimelineRow
                key={id}
                id={id}
                boardId={boardId}
                top={head + (win.first + i) * ROW}
                origin={origin}
                px={px}
                left={left}
                delta={barDrag?.id === id ? barDrag.delta : 0}
                mode={barDrag?.id === id ? barDrag.mode : null}
                readOnly={readOnly}
                onBarDown={onBarDown}
              />
            ),
          )}
          {rows.length === 0 ? (
            <p className="absolute text-body text-muted" style={{ top: head + 24, left: left + 24 }}>
              {t('boards.tl.empty')}
            </p>
          ) : null}
        </div>
      </div>
      {undated.length ? (
        <div className="shrink-0 border-t border-line" data-testid="timeline-undated">
          <button type="button" onClick={() => setUndatedOpen((v) => !v)} aria-expanded={undatedOpen} className="flex h-8 w-full items-center gap-2 px-3 text-left text-control font-semibold hover:bg-hover">
            <ChevronRight className={cx('size-4 text-muted transition-transform duration-[var(--motion-fast)]', undatedOpen && 'rotate-90')} aria-hidden />
            {t('boards.tl.noDates')}
            <span className="text-caption font-normal tabular-nums text-muted">{undated.length}</span>
            {readOnly ? null : <span className="min-w-0 truncate text-caption font-normal text-muted">{t('boards.tl.noDatesHint')}</span>}
          </button>
          {undatedOpen ? (
            <div className="scrollbar-thin flex max-h-24 flex-wrap gap-1.5 overflow-y-auto px-3 pb-2">
              {undated.map((id) => (
                <UndatedChip key={id} id={id} boardId={boardId} readOnly={readOnly} dragging={drag?.kind === 'place' && drag.id === id && drag.moved} onDown={onPlaceDown} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {drag?.kind === 'place' && drag.moved ? <PlaceGhost id={drag.id} x={drag.x} y={drag.y} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ scale

const monthFmt = (): Intl.DateTimeFormat => dateTimeFormat({ month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayFmt = (): Intl.DateTimeFormat => dateTimeFormat({ weekday: 'short', day: 'numeric', timeZone: 'UTC' });

/** The header: months, then days (weeks on the quarter scale), then the milestone lane. Sticky on top. */
const Scale = memo(function Scale({ origin, px, left, d0, d1, zoom, head, width, children }: { origin: number; px: number; left: number; d0: number; d1: number; zoom: Zoom; head: number; width: number; children: ReactNode }): ReactNode {
  const months: ReactNode[] = [];
  const ticks: ReactNode[] = [];
  const mf = monthFmt();
  const df = dayFmt();
  for (let d = d0; d <= d1; d++) {
    const iso = isoDay(d);
    const x = left + (d - origin) * px;
    if (iso.endsWith('-01') || d === d0) {
      // The month spans its days; its name sticks to the scale's left edge while it is in view.
      const date = new Date(d * 86_400_000);
      const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 86_400_000;
      months.push(
        <div key={`m${d}`} className="absolute top-0 h-5" style={{ left: x, width: (Math.min(next, d1 + 1) - d) * px }}>
          <span className="sticky flex h-5 w-fit items-center whitespace-nowrap px-1.5 text-caption font-semibold capitalize text-fg" style={{ left }}>
            {mf.format(date)}
          </span>
        </div>,
      );
    }
    const monday = new Date(d * 86_400_000).getUTCDay() === 1;
    if (zoom === 'quarter' ? monday : true) {
      ticks.push(
        <span
          key={`d${d}`}
          className={cx('absolute top-5 flex h-6 items-center justify-center text-micro tabular-nums', isWeekend(d) ? 'text-faint' : 'text-muted', zoom === 'quarter' && 'justify-start border-l border-line pl-1')}
          style={{ left: x, width: zoom === 'quarter' ? px * 7 : px }}
        >
          {zoom === 'week' ? df.format(new Date(d * 86_400_000)) : iso.slice(8).replace(/^0/, '')}
        </span>,
      );
    }
  }
  return (
    <div className="sticky top-0 z-[3] border-b border-line bg-[var(--color-bg)]" style={{ height: head, width }} data-testid="timeline-scale">
      {months}
      {ticks}
      {children}
      <div className="sticky left-0 top-0 z-[1] border-r border-line bg-[var(--color-bg)]" style={{ width: left, height: head - 1 }} />
    </div>
  );
});

/** Weekends and the today line, for the visible days only. */
const Grid = memo(function Grid({ origin, px, left, d0, d1, today }: { origin: number; px: number; left: number; d0: number; d1: number; today: number }): ReactNode {
  const out: ReactNode[] = [];
  for (let d = d0; d <= d1; d++) if (isWeekend(d)) out.push(<div key={d} className="absolute inset-y-0 bg-[color-mix(in_srgb,var(--color-fg)_4%,transparent)]" style={{ left: left + (d - origin) * px, width: px }} />);
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {out}
      {today >= d0 && today <= d1 ? <div className="absolute inset-y-0 w-0.5 bg-accent" style={{ left: left + (today - origin) * px + px / 2 - 1 }} data-testid="timeline-today-line" /> : null}
    </div>
  );
});

const MilestoneMark = memo(function MilestoneMark({ m, origin, px, left, delta, draggable, onDown }: { m: BoardMilestone; origin: number; px: number; left: number; delta: number; draggable: boolean; onDown: (e: ReactPointerEvent, id: string) => void }): ReactNode {
  const d = dayNum(m.dueOn);
  if (Number.isNaN(d)) return null;
  const x = left + (d + delta - origin) * px + px / 2;
  return (
    <span
      role="img"
      aria-label={`${m.name} · ${isoDay(d + delta)}`}
      title={`${m.name} · ${isoDay(d + delta)}`}
      onPointerDown={draggable ? (e) => onDown(e, m.id) : undefined}
      className={cx('absolute top-1 flex items-center gap-1 whitespace-nowrap', draggable && 'cursor-ew-resize')}
      style={{ left: x - 6 }}
      data-testid="timeline-milestone"
    >
      <span className="size-3 rotate-45 rounded-[2px] border-2 border-[var(--color-yellow)] bg-[var(--color-bg)]" aria-hidden />
      {px >= 18 ? <span className="text-micro text-muted">{m.name}</span> : null}
    </span>
  );
});

// ------------------------------------------------------------------ rows

const GroupRow = memo(function GroupRow({ k, group, top, left, boardId, workspaceId }: { k: string; group: TimelineGroup; top: number; left: number; boardId: string; workspaceId: string }): ReactNode {
  const msName = useBoards((s) => (group === 'milestone' && k ? (s.boards[boardId]?.milestones.find((m) => m.id === k)?.name ?? '') : ''));
  const label = group === 'assignee' ? (k ? memberName(workspaceId, k) : t('boards.noAssignee')) : k ? msName : t('boards.noMilestone');
  return (
    <div className="absolute inset-x-0 flex items-center border-b border-line bg-[color-mix(in_srgb,var(--color-fg)_3%,var(--color-bg))]" style={{ top, height: ROW }} data-testid="timeline-group">
      <div className="sticky left-0 flex h-full items-center gap-2 px-3 text-control font-semibold" style={{ width: left }}>
        {group === 'assignee' && k ? <MemberAvatar workspaceId={workspaceId} userId={k} size={18} /> : null}
        <span className="truncate">{label}</span>
      </div>
    </div>
  );
});

const TimelineRow = memo(function TimelineRow({
  id,
  boardId,
  top,
  origin,
  px,
  left,
  delta,
  mode,
  readOnly,
  onBarDown,
}: {
  id: string;
  boardId: string;
  top: number;
  origin: number;
  px: number;
  left: number;
  delta: number;
  mode: DragMode | null;
  readOnly: boolean;
  onBarDown: (e: ReactPointerEvent, id: string, mode: DragMode) => void;
}): ReactNode {
  const task = useBoards((s) => s.tasks[id]);
  const status = useBoards((s) => (task ? s.boards[boardId]?.statuses.find((x) => x.id === task.statusId) : undefined));
  const perms = useTaskPerms(task);
  const blockers = useBoards((s) => (task ? lateBlockers(task, s.tasks).join(', ') : ''));
  const open = useBoardsUi((s) => s.taskId === id);
  if (!task) return null;
  const span = spanOf(task);
  if (!span) return null;
  const shown: Span = mode ? dragSpan(span, mode, delta) : span;
  const box = barBox(shown, origin, px);
  const editable = !readOnly && mayEditTask(task, perms, myUserId());
  const color = colorCss(status?.color ?? 0x8e8e93);
  const openTask = (): void => useBoardsUi.getState().openTask(id);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openTask();
    }
  };
  // Mouse: the drag handler opens on a click without travel; keyboard / a tap: click (detail 0 / read-only).
  const onClick = (e: MouseEvent): void => {
    if (!editable || e.detail === 0) openTask();
  };
  return (
    <div className={cx('group/tl absolute inset-x-0 border-b border-[color-mix(in_srgb,var(--color-line)_50%,transparent)]', open && 'bg-active')} style={{ top, height: ROW }} data-testid="timeline-row" data-task={id}>
      <button
        type="button"
        onClick={openTask}
        className={cx('sticky left-0 z-[1] flex h-full items-center gap-2 border-r border-line px-3 text-left text-control hover:bg-hover', open ? 'bg-active' : 'bg-[var(--color-bg)]')}
        style={{ width: left }}
      >
        <StatusIcon type={status?.type ?? 0} color={status?.color ?? 0} />
        <span className="shrink-0 text-caption tabular-nums text-muted">{task.key}</span>
        <span className="min-w-0 truncate text-fg">{task.title}</span>
      </button>
      {box.width < 40 ? (
        <span className="pointer-events-none absolute top-1 flex h-6 max-w-64 items-center truncate text-caption text-muted" style={{ left: left + box.left + Math.max(box.width, 6) + 6 }}>
          {task.title}
        </span>
      ) : null}
      <div
        role="button"
        tabIndex={0}
        aria-label={`${task.key} ${task.title}`}
        onPointerDown={editable ? (e) => onBarDown(e, id, 'move') : undefined}
        onClick={onClick}
        onKeyDown={onKey}
        className={cx(
          'absolute top-1 flex h-6 items-center gap-1 overflow-hidden rounded-[6px] border text-caption text-fg outline-offset-1',
          editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
          mode && 'shadow-[var(--shadow-popover)]',
        )}
        style={{
          left: left + box.left,
          width: Math.max(box.width, 6),
          background: `color-mix(in srgb, ${color} 26%, var(--color-bg))`,
          borderColor: `color-mix(in srgb, ${color} 70%, transparent)`,
        }}
        title={blockers ? t('boards.tl.blocked', { keys: blockers }) : `${task.key} · ${task.title}`}
        data-testid="timeline-bar"
      >
        {blockers ? <span className="ml-1 size-2 shrink-0 rounded-full bg-[var(--color-red)]" aria-label={t('boards.tl.blocked', { keys: blockers })} data-testid="bar-blocked" /> : null}
        {box.width >= 40 ? <span className="min-w-0 truncate px-1.5">{task.title}</span> : null}
        {editable ? (
          <>
            <span onPointerDown={(e) => onBarDown(e, id, 'start')} className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize opacity-0 group-hover/tl:opacity-100" style={{ background: color }} data-testid="bar-start" />
            <span onPointerDown={(e) => onBarDown(e, id, 'end')} className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize opacity-0 group-hover/tl:opacity-100" style={{ background: color }} data-testid="bar-end" />
          </>
        ) : null}
      </div>
    </div>
  );
});

const UndatedChip = memo(function UndatedChip({ id, boardId, readOnly, dragging, onDown }: { id: string; boardId: string; readOnly: boolean; dragging: boolean; onDown: (e: ReactPointerEvent, id: string) => void }): ReactNode {
  const task = useBoards((s) => s.tasks[id]);
  const status = useBoards((s) => (task ? s.boards[boardId]?.statuses.find((x) => x.id === task.statusId) : undefined));
  const perms = useTaskPerms(task);
  if (!task) return null;
  const editable = !readOnly && mayEditTask(task, perms, myUserId());
  return (
    <button
      type="button"
      onPointerDown={editable ? (e) => onDown(e, id) : undefined}
      onClick={(e) => {
        if (!editable || e.detail === 0) useBoardsUi.getState().openTask(id);
      }}
      className={cx('inline-flex h-7 max-w-64 items-center gap-1.5 rounded-full border border-line px-2.5 text-control hover:bg-hover', editable && 'cursor-grab', dragging && 'opacity-40')}
      data-testid="undated-task"
    >
      <StatusIcon type={status?.type ?? 0} color={status?.color ?? 0} />
      <span className="shrink-0 text-caption tabular-nums text-muted">{task.key}</span>
      <span className="min-w-0 truncate">{task.title}</span>
    </button>
  );
});

function PlaceGhost({ id, x, y }: { id: string; x: number; y: number }): ReactNode {
  const key = useBoards((s) => s.tasks[id]?.key ?? '');
  const title = useBoards((s) => s.tasks[id]?.title ?? '');
  return (
    <div className="mat-popover pointer-events-none fixed z-[var(--z-popover)] flex h-7 max-w-64 items-center gap-1.5 rounded-full px-2.5 text-control" style={{ left: x + 8, top: y - 14 }} aria-hidden>
      <span className="text-caption tabular-nums text-muted">{key}</span>
      <span className="truncate">{title}</span>
    </div>
  );
}
