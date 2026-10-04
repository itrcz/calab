import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { TaskAssigneeSchema, TaskRelationKind, TaskRelationSchema, TaskSchema, type Task } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import {
  GROUP_ROW,
  LABEL_GAP,
  layoutLabels,
  barBox,
  datePatch,
  dayAt,
  dayCenter,
  dayNum,
  dayPill,
  daysOf,
  dayWindow,
  dragSpan,
  isWeekend,
  isoDay,
  lateBlockers,
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
} from './timeline';

const task = (id: string, init: MessageInitShape<typeof TaskSchema> = {}): Task => create(TaskSchema, { id, key: id.toUpperCase(), ...init });

describe('timeline dates', () => {
  it('converts days both ways and knows weekends', () => {
    const d = dayNum('2026-01-15');
    expect(isoDay(d)).toBe('2026-01-15');
    expect(dayNum('2026-01-16') - d).toBe(1);
    expect(Number.isNaN(dayNum(''))).toBe(true);
    expect(isWeekend(dayNum('2026-01-17'))).toBe(true); // Saturday
    expect(isWeekend(dayNum('2026-01-19'))).toBe(false); // Monday
  });

  it('spans: start…due, one date = one day, none = off the scale', () => {
    expect(spanOf({ startOn: '2026-01-12', dueOn: '2026-01-14' })).toEqual({ start: dayNum('2026-01-12'), end: dayNum('2026-01-14') });
    expect(spanOf({ startOn: '', dueOn: '2026-01-14' })).toEqual({ start: dayNum('2026-01-14'), end: dayNum('2026-01-14') });
    expect(spanOf({ startOn: '', dueOn: '' })).toBeNull();
  });

  it('bar geometry: inclusive end', () => {
    const o = dayNum('2026-01-10');
    expect(barBox({ start: o + 2, end: o + 4 }, o, 18)).toEqual({ left: 36, width: 54 });
  });
});

describe('timeline drag', () => {
  const s = { start: 100, end: 103 };
  it('snaps travel to whole days', () => {
    expect(daysOf(8, 18)).toBe(0);
    expect(daysOf(10, 18)).toBe(1);
    expect(daysOf(-44, 44)).toBe(-1);
    expect(Object.is(daysOf(-2, 18), -0)).toBe(false);
  });
  it('moves and resizes, never past the other edge', () => {
    expect(dragSpan(s, 'move', 2)).toEqual({ start: 102, end: 105 });
    expect(dragSpan(s, 'start', -3)).toEqual({ start: 97, end: 103 });
    expect(dragSpan(s, 'start', 9)).toEqual({ start: 103, end: 103 });
    expect(dragSpan(s, 'end', -9)).toEqual({ start: 100, end: 100 });
  });
  it('patches only the changed dates, a one-date task stays one-date when moved', () => {
    const both = { startOn: '2026-01-12', dueOn: '2026-01-14' };
    const sp = spanOf(both) ?? { start: 0, end: 0 };
    expect(datePatch(both, dragSpan(sp, 'move', 1))).toEqual({ startOn: '2026-01-13', dueOn: '2026-01-15' });
    expect(datePatch(both, dragSpan(sp, 'end', 2))).toEqual({ dueOn: '2026-01-16' });
    expect(datePatch(both, dragSpan(sp, 'start', -1))).toEqual({ startOn: '2026-01-11' });
    const due = { startOn: '', dueOn: '2026-01-15' };
    const one = spanOf(due) ?? { start: 0, end: 0 };
    expect(datePatch(due, dragSpan(one, 'move', 3))).toEqual({ dueOn: '2026-01-18' });
    expect(datePatch(due, dragSpan(one, 'start', -2))).toEqual({ startOn: '2026-01-13' });
    expect(placePatch(dayNum('2026-01-20'))).toEqual({ startOn: '2026-01-20', dueOn: '2026-01-20' });
  });
});

describe('timeline blockers', () => {
  it('marks a task whose blocker ends on or after its start', () => {
    const blocks = (a: string, b: string) => create(TaskRelationSchema, { taskId: a, relatedId: b, kind: TaskRelationKind.BLOCKS });
    const a = task('a', { startOn: '2026-01-12', dueOn: '2026-01-16' });
    const b = task('b', { startOn: '2026-01-15', dueOn: '2026-01-20', relations: [blocks('a', 'b')] });
    const c = task('c', { startOn: '2026-01-17', dueOn: '2026-01-20', relations: [blocks('a', 'c')] });
    const all = { a, b, c };
    expect(lateBlockers(b, all)).toEqual(['A']);
    expect(lateBlockers(c, all)).toEqual([]);
    // The blocker's own side of the relation is not a marker on the blocker.
    expect(lateBlockers({ ...a, relations: [blocks('a', 'b')] }, all)).toEqual([]);
    // Relates / an undated blocker: no marker.
    expect(lateBlockers(task('d', { dueOn: '2026-01-15', relations: [create(TaskRelationSchema, { taskId: 'a', relatedId: 'd', kind: TaskRelationKind.RELATES })] }), all)).toEqual([]);
  });
});

describe('timeline layout', () => {
  it('range keeps today in with margins', () => {
    const today = dayNum('2026-01-15');
    expect(scaleRange([dayNum('2026-02-01'), NaN], today)).toEqual({ start: today - 14, end: dayNum('2026-02-01') + 45 });
  });
  it('windows: rows and days in view with overscan', () => {
    expect(rowWindow(0, 320, 32, 100)).toEqual({ first: 0, last: 16 });
    expect(rowWindow(3200, 320, 32, 100)).toEqual({ first: 94, last: 100 });
    expect(dayWindow(180, 360, 18, { start: 0, end: 500 })).toEqual({ start: 8, end: 32 });
  });
  it('rows: by start, grouped by lead / milestone, undated apart', () => {
    const lead = (u: string) => [create(TaskAssigneeSchema, { userId: u, isLead: true })];
    const list = [
      task('x', { number: 3, dueOn: '2026-01-20', assignees: lead('u1') }),
      task('y', { number: 1, startOn: '2026-01-10', dueOn: '2026-01-12' }),
      task('z', { number: 2 }),
      task('w', { number: 4, startOn: '2026-01-11', assignees: lead('u1'), milestoneId: 'm' }),
    ];
    expect(timelineRows(list, 'none')).toEqual({ rows: ['y', 'w', 'x'], undated: ['z'] });
    expect(timelineRows(list, 'assignee').rows).toEqual([`${GROUP_ROW}u1`, 'w', 'x', GROUP_ROW, 'y']);
    expect(timelineRows(list, 'milestone').rows).toEqual([`${GROUP_ROW}m`, 'w', GROUP_ROW, 'y', 'x']);
  });
});

describe('timeline scale (ADR-0063 «меньше цифр»)', () => {
  const d = dayNum;
  it('numbers at Mondays, months as segments from the 1st (the first one from the window start)', () => {
    // 2026-08-31 is a Monday.
    const m = scaleMarks(d('2026-08-30'), d('2026-10-11'), 'month');
    expect(m.weeks.map(isoDay)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05']);
    expect(m.months.map(isoDay)).toEqual(['2026-08-30', '2026-09-01', '2026-10-01']);
    expect(scaleMarks(d('2026-08-30'), d('2026-10-11'), 'week')).toEqual(m);
    const q = scaleMarks(d('2026-09-01'), d('2026-12-31'), 'quarter');
    expect(q.weeks).toEqual([]);
    expect(q.months.map(isoDay)).toEqual(['2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01']);
    expect(isoDay(nextMonth(d('2026-12-15')))).toBe('2027-01-01');
  });
  it('labels: short upper-case months of the locale, the year when not this year', () => {
    const today = d('2026-10-04');
    expect(monthLabel(d('2026-10-05'), today, 'ru')).toBe('ОКТ');
    expect(monthLabel(d('2026-09-07'), today, 'ru')).toBe('СЕНТ');
    expect(monthLabel(d('2026-10-05'), today, 'en')).toBe('OCT');
    expect(monthLabel(d('2027-01-04'), today, 'en')).toBe('JAN 2027');
    expect(dayPill(today, 'ru')).toBe('4 ОКТ');
    expect(dayPill(today, 'en')).toBe('OCT 4');
    expect(dayPill(d('2026-09-25'), 'en')).toBe('SEP 25');
  });
  it('today / hover geometry: the day centre and the day under x', () => {
    const origin = d('2026-09-01');
    expect(dayCenter(origin + 3, origin, 18, 248)).toBe(248 + 54 + 9);
    expect(dayAt(247, origin, 18, 248)).toBeNull();
    expect(dayAt(248, origin, 18, 248)).toBe(origin);
    expect(dayAt(248 + 18 * 3 + 17, origin, 18, 248)).toBe(origin + 3);
    expect(dayAt(dayCenter(origin + 10, origin, 44, 248), origin, 44, 248)).toBe(origin + 10);
  });
  it('off-screen: the side against the viewport days and the hint text', () => {
    const origin = d('2026-01-01');
    const view = viewDays(18 * 240, 248 + 18 * 30, 18, 248, origin);
    expect(view).toEqual({ start: origin + 240, end: origin + 269 });
    expect(offscreenSide({ start: origin + 10, end: origin + 239 }, view)).toBe('left');
    expect(offscreenSide({ start: origin + 10, end: origin + 240 }, view)).toBeNull();
    expect(offscreenSide({ start: origin + 270, end: origin + 300 }, view)).toBe('right');
    const today = d('2026-10-04');
    expect(offscreenText({ start: d('2026-05-28'), end: d('2026-08-27') }, today, 'en')).toBe('May 28 – Aug 27');
    expect(offscreenText({ start: d('2026-05-28'), end: d('2026-08-27') }, today, 'ru')).toBe('28 мая – 27 авг');
    expect(offscreenText({ start: d('2025-01-10'), end: d('2025-01-20') }, today, 'en')).toBe('Jan 2025');
    expect(offscreenText({ start: d('2025-04-01'), end: d('2025-05-30') }, today, 'ru')).toBe('апр 2025 – май 2025');
    expect(offscreenText({ start: d('2026-03-03'), end: d('2026-03-03') }, today, 'en')).toBe('Mar 3');
  });
  it('a hint click scrolls the start a few days from the edge', () => {
    const origin = d('2026-01-01');
    expect(revealScroll({ start: origin + 100, end: origin + 120 }, origin, 18, 'month')).toBe(96 * 18);
    expect(revealScroll({ start: origin + 1, end: origin + 2 }, origin, 44, 'week')).toBe(0);
  });
});

describe('layoutLabels', () => {
  it('centres a lone label under its diamond', () => {
    expect(layoutLabels([200], [60], 100)).toEqual([170]);
  });
  it('clamps the leftmost label to the visible edge, hides it when the diamond is under the column', () => {
    expect(layoutLabels([130], [80], 100)).toEqual([106]);
    expect(layoutLabels([90], [80], 100)).toEqual([null]);
  });
  it('shifts right to clear the previous label, hides when crowded', () => {
    expect(layoutLabels([200, 240], [60, 60], 0)).toEqual([170, 236]);
    expect(layoutLabels([200, 215, 224], [60, 60, 60], 0)).toEqual([170, null, null]);
  });
  it('never overlaps and keeps the gap, on random input', () => {
    let seed = 7;
    const rnd = (): number => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let n = 0; n < 300; n++) {
      const k = 1 + Math.floor(rnd() * 8);
      const xs = Array.from({ length: k }, () => rnd() * 600);
      const ws = Array.from({ length: k }, () => 20 + rnd() * 90);
      const minX = rnd() * 100;
      const out = layoutLabels(xs, ws, minX);
      const shown: { x: number; l: number; w: number }[] = [];
      out.forEach((l, i) => {
        if (l !== null) shown.push({ x: xs[i] ?? 0, l, w: ws[i] ?? 0 });
      });
      shown.sort((a, b) => a.l - b.l);
      shown.forEach((s, i) => {
        expect(s.l).toBeGreaterThanOrEqual(minX + LABEL_GAP - 1e-9);
        expect(s.l).toBeLessThanOrEqual(s.x + 1e-9);
        const p = shown[i - 1];
        if (p) expect(s.l - (p.l + p.w)).toBeGreaterThanOrEqual(LABEL_GAP - 1e-9);
      });
    }
  });
});
