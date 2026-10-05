import type { Me, SessionAuthority } from '@calaba/protocol';
import { create } from 'zustand';
import type { AppInfo, AppSettings, LogoutReason, UpdateStatus } from '../../shared/ipc';
import type { GatewayStatus } from '../lib/gateway/client';
import { hasPendingUpdate, type UpdateInput } from '../features/shell/updateBarModel';

export type AuthStatus = 'booting' | 'anon' | 'authed' | 'offline';

export interface SessionState {
  status: AuthStatus;
  serverUrl: string;
  sessionId: string;
  me: Me | null;
  authority: SessionAuthority | null;
  /** Where to ask for a paid plan (READY.plan_contact, ADR-0024): mailto: or https:; '' = unknown. */
  planContact: string;
  /**
   * EMAIL_VERIFICATION=optional on the server (ADR-0065: an unconfirmed address blocks nothing),
   * from the login / register answer, then READY. false = unknown or required (ADR-0023).
   */
  emailVerificationOptional: boolean;
  /** An email invitation waits for the unconfirmed address (ADR-0065): asked even when optional. */
  emailInvitePending: boolean;
  gateway: GatewayStatus;
  /** «Нет соединения с сервером» banner (lib/gateway/banner.ts decides). */
  reconnectBanner: boolean;
  /** Gateway READY received at least once for this login. */
  ready: boolean;
  /** Close 4008 before READY: too many active devices. */
  tooManySessions: boolean;
  loggedOutReason: LogoutReason | null;
  appInfo: AppInfo | null;
  settings: AppSettings | null;
  update: UpdateStatus;
  /** Web: the server's version (GET /api/version at READY) when newer than this bundle; '' = none. */
  webVersion: string;
  set: (patch: Partial<SessionState>) => void;
}

export const useSession = create<SessionState>()((set) => ({
  status: 'booting',
  serverUrl: '',
  sessionId: '',
  me: null,
  authority: null,
  planContact: '',
  emailVerificationOptional: false,
  emailInvitePending: false,
  gateway: 'idle',
  reconnectBanner: false,
  ready: false,
  tooManySessions: false,
  loggedOutReason: null,
  appInfo: null,
  settings: null,
  update: { state: 'disabled' },
  webVersion: '',
  set: (patch) => set(patch),
}));

export const myUserId = (): string => useSession.getState().me?.user?.id ?? '';

/** The update bar's input (features/shell/updateBarModel.ts) from the session. */
export const updateInputOf = (s: SessionState): UpdateInput => ({
  update: s.update,
  webVersion: s.webVersion,
  appVersion: s.appInfo?.version ?? '',
  autoUpdate: s.settings?.autoUpdate === true,
});

/** Selector: an update is waiting (gear dot, «Обновление» badge) — a boolean, cheap to subscribe. */
export const selectUpdatePending = (s: SessionState): boolean => hasPendingUpdate(updateInputOf(s));
