import * as Dropdown from '../../components/radix/dropdown-menu';
import * as Popover from '../../components/radix/popover';
import { CalendarDays, CalendarSearch, Ellipsis, ChevronLeft, ChevronRight, Users } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { CreateButton } from '../../components/CreateButton';
import { Button, IconButton, Modal, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { isExternalKey } from '../../lib/calendar/external';
import { HOUR, addDays, dayEnd, dayStart, monthOf } from '../../lib/calendar/time';
import { dateTimeFormat } from '../../lib/format';
import { haptics } from '../../lib/haptics';
import { useMobile } from '../../lib/mobile';
import { daySwipeStep, lockAxis, type AxisGesture } from '../../lib/swipeGestures';
import { calendarAvailable } from '../../services/calendar';
import { selectPeople, useFreeBusy } from '../../stores/freebusy';
import { useUi } from '../../stores/ui';
import { menuBox, menuItem } from '../shell/menu';
import { Bar } from '../../components/Bar';
import { CreateSlot, NavButton, PhoneSearchButton } from '../../components/PhoneHeader';
import { defaultDraft, newEvent, startFind } from './actions';
import { AllDayChip, BusyBlock, BusyChip, DragGhost, DropCursor, EventBlock, type BlockDown } from './blocks';
import { CalendarHeader, ConnectControl, FilterRow } from './CalendarHeader';
import { CalendarExportDialog, CalendarExportItems, type CalendarExportMode } from './CalendarExport';
import { isBusyKey, useCalendarDays } from './calendarData';
import { gridScrollTarget } from '../../lib/calendar/scrollTarget';
import { useSession } from '../../stores/session';
import { settleScroll, useCloseCardOutside, useDayKeys, useDragController } from './dayControls';
import { ExternalBlock, ExternalChip } from './ExternalEventCard';
import { useDayDrag } from './dragState';
import { useToday } from './MiniCalendar';
import { FindTimePane } from './FindTime';
import { GUTTER, HOUR_PX, HourLines, HourScale, NowLine } from './gridParts';
import { MonthPicker } from './MonthPicker';
import { PeopleBar } from './PeopleBar';
import { WeekGrid } from './WeekView';
import { ZoneHeads, ZoneScales, useZonesSig } from './ZoneAxis';

export { HOUR_PX };
/** A day swipe never starts this close to the screen's left edge (the shell's / Safari's «back»). */
const SWIPE_EDGE_PX = 28;

/**
 * Day view (ADR-0038 §7, Apple Calendar): the day in the centre pane instead of the room — hour
 * grid 00–24, the red «now» line (a leaf, one render a minute), meeting blocks side by side when
 * they overlap, all-day meetings on top, «+ Встреча», ‹ › and «Сегодня». Drag (owner, 29.09):
 * a block moves (15-minute steps), its bottom edge resizes it, onto the all-day row it becomes
 * all-day, onto a day of the mini calendar it moves there (←/→ or holding at the grid's edge
 * switches the day while dragging); a press-and-drag on the empty grid selects a range for a new
 * meeting, a click proposes 30 minutes. Keys: N new, ←/→ day, T today, Delete cancels.
 * The drag lives in a leaf store (dragState.ts); the calendar store is written once, on drop.
 * «Люди» (ADR-0041 §3): the chips over the grid switch it to those people's meetings (only theirs —
 * owner, 05.10; me among them brings mine back), each block dotted in the colours of the selected
 * people it involves; their busy time I may not see — grey «Занято» blocks (the server decides
 * what I see: ADR-0041 §1, ADR-0045 §4). My external calendar shows without a selection or with me
 * selected.
 * «Подобрать время» replaces the grid with the availability columns (FindTime.tsx); «Неделя» (the
 * desktop's view switch) with the week (WeekView.tsx) — the phone always shows the day.
 */
export function DayView({ workspaceId }: { workspaceId: string }): ReactNode {
  const finding = useFreeBusy((s) => s.find?.workspaceId === workspaceId);
  const week = useUi((s) => s.calView === 'week');
  const mobile = useMobile();
  if (finding) return <FindTimePane workspaceId={workspaceId} />;
  return week && !mobile ? <WeekGrid workspaceId={workspaceId} /> : <DayGrid workspaceId={workspaceId} />;
}

function DayGrid({ workspaceId }: { workspaceId: string }): ReactNode {
  useLocale();
  const today = useToday();
  const day = useUi((s) => s.calDay) ?? today;
  const selected = useUi((s) => s.calEvent);
  const mobile = useMobile();
  const workStart = useSession((s) => s.me?.settings?.workHours?.startMin);
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const creatable = calendarAvailable(workspaceId);
  const zones = useZonesSig();

  const days = useMemo(() => [day], [day]);
  const { data, people } = useCalendarDays(workspaceId, days);
  const d = data[0];
  const placed = useMemo(() => d?.placed ?? [], [d]);

  // Open at the selected meeting, else at the working day's start (CBF-57; «now» does not move it).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const sel = selected ? placed.find((p) => p.key === selected) : undefined;
    return settleScroll(el, gridScrollTarget(workStart, sel?.top));
    // Only when the day changes (not on every list refresh).
  }, [day]); // eslint-disable-line react-hooks/exhaustive-deps

  // A newly selected meeting (created, opened by a link) comes into view.
  useEffect(() => {
    if (!selected) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-occ="${CSS.escape(selected)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  useCloseCardOutside(dayStart(day), dayEnd(day));

  const drag = useDragController({ workspaceId, day, grid, scroller, creatable, mobile });
  const swipe = useDaySwipe(mobile, day);

  useDayKeys(workspaceId, day, creatable);

  return (
    <section className="mat-content relative flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('cal.dayView')} data-testid="day-view">
      {mobile ? (
        <PhoneDayHeader workspaceId={workspaceId} day={day} today={today} creatable={creatable} people={people.length} />
      ) : (
        <CalendarHeader workspaceId={workspaceId} day={day} days={days} today={today} creatable={creatable} view="day" />
      )}
      {mobile ? null : <FilterRow workspaceId={workspaceId} people={people} />}
      <AllDayRow workspaceId={workspaceId} keys={d?.allDay ?? []} day={day} zones={zones} onDown={drag.onBlockDown} />
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden" data-testid="day-scroller" {...swipe}>
        <div className="relative flex" style={{ height: 24 * HOUR_PX + 16 }}>
          {zones ? <ZoneScales sig={zones} day={day} nowDay={day === today ? day : ''} /> : null}
          <HourScale primary={!!zones} />
          <div
            ref={grid}
            className="relative mr-2 mt-2 flex-1 touch-pan-y"
            style={{ height: 24 * HOUR_PX }}
            onPointerDown={drag.onGridDown}
            data-testid="day-grid"
          >
            <HourLines />
            {placed.map((p) =>
              isBusyKey(p.key) ? (
                <BusyBlock key={p.key} workspaceId={workspaceId} busyKey={p.key} top={p.top} height={p.height} col={p.col} cols={p.cols} />
              ) : isExternalKey(p.key) ? (
                <ExternalBlock key={p.key} workspaceId={workspaceId} day={day} extKey={p.key} top={p.top} height={p.height} col={p.col} cols={p.cols} />
              ) : (
                <EventBlock key={p.key} occKey={p.key} top={p.top} height={p.height} col={p.col} cols={p.cols} onDown={drag.onBlockDown} />
              ),
            )}
            {day === today ? <NowLine day={day} /> : null}
            <DragGhost />
          </div>
        </div>
      </div>
      {(d?.count ?? 0) === 0 && creatable ? (
        <p className="pointer-events-none absolute inset-x-0 top-1/2 px-6 text-center text-body text-muted" data-testid="day-empty">
          {t('cal.emptyHint')}
        </p>
      ) : null}
      <DropCursor />
    </section>
  );
}

/** Phone: the header's date is a button; a tap opens a centred month card to jump to a day. */
function DatePickCard({ day, today, title, onPick }: { day: string; today: string; title: string; onPick: (day: string) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(monthOf(day));
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        if (o) setMonth(monthOf(day));
        setOpen(o);
      }}
      modal={false}
    >
      <h1 className="flex">
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={`${title}. ${t('cal.pickDate')}`}
            aria-haspopup="dialog"
            className="relative h-9 min-w-[64px] truncate rounded-[var(--radius-icon)] px-2 text-center text-list font-semibold first-letter:uppercase before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']"
            data-testid="day-date"
          >
            <span aria-live="polite">{title}</span>
          </button>
        </Popover.Trigger>
      </h1>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="center"
          sideOffset={4}
          collisionPadding={8}
          aria-label={t('cal.pickDate')}
          data-testid="day-date-card"
          className="mat-popover anim-in z-[var(--z-modal-popover)] w-[300px] rounded-[var(--radius-card)] p-2 text-body"
        >
          <MonthPicker
            month={month}
            onMonth={setMonth}
            value={day}
            today={today}
            onPick={(d) => {
              haptics.select();
              setOpen(false);
              onPick(d);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Phone: a compact «‹ ср, 14 окт ›» group (the date opens a month card), «+» as a plain header icon,
 * the rest («Сегодня», «Люди», «Подобрать время») behind «…» — the header keeps room for the shell's
 * nav button. No week view on the phone.
 */
function PhoneDayHeader({ workspaceId, day, today, creatable, people }: { workspaceId: string; day: string; today: string; creatable: boolean; people: number }): ReactNode {
  const open = useUi((s) => s.openCalendarDay);
  const [sheet, setSheet] = useState(false);
  const [exportMode, setExportMode] = useState<CalendarExportMode | null>(null);
  const title = dateTimeFormat({ weekday: 'short', day: 'numeric', month: 'short' }).format(dayStart(day));
  return (
    <Bar>
      <NavButton />
      <IconButton label={t('cal.prevDay')} tip={false} onClick={() => open(addDays(day, -1))}>
        <ChevronLeft className="size-[18px]" />
      </IconButton>
      <DatePickCard day={day} today={today} title={title} onPick={open} />
      <IconButton label={t('cal.nextDay')} tip={false} onClick={() => open(addDays(day, 1))}>
        <ChevronRight className="size-[18px]" />
      </IconButton>
      <span className="flex-1" />
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <IconButton label={t('boards.more')} tip={false} className="relative data-[state=open]:bg-active" data-testid="day-more">
            <Ellipsis className="size-[18px]" />
            {people > 0 ? <span className="absolute right-1 top-1 size-2 rounded-full bg-accent-strong" aria-hidden /> : null}
          </IconButton>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={cx(menuBox, 'w-60')} sideOffset={4} align="end" collisionPadding={16}>
            {day !== today ? (
              <Dropdown.Item className={menuItem} onSelect={() => open(today)} data-testid="day-today">
                <CalendarDays className="size-4" aria-hidden /> {t('cal.today')}
              </Dropdown.Item>
            ) : null}
            {creatable ? (
              <>
                <Dropdown.Item className={menuItem} onSelect={() => setSheet(true)} data-testid="day-people">
                  <Users className="size-4" aria-hidden /> <span className="flex-1">{t('fb.filter')}</span>
                  {people > 0 ? <span className="text-caption tabular-nums text-muted">{people}</span> : null}
                </Dropdown.Item>
                <Dropdown.Item className={menuItem} onSelect={() => startFind(workspaceId)} data-testid="day-find">
                  <CalendarSearch className="size-4" aria-hidden /> {t('fb.find')}
                </Dropdown.Item>
                <CalendarExportItems onSelect={setExportMode} />
              </>
            ) : null}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      <PhoneSearchButton />
      {creatable ? <CreateButton label={t('cal.newEventLong')} tip={false} onClick={() => newEvent(workspaceId, defaultDraft(day))} data-testid="day-new-event" /> : <CreateSlot />}
      {sheet ? <PeopleSheet workspaceId={workspaceId} onClose={() => setSheet(false)} /> : null}
      {exportMode ? <CalendarExportDialog key={`${workspaceId}:${exportMode}`} workspaceId={workspaceId} mode={exportMode} onClose={() => setExportMode(null)} /> : null}
    </Bar>
  );
}

/** Phone: the filter as a centred dialog card with the chips. */
function PeopleSheet({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): ReactNode {
  const people = useFreeBusy(selectPeople(workspaceId));
  const dispatch = useFreeBusy((s) => s.dispatchPeople);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('fb.filter')}
      description={t('fb.filterHint')}
      footer={
        <Button onClick={onClose} data-testid="people-sheet-done">
          {t('fb.done')}
        </Button>
      }
    >
      <PeopleBar
        workspaceId={workspaceId}
        people={people}
        wrap
        onAdd={(ids) => dispatch({ type: 'add', workspaceId, ids })}
        onRemove={(id) => dispatch({ type: 'remove', workspaceId, id })}
        onClear={() => dispatch({ type: 'clear', workspaceId })}
        testId="people-filter"
      />
      <div className="mt-3 flex justify-end">
        <ConnectControl />
      </div>
    </Modal>
  );
}

/** All-day meetings above the grid; a drop target that makes a dragged meeting all-day. */
function AllDayRow({ workspaceId, keys, day, zones, onDown }: { workspaceId: string; keys: readonly string[]; day: string; zones: string; onDown: BlockDown }): ReactNode {
  // Always there (Apple Calendar): a stable grid under a drag, and a visible drop target.
  const dropping = useDayDrag((s) => s.allDay && !s.locked && s.mode === 'move');
  return (
    <div
      data-cal-allday={day}
      className={cx('flex shrink-0 items-start gap-0 border-b border-line py-1 pr-2', dropping && 'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]')}
      data-testid="allday-row"
    >
      {zones ? <ZoneHeads sig={zones} at={dayStart(day) + 12 * HOUR} /> : null}
      <span className={cx(GUTTER, 'shrink-0 self-center pr-2 text-right text-micro leading-3 text-faint')}>{t('cal.allDayRow')}</span>
      <div className="flex min-h-6 min-w-0 flex-1 flex-col gap-0.5">
        {keys.map((k) =>
          isBusyKey(k) ? (
            <BusyChip key={k} workspaceId={workspaceId} busyKey={k} />
          ) : isExternalKey(k) ? (
            <ExternalChip key={k} workspaceId={workspaceId} day={day} extKey={k} />
          ) : (
            <AllDayChip key={k} occKey={k} onDown={onDown} />
          ),
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- day swipe

/**
 * Phone (docs/08 «Свайпы и долгое нажатие»): a horizontal swipe over the day (≥ 60 px) opens the
 * next (left) or previous (right) day, as ‹ ›; a vertical one scrolls the hours. No state, no
 * render: a gesture is a ref until its release.
 */
function useDaySwipe(enabled: boolean, day: string): { onTouchStart: (e: TouchEvent) => void; onTouchMove: (e: TouchEvent) => void; onTouchEnd: (e: TouchEvent) => void } | undefined {
  const gesture = useRef<AxisGesture | null>(null);
  if (!enabled) return undefined;
  return {
    onTouchStart: (e) => {
      const p = e.touches[0];
      gesture.current = p && e.touches.length === 1 && p.clientX > SWIPE_EDGE_PX ? { x: p.clientX, y: p.clientY, axis: null } : null;
    },
    onTouchMove: (e) => {
      const g = gesture.current;
      const p = e.touches[0];
      if (!g || !p) return;
      if (lockAxis(g, p.clientX, p.clientY) === 'y') gesture.current = null;
      else if (g.axis === 'x') e.stopPropagation();
    },
    onTouchEnd: (e) => {
      const g = gesture.current;
      const p = e.changedTouches[0];
      gesture.current = null;
      if (!g || !p) return;
      const step = daySwipeStep(g, p.clientX, p.clientY);
      if (!step) return;
      e.stopPropagation();
      haptics.select();
      useUi.getState().openCalendarDay(addDays(day, step));
    },
  };
}
