import { Component, createRef, type ReactNode } from 'react';

/**
 * The iOS push / pop of the phone's screens (ADR-0073, owner 07.10): the new screen slides in from
 * the right over the old one, which shifts a little to the left; a pop slides the top screen out to
 * the right over the one that comes back. ~250 ms, `transform` / `opacity` only (compositor, no
 * layout), one-shot Web Animations — nothing runs after they finish.
 *
 * Only the top screen stays mounted (the perf rule of ADR-0073): the outgoing screen is not kept in
 * React but copied as inert DOM just before React replaces it (getSnapshotBeforeUpdate), shown
 * for the length of the animation and then removed. No animation with `prefers-reduced-motion`, in
 * the «Слабый компьютер» mode (`data-low-end` on the root) or while the window is hidden.
 */

export const SCREEN_MS = 250;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
/** How far the screen beneath shifts (a fraction of the width), as iOS does. */
const PARALLAX = '-28%';
const SHADOW = '-10px 0 24px -6px rgb(0 0 0 / 0.28)';

export function motionOff(): boolean {
  if (typeof window === 'undefined' || typeof Element.prototype.animate !== 'function') return true;
  const root = document.documentElement;
  return root.dataset['lowEnd'] === 'true' || root.classList.contains('window-hidden') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface Snap {
  clone: HTMLElement;
  /** [index in the subtree, scrollTop, scrollLeft] of the scrolled boxes: a copy starts at the top. */
  scrolls: Array<[number, number, number]>;
}

/** An inert copy of the outgoing screen: no ids / test ids (they would be found twice), hidden from assistive tech. */
function snapshot(live: HTMLElement): Snap {
  const clone = live.cloneNode(true) as HTMLElement;
  const scrolls: Snap['scrolls'] = [];
  const src = live.querySelectorAll<HTMLElement>('*');
  src.forEach((el, i) => {
    if (el.scrollTop > 0 || el.scrollLeft > 0) scrolls.push([i, el.scrollTop, el.scrollLeft]);
  });
  clone.querySelectorAll('[id], [data-testid]').forEach((el) => {
    el.removeAttribute('id');
    el.removeAttribute('data-testid');
  });
  clone.removeAttribute('data-testid');
  clone.setAttribute('aria-hidden', 'true');
  clone.setAttribute('inert', '');
  clone.setAttribute('data-screen-ghost', '');
  return { clone, scrolls };
}

export class ScreenTransition extends Component<{ depth: number; children: ReactNode }> {
  private live = createRef<HTMLDivElement>();
  private ghost: HTMLElement | null = null;
  private anims: Animation[] = [];

  override getSnapshotBeforeUpdate(prev: { depth: number }): Snap | null {
    const live = this.live.current;
    if (!live || prev.depth === this.props.depth || motionOff()) return null;
    this.finish();
    return snapshot(live);
  }

  override componentDidUpdate(prev: { depth: number }, _state: unknown, snap: Snap | null): void {
    const live = this.live.current;
    const host = live?.parentElement;
    if (!snap || !live || !host) return;
    const push = this.props.depth > prev.depth;
    const { clone } = snap;
    Object.assign(clone.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: push ? '0' : '2', backgroundColor: 'var(--color-bg)' });
    host.appendChild(clone);
    const nodes = clone.querySelectorAll<HTMLElement>('*');
    for (const [i, top, left] of snap.scrolls) {
      const el = nodes[i];
      if (el) {
        el.scrollTop = top;
        el.scrollLeft = left;
      }
    }
    this.ghost = clone;
    // The upper layer carries the edge shadow and an opaque plate; the lower one shifts and dims.
    const upper = push ? live : clone;
    const lower = push ? clone : live;
    live.style.zIndex = push ? '2' : '1';
    live.style.backgroundColor = 'var(--color-bg)';
    upper.style.boxShadow = SHADOW;
    const opts: KeyframeAnimationOptions = { duration: SCREEN_MS, easing: EASE, fill: 'both' };
    const slide = push ? [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }] : [{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }];
    const shift = push ? [{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${PARALLAX})`, opacity: 0.6 }] : [{ transform: `translateX(${PARALLAX})`, opacity: 0.6 }, { transform: 'translateX(0)', opacity: 1 }];
    this.anims = [upper.animate(slide, opts), lower.animate(shift, opts)];
    void Promise.all(this.anims.map((a) => a.finished)).then(
      () => this.finish(),
      () => undefined, // cancelled by the next transition, which cleans up itself
    );
  }

  override componentWillUnmount(): void {
    this.finish();
  }

  /** The animation is over (or interrupted): the copy goes, the live screen is plain again. */
  private finish(): void {
    for (const a of this.anims) a.cancel();
    this.anims = [];
    this.ghost?.remove();
    this.ghost = null;
    const live = this.live.current;
    if (live) {
      live.style.zIndex = '';
      live.style.backgroundColor = '';
      live.style.boxShadow = '';
    }
  }

  override render(): ReactNode {
    return (
      <div ref={this.live} className="relative flex min-h-0 flex-1 flex-col">
        {this.props.children}
      </div>
    );
  }
}
