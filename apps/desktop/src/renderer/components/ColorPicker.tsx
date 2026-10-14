import * as Popover from '@radix-ui/react-popover';
import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './ui';

/**
 * A grid of choices in a popover (ADR-0093): colour swatches, status icons. Radix Popover through
 * a portal (`mat-popover`, as PickerPopover), so a row below never covers it and a scrolling card
 * never clips it; on a phone the shared menu runtime (lib/phoneMenus.ts) centres it as a card.
 * Keyboard: the chosen cell takes the focus on open, arrows move by cell / row, Enter or Space
 * picks (a native button), Esc closes and returns the focus to the trigger.
 */
export function GridPicker<T extends string | number>({
  items,
  value,
  cols = 6,
  cell,
  label,
  itemLabel,
  renderItem,
  onPick,
  trigger,
  footer,
  testId,
}: {
  items: readonly T[];
  /** The chosen item (ringed); undefined = none of the grid. */
  value: T | undefined;
  cols?: number;
  /** Cell side in px. */
  cell: number;
  /** The popover's accessible name. */
  label: string;
  itemLabel: (item: T) => string;
  renderItem: (item: T, chosen: boolean) => ReactNode;
  onPick: (item: T) => void;
  /** The trigger button (Radix `asChild`). */
  trigger: ReactNode;
  /** Below the grid (e.g. «По типу»); `close` closes the popover. */
  footer?: (close: () => void) => ReactNode;
  testId?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
      if (!step || !grid.current) return;
      const cells = Array.from(grid.current.querySelectorAll<HTMLButtonElement>('[data-grid-cell]'));
      const at = cells.indexOf(document.activeElement as HTMLButtonElement);
      e.preventDefault();
      const next = at < 0 ? 0 : Math.min(cells.length - 1, Math.max(0, at + step));
      cells[next]?.focus();
    },
    [cols],
  );
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          aria-label={label}
          data-testid={testId}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const g = grid.current;
            (g?.querySelector<HTMLButtonElement>('[data-grid-cell][aria-checked="true"]') ?? g?.querySelector<HTMLButtonElement>('[data-grid-cell]'))?.focus();
          }}
          className="mat-popover anim-in z-[var(--z-modal-popover)] rounded-[var(--radius-card)] p-3"
        >
          <div ref={grid} role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="grid justify-center gap-2" style={{ gridTemplateColumns: `repeat(${cols}, ${cell}px)` }}>
            {items.map((it) => {
              const chosen = it === value;
              return (
                <button
                  key={it}
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  aria-label={itemLabel(it)}
                  title={itemLabel(it)}
                  tabIndex={chosen || (value === undefined && it === items[0]) ? 0 : -1}
                  data-grid-cell
                  onClick={() => {
                    setOpen(false);
                    onPick(it);
                  }}
                  className={cx(
                    'grid place-items-center rounded-full outline-none ring-offset-2 ring-offset-[var(--color-popover)] focus-visible:ring-2 focus-visible:ring-accent',
                    chosen && 'ring-2 ring-fg',
                  )}
                  style={{ width: cell, height: cell }}
                >
                  {renderItem(it, chosen)}
                </button>
              );
            })}
          </div>
          {footer ? footer(close) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The colour of a status / label (ADR-0093): a dot that opens a grid of the palette — swatches
 * 28 px with a gap of 8, six in a row, the chosen one ringed, each named for screen readers.
 */
export function ColorPicker({
  value,
  palette,
  onPick,
  label,
  colorName,
  colorCss,
  testId,
}: {
  value: number;
  palette: readonly number[];
  onPick: (color: number) => void;
  /** The trigger's and the popover's name («Цвет»). */
  label: string;
  colorName: (color: number) => string;
  colorCss: (color: number) => string;
  testId?: string;
}): ReactNode {
  return (
    <GridPicker
      items={palette}
      value={palette.includes(value) ? value : undefined}
      cell={28}
      label={label}
      itemLabel={colorName}
      renderItem={(c) => <span className="size-7 rounded-full" style={{ background: colorCss(c) }} aria-hidden />}
      onPick={(c) => c !== value && onPick(c)}
      testId={testId}
      trigger={
        <button type="button" aria-label={`${label}: ${colorName(value)}`} className="grid size-6 shrink-0 place-items-center rounded-full hover:bg-hover data-[state=open]:bg-active">
          <span className="size-3 rounded-full" style={{ background: colorCss(value) }} aria-hidden />
        </button>
      }
    />
  );
}
