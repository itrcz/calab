import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { BarContext, cx } from './ui';

/**
 * The header bar (docs/08 «Шапки», owner 07.10): one 48 px row; on the phone 12 px side gutters and
 * 8 px gaps, every control in it 36 px high (the CreateButton's disc) with a 44 px target
 * (`bar-hit`, styles.css), so the targets touch but never overlap. IconButtons inside take the
 * `bar` plate (a rounded square, `--radius-bar`) through the context. `data-bar` is what the
 * phone safety net in styles.css and the e2e invariant (mobile.visual.spec.ts) look for.
 */
export const BAR = 'flex h-12 shrink-0 items-center border-b border-line mobile:gap-2 mobile:px-3';
/** A group of icon controls at the end of a bar. */
export const BAR_GROUP = 'flex shrink-0 items-center gap-0.5 mobile:gap-2';

type BarProps = HTMLAttributes<HTMLElement> & { ref?: Ref<HTMLElement>; children?: ReactNode; plain?: boolean };

/** `plain`: no toolbar material (the board header sits on the content). */
export function Bar({ className, children, ref, plain, ...rest }: BarProps): ReactNode {
  return (
    <BarContext.Provider value>
      <header ref={ref} data-bar className={cx(BAR, !plain && 'mat-toolbar', className)} {...rest}>
        {children}
      </header>
    </BarContext.Provider>
  );
}

/** A second toolbar row under a bar (the board's view switch and display menu): the same standard, no border. */
export function BarRow({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <BarContext.Provider value>
      <div data-bar className={cx('flex h-12 shrink-0 items-center mobile:gap-2 mobile:px-3', className)} {...rest}>
        {children}
      </div>
    </BarContext.Provider>
  );
}
