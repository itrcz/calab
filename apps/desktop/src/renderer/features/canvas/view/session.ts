/**
 * One open canvas: Y.Doc + awareness + engine + sync socket + the binding between them, created together
 * and destroyed together (no background sockets or frames after the screen closes). No React.
 *
 * Destroy order (H4 hand-over): pending text edit → binding → sync (flush, compaction snapshot when we
 * edited, bye, close) → engine → awareness → doc.
 */
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { canvasPublicSyncUrl, canvasSyncUrl, createCanvasSync, type CanvasSync } from '../../../lib/canvasSync';
import type { SocketLike } from '../../../lib/gateway/client';
import { builtinStickerSrc } from '../../../lib/builtinStickers';
import { canvasDocUserKey } from '../../../lib/canvas/docUser';
import type { Point } from '../../../lib/canvas/geometry';
import { CanvasEngine, type CanvasPalette, type ClipboardPort, type RefusedWhy } from '../engine';
import { bindCanvasSync, type CanvasUser, type SyncBinding, type SyncEnginePort } from '../syncBinding';
import type { PresenceStore } from './presenceStore';
import { playTimerEnd } from './timerSound';
import { TimerStore } from './timerStore';

/** Connection details the screen needs from the app (injected so tests run against a mock socket). */
export interface CanvasViewDeps {
  /** Server origin the API lives on (`https://app.example.com`). */
  serverUrl: () => string;
  getToken: () => Promise<string | null>;
  refreshToken?: () => Promise<string | null>;
  createSocket: (url: string) => SocketLike;
  /** The signed-in person as the others see them. */
  user: () => { id: string; name: string };
  clipboard?: ClipboardPort;
  /**
   * `serverNow − localNow` in ms, estimated from the `Date` header of one light REST call; null = unknown. Called once
   * per open canvas, and only when a timer is first seen or started (ADR-0127). Absent: the local clock is used.
   */
  serverClockOffset?: () => Promise<number | null>;
  /**
   * An API media path → a URL an <img> can load with the person's access (platform.mediaUrl). Absent (the public link:
   * no token, no public route for workspace files): pictures on the board stay plaques, except built-in stickers,
   * which are bundled with the app.
   */
  mediaUrl?: (path: string) => Promise<string>;
  /** Uploads a picture pasted or dropped on canvas `canvasId` (owner 23.11); absent (the public link): such pastes do nothing. */
  uploadImage?: (canvasId: string, file: File) => Promise<{ path: string; width: number; height: number }>;
  /** Opens an object's web link in the browser (platform.app.openExternal). */
  openLink?: (url: string) => void;
}

export interface SessionOptions {
  canvasId: string;
  canvas: HTMLCanvasElement;
  /** The transparent layer over `canvas` for other people's cursors. */
  remoteCanvas?: HTMLCanvasElement | null;
  editorHost: HTMLElement;
  /** The text editor's accessible name (read at every open, so it follows the UI language). */
  editorLabel?: () => string;
  /** A new frame's title in the UI language. */
  frameTitle?: (n: number) => string;
  deps: CanvasViewDeps;
  palette: CanvasPalette;
  /** No CANVAS_WRITE. */
  readOnly: boolean;
  /**
   * The public link's viewer (ADR-0127 wave 5): the anonymous receive-only socket of this code instead of
   * `/api/canvas/items/{id}/sync` — no token, nothing sent (lib/canvasSync.ts `anonymous`).
   */
  publicCode?: string;
  lowPower: boolean;
  reducedMotion: boolean;
  /** The phone viewer: touch editing semantics in the engine. */
  touch?: boolean;
  presence: PresenceStore;
  color: (userId: string) => string;
  /** The canvas' name for the snapshot meta (read at call time). */
  title: () => string;
  onTooLarge: (bytes: number) => void;
  /** An action was refused (EngineOptions.onRefused). */
  onRefused?: (why: RefusedWhy) => void;
  /** A pasted or dropped picture did not upload (the server's refusal: too large, the quota, no right). */
  onImageFailed?: (e: unknown) => void;
  onFatal: (code: number) => void;
}

export interface CanvasSession {
  readonly ydoc: Y.Doc;
  readonly awareness: Awareness;
  readonly sync: CanvasSync;
  readonly engine: CanvasEngine;
  readonly binding: SyncBinding;
  /** The shared countdown (meta.timer). */
  readonly timer: TimerStore;
  destroy(): void;
}

/** How far apart (world units) pictures dropped together land. */
const IMAGE_STEP = 32;

export function openCanvasSession(o: SessionOptions): CanvasSession {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const me = o.deps.user();
  // What the document carries for me (votes, who started a vote or the timer): a key, not my id (docUser.ts).
  const docUser = o.publicCode ? '' : canvasDocUserKey(o.canvasId, me.id);
  const upload = o.publicCode ? undefined : o.deps.uploadImage;
  // Each picture lands as its upload finishes, the n-th a step down-right of the first (several dropped at once).
  const pasteImages = (files: readonly File[], at: Point | null): void => {
    if (!upload) return;
    files.forEach((f, i) => {
      upload(o.canvasId, f).then(
        (r) => {
          // The board may have closed while the picture was uploading: the engine and its document are gone.
          if (closed) return;
          const p = at ?? engine.viewCenter();
          engine.insertImage(r.path, r.width, r.height, undefined, { x: p.x + i * IMAGE_STEP, y: p.y + i * IMAGE_STEP });
        },
        (e: unknown) => {
          if (!closed) o.onImageFailed?.(e);
        },
      );
    });
  };
  const engine = new CanvasEngine({
    canvas: o.canvas,
    userId: docUser,
    ...(o.remoteCanvas ? { remoteCanvas: o.remoteCanvas } : {}),
    doc: ydoc,
    palette: o.palette,
    readOnly: o.readOnly,
    lowPower: o.lowPower,
    reducedMotion: o.reducedMotion,
    ...(o.touch ? { touch: true } : {}),
    editorHost: o.editorHost,
    ...(o.editorLabel ? { editorLabel: o.editorLabel } : {}),
    ...(o.frameTitle ? { frameTitle: o.frameTitle } : {}),
    ...(o.deps.clipboard ? { clipboard: o.deps.clipboard } : {}),
    ...(o.onRefused ? { onRefused: o.onRefused } : {}),
    imageUrl: (src) => builtinStickerSrc(src) ?? o.deps.mediaUrl?.(src) ?? null,
    ...(upload ? { pasteImages: (files: readonly File[], at: Point | null) => pasteImages(files, at) } : {}),
    ...(o.deps.openLink ? { openLink: o.deps.openLink } : {}),
  });
  const code = o.publicCode;
  const sync = createCanvasSync(ydoc, awareness, {
    url: () => (code ? canvasPublicSyncUrl(o.deps.serverUrl(), code) : canvasSyncUrl(o.deps.serverUrl(), o.canvasId)),
    ...(code ? { anonymous: true } : {}),
    getToken: o.deps.getToken,
    ...(o.deps.refreshToken ? { refreshToken: o.deps.refreshToken } : {}),
    createSocket: o.deps.createSocket,
    readOnly: o.readOnly,
    title: o.title,
    onTooLarge: o.onTooLarge,
    onFatal: o.onFatal,
  });
  const port: SyncEnginePort = {
    setPeers: (peers) => {
      engine.setPeers(peers);
      o.presence.set(peers);
    },
    onLocalAwareness: (fn) => engine.onLocalAwareness(fn),
    onLocalView: (fn) => engine.onLocalView(fn),
    setReadOnly: (on) => engine.setReadOnly(on),
  };
  const user: CanvasUser = { id: me.id, name: me.name, color: o.color(me.id) };
  const binding = bindCanvasSync({ doc: ydoc, awareness, sync, engine: port, user, readOnly: o.readOnly });

  const timer = new TimerStore({
    meta: ydoc.getMap('meta'),
    userId: docUser,
    canWrite: () => !engine.readOnly,
    visible: () => engine.isActive,
    onVisible: (fn) => engine.subscribeView(fn),
    ...(o.deps.serverClockOffset ? { fetchOffset: o.deps.serverClockOffset } : {}),
    playEnd: playTimerEnd,
  });

  // Window closing: the open text edit is committed and the pending update sent before the page goes.
  const onPageHide = (): void => {
    if (engine.editor.isOpen) engine.editor.commit();
    sync.flush();
  };
  window.addEventListener('pagehide', onPageHide);

  let closed = false;
  return {
    ydoc,
    awareness,
    sync,
    engine,
    binding,
    timer,
    destroy() {
      if (closed) return;
      closed = true;
      window.removeEventListener('pagehide', onPageHide);
      if (engine.editor.isOpen) engine.editor.commit();
      timer.destroy();
      binding.destroy();
      sync.destroy();
      engine.destroy();
      awareness.destroy();
      ydoc.destroy();
    },
  };
}
