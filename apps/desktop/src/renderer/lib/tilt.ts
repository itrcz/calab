/**
 * The achievement viewer's tilt (ADR-0061 §5, the owner's explicit exception to «heavy effects
 * only when visible»): the picture leans toward the cursor by at most 6°, `perspective(600px)
 * rotateX/rotateY`. Work happens only on `pointermove` over the area, at most once per frame
 * (requestAnimationFrame); leaving returns it to 0 with a 300 ms transition; no movement — no
 * work. Off with prefers-reduced-motion, in the «Слабый компьютер» mode (`<html
 * data-low-end="true">`) and for touch / pen pointers. Only the picture's transform changes.
 */

export const TILT_MAX_DEG = 6;
export const TILT_PERSPECTIVE_PX = 600;
export const TILT_RETURN_MS = 300;

export interface TiltEnv {
  reducedMotion: boolean;
  lowEnd: boolean;
  /** No hover-capable pointer (a phone, a tablet). */
  touchOnly: boolean;
}

export const tiltAllowed = (env: TiltEnv): boolean => !env.reducedMotion && !env.lowEnd && !env.touchOnly;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Angles for a pointer at (x, y) over `box`: the right edge turns the picture by +max around Y,
 * the top edge by +max around X (the near edge comes toward the cursor); clamped to ±max; zero
 * when not allowed.
 */
export function tiltAngles(x: number, y: number, box: Box, allowed = true, max = TILT_MAX_DEG): { rx: number; ry: number } {
  if (!allowed || box.width <= 0 || box.height <= 0) return { rx: 0, ry: 0 };
  const nx = clamp(((x - box.left) / box.width) * 2 - 1, -1, 1);
  const ny = clamp(((y - box.top) / box.height) * 2 - 1, -1, 1);
  const r = (v: number): number => Math.round(clamp(v * max, -max, max) * 100) / 100 || 0;
  return { rx: r(-ny), ry: r(nx) };
}

export const tiltTransform = (a: { rx: number; ry: number }): string => `perspective(${TILT_PERSPECTIVE_PX}px) rotateX(${a.rx}deg) rotateY(${a.ry}deg)`;

/** The current environment of this window. */
export function tiltEnv(): TiltEnv {
  const mq = (q: string): boolean => typeof matchMedia === 'function' && matchMedia(q).matches;
  return {
    reducedMotion: mq('(prefers-reduced-motion: reduce)'),
    lowEnd: typeof document !== 'undefined' && document.documentElement.dataset['lowEnd'] === 'true',
    touchOnly: mq('(hover: none)'),
  };
}

/**
 * Wires the tilt: `area` hears the pointer, `target` (the picture) is transformed. Returns the
 * cleanup. Nothing is attached when the tilt is not allowed.
 */
export function attachTilt(area: HTMLElement, target: HTMLElement, env: TiltEnv = tiltEnv()): () => void {
  if (!tiltAllowed(env)) return () => undefined;
  let frame = 0;
  let last: { x: number; y: number } | null = null;
  const apply = (): void => {
    frame = 0;
    if (!last) return;
    target.style.transform = tiltTransform(tiltAngles(last.x, last.y, area.getBoundingClientRect()));
  };
  const move = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    last = { x: e.clientX, y: e.clientY };
    target.style.transition = '';
    if (!frame) frame = requestAnimationFrame(apply);
  };
  const leave = (): void => {
    last = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    target.style.transition = `transform ${TILT_RETURN_MS}ms ease-out`;
    target.style.transform = tiltTransform({ rx: 0, ry: 0 });
  };
  area.addEventListener('pointermove', move);
  area.addEventListener('pointerleave', leave);
  return () => {
    area.removeEventListener('pointermove', move);
    area.removeEventListener('pointerleave', leave);
    if (frame) cancelAnimationFrame(frame);
  };
}
