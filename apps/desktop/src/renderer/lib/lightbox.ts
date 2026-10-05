/**
 * Lightbox view logic (docs/08 «Медиа в чате», issue #7), kept pure for unit tests.
 *
 * The viewer opens at once with the chat thumbnail (already loaded) as a placeholder and a
 * spinner over it; the full file replaces it when loaded. Both are drawn in one frame whose size
 * is the image fitted into the viewer box — never cropped, never upscaled past its own pixels.
 */

export interface LightboxImage {
  fileId: string;
  name: string;
  /** MIME type from FileMeta, when known (the web drag-out names the file's type with it). */
  mime?: string;
  /** Pixel size from FileMeta (0 when the server does not know it). */
  width: number;
  height: number;
}

export type LoadState = 'loading' | 'loaded' | 'error';

export interface Layers {
  /** The thumbnail placeholder (stays under a failed full image). */
  thumb: boolean;
  /** The full image is shown (opacity 1). */
  full: boolean;
  spinner: boolean;
  error: boolean;
}

/** What the frame shows for the thumbnail and full-image load states. */
export function lightboxLayers(thumb: LoadState, full: LoadState): Layers {
  return {
    thumb: full !== 'loaded' && thumb === 'loaded',
    full: full === 'loaded',
    spinner: full === 'loading',
    error: full === 'error',
  };
}

export interface Dims {
  w: number;
  h: number;
}

/** Known pixel size of an image, or null (0 / missing). */
export function dimsOf(w: number | undefined, h: number | undefined): Dims | null {
  return w && h && w > 0 && h > 0 ? { w, h } : null;
}

/**
 * The frame's CSS size inside a `container-type: size` box: the aspect ratio of the image and the
 * largest width at which it fits the box both ways (`cqw`/`cqh`). `natural` caps the width at the
 * image's own pixels (a known size: no upscaling); an aspect known only from the thumbnail fills
 * the box. null → no frame yet (nothing known about the image).
 */
export function fitFrame(d: Dims | null, natural: boolean): { width: string; aspectRatio: string } | null {
  if (!d) return null;
  const byHeight = `calc(100cqh * ${d.w} / ${d.h})`;
  return {
    width: natural ? `min(100cqw, ${d.w}px, ${byHeight})` : `min(100cqw, ${byHeight})`,
    aspectRatio: `${d.w} / ${d.h}`,
  };
}

/** ←/→ in a gallery: the next index, clamped (no wrap-around), or null when there is none. */
export function stepImage(index: number, delta: -1 | 1, count: number): number | null {
  const next = index + delta;
  return next >= 0 && next < count ? next : null;
}

/** Movement (CSS px) under which a press on the image still counts as a click, not a drag. */
export const TAP_SLOP = 6;

/** A press released within TAP_SLOP of where it started: a click on the image (closes the viewer). */
export function isTap(down: { x: number; y: number }, up: { x: number; y: number }, slop = TAP_SLOP): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= slop;
}
