import { platform } from '../platform';
import { useSession } from '../stores/session';
import { badgeCount, useRooms } from '../stores/rooms';

let started = false;
let shown = -1;

/**
 * The app badge (docs/09 item 22): Dock / taskbar / tray and the window title show mentions of
 * me + unread DM messages (stores/rooms.ts badgeCount), not every unread message. Recomputed on
 * every rooms-store change; reading a room clears its share.
 */
export function startAppBadge(): void {
  if (started) return;
  started = true;
  const apply = (force = false): void => {
    // Do not overwrite an APNs count with an empty store while READY is loading.
    if (platform.notifications?.setBadge && !useSession.getState().ready) return;
    const n = badgeCount(useRooms.getState());
    if (n === shown && !force) return;
    shown = n;
    platform.app.setBadge(n);
    document.title = n > 0 ? `(${n > 99 ? '99+' : n}) Calab` : 'Calab';
  };
  apply();
  useRooms.subscribe(() => apply());
  useSession.subscribe((s, previous) => { if (s.ready && !previous.ready) apply(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') apply(true);
  });
}
