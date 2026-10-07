import { PresenceStatus } from '@calaba/protocol';
import { ReconnectBanner } from '../lib/gateway/banner';
import { GatewayClient, gatewayUrl, type GatewayFatal } from '../lib/gateway/client';
import { TabId } from '../lib/gateway/tabId';
import { log } from '../lib/log';
import { useSession } from '../stores/session';
import { isAway } from './afk';
import { applyDispatch } from './dispatch';
import { platform } from '../platform';
import { applyServerPresence } from './presenceTimer';
import type { LogoutReason } from '../../shared/ipc';

let client: GatewayClient | null = null;
/** Rooms we want typing/read-state for (SUBSCRIBE replaces the set; resent after READY/RESUMED). */
let subscribed: string[] = [];
/** «переподключаемся…» banner: only after a real drop > 3 s, gone at once on READY/RESUMED. */
const banner = new ReconnectBanner((reconnectBanner) => useSession.getState().set({ reconnectBanner }));
let wakeInstalled = false;
/**
 * Web: tabs of one browser share the auth session; each keeps its own gateway session under
 * its own tab id (#40). Desktop: none — one window = one device.
 */
let tab: TabId | null = null;
function tabIdentity(): TabId | null {
  if (!tab && platform.kind === 'web') tab = new TabId(safeSessionStorage());
  return tab;
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null; // storage blocked: the tab id lives in memory only
  }
}

/**
 * Timers of a hidden tab / a sleeping machine are throttled or frozen: when the window comes
 * back or the network returns, check the socket instead of waiting for them (GatewayClient.wake).
 */
function installWake(): void {
  if (wakeInstalled || typeof document === 'undefined') return;
  wakeInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') client?.wake();
  });
  window.addEventListener('online', () => client?.wake());
}

export function startGateway(onFatal: (kind: GatewayFatal, reason?: LogoutReason) => void): void {
  stopGateway();
  installWake();
  const s = useSession.getState();
  const info = s.appInfo;
  const tabId = tabIdentity();
  client = new GatewayClient({
    url: () => gatewayUrl(useSession.getState().serverUrl),
    getToken: () => platform.auth.accessToken(),
    refreshToken: () => platform.auth.forceRefresh(),
    device: { name: info?.hostname ?? 'desktop', platform: info?.platform ?? '', appVersion: info?.version ?? '' },
    createSocket: (url) => new WebSocket(url),
    onDispatch: (ev) => {
      try {
        applyDispatch(ev);
        // The manual status lives on the server (docs/05 «Presence»); READY / USER_UPDATE bring it.
        if (ev.event.case === 'ready') applyServerPresence(ev.event.value.presence, true);
        if (ev.event.case === 'userUpdate' && ev.event.value.presence) applyServerPresence(ev.event.value.presence, false);
        if (ev.event.case === 'ready' || ev.event.case === 'resumed') {
          if (subscribed.length) client?.subscribe(subscribed);
          if (isAway()) client?.setPresence(PresenceStatus.IDLE); // a new session starts online
        }
      } catch (e) {
        log.error('dispatch failed', ev.event.case, e);
      }
    },
    onStatus: (gateway) => {
      useSession.getState().set({ gateway });
      banner.update(gateway);
    },
    onFatal,
    log: (m) => log.info(m),
    ...(tabId && {
      tabId: () => tabId.get(),
      renewTabId: () => void tabId.renew(),
      isHidden: () => document.visibilityState === 'hidden',
    }),
  });
  client.start();
}

export function stopGateway(): void {
  client?.stop();
  client = null;
  banner.reset();
}

/** Logout: forget the previous account's room subscriptions (review L9). */
export function resetGatewaySubscriptions(): void {
  subscribed = [];
}

export function reconnectGateway(): void {
  client?.forceReconnect();
}

/** Reconnect now only if the socket is gone or dead (screen unlock, window shown, back online). */
export function wakeGateway(reason: 'visibility' | 'incoming-call' = 'visibility'): void {
  client?.wake(reason);
}

/** Fine-grained subscription (docs/05, SUBSCRIBE): the server sends TYPING_START only for these rooms. */
export function subscribeRooms(roomIds: string[]): void {
  subscribed = roomIds;
  client?.subscribe(roomIds);
}

export function sendTyping(roomId: string): void {
  client?.sendTyping(roomId);
}

/** `untilMs` given = a manual status for all devices (0 = no end), else this session's AFK status. */
export function setPresence(status: PresenceStatus, untilMs?: number): void {
  client?.setPresence(status, untilMs);
}

export function pruneGatewaySubscriptions(ids: ReadonlySet<string>): void {
  subscribeRooms(subscribed.filter((id) => !ids.has(id)));
}
