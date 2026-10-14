import type { SearchCache } from './cache';

/**
 * One debounced search request (ADR-0062 §4: 200 ms, the previous one aborted). Call it from an
 * effect keyed by the request; the returned cleanup cancels the timer and aborts the request in
 * flight, so a newer key always wins and a stale answer never lands. A fresh cached answer is
 * delivered on the next microtask without a request.
 */
export interface DebouncedSearch<V> {
  key: string;
  run: (signal: AbortSignal) => Promise<V>;
  cache: SearchCache<V>;
  onDone: (key: string, value: V) => void;
  onError: (key: string, error: unknown) => void;
  delayMs?: number;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };
}

export const SEARCH_DEBOUNCE_MS = 200;

const realTimers = {
  set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clear: (id: unknown): void => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export function debouncedSearch<V>(o: DebouncedSearch<V>): () => void {
  const ctl = new AbortController();
  const timers = o.timers ?? realTimers;
  const cached = o.cache.get(o.key);
  if (cached !== undefined) {
    void Promise.resolve().then(() => {
      if (!ctl.signal.aborted) o.onDone(o.key, cached);
    });
    return () => ctl.abort();
  }
  const id = timers.set(() => {
    o.run(ctl.signal).then(
      (v) => {
        if (ctl.signal.aborted) return;
        o.cache.set(o.key, v);
        o.onDone(o.key, v);
      },
      (e: unknown) => {
        if (!ctl.signal.aborted) o.onError(o.key, e);
      },
    );
  }, o.delayMs ?? SEARCH_DEBOUNCE_MS);
  return () => {
    timers.clear(id);
    ctl.abort();
  };
}
