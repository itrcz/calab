import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { DRAG_THRESHOLD_PX, createRange, minutesAt, moveRange, resizeRange, type Range } from '../../lib/calendar/drag';
import { addDays, atMinutes, dayEnd, dayKey, dayStart, eventSpan } from '../../lib/calendar/time';
import type { ScrollTarget } from '../../lib/calendar/scrollTarget';
import { canEditEvent, eventOf, moveOccurrence } from '../../services/calendar';
import { useUi } from '../../stores/ui';
import { askSeriesScope, cancelWithConfirm, defaultDraft, newEvent } from './actions';
import type { BlockDown } from './blocks';
import { useDayDrag } from './dragState';
import { PX_PER_MIN } from './gridParts';

/*
 * The pointer and keyboard controls of the calendar grid, shared by the day and the week view
 * (owner, 29.09: d&d like Apple Calendar). The week view passes `dayAt` — the day of the column
 * under the pointer — and a 7-day step; the day view its one day and 1.
 */

/** Hold near the grid's left / right edge this long while dragging → previous / next day (week). */
const EDGE_DWELL_MS = 700;
const EDGE_PX = 24;

/**
 * Another day / week (‹ ›, ←/→, T, the mini month): a card of a meeting not in [from, to) closes
 * (Apple). Not while dragging (holding at the edge flips days with the dragged meeting still
 * selected); an occurrence not loaded yet (a deep link) stays.
 */
export function useCloseCardOutside(from: number, to: number): void {
  const shown = useRef(from);
  useEffect(() => {
    if (shown.current === from) return;
    shown.current = from;
    const ui = useUi.getState();
    const ev = ui.calEvent ? eventOf(ui.calEvent) : undefined;
    if (!ev || useDayDrag.getState().mode) return;
    const span = eventSpan(ev);
    if (span.end <= from || span.start >= to) ui.selectCalEvent(null);
  }, [from, to]);
}

/**
 * Scrolls the hour grid to `minute` (a third from the top), again while the pane settles (on a
 * phone it is laid out as the drawer closes): on its resizes during the first second, until the
 * user scrolls it. Returns the cleanup.
 */
export function settleScroll(el: HTMLElement, target: ScrollTarget): () => void {
  const apply = (): void => {
    el.scrollTop = Math.max(0, target.minute * PX_PER_MIN - (target.at === 'third' ? el.clientHeight / 3 : 0));
  };
  apply();
  const ro = new ResizeObserver(apply);
  ro.observe(el);
  const stop = (): void => ro.disconnect();
  const timer = window.setTimeout(stop, 1000);
  el.addEventListener('wheel', stop, { once: true, passive: true });
  el.addEventListener('touchstart', stop, { once: true, passive: true });
  return () => {
    stop();
    window.clearTimeout(timer);
    el.removeEventListener('wheel', stop);
    el.removeEventListener('touchstart', stop);
  };
}

// ---------------------------------------------------------------- drag controller

interface Press {
  kind: 'block' | 'grid';
  key: string | null;
  mode: 'move' | 'resize' | 'create';
  editable: boolean;
  touch: boolean;
  x0: number;
  y0: number;
  moved: boolean;
  /** The day (column) where the press started. */
  day: string;
  /** The block's range in minutes of that day. */
  orig: Range;
  wasAllDay: boolean;
  /** Minutes between the block's top and the press point. */
  grab: number;
  /** Grid minute under the press (a range selection). */
  anchor: number;
  /** Last pointer (edge dwell, key-switched days re-evaluate it). */
  x: number;
  y: number;
}

export function useDragController({
  workspaceId,
  day,
  grid,
  scroller,
  creatable,
  mobile,
  dayAt,
  step = 1,
}: {
  workspaceId: string;
  /** The view's day (the anchor of the week view). */
  day: string;
  grid: RefObject<HTMLDivElement | null>;
  scroller: RefObject<HTMLDivElement | null>;
  creatable: boolean;
  mobile: boolean;
  /** The week view: the day of the column under a pointer x; the day view: its day. */
  dayAt?: (x: number) => string;
  /** Days flipped by holding at the grid's edge while moving a block. */
  step?: number;
}): { onGridDown: (e: ReactPointerEvent<HTMLDivElement>) => void; onBlockDown: BlockDown } {
  const press = useRef<Press | null>(null);
  const dayRef = useRef(day);
  const dayAtRef = useRef(dayAt);
  useEffect(() => {
    dayRef.current = day;
    dayAtRef.current = dayAt;
  }, [day, dayAt]);
  const edgeTimer = useRef<number | null>(null);
  const edgeSide = useRef<-1 | 0 | 1>(0);

  const minuteAt = (clientY: number): number => {
    const r = grid.current?.getBoundingClientRect();
    return r ? minutesAt(clientY - r.top, PX_PER_MIN) : 0;
  };
  const columnDay = (x: number): string => dayAtRef.current?.(x) ?? dayRef.current;

  const update = useCallback((x: number, y: number): void => {
    const p = press.current;
    if (!p || !p.moved) return;
    const drag = useDayDrag.getState();
    if (p.mode === 'create') {
      drag.set({ range: createRange(p.anchor, minuteAt(y), true), day: p.day });
      return;
    }
    if (p.mode === 'resize') {
      drag.set({ range: resizeRange(p.orig, minuteAt(y)), day: p.day });
      return;
    }
    const under = document.elementFromPoint(x, y);
    const overDay = under?.closest<HTMLElement>('[data-cal-day]')?.dataset['calDay'] ?? null;
    if (overDay) {
      drag.set({ overDay, allDay: false, range: null, day: null });
      return;
    }
    const allDayCell = under?.closest<HTMLElement>('[data-cal-allday]')?.dataset['calAllday'];
    if (allDayCell) {
      drag.set({ allDay: true, overDay: null, range: null, day: allDayCell });
      return;
    }
    const g = grid.current?.getBoundingClientRect();
    const inGrid = !!g && x >= g.left - 60 && x <= g.right + 8;
    drag.set({ allDay: false, overDay: null, range: inGrid ? moveRange(p.orig, p.grab, minuteAt(y)) : null, day: inGrid ? columnDay(x) : null });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stopEdge = (): void => {
    if (edgeTimer.current !== null) window.clearTimeout(edgeTimer.current);
    edgeTimer.current = null;
    edgeSide.current = 0;
  };

  // Holding at the grid's left / right edge while moving a block flips the day / week (repeats).
  const edge = (x: number): void => {
    const p = press.current;
    const box = scroller.current?.getBoundingClientRect();
    if (!p || p.mode !== 'move' || !p.editable || !box) {
      stopEdge();
      return;
    }
    const side: -1 | 0 | 1 = x < box.left + EDGE_PX ? -1 : x > box.right - EDGE_PX ? 1 : 0;
    if (side === edgeSide.current) return;
    stopEdge();
    edgeSide.current = side;
    if (!side) return;
    const flip = (): void => {
      useUi.getState().openCalendarDay(addDays(dayRef.current, side * step));
      edgeTimer.current = window.setTimeout(flip, EDGE_DWELL_MS);
    };
    edgeTimer.current = window.setTimeout(flip, EDGE_DWELL_MS);
  };

  // A day switched while dragging (←/→, edge): the ghost re-evaluates at the same pointer.
  useEffect(() => {
    const p = press.current;
    if (p?.moved) requestAnimationFrame(() => update(p.x, p.y));
  }, [day, update]);

  const onMove = useCallback((e: PointerEvent): void => {
    const p = press.current;
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (!p.moved) {
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < DRAG_THRESHOLD_PX) return;
      // Touch: a drag is a scroll (no long-press drag on phones — the card has the same actions).
      if (p.touch) {
        press.current = null;
        detach();
        return;
      }
      p.moved = true;
      if (p.kind === 'block' && !p.editable) {
        useDayDrag.getState().set({ key: p.key, mode: p.mode, locked: true });
        return;
      }
      useDayDrag.getState().set({ key: p.key, mode: p.mode, locked: false });
    }
    if (useDayDrag.getState().locked) return;
    // Near the scroller's top / bottom: scroll the grid.
    const box = scroller.current?.getBoundingClientRect();
    if (box && scroller.current) {
      if (e.clientY < box.top + 24) scroller.current.scrollTop -= 12;
      else if (e.clientY > box.bottom - 24) scroller.current.scrollTop += 12;
    }
    update(e.clientX, e.clientY);
    edge(e.clientX);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onUp = useCallback((e: PointerEvent): void => {
    const p = press.current;
    press.current = null;
    detach();
    stopEdge();
    const drag = useDayDrag.getState();
    const { range, allDay, overDay, locked, day: dropDay } = drag;
    drag.clear();
    if (!p || e.type === 'pointercancel') return;
    if (!p.moved) {
      if (p.kind === 'block' && p.key) useUi.getState().selectCalEvent(p.key);
      // With a meeting selected, a click on the empty grid first closes its card (below 1200 px it
      // floats over the grid); the next click (or a drag) creates.
      else if (p.kind === 'grid' && useUi.getState().calEvent) useUi.getState().selectCalEvent(null);
      else if (p.kind === 'grid' && creatable) {
        const r = createRange(p.anchor, p.anchor, false);
        newEvent(workspaceId, { start: atMinutes(p.day, r.start).getTime(), end: atMinutes(p.day, r.end).getTime() });
      }
      return;
    }
    if (locked) return;
    // The day the drop lands on: the column under the pointer (week), else the view's day.
    const target = dropDay ?? (p.mode === 'move' ? dayRef.current : p.day);
    if (p.mode === 'create') {
      if (range) newEvent(workspaceId, { start: atMinutes(target, range.start).getTime(), end: atMinutes(target, range.end).getTime() });
      return;
    }
    if (!p.key) return;
    const ev = eventOf(p.key);
    if (!ev) return;
    const span = eventSpan(ev);
    let start: number;
    let end: number;
    let nextAllDay = ev.allDay;
    if (overDay) {
      if (ev.allDay) {
        start = dayStart(overDay);
        end = dayStart(addDays(overDay, Math.max(1, Math.round((span.end - span.start) / 86_400_000))));
      } else {
        start = atMinutes(overDay, Math.max(0, p.orig.start)).getTime();
        end = start + (span.end - span.start);
      }
    } else if (allDay) {
      nextAllDay = true;
      start = dayStart(target);
      end = dayEnd(target);
    } else if (range) {
      nextAllDay = false;
      start = atMinutes(target, range.start).getTime();
      end = atMinutes(target, range.end).getTime();
    } else return;
    if (start === span.start && end === span.end && nextAllDay === ev.allDay) return;
    void moveOccurrence(p.key, start, end, nextAllDay !== ev.allDay ? nextAllDay : undefined, () => askSeriesScope('move', span.start));
  }, [creatable, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  function detach(): void {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  }

  const attach = (): void => {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  useEffect(() => () => {
    detach();
    stopEdge();
    useDayDrag.getState().clear();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Stable (refs inside): the memo blocks and the week's columns keep their props across renders.
  const onBlockDown = useCallback<BlockDown>((e, key, mode) => {
    if (e.button !== 0 || press.current) return;
    e.stopPropagation();
    const ev = eventOf(key);
    if (!ev) return;
    const pressDay = columnDay(e.clientX);
    const ds = dayStart(pressDay);
    const span = eventSpan(ev);
    const orig = ev.allDay ? { start: 9 * 60, end: 10 * 60 } : { start: (span.start - ds) / 60_000, end: (span.end - ds) / 60_000 };
    const grab = ev.allDay ? 0 : minuteAt(e.clientY) - orig.start;
    press.current = {
      kind: 'block',
      key,
      mode,
      editable: canEditEvent(ev),
      touch: e.pointerType === 'touch' || mobile,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      day: pressDay,
      orig,
      wasAllDay: ev.allDay,
      grab,
      anchor: 0,
    };
    attach();
  }, [mobile, onUp]); // eslint-disable-line react-hooks/exhaustive-deps

  const onGridDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // A press that closes the open meeting dialog (a click outside it) does not start another one.
    // The week view's columns are the grid's background too (`data-grid-bg`).
    const bg = e.target === e.currentTarget || (e.target instanceof HTMLElement && e.target.hasAttribute('data-grid-bg'));
    if (e.button !== 0 || press.current || !bg || useUi.getState().dialog) return;
    press.current = {
      kind: 'grid',
      key: null,
      mode: 'create',
      editable: creatable,
      touch: e.pointerType === 'touch' || mobile,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      day: columnDay(e.clientX),
      orig: { start: 0, end: 0 },
      wasAllDay: false,
      grab: 0,
      anchor: minuteAt(e.clientY),
    };
    if (!creatable) return;
    attach();
  };

  return { onGridDown, onBlockDown };
}

// ---------------------------------------------------------------- keys

/**
 * N new, ←/→ day (the week view: week — `step`), T today, Delete cancels the selected meeting,
 * Esc closes its card (not while typing or in a dialog).
 */
export function useDayKeys(workspaceId: string, day: string, creatable: boolean, step = 1): void {
  const dayRef = useRef(day);
  useEffect(() => {
    dayRef.current = day;
  }, [day]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const ui = useUi.getState();
      if (ui.dialog) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"], [role="grid"], [role="menu"], [role="dialog"], [role="listbox"]')) return;
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        ui.openCalendarDay(addDays(dayRef.current, k === 'ArrowLeft' ? -step : step));
      } else if ((k === 't' || k === 'T' || k === 'е' || k === 'Е') && !e.shiftKey) {
        e.preventDefault();
        ui.openCalendarDay(dayKey(Date.now()));
      } else if ((k === 'n' || k === 'N' || k === 'т' || k === 'Т') && creatable) {
        e.preventDefault();
        newEvent(workspaceId, defaultDraft(dayRef.current));
      } else if ((k === 'Delete' || k === 'Backspace') && ui.calEvent) {
        e.preventDefault();
        void cancelWithConfirm(ui.calEvent);
      }
    };
    // Esc closes the meeting's card (column or floating panel) and gives the focus back to its block.
    // Capture phase: an open dialog, confirmation or menu is still in the DOM and closes itself first.
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const ui = useUi.getState();
      const key = ui.calEvent;
      if (!key || ui.dialog || useDayDrag.getState().mode) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      ui.selectCalEvent(null);
      const occ = CSS.escape(key);
      const block = document.querySelector<HTMLElement>(`[data-testid="day-view"] [data-occ="${occ}"], [data-testid="week-view"] [data-occ="${occ}"]`);
      if (!el || el === document.body || el.closest('[data-testid="event-panel"]')) block?.focus();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onEsc, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onEsc, true);
    };
  }, [workspaceId, creatable, step]);
}
