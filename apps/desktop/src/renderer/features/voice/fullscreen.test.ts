import { describe, expect, it } from 'vitest';
import type { CalabaApi } from '../../../preload/api';
import { FullscreenState, isExitKey, pickFullscreen, windowHost } from './fullscreen';

/** The preload's `window` API over a fake main: setFullScreen answers with the change event. */
function fakeIpc() {
  const calls: boolean[] = [];
  let listener: ((on: boolean) => void) | null = null;
  let full = false;
  const api: CalabaApi['window'] = {
    setFullScreen: (on) => {
      calls.push(on);
      if (on !== full) {
        full = on;
        listener?.(on);
      }
      return Promise.resolve(on);
    },
    isFullScreen: () => Promise.resolve(full),
    isShown: () => Promise.resolve(true),
    onShownChange: () => () => undefined,
    onFullScreenChange: (cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  };
  /** The OS changed it (⌃⌘F, the green button). */
  const os = (on: boolean): void => {
    full = on;
    listener?.(on);
  };
  return { api, calls, os, subscribed: () => listener !== null };
}

const el = {} as HTMLElement;

describe('FullscreenState (docs/09 #18)', () => {
  it('request → layout on, the window goes full screen once the layout is mounted', () => {
    const ipc = fakeIpc();
    const changes: boolean[] = [];
    const fs = new FullscreenState(windowHost(ipc.api), (on) => changes.push(on));
    fs.request();
    expect(fs.active).toBe(true);
    expect(ipc.calls).toEqual([]);
    fs.attach(el);
    expect(ipc.calls).toEqual([true]);
    expect(changes).toEqual([true]);
  });

  it('«Свернуть» / Esc: layout back at once, the window leaves full screen', () => {
    const ipc = fakeIpc();
    const changes: boolean[] = [];
    const fs = new FullscreenState(windowHost(ipc.api), (on) => changes.push(on));
    fs.request();
    fs.attach(el);
    fs.exit();
    expect(fs.active).toBe(false);
    expect(ipc.calls).toEqual([true, false]);
    expect(changes).toEqual([true, false]);
  });

  it('the OS leaving full screen (⌃⌘F, green button) restores the layout', () => {
    const ipc = fakeIpc();
    const fs = new FullscreenState(windowHost(ipc.api), () => undefined);
    fs.request();
    fs.attach(el);
    ipc.os(false);
    expect(fs.active).toBe(false);
    expect(ipc.calls).toEqual([true]); // nothing more to ask main
  });

  it('full screen entered by the OS alone does not switch to the video layout', () => {
    const ipc = fakeIpc();
    const fs = new FullscreenState(windowHost(ipc.api), () => undefined);
    ipc.os(true);
    expect(fs.active).toBe(false);
    fs.exit(); // not ours: leaves the window alone
    expect(ipc.calls).toEqual([]);
  });

  it('re-attaching the container (a re-render) does not ask main again', () => {
    const ipc = fakeIpc();
    const fs = new FullscreenState(windowHost(ipc.api), () => undefined);
    fs.request();
    fs.attach(el);
    fs.attach(null);
    fs.attach(el);
    expect(ipc.calls).toEqual([true]);
  });

  it('toggle, repeated exit and dispose', () => {
    const ipc = fakeIpc();
    const fs = new FullscreenState(windowHost(ipc.api), () => undefined);
    fs.attach(el);
    fs.toggle();
    expect(fs.active).toBe(true);
    fs.toggle();
    fs.exit();
    expect(ipc.calls).toEqual([true, false]);
    fs.request();
    fs.dispose();
    expect(fs.active).toBe(false);
    expect(ipc.subscribed()).toBe(false);
  });
});

describe('isExitKey', () => {
  const k = (key: string, code: string, ctrlKey = false, metaKey = false) => ({ key, code, ctrlKey, metaKey });
  it('Esc and ⌃⌘F leave full screen; plain F or ⌘F do not', () => {
    expect(isExitKey(k('Escape', 'Escape'))).toBe(true);
    expect(isExitKey(k('f', 'KeyF', true, true))).toBe(true);
    expect(isExitKey(k('f', 'KeyF'))).toBe(false);
    expect(isExitKey(k('f', 'KeyF', false, true))).toBe(false);
  });
});

describe('pickFullscreen (iPhone has no requestFullscreen on elements)', () => {
  const video = { webkitEnterFullscreen: () => undefined };
  it('uses the Fullscreen API where the element has it', () => {
    const el = { requestFullscreen: () => Promise.resolve(), querySelector: () => video } as never;
    expect(pickFullscreen(el)).toEqual({ kind: 'element' });
  });
  it('falls back to the native player of the inner video', () => {
    const el = { querySelector: () => video } as never;
    expect(pickFullscreen(el)).toEqual({ kind: 'video', video });
  });
  it('is null when neither exists', () => {
    expect(pickFullscreen({ querySelector: () => null } as never)).toBeNull();
    expect(pickFullscreen({ querySelector: () => ({}) } as never)).toBeNull();
  });
});
