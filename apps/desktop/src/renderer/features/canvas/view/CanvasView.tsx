/**
 * The Canvas screen's body (ADR-0126 §4–§5): the engine on a `<canvas>`, the tool and properties panels,
 * zoom, other people's cursors and the connection state. The section's header, tree and dialogs are the
 * parent's (H5a); this component owns everything inside the work area.
 *
 * Lifecycle: mounting opens one Y.Doc + awareness + engine + sync socket (session.ts); unmounting flushes,
 * compacts when edited and closes all of it — a canvas that is not on screen holds no socket, frame or timer.
 *
 * Re-render discipline (CLAUDE.md): this component re-renders for a handful of rare things (session ready,
 * theme, a help/menu toggle). Everything that changes with editing is read by leaf components through
 * primitives (`useEngineValue`) or imperatively (the properties panel's position).
 */
import * as ContextMenu from '@radix-ui/react-context-menu';
import { CANVAS_BITS } from '@calaba/protocol';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref } from 'react';
import { t, useLocale, type MessageKey } from '../../../i18n';
import { fitRect } from '../../../lib/canvas/camera';
import { canvasDocHandle, setCanvasDocHandle } from '../../../lib/canvas/docHandle';
import { restoreCanvasState } from '../../../lib/canvas/restore';
import { toast } from '../../../stores/toasts';
import type { CanvasPalette, RefusedWhy } from '../engine';
import { CanvasMenu, type MenuMode } from './CanvasMenu';
import { CommentsLayer, CommentsToggle } from './comments/CommentsLayer';
import { ZoomBar } from './Controls';
import { FramesPanel } from './FramesPanel';
import { MiniMap } from './MiniMap';
import { PhoneEditBar } from './PhoneEditBar';
import { PhoneFormatBar } from './PhoneFormatBar';
import { PhoneProps } from './PhoneProps';
import { PhoneEditHint, PhoneNote, PhoneOthers } from './PhoneChrome';
import { Presence } from './PresenceBar';
import { QuickDropMenu } from './QuickDropMenu';
import { PropsPanel } from './PropsPanel';
import { SelectionAnnouncer } from './SelectionAnnouncer';
import { StatusBanner, ViewerStatus } from './StatusBanner';
import { TemplatesCard } from './Templates';
import { TextFormatBar } from './TextFormatBar';
import { HistoryBar, Toolbar } from './Toolbar';
import { appDeps } from './defaultDeps';
import { downloadBlob, exportCanvasPng, pngFileName, type ExportArea } from './exportPng';
import { registerCanvasViewHandle, type CanvasViewHandle } from './handle';
import { useEngineValue } from './hooks';
import { currentTheme, cursorColor, readCanvasPalette } from './palette';
import { PresenceStore } from './presenceStore';
import { openCanvasSession, type CanvasSession, type CanvasViewDeps } from './session';

export interface CanvasViewProps {
  canvasId: string;
  workspaceId: string;
  /** `my_bits` of the CanvasItem: CANVAS_WRITE decides edit vs. view only. */
  bits: bigint;
  onOpenHistory: () => void;
  onShare: () => void;
  /** The canvas' name, for the snapshot meta (search) and the PNG file name. Optional; read at call time. */
  name?: string;
  /**
   * The phone viewer (ADR-0126 §5): always read-only whatever `bits` say, no toolbar / properties / help /
   * context menu / avatars; the zoom bar, connection notices, a count of the others and a one-time note stay.
   */
  phone?: boolean;
  /**
   * The phone's «Править» mode (ADR-0127 wave 5b): with CANVAS_WRITE the phone viewer becomes editable (touch editing,
   * bottom tool bar, properties sheet). Off — the view-only viewer as before. Ignored off the phone.
   */
  phoneEdit?: boolean;
  /**
   * The public link's viewer `/c/{code}` (ADR-0127 wave 5): the anonymous receive-only socket of this code, view
   * only whatever `bits` say, and none of the people's chrome — no tools, properties, context menu, comments,
   * voting, presence, cursors or mini-map; the zoom bar, the timer and the connection notices stay. `phone` picks
   * the touch viewer.
   */
  publicCode?: string;
  /** The server closed the socket for good: 4003 (access changed) or 4404 (gone). The shell may reload the item's rights. */
  onFatal?: (code: number) => void;
  /** Receives the handle (export, fit) once the canvas is open; `getCanvasViewHandle(canvasId)` is the same. */
  ref?: Ref<CanvasViewHandle>;
  /** Test seam: connection details instead of the app's. */
  deps?: CanvasViewDeps;
}

interface Env {
  lowPower: boolean;
  reducedMotion: boolean;
}

const REFUSED: Record<RefusedWhy, MessageKey> = {
  objects: 'canvasBoard.pasteFull',
  size: 'canvasBoard.pasteTooLarge',
  create: 'canvasBoard.createFull',
  clipboard: 'canvasBoard.clipboardFailed',
  notImage: 'canvasBoard.imageNotPicture',
};

function readEnv(): Env {
  return {
    lowPower: document.documentElement.dataset['lowEnd'] === 'true',
    reducedMotion: typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
}

export function CanvasView({ canvasId, workspaceId, bits, onOpenHistory, onShare, name, phone = false, phoneEdit = false, publicCode, onFatal, ref, deps: depsProp }: CanvasViewProps): ReactNode {
  useLocale();
  const viewer = !!publicCode;
  const granted = !viewer && (bits & CANVAS_BITS.WRITE) !== 0n;
  const canWrite = (!phone || phoneEdit) && granted;
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const remote = useRef<HTMLCanvasElement>(null);
  const [session, setSession] = useState<CanvasSession | null>(null);
  const [palette, setPalette] = useState<CanvasPalette>(() => readCanvasPalette(currentTheme()));
  const [gone, setGone] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [menuMode, setMenuMode] = useState<MenuMode>('empty');
  const presence = useMemo(() => new PresenceStore(), []);
  const deps = useMemo(() => depsProp ?? appDeps(workspaceId), [depsProp, workspaceId]);

  // Values the long-lived session reads at call time, so changing them does not reopen the socket.
  const live = useRef({ name: name ?? '', canWrite, deps, palette, onFatal, gone: false });
  useLayoutEffect(() => {
    live.current = { name: name ?? '', canWrite, deps, palette, onFatal, gone };
  });

  const focusCanvas = useCallback((): void => {
    canvas.current?.focus({ preventScroll: true });
  }, []);

  // iOS / Safari zoom the page on a pinch that starts on a panel or toolbar over the canvas (touch-action
  // below covers the modern engines; the gesture events are the fallback and the macOS trackpad). The
  // canvas itself handles them in the engine (input.ts); here they are only kept from the page.
  useEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const stop = (e: Event): void => e.preventDefault();
    el.addEventListener('gesturestart', stop);
    el.addEventListener('gesturechange', stop);
    return () => {
      el.removeEventListener('gesturestart', stop);
      el.removeEventListener('gesturechange', stop);
    };
  }, []);

  // One session per open canvas.
  useEffect(() => {
    const cv = canvas.current;
    const host = stage.current;
    if (!cv || !host) return undefined;
    setGone(false);
    const env = readEnv();
    const s = openCanvasSession({
      canvasId,
      canvas: cv,
      remoteCanvas: remote.current,
      editorHost: host,
      editorLabel: () => t('canvasBoard.textEditor'),
      frameTitle: (n) => t('canvasBoard.frame.default', { n }),
      deps: live.current.deps,
      palette: live.current.palette,
      readOnly: !live.current.canWrite,
      ...(publicCode ? { publicCode } : {}),
      lowPower: env.lowPower,
      reducedMotion: env.reducedMotion,
      touch: phone,
      presence,
      color: (id) => cursorColor(id),
      title: () => live.current.name,
      onTooLarge: () => toast.error(t('canvasBoard.tooLarge')),
      onRefused: (why) => toast.error(t(REFUSED[why])),
      onImageFailed: (e) => toast.fail(e, t('canvasBoard.imageUploadFailed')),
      onFatal: (code) => {
        setGone(true);
        live.current.onFatal?.(code);
      },
    });
    setSession(s);
    return () => {
      setSession(null);
      s.destroy();
    };
  }, [canvasId, presence, epoch, phone, publicCode]);

  // Grant changes while open (CANVAS_WRITE given or taken away).
  useEffect(() => {
    if (!session) return;
    // Leaving the phone's edit mode keeps what was typed and drops the selection and the tool (nothing stays half-armed).
    if (!canWrite && phone) {
      session.engine.leaveTouchEdit();
      // The read-only socket sends nothing: what was drawn a moment ago goes out first.
      session.sync.flush();
    }
    session.binding.setReadOnly(!canWrite);
  }, [session, canWrite, phone]);

  // The app's theme, «слабый компьютер» and reduced motion reach the engine without reopening anything.
  useEffect(() => {
    if (!session) return undefined;
    const { engine } = session;
    let theme = currentTheme();
    const apply = (): void => {
      const env = readEnv();
      engine.setLowPower(env.lowPower);
      engine.setReducedMotion(env.reducedMotion);
      const next = currentTheme();
      if (next !== theme) {
        theme = next;
        const p = readCanvasPalette(next);
        engine.setPalette(p);
        setPalette(p);
      }
    };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-low-end'] });
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    mq?.addEventListener('change', apply);
    return () => {
      mo.disconnect();
      mq?.removeEventListener('change', apply);
    };
  }, [session]);

  // Off screen (a hidden tab / panel of the app) draws nothing, like a hidden window does.
  useEffect(() => {
    const host = stage.current;
    if (!session || !host || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) session.engine.setActive(last.isIntersecting && document.visibilityState !== 'hidden');
    });
    io.observe(host);
    return () => io.disconnect();
  }, [session]);

  const handle = useMemo<CanvasViewHandle | null>(() => {
    if (!session) return null;
    const { engine } = session;
    return {
      fitAll: () => engine.fitAll(),
      exportPng: async (opts) => {
        const area: ExportArea = opts?.area ?? 'all';
        if (!engine.scene.bounds()) {
          toast.info(t('canvasBoard.export.empty'));
          return false;
        }
        const blob = await exportCanvasPng(engine, { area });
        if (!blob) {
          toast.error(t('canvasBoard.export.failed'));
          return false;
        }
        downloadBlob(blob, pngFileName(opts?.name ?? live.current.name, t('canvasBoard.export.fileName')));
        return true;
      },
    };
  }, [session]);
  useImperativeHandle(ref, () => handle as CanvasViewHandle, [handle]);
  useEffect(() => (handle ? registerCanvasViewHandle(canvasId, handle) : undefined), [canvasId, handle]);

  // A canvas opens showing all of its content, once, as soon as the document has arrived (the camera starts
  // at the world origin otherwise and the objects sit cut off in a corner). Instant, no animation; later
  // reconnects and the person's own panning are left alone.
  useEffect(() => {
    if (!session) return undefined;
    const { sync, engine } = session;
    let done = false;
    let off: (() => void) | null = null;
    const fit = (): void => {
      const st = sync.getStatus();
      if (done || (st !== 'synced' && st !== 'readonly')) return;
      done = true;
      off?.();
      const b = engine.scene.bounds();
      if (b) engine.setCamera(fitRect(b, engine.viewport));
    };
    off = sync.subscribe(fit);
    fit();
    return () => {
      done = true;
      off();
    };
  }, [session]);

  // «Восстановить версию» (history dialog, main chunk) reaches the live document through this handle. The
  // canvas is never in the trash while this view is mounted (the section shows a banner instead).
  useEffect(() => {
    if (!session || viewer) return undefined;
    const h = {
      canvasId,
      restore: (state: Uint8Array): boolean => restoreCanvasState(session.engine.doc, state),
      writable: (): boolean => live.current.canWrite && !live.current.gone && session.sync.getStatus() === 'synced',
      subscribe: (fn: () => void): (() => void) => session.sync.subscribe(() => fn()),
    };
    setCanvasDocHandle(h);
    return () => {
      // Another canvas may have registered its own already (switch): only clear what is ours.
      if (canvasDocHandle(canvasId) === h) setCanvasDocHandle(null);
    };
  }, [session, canvasId, viewer]);

  // Right click: select what is under the pointer (or clear), then let the menu open for that.
  const onContextMenuCapture = (e: ReactMouseEvent): void => {
    const cv = canvas.current;
    if (!session || !cv) return;
    if (e.target !== cv) {
      // The text editor's own textarea keeps the browser's menu (copy / paste / spelling); panels have none.
      e.stopPropagation();
      if (!(e.target instanceof HTMLTextAreaElement)) e.preventDefault();
      return;
    }
    const { engine } = session;
    const r = cv.getBoundingClientRect();
    const hit = engine.hitAt(engine.toWorld({ x: e.clientX - r.left, y: e.clientY - r.top }));
    if (hit) {
      // The menu acts on what a click would select: a group member brings its whole group.
      if (!engine.selection.has(hit.id)) engine.setSelection(engine.unitAt(hit.id));
      setMenuMode('object');
    } else {
      engine.clearSelection();
      setMenuMode('empty');
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === '?' && e.target === canvas.current) {
      e.preventDefault();
      setHelpOpen((o) => !o);
    }
  };

  const engine = session?.engine ?? null;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild disabled={phone || viewer}>
        <div
          ref={root}
          // Panning and scrolling panels are the browser's; pinch and double-tap zoom of the page are not.
          style={{ touchAction: 'pan-x pan-y' }}
          className="relative size-full min-h-0 min-w-0 select-none overflow-hidden bg-main"
          data-testid="canvas-view"
          data-canvas-id={canvasId}
          onContextMenuCapture={onContextMenuCapture}
          onKeyDown={onKeyDown}
        >
          <div ref={stage} className="absolute inset-0">
            <canvas ref={canvas} className="block size-full outline-none" aria-label={t('canvasBoard.label')} data-testid="canvas-surface" />
            {/* Other people's cursors: a second layer so their stream never repaints the canvas above (ADR-0126 §4). */}
            <canvas ref={remote} className="pointer-events-none absolute inset-0 block size-full" aria-hidden="true" data-testid="canvas-remote" />
          </div>
          {session && engine && viewer ? (
            <ViewerChrome session={session} focusCanvas={focusCanvas} gone={gone} phone={phone} />
          ) : session && engine ? (
            <Chrome
              session={session}
              palette={palette}
              canWrite={canWrite}
              gone={gone}
              onRetry={() => setEpoch((e) => e + 1)}
              presence={presence}
              focusCanvas={focusCanvas}
              helpOpen={helpOpen}
              onHelpOpenChange={setHelpOpen}
              phone={phone}
              granted={granted}
              canvasId={canvasId}
              workspaceId={workspaceId}
              bits={bits}
            />
          ) : null}
        </div>
      </ContextMenu.Trigger>
      {engine && !phone && !viewer ? (
        <CanvasMenu engine={engine} mode={menuMode} canWrite={canWrite} focusCanvas={focusCanvas} onOpenHistory={onOpenHistory} onShare={onShare} />
      ) : null}
    </ContextMenu.Root>
  );
}

/**
 * Over the public link's canvas: the zoom bar, the timer and the connection notices. Nothing that reads who is on
 * the canvas or loads comments and votes (CommentsLayer, Presence, VoteChip are never mounted).
 */
function ViewerChrome({ session, focusCanvas, gone, phone }: { session: CanvasSession; focusCanvas: () => void; gone: boolean; phone: boolean }): ReactNode {
  const { engine, sync, timer } = session;
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <>
      <ZoomBar engine={engine} focusCanvas={focusCanvas} canWrite={false} helpOpen={helpOpen} onHelpOpenChange={setHelpOpen} phone={phone} minimap={false} frames={false} />
      <ViewerStatus engine={engine} sync={sync} timer={timer} gone={gone} />
      <SelectionAnnouncer engine={engine} />
    </>
  );
}


/** Everything drawn over the canvas. Editing tools exist only while the engine is writable. */
function Chrome({
  session, palette, canWrite, gone, onRetry, presence, focusCanvas, helpOpen, onHelpOpenChange, phone, granted, canvasId, workspaceId, bits,
}: {
  session: CanvasSession;
  palette: CanvasPalette;
  canWrite: boolean;
  gone: boolean;
  onRetry: () => void;
  presence: PresenceStore;
  focusCanvas: () => void;
  helpOpen: boolean;
  onHelpOpenChange: (o: boolean) => void;
  phone: boolean;
  /** CANVAS_WRITE is granted (the phone may be in view mode with it). */
  granted: boolean;
  canvasId: string;
  workspaceId: string;
  bits: bigint;
}): ReactNode {
  const { engine, sync, timer } = session;
  const editable = !useEngineValue(engine, (s) => s.readOnly);
  // Comments (ADR-0127 wave 4): their own layer and panel; the canvas never re-renders for them.
  const comments = <CommentsLayer engine={engine} sync={sync} canvasId={canvasId} workspaceId={workspaceId} bits={bits} phone={phone} />;
  const commentsToggle = <CommentsToggle canvasId={canvasId} focusCanvas={phone ? undefined : focusCanvas} />;
  if (phone) {
    return (
      <>
        {comments}
        <ZoomBar engine={engine} focusCanvas={focusCanvas} canWrite={false} helpOpen={false} onHelpOpenChange={onHelpOpenChange} phone top={canWrite} comments={commentsToggle} />
        <PhoneOthers store={presence} top={canWrite} />
        {granted ? null : <PhoneNote />}
        {canWrite && editable ? <PhoneEditHint /> : null}
        {canWrite && editable ? <PhoneFormatBar engine={engine} /> : null}
        {canWrite && editable ? (
          <PhoneEditBar engine={engine} timer={timer} palette={palette} focusCanvas={focusCanvas}>
            <PhoneProps engine={engine} palette={palette} focusCanvas={focusCanvas} />
          </PhoneEditBar>
        ) : null}
        <StatusBanner engine={engine} sync={sync} timer={timer} canWrite={canWrite} gone={gone} onRetry={onRetry} phone low={canWrite} />
        <SelectionAnnouncer engine={engine} />
      </>
    );
  }
  return (
    <>
      {editable ? (
        <>
          <Toolbar engine={engine} timer={timer} palette={palette} focusCanvas={focusCanvas} workspaceId={workspaceId} />
          <HistoryBar engine={engine} focusCanvas={focusCanvas} />
          <PropsPanel engine={engine} palette={palette} focusCanvas={focusCanvas} />
          <QuickDropMenu engine={engine} focusCanvas={focusCanvas} />
          <TextFormatBar engine={engine} />
          <TemplatesCard engine={engine} sync={sync} focusCanvas={focusCanvas} />
        </>
      ) : null}
      {comments}
      <ZoomBar engine={engine} focusCanvas={focusCanvas} canWrite={canWrite} helpOpen={helpOpen} onHelpOpenChange={onHelpOpenChange} comments={commentsToggle} />
      <MiniMap engine={engine} palette={palette} focusCanvas={focusCanvas} />
      <FramesPanel engine={engine} palette={palette} editable={editable} focusCanvas={focusCanvas} />
      <Presence store={presence} engine={engine} />
      <StatusBanner engine={engine} sync={sync} timer={timer} canWrite={canWrite} gone={gone} onRetry={onRetry} />
      <SelectionAnnouncer engine={engine} />
    </>
  );
}
