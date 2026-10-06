import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Bar } from '../../components/Bar';
import { Avatar } from '../../components/Avatar';
import { Button, IconButton, Input, Modal, Segmented, Spinner, Toggle, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { sharedLabel } from '../../lib/calendar/external';
import { freeWindows, mergeIntervals, subtractIntervals, workIntervals, type Interval } from '../../lib/calendar/freebusy';
import { freebusyApi, noCommonHours } from '../../lib/calendar/freebusyApi';
import { addPeople, personColor } from '../../lib/calendar/people';
import { addDays, dayEnd, dayKey, dayStart, formatLongDay, formatShortDay, formatTime } from '../../lib/calendar/time';
import { useMobile } from '../../lib/mobile';
import { busySignature, ensureBusy, hoursSignature, parseBusySignature, parseHoursSignature } from '../../services/freebusy';
import { entryKey, useFreeBusy } from '../../stores/freebusy';
import { myUserId } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { popoverBox } from '../shell/menu';
import { useNow } from '../shell/voiceFormat';
import { newEvent } from './actions';
import { GUTTER, HOUR_PX, HourLines, HourScale, NowLine, PX_PER_MIN } from './gridParts';
import { useToday } from './MiniCalendar';
import { PeopleBar } from './PeopleBar';

/*
 * «Подобрать время» (ADR-0041 §3, Apple Calendar «Доступность»): chips of people, the duration
 * and «в рабочие часы»; a column of busy time per person (their colour; muted outside their work
 * hours; an external calendar's busy time hatched), the common free windows green, «Ближайшие
 * окна» from the server's suggest — a narrow column beside the grid when the pane is wide, else a
 * popover from the toolbar (the grid keeps the width, owner 29.09). A click on a window or a drag
 * over a green area picks the time: the meeting dialog opens prefilled (from the day view) or takes
 * it back (from the dialog). The columns are memo leaves selecting one person's day as a primitive:
 * a voice / presence event re-renders none of them (tools/perf-call.ts --findtime).
 */

export const DURATIONS = [30, 45, 60, 90] as const;
const MIN = 60_000;
/** Suggestions look two weeks ahead (the free / busy window). */
const SUGGEST_SPAN = 14 * 86_400_000;
/** Below this pane width «Ближайшие окна» is a popover, not a column. */
const SLOTS_COLUMN_MIN = 1100;

/** The controls' state and its setters — from the store (day view) or local (the dialog). */
export interface FindCtl {
  workspaceId: string;
  users: readonly string[];
  durationMin: number;
  workHours: boolean;
  day: string;
  addUsers: (ids: readonly string[]) => void;
  removeUser: (id: string) => void;
  setDuration: (min: number) => void;
  setWorkHours: (on: boolean) => void;
  setDay: (day: string) => void;
}

// ---------------------------------------------------------------- the day view's mode

/** «Подобрать время» in the centre pane (the store's `find`); ‹ › / ←/→ change the day, Esc / «×» close. */
export function FindTimePane({ workspaceId }: { workspaceId: string }): ReactNode {
  useLocale();
  const today = useToday();
  const day = useUi((s) => s.calDay) ?? today;
  const find = useFreeBusy((s) => s.find);
  const mobile = useMobile();
  const section = useRef<HTMLElement>(null);
  const wide = useWiderThan(section, SLOTS_COLUMN_MIN);
  const ctl = useMemo<FindCtl | null>(() => {
    if (!find) return null;
    const fb = useFreeBusy.getState;
    return {
      workspaceId,
      users: find.users,
      durationMin: find.durationMin,
      workHours: find.workHours,
      day,
      addUsers: (ids) => fb().patchFind({ users: addPeople(fb().find?.users ?? [], ids).list }),
      removeUser: (id) => fb().patchFind({ users: (fb().find?.users ?? []).filter((u) => u !== id) }),
      setDuration: (durationMin) => fb().patchFind({ durationMin }),
      setWorkHours: (workHours) => fb().patchFind({ workHours }),
      setDay: (d) => useUi.getState().openCalendarDay(d),
    };
  }, [find, workspaceId, day]);
  const slots = useSlots(ctl);

  const close = useCallback(() => useFreeBusy.getState().setFind(null), []);
  useFindKeys(day, close);

  if (!ctl) return null;
  const pick = (slot: Interval): void => {
    const me = myUserId();
    useUi.getState().openCalendarDay(dayKey(slot.start));
    newEvent(workspaceId, { start: slot.start, end: slot.end, attendees: ctl.users.filter((u) => u !== me) });
  };

  return (
    <section ref={section} className="mat-content relative flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('fb.find')} data-testid="find-time">
      {/* Phone: the header's one control is ✕ — no nav button next to it (it would be hamburger + ✕). */}
      <Bar className="gap-3 pl-4 pr-2">
        <h1 className="shrink-0 text-list font-semibold">{t('fb.find')}</h1>
        {/* Phone: the list covers two weeks from today — no day to page through. */}
        {mobile ? null : <DayNav day={day} today={today} setDay={ctl.setDay} />}
        <span className="flex-1" />
        {!mobile && !wide ? <SlotsPopover slots={slots} onPick={pick} /> : null}
        <IconButton label={t('fb.closeFind')} shortcut="Esc" onClick={close} data-testid="find-close">
          <X className="size-[18px]" />
        </IconButton>
      </Bar>
      <FindControls ctl={ctl} wrap={mobile} />
      <NoCommonHours ctl={ctl} slots={slots} />
      {mobile ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <SlotPanel slots={slots} onPick={pick} next={false} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <AvailabilityGrid ctl={ctl} onPick={pick} highlight={slots.shown} />
          {wide ? (
            <aside className="w-60 shrink-0 overflow-y-auto border-l border-line p-3" aria-label={t('fb.slots')}>
              <SlotPanel slots={slots} onPick={pick} next />
            </aside>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** Whether the element is at least `min` px wide (a ResizeObserver: only on resizes, not per frame). */
function useWiderThan(ref: React.RefObject<HTMLElement | null>, min: number): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setWide(el.clientWidth >= min);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, min]);
  return wide;
}

/** ‹ «Четверг, 15 января» › and «Сегодня» — the day, secondary to the title. */
function DayNav({ day, today, setDay }: { day: string; today: string; setDay: (d: string) => void }): ReactNode {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <IconButton label={t('cal.prevDay')} shortcut="←" size="sm" onClick={() => setDay(addDays(day, -1))}>
        <ChevronLeft className="size-4" />
      </IconButton>
      <span className="min-w-0 truncate text-control text-muted first-letter:uppercase" aria-live="polite" data-testid="find-day">
        {formatLongDay(dayStart(day))}
      </span>
      <IconButton label={t('cal.nextDay')} shortcut="→" size="sm" onClick={() => setDay(addDays(day, 1))}>
        <ChevronRight className="size-4" />
      </IconButton>
      {day !== today ? (
        <Button variant="ghost" size="sm" onClick={() => setDay(today)} className="ml-1">
          {t('cal.today')}
        </Button>
      ) : null}
    </div>
  );
}

/** ←/→ day, Esc closes (not while typing, not under a dialog or menu). */
function useFindKeys(day: string, close: () => void): void {
  const dayRef = useRef(day);
  useEffect(() => {
    dayRef.current = day;
  }, [day]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || useUi.getState().dialog) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        useUi.getState().openCalendarDay(addDays(dayRef.current, e.key === 'ArrowLeft' ? -1 : 1));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
}

// ---------------------------------------------------------------- the dialog's run

/**
 * «Подобрать время» next to the meeting dialog's times: the same controls on local state,
 * prefilled with me and the attendees; a picked slot goes back to the dialog. The sheet is
 * narrower than the slots column's threshold: «Ближайшие окна» is the toolbar's popover.
 */
export function FindTimeDialog({
  workspaceId,
  users: initUsers,
  durationMin: initDuration,
  day: initDay,
  onPick,
  onClose,
}: {
  workspaceId: string;
  users: readonly string[];
  durationMin: number;
  day: string;
  onPick: (slot: Interval, users: readonly string[]) => void;
  onClose: () => void;
}): ReactNode {
  const mobile = useMobile();
  const today = useToday();
  const [users, setUsers] = useState<readonly string[]>(initUsers);
  const [durationMin, setDuration] = useState(initDuration);
  const [workHours, setWorkHours] = useState(true);
  const [day, setDay] = useState(initDay);
  const ctl = useMemo<FindCtl>(
    () => ({
      workspaceId,
      users,
      durationMin,
      workHours,
      day,
      addUsers: (ids) => setUsers((u) => addPeople(u, ids).list),
      removeUser: (id) => setUsers((u) => u.filter((x) => x !== id)),
      setDuration,
      setWorkHours,
      setDay,
    }),
    [workspaceId, users, durationMin, workHours, day],
  );
  const slots = useSlots(ctl);
  const pick = (slot: Interval): void => onPick(slot, users);
  return (
    <Modal open onClose={onClose} title={t('fb.find')} wide fill>
      <div className="-mx-5 -mb-5 -mt-4 flex min-h-0 flex-1 flex-col border-t border-line" data-testid="find-time-dialog">
        <FindControls ctl={ctl} wrap lead={mobile ? null : <DayNav day={day} today={today} setDay={setDay} />} trail={mobile ? null : <SlotsPopover slots={slots} onPick={pick} />} />
        <NoCommonHours ctl={ctl} slots={slots} />
        {mobile ? (
          <div className="p-3">
            <SlotPanel slots={slots} onPick={pick} next={false} />
          </div>
        ) : (
          <div className="flex h-[min(440px,calc(100vh-300px))] min-h-[240px]">
            <AvailabilityGrid ctl={ctl} onPick={pick} highlight={slots.shown} />
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- controls

/**
 * Two rows under a hairline (docs/08): the people's chips with `trail` right-aligned (the
 * dialog's «Ближайшие окна ▾»); then `lead` (the dialog's day), the duration and, on the right,
 * «В рабочие часы».
 */
function FindControls({ ctl, wrap, lead, trail }: { ctl: FindCtl; wrap: boolean; lead?: ReactNode; trail?: ReactNode }): ReactNode {
  const preset = (DURATIONS as readonly number[]).includes(ctl.durationMin);
  const [custom, setCustom] = useState(!preset);
  const [text, setText] = useState(String(ctl.durationMin));
  const value = custom ? 'custom' : String(ctl.durationMin);
  const commit = (raw: string): void => {
    const n = Math.round(Number(raw) / 15) * 15;
    if (Number.isFinite(n) && n >= 15 && n <= 480) ctl.setDuration(n);
    else setText(String(ctl.durationMin));
  };
  return (
    <div className="flex shrink-0 flex-col gap-3 border-b border-line px-4 py-3" data-testid="find-controls">
      <div className="flex min-w-0 items-start gap-4">
        <PeopleBar workspaceId={ctl.workspaceId} people={ctl.users} onAdd={ctl.addUsers} onRemove={ctl.removeUser} wrap={wrap} testId="find-people" />
        {trail ? <div className="shrink-0">{trail}</div> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {lead}
        <div className="flex items-center gap-2">
          <Segmented
            label={t('fb.duration')}
            value={value}
            options={[...DURATIONS.map((m) => ({ value: String(m), label: t('fb.min', { n: m }) })), { value: 'custom', label: t('fb.custom') }]}
            onChange={(v) => {
              if (v === 'custom') {
                setCustom(true);
                setText(String(ctl.durationMin));
                return;
              }
              setCustom(false);
              ctl.setDuration(Number(v));
            }}
          />
          {custom ? (
            <Input
              type="number"
              min={15}
              max={480}
              step={15}
              value={text}
              aria-label={t('fb.customMin')}
              onChange={(e) => setText(e.target.value)}
              onBlur={(e) => commit(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)}
              className="w-20"
              data-testid="find-custom"
            />
          ) : null}
        </div>
        <label className="ml-auto flex items-center gap-2 text-body">
          <span>{t('fb.workHours')}</span>
          <Toggle label={t('fb.workHours')} checked={ctl.workHours} onChange={ctl.setWorkHours} />
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- «Ближайшие окна»

interface Slots {
  slots: Interval[];
  status: 'idle' | 'loading' | 'ok' | 'hours' | 'fail';
  /** The slot «Следующее окно» stepped to (outlined on the grid), -1 = none. */
  cursor: number;
  shown: Interval | null;
  next: () => void;
}

/** The server's nearest windows (≤ 10) from the shown day on, asked again when anything changes. */
function useSlots(ctl: FindCtl | null): Slots {
  const workspaceId = ctl?.workspaceId ?? '';
  const users = ctl?.users ?? [];
  const durationMin = ctl?.durationMin ?? 30;
  const workHours = ctl?.workHours ?? true;
  const day = ctl?.day ?? '';
  const [res, setRes] = useState<{ key: string; slots: Interval[]; status: 'ok' | 'hours' | 'fail' } | null>(null);
  const [cursor, setCursor] = useState<{ key: string; i: number }>({ key: '', i: -1 });
  // Busy time changes (EVENT_*, a new window loaded) ask the server again.
  const version = useFreeBusy((s) => s.rev);
  const baseKey = `${workspaceId}|${users.join(',')}|${durationMin}|${workHours ? 1 : 0}`;
  const reqKey = `${baseKey}|${day}|${version}`;

  useEffect(() => {
    if (!users.length || !workspaceId) return;
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      const start = Math.max(Math.ceil(Date.now() / (15 * MIN)) * 15 * MIN, dayStart(day));
      freebusyApi.suggest(workspaceId, { users, durationMin, from: start, to: start + SUGGEST_SPAN, withinWorkHours: workHours }, ac.signal).then(
        (slots) => setRes({ key: reqKey, slots: slots.slice(0, 10), status: 'ok' }),
        (e: unknown) => {
          if (!ac.signal.aborted) setRes({ key: reqKey, slots: [], status: noCommonHours(e) ? 'hours' : 'fail' });
        },
      );
    }, 250);
    return () => {
      ac.abort();
      window.clearTimeout(timer);
    };
  }, [reqKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const slots = users.length ? (res?.slots ?? []) : [];
  const status: Slots['status'] = !users.length ? 'idle' : !res || res.key !== reqKey ? 'loading' : res.status;
  // The cursor belongs to one query (people, duration, hours): a new one starts over.
  const i = cursor.key === baseKey ? cursor.i : -1;
  const shown = slots[i] ?? null;
  const next = (): void => {
    const n = i + 1 < slots.length ? i + 1 : 0;
    const slot = slots[n];
    if (!slot || !ctl) return;
    setCursor({ key: baseKey, i: n });
    const d = dayKey(slot.start);
    if (d !== day) ctl.setDay(d);
  };
  return { slots, status, cursor: i, shown, next };
}

/**
 * The list: compact rows (weekday + date left, time right, 36 px, 6 px apart), «Следующее окно»
 * right under it (content width, right-aligned) when `next` — where there is a grid to step on.
 */
function groupByDay(list: Interval[]): Array<{ day: string; items: Array<{ s: Interval; i: number }> }> {
  const out: Array<{ day: string; items: Array<{ s: Interval; i: number }> }> = [];
  list.forEach((s, i) => {
    const day = formatShortDay(s.start);
    const last = out[out.length - 1];
    if (last?.day === day) last.items.push({ s, i });
    else out.push({ day, items: [{ s, i }] });
  });
  return out;
}

function SlotPanel({ slots, onPick, next }: { slots: Slots; onPick: (slot: Interval) => void; next: boolean }): ReactNode {
  const { status, slots: list, cursor } = slots;
  const mobile = useMobile();
  return (
    <div className="flex flex-col gap-2" data-testid="find-slots">
      <div className="flex h-6 items-center justify-between gap-2">
        <h2 className="text-control font-semibold">{t('fb.slots')}</h2>
        {status === 'loading' ? <Spinner className="size-4" /> : null}
      </div>
      {status === 'idle' ? <p className="text-caption text-muted">{t('fb.addSomeone')}</p> : null}
      {status === 'hours' ? <p className="text-caption text-muted">{t('fb.noSlots')}</p> : null}
      {status === 'fail' ? <p className="text-caption text-danger-text">{t('fb.failed')}</p> : null}
      {status === 'ok' && list.length === 0 ? <p className="text-caption text-muted">{t('fb.noSlots')}</p> : null}
      {list.length && mobile ? (
        // Phone: one card per day — the date is the primary line, the times (secondary) are chips under it.
        <ul className="flex flex-col gap-2">
          {groupByDay(list).map((g) => (
            <li key={g.day} className="flex min-h-14 flex-col gap-1.5 rounded-[var(--radius-card)] bg-[var(--color-fill)] px-4 py-3" data-testid="find-day">
              <span className="text-[15px] font-semibold first-letter:uppercase">{g.day}</span>
              <div className="flex flex-wrap gap-2">
                {g.items.map(({ s, i }) => (
                  <button
                    key={s.start}
                    type="button"
                    onClick={() => onPick(s)}
                    aria-pressed={i === cursor}
                    className={cx('h-9 rounded-full px-3 text-[13px] font-medium tabular-nums', i === cursor ? 'bg-accent-strong text-accent-fg' : 'bg-[var(--color-fill-hover)] text-fg')}
                    data-testid="find-slot"
                  >
                    {formatTime(s.start)} – {formatTime(s.end)}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      ) : list.length ? (
        <ul className="flex flex-col gap-1.5">
          {list.map((s, i) => (
            <li key={s.start}>
              <button
                type="button"
                onClick={() => onPick(s)}
                aria-pressed={i === cursor}
                className={cx(
                  'flex h-9 w-full items-center justify-between gap-2 rounded-[8px] px-3 text-left transition-colors duration-[var(--motion-fast)]',
                  i === cursor ? 'bg-accent-strong text-accent-fg' : 'bg-[var(--color-fill)] text-fg hover:bg-[var(--color-fill-hover)]',
                )}
                data-testid="find-slot"
              >
                <span className={cx('min-w-0 truncate text-caption first-letter:uppercase', i === cursor ? '' : 'text-muted')}>{formatShortDay(s.start)}</span>
                <span className="shrink-0 text-body font-medium tabular-nums">
                  {formatTime(s.start)} – {formatTime(s.end)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {next && list.length ? (
        <Button variant="secondary" size="sm" className="self-end" onClick={slots.next} data-testid="find-next">
          {t('fb.next')}
          <ChevronRight className="size-3.5" aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

/** 409 NO_COMMON_HOURS under the toolbar — seen whatever shows the list — with the way out. */
function NoCommonHours({ ctl, slots }: { ctl: FindCtl; slots: Slots }): ReactNode {
  if (slots.status !== 'hours') return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-[var(--color-fill)] px-4 py-2" role="alert" data-testid="find-no-hours">
      <p className="min-w-0 flex-1 text-caption text-fg">{t('fb.noCommonHours')}</p>
      <Button size="sm" variant="secondary" onClick={() => ctl.setWorkHours(false)}>
        {t('fb.anyHours')}
      </Button>
    </div>
  );
}

/** A narrow pane: «Ближайшие окна ▾» in the toolbar opens the same list over the grid. */
function SlotsPopover({ slots, onPick }: { slots: Slots; onPick: (slot: Interval) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const count = slots.slots.length;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="secondary" size="sm" data-testid="find-slots-toggle">
          {t('fb.slots')}
          {count ? <span className="tabular-nums text-muted">{count}</span> : null}
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={16} className={cx(popoverBox, 'max-h-[var(--radix-popover-content-available-height)] w-72 overflow-y-auto p-3')} onOpenAutoFocus={(e) => e.preventDefault()}
          // A picked slot opens the meeting dialog: the focus must not jump back to the trigger (a non-modal dialog closes on focus outside).
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <SlotPanel
            slots={slots}
            onPick={(s) => {
              setOpen(false);
              onPick(s);
            }}
            next
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------- the grid

/** Columns of busy time, one per person, over the hour grid; the common free windows green. */
function AvailabilityGrid({ ctl, onPick, highlight }: { ctl: FindCtl; onPick: (slot: Interval) => void; highlight: Interval | null }): ReactNode {
  const { workspaceId, users, day } = ctl;
  const scroller = useRef<HTMLDivElement>(null);
  const from = dayStart(day);
  const to = dayEnd(day);
  useEffect(() => ensureBusy(workspaceId, users, from, to), [workspaceId, users, from, to]);

  // Open at the earliest work start of the people (their zones), else 08:00; a highlighted slot comes into view.
  const hours = useFreeBusy(useShallow((s) => users.map((u) => hoursSignature(s.entries[entryKey(workspaceId, u)]))));
  const firstWork = useMemo(() => {
    let min = 8 * 60;
    for (const h of hours) {
      const p = parseHoursSignature(h);
      const w = p ? workIntervals(p.workHours, p.timezone, from, to)[0] : undefined;
      if (w) min = Math.min(min, (w.start - from) / MIN);
    }
    return min;
  }, [hours, from, to]);
  const loaded = hours.every(Boolean);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = Math.max(0, (firstWork - 60) * PX_PER_MIN);
    // Once per day (and when the people's hours arrive).
  }, [day, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = scroller.current;
    if (!el || !highlight || highlight.start < from || highlight.start >= to) return;
    const top = ((highlight.start - from) / MIN) * PX_PER_MIN;
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - 60) el.scrollTo({ top: Math.max(0, top - el.clientHeight / 3) });
  }, [highlight, from, to]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="availability">
      <div className="flex shrink-0 border-b border-line pr-2">
        <div className={cx(GUTTER, 'shrink-0')} />
        {users.map((u, i) => (
          <ColumnHead key={u} workspaceId={workspaceId} userId={u} day={day} color={personColor(i)} />
        ))}
      </div>
      <div ref={scroller} tabIndex={0} role="region" aria-label={t('fb.gridLabel')} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-offset-[-2px]">
        <div className="relative flex" style={{ height: 24 * HOUR_PX + 16 }}>
          <HourScale />
          <div className="relative mr-2 mt-2 flex flex-1" style={{ height: 24 * HOUR_PX }}>
            <HourLines />
            {users.map((u, i) => (
              <BusyColumn key={u} workspaceId={workspaceId} userId={u} day={day} color={personColor(i)} />
            ))}
            <FreeOverlay ctl={ctl} onPick={onPick} highlight={highlight} />
            <NowLine day={day} />
          </div>
        </div>
      </div>
    </div>
  );
}

const ColumnHead = memo(function ColumnHead({ workspaceId, userId, day, color }: { workspaceId: string; userId: string; day: string; color: string }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const from = dayStart(day);
  const to = dayEnd(day);
  const allDay = useFreeBusy((s) => s.entries[entryKey(workspaceId, userId)]?.busy.some((b) => b.allDay && b.start < to && b.end > from) ?? false);
  const avatar = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]?.user?.avatarFileId ?? '');
  return (
    <div className="flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 border-l border-line px-1.5" title={name}>
      <span className="grid size-6 shrink-0 place-items-center rounded-full" style={{ boxShadow: `inset 0 0 0 2px ${color}` }}>
        <Avatar userId={userId} name={name} {...(avatar ? { fileId: avatar } : {})} size={20} />
      </span>
      <span className="min-w-0 truncate text-caption font-medium">{userId === myUserId() ? t('fb.me') : name}</span>
      {allDay ? (
        <span className="shrink-0 rounded-full px-1.5 text-micro font-medium leading-4 text-fg" style={{ background: `color-mix(in srgb, ${color} 28%, transparent)` }} title={t('fb.busyAllDay', { name })} data-testid="busy-all-day">
          {t('cal.allDayRow')}
        </span>
      ) : null}
    </div>
  );
});

/** One person's day: grey outside their work hours, busy blocks in their colour (external: hatched). */
const BusyColumn = memo(function BusyColumn({ workspaceId, userId, day, color }: { workspaceId: string; userId: string; day: string; color: string }): ReactNode {
  const from = dayStart(day);
  const to = dayEnd(day);
  const sig = useFreeBusy((s) => busySignature(s.entries[entryKey(workspaceId, userId)], from, to));
  const hoursSig = useFreeBusy((s) => hoursSignature(s.entries[entryKey(workspaceId, userId)]));
  const name = useMemberName(workspaceId, userId);
  // Overlapping meetings of one person are one block (the column says «busy», not what); an
  // external event they share the title of (ADR-0045 §4) stays itself, with its label.
  const busy = useMemo(() => {
    const list = parseBusySignature(sig);
    const merge = (kind: 'meeting' | 'external'): Array<{ start: number; end: number; kind: typeof kind; label: string }> =>
      mergeIntervals(list.filter((b) => b.kind === kind && !b.allDay && !(kind === 'external' && sharedLabel(b)))).map((i) => ({ ...i, kind, label: '' }));
    const shared = list.flatMap((b) => {
      const l = b.kind === 'external' && !b.allDay ? sharedLabel(b) : null;
      return l ? [{ start: b.start, end: b.end, kind: 'external' as const, label: l.count ? plural('fb.sharedCount', l.count, { title: l.title }) : l.title }] : [];
    });
    return [...merge('external'), ...shared, ...merge('meeting')];
  }, [sig]);
  const off = useMemo(() => {
    const h = parseHoursSignature(hoursSig);
    return h ? subtractIntervals([{ start: from, end: to }], workIntervals(h.workHours, h.timezone, from, to)) : [];
  }, [hoursSig, from, to]);
  const y = (ms: number): number => ((Math.max(from, Math.min(to, ms)) - from) / MIN) * PX_PER_MIN;
  return (
    <div className="relative min-w-0 flex-1 border-l border-line" data-testid="busy-column" data-user={userId}>
      {off.map((o) => (
        <div key={o.start} aria-hidden className="absolute inset-x-0 bg-[color-mix(in_srgb,var(--color-label-tertiary)_10%,transparent)]" style={{ top: y(o.start), height: y(o.end) - y(o.start) }} />
      ))}
      {busy.map((b) => {
        const external = b.kind === 'external';
        return (
          <div
            key={`${b.start}-${b.end}-${b.kind}-${b.label}`}
            role="img"
            aria-label={
              b.label
                ? t('fb.sharedAt', { name, label: b.label, time: `${formatTime(b.start)} – ${formatTime(b.end)}` })
                : t(external ? 'fb.busyExternalAt' : 'fb.busyAt', { name, time: `${formatTime(b.start)} – ${formatTime(b.end)}` })
            }
            title={b.label || undefined}
            data-testid="busy-cell"
            data-kind={b.kind}
            className="absolute inset-x-1 overflow-hidden rounded-[6px] border-l-[3px] px-1 text-micro font-medium leading-4 text-fg"
            style={{
              top: y(b.start) + 1,
              height: Math.max(8, y(b.end) - y(b.start) - 2),
              borderColor: color,
              background: external
                ? `repeating-linear-gradient(135deg, color-mix(in srgb, ${color} 18%, transparent) 0 6px, color-mix(in srgb, ${color} 42%, transparent) 6px 9px)`
                : `color-mix(in srgb, ${color} 42%, var(--color-bg))`,
            }}
          >
            {b.label && y(b.end) - y(b.start) >= 18 ? <span className="block truncate pt-0.5">{b.label}</span> : null}
          </div>
        );
      })}
    </div>
  );
});

/**
 * The common free windows (green) over the columns, the only pointer target: a click takes the
 * duration from that point (inside the window), a drag selects a range in it (15-minute steps).
 */
const FreeOverlay = memo(function FreeOverlay({ ctl, onPick, highlight }: { ctl: FindCtl; onPick: (slot: Interval) => void; highlight: Interval | null }): ReactNode {
  const { workspaceId, users, day, durationMin, workHours } = ctl;
  const from = dayStart(day);
  const to = dayEnd(day);
  const sigs = useFreeBusy(useShallow((s) => users.map((u) => `${busySignature(s.entries[entryKey(workspaceId, u)], from, to)}#${hoursSignature(s.entries[entryKey(workspaceId, u)])}`)));
  // «Now» in 15-minute steps (the minute ticker; the windows recompute when a step passes).
  const now = Math.ceil(useNow(60_000) / (15 * MIN)) * 15 * MIN;
  const windows = useMemo(() => {
    if (!users.length || sigs.some((x) => x.endsWith('#'))) return [];
    const busy = sigs.map((x) => parseBusySignature(x.slice(0, x.lastIndexOf('#'))));
    const work = workHours
      ? sigs.map((x) => {
          const h = parseHoursSignature(x.slice(x.lastIndexOf('#') + 1));
          return h ? workIntervals(h.workHours, h.timezone, from, to) : [];
        })
      : null;
    // Not in the past.
    return freeWindows({ from: Math.max(from, Math.min(to, now)), to, busy, work, minMinutes: durationMin });
    // `now` in 15-minute steps: recomputed when the minute passes a step (with the day / people).
  }, [sigs, users.length, workHours, from, to, durationMin, now]);
  const [sel, setSel] = useState<Interval | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const minuteAt = (clientY: number): number => {
    const r = box.current?.getBoundingClientRect();
    return r ? Math.max(0, Math.min(24 * 60, Math.round((clientY - r.top) / PX_PER_MIN / 15) * 15)) : 0;
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>, w: Interval): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const anchor = from + minuteAt(e.clientY) * MIN;
    const y0 = e.clientY;
    let moved = false;
    const clip = (a: number, b: number): Interval => ({ start: Math.max(w.start, Math.min(a, b)), end: Math.min(w.end, Math.max(a, b)) });
    const move = (ev: PointerEvent): void => {
      if (!moved && Math.abs(ev.clientY - y0) < 4) return;
      moved = true;
      const at = from + minuteAt(ev.clientY) * MIN;
      setSel(clip(anchor, at === anchor ? anchor + 15 * MIN : at));
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setSel(null);
      if (ev.type === 'pointercancel') return;
      if (moved) {
        const at = from + minuteAt(ev.clientY) * MIN;
        const r = clip(anchor, at);
        if (r.end - r.start >= 15 * MIN) onPick(r);
        return;
      }
      // A click: the duration from the clicked quarter, kept inside the window.
      const len = durationMin * MIN;
      const start = Math.max(w.start, Math.min(Math.floor(anchor / (15 * MIN)) * 15 * MIN, w.end - len));
      onPick({ start, end: start + len });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const y = (ms: number): number => ((Math.max(from, Math.min(to, ms)) - from) / MIN) * PX_PER_MIN;
  const shown = sel ?? (highlight && highlight.start < to && highlight.end > from ? highlight : null);
  return (
    <div ref={box} className="pointer-events-none absolute inset-0 z-[1]" data-testid="free-overlay">
      {windows.map((w) => (
        <div
          key={w.start}
          role="button"
          tabIndex={0}
          aria-label={t('fb.freeWindow', { time: `${formatTime(w.start)} – ${formatTime(w.end)}` })}
          data-testid="free-window"
          onPointerDown={(e) => onDown(e, w)}
          onKeyDown={(e) => {
            // Keyboard: the window's first slot of the duration.
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            const start = Math.ceil(w.start / (15 * MIN)) * 15 * MIN;
            onPick({ start, end: start + durationMin * MIN });
          }}
          className="pointer-events-auto absolute inset-x-0.5 cursor-copy rounded-[6px] border border-[color-mix(in_srgb,var(--color-green)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-green)_12%,transparent)] outline-offset-[-2px] hover:bg-[color-mix(in_srgb,var(--color-green)_20%,transparent)]"
          style={{ top: y(w.start), height: Math.max(4, y(w.end) - y(w.start)) }}
        />
      ))}
      {shown ? (
        <div
          className="absolute inset-x-0 z-[2] rounded-[6px] border-2 border-accent bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)]"
          style={{ top: y(shown.start), height: Math.max(12, y(shown.end) - y(shown.start)) }}
          data-testid="find-selection"
        >
          <span className="absolute left-1.5 top-0.5 rounded bg-accent-strong px-1 text-micro font-semibold tabular-nums text-accent-fg">
            {formatTime(shown.start)} – {formatTime(shown.end)}
          </span>
        </div>
      ) : null}
    </div>
  );
});
