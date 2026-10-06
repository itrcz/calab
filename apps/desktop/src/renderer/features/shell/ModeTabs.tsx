import { CalendarDays, SquareKanban, Volume2, type LucideIcon } from 'lucide-react';
import { memo, useCallback, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { dayKey } from '../../lib/calendar/time';
import { unreadCount, useBoards } from '../../stores/boards';
import { useBoardsUi } from '../../stores/boardsUi';
import { useCalendar } from '../../stores/calendar';
import { useFreeBusy } from '../../stores/freebusy';
import { useUi } from '../../stores/ui';
import { pillBox, pillStyle } from './modePill';

export type Mode = 'voice' | 'calendar' | 'boards';
const MODES: readonly Mode[] = ['voice', 'calendar', 'boards'];

/**
 * Switches the workspace mode (docs/09 #140): «Голос» — the room (calendar and boards off);
 * «Календарь» — today's day view with the mini month (boards off, ADR-0041 §3); «Доски» — the boards
 * (calendar off, ADR-0042 §5). The stores keep the two exclusive on their own as well (a board or a
 * day opened from anywhere turns the other off).
 */
export function showMode(mode: Mode): void {
  const ui = useUi.getState();
  const boards = useBoardsUi.getState();
  if (mode === 'calendar') {
    if (ui.calDay !== null) return;
    ui.setCalMonth(null);
    useFreeBusy.getState().setFind(null);
    ui.openCalendarDay(dayKey(Date.now()), null);
    ui.toggleMiniCal(true);
    return;
  }
  if (ui.calDay !== null) ui.closeCalendar();
  ui.toggleMiniCal(false);
  if (boards.active !== (mode === 'boards')) boards.setActive(mode === 'boards');
}

/** The selected mode: boards win (the centre shows them), then the day view, else the room. */
const useMode = (): Mode => {
  const boards = useBoardsUi((s) => s.active);
  const cal = useUi((s) => s.calDay !== null);
  return boards ? 'boards' : cal ? 'calendar' : 'voice';
};

/**
 * «Голос · Календарь · Доски» in the room column header, in place of the workspace name (owner,
 * 30.09; docs/09 #140): a segmented tab strip. The selected tab shows its icon and label and takes
 * the free width; the others are 32 px icons with a tooltip (the column is 200–320 px wide next
 * to «+»: three labels do not fit in every language). Counters as before: today's meetings on the
 * calendar, unread tasks on the boards. ←/→ (Home/End) move between the tabs and select them.
 * Not for guests (the caller). Primitive selectors only — a mode switch re-renders this strip,
 * not the room list.
 */
export const ModeTabs = memo(function ModeTabs({ workspaceId, calendar = true }: { workspaceId: string; calendar?: boolean }): ReactNode {
  // memo + props without the language: subscribe, or a live language switch leaves the old labels.
  useLocale();
  const mode = useMode();
  const today = useCalendar((s) => s.todayCount);
  const unread = useBoards((s) => unreadCount(s, workspaceId));
  const trackRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  // The pill is moved straight on the DOM (no state): a switch re-renders only this strip's tabs.
  // The first measure and every resize are instant; a change of the mode glides (data-glide).
  useLayoutEffect(() => {
    const track = trackRef.current;
    const pill = pillRef.current;
    if (!track || !pill) return;
    const place = (glide: boolean): void => {
      const seg = track.querySelector<HTMLElement>(`[data-mode="${mode}"]`);
      if (!seg) return;
      const tr = track.getBoundingClientRect();
      const box = pillBox({ left: tr.left, borderLeft: track.clientLeft }, seg.getBoundingClientRect(), window.devicePixelRatio || 1);
      if (!box) return;
      const first = pill.dataset.ready !== 'true';
      pill.dataset.glide = String(glide && !first);
      const st = pillStyle(box);
      pill.style.transform = st.transform;
      pill.style.width = st.width;
      pill.dataset.ready = 'true';
      pill.style.visibility = 'visible';
    };
    place(true);
    // A resize of the column moves the segment without a user switch: follow it instantly. It
    // fires on real size changes only, never on a timer.
    let observed = false;
    const ro = new ResizeObserver(() => {
      // The first callback is the initial observation, not a resize: it must not cut the glide.
      if (observed) place(false);
      observed = true;
    });
    ro.observe(track);
    return () => ro.disconnect();
  }, [mode]);
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const modes = calendar ? MODES : MODES.filter((m) => m !== 'calendar');
    const n = modes.length;
    const at = modes.indexOf((e.target as HTMLElement).dataset.mode as Mode);
    if (at < 0) return;
    const next = e.key === 'ArrowRight' ? (at + 1) % n : e.key === 'ArrowLeft' ? (at + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const m = modes[next] ?? 'voice';
    const list = e.currentTarget;
    const focus = (): void => list.querySelector<HTMLElement>(`[data-mode="${m}"]`)?.focus();
    showMode(m);
    focus();
    // «Голос» opens the room, whose composer takes the focus on mount: arrows stay on the tabs.
    window.setTimeout(() => {
      if (!list.contains(document.activeElement)) focus();
    }, 0);
  }, [calendar]);
  return (
    <div
      ref={trackRef}
      role="tablist"
      aria-label={t('shell.modes')}
      onKeyDown={onKeyDown}
      className="relative flex h-8 min-w-0 flex-1 items-center gap-0.5 rounded-[var(--radius-control)] bg-[var(--color-mode-track)] p-0.5 shadow-[inset_0_0_0_1px_var(--color-mode-track-line)]"
      data-testid="mode-tabs"
    >
      <div ref={pillRef} aria-hidden className="mode-pill" style={{ visibility: 'hidden' }} data-testid="mode-pill" />
      <ModeTab mode="voice" selected={mode === 'voice'} icon={Volume2} label={t('shell.modeVoice')} count={0} countLabel="" testId="mode-voice" />
      {calendar ? (
      <ModeTab
        mode="calendar"
        selected={mode === 'calendar'}
        icon={CalendarDays}
        label={t('cal.open')}
        count={today}
        countLabel={today > 0 ? plural('cal.todayCount', today) : ''}
       
        testId="calendar-button"
        countTestId="calendar-count"
      />
      ) : null}
      <ModeTab
        mode="boards"
        selected={mode === 'boards'}
        icon={SquareKanban}
        label={t('shell.modeBoards')}
        count={unread}
        countLabel={unread > 0 ? plural('boards.unreadCount', unread) : ''}
       
        testId="boards-button"
        countTestId="boards-count"
      />
    </div>
  );
});

function ModeTab({
  mode,
  selected,
  icon: Icon,
  label,
  count,
  countLabel,
  testId,
  countTestId,
}: {
  mode: Mode;
  selected: boolean;
  icon: LucideIcon;
  label: string;
  count: number;
  countLabel: string;
  testId: string;
  countTestId?: string;
}): ReactNode {
  // The counters' texts start with the tab's name («Календарь: сегодня 2 встречи»).
  const name = countLabel || label;
  const tab = (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={name}
      // Every tab stays in the Tab order: iOS WebKit does not turn a tap on a tabindex=-1 button
      // into a click (the roving-tabindex pattern broke the tabs on phones). ←/→ still move.
      data-mode={mode}
      data-testid={testId}
      onClick={() => showMode(mode)}
      className={cx(
        // Focus ring at offset 0: it fills the track's 2 px padding (as the segmented control).
        // The pill (behind, see .mode-pill) carries the selected look; the tab itself is flat.
        'relative z-10 flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-[calc(var(--radius-control)-2px)] text-control font-medium transition-colors duration-[var(--motion-fast)] focus-visible:outline-offset-0',
        selected ? 'min-w-0 flex-1 px-2 font-semibold text-fg' : 'w-8 text-[var(--color-mode-idle)] hover:bg-[var(--color-mode-hover)] hover:text-fg',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {selected ? <span className="mode-label min-w-0 truncate">{label}</span> : null}
      {count > 0 ? (
        <span
          aria-hidden
          data-testid={countTestId}
          className={cx(
            'grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-accent-strong px-1 text-micro font-semibold tabular-nums leading-none text-accent-fg',
            !selected && 'absolute -right-1 -top-1',
          )}
        >
          {count > 9 ? '9+' : count}
        </span>
      ) : null}
    </button>
  );
  // Always under the tooltip: a wrapper that came and went with the selection would remount the
  // tab and drop the keyboard focus.
  return <Tip label={name}>{tab}</Tip>;
}
