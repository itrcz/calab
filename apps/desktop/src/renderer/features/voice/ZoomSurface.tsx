import { ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { t } from '../../i18n';
import { contentRect } from '../../lib/annot/paint';
import { FIT, KEY_STEP, centerOn, clampView, levelText, pinch, panBy, toggleAt, viewFrac, wheelFactor, wheelPixels, zoomAt, type View } from './zoomMath';

/**
 * Viewer-side zoom and pan of a screen share (issue #33; local only, nobody else sees it). The
 * <video> (with its annotation layer) sits in an inner box that gets a CSS `translate() scale()`:
 * the compositor scales the decoded frames, nothing is redrawn. Gestures write the transform
 * straight to the element in a requestAnimationFrame, with no React state per wheel / pointer
 * event; React sees only the zoom level (chip, minimap), debounced after the gesture. While
 * zoomed out (1× = fit) nothing runs: no timers, no listeners beyond the DOM ones.
 */

const IDLE_MS = 2500;
const COMMIT_MS = 120;
const MINIMAP_W = 160;
const MINIMAP_MS = 500;

const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.userAgent);
/** The modifier shown in the tooltip: ⌘ on macOS, Ctrl elsewhere. */
export const zoomHint = (): string => t('zoom.hint', { mod: isMac() ? '⌘' : 'Ctrl' });

class Controller {
  view: View = FIT;
  w = 1;
  h = 1;
  /** Elements of the chrome (bound while it is mounted). */
  private rect: HTMLElement | null = null;
  private chrome: HTMLElement | null = null;
  private vp!: HTMLElement;
  private inner!: HTMLElement;
  private raf = 0;
  private commitTimer = 0;
  private idleTimer = 0;
  private committed = 1;
  private win: Window = window;
  private readonly pointers = new Map<number, [number, number]>();
  private base: { view: View; d: number; m: [number, number] } | null = null;
  private origin = { left: 0, top: 0 };

  constructor(private readonly onLevel: (level: number) => void) {}

  /** Binds the DOM; the returned function unbinds it. */
  attach(vp: HTMLElement, inner: HTMLElement): () => void {
    this.vp = vp;
    this.inner = inner;
    this.win = vp.ownerDocument.defaultView ?? window;
    this.resize(vp.clientWidth, vp.clientHeight);
    return () => {
      this.win.cancelAnimationFrame(this.raf);
      this.win.clearTimeout(this.commitTimer);
      this.win.clearTimeout(this.idleTimer);
      this.raf = 0;
    };
  }

  bindChrome(el: HTMLElement | null): void {
    this.chrome = el;
    if (el) this.wake();
  }

  bindRect(el: HTMLElement | null): void {
    this.rect = el;
    if (el) this.placeRect(el);
  }

  /** The stage's aspect ratio (the minimap shows the whole stage box). */
  aspect(): number {
    return this.w / this.h;
  }

  isIdle(): boolean {
    return this.chrome?.dataset['idle'] === 'true';
  }

  private placeRect(r: HTMLElement): void {
    const f = viewFrac(this.view, this.w, this.h);
    r.style.left = `${f.l * 100}%`;
    r.style.top = `${f.t * 100}%`;
    r.style.width = `${f.w * 100}%`;
    r.style.height = `${f.h * 100}%`;
  }

  resize(w: number, h: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.set(clampView(this.view, this.w, this.h));
  }

  set(v: View): void {
    this.view = v;
    if (!this.raf) this.raf = this.win.requestAnimationFrame(this.apply);
    if (v.s > 1) this.wake();
    // Crossing 1× changes what is mounted: tell React at once, the level text can wait.
    if (v.s > 1 !== this.committed > 1) this.commit();
    else {
      this.win.clearTimeout(this.commitTimer);
      this.commitTimer = this.win.setTimeout(() => this.commit(), COMMIT_MS);
    }
  }

  reset(): void {
    this.pointers.clear();
    this.base = null;
    this.set(FIT);
  }

  private readonly apply = (): void => {
    this.raf = 0;
    const { s, x, y } = this.view;
    const st = this.inner.style;
    if (s === 1) {
      st.transform = '';
      st.willChange = '';
    } else {
      st.transform = `translate3d(${x}px, ${y}px, 0) scale(${s})`;
      st.willChange = 'transform';
    }
    if (!this.pointers.size) this.vp.style.cursor = s > 1 ? 'grab' : '';
    if (this.rect && s > 1) this.placeRect(this.rect);
  };

  private commit(): void {
    this.committed = this.view.s;
    this.onLevel(this.view.s);
  }

  /** Shows the chrome and fades it out again after a pause. */
  wake(): void {
    const c = this.chrome;
    if (c) c.dataset['idle'] = 'false';
    this.win.clearTimeout(this.idleTimer);
    this.idleTimer = this.win.setTimeout(() => {
      if (this.chrome) this.chrome.dataset['idle'] = 'true';
    }, IDLE_MS);
  }

  zoomBy(factor: number, px = this.w / 2, py = this.h / 2): void {
    this.set(zoomAt(this.view, this.view.s * factor, px, py, this.w, this.h));
  }

  wheel(e: WheelEvent): void {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const b = this.vp.getBoundingClientRect();
    const f = wheelFactor(wheelPixels(e.deltaY, e.deltaMode, b.height));
    this.zoomBy(f, e.clientX - b.left, e.clientY - b.top);
  }

  doubleClick(e: { clientX: number; clientY: number }): void {
    const b = this.vp.getBoundingClientRect();
    this.set(toggleAt(this.view, e.clientX - b.left, e.clientY - b.top, this.w, this.h));
  }

  centerOnFrac(fx: number, fy: number): void {
    this.set(centerOn(this.view.s, fx, fy, this.w, this.h));
  }

  key(e: ReactKeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const pan = (dx: number, dy: number): void => {
      if (this.view.s > 1) this.set(panBy(this.view, dx, dy, this.w, this.h));
    };
    switch (e.key) {
      case '+':
      case '=':
        this.zoomBy(KEY_STEP);
        break;
      case '-':
      case '_':
        this.zoomBy(1 / KEY_STEP);
        break;
      case '0':
        this.set(FIT);
        break;
      case 'ArrowLeft':
        pan(48, 0);
        break;
      case 'ArrowRight':
        pan(-48, 0);
        break;
      case 'ArrowUp':
        pan(0, 48);
        break;
      case 'ArrowDown':
        pan(0, -48);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  down(e: ReactPointerEvent<HTMLElement>): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const b = this.vp.getBoundingClientRect();
    this.origin = { left: b.left, top: b.top };
    this.pointers.set(e.pointerId, [e.clientX - b.left, e.clientY - b.top]);
    try {
      this.vp.setPointerCapture(e.pointerId);
    } catch {
      // a synthetic pointer without an active capture target: panning still works while inside
    }
    this.rebase();
    if (this.view.s > 1) this.vp.style.cursor = 'grabbing';
  }

  move(e: ReactPointerEvent<HTMLElement>): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const cur: [number, number] = [e.clientX - this.origin.left, e.clientY - this.origin.top];
    this.pointers.set(e.pointerId, cur);
    if (this.pointers.size >= 2 && this.base) {
      const [a, c] = [...this.pointers.values()] as [[number, number], [number, number]];
      this.set(pinch(this.base.view, this.base.d, this.base.m, Math.hypot(a[0] - c[0], a[1] - c[1]), mid(a, c), this.w, this.h));
    } else if (this.view.s > 1) {
      this.set(panBy(this.view, cur[0] - prev[0], cur[1] - prev[1], this.w, this.h));
    }
  }

  up(e: ReactPointerEvent<HTMLElement>): void {
    if (!this.pointers.delete(e.pointerId)) return;
    this.rebase();
    if (!this.pointers.size) this.vp.style.cursor = this.view.s > 1 ? 'grab' : '';
  }

  private rebase(): void {
    if (this.pointers.size >= 2) {
      const [a, c] = [...this.pointers.values()] as [[number, number], [number, number]];
      this.base = { view: this.view, d: Math.hypot(a[0] - c[0], a[1] - c[1]), m: mid(a, c) };
    } else this.base = null;
  }
}

const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/**
 * Wrap the <video> (and what lies over it) of a screen share. `video` feeds the minimap;
 * `resetKey` (the watched track) returns the view to fit when the stream changes.
 */
export function ZoomSurface({ video, resetKey, children }: { video: RefObject<HTMLVideoElement | null>; resetKey: string; children: ReactNode }): ReactNode {
  const vpRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState(1);
  const [ctrl] = useState(() => new Controller(setLevel));

  useEffect(() => {
    const vp = vpRef.current;
    const inner = innerRef.current;
    if (!vp || !inner) return;
    const detach = ctrl.attach(vp, inner);
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) ctrl.resize(r.width, r.height);
    });
    ro.observe(vp);
    // Not passive: Ctrl + wheel / pinch must not zoom the page.
    const onWheel = (e: WheelEvent): void => ctrl.wheel(e);
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      vp.removeEventListener('wheel', onWheel);
      ro.disconnect();
      detach();
    };
  }, [ctrl]);

  useEffect(() => {
    ctrl.reset();
  }, [ctrl, resetKey]);

  return (
    <>
      <div
        ref={vpRef}
        data-testid="stream-zoom"
        data-zoom={level > 1 ? level.toFixed(2) : '1'}
        role="group"
        tabIndex={0}
        aria-label={t('zoom.stage')}
        title={zoomHint()}
        className="absolute inset-0 touch-none overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        onPointerDown={(e) => ctrl.down(e)}
        onPointerMove={(e) => ctrl.move(e)}
        onPointerUp={(e) => ctrl.up(e)}
        onPointerCancel={(e) => ctrl.up(e)}
        onKeyDown={(e) => ctrl.key(e)}
        onDoubleClick={(e) => {
          // A drawing tool owns the clicks.
          if (e.target instanceof HTMLElement && e.target.dataset['tool'] && e.target.dataset['tool'] !== 'none') return;
          ctrl.doubleClick(e);
        }}
      >
        <div ref={innerRef} className="absolute inset-0 origin-top-left">
          {children}
        </div>
      </div>
      {level > 1 ? <ZoomChrome ctrl={ctrl} video={video} level={level} /> : null}
    </>
  );
}

/** The «250 %» reset chip and the minimap; only while zoomed, fading out after a pause. */
function ZoomChrome({ ctrl, video, level }: { ctrl: Controller; video: RefObject<HTMLVideoElement | null>; level: number }): ReactNode {
  const box = useCallback((el: HTMLDivElement | null) => ctrl.bindChrome(el), [ctrl]);
  const rect = useCallback((el: HTMLDivElement | null) => ctrl.bindRect(el), [ctrl]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const mini = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // The thumbnail: the video drawn into a tiny canvas twice a second, only while the chrome is
  // visible in a visible window (a frame scaled to 160 px is a fraction of a percent of CPU).
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const win = cv.ownerDocument.defaultView ?? window;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const draw = (): void => {
      const v = video.current;
      if (!v || !v.videoWidth) return;
      const h = Math.max(1, Math.round(MINIMAP_W / ctrl.aspect()));
      if (cv.height !== h) cv.height = h;
      const r = contentRect(MINIMAP_W, h, v.videoWidth, v.videoHeight);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, MINIMAP_W, h);
      ctx.drawImage(v, r.x, r.y, r.w, r.h);
    };
    draw();
    const timer = win.setInterval(() => {
      if (cv.ownerDocument.visibilityState !== 'visible' || ctrl.isIdle()) return;
      draw();
    }, MINIMAP_MS);
    return () => win.clearInterval(timer);
  }, [ctrl, video]);

  const at = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const b = e.currentTarget.getBoundingClientRect();
    ctrl.centerOnFrac((e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height);
  };
  return (
    <div
      ref={box}
      data-testid="stream-zoom-chrome"
      data-idle="false"
      onPointerEnter={() => ctrl.wake()}
      onPointerMove={() => ctrl.wake()}
      // Finite fade only (docs/08, CLAUDE.md: no infinite animations); hover / focus brings it back.
      className="absolute bottom-3 left-3 flex flex-col items-start gap-2 transition-opacity duration-[var(--motion-fast)] motion-reduce:transition-none data-[idle=true]:opacity-0 data-[idle=true]:focus-within:opacity-100 data-[idle=true]:hover:opacity-100"
    >
      <div
        ref={mini}
        data-testid="stream-zoom-minimap"
        role="img"
        aria-label={t('zoom.minimap')}
        className="relative cursor-pointer touch-none overflow-hidden rounded-[var(--radius-control)] bg-black ring-1 ring-white/25"
        style={{ width: MINIMAP_W, aspectRatio: ctrl.aspect() }}
        onPointerDown={(e) => {
          e.stopPropagation();
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          at(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current) at(e);
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
      >
        <canvas ref={canvas} width={MINIMAP_W} height={Math.round((MINIMAP_W * 9) / 16)} className="block size-full" aria-hidden />
        <div ref={rect} className="pointer-events-none absolute rounded-[2px] border-2 border-white bg-white/10" />
      </div>
      <button
        type="button"
        data-testid="stream-zoom-reset"
        aria-label={t('zoom.reset', { level: levelText(level) })}
        title={t('zoom.reset', { level: levelText(level) })}
        onClick={() => ctrl.set(FIT)}
        onPointerDown={(e) => e.stopPropagation()}
        className="flex h-7 items-center gap-1.5 rounded-full bg-black/70 px-2.5 text-[12px] font-medium text-white ring-1 ring-white/10 transition-colors duration-[var(--motion-fast)] hover:bg-black/85 focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ZoomOut className="size-3.5" aria-hidden />
        {levelText(level)}
      </button>
    </div>
  );
}
