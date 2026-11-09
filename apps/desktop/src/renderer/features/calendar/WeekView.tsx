import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { isExternalKey } from '../../lib/calendar/external';
import { layoutAllDay, type Placed } from '../../lib/calendar/layout';
import { HOUR, dayEnd, dayStart, formatLongDay, isoWeek, shortWeekday, utcOffsetLabel, viewerZone, weekDays, useWeekStart } from '../../lib/calendar/time';
import { dateTimeFormat } from '../../lib/format';
import { calendarAvailable } from '../../services/calendar';
import { useUi } from '../../stores/ui';
import { AllDayChip, BusyBlock, BusyChip, DragGhost, DropCursor, EventBlock, type BlockDown } from './blocks';
import { CalendarHeader, FilterRow } from './CalendarHeader';
import { isBusyKey, useCalendarDays, type DayData } from './calendarData';
import { gridScrollTarget } from '../../lib/calendar/scrollTarget';
import { useSession } from '../../stores/session';
import { settleScroll, useCloseCardOutside, useDayKeys, useDragController } from './dayControls';
import { useDayDrag } from './dragState';
import { ExternalBlock, ExternalChip } from './ExternalEventCard';
import { GUTTER, HOUR_PX, HourLines, HourScale, NowLine, WEEK_MIN_BLOCK_PX } from './gridParts';
import { useToday } from './MiniCalendar';
import { ZoneHeads, ZoneScales, useZonesSig } from './ZoneAxis';

/*
 * Week view (bug board #6, «как в Яндексе»; desktop only — the phone keeps the day): seven days
 * from the locale's first weekday, the time column with the viewer's UTC offset, the ISO week
 * number over the «весь день» band, today's date in an accent circle and its column shaded, the
 * red «now» line in today's column. Every day is laid out by the day view's own function
 * (lib/calendar/layout.ts), the all-day / multi-day items span their days in lanes. The blocks,
 * the drag and the keys are the day view's (blocks.tsx, dayControls.ts): a block moves to another
 * day's column, ←/→ and holding at the grid's edge flip the week. `calDay` stays the anchor.
 */

const SEP_FIELD = '\u0001';
const SEP_ITEM = '\u0002';
/** «весь день» band: lane height and the visible lanes before it scrolls. */
const LANE_PX = 22;
const MAX_LANES = 3;

/** A column's layout as a primitive: the memo column re-renders only when its own layout changes. */
const layoutSig = (placed: readonly Placed[]): string => placed.map((p) => [p.key, p.top, p.height, p.col, p.cols].join(SEP_FIELD)).join(SEP_ITEM);

function parseLayout(sig: string): Placed[] {
  if (!sig) return [];
  return sig.split(SEP_ITEM).map((s) => {
    const [key = '', top, height, col, cols] = s.split(SEP_FIELD);
    return { key, top: Number(top), height: Number(height), col: Number(col), cols: Number(cols) };
  });
}

/** The «весь день» bars of the week as a primitive: `key col span lane`. */
function barsSig(data: readonly DayData[]): string {
  const days = new Map<string, number[]>();
  data.forEach((d, i) => {
    for (const k of d.allDay) {
      const list = days.get(k);
      if (list) list.push(i);
      else days.set(k, [i]);
    }
  });
  return layoutAllDay([...days].map(([key, idx]) => ({ key, days: idx })))
    .map((b) => [b.key, b.col, b.span, b.lane].join(SEP_FIELD))
    .join(SEP_ITEM);
}

export function WeekGrid({ workspaceId }: { workspaceId: string }): ReactNode {
  useLocale(); // day labels follow the language
  const today = useToday();
  const day = useUi((s) => s.calDay) ?? today;
  const selected = useUi((s) => s.calEvent);
  const workStart = useSession((s) => s.me?.settings?.workHours?.startMin);
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const creatable = calendarAvailable(workspaceId);
  const zones = useZonesSig();

  const first = useWeekStart();
  const startKey = weekDays(day, first)[0] ?? day;
  const days = useMemo(() => weekDays(startKey, first), [startKey, first]);
  const { data, people } = useCalendarDays(workspaceId, days);
  const from = dayStart(startKey);
  const to = dayEnd(days[6] ?? startKey);

  // Open at the selected meeting, else at the working day's start (CBF-57; «now» does not move it).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const placed = data.flatMap((d) => d.placed);
    const sel = selected ? placed.find((p) => p.key === selected) : undefined;
    return settleScroll(el, gridScrollTarget(workStart, sel?.top));
    // Only when the week changes (not on every list refresh).
  }, [startKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A newly selected meeting (created, opened by a link) comes into view.
  useEffect(() => {
    if (!selected) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-occ="${CSS.escape(selected)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  useCloseCardOutside(from, to);

  // The day of the column under a pointer x (the drag's target day).
  const dayAt = useCallback(
    (x: number): string => {
      const r = grid.current?.getBoundingClientRect();
      if (!r || r.width <= 0) return days[0] ?? startKey;
      const col = Math.max(0, Math.min(6, Math.floor(((x - r.left) / r.width) * 7)));
      return days[col] ?? startKey;
    },
    [days, startKey],
  );
  const drag = useDragController({ workspaceId, day, grid, scroller, creatable, mobile: false, dayAt, step: 7 });
  useDayKeys(workspaceId, day, creatable, 7);

  const bars = useMemo(() => barsSig(data), [data]);
  const isoDay = days[first === 0 ? 1 : 0] ?? startKey;
  // The extra zones' rows and offsets: today's in this week, else mid-week's.
  const nowDay = days.includes(today) ? today : '';
  const zoneDay = nowDay || (days[3] ?? startKey);

  return (
    <section className="mat-content relative flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('cal.weekView')} data-testid="week-view">
      <CalendarHeader workspaceId={workspaceId} day={day} days={days} today={today} creatable={creatable} view="week" />
      <FilterRow workspaceId={workspaceId} people={people} />
      <WeekHead days={days} today={today} zone={utcOffsetLabel(dayStart(days[3] ?? startKey))} zones={zones} zoneAt={dayStart(zoneDay) + 12 * HOUR} />
      <WeekAllDay workspaceId={workspaceId} days={days} today={today} bars={bars} week={isoWeek(isoDay)} zones={zones} onDown={drag.onBlockDown} />
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden" data-testid="week-scroller">
        <div className="relative flex" style={{ height: 24 * HOUR_PX + 16 }}>
          {zones ? <ZoneScales sig={zones} day={zoneDay} week nowDay={nowDay} /> : null}
          <HourScale primary={!!zones} />
          <div ref={grid} className="relative mr-2 mt-2 flex-1" style={{ height: 24 * HOUR_PX }} onPointerDown={drag.onGridDown} data-testid="week-grid">
            <HourLines />
            <div className="absolute inset-0 grid grid-cols-7" data-grid-bg>
              {data.map((d) => (
                <WeekColumn key={d.day} workspaceId={workspaceId} day={d.day} layout={layoutSig(d.placed)} isToday={d.day === today} onDown={drag.onBlockDown} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <DropCursor />
    </section>
  );
}

/** Today's column (and its header / all-day cell): a subtle tint (Yandex). */
const TODAY_TINT = 'bg-[color-mix(in_srgb,var(--color-fill)_45%,transparent)]';

/** «UTC+3 | пн 19 | вт 20 …»: a click on a day opens it in the day view. */
const WeekHead = memo(function WeekHead({ days, today, zone, zones, zoneAt }: { days: readonly string[]; today: string; zone: string; zones: string; zoneAt: number }): ReactNode {
  useLocale();
  const weekday = dateTimeFormat({ weekday: 'short' });
  const openDay = (d: string): void => {
    useUi.getState().setCalView('day');
    useUi.getState().openCalendarDay(d);
  };
  return (
    <div className="flex h-10 shrink-0 border-b border-line pr-2" data-testid="week-head">
      {zones ? <ZoneHeads sig={zones} at={zoneAt} /> : null}
      <Tip label={t('cal.zone', { zone: viewerZone() })}>
        <span className={cx(GUTTER, 'shrink-0 self-center pr-2 text-right text-micro tabular-nums text-faint')} tabIndex={-1} data-testid="week-zone">
          {zone}
        </span>
      </Tip>
      <div className="grid min-w-0 flex-1 grid-cols-7">
        {days.map((d) => {
          const at = dayStart(d);
          const dow = new Date(at).getDay();
          const isToday = d === today;
          return (
            <Tip key={d} label={t('cal.openDay')}>
              <button
                type="button"
                onClick={() => openDay(d)}
                aria-label={formatLongDay(at)}
                aria-current={isToday ? 'date' : undefined}
                className={cx(
                  'flex min-w-0 items-center justify-center gap-1.5 border-l border-line text-body outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                  isToday && TODAY_TINT,
                  dow === 0 || dow === 6 ? 'text-muted' : 'text-fg',
                )}
                data-testid="week-day"
              >
                <span className="truncate">{shortWeekday(weekday.format(at))}</span>
                <span
                  className={cx(
                    'grid h-6 min-w-6 shrink-0 place-items-center rounded-full px-1 font-semibold tabular-nums',
                    isToday && 'bg-accent-strong text-accent-fg',
                  )}
                  data-testid={isToday ? 'week-today' : undefined}
                >
                  {new Date(at).getDate()}
                </span>
              </button>
            </Tip>
          );
        })}
      </div>
    </div>
  );
});

/** The «весь день» band: the ISO week number in the gutter, a drop cell per day, bars across their days. */
const WeekAllDay = memo(function WeekAllDay({
  workspaceId,
  days,
  today,
  bars,
  week,
  zones,
  onDown,
}: {
  workspaceId: string;
  days: readonly string[];
  today: string;
  bars: string;
  week: number;
  zones: string;
  onDown: BlockDown;
}): ReactNode {
  useLocale();
  const list = bars
    ? bars.split(SEP_ITEM).map((s) => {
        const [key = '', col, span, lane] = s.split(SEP_FIELD);
        return { key, col: Number(col), span: Number(span), lane: Number(lane) };
      })
    : [];
  const lanes = list.reduce((n, b) => Math.max(n, b.lane + 1), 0);
  const inner = Math.max(1, lanes) * LANE_PX + 8;
  return (
    <div className="flex shrink-0 border-b border-line pr-2" data-testid="allday-row">
      {zones ? <ZoneHeads sig={zones} at={0} bare /> : null}
      <Tip label={t('cal.weekNumLong', { n: week })}>
        <span className={cx(GUTTER, 'shrink-0 self-start pr-2 pt-1.5 text-right text-micro tabular-nums leading-4 text-faint')} tabIndex={-1} data-testid="week-number">
          {t('cal.weekNum', { n: week })}
        </span>
      </Tip>
      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden" style={{ maxHeight: MAX_LANES * LANE_PX + 8 }}>
        <div className="relative grid grid-cols-7" style={{ height: inner }}>
          {days.map((d) => (
            <AllDayCell key={d} day={d} isToday={d === today} />
          ))}
          {list.map((b) => {
            const d = days[b.col] ?? '';
            return (
              <div
                key={b.key}
                className="absolute flex flex-col px-0.5"
                style={{ left: `${(b.col / 7) * 100}%`, width: `${(b.span / 7) * 100}%`, top: 4 + b.lane * LANE_PX, height: LANE_PX - 2 }}
              >
                {isBusyKey(b.key) ? (
                  <BusyChip workspaceId={workspaceId} busyKey={b.key} />
                ) : isExternalKey(b.key) ? (
                  <ExternalChip workspaceId={workspaceId} day={d} extKey={b.key} />
                ) : (
                  <AllDayChip occKey={b.key} onDown={onDown} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

/** A day of the «весь день» band: a drop target that makes a dragged meeting all-day on that day. */
const AllDayCell = memo(function AllDayCell({ day, isToday }: { day: string; isToday: boolean }): ReactNode {
  const dropping = useDayDrag((s) => s.allDay && !s.locked && s.mode === 'move' && s.day === day);
  return <div data-cal-allday={day} className={cx('h-full border-l border-line', isToday && TODAY_TINT, dropping && 'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]')} />;
});

/** One day of the grid: its blocks laid out by the day view's function, the «now» line today, the drag ghost when it is the target. */
const WeekColumn = memo(function WeekColumn({
  workspaceId,
  day,
  layout,
  isToday,
  onDown,
}: {
  workspaceId: string;
  day: string;
  layout: string;
  isToday: boolean;
  onDown: BlockDown;
}): ReactNode {
  const placed = useMemo(() => parseLayout(layout), [layout]);
  return (
    <div className={cx('relative h-full min-w-0 border-l border-line', isToday && TODAY_TINT)} data-grid-bg data-week-day={day} data-testid="week-column">
      {placed.map((p) =>
        isBusyKey(p.key) ? (
          <BusyBlock key={p.key} workspaceId={workspaceId} busyKey={p.key} top={p.top} height={p.height} col={p.col} cols={p.cols} minPx={WEEK_MIN_BLOCK_PX} />
        ) : isExternalKey(p.key) ? (
          <ExternalBlock key={p.key} workspaceId={workspaceId} day={day} extKey={p.key} top={p.top} height={p.height} col={p.col} cols={p.cols} minPx={WEEK_MIN_BLOCK_PX} />
        ) : (
          <EventBlock key={p.key} occKey={p.key} top={p.top} height={p.height} col={p.col} cols={p.cols} onDown={onDown} minPx={WEEK_MIN_BLOCK_PX} />
        ),
      )}
      {isToday ? <NowLine day={day} /> : null}
      <DragGhost day={day} />
    </div>
  );
});
