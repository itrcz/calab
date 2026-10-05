import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { CalabaApi } from '../../../preload/api';

/**
 * «На весь экран» for a stream (docs/09 #18). The stage switches to a video-only layout with a
 * thin overlay while the host goes full screen:
 * - desktop: the window itself (`window:setFullScreen` → BrowserWindow.setFullScreen, macOS: its
 *   own Space); main restores the bounds when it leaves;
 * - web: the Fullscreen API on the video container.
 * However full screen ends — our «Свернуть», Esc, ⌃⌘F, the green button, the browser's Esc — the
 * host reports it and the layout goes back.
 */
export interface FullscreenHost {
  /** Go full screen; `el` is the video container (the web host puts that element in full screen). */
  enter(el: HTMLElement): Promise<unknown>;
  exit(): Promise<unknown>;
  /** Host-side changes (true = entered, false = left), whoever caused them. */
  subscribe(cb: (on: boolean) => void): () => void;
}

/** A window's own full screen over the preload bridge (the main window or a stream pop-out). */
export function windowHost(api: CalabaApi['window']): FullscreenHost {
  return {
    enter: () => api.setFullScreen(true),
    exit: () => api.setFullScreen(false),
    subscribe: (cb) => api.onFullScreenChange(cb),
  };
}

/** iOS Safari: only a <video> can go full screen (its native player); other elements lack requestFullscreen. */
interface IosVideo extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
}

/**
 * How `el` goes full screen: the Fullscreen API on the element, else (iPhone) the native player
 * of the <video> inside it, else not at all. Pure — unit-tested.
 */
export function pickFullscreen(el: Pick<HTMLElement, 'requestFullscreen' | 'querySelector'>): { kind: 'element' } | { kind: 'video'; video: IosVideo } | null {
  if (typeof el.requestFullscreen === 'function') return { kind: 'element' };
  const video = el.querySelector<IosVideo>('video');
  if (video && typeof video.webkitEnterFullscreen === 'function') return { kind: 'video', video };
  return null;
}

/** The Fullscreen API of `doc` (web; a pop-out without the bridge), with iPhone's video-only fallback. */
export function domHost(doc: Document): FullscreenHost {
  let nativeVideo: IosVideo | null = null;
  return {
    enter: (el) => {
      const pick = pickFullscreen(el);
      if (pick?.kind === 'video') {
        nativeVideo = pick.video;
        try {
          pick.video.webkitEnterFullscreen?.();
        } catch {
          nativeVideo = null;
        }
        return Promise.resolve();
      }
      return pick ? el.requestFullscreen().catch(() => undefined) : Promise.resolve();
    },
    exit: () => {
      const v = nativeVideo;
      nativeVideo = null;
      if (v?.webkitDisplayingFullscreen) v.webkitExitFullscreen?.();
      return doc.fullscreenElement ? doc.exitFullscreen().catch(() => undefined) : Promise.resolve();
    },
    subscribe: (cb) => {
      const listener = (): void => cb(doc.fullscreenElement !== null);
      // iOS «Done» in the native player: webkitendfullscreen does not bubble, so listen in capture.
      const native = (): void => {
        nativeVideo = null;
        cb(false);
      };
      doc.addEventListener('fullscreenchange', listener);
      doc.addEventListener('webkitendfullscreen', native, true);
      return () => {
        doc.removeEventListener('fullscreenchange', listener);
        doc.removeEventListener('webkitendfullscreen', native, true);
      };
    },
  };
}

/**
 * The layout state machine: `on` = the full-screen layout is shown. On only by our request;
 * off by ours or by the host leaving full screen. A host «entered» we did not ask for (⌃⌘F on a
 * plain window) does not switch the layout.
 */
export class FullscreenState {
  private on = false;
  /** host.enter() already called for this request. */
  private entered = false;
  private el: HTMLElement | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly host: FullscreenHost,
    private readonly onChange: (on: boolean) => void,
  ) {
    this.unsubscribe = host.subscribe((entered) => {
      if (!entered) this.set(false);
    });
  }

  get active(): boolean {
    return this.on;
  }

  /** Show the layout; the host goes full screen once the layout's container exists (`attach`). */
  request(): void {
    this.set(true);
    this.enter();
  }

  /** The full-screen layout mounted (el) or unmounted (null). Re-attaching does not enter again. */
  attach(el: HTMLElement | null): void {
    this.el = el;
    this.enter();
  }

  private enter(): void {
    if (!this.el || !this.on || this.entered) return;
    this.entered = true;
    void this.host.enter(this.el);
  }

  /** «Свернуть», Esc, ⌃⌘F, the stream ended: layout back now, the host leaves full screen. */
  exit(): void {
    if (!this.on) return;
    this.set(false);
    void this.host.exit();
  }

  toggle(): void {
    if (this.on) this.exit();
    else this.request();
  }

  dispose(): void {
    this.exit();
    this.unsubscribe();
  }

  private set(on: boolean): void {
    if (this.on === on) return;
    this.on = on;
    if (!on) this.entered = false;
    this.onChange(on);
  }
}

/** Esc and ⌃⌘F (macOS «Full Screen» shortcut; Ctrl+Meta+F elsewhere) leave full screen. */
export function isExitKey(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey'>): boolean {
  return e.key === 'Escape' || (e.ctrlKey && e.metaKey && e.code === 'KeyF');
}

// ---------------------------------------------------------------- the main window's instance

export const useStreamFullscreen = create<{ on: boolean }>()(() => ({ on: false }));

let main: FullscreenState | null = null;

/** The main window's stage full screen (created on first use with the platform's host). */
export function mainFullscreen(host: () => FullscreenHost): FullscreenState {
  main ??= new FullscreenState(host(), (on) => useStreamFullscreen.setState({ on }));
  return main;
}

/** Controls and cursor hide after `ms` without pointer / key activity; `poke` shows them again. */
export function useIdle(ms: number): { idle: boolean; poke: () => void } {
  const [idle, setIdle] = useState(false);
  const timer = useRef<number | null>(null);
  const poke = useCallback((): void => {
    setIdle(false);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setIdle(true), ms);
  }, [ms]);
  useEffect(() => {
    timer.current = window.setTimeout(() => setIdle(true), ms);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [ms]);
  return { idle, poke };
}
