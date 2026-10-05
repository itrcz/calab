import { API_ORIGIN } from '../../shared/ipc';
import type { Platform } from './types';

/** Electron: everything goes through the preload bridge; API via the calaba-api:// scheme. */
export function createElectronPlatform(): Platform {
  const c = window.calaba;
  return {
    ...c,
    kind: 'electron',
    canShareScreen: () => true,
    apiBase: API_ORIGIN,
    apiFetch: (path, init) => fetch(`${API_ORIGIN}${path}`, init),
    authHeaders: () => Promise.resolve({}),
    mediaUrl: (path) => Promise.resolve(`${API_ORIGIN}${path}`),
    directMedia: true,
    clearProtectedMedia: () => {
      void c.auth.clearProtectedCache();
    },
    // Room links (ADR-0016): the guest session is created and kept by main (keychain), like a login.
    guestJoin: (code, nickname) => c.auth.guestJoin(code, nickname),
  };
}
