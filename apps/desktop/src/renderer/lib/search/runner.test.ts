import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchCache } from './cache';
import { debouncedSearch } from './runner';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const cache = new SearchCache<string>();
  const done: Array<[string, string]> = [];
  const errors: string[] = [];
  const signals: AbortSignal[] = [];
  const calls: string[] = [];
  const pending = new Map<string, (v: string) => void>();
  const start = (key: string): (() => void) =>
    debouncedSearch({
      key,
      cache,
      run: (signal) => {
        calls.push(key);
        signals.push(signal);
        return new Promise<string>((resolve) => pending.set(key, resolve));
      },
      onDone: (k, v) => done.push([k, v]),
      onError: (k) => errors.push(k),
    });
  return { cache, done, errors, signals, calls, pending, start };
}

describe('debouncedSearch', () => {
  it('waits 200 ms; typing on cancels the previous timer — one request for the last query', () => {
    const s = setup();
    let stop = s.start('r');
    vi.advanceTimersByTime(150);
    stop();
    stop = s.start('re');
    vi.advanceTimersByTime(150);
    stop();
    s.start('rel');
    vi.advanceTimersByTime(199);
    expect(s.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(s.calls).toEqual(['rel']);
  });

  it('aborts the request in flight when the query changes; its late answer is dropped', async () => {
    const s = setup();
    const stop = s.start('a');
    vi.advanceTimersByTime(200);
    expect(s.calls).toEqual(['a']);
    stop();
    expect(s.signals[0]?.aborted).toBe(true);
    s.start('ab');
    vi.advanceTimersByTime(200);
    s.pending.get('a')?.('late');
    s.pending.get('ab')?.('fresh');
    await vi.runAllTimersAsync();
    expect(s.done).toEqual([['ab', 'fresh']]);
    expect(s.cache.get('a')).toBeUndefined();
    expect(s.cache.get('ab')).toBe('fresh');
  });

  it('answers a cached query without a request', async () => {
    const s = setup();
    s.cache.set('q', 'cached');
    s.start('q');
    await vi.runAllTimersAsync();
    expect(s.calls).toEqual([]);
    expect(s.done).toEqual([['q', 'cached']]);
  });

  it('reports errors of the current request only', async () => {
    const s = setup();
    const cache = new SearchCache<string>();
    const errors: string[] = [];
    debouncedSearch({ key: 'x', cache, run: () => Promise.reject(new Error('422')), onDone: () => undefined, onError: (k) => errors.push(k) });
    const stop = debouncedSearch({ key: 'y', cache, run: () => Promise.reject(new Error('429')), onDone: () => undefined, onError: (k) => errors.push(k) });
    vi.advanceTimersByTime(200);
    stop();
    await vi.runAllTimersAsync();
    expect(errors).toEqual(['x']);
    expect(s.errors).toEqual([]);
  });
});
