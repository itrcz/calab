import { BillingState, Plan, type Money } from '@calaba/protocol';
import { memo, useEffect, useState, type ReactNode } from 'react';
import { cx } from '../../../components/ui';
import { plural, t, type MessageKey } from '../../../i18n';
import { countdownPeriod, timeLeft } from '../../../lib/billing/model';
import { formatMoney, minorOf, type MoneyFormatOptions } from '../../../lib/billing/money';
import { fmt } from '../../../lib/format';

/**
 * Small pieces of the billing cabinet (ADR-0080 §13, docs/08 «Тариф»). The countdown is a leaf with
 * its own timer (CLAUDE.md «Ререндеры»): the card around it never re-renders on a tick; the timer
 * stops while the window is hidden (docs/14) and ticks once a minute (each 10 minutes beyond a day).
 */

/** An amount: tabular digits; a negative balance in the danger text colour. */
export const MoneyText = memo(function MoneyText({ m, danger, className, ...o }: { m: Money | undefined; danger?: boolean; className?: string } & MoneyFormatOptions): ReactNode {
  return <span className={cx('tabular-nums', (danger ?? minorOf(m) < 0n) && 'text-danger-text', className)}>{formatMoney(m, o)}</span>;
});

/** «3 д 5 ч» / «4 ч 12 мин» / «12 мин» (≤ 2 units). */
export function leftText(deadlineMs: number, nowMs: number): string {
  const l = timeLeft(deadlineMs, nowMs);
  if (l.ms <= 0) return t('billing.left.passed');
  if (l.days > 0) return t('billing.left.dh', { d: l.days, h: l.hours });
  if (l.hours > 0) return t('billing.left.hm', { h: l.hours, m: l.minutes });
  return t('billing.left.m', { m: Math.max(1, l.minutes) });
}

function visibleNow(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * «осталось 3 д 5 ч» until a deadline. Own state + one timeout per period, paused while hidden; a
 * deadline in the past renders the «passed» text and stops.
 */
export const Countdown = memo(function Countdown({ at, className, testId }: { at: number; className?: string; testId?: string }): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer = 0;
    const schedule = (): void => {
      window.clearTimeout(timer);
      const n = Date.now();
      const l = timeLeft(at, n);
      if (l.ms <= 0 || !visibleNow()) return;
      // Wake when the remaining time crosses the next multiple of the period (what is shown changes).
      const period = countdownPeriod(l);
      timer = window.setTimeout(
        () => {
          setNow(Date.now());
          schedule();
        },
        Math.max(1_000, ((at - n) % period) + 50),
      );
    };
    const onVisibility = (): void => {
      if (visibleNow()) {
        setNow(Date.now());
        schedule();
      } else window.clearTimeout(timer);
    };
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [at]);
  return (
    <span className={cx('tabular-nums', className)} data-testid={testId} title={fmt.dateTime(new Date(at), 'long')}>
      {leftText(at, now)}
    </span>
  );
});

/** «Баланс закончится примерно через N дней»-style forecast text. */
export function forecastText(days: number): string {
  return plural('billing.forecast.days', days);
}

const STATE_KEY: Record<BillingState, MessageKey | null> = {
  [BillingState.UNSPECIFIED]: null,
  [BillingState.INACTIVE]: 'billing.state.inactive',
  [BillingState.ACTIVE]: 'billing.state.active',
  [BillingState.IN_ARREARS]: 'billing.state.arrears',
  [BillingState.STOPPED]: 'billing.state.stopped',
  [BillingState.SUSPENDED]: 'billing.state.suspended',
  [BillingState.LAPSED]: 'billing.state.lapsed',
};

/** The billing state as a pill: active green, arrears amber, suspended red, others neutral. */
export function StatePill({ state }: { state: BillingState }): ReactNode {
  const key = STATE_KEY[state];
  if (!key) return null;
  return (
    <span
      data-billing-state={BillingState[state]}
      className={cx(
        'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-caption font-semibold',
        state === BillingState.ACTIVE
          ? 'bg-ok-fill text-white'
          : state === BillingState.SUSPENDED
            ? 'bg-danger-fill text-white'
            : state === BillingState.IN_ARREARS || state === BillingState.LAPSED
              ? 'bg-warn-surface text-fg ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-warn)_45%,transparent)]'
              : 'bg-[var(--color-fill-hover)] text-fg',
      )}
    >
      {t(key)}
    </span>
  );
}

export const PLAN_NAME: Record<Plan.TEAM | Plan.ENTERPRISE, MessageKey> = {
  [Plan.TEAM]: 'plan.name.team',
  [Plan.ENTERPRISE]: 'plan.name.enterprise',
};

/** A label / value line inside a dialog summary (quote, preview). */
export function SumLine({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }): ReactNode {
  return (
    <div className={cx('flex items-baseline justify-between gap-4 py-1.5 text-body', strong && 'border-t border-line pt-2 font-semibold')}>
      <span className={strong ? 'text-fg' : 'text-muted'}>{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  );
}

/** A short note with an icon inside a card (warnings, explanations). */
export function Note({ icon, children, tone = 'muted', testId }: { icon?: ReactNode; children: ReactNode; tone?: 'muted' | 'warn' | 'danger'; testId?: string }): ReactNode {
  return (
    <p role="note" data-testid={testId} className={cx('flex items-start gap-2 px-3 py-2 text-body', tone === 'danger' ? 'text-danger-text' : tone === 'warn' ? 'text-fg' : 'text-muted')}>
      {icon}
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}
