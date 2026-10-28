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
    expect(failed).toEqual({ generation: 0, phase: 'error', error: 'network', entry: null });
    // Android reports load-finished around the error; neither hides it.
    expect(hostReducer(failed, { type: 'loaded' })).toBe(failed);
    expect(hostReducer(failed, { type: 'loadStart' })).toBe(failed);
    expect(hostReducer(failed, { type: 'retry' })).toEqual({ generation: 1, phase: 'loading', error: null, entry: null });
  });

  it('keeps the error raised after a load-finished event (Android order)', () => {
    expect(run({ type: 'loaded' }, { type: 'failed', error: 'server' })).toMatchObject({ phase: 'error', error: 'server' });
  });

  it('covers a reload of the running app again', () => {
    expect(run({ type: 'loaded' }, { type: 'loadStart' }).phase).toBe('loading');
  });

  it('remounts after the web process dies in a running app', () => {
    expect(run({ type: 'loaded' }, { type: 'processGone' })).toEqual({ generation: 1, phase: 'loading', error: null, entry: null });
  });

  it('stops remounting when the process dies before the app loads', () => {
    expect(run({ type: 'loaded' }, { type: 'processGone' }, { type: 'processGone' })).toEqual({
      generation: 1,
      phase: 'error',
      error: 'crashed',
      entry: null,
    });
  });

  it('remounts on an incoming link from any phase, once per announcement while it loads', () => {
    const url = 'https://calab.example.com/t/INV-820';
    const opened = run({ type: 'open', url });
    expect(opened).toEqual({ generation: 1, phase: 'loading', error: null, entry: url });
    expect(hostReducer(opened, { type: 'open', url })).toBe(opened);
    const ready = hostReducer(opened, { type: 'loaded' });
    expect(hostReducer(ready, { type: 'open', url })).toEqual({ generation: 2, phase: 'loading', error: null, entry: url });
    const failed = run({ type: 'failed', error: 'network' }, { type: 'open', url });
    expect(failed).toEqual({ generation: 1, phase: 'loading', error: null, entry: url });
  });

  it('keeps the link across a retry, drops it when a running app crashes', () => {
    const url = 'https://calab.example.com/join/AbC123xYz';
    const failed = run({ type: 'open', url }, { type: 'failed', error: 'server' });
    expect(hostReducer(failed, { type: 'retry' })).toMatchObject({ generation: 2, entry: url });
    expect(run({ type: 'open', url }, { type: 'loaded' }, { type: 'processGone' })).toMatchObject({ generation: 2, entry: null });
  });
});
