/**
 * «An image of ours is being dragged out» (features/chat/imageDragOut.ts). The OS drag carries the
 * image as a file (`Files`), so our own drop targets — the chat's file zone, the sidebar's chat
 * rows — would take it for a file from Finder and upload it again. They ask this first.
 *
 * Electron's drag is the OS's (`startDrag`): the window gets no `dragend`, and the drop may reach
 * the renderer just after the drag call returned — so the flag lingers for END_GRACE_MS after the
 * end. Pure: no timers, `now` is passed in by tests.
 */

export const END_GRACE_MS = 1000;

let active = false;
let endedAt = Number.NEGATIVE_INFINITY;

export function beginDragOut(): void {
  active = true;
}

export function endDragOut(now: number = performance.now()): void {
  if (!active) return;
  active = false;
  endedAt = now;
}

export function dragOutActive(now: number = performance.now()): boolean {
  return active || now - endedAt < END_GRACE_MS;
}
