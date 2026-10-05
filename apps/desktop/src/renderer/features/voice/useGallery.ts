import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { lastSpoke } from '../../lib/lastSpoke';
import { NO_SLOTS, galleryLayout, galleryPageSize, pageOf, sameGallery, type Gallery, type GallerySlots, type TilePerson } from './tileLayout';

export interface GalleryInput {
  people: readonly TilePerson[];
  pinned: string | null;
  me: string;
  hideSelf: boolean;
  hideNoVideo: boolean;
  size: number;
  page: number;
}

const OFF: GalleryInput = { people: [], pinned: null, me: '', hideSelf: false, hideNoVideo: false, size: 1, page: 0 };

/**
 * The gallery page on screen (tileLayout.ts galleryLayout) with the order carried between
 * layouts, so page 1 and the visible page keep their tiles and a hidden speaker comes forward in
 * place (ADR-0066 §2). `null` input: the speaker view — nothing runs.
 *
 * Rerenders: «last spoke» lives outside the stores (lib/lastSpoke.ts). Each speaking start re-runs
 * the layout here, but the state — and so the grid — changes only when the page's tiles, the page
 * or the page count do. A rate-limited swap re-runs once on a one-shot timer. `pageOf` reads the
 * latest order without re-rendering anyone.
 */
export function useGallery(input: GalleryInput | null): { gallery: Gallery | null; pageOf: (userId: string) => number } {
  const slots = useRef<GallerySlots>(NO_SLOTS);
  const [gallery, setGallery] = useState<Gallery | null>(null);
  const { people, pinned, me, hideSelf, hideNoVideo, size, page } = input ?? OFF;
  const on = input !== null;
  useLayoutEffect(() => {
    // «Спикер»: no gallery; the next gallery starts afresh.
    if (!on) {
      slots.current = NO_SLOTS;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (): void => {
      clearTimeout(timer);
      timer = undefined;
      const now = performance.now();
      const next = galleryLayout(people, { pinned, me, hideSelf, hideNoVideo, size, page, spoke: lastSpoke.snapshot(), prev: slots.current, now });
      slots.current = next.slots;
      if (next.retryAt !== null) timer = setTimeout(run, Math.max(0, next.retryAt - now));
      setGallery((cur) => (cur && sameGallery(cur, next) ? cur : next));
    };
    // Before paint: a new participant / pin / page shows in the same frame.
    run();
    const off = lastSpoke.subscribe(run);
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [on, people, pinned, me, hideSelf, hideNoVideo, size, page]);
  const find = useCallback((userId: string) => pageOf(slots.current, userId), []);
  return { gallery: on ? gallery : null, pageOf: find };
}

const subscribeResize = (fn: () => void): (() => void) => {
  window.addEventListener('resize', fn);
  return () => window.removeEventListener('resize', fn);
};

/**
 * «Слабый компьютер» (docs/09 #44): not built yet; when it is, it sets `data-low-end` on <html>
 * (the flag lib/tilt.ts already reads) and the gallery drops to 9 tiles.
 */
const lowEnd = (): boolean => document.documentElement.dataset['lowEnd'] === 'true';

/** Tiles per gallery page for this window (a primitive: a resize re-renders only when it changes). */
export function useGalleryPageSize(phone: boolean): number {
  return useSyncExternalStore(subscribeResize, () => galleryPageSize(window.innerWidth, window.innerHeight, { phone, weak: lowEnd() }));
}
