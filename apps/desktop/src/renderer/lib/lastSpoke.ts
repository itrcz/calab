/**
 * «Last spoke at» per participant of my call (ADR-0066 §2): the time (`performance.now()`) each
 * one last *started* speaking. The call grid uses it to promote a hidden speaker from «Ещё N».
 *
 * Deliberately outside the voice store: it changes on every speaking start, and nothing should
 * re-render for that. The grid listens here and re-renders only when its visible set changes
 * (features/voice/useTileSelection.ts). Updated on speaking *starts* only, never per level tick.
 */

const spoke = new Map<string, number>();
const listeners = new Set<() => void>();

/** Ids that are speaking in `next` but were not in `prev` (the debounced speaking maps). */
export function speakingStarts(prev: Readonly<Record<string, boolean>>, next: Readonly<Record<string, boolean>>): string[] {
  const out: string[] = [];
  for (const [id, on] of Object.entries(next)) if (on && !prev[id]) out.push(id);
  return out;
}

export const lastSpoke = {
  /** The current map (live — read it, don't keep it). */
  snapshot(): ReadonlyMap<string, number> {
    return spoke;
  },
  get(userId: string): number {
    return spoke.get(userId) ?? 0;
  },
  /** `ids` started speaking at `at`; listeners run once per call. */
  mark(ids: readonly string[], at: number): void {
    if (ids.length === 0) return;
    for (const id of ids) spoke.set(id, at);
    for (const fn of listeners) fn();
  },
  /** The call ended (or a new one starts). */
  clear(): void {
    if (spoke.size === 0) return;
    spoke.clear();
    for (const fn of listeners) fn();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
