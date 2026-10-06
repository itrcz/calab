import { Plus } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Tip, cx } from './ui';

/**
 * The section's «+» (docs/08, owner 07.10): one accent circle at the right end of a section header —
 * Чаты, Личные, Доски, Календарь, on the desktop column and on the phone tab root. Always the same
 * look and place; what it opens (a menu, a dialog) is the caller's. Desktop: 28 px disc in a 32 px
 * hit; phone: 36 px disc in a 44 px hit. `ref` + rest props land on the button, so it works as a
 * Radix `asChild` trigger.
 */
export function CreateButton({
  label,
  tip = true,
  className,
  ref,
  ...rest
}: { label: string; tip?: boolean; ref?: Ref<HTMLButtonElement> } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>): ReactNode {
  const btn = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={cx('group/create inline-grid size-8 shrink-0 place-items-center rounded-full mobile:tap-size', className)}
      {...rest}
    >
      <span className="grid size-7 place-items-center rounded-full bg-accent-strong text-accent-fg transition-[filter] duration-[var(--motion-fast)] group-hover/create:brightness-110 group-data-[state=open]/create:brightness-110 mobile:size-9">
        <Plus className="size-4 mobile:size-5" strokeWidth={2.25} aria-hidden />
      </span>
    </button>
  );
  return tip ? <Tip label={label}>{btn}</Tip> : btn;
}

/**
 * A «+» that adds a sub-item in place (a room into a category, a shelf, a task column): quiet, grey,
 * no disc — it never competes with the section's CreateButton. Hit 44 px on the phone.
 */
export function InlineAdd({ label, className, ref, ...rest }: { label: string; ref?: Ref<HTMLButtonElement> } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>): ReactNode {
  return (
    <Tip label={label}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cx(
          'grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg mobile:tap-size',
          className,
        )}
        {...rest}
      >
        <Plus className="size-4" strokeWidth={1.75} aria-hidden />
      </button>
    </Tip>
  );
}
