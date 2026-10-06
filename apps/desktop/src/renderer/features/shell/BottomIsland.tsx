import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { SelfPanel } from './SelfPanel';
import { VoiceBar } from './VoiceBar';
import { MeetingRecordPrompt } from '../calendar/RoomEvent';

/**
 * Bottom island (docs/08 «Нижний островок», Discord reference): «Голос подключён» and
 * the self panel as one floating block across the whole left part — from the rail's
 * left edge to the room column's right edge, 8 px in (4 px up from the bottom, so my avatar lands
 * on the rail's axis at the inset the old rail avatar had), radius 12, on the window layer. The rail
 * and the room list end above it: its height is published as `--island-height` on the parent
 * (their bottom padding).
 */
export function BottomIsland(): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const ro = new ResizeObserver(() => host.style.setProperty('--island-height', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      host.style.removeProperty('--island-height');
    };
  }, []);
  return (
    <div
      ref={ref}
      data-testid="bottom-island"
      data-island
      className="mat-toolbar absolute bottom-1 left-2 z-[var(--z-sticky)] flex flex-col divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] shadow-[var(--shadow-island)]"
      style={{ width: 'calc(var(--rail-width) + var(--sidebar-width) - 16px)' }}
    >
      <MeetingRecordPrompt />
      <VoiceBar />
      <SelfPanel />
    </div>
  );
}
