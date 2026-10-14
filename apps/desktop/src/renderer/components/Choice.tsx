import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMobile } from '../lib/mobile';
import { menuBox, menuItem, menuLabel } from '../features/shell/menu';
import { Segmented, cx } from './ui';

/** On a phone more options than this no longer fit a 390 px row as segments (docs/08 «Choice»). */
export const PHONE_SEGMENTS_MAX = 3;

/**
 * Whether a phone shows the picker button instead of segments: `phone` forces either form,
 * `auto` (default) switches to the picker when there are more than three options.
 */
export function phonePicker(phone: 'auto' | 'picker' | 'segmented', optionCount: number): boolean {
  if (phone === 'picker') return true;
  if (phone === 'segmented') return false;
  return optionCount > PHONE_SEGMENTS_MAX;
}

/**
 * A choice of one value. Same API as `Segmented`, which it renders on desktop. On a phone it can
 * be a pill button `[current ▾]` that opens the options as a radio menu (phoneMenus.ts shows
 * every Radix menu there as a centred card, ADR-0073 §8): segments that scroll sideways or
 * squeeze into 390 px are hard to hit.
 */
export function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
  fill = false,
  testId,
  phone = 'auto',
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
  fill?: boolean;
  testId?: string;
  phone?: 'auto' | 'picker' | 'segmented';
}): ReactNode {
  const mobile = useMobile();
  if (!mobile || !phonePicker(phone, options.length)) {
    return <Segmented value={value} options={options} onChange={onChange} label={label} fill={fill} testId={testId} />;
  }
  const current = options.find((o) => o.value === value);
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid={testId}
          className={cx(
            'tap-hit inline-flex h-9 min-w-0 shrink-0 items-center gap-1.5 rounded-full bg-hover px-3 text-control font-medium text-fg data-[state=open]:bg-active',
            fill && 'w-full justify-between',
          )}
        >
          <span className="min-w-0 truncate">{current ? current.label : ''}</span>
          <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'w-60')} sideOffset={4} align="start" collisionPadding={16}>
          <Dropdown.Label className={menuLabel}>{label}</Dropdown.Label>
          <Dropdown.RadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
            {options.map((o) => (
              <Dropdown.RadioItem key={o.value} value={o.value} className={menuItem} data-testid={testId ? `${testId}-${o.value}` : undefined}>
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.value === value ? <Check className="size-4 shrink-0" aria-hidden /> : null}
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
