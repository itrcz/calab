import { api } from '../lib/api/endpoints';
import { setApiHealth } from '../lib/api/client';
import { ServerHealth } from '../lib/api/health';
import { log } from '../lib/log';
import { queryClient } from '../lib/queryClient';
import { useSession } from '../stores/session';
import { resyncLoadedRooms, retryFailedLoads } from './chat';
import { voice } from './voice';

/**
 * The REST side of «Нет связи с сервером — восстанавливаем…» (ADR-0166, lib/api/health.ts).
 * While the server answers 503 (a database stall) the gateway socket may stay up: this is what
 * tells the user, and what brings every surface back on recovery — failed chat loads, loaded
 * windows (events may have been missed), queries left in error, a voice rejoin waiting out its
 * backoff. Nothing is dropped meanwhile: the UI stays as it was.
 */
let health: ServerHealth | null = null;

export function installServerHealth(): void {
  if (health) return;
  health = new ServerHealth({
    onChange: (serverDegraded) => {
      log.info(`server ${serverDegraded ? 'unavailable (API outage), probing' : 'available again'}`);
      useSession.getState().set({ serverDegraded });
    },
    onRecovered: () => {
      void retryFailedLoads();
      void resyncLoadedRooms();
      void queryClient.refetchQueries({ type: 'active', predicate: (q) => q.state.status === 'error' });
      voice.checkSeat(); // a rejoin waiting out its backoff goes now
    },
    probe: () => void api.me.get().catch(() => undefined),
    isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  });
  setApiHealth(health);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') health?.wake();
    });
    window.addEventListener('online', () => health?.wake());
  }
}

/** Logout: the indicator belongs to the session. */
export function resetServerHealth(): void {
  health?.reset();
}
