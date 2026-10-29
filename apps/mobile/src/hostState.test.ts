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
    expect(failed).toEqual({ generation: 0, phase: 'error', error: 'network', entry: null, entryLoaded: false });
    // Android reports load-finished around the error; neither hides it.
    expect(hostReducer(failed, { type: 'loaded' })).toBe(failed);
    expect(hostReducer(failed, { type: 'loadStart' })).toBe(failed);
    expect(hostReducer(failed, { type: 'retry' })).toEqual({
      generation: 1,
      phase: 'loading',
      error: null,
      entry: null,
      entryLoaded: false,
    });
  });

  it('keeps the error raised after a load-finished event (Android order)', () => {
    expect(run({ type: 'loaded' }, { type: 'failed', error: 'server' })).toMatchObject({ phase: 'error', error: 'server' });
  });

  it('covers a reload of the running app again', () => {
    expect(run({ type: 'loaded' }, { type: 'loadStart' }).phase).toBe('loading');
  });

  it('remounts after the web process dies in a running app', () => {
    expect(run({ type: 'loaded' }, { type: 'processGone' })).toEqual({
      generation: 1,
      phase: 'loading',
      error: null,
      entry: null,
      entryLoaded: false,
    });
  });

  it('stops remounting when the process dies before the app loads', () => {
    expect(run({ type: 'loaded' }, { type: 'processGone' }, { type: 'processGone' })).toEqual({
      generation: 1,
      phase: 'error',
      error: 'crashed',
      entry: null,
      entryLoaded: false,
    });
  });

  it('remounts on an incoming link from any phase, once per announcement while it loads', () => {
    const url = 'https://calab.example.com/t/INV-820';
    const opened = run({ type: 'open', url });
    expect(opened).toEqual({ generation: 1, phase: 'loading', error: null, entry: url, entryLoaded: false });
    expect(hostReducer(opened, { type: 'open', url })).toBe(opened);
    const ready = hostReducer(opened, { type: 'loaded' });
    expect(hostReducer(ready, { type: 'open', url })).toEqual({
      generation: 2,
      phase: 'loading',
      error: null,
      entry: url,
      entryLoaded: false,
    });
    const failed = run({ type: 'failed', error: 'network' }, { type: 'open', url });
    expect(failed).toEqual({ generation: 1, phase: 'loading', error: null, entry: url, entryLoaded: false });
  });

  it('keeps the link across a retry, drops it when a running app crashes', () => {
    const url = 'https://calab.example.com/join/AbC123xYz';
    const failed = run({ type: 'open', url }, { type: 'failed', error: 'server' });
    expect(hostReducer(failed, { type: 'retry' })).toMatchObject({ generation: 2, entry: url });
    expect(run({ type: 'open', url }, { type: 'loaded' }, { type: 'processGone' })).toMatchObject({ generation: 2, entry: null });
  });

  it('drops the link on retry once it already loaded, instead of re-opening it (review follow-up)', () => {
    const url = 'https://calab.example.com/t/INV-820';
    const loadedThenFailed = run({ type: 'open', url }, { type: 'loaded' }, { type: 'failed', error: 'network' });
    expect(hostReducer(loadedThenFailed, { type: 'retry' })).toMatchObject({ generation: 2, entry: null });
  });

  // Regression: #263 made `loaded` clear `entry`, which is also the `source.uri` of the mounted
  // WebView (same `generation`) in App.tsx — react-native-webview reloads on a `uri` change, so
  // the page it had just loaded got replaced by the origin right after loading (DEV-4947).
  it('keeps entry unchanged for the mounted WebView once a link loads', () => {
    const url = 'https://calab.example.com/t/INV-820';
    const loading = run({ type: 'open', url }, { type: 'loadStart' });
    const loaded = hostReducer(loading, { type: 'loaded' });
    expect(loaded).toMatchObject({ generation: 1, phase: 'ready', entry: url });
  });

  it('drops a loaded entry on retry', () => {
    const url = 'https://calab.example.com/t/INV-820';
    const loaded = run({ type: 'open', url }, { type: 'loaded' });
    expect(hostReducer(loaded, { type: 'retry' })).toMatchObject({ generation: 2, entry: null });
  });

  it('keeps a failed, never-loaded entry on retry', () => {
    const url = 'https://calab.example.com/t/INV-820';
    const failed = run({ type: 'open', url }, { type: 'failed', error: 'network' });
    expect(hostReducer(failed, { type: 'retry' })).toMatchObject({ generation: 2, entry: url });
  });

  it('still ignores a duplicate open announcement for the same link while it loads', () => {
    const url = 'https://calab.example.com/t/INV-820';
    const opened = run({ type: 'open', url });
    expect(hostReducer(opened, { type: 'open', url })).toBe(opened);
  });
});
