import { CalendarPlus, CalendarSearch, ChevronLeft, ChevronRight, Users } from 'lucide-react';
import { useCallback, useEffect, type ReactNode } from 'react';
import { Bar } from '../../components/Bar';
import { Button, IconButton, Segmented, Tip } from '../../components/ui';
import { t } from '../../i18n';
import { addDays, dayStart, formatLongDay, formatWeekTitle } from '../../lib/calendar/time';
import { loadCalDav } from '../../services/freebusy';
import { useFreeBusy } from '../../stores/freebusy';
import { useUi, type CalView } from '../../stores/ui';
import { startFind } from './actions';
import { PeopleBar } from './PeopleBar';
import { CalendarExportControl } from './CalendarExport';

/*
 * The desktop header of the calendar (ADR-0038 §7; the week — bug board #6, Yandex Calendar), one
 * for the day and the week view: ‹ › (a day / a week), the title, «Сегодня» (when today is not
 * shown), «Подобрать время» and «Неделя | День» (a segmented switch). A meeting is created from the
 * sidebar's «+» (`section-create-event`), the global create menu or N (dayControls) — no button here
 * (owner, 19.10); a call now is a temporary room from the room list. The phone keeps its own compact
 * day header (DayView.tsx, with its round «+») and never shows the week.
 */

export function CalendarHeader({
  workspaceId,
  day,
  days,
  today,
  creatable,
  view,
}: {
  workspaceId: string;
  /** The view's day (the week view: the anchor inside the week). */
  day: string;
  /** The days shown: one, or the week's seven. */
  days: readonly string[];
  today: string;
  creatable: boolean;
  view: CalView;
}): ReactNode {
  const open = useUi((s) => s.openCalendarDay);
  const week = view === 'week';
  const step = week ? 7 : 1;
  const showsToday = days.includes(today);
  return (
    <Bar className="@container gap-1 pl-3 pr-2">
      <IconButton label={week ? t('cal.prevWeek') : t('cal.prevDay')} shortcut="←" onClick={() => open(addDays(day, -step))} data-testid="cal-prev">
        <ChevronLeft className="size-[18px]" />
      </IconButton>
      <IconButton label={week ? t('cal.nextWeek') : t('cal.nextDay')} shortcut="→" onClick={() => open(addDays(day, step))} data-testid="cal-next">
        <ChevronRight className="size-[18px]" />
      </IconButton>
      <h1 className="ml-1 min-w-0 flex-1 truncate text-list font-semibold first-letter:uppercase" aria-live="polite" data-testid="cal-title">
        {week ? formatWeekTitle(days) : formatLongDay(dayStart(day))}
      </h1>
      {!showsToday ? (
        <Tip label={t('cal.today')} shortcut="T">
          <Button variant="secondary" size="sm" onClick={() => open(today)} data-testid="cal-today">
            {t('cal.today')}
          </Button>
        </Tip>
      ) : null}
      {creatable ? (
        <Tip label={t('fb.find')}>
          <Button variant="secondary" size="sm" onClick={() => startFind(workspaceId)} aria-label={t('fb.find')} data-testid="day-find">
            <CalendarSearch className="size-3.5" aria-hidden />
            {/* A narrow pane (960 px window, the week's buttons): the icon keeps the title room. */}
            <span className="hidden @[620px]:inline">{t('fb.find')}</span>
          </Button>
        </Tip>
      ) : null}
      <ViewSwitch view={view} />
      <CalendarExportControl key={workspaceId} workspaceId={workspaceId} />
    </Bar>
  );
}

/** «Неделя | День» (Yandex Calendar): the view, kept on this device; the bar's segmented pill. */
function ViewSwitch({ view }: { view: CalView }): ReactNode {
  const setView = useUi((s) => s.setCalView);
  return (
    <Segmented<CalView>
      value={view}
      label={t('cal.viewPick', { view: view === 'week' ? t('cal.viewWeek') : t('cal.viewDay') })}
      options={[
        { value: 'week', label: t('cal.viewWeek') },
        { value: 'day', label: t('cal.viewDay') },
      ]}
      onChange={setView}
      testId="cal-view"
    />
  );
}

/** «Люди» over the grid (desktop): the chips of the filter; the CalDAV hint at the right end. */
export function FilterRow({ workspaceId, people }: { workspaceId: string; people: readonly string[] }): ReactNode {
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
export function ConnectControl(): ReactNode {
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
