/**
 * Pure logic behind «the feed stays at the bottom» (docs/09 #149 and its follow-up): while the
 * reader sits at the bottom of the feed, any change of the feed's geometry that is not their own
 * scroll — the last row growing (a reaction pill, an upload turning into its preview, an image or
 * link preview loading, an edit), the scroller shrinking (the composer growing to several lines or
 * gaining attachment chips) — re-anchors the scroll to the true bottom.
 *
 * Why not Virtuoso's atBottom: it is recomputed *from* the grown geometry, so a growth taller than
 * its threshold (an image) flips it to false before we can react, and Virtuoso itself only follows
 * size increases for 100 ms after a new item. «Stuck» here is decided by the reader's scrolling
 * alone: reaching the bottom sticks, moving up unsticks, content changes never unstick.
 *
 * Stateless about the DOM (like hoverIntent.ts): the caller feeds geometry from scroll events and
 * ResizeObserver callbacks and does the actual scrolling. No timers, no frame loops.
 */
export interface FeedGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface BottomPin {
  /** A scroll event (the reader's, or ours/Virtuoso's programmatic one). */
  scrolled(g: FeedGeometry): void;
  /** A ResizeObserver report (the scroller or its content). Returns whether the caller should
   * set scrollTop to the bottom now. */
  resized(g: FeedGeometry): boolean;
  /** False while newer history is not loaded (hasMoreAfter): the bottom is not the present, and
   * pinning there would keep triggering endReached. */
  setLive(live: boolean): void;
}

/** Distance from the bottom (px) still counted as «at the bottom» — sub-pixel zoom rounding and a
 * nudge of the wheel; deliberately far below Virtuoso's 48 px «show the to-bottom button». */
export const STICK_PX = 8;

const distance = (g: FeedGeometry): number => g.scrollHeight - g.clientHeight - g.scrollTop;

export function createBottomPin(): BottomPin {
  let stuck = false;
  let live = true;
  let lastTop = 0;
  return {
    scrolled(g) {
      if (distance(g) <= STICK_PX) stuck = true;
      // Only an upward move unsticks: a smooth scroll *down* that hasn't arrived yet keeps the pin.
      else if (g.scrollTop < lastTop) stuck = false;
      lastTop = g.scrollTop;
    },
    resized(g) {
      const d = distance(g);
      if (stuck && live && d > 0.5) return true;
      // Not pinning: the geometry itself says where we are (e.g. content shrank under the reader).
      stuck = d <= STICK_PX;
      lastTop = g.scrollTop;
      return false;
    },
    setLive(v) {
      live = v;
    },
  };
}
