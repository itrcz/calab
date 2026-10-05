import type { HostCallsCapability } from '../../shared/hostCalls';
import type { CalabaApi } from '../../preload/api';
import type { AuthSession, IpcResult } from '../../shared/ipc';
import type { SessionActivityCapability, HostNotificationsCapability } from '../../shared/hostActivity';

/** Result of a guest sign-in by a room link (ADR-0016). */
export interface GuestJoin {
  session: AuthSession;
  roomId: string;
  workspaceId: string;
  /** Set = the guest waits for the organizer (ADR-0040): the RoomAdmission as JSON. */
  admission?: unknown;
}

/**
 * Platform layer (ADR-0015): everything the renderer needs from its host.
 * `electron` — preload bridge (IPC to main); `web` — browser APIs, same-origin API.
 */
export interface Platform extends CalabaApi {
  /** Optional status-only phone host capability; absent in ordinary browsers/older hosts. */
  sessionActivity?: SessionActivityCapability;
  notifications?: HostNotificationsCapability;
  incomingCalls?: HostCallsCapability;
  kind: 'electron' | 'web';
  finishSso?(): Promise<import('../../shared/ipc').IpcResult<import('../../shared/ipc').SsoResult>>;
  /** Prefix for API paths (`calaba-api://api` in Electron, '' on the web = same origin). */
  apiBase: string;
  /** The host can capture a screen / window (Electron always; the web needs `getDisplayMedia`, phones have none). */
  canShareScreen(): boolean;
  /** Authenticated API request (Bearer + one refresh-and-retry on 401 where needed). */
  apiFetch(path: string, init?: RequestInit): Promise<Response>;
  /** Headers for requests the platform cannot wrap itself (XHR uploads). */
  authHeaders(): Promise<Record<string, string>>;
  /**
   * URL usable in <img>/<video> for an API media path. Electron: direct (main adds auth).
   * Web: a blob: URL of an authenticated fetch (cached).
   */
  mediaUrl(path: string): Promise<string>;
  /** Whether the platform can hand out a synchronous media URL (no blob fetch needed). */
  directMedia: boolean;
  clearProtectedMedia?(): void;
  /**
   * Guest sign-in by a room link without an account (POST /api/room-invites/{code}/join with a
   * nickname, ADR-0016). Web only; undefined where the host cannot adopt a session (Electron:
   * tokens live in main — the guest path there is the browser).
   */
  guestJoin?: (code: string, nickname: string) => Promise<IpcResult<GuestJoin>>;
}
