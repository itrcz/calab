import { ArrowLeft, ArrowRight, ChevronRight } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { BoardFeature, type BoardMilestone, type TaskMilestone } from '@calaba/protocol';
import { Button, Segmented, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { useMobile } from '../../lib/mobile';
import { milestoneHint, milestoneState } from '../../lib/boards/milestones';
import {
  DAY_PX,
  GROUP_ROW,
  barBox,
  datePatch,
  dayAt,
  dayCenter,
  dayNum,
  dayPill,
  dayWindow,
  daysOf,
  dragSpan,
  isWeekend,
  isoDay,
  labelWidth,
  lateBlockers,
  layoutLabels,
  monthLabel,
  nextMonth,
  offscreenSide,
  offscreenText,
  placePatch,
  revealScroll,
  rowWindow,
  scaleMarks,
  scaleRange,
  spanOf,
  timelineRows,
  viewDays,
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
import { MilestoneDiamond } from './TaskMilestones';
import { useFeatureOn, useMatchCtx } from './useBoardView';
import { useTaskPerms } from './useTaskPerms';
import { StatusIcon, colorCss, formatDue } from './visuals';

/**
 * Timeline (Gantt) of a board (ADR-0042 §5, docs/08 «Доски задач»): the dated tasks as rows (a
 * sticky list on the left, bars in the status colour on the scale), week / month / quarter zoom,
 * weekends shaded, milestones of the board as diamonds on the scale, a red marker on a bar whose
 * blocker ends after it starts, grouping by assignee / milestone. The scale (ADR-0063
 * «Дополнение»): numbers at week starts, the month once a row above, the today pill «4 ОКТ» with
 * a 1 px accent line and the hover pill + line (a leaf: pointermove → rAF, local state only).
 * Rows: the title above the bar, the task's own milestones as diamonds on it with their names
 * below, a task outside the viewport gets «← янв 2025» / «28 мая – 27 авг →» (a click scrolls to
 * it); a phone gets compact rows (title inside the bar), read-only. D&D: a bar moves, its edges
 * change the start / due date, a board milestone moves, a task from «Без дат» gets a day — the
 * store is written on drop only (updateTask, optimistic). Rows and the scale's labels render for
 * the visible window only. Math: lib/boards/timeline.ts.
 */

const ROW = 56;
const ROW_COMPACT = 32;
const HEAD = 44;
const LANE = 20;
/** Bar geometry inside a row: the title above (full rows), the milestones' names below. */
const BAR_TOP = 22;
const BAR_H = 20;
/** The title above a short bar may run past it (up to this width). */
const TITLE_MIN = 280;

type Drag =
  | { kind: 'bar'; id: string; mode: DragMode; x: number; delta: number; moved: boolean }
  | { kind: 'ms'; id: string; x: number; delta: number; moved: boolean }
  | { kind: 'place'; id: string; x: number; y: number; moved: boolean };

const NO_MS: BoardMilestone[] = [];
const ZOOMS: Zoom[] = ['week', 'month', 'quarter'];
const GROUPS: TimelineGroup[] = ['none', 'assignee', 'milestone'];

export function Timeline({ boardId, workspaceId }: { boardId: string; workspaceId: string }): ReactNode {
  const mobile = useMobile();
  const locale = useLocale();
  const prefs = useBoardsUi((s) => prefsOf(s, boardId));
  const zoom = prefs.zoom ?? 'month';
  const group = prefs.tlGroup ?? 'none';
  const px = DAY_PX[zoom];
  const left = mobile ? 132 : 248;
  const rowH = mobile ? ROW_COMPACT : ROW;
  const ctx = useMatchCtx(boardId);
  const milestones = useBoards(useShallow((s) => s.boards[boardId]?.milestones ?? NO_MS));
  const manage = useBoards((s) => hasBit(s.boards[boardId]?.permissions, MANAGE_BOARD));
  const today = dayNum(useToday());
  // What rows / range read, as a primitive: an edit of a title leaves the rows as they are.
  const shape = useBoards((s) => {
    const b = s.boards[boardId];
    if (!b) return '';
    let out = '';
    for (const x of visibleTasks(s, b, prefs, ctx)) {
      out += `${x.id}|${x.startOn}|${x.dueOn}|${x.number}|${x.assignees.find((a) => a.isLead)?.userId ?? ''}|${x.milestoneId}|`;
      for (const m of x.milestones) out += `${m.dueOn},`;
      out += ';';
    }
    return out;
  });
  const { rows, undated, range } = useMemo(() => {
    const s = useBoards.getState();
    const b = s.boards[boardId];
    const list = b ? visibleTasks(s, b, prefs, ctx) : [];
    const days: number[] = [];
    for (const x of list) {
      days.push(dayNum(x.startOn), dayNum(x.dueOn));
      for (const m of x.milestones) days.push(dayNum(m.dueOn));
    }
    for (const m of milestones) days.push(dayNum(m.dueOn));
    return { ...timelineRows(list, group), range: scaleRange(days, today) };
    // `shape` stands for the tasks read through getState().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, group, boardId, prefs, ctx, milestones, today]);
  const head = HEAD + (milestones.length ? LANE : 0);
  const origin = range.start;
  const days = range.end - range.start + 1;

  // ---- the visible window (rows, days with overscan) and the viewport's days (the off-screen
  // hints); state changes only when one of them does.
  const scroller = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ first: 0, last: 30, d0: origin, d1: origin + 90, v0: origin, v1: origin + 60 });
  const sync = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const r = rowWindow(el.scrollTop, el.clientHeight - head, rowH, rows.length);
    // Days in whole weeks: horizontal scrolling re-renders the scale once a week of travel.
    const q = px * 7;
    const d = dayWindow(Math.max(0, Math.floor(el.scrollLeft / q) * q - q), el.clientWidth + 3 * q, px, range);
    const v = viewDays(el.scrollLeft, el.clientWidth, px, left, origin);
    setWin((w) =>
      w.first === r.first && w.last === r.last && w.d0 === d.start && w.d1 === d.end && w.v0 === v.start && w.v1 === v.end
        ? w
        : { first: r.first, last: r.last, d0: d.start, d1: d.end, v0: v.start, v1: v.end },
    );
  }, [rows.length, head, rowH, px, range, left, origin]);
  // The visible edge for the milestone labels: the sticky column's end, day-precise.
  useEffect(() => {
    useLabelEdge.setState({ x: left + (win.v0 - origin) * px });
  }, [win.v0, origin, px, left]);
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
  // An off-screen hint's click: the task's start a few days from the left edge.
  const reveal = useCallback(
    (id: string) => {
      const el = scroller.current;
      const task = useBoards.getState().tasks[id];
      const span = task ? spanOf(task) : null;
      if (el && span) el.scrollTo({ left: revealScroll(span, origin, px, zoom), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    },
    [origin, px, zoom],
  );

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
  const taskMs = useFeatureOn(boardId, BoardFeature.MILESTONES);
  if (rows.length === 0 && undated.length === 0) return <EmptyBoard />;
  const readOnly = mobile || !startOn || !dueOn;
  const barDrag = drag?.kind === 'bar' && drag.moved ? drag : null;
  const msDrag = drag?.kind === 'ms' && drag.moved ? drag : null;
  // While a bar is dragged the hover pill shows the date of the edge that moves.
  let pin: number | null = null;
  if (barDrag) {
    const task = useBoards.getState().tasks[barDrag.id];
    const span = task ? spanOf(task) : null;
    if (span) {
      const next = dragSpan(span, barDrag.mode, barDrag.delta);
      pin = barDrag.mode === 'end' ? next.end : next.start;
    }
  }
  const shownRows = rows.slice(win.first, win.last);
  const view: Span = { start: win.v0, end: win.v1 };
  // Off-screen hints: a primitive per row, so a scroll re-renders only rows whose side changes.
  const tasksNow = useBoards.getState().tasks;
  const sideOf = (id: string, v: Span): 'left' | 'right' | null => {
    const tk = tasksNow[id];
    const sp = tk ? spanOf(tk) : null;
    return sp ? offscreenSide(sp, v) : null;
  };
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
        <div className="relative" style={{ width: left + days * px, height: head + rows.length * rowH, minHeight: '100%' }}>
          <Grid origin={origin} px={px} left={left} d0={win.d0} d1={win.d1} today={today} />
          <Scale origin={origin} px={px} left={left} d0={win.d0} d1={win.d1} zoom={zoom} head={head} width={left + days * px} today={today} locale={locale}>
            {milestones.length ? (
              <div className="absolute inset-x-0 bottom-0 h-5" data-testid="timeline-milestones">
                {milestones.map((m) => (
                  <MilestoneMark key={m.id} m={m} origin={origin} px={px} left={left} delta={msDrag?.id === m.id ? msDrag.delta : 0} draggable={manage && !readOnly} onDown={onMsDown} />
                ))}
              </div>
            ) : null}
            {mobile ? null : <HoverMarker scroller={scroller} origin={origin} px={px} left={left} head={head} pin={pin} locale={locale} />}
          </Scale>
          {shownRows.map((id, i) =>
            id.startsWith(GROUP_ROW) ? (
              <GroupRow key={id} k={id.slice(GROUP_ROW.length)} group={group} top={head + (win.first + i) * rowH} height={rowH} left={left} boardId={boardId} workspaceId={workspaceId} />
            ) : (
              <TimelineRow
                key={id}
                id={id}
                boardId={boardId}
                top={head + (win.first + i) * rowH}
                origin={origin}
                px={px}
                left={left}
                compact={mobile}
                side={barDrag?.id === id ? null : sideOf(id, view)}
                today={today}
                locale={locale}
                milestones={taskMs}
                delta={barDrag?.id === id ? barDrag.delta : 0}
                mode={barDrag?.id === id ? barDrag.mode : null}
                readOnly={readOnly}
                onBarDown={onBarDown}
                onReveal={reveal}
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

/** A pill on the scale's number row: today (accent) or the hover (grey). */
const pillCls = 'pointer-events-none absolute top-[22px] flex h-5 -translate-x-1/2 items-center whitespace-nowrap rounded-full px-1.5 text-micro font-semibold tabular-nums';

/**
 * The header (sticky on top): the month once above its first week, the numbers at week starts
 * (months only on the quarter zoom), the today pill, then the board milestones' lane.
 */
const Scale = memo(function Scale({
  origin,
  px,
  left,
  d0,
  d1,
  zoom,
  head,
  width,
  today,
  locale,
  children,
}: {
  origin: number;
  px: number;
  left: number;
  d0: number;
  d1: number;
  zoom: Zoom;
  head: number;
  width: number;
  today: number;
  locale: string;
  children: ReactNode;
}): ReactNode {
  const { weeks, months } = useMemo(() => scaleMarks(d0, d1, zoom), [d0, d1, zoom]);
  const x = (d: number): number => left + (d - origin) * px;
  return (
    <div className="sticky top-0 z-[3] border-b border-line bg-[var(--color-bg)]" style={{ height: head, width }} data-testid="timeline-scale">
      {months.map((d) => (
        // A month segment: its name sticks to the scale's left edge while the month is in view.
        <div key={`m${d}`} className={cx('absolute h-5', zoom === 'quarter' ? 'top-[22px]' : 'top-0.5')} style={{ left: x(d), width: (Math.min(nextMonth(d), d1 + 1) - d) * px }}>
          <span className="sticky flex h-5 w-fit items-center whitespace-nowrap px-0.5 text-micro font-semibold tracking-wide text-muted" style={{ left: left + 4 }} data-testid="timeline-month">
            {monthLabel(d, today, locale)}
          </span>
        </div>
      ))}
      {weeks.map((d) => (
        <span key={`w${d}`} className="absolute top-[22px] flex h-5 items-center whitespace-nowrap text-micro tabular-nums text-faint" style={{ left: x(d) }} data-testid="timeline-week">
          {new Date(d * 86_400_000).getUTCDate()}
        </span>
      ))}
      {today >= d0 && today <= d1 ? (
        <span className={cx(pillCls, 'z-[1] bg-accent-strong text-accent-fg')} style={{ left: dayCenter(today, origin, px, left) }} data-testid="timeline-today-pill">
          {dayPill(today, locale)}
        </span>
      ) : null}
      {children}
      <div className="sticky left-0 top-0 z-[2] border-r border-line bg-[var(--color-bg)]" style={{ width: left, height: head - 1 }} />
    </div>
  );
});

/**
 * The hover marker: a grey pill with the day under the pointer and a 1 px line down the visible
 * rows. A leaf with local state only: pointermove → one requestAnimationFrame → the day (a render
 * only when the day changes); no timers, no store writes; hidden when the pointer leaves. `pin`
 * (a dragged bar's edge) wins over the pointer.
 */
function HoverMarker({ scroller, origin, px, left, head, pin, locale }: { scroller: RefObject<HTMLDivElement | null>; origin: number; px: number; left: number; head: number; pin: number | null; locale: string }): ReactNode {
  const [at, setAt] = useState<{ day: number; h: number } | null>(null);
  const geo = useRef({ origin, px, left, head });
  useLayoutEffect(() => {
    geo.current = { origin, px, left, head };
  }, [origin, px, left, head]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let raf = 0;
    let cx = 0;
    let cy = 0;
    const measure = (): void => {
      raf = 0;
      const box = el.getBoundingClientRect();
      const g = geo.current;
      const day = cy - box.top < g.head ? null : dayAt(cx - box.left + el.scrollLeft, g.origin, g.px, g.left);
      const h = el.clientHeight - g.head;
      setAt((p) => (day === null ? null : p && p.day === day && p.h === h ? p : { day, h }));
    };
    const move = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return;
      cx = e.clientX;
      cy = e.clientY;
      if (!raf) raf = requestAnimationFrame(measure);
    };
    const scroll = (): void => {
      if (cx && !raf) raf = requestAnimationFrame(measure);
    };
    const leave = (): void => {
      cancelAnimationFrame(raf);
      raf = 0;
      cx = 0;
      setAt(null);
    };
    el.addEventListener('pointermove', move, { passive: true });
    el.addEventListener('scroll', scroll, { passive: true });
    el.addEventListener('pointerleave', leave);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('scroll', scroll);
      el.removeEventListener('pointerleave', leave);
    };
  }, [scroller]);
  const day = pin ?? at?.day ?? null;
  if (day === null) return null;
  const x = dayCenter(day, origin, px, left);
  const h = at?.h ?? (scroller.current ? scroller.current.clientHeight - head : 0);
  return (
    <>
      <span className={cx(pillCls, 'z-[1] bg-[color-mix(in_srgb,var(--color-fg)_16%,var(--color-bg))] text-fg')} style={{ left: x }} data-testid="timeline-hover-pill">
        {dayPill(day, locale)}
      </span>
      <span aria-hidden className="pointer-events-none absolute w-px bg-[color-mix(in_srgb,var(--color-fg)_25%,transparent)]" style={{ left: Math.floor(x), top: head, height: Math.max(0, h) }} data-testid="timeline-hover-line" />
    </>
  );
}

/** Weekends (shading) and the today line (1 px accent), for the visible days only. */
const Grid = memo(function Grid({ origin, px, left, d0, d1, today }: { origin: number; px: number; left: number; d0: number; d1: number; today: number }): ReactNode {
  const out: ReactNode[] = [];
  for (let d = d0; d <= d1; d++) if (isWeekend(d)) out.push(<div key={d} className="absolute inset-y-0 bg-[color-mix(in_srgb,var(--color-fg)_4%,transparent)]" style={{ left: left + (d - origin) * px, width: px }} />);
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {out}
      {today >= d0 && today <= d1 ? <div className="absolute inset-y-0 w-px bg-accent" style={{ left: Math.floor(dayCenter(today, origin, px, left)) }} data-testid="timeline-today-line" /> : null}
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

const GroupRow = memo(function GroupRow({ k, group, top, height, left, boardId, workspaceId }: { k: string; group: TimelineGroup; top: number; height: number; left: number; boardId: string; workspaceId: string }): ReactNode {
  const msName = useBoards((s) => (group === 'milestone' && k ? (s.boards[boardId]?.milestones.find((m) => m.id === k)?.name ?? '') : ''));
  const label = group === 'assignee' ? (k ? memberName(workspaceId, k) : t('boards.noAssignee')) : k ? msName : t('boards.noMilestone');
  return (
    <div className="absolute inset-x-0 flex items-center border-b border-line bg-[color-mix(in_srgb,var(--color-fg)_3%,var(--color-bg))]" style={{ top, height }} data-testid="timeline-group">
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
  compact,
  side,
  today,
  locale,
  milestones,
  delta,
  mode,
  readOnly,
  onBarDown,
  onReveal,
}: {
  id: string;
  boardId: string;
  top: number;
  origin: number;
  px: number;
  left: number;
  compact: boolean;
  side: 'left' | 'right' | null;
  today: number;
  locale: string;
  milestones: boolean;
  delta: number;
  mode: DragMode | null;
  readOnly: boolean;
  onBarDown: (e: ReactPointerEvent, id: string, mode: DragMode) => void;
  onReveal: (id: string) => void;
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
  const rowH = compact ? ROW_COMPACT : ROW;
  const barTop = compact ? 4 : BAR_TOP;
  const barH = compact ? 24 : BAR_H;
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
  const inside = compact && box.width >= 40;
  const dates = side ? offscreenText(span, today, locale) : '';
  return (
    <div className={cx('group/tl absolute inset-x-0 border-b border-[color-mix(in_srgb,var(--color-line)_50%,transparent)]', open && 'bg-active')} style={{ top, height: rowH }} data-testid="timeline-row" data-task={id}>
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
      {side ? (
        // Off screen: «← янв 2025» at the left edge / «28 мая – 27 авг →» at the right; a click scrolls there.
        <div className={cx('pointer-events-none absolute inset-0 flex items-center', side === 'right' && 'justify-end')}>
          <button
            type="button"
            onClick={() => onReveal(id)}
            className="pointer-events-auto sticky flex h-6 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-row)] px-1.5 text-caption tabular-nums text-faint hover:bg-hover hover:text-muted"
            style={side === 'left' ? { left: left + 8 } : { right: 8 }}
            aria-label={t('boards.tl.toTask', { dates })}
            data-testid="timeline-offscreen"
            data-side={side}
          >
            {side === 'left' ? <ArrowLeft className="size-3.5" aria-hidden /> : null}
            {dates}
            {side === 'right' ? <ArrowRight className="size-3.5" aria-hidden /> : null}
          </button>
        </div>
      ) : null}
      {compact || side ? null : (
        // The title above the bar (Linear): it slides along while the bar's start is scrolled away.
        <div className="pointer-events-none absolute flex h-4 items-center" style={{ top: 3, left: left + box.left, width: Math.max(box.width, TITLE_MIN) }}>
          <span className="sticky min-w-0 truncate whitespace-nowrap text-caption font-medium text-fg" style={{ left: left + 6 }}>
            {task.title}
          </span>
        </div>
      )}
      {compact && !inside ? (
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
          'absolute flex items-center gap-1 overflow-hidden rounded-[6px] border text-caption text-fg outline-offset-1',
          editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
          mode && 'shadow-[var(--shadow-popover)]',
        )}
        style={{
          top: barTop,
          height: barH,
          left: left + box.left,
          width: Math.max(box.width, 6),
          background: `color-mix(in srgb, ${color} 26%, var(--color-bg))`,
          borderColor: `color-mix(in srgb, ${color} 70%, transparent)`,
        }}
        title={blockers ? t('boards.tl.blocked', { keys: blockers }) : `${task.key} · ${task.title}`}
        data-testid="timeline-bar"
      >
        {blockers ? <span className="ml-1 size-2 shrink-0 rounded-full bg-[var(--color-red)]" aria-label={t('boards.tl.blocked', { keys: blockers })} data-testid="bar-blocked" /> : null}
        {inside ? <span className="min-w-0 truncate px-1.5">{task.title}</span> : null}
        {editable ? (
          <>
            <span onPointerDown={(e) => onBarDown(e, id, 'start')} className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize opacity-0 group-hover/tl:opacity-100" style={{ background: color }} data-testid="bar-start" />
            <span onPointerDown={(e) => onBarDown(e, id, 'end')} className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize opacity-0 group-hover/tl:opacity-100" style={{ background: color }} data-testid="bar-end" />
          </>
        ) : null}
      </div>
      {milestones ? task.milestones.map((m) => <TaskDiamond key={m.id} m={m} origin={origin} px={px} left={left} top={barTop + barH / 2} today={today} />) : null}
      {milestones && !compact && task.milestones.length ? <TaskMilestoneLabels milestones={task.milestones} origin={origin} px={px} left={left} top={barTop + barH / 2} /> : null}
    </div>
  );
});

/**
 * A milestone of the task on its bar (ADR-0063 §5): the diamond at its date (filled: completed,
 * red: overdue), its name below; the hint — name, date, progress of the linked subtasks.
 */
const TaskDiamond = memo(function TaskDiamond({ m, origin, px, left, top, today }: { m: TaskMilestone; origin: number; px: number; left: number; top: number; today: number }): ReactNode {
  const d = dayNum(m.dueOn);
  if (Number.isNaN(d)) return null;
  const x = dayCenter(d, origin, px, left);
  const iso = isoDay(today);
  const hint = milestoneHint(m, formatDue(m.dueOn, iso));
  return (
    <span role="img" aria-label={hint} title={hint} className="absolute grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center" style={{ left: x, top }} data-testid="timeline-task-milestone">
      <MilestoneDiamond state={milestoneState(m, iso)} size={12} />
    </span>
  );
});

/** Content x where the sticky column's shadow ends (the visible edge); set by the Timeline per day of scroll. */
const useLabelEdge = create<{ x: number }>(() => ({ x: 0 }));

/**
 * The names under a bar's milestone diamonds (ADR-0063 §5): centred, shifted right off the previous
 * name / the sticky column, hidden when crowded (the diamond's tooltip has the name). The layout
 * is memoized on the row's milestones, the zoom and the scroll edge; only rows with milestones
 * subscribe to the edge.
 */
const TaskMilestoneLabels = memo(function TaskMilestoneLabels({ milestones, origin, px, left, top }: { milestones: TaskMilestone[]; origin: number; px: number; left: number; top: number }): ReactNode {
  const edge = useLabelEdge((s) => s.x);
  const items = useMemo(() => {
    const list = milestones.filter((m) => !Number.isNaN(dayNum(m.dueOn)));
    const xs = list.map((m) => dayCenter(dayNum(m.dueOn), origin, px, left));
    const pos = layoutLabels(xs, list.map((m) => labelWidth(m.name)), edge);
    return list.map((m, i) => ({ id: m.id, name: m.name, x: pos[i] ?? null }));
  }, [milestones, origin, px, left, edge]);
  return (
    <>
      {items.map((it) =>
        it.x === null ? null : (
          <span key={it.id} className="pointer-events-none absolute max-w-28 truncate whitespace-nowrap text-micro leading-none text-muted" style={{ left: it.x, top: top + BAR_H / 2 + 3 }} aria-hidden data-testid="timeline-task-milestone-label">
            {it.name}
          </span>
        ),
      )}
    </>
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
