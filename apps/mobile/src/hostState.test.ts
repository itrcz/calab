import { describe, expect, it } from 'vitest';
import { type HostEvent, type HostState, hostReducer, initialHostState } from './hostState';

const run = (...events: HostEvent[]): HostState => events.reduce(hostReducer, initialHostState);

describe('hostReducer', () => {
  it('covers the WebView until the app document loads', () => {
    expect(run().phase).toBe('loading');
    expect(run({ type: 'loadStart' }, { type: 'loaded' }).phase).toBe('ready');
  });

  it('shows a main-frame failure until the user retries, then remounts the WebView', () => {
    const failed = run({ type: 'loadStart' }, { type: 'failed', error: 'network' });
    expect(failed).toEqual({ generation: 0, phase: 'error', error: 'network' });
    // Android reports load-finished around the error; neither hides it.
    expect(hostReducer(failed, { type: 'loaded' })).toBe(failed);
    expect(hostReducer(failed, { type: 'loadStart' })).toBe(failed);
    expect(hostReducer(failed, { type: 'retry' })).toEqual({ generation: 1, phase: 'loading', error: null });
  });

  it('keeps the error raised after a load-finished event (Android order)', () => {
    expect(run({ type: 'loaded' }, { type: 'failed', error: 'server' })).toMatchObject({ phase: 'error', error: 'server' });
  });

  it('covers a reload of the running app again', () => {
    expect(run({ type: 'loaded' }, { type: 'loadStart' }).phase).toBe('loading');
  });

  it('remounts after the web process dies in a running app', () => {
    expect(run({ type: 'loaded' }, { type: 'processGone' })).toEqual({ generation: 1, phase: 'loading', error: null });
  });

  it('stops remounting when the process dies before the app loads', () => {
    expect(run({ type: 'loaded' }, { type: 'processGone' }, { type: 'processGone' })).toEqual({
      generation: 1,
      phase: 'error',
      error: 'crashed',
    });
  });
});
