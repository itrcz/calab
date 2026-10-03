import { useMessages } from '../stores/messages';
import { useUi } from '../stores/ui';

/**
 * Long sessions (review M10): every room ever opened used to keep its whole loaded history.
 * Background rooms are cut to their newest KEEP messages right away and dropped completely
 * after IDLE_MS unopened (they reload from the API when opened; events for an unloaded room
 * are ignored by the store). The open room and rooms with unsent messages are never touched here;
 * the open room's own window is capped by the store (WINDOW_CAP, stores/messages) as it pages.
 */
export const KEEP = 200;
export const IDLE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;

/** Pure decision for one room (unit-tested). */
export function retentionAction(opts: { open: boolean; hasPending: boolean; idleMs: number }): 'keep' | 'trim' | 'unload' {
  if (opts.open) return 'keep';
  if (opts.idleMs >= IDLE_MS && !opts.hasPending) return 'unload';
  return 'trim';
}

function openRoomId(): string | null {
  const ui = useUi.getState();
  return ui.activeWorkspaceId ? (ui.lastRoom[ui.activeWorkspaceId] ?? null) : null;
}

let started = false;

export function startMessageRetention(): void {
  if (started) return;
  started = true;
  const lastSeen = new Map<string, number>();
  let current = openRoomId();
  const sweep = (): void => {
    const now = Date.now();
    const open = openRoomId();
    const store = useMessages.getState();
    for (const [roomId, r] of Object.entries(store.rooms)) {
      if (!lastSeen.has(roomId)) lastSeen.set(roomId, now);
      const action = retentionAction({
        open: roomId === open,
        hasPending: r.items.some((c) => c.status !== 'sent'),
        idleMs: now - (lastSeen.get(roomId) ?? now),
      });
      if (action === 'unload') {
        store.unload(roomId);
        lastSeen.delete(roomId);
      } else if (action === 'trim') store.trim(roomId, KEEP);
    }
  };
  useUi.subscribe(() => {
    const next = openRoomId();
    if (next === current) return;
    const now = Date.now();
    if (current) lastSeen.set(current, now); // left it now: idle from here
    if (next) lastSeen.set(next, now);
    current = next;
    sweep();
  });
  window.setInterval(sweep, SWEEP_MS);
}
