import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { addMonths, formatMonth, monthGrid, monthOf, weekStart, weekdayNames } from '../../lib/calendar/time';

/**
 * A month to pick a day from: «‹ Октябрь 2026 ›», weekday names and six weeks. The chosen day is
 * filled, today is accent-coloured, `focus` (keyboard) gets a ring. Shared by the board date
 * popover and the phone calendar's date card; the owner handles keys and closing.
 */
export function MonthPicker({
  month,
  onMonth,
  value,
  today,
  focus,
  onPick,
}: {
  month: string;
  onMonth: (month: string) => void;
  value: string;
  today: string;
  focus?: string;
  onPick: (day: string) => void;
}): ReactNode {
  const first = weekStart();
  const grid = useMemo(() => monthGrid(month, first), [month, first]);
  const arrow = 'grid size-6 place-items-center rounded-[var(--radius-icon)] text-muted hover:bg-hover hover:text-fg mobile:size-11';
  return (
    <>
      <div className="flex items-center gap-1 pb-1">
        <span className="flex-1 pl-1 text-control font-semibold">{formatMonth(month)}</span>
        <button type="button" aria-label={t('cal.prevMonth')} onClick={() => onMonth(addMonths(month, -1))} className={arrow} data-testid="month-prev">
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <button type="button" aria-label={t('cal.nextMonth')} onClick={() => onMonth(addMonths(month, 1))} className={arrow} data-testid="month-next">
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-micro text-faint">
        {weekdayNames(first).map((d, i) => (
          <span key={i} className="py-1">
            {d}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7" role="group" aria-label={formatMonth(month)}>
        {grid.map((d) => {
          const other = monthOf(d) !== month;
          const sel = d === value;
          const isToday = d === today;
          return (
            <button
              key={d}
              type="button"
              tabIndex={-1}
              onClick={() => onPick(d)}
              aria-pressed={sel}
              aria-current={isToday ? 'date' : undefined}
              data-day={d}
              className={cx(
                'mx-auto grid size-8 place-items-center rounded-full text-control tabular-nums mobile:size-11',
                sel ? 'bg-accent-strong text-accent-fg' : isToday ? 'font-semibold text-accent-text' : other ? 'text-faint' : 'text-fg',
                !sel && 'hover:bg-hover',
                d === focus && !sel && 'ring-1 ring-accent',
              )}
            >
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>
    </>
  );
}
