import { ShieldOff } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import type { AccessLevel } from '../../lib/permissions';

/*
 * «Кто видит» of a room / board as three levels (ADR-0048 §2, docs/08 «Доступ»): Все участники ·
 * По списку · По списку, без администраторов — radio rows with a one-line hint each (the third
 * says what it costs: admins lose the section, the owner never does).
 */

const OPTIONS: ReadonlyArray<{ v: AccessLevel; label: MessageKey; hint: MessageKey }> = [
  { v: 'all', label: 'access.all', hint: 'access.allHint' },
  { v: 'list', label: 'access.list', hint: 'access.listHint' },
  { v: 'restricted', label: 'access.restricted', hint: 'access.restrictedHint' },
];

export function AccessLevelPicker({
  value,
  onChange,
  disabled,
  allLocked,
  temp = false,
}: {
  value: AccessLevel;
  onChange: (v: AccessLevel) => void;
  disabled: boolean;
  /** «Все участники» cannot be chosen (a permanent room stays private): the reason instead of its hint. */
  allLocked?: MessageKey | undefined;
  /**
   * A temporary room (ADR-0078): «По списку» already hides it from admins and the owner, so its
   * hint says so and the third level is offered only to leave it.
   */
  temp?: boolean | undefined;
}): ReactNode {
  const options = temp
    ? OPTIONS.filter((o) => o.v !== 'restricted' || value === 'restricted').map((o) =>
        o.v === 'list' ? { ...o, hint: 'temp.visSelectedHint' as const } : o,
      )
    : OPTIONS;
  return (
    <div role="radiogroup" aria-label={t('access.level')} className="flex flex-col" data-testid="access-level">
      {options.map((o) => {
        const reason = o.v === 'all' && value !== 'all' ? allLocked : undefined;
        const locked = reason !== undefined;
        const on = value === o.v;
        return (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled || locked}
            onClick={() => !on && onChange(o.v)}
            data-testid={`access-level-${o.v}`}
            className="flex min-h-11 items-center gap-3 px-3 py-2 text-left enabled:hover:bg-hover disabled:cursor-default"
          >
            <span className={cx('flex min-w-0 flex-1 flex-col', locked && 'opacity-60')}>
              <span className="flex items-center gap-1.5 text-body">
                {t(o.label)}
                {o.v === 'restricted' ? <ShieldOff className="size-3.5 shrink-0 text-muted" aria-hidden /> : null}
              </span>
              <span className="text-caption text-faint">{t(reason ?? o.hint)}</span>
            </span>
            <span
              className={cx('grid size-4 shrink-0 place-items-center rounded-full border', on ? 'border-accent bg-accent' : 'border-[var(--color-fill-hover)]')}
              aria-hidden
            >
              {on ? <span className="size-1.5 rounded-full bg-white" /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The small «closed to admins» mark after a room / board name in the lists, with its tooltip. */
export const RestrictedMark = memo(function RestrictedMark({ className }: { className?: string }): ReactNode {
  return (
    <Tip label={t('access.badge')}>
      <span role="img" aria-label={t('access.badge')} className={cx('grid shrink-0 place-items-center text-faint', className)} data-testid="restricted-mark">
        <ShieldOff className="size-3.5" aria-hidden />
      </span>
    </Tip>
  );
});
