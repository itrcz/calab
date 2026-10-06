import * as ContextMenu from '@radix-ui/react-context-menu';
import { AttendeeStatus, EventRepeat } from '@calaba/protocol';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { CalendarDays, CalendarPlus, CalendarSearch, Ellipsis, ChevronLeft, ChevronRight, Link2, Pencil, Copy, Repeat, Trash2, Users, Video } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { CreateButton } from '../../components/CreateButton';
import { Button, IconButton, Modal, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { CLICK_DURATION, DRAG_THRESHOLD_PX, createRange, minutesAt, moveRange, resizeRange, type Range } from '../../lib/calendar/drag';
import { dayKeys, daySignature, involvedIndexes, keyEventId, myStatusOf, parseSignature, type SigItem } from '../../lib/calendar/events';
import { externalSignature, isExternalKey, parseExternalSignature, sharedLabel } from '../../lib/calendar/external';
import { chunkOf } from '../../lib/calendar/freebusy';
import { layoutDay } from '../../lib/calendar/layout';
import { addDays, atMinutes, dayEnd, dayKey, dayStart, eventSpan, formatLongDay, formatMinutes, formatRange, formatTime, monthOf } from '../../lib/calendar/time';
import { dateTimeFormat } from '../../lib/format';
import { addPeople, personColor } from '../../lib/calendar/people';
import { useMobile } from '../../lib/mobile';
import { calendarAvailable, canEditEvent, copyEventLink, ensureMonth, eventOf, moveOccurrence } from '../../services/calendar';
import { useCalendar } from '../../stores/calendar';
import { busySignature, ensureBusy, ensureExternal, loadCalDav, parseBusySignature } from '../../services/freebusy';
import { entryKey, selectPeople, useFreeBusy } from '../../stores/freebusy';
import { useRooms } from '../../stores/rooms';
import { myUserId } from '../../stores/session';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { useUi } from '../../stores/ui';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { NavButton, PhoneSearchButton } from '../../components/PhoneHeader';
import { cancelWithConfirm, duplicateEvent, editEvent, newEvent } from './actions';
import { ExternalBlock, ExternalChip } from './ExternalEventCard';
import { useDayDrag } from './dragState';
import { useToday } from './MiniCalendar';
import { FindTimePane } from './FindTime';
import { GUTTER, HOUR_PX, HourLines, HourScale, NowLine, PX_PER_MIN } from './gridParts';
import { PeopleBar } from './PeopleBar';

export { HOUR_PX };
/** Hold near the grid's left / right edge this long while dragging → previous / next day. */
const EDGE_DWELL_MS = 700;
const EDGE_PX = 24;

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
 * «Подобрать время» replaces the grid with the availability columns (FindTime.tsx).
 */
export function DayView({ workspaceId }: { workspaceId: string }): ReactNode {
  const finding = useFreeBusy((s) => s.find?.workspaceId === workspaceId);
  return finding ? <FindTimePane workspaceId={workspaceId} /> : <DayGrid workspaceId={workspaceId} />;
}

const NO_PEOPLE: readonly string[] = [];

function DayGrid({ workspaceId }: { workspaceId: string }): ReactNode {
  useLocale();
  const today = useToday();
  const day = useUi((s) => s.calDay) ?? today;
  const selected = useUi((s) => s.calEvent);
  const mobile = useMobile();
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const creatable = calendarAvailable(workspaceId);

  useEffect(() => ensureMonth(workspaceId, monthOf(day)), [workspaceId, day]);

  // The day's meetings as one primitive signature: re-render on a change of the set or of a time,
  // not on an answer / title (the blocks subscribe to those themselves).
  const people = useFreeBusy(selectPeople(workspaceId));
  const peopleSet = useMemo(() => (people.length ? new Set(people) : undefined), [people]);
  // Scope: without a selection only meetings I organize or attend (owner, 02.10); with one — only
  // the selected people's (owner, 05.10).
  const me = myUserId();
  const mine = me;
  const sig = useCalendar((s) => daySignature(s.occ, dayKeys(s.occ, workspaceId, day, peopleSet, mine)));
  const items = useMemo(() => parseSignature(sig), [sig]);
  // Busy time from free / busy: the selected people's (what I cannot see as a meeting), else my
  // external calendar's. A primitive per person: a busy change of someone else re-renders nothing.
  const own = people.length === 0;
  // My external calendar's events: in my own day, or when I am one of the selected people.
  const showMine = own || (!!me && people.includes(me));
  const watched = useMemo(() => (!own ? people : me ? [me] : NO_PEOPLE), [own, people, me]);
  useEffect(() => ensureBusy(workspaceId, watched, dayStart(day), dayEnd(day)), [workspaceId, watched, day]);
  const fbSig = useFreeBusy((s) => watched.map((u) => `${u}#${busySignature(s.entries[entryKey(workspaceId, u)], dayStart(day), dayEnd(day))}`).join('¦'));
  // My external calendar's events with their details (ADR-0045 §3) wherever my busy time shows:
  // cards instead of my grey external blocks once the day is loaded.
  const extOn = useFreeBusy((s) => showMine && !!s.caldav?.calendarHref && s.caldav.import);
  const extLoaded = useFreeBusy((s) => s.externalWs === workspaceId && !!s.externalChunks[chunkOf(dayStart(day))] && !!s.externalChunks[chunkOf(dayEnd(day) - 1)]);
  useEffect(() => {
    if (extOn && !extLoaded) ensureExternal(workspaceId, dayStart(day), dayEnd(day));
  }, [workspaceId, day, extOn, extLoaded]);
  const extSig = useFreeBusy((s) => (showMine && s.externalWs === workspaceId ? externalSignature(s.external[day]) : ''));
  const extHeld = useFreeBusy((s) => showMine && s.externalWs === workspaceId && s.external[day] !== undefined);
  const ext = useMemo<SigItem[]>(() => parseExternalSignature(extSig).map((e) => ({ key: e.key, allDay: e.allDay, start: e.start, end: e.end })), [extSig]);
  const busy = useMemo(() => busyItems(fbSig, items, own, extHeld ? me : ''), [fbSig, items, own, extHeld, me]);
  const timed = useMemo(() => [...items.filter((i) => !i.allDay), ...busy.filter((i) => !i.allDay), ...ext.filter((i) => !i.allDay)], [items, busy, ext]);
  const allDay = useMemo(() => [...items.filter((i) => i.allDay), ...ext.filter((i) => i.allDay), ...busy.filter((i) => i.allDay)].map((i) => i.key), [items, busy, ext]);
  const placed = useMemo(() => layoutDay(timed, dayStart(day), dayEnd(day)), [timed, day]);

  // Open at «now» (today) or the selected meeting, else at 08:00 / the first meeting.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const sel = selected ? placed.find((p) => p.key === selected) : undefined;
    const first = placed[0];
    const minute = sel ? sel.top : day === today ? (Date.now() - dayStart(day)) / 60_000 : first ? Math.min(first.top, 8 * 60) : 8 * 60;
    const apply = (): void => {
      el.scrollTop = Math.max(0, minute * PX_PER_MIN - el.clientHeight / 3);
    };
    apply();
    // Again while the pane settles (on a phone it is laid out as the drawer closes): on its resizes
    // during the first second, until the user scrolls it.
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
    // Only when the day changes (not on every list refresh).
  }, [day]); // eslint-disable-line react-hooks/exhaustive-deps

  // A newly selected meeting (created, opened by a link) comes into view.
  useEffect(() => {
    if (!selected) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-occ="${CSS.escape(selected)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  // Another day (‹ ›, ←/→, T, the mini month): a card of a meeting not on it closes (Apple). Not
  // while dragging (holding at the edge flips days with the dragged meeting still selected); an
  // occurrence not loaded yet (a deep link) stays.
  const shownDay = useRef(day);
  useEffect(() => {
    if (shownDay.current === day) return;
    shownDay.current = day;
    const ui = useUi.getState();
    const ev = ui.calEvent ? eventOf(ui.calEvent) : undefined;
    if (!ev || useDayDrag.getState().mode) return;
    const span = eventSpan(ev);
    if (span.end <= dayStart(day) || span.start >= dayEnd(day)) ui.selectCalEvent(null);
  }, [day]);

  const drag = useDragController({ workspaceId, day, grid, scroller, creatable, mobile });

  useDayKeys(workspaceId, day, creatable);

  return (
    <section className="mat-content relative flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('cal.dayView')} data-testid="day-view">
      <DayHeader workspaceId={workspaceId} day={day} today={today} creatable={creatable} mobile={mobile} people={people.length} />
      {mobile ? null : <FilterRow workspaceId={workspaceId} people={people} />}
      <AllDayRow workspaceId={workspaceId} keys={allDay} day={day} onDown={drag.onBlockDown} />
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden" data-testid="day-scroller">
        <div className="relative flex" style={{ height: 24 * HOUR_PX + 16 }}>
          <HourScale />
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
      {items.length === 0 && busy.length === 0 && ext.length === 0 && creatable ? (
        <p className="pointer-events-none absolute inset-x-0 top-1/2 px-6 text-center text-body text-muted" data-testid="day-empty">
          {t('cal.emptyHint')}
        </p>
      ) : null}
      <DropCursor />
    </section>
  );
}

/** While a locked meeting is dragged: the «not allowed» cursor over everything. */
function DropCursor(): ReactNode {
  const locked = useDayDrag((s) => s.locked);
  return locked ? <div className="fixed inset-0 z-[var(--z-popover)] cursor-not-allowed" aria-hidden /> : null;
}

function DayHeader({ workspaceId, day, today, creatable, mobile, people }: { workspaceId: string; day: string; today: string; creatable: boolean; mobile: boolean; people: number }): ReactNode {
  const open = useUi((s) => s.openCalendarDay);
  const [sheet, setSheet] = useState(false);
  if (mobile) {
    // Phone: a compact «‹ 15 янв. ›» group, «+» as a plain header icon, the rest («Сегодня», «Люди»,
    // «Подобрать время») behind «…» — the header keeps room for the shell's nav button.
    const title = dateTimeFormat({ day: 'numeric', month: 'short' }).format(dayStart(day));
    const touch = 'size-11 rounded-full';
    return (
      <header className="mat-toolbar flex h-12 shrink-0 items-center gap-0.5 border-b border-line pl-0.5 pr-2">
        <NavButton />
        <IconButton label={t('cal.prevDay')} tip={false} onClick={() => open(addDays(day, -1))} className={touch}>
          <ChevronLeft className="size-[18px]" />
        </IconButton>
        <h1 className="min-w-[64px] truncate text-center text-list font-semibold first-letter:uppercase" aria-live="polite">
          {title}
        </h1>
        <IconButton label={t('cal.nextDay')} tip={false} onClick={() => open(addDays(day, 1))} className={touch}>
          <ChevronRight className="size-[18px]" />
        </IconButton>
        <span className="flex-1" />
        <Dropdown.Root modal={false}>
          <Dropdown.Trigger asChild>
            <IconButton label={t('boards.more')} tip={false} className={cx(touch, 'relative data-[state=open]:bg-active')} data-testid="day-more">
              <Ellipsis className="size-[18px]" />
              {people > 0 ? <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent-strong" aria-hidden /> : null}
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
                </>
              ) : null}
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
        <PhoneSearchButton />
        {creatable ? <CreateButton label={t('cal.newEventLong')} tip={false} onClick={() => newEvent(workspaceId, defaultDraft(day))} data-testid="day-new-event" /> : null}
        {sheet ? <PeopleSheet workspaceId={workspaceId} onClose={() => setSheet(false)} /> : null}
      </header>
    );
  }
  return (
    <header className="mat-toolbar flex h-12 shrink-0 items-center gap-1 border-b border-line pl-3 pr-2">
      <IconButton label={t('cal.prevDay')} shortcut="←" onClick={() => open(addDays(day, -1))}>
        <ChevronLeft className="size-[18px]" />
      </IconButton>
      <IconButton label={t('cal.nextDay')} shortcut="→" onClick={() => open(addDays(day, 1))}>
        <ChevronRight className="size-[18px]" />
      </IconButton>
      <h1 className="ml-1 min-w-0 flex-1 truncate text-list font-semibold first-letter:uppercase" aria-live="polite">
        {formatLongDay(dayStart(day))}
      </h1>
      {day !== today ? (
        <Button variant="secondary" size="sm" onClick={() => open(today)} title="T">
          {t('cal.today')}
        </Button>
      ) : null}
      {creatable ? (
        <>
          <Button variant="secondary" size="sm" onClick={() => startFind(workspaceId)} data-testid="day-find">
            <CalendarSearch className="size-3.5" aria-hidden />
            {t('fb.find')}
          </Button>
          <Button size="sm" onClick={() => newEvent(workspaceId, defaultDraft(day))} data-testid="day-new-event" title="N">
            {t('cal.newEvent')}
          </Button>
        </>
      ) : null}
    </header>
  );
}

/** «Подобрать время» from the day view: the filter's people (and me) as the first chips. */
export function startFind(workspaceId: string): void {
  const me = myUserId();
  const fb = useFreeBusy.getState();
  const users = addPeople(me ? [me] : [], fb.people[workspaceId] ?? []).list;
  fb.setFind({ workspaceId, users, durationMin: 30, workHours: true });
}

/** «Люди» over the grid (desktop): the chips of the filter; the CalDAV hint at the right end. */
function FilterRow({ workspaceId, people }: { workspaceId: string; people: readonly string[] }): ReactNode {
  const dispatch = useFreeBusy((s) => s.dispatchPeople);
  const onAdd = useCallback((ids: readonly string[]) => dispatch({ type: 'add', workspaceId, ids }), [dispatch, workspaceId]);
  const onRemove = useCallback((id: string) => dispatch({ type: 'remove', workspaceId, id }), [dispatch, workspaceId]);
  const onClear = useCallback(() => dispatch({ type: 'clear', workspaceId }), [dispatch, workspaceId]);
  return (
    <div className="@container flex h-10 shrink-0 items-center gap-2 border-b border-line pl-3 pr-2" data-testid="day-filter">
      <Users className="size-4 shrink-0 text-muted" aria-hidden />
      <PeopleBar workspaceId={workspaceId} people={people} onAdd={onAdd} onRemove={onRemove} onClear={onClear} testId="people-filter" />
      <ConnectControl />
    </div>
  );
}

/**
 * The right end of the filter (owner, 30.09; docs/09 #140): without my CalDAV calendar — the
 * orange «Подключить свой календарь» (Settings → Calendar); nothing when connected (the «Только
 * мои» switch is gone, 02.10) or until the account is known (asked once, here).
 */
function ConnectControl(): ReactNode {
  const caldav = useFreeBusy((s) => (s.caldav === undefined ? 'unknown' : s.caldav ? 'yes' : 'no'));
  useEffect(() => {
    if (caldav === 'unknown') void loadCalDav();
  }, [caldav]);
  if (caldav !== 'no') return null;
  return (
    <Button
      variant="attention"
      size="sm"
      title={t('fb.connectHint')}
      aria-label={t('fb.connect')}
      onClick={() => useUi.getState().openDialog({ kind: 'settings', tab: 'calendar' })}
      data-testid="connect-calendar"
    >
      <CalendarPlus className="size-3.5" aria-hidden />
      {/* A narrow row (960 px window, chips selected): the short label keeps the chips room. */}
      <span className="@[720px]:hidden">{t('fb.connectShort')}</span>
      <span className="hidden @[720px]:inline">{t('fb.connect')}</span>
    </Button>
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

// ---------------------------------------------------------------- busy blocks (free / busy)

const BUSY = 'busy~';
const isBusyKey = (key: string): boolean => key.startsWith(BUSY);

/**
 * Busy blocks of a day: `ownOnly` — my external calendar's; else the watched people's busy time
 * that is not a meeting shown on the grid. The same interval of several people is one block (an
 * external one only with the same shared title and attendees, ADR-0045 §4). `extOf`: whose
 * external intervals are drawn as event cards instead (me, once my day's events are loaded).
 */
function busyItems(fbSig: string, shown: readonly SigItem[], ownOnly: boolean, extOf: string): SigItem[] {
  if (!fbSig) return [];
  const visible = new Set(shown.map((i) => keyEventId(i.key)));
  const groups = new Map<string, { start: number; end: number; kind: string; allDay: boolean; users: string[]; title: string; attendees: string }>();
  for (const part of fbSig.split('¦')) {
    const at = part.indexOf('#');
    const user = part.slice(0, at);
    for (const b of parseBusySignature(part.slice(at + 1))) {
      if (ownOnly ? b.kind !== 'external' : b.eventId && visible.has(b.eventId)) continue;
      if (b.kind === 'external' && user === extOf) continue;
      const title = b.kind === 'external' ? encodeURIComponent(b.title).replace(/~/g, '%7E') : '';
      const attendees = b.kind === 'external' ? b.attendees.join(',') : '';
      const g = `${b.start}~${b.end}~${b.kind}~${b.allDay ? 1 : 0}~${title}~${attendees}`;
      const cur = groups.get(g);
      if (cur) cur.users.push(user);
      else groups.set(g, { start: b.start, end: b.end, kind: b.kind, allDay: b.allDay, users: [user], title, attendees });
    }
  }
  return [...groups.values()].map((g) => ({ key: `${BUSY}${g.start}~${g.end}~${g.kind}~${g.users.join(',')}~${g.title}~${g.attendees}`, allDay: g.allDay, start: g.start, end: g.end }));
}

function parseBusyKey(key: string): { start: number; end: number; external: boolean; users: string[]; title: string; attendees: string[] } {
  const [, s, e, kind, users = '', title = '', attendees = ''] = key.split('~');
  let text: string;
  try {
    text = decodeURIComponent(title);
  } catch {
    text = '';
  }
  return { start: Number(s), end: Number(e), external: kind === 'external', users: users.split(',').filter(Boolean), title: text, attendees: attendees.split(',').filter(Boolean) };
}

/**
 * «Занято · Анна, Борис» / mine from the external calendar: «Занято · внешний календарь»; a
 * colleague's shared external event (ADR-0045 §4): «Название · Анна» / «Название · 3 участника · Анна».
 */
function useBusyLabel(workspaceId: string, busyKey: string): { text: string; external: boolean } {
  const b = parseBusyKey(busyKey);
  const names = useWorkspaces((s) => b.users.map((u) => s.byId[workspaceId]?.members[u]?.nickname || s.byId[workspaceId]?.members[u]?.user?.displayName || '').join(', '));
  const mineOnly = b.users.length === 1 && b.users[0] === myUserId();
  const who = mineOnly ? (b.external ? t('fb.external') : '') : names;
  const shared = b.external ? sharedLabel(b) : null;
  if (shared) {
    const label = shared.count ? plural('fb.sharedCount', shared.count, { title: shared.title }) : shared.title;
    return { text: who ? t('fb.sharedWho', { label, who }) : label, external: true };
  }
  return { text: who ? t('fb.busyWho', { who }) : t('fb.busy'), external: b.external };
}

/** Grey, hatched when it comes from an external calendar (docs/08 «Календарь»). */
const busyStyle = (external: boolean): React.CSSProperties =>
  external
    ? { backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in srgb, var(--color-label-tertiary) 35%, transparent) 6px 8px)' }
    : {};

const BusyBlock = memo(function BusyBlock({ workspaceId, busyKey, top, height, col, cols }: { workspaceId: string; busyKey: string; top: number; height: number; col: number; cols: number }): ReactNode {
  const { text, external } = useBusyLabel(workspaceId, busyKey);
  const { start, end } = parseBusyKey(busyKey);
  const px = height * PX_PER_MIN;
  return (
    <div
      role="img"
      aria-label={`${text}, ${formatTime(start)} – ${formatTime(end)}`}
      title={text}
      data-testid="busy-block"
      className="pointer-events-none absolute z-[1] overflow-hidden rounded-[6px] border-l-[3px] border-[var(--color-label-tertiary)] bg-[var(--color-fill)] px-1.5 text-caption text-muted"
      style={{
        top: top * PX_PER_MIN + 1,
        height: Math.max(18, px - 2),
        left: `calc(${(col / cols) * 100}% + 2px)`,
        width: `calc(${100 / cols}% - 4px)`,
        ...busyStyle(external),
      }}
    >
      <p className={cx('truncate font-medium', px < 38 ? 'leading-4' : 'pt-1')}>{text}</p>
    </div>
  );
});

const BusyChip = memo(function BusyChip({ workspaceId, busyKey }: { workspaceId: string; busyKey: string }): ReactNode {
  const { text, external } = useBusyLabel(workspaceId, busyKey);
  return (
    <div role="img" aria-label={text} data-testid="busy-block" className="truncate rounded-[6px] border-l-[3px] border-[var(--color-label-tertiary)] bg-[var(--color-fill)] px-1.5 text-caption font-medium leading-5 text-muted" style={busyStyle(external)}>
      {text}
    </div>
  );
});

/** «+ Встреча» on a day: the next full half hour today, 10:00 on another day; 30 minutes. */
function defaultDraft(day: string): { start: number; end: number } {
  const now = new Date();
  let start = atMinutes(day, 10 * 60).getTime();
  if (dayKey(now) === day) {
    const m = Math.min(23 * 60, Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 30) * 30);
    start = atMinutes(day, m).getTime();
  }
  return { start, end: start + CLICK_DURATION * 60_000 };
}

// ---------------------------------------------------------------- blocks

type BlockDown = (e: ReactPointerEvent<HTMLElement>, key: string, mode: 'move' | 'resize') => void;

/** How a block looks: my answer tints it (declined — faded, no answer yet — dashed), selected — filled. */
function blockTone(status: AttendeeStatus, selected: boolean): string {
  if (selected) return 'bg-accent-strong text-accent-fg border-accent-strong';
  if (status === AttendeeStatus.DECLINED) return 'bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-muted border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)]';
  if (status === AttendeeStatus.PENDING) return 'bg-[color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg))] text-fg border-accent border-dashed';
  return 'bg-[color-mix(in_srgb,var(--color-accent)_24%,var(--color-bg))] text-fg border-accent';
}

const EventBlock = memo(function EventBlock({
  occKey,
  top,
  height,
  col,
  cols,
  onDown,
}: {
  occKey: string;
  top: number;
  height: number;
  col: number;
  cols: number;
  onDown: BlockDown;
}): ReactNode {
  const ev = useCalendar((s) => s.occ[occKey]);
  const roomName = useRooms((s) => (ev?.roomId ? (s.byId[ev.roomId]?.name ?? '') : ''));
  const selected = useUi((s) => s.calEvent === occKey);
  const lifted = useDayDrag((s) => s.key === occKey && !s.locked && (s.mode === 'move' || s.mode === 'resize'));
  if (!ev) return null;
  const editable = canEditEvent(ev);
  const status = myStatusOf(ev, myUserId());
  const time = formatRange(ev);
  const label = roomName ? t('cal.blockRoom', { title: ev.title, time, room: roomName }) : t('cal.block', { title: ev.title, time });
  const px = height * PX_PER_MIN;
  const short = px < 38;
  return (
    <BlockMenu occKey={occKey} editable={editable}>
      <div
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-pressed={selected}
        data-occ={occKey}
        data-testid="event-block"
        title={editable ? undefined : t('cal.locked')}
        onPointerDown={(e) => onDown(e, occKey, 'move')}
        onDoubleClick={() => editable && editEvent(occKey)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            useUi.getState().selectCalEvent(occKey);
          }
        }}
        className={cx(
          'absolute z-[1] overflow-hidden rounded-[6px] border-l-[3px] px-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent',
          short ? 'py-0' : 'py-1',
          blockTone(status, selected),
          lifted && 'opacity-40',
        )}
        style={{
          top: top * PX_PER_MIN + 1,
          height: Math.max(18, px - 2),
          left: `calc(${(col / cols) * 100}% + 2px)`,
          width: `calc(${100 / cols}% - 4px)`,
        }}
      >
        {short ? (
          <p className="truncate text-caption leading-4">
            <span className="font-semibold">{ev.title}</span>
            <span className="opacity-80"> · {formatTime(eventSpan(ev).start)}</span>
          </p>
        ) : (
          <>
            <p className={cx('truncate text-caption font-semibold', status === AttendeeStatus.DECLINED && !selected && 'line-through')}>{ev.title}</p>
            <p className="truncate text-caption opacity-80">
              {time}
              {/* phone: side-by-side events are narrow — the full time stays, the room name goes */}
              {roomName ? <span className={cx(cols > 1 && 'mobile:hidden')}>{` · ${roomName}`}</span> : null}
            </p>
            {px > 70 && ev.repeat !== EventRepeat.UNSPECIFIED ? <Repeat className="mt-0.5 size-3 opacity-70" aria-hidden /> : null}
          </>
        )}
        <PersonDots occKey={occKey} className="absolute right-1 top-1" />
        {editable ? (
          <span
            aria-hidden
            data-testid="event-resize"
            onPointerDown={(e) => {
              e.stopPropagation();
              onDown(e, occKey, 'resize');
            }}
            className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
          />
        ) : null}
      </div>
    </BlockMenu>
  );
});

/** Right click on a block: every action of the card (owner addendum). */
function BlockMenu({ occKey, editable, children }: { occKey: string; editable: boolean; children: ReactNode }): ReactNode {
  const ev = useCalendar((s) => s.occ[occKey]);
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={cx(menuBox, 'w-56')}>
          {editable ? (
            <ContextMenu.Item className={menuItem} onSelect={() => editEvent(occKey)}>
              <Pencil className="size-4" aria-hidden /> {t('cal.edit')}
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Item className={menuItem} onSelect={() => duplicateEvent(occKey)}>
            <Copy className="size-4" aria-hidden /> {t('cal.duplicate')}
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => ev && copyEventLink(ev.id)}>
            <Link2 className="size-4" aria-hidden /> {t('cal.copyLink')}
          </ContextMenu.Item>
          {ev?.roomId ? (
            <ContextMenu.Item className={menuItem} onSelect={() => useUi.getState().openRoom(ev.workspaceId, ev.roomId)}>
              <Video className="size-4" aria-hidden /> {t('cal.go')}
            </ContextMenu.Item>
          ) : null}
          {editable ? (
            <>
              <ContextMenu.Separator className={menuSeparator} />
              <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void cancelWithConfirm(occKey)}>
                <Trash2 className="size-4" aria-hidden /> {ev && ev.repeat !== EventRepeat.UNSPECIFIED ? t('cal.cancelOne') : t('cal.cancelItem')}
              </ContextMenu.Item>
            </>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** All-day meetings above the grid; a drop target that makes a dragged meeting all-day. */
function AllDayRow({ workspaceId, keys, day, onDown }: { workspaceId: string; keys: readonly string[]; day: string; onDown: BlockDown }): ReactNode {
  // Always there (Apple Calendar): a stable grid under a drag, and a visible drop target.
  const dropping = useDayDrag((s) => s.allDay && !s.locked && s.mode === 'move');
  return (
    <div
      data-cal-allday={day}
      className={cx('flex shrink-0 items-start gap-0 border-b border-line py-1 pr-2', dropping && 'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]')}
      data-testid="allday-row"
    >
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

const AllDayChip = memo(function AllDayChip({ occKey, onDown }: { occKey: string; onDown: BlockDown }): ReactNode {
  const ev = useCalendar((s) => s.occ[occKey]);
  const selected = useUi((s) => s.calEvent === occKey);
  if (!ev) return null;
  const editable = canEditEvent(ev);
  return (
    <BlockMenu occKey={occKey} editable={editable}>
      <div
        role="button"
        tabIndex={0}
        data-occ={occKey}
        data-testid="event-block"
        aria-pressed={selected}
        aria-label={t('cal.block', { title: ev.title, time: formatRange(ev) })}
        title={editable ? undefined : t('cal.locked')}
        onPointerDown={(e) => onDown(e, occKey, 'move')}
        onDoubleClick={() => editable && editEvent(occKey)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            useUi.getState().selectCalEvent(occKey);
          }
        }}
        className={cx('flex min-w-0 items-center gap-1 rounded-[6px] border-l-[3px] px-1.5 text-caption font-semibold leading-5 outline-none focus-visible:ring-2 focus-visible:ring-accent', blockTone(myStatusOf(ev, myUserId()), selected))}
      >
        <span className="min-w-0 flex-1 truncate">{ev.title}</span>
        <PersonDots occKey={occKey} />
      </div>
    </BlockMenu>
  );
});

/**
 * With the «Люди» filter on: a dot per selected person the meeting involves, in their chip colour
 * (docs/08 «Фильтр «Люди»»). A leaf: a selection change re-renders the dots, not the block.
 */
const PersonDots = memo(function PersonDots({ occKey, className }: { occKey: string; className?: string }): ReactNode {
  const ws = useCalendar((s) => s.occ[occKey]?.workspaceId ?? '');
  const people = useFreeBusy(selectPeople(ws));
  // A primitive: the involved positions, re-computed only when the meeting or the selection changes.
  const sig = useCalendar((s) => {
    const ev = s.occ[occKey];
    return ev && people.length ? involvedIndexes(ev, people).join(',') : '';
  });
  if (!sig) return null;
  const idx = sig.split(',').map(Number);
  const names = idx.map((i) => memberName(ws, people[i] ?? '')).join(', ');
  return (
    <span className={cx('pointer-events-none flex shrink-0 items-center gap-0.5', className)} title={names} data-testid="person-dots">
      {idx.map((i) => (
        <span key={i} className="size-1.5 rounded-full ring-1 ring-[var(--color-bg)]" style={{ background: personColor(i) }} aria-hidden />
      ))}
      <span className="sr-only">{names}</span>
    </span>
  );
});

/** The dragged block's (or the selected range's) outline with its time — the only thing that follows the pointer. */
const DragGhost = memo(function DragGhost(): ReactNode {
  const range = useDayDrag((s) => (s.locked ? null : s.range));
  const mode = useDayDrag((s) => s.mode);
  if (!range || !mode) return null;
  const top = range.start * PX_PER_MIN;
  const h = (range.end - range.start) * PX_PER_MIN;
  const text = `${formatMinutes(range.start)} – ${formatMinutes(range.end % 1440 === 0 && range.end > 0 ? 0 : range.end)}`;
  return (
    <div
      className="pointer-events-none absolute inset-x-0.5 z-[3] rounded-[6px] border-2 border-dashed border-accent bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)]"
      style={{ top, height: Math.max(12, h) }}
      data-testid="drag-ghost"
    >
      <span className="absolute left-1.5 top-0.5 rounded bg-accent-strong px-1 text-micro font-semibold tabular-nums text-accent-fg">{text}</span>
    </div>
  );
});

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
  /** The block's range in minutes of the day where the press started. */
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

function useDragController({
  workspaceId,
  day,
  grid,
  scroller,
  creatable,
  mobile,
}: {
  workspaceId: string;
  day: string;
  grid: React.RefObject<HTMLDivElement | null>;
  scroller: React.RefObject<HTMLDivElement | null>;
  creatable: boolean;
  mobile: boolean;
}): { onGridDown: (e: ReactPointerEvent<HTMLDivElement>) => void; onBlockDown: BlockDown } {
  const press = useRef<Press | null>(null);
  const dayRef = useRef(day);
  useEffect(() => {
    dayRef.current = day;
  }, [day]);
  const edgeTimer = useRef<number | null>(null);
  const edgeSide = useRef<-1 | 0 | 1>(0);

  const minuteAt = (clientY: number): number => {
    const r = grid.current?.getBoundingClientRect();
    return r ? minutesAt(clientY - r.top, PX_PER_MIN) : 0;
  };

  const update = useCallback((x: number, y: number): void => {
    const p = press.current;
    if (!p || !p.moved) return;
    const drag = useDayDrag.getState();
    if (p.mode === 'create') {
      drag.set({ range: createRange(p.anchor, minuteAt(y), true) });
      return;
    }
    if (p.mode === 'resize') {
      drag.set({ range: resizeRange(p.orig, minuteAt(y)) });
      return;
    }
    const under = document.elementFromPoint(x, y);
    const overDay = under?.closest<HTMLElement>('[data-cal-day]')?.dataset['calDay'] ?? null;
    if (overDay) {
      drag.set({ overDay, allDay: false, range: null });
      return;
    }
    if (under?.closest('[data-cal-allday]')) {
      drag.set({ allDay: true, overDay: null, range: null });
      return;
    }
    const g = grid.current?.getBoundingClientRect();
    const inGrid = !!g && x >= g.left - 60 && x <= g.right + 8;
    drag.set({ allDay: false, overDay: null, range: inGrid ? moveRange(p.orig, p.grab, minuteAt(y)) : null });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stopEdge = (): void => {
    if (edgeTimer.current !== null) window.clearTimeout(edgeTimer.current);
    edgeTimer.current = null;
    edgeSide.current = 0;
  };

  // Holding at the grid's left / right edge while moving a block flips the day (repeats).
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
      useUi.getState().openCalendarDay(addDays(dayRef.current, side));
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
    const { range, allDay, overDay, locked } = drag;
    drag.clear();
    if (!p || e.type === 'pointercancel') return;
    const viewDay = dayRef.current;
    if (!p.moved) {
      if (p.kind === 'block' && p.key) useUi.getState().selectCalEvent(p.key);
      // With a meeting selected, a click on the empty grid first closes its card (below 1200 px it
      // floats over the grid); the next click (or a drag) creates.
      else if (p.kind === 'grid' && useUi.getState().calEvent) useUi.getState().selectCalEvent(null);
      else if (p.kind === 'grid' && creatable) {
        const r = createRange(p.anchor, p.anchor, false);
        newEvent(workspaceId, { start: atMinutes(viewDay, r.start).getTime(), end: atMinutes(viewDay, r.end).getTime() });
      }
      return;
    }
    if (locked) return;
    if (p.mode === 'create') {
      if (range) newEvent(workspaceId, { start: atMinutes(viewDay, range.start).getTime(), end: atMinutes(viewDay, range.end).getTime() });
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
      start = dayStart(viewDay);
      end = dayEnd(viewDay);
    } else if (range) {
      nextAllDay = false;
      start = atMinutes(viewDay, range.start).getTime();
      end = atMinutes(viewDay, range.end).getTime();
    } else return;
    if (start === span.start && end === span.end && nextAllDay === ev.allDay) return;
    void moveOccurrence(p.key, start, end, nextAllDay !== ev.allDay ? nextAllDay : undefined);
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

  const onBlockDown: BlockDown = (e, key, mode) => {
    if (e.button !== 0 || press.current) return;
    e.stopPropagation();
    const ev = eventOf(key);
    if (!ev) return;
    const ds = dayStart(dayRef.current);
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
      orig,
      wasAllDay: ev.allDay,
      grab,
      anchor: 0,
    };
    attach();
  };

  const onGridDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // A press that closes the open meeting dialog (a click outside it) does not start another one.
    if (e.button !== 0 || press.current || e.target !== e.currentTarget || useUi.getState().dialog) return;
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

/** N new, ←/→ day, T today, Delete cancels the selected meeting, Esc closes its card (not while typing or in a dialog). */
function useDayKeys(workspaceId: string, day: string, creatable: boolean): void {
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
        ui.openCalendarDay(addDays(dayRef.current, k === 'ArrowLeft' ? -1 : 1));
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
      const block = document.querySelector<HTMLElement>(`[data-testid="day-view"] [data-occ="${CSS.escape(key)}"]`);
      if (!el || el === document.body || el.closest('[data-testid="event-panel"]')) block?.focus();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onEsc, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onEsc, true);
    };
  }, [workspaceId, creatable]);
}

