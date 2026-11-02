/**
 * Presenter's annotation overlay (ADR-0028): the renderer hands main already validated
 * annotations of *my* stream; main forwards them to the click-through overlay window over the
 * shared display. Plain data (structured clone over IPC); main re-checks the shape anyway.
 */

/**
 * main → overlay page channel. Lives here, not in IPC (shared/ipc.ts): the two preloads must not
 * import a common module — rollup would split it into a chunk, and a sandboxed preload cannot
 * `require` a file.
 */
export const ANNOT_OVERLAY_CHANNEL = 'annot:overlay-message';

/** One annotation for a scene (renderer/lib/annot/scene.ts `SceneEvent`). */
export interface AnnotOverlayEvent {
  /** Sender's LiveKit identity. */
  from: string;
  /** Sender's display name (the pointer's label). */
  name: string;
  kind: 'pointer' | 'stroke' | 'clear';
  color: number;
  /** x0, y0, x1, y1… normalized to the shared screen (0..1). */
  points: number[];
  strokeId: number;
  strokeEnd: boolean;
  /** Sent by the presenter: a clear erases everyone's strokes. */
  owner: boolean;
}

/** What the overlay page receives. */
export interface AnnotOverlayMessage {
  type: 'event';
  ev: AnnotOverlayEvent;
}

/** The shared source to cover: only whole screens get an overlay (window bounds are unknown). */
export interface AnnotOverlayTarget {
  sourceId: string;
  displayId: string;
}

const MAX_POINTS = 60;

/** Validates an event coming over IPC; throws on anything off-shape. */
export function parseOverlayEvent(v: unknown): AnnotOverlayEvent {
  if (typeof v !== 'object' || v === null) throw new Error('invalid annot event');
  const r = v as Record<string, unknown>;
  const kind = r['kind'];
  const pts = r['points'];
  const text = (x: unknown, max: number): string => {
    if (typeof x !== 'string' || x.length > max) throw new Error('invalid annot event');
    return x;
  };
  const int = (x: unknown, max: number): number => {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x > max) throw new Error('invalid annot event');
    return x;
  };
  if (kind !== 'pointer' && kind !== 'stroke' && kind !== 'clear') throw new Error('invalid annot event');
  if (!Array.isArray(pts) || pts.length % 2 !== 0 || pts.length > MAX_POINTS * 2) throw new Error('invalid annot event');
  const points = pts.map((p: unknown) => {
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new Error('invalid annot event');
    return p;
  });
  if (typeof r['strokeEnd'] !== 'boolean' || typeof r['owner'] !== 'boolean') throw new Error('invalid annot event');
  return {
    from: text(r['from'], 256),
    name: text(r['name'], 200),
    kind,
    color: int(r['color'], 0xffffff),
    points,
    strokeId: int(r['strokeId'], 0xffffffff),
    strokeEnd: r['strokeEnd'],
    owner: r['owner'],
  };
}

export function parseOverlayTarget(v: unknown): AnnotOverlayTarget {
  if (typeof v !== 'object' || v === null) throw new Error('invalid overlay target');
  const r = v as Record<string, unknown>;
  const sourceId = r['sourceId'];
  const displayId = r['displayId'];
  if (typeof sourceId !== 'string' || sourceId.length > 256 || typeof displayId !== 'string' || displayId.length > 64) throw new Error('invalid overlay target');
  return { sourceId, displayId };
}

/** A display's bounds (Electron Rectangle). */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The display a screen source shows, or null (a window, a synthetic test source, unplugged).
 * An id that matches no display (empty or foreign on Windows, see `resolveScreenDisplays`) still
 * resolves when there is only one display: a whole-screen source can only be that one.
 */
export function displayBoundsFor(target: AnnotOverlayTarget, displays: ReadonlyArray<{ id: number; bounds: Bounds }>): Bounds | null {
  if (!target.sourceId.startsWith('screen:')) return null;
  const d = displays.find((o) => String(o.id) === target.displayId);
  if (d) return d.bounds;
  return displays.length === 1 && displays[0] ? displays[0].bounds : null;
}

/** A screen source as desktopCapturer lists it: its `display_id` and the thumbnail's size. */
export interface ScreenSourceInfo {
  id: string;
  displayId: string;
  thumbWidth: number;
  thumbHeight: number;
}

const ASPECT_TOLERANCE = 0.02;

/**
 * Fills in the display ids desktopCapturer could not (issue #102). On macOS a screen source's
 * `display_id` is the CGDirectDisplayID, the same id as `screen.getAllDisplays()`. On Windows
 * Electron maps sources to displays through DXGI output device names: where DXGI duplication is
 * unavailable (hybrid-GPU laptops, RDP, some drivers) the id stays empty, and where the capturer
 * enumerates monitors differently from the screen API the id matches no display. The overlay then
 * never opened, silently. Here an unmatched source gets the one display left unmatched, or the
 * only unmatched display with its thumbnail's aspect ratio; anything ambiguous stays '' (no overlay
 * over a wrong monitor: the presenter gets the in-app fallback instead).
 */
export function resolveScreenDisplays(sources: readonly ScreenSourceInfo[], displays: ReadonlyArray<{ id: number; bounds: Bounds }>): Map<string, string> {
  const ids = new Set(displays.map((d) => String(d.id)));
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const s of sources) {
    if (ids.has(s.displayId) && !taken.has(s.displayId)) {
      out.set(s.id, s.displayId);
      taken.add(s.displayId);
    }
  }
  const open = sources.filter((s) => !out.has(s.id));
  let free = displays.filter((d) => !taken.has(String(d.id)));
  if (open.length === 1 && free.length === 1 && free[0]) {
    out.set(open[0]?.id ?? '', String(free[0].id));
    return out;
  }
  for (const s of open) {
    const aspect = s.thumbWidth > 0 && s.thumbHeight > 0 ? s.thumbWidth / s.thumbHeight : 0;
    const same = aspect
      ? free.filter((d) => d.bounds.height > 0 && Math.abs(d.bounds.width / d.bounds.height / aspect - 1) < ASPECT_TOLERANCE)
      : [];
    const sameOpen = open.filter((o) => o.thumbHeight > 0 && Math.abs(o.thumbWidth / o.thumbHeight / aspect - 1) < ASPECT_TOLERANCE);
    if (same.length === 1 && same[0] && sameOpen.length === 1) {
      const id = String(same[0].id);
      out.set(s.id, id);
      free = free.filter((d) => String(d.id) !== id);
    } else {
      out.set(s.id, '');
    }
  }
  return out;
}

/** Windows re-raises the overlay at most this often while annotations come (issue #102). */
export const OVERLAY_RAISE_MS = 2000;

/**
 * Windows keeps every topmost window in one band: one shown after the overlay (a slide show,
 * another app's «always on top» window) covers it until the stream ends. While annotations come,
 * the overlay goes back to the top of the band — at most every OVERLAY_RAISE_MS, never when idle.
 */
export function overlayRaiseDue(platform: string, now: number, last: number): boolean {
  return platform === 'win32' && now - last >= OVERLAY_RAISE_MS;
}

/** Content protection keeps the window out of screen capture: macOS and Windows 10 2004+. */
export function overlaySupported(platform: string): boolean {
  return platform === 'darwin' || platform === 'win32';
}
