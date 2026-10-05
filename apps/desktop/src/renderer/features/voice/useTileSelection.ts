import { useLayoutEffect, useRef, useState } from 'react';
import { lastSpoke } from '../../lib/lastSpoke';
import { NO_SLOTS, sameSelection, selectTiles, type TilePerson, type TileSelection, type TileSlots } from './tileLayout';

/**
 * The call grid's tiles (tileLayout.ts selectTiles) with the visible set carried between
 * selections, so a hidden speaker comes forward in place (ADR-0066 §2).
 *
 * Rerenders: «last spoke» lives outside the stores (lib/lastSpoke.ts). Each speaking start
 * re-runs the selection here, but the state — and so the grid — changes only when the tiles, the
 * large tile or the hidden list do. A rate-limited swap re-runs once on a one-shot timer.
 */
export function useTileSelection(people: readonly TilePerson[], focused: string | null, active: string | null, me: string): TileSelection | null {
  const slots = useRef<TileSlots>(NO_SLOTS);
  const [sel, setSel] = useState<TileSelection | null>(null);
  useLayoutEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (): void => {
      clearTimeout(timer);
      timer = undefined;
      const now = performance.now();
      const next = selectTiles(people, { focused, active, me, spoke: lastSpoke.snapshot(), prev: slots.current, now });
      slots.current = next.slots;
      if (next.retryAt !== null) timer = setTimeout(run, Math.max(0, next.retryAt - now));
      setSel((cur) => (cur && sameSelection(cur, next) ? cur : next));
    };
    // Before paint: a new participant / pin shows in the same frame.
    run();
    const off = lastSpoke.subscribe(run);
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [people, focused, active, me]);
  return sel;
}
