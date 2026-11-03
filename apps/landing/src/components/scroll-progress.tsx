'use client';
import { useEffect, useRef } from 'react';

/**
 * A thin bar on the right edge filling top → bottom with the page scroll. Where CSS scroll-driven animations exist
 * (`animation-timeline: scroll()`) it is pure CSS and costs no JS; elsewhere a passive scroll listener writes one custom
 * property per frame (rAF). Nothing runs while the tab is hidden (no scroll, no frames) and there is no smoothing.
 */
export function ScrollProgress() {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el || (typeof CSS !== 'undefined' && CSS.supports('animation-timeline', 'scroll()'))) return;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const room = document.documentElement.scrollHeight - window.innerHeight;
      el.style.setProperty('--p', room > 0 ? String(Math.min(1, Math.max(0, window.scrollY / room))) : '0');
    };
    const onScroll = () => {
      if (!frame && document.visibilityState === 'visible') frame = requestAnimationFrame(paint);
    };
    paint();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <div ref={bar} className="scroll-progress" aria-hidden="true">
      <i />
    </div>
  );
}
