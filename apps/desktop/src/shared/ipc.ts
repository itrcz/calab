import type { KeySource } from './keySource';
import type { PttMode } from './pttGate';

/**
 * IPC contract between main and renderer (via preload). Keep it narrow:
 * every channel here is an explicit capability granted to the renderer.
 */
export const IPC = {
  // ---- auth (main is the token broker; the refresh token never leaves main) ----
  authIdentityClearCache: 'auth:identity-clear-cache',
  authIdentityRecover: 'auth:identity-recover',
  authSsoBegin: 'auth:sso-begin',
  authSsoCancel: 'auth:sso-cancel',
  authSsoResult: 'auth:sso-result',
  authRestore: 'auth:restore',
  authLogin: 'auth:login',
  authRegister: 'auth:register',
  authGuestJoin: 'auth:guest-join',
  authLogout: 'auth:logout',
  authAccessToken: 'auth:access-token',
  authForceRefresh: 'auth:force-refresh',
  /** main → renderer: the session ended (refresh failed / revoked / logout elsewhere). */
  authLoggedOut: 'auth:logged-out',

  // ---- app ----
  appInfo: 'app:info',
  appGetSettings: 'app:get-settings',
  appSetSettings: 'app:set-settings',
  appTakeDeepLink: 'app:take-deep-link',
  /** main → renderer */
  appDeepLink: 'app:deep-link',
  /** main → renderer: power events (resume after sleep → force gateway reconnect). */
  appPower: 'app:power',
  /** main → renderer: the API connections were reset after a stall — retry failed loads (docs/09 #146). */
  appApiReset: 'app:api-reset',
  appCheckUpdates: 'app:check-updates',
  /** The current update status (a reloaded renderer does not miss a downloaded update). */
  appGetUpdateStatus: 'app:get-update-status',
  /** Restart and install the downloaded update; arg `true` during a call: when the call ends. */
  appInstallUpdate: 'app:install-update',
  /** «Скачать и установить» in «О программе»: download an `installable` available update now. */
  appDownloadUpdate: 'app:download-update',
  /** main → renderer */
  appUpdateStatus: 'app:update-status',
  /**
   * main → renderer: the app restarts for an update now — answer with appResumeVoice (the voice
   * seat to take again after the relaunch, or null; docs/09 #126, main/resumeVoice.ts).
   */
  appPrepareRestart: 'app:prepare-restart',
  /** renderer → main: the answer to appPrepareRestart (ResumeVoiceSeat | null). */
  appResumeVoice: 'app:resume-voice',
  /** The seat left by the restart for an update (ResumeVoice | null), once per app run. */
  appTakeResumeVoice: 'app:take-resume-voice',
  /** renderer → main: the `online` event (main has none) — a throttled update check. */
  appNetworkOnline: 'app:network-online',
  appLog: 'app:log',
  appOpenExternal: 'app:open-external',
  appLegal: 'app:legal',
  appAttention: 'app:attention',
  /** Mentions + unread DM messages → Dock badge / badge count / tray tooltip (docs/09 item 22). */
  appSetBadge: 'app:set-badge',
  /** Renderer theme → nativeTheme.themeSource (the window background follows the app theme). */
  appSetTheme: 'app:set-theme',
  /** Renderer locale → the few strings main shows itself (tray, notifications, window titles; ADR-0022). */
  appSetStrings: 'app:set-strings',
  /** macOS permission statuses + requesting microphone access (onboarding). */
  systemPermissions: 'system:permissions',
  systemRequestMic: 'system:request-mic',
  /** Screen Recording status + whether capture actually works now (onboarding). */
  screenAccess: 'screen:access',
  /**
   * macOS: register the app in the Screen Recording list (a capture attempt — TCC lists an app
   * only after its first try) and open that Privacy pane (docs/09 P0 #3).
   */
  screenRequestAccess: 'screen:requestAccess',
  /** Quit and start again (macOS applies a new Screen Recording grant only after a relaunch). */
  appRelaunch: 'app:relaunch',

  // ---- tray ----
  trayState: 'tray:state',
  /** main → renderer */
  trayAction: 'tray:action',

  // ---- macOS application / Dock menu (shared/menu.ts) ----
  /** renderer → main: MenuState (voice summary, workspaces, capabilities, shortcut labels). */
  menuState: 'menu:state',
  /** main → renderer: a MenuAction id chosen in the menu bar / Dock menu. */
  menuAction: 'menu:action',

  // ---- files ----
  filesDownload: 'files:download',
  filesProgress: 'files:progress',
  /** Drag an image out of the window (main/dragOut.ts): fetch the original into temp ahead… */
  filesDragPrepare: 'files:drag-prepare',
  /** …then start the OS drag of that file from the sender's window. */
  filesDragStart: 'files:drag-start',
  /** A picture Chromium cannot decode (HEIC) → JPEG by the OS (main/imageDecode.ts); null = cannot. */
  filesDecodeImage: 'files:decode-image',

  // ---- media ----
  captureListSources: 'capture:list-sources',
  captureSelectSource: 'capture:select-source',
  /**
   * The sender's own BrowserWindow in native full screen (docs/09 #18: the stream's «На весь
   * экран»; macOS: its own Space on the window's display). Leaving restores the bounds saved on
   * entry. The main window and a stream pop-out each call it for themselves.
   */
  windowSetFullScreen: 'window:setFullScreen',
  windowIsFullScreen: 'window:isFullScreen',
  /** main → renderer: the window entered / left full screen (also by the OS: ⌃⌘F, green button). */
  windowFullScreenChanged: 'window:fullScreenChanged',
  /**
   * Presenter's annotation overlay (ADR-0028): open the click-through window over the shared
   * screen (false: not a whole screen / no content protection here), forward one validated
   * annotation of my stream, close it.
   */
  annotOverlayOpen: 'annot:overlay-open',
  annotOverlaySend: 'annot:overlay-send',
  annotOverlayClose: 'annot:overlay-close',
  // main → overlay page: ANNOT_OVERLAY_CHANNEL in shared/annot.ts (the overlay preload must not
  // share a module with this one: a shared chunk cannot be required by a sandboxed preload).
  /**
   * The window is on screen (shown and not minimized). Needed because `backgroundThrottling: false`
   * also pins the Page Visibility API to «visible» (lib/windowVisibility.ts, docs/14-energy.md).
   */
  windowIsShown: 'window:isShown',
  /** main → renderer: shown / hidden / minimized / restored. */
  windowShownChanged: 'window:shownChanged',
  pttSetBinding: 'ptt:set-binding',
  pttCaptureNext: 'ptt:capture-next',
  /** The binder closed: disarm a pending capture (review H2). */
  pttCancelCapture: 'ptt:cancel-capture',
  pttStatus: 'ptt:status',
  /** main → renderer push: PTT key pressed/released. */
  pttEvent: 'ptt:event',
  /** main → renderer push while a capture is armed: raw key event (PttRawKey, diagnostics). */
  pttRawKey: 'ptt:raw-key',
  systemOpenPrivacySettings: 'system:open-privacy-settings',
  /** CPU of this window's renderer + GPU process (dev stats panel). */
  systemMetrics: 'system:metrics',
  /** Seconds since the last keyboard/mouse input anywhere in the OS (AFK presence). */
  systemIdleSeconds: 'system:idle-seconds',

  // ---- workspace web apps (ADR-0050 §4): a WebContentsView per app, managed by main ----
  /** Show app `appId` at `bounds` (CSS px of the main window), loading `url` on first open or when it changed. */
  webAppOpen: 'webapp:open',
  /** Hide the shown app (back to rooms, an overlay over it); it stays alive (LRU 2). */
  webAppHide: 'webapp:hide',
  /** The content area moved / resized. */
  webAppSetBounds: 'webapp:set-bounds',
  /** ◀ ▶ ⟳ of the shown app (WebAppNavAction). */
  webAppNavigate: 'webapp:navigate',
  /** «Открыть в браузере»: the shown app's current page in the system browser. */
  webAppOpenExternal: 'webapp:open-external',
  /** The app was deleted: destroy its view, clear its session data and remembered permissions. */
  webAppForget: 'webapp:forget',
  /** main → renderer: WebAppNavState of an app (navigation, title, loading, failure). */
  webAppState: 'webapp:state',
  /** A tooltip over the shown app: drawn by a native overlay above it (WebAppTip; ADR-0053 «Поправка 1»). */
  webAppTipShow: 'webapp:tip-show',
  webAppTipHide: 'webapp:tip-hide',
} as const;

/** ◀ ▶ ⟳ of the navigation strip. */
export type WebAppNavAction = 'back' | 'forward' | 'reload';

export interface WebAppBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A tooltip the overlay draws over the app: `rect` in CSS px of the main window. */
export interface WebAppTip {
  text: string;
  /** The tooltip's shortcut hint ('' = none). */
  shortcut: string;
  rect: WebAppBounds;
  theme: 'dark' | 'light';
  side: 'top' | 'right' | 'bottom' | 'left';
}

/** A view's state for the navigation strip (updated by events, no polling). */
export interface WebAppNavState {
  appId: string;
  /** The current page (the strip shows its host). */
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** The page did not load (DNS, TLS, refused…): Chromium's error text; '' = fine. The view is hidden meanwhile. */
  failed: string;
  /** The page's process died: ⟳ creates it again. */
  crashed: boolean;
}

/** Scheme through which the renderer talks to the API; main adds auth and forwards. */
export const API_SCHEME = 'calaba-api';
/** `calaba-api://api/api/me` → `<serverUrl>/api/me`. */
export const API_ORIGIN = `${API_SCHEME}://api`;

// ---------------------------------------------------------------- auth

/** ApiError JSON (proto calaba.v1.ApiError, protojson) plus the HTTP status. */
export interface ApiErrorJson {
  code: string;
  message: string;
  field?: string;
  /** ApiError.reason, when the server gives one (e.g. SESSION_REVOKED: REUSE). */
  reason?: string;
  status: number;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: ApiErrorJson };

export interface AuthSession {
  serverUrl: string;
  sessionId: string;
  /** calaba.v1.Me as protojson; the renderer decodes it with MeSchema. */
  me: unknown;
  /** Public session authority, encoded using the generated schema. */
  authority?: unknown;
  /** Login / RegisterResponse.email_verification_optional (ADR-0065); absent = false. */
  emailVerificationOptional?: boolean;
  /** Login / RegisterResponse.email_invite_pending (ADR-0065); absent = false. */
  emailInvitePending?: boolean;
}

export interface LoginArgs {
  serverUrl: string;
  email: string;
  password: string;
}

export interface RegisterArgs extends LoginArgs {
  displayName: string;
  inviteCode: string;
  /** UI language (BCP 47) → the language of emails (ADR-0023); '' = the server decides. */
  locale?: string;
  /**
   * Ask the server whether the address looks like another account's first (docs/09 #119): on a
   * hit nothing is created and the result is an error with SIMILAR_ACCOUNT_CODE.
   */
  checkSimilar?: boolean;
}

/** Register result «an account on a sibling domain exists» (a hint, not a server error). */
export const SIMILAR_ACCOUNT_CODE = 'ERROR_CODE_SIMILAR_ACCOUNT';

/** A 2xx auth answer without tokens: the similar-account hint, else a broken response. */
export function noSession(similar: boolean | undefined, status: number): ApiErrorJson {
  return similar
    ? { code: SIMILAR_ACCOUNT_CODE, message: 'similar account exists', status }
    : { code: 'ERROR_CODE_INTERNAL', message: 'no session in the response', status };
}

/** The email-verification flags of a login / register answer (ADR-0065); only `true` is kept. */
export function verificationOf(data: {
  emailVerificationOptional?: boolean;
  emailInvitePending?: boolean;
}): Pick<AuthSession, 'emailVerificationOptional' | 'emailInvitePending'> {
  return {
    ...(data.emailVerificationOptional === true ? { emailVerificationOptional: true } : {}),
    ...(data.emailInvitePending === true ? { emailInvitePending: true } : {}),
  };
}

/** 'reset' = ended by reuse detection (after a connection loss), shared/logoutReason.ts. */
export type LogoutReason = 'logout' | 'expired' | 'revoked' | 'reset';

// ---------------------------------------------------------------- app

export interface AppSettings {
  /** API base URL, e.g. https://app.example.com (no trailing slash). */
  serverUrl: string;
  /** electron-updater generic feed URL; empty = updates off. */
  updateUrl: string;
  autostart: boolean;
  /**
   * «Автоматически обновлять» (default on): download in the background and install on restart /
   * quit where the platform can (Windows, Linux AppImage, signed macOS). Off → notify only.
   */
  autoUpdate: boolean;
  /**
   * «Проверять обновления автоматически» (default on): at start, hourly, after wake / unlock /
   * back online. Off → only «Проверить» in «О программе».
   */
  autoCheckUpdates: boolean;
  /**
   * Windows/Linux «При закрытии окна»: true (default) — hide to the tray, the call goes on;
   * false — quit (asks during a call). macOS ignores it: the close button always hides (docs/09 #31).
   */
  closeToTray: boolean;
  /**
   * macOS «Прозрачность окна» (default on, ADR-0075): native vibrancy behind the title bar, the
   * section rail and the room column. Off → solid materials. Ignored on Windows/Linux.
   */
  windowTranslucency: boolean;
  /** Main-owned: the one-time «Calab продолжает работать в трее» was shown. Not settable by the renderer. */
  trayHintShown: boolean;
}

/** Licence texts for «О программе» (BUSL-1.1 LICENSE, NOTICE, commercial terms, third-party notices). */
export interface LegalTexts {
  license: string;
  notice: string;
  commercial: string;
  thirdParty: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  hostname: string;
  electron: string;
  chrome: string;
  packaged: boolean;
  /** Test/automation flag (fake media devices). */
  fakeMedia: boolean;
  /** Test flag CALABA_FORCE_RELAY=1: ICE relay-only (checks the TURN/TLS 443 path). */
  forceRelay: boolean;
  /** Test flag CALABA_VISUAL_TEST=1: no animations (deterministic screenshots). */
  visualTest: boolean;
  systemAudioLoopback: 'supported' | 'experimental' | 'unsupported';
  micAccess: string;
  screenAccess: string;
  /** OS / app UI languages, most preferred first (`app.getLocale()`, then the system list; ADR-0022). */
  locales: string[];
}

/** Strings main shows itself, translated by the renderer (ADR-0022). Main starts with the Russian ones. */
export interface MainStrings {
  trayOpen: string;
  trayMute: string;
  trayDeafen: string;
  trayDisconnect: string;
  trayQuit: string;
  trayInVoice: string;
  trayInVoiceMuted: string;
  /** `{version}` placeholder. */
  updateAvailable: string;
  /** Tray item when an update is downloaded; `{version}` placeholder. */
  trayRestartUpdate: string;
  streamWindow: string;
  /** Native quit confirmation during a call (docs/09 #31). */
  quitInCall: string;
  quitInCallDetail: string;
  quitConfirm: string;
  quitCancel: string;
  /** One-time tray balloon / notification after the first close-to-tray (Windows/Linux). */
  trayHintTitle: string;
  trayHintBody: string;
  /** macOS application / Dock menu (docs/08 «Меню macOS», main/menuModel.ts). */
  menuAbout: string;
  menuCheckUpdates: string;
  menuSettings: string;
  menuServices: string;
  menuHide: string;
  menuHideOthers: string;
  menuShowAll: string;
  menuQuit: string;
  menuFile: string;
  menuNewMessage: string;
  menuCreateRoom: string;
  menuInvite: string;
  menuCloseWindow: string;
  menuEdit: string;
  menuUndo: string;
  menuRedo: string;
  menuCut: string;
  menuCopy: string;
  menuPaste: string;
  menuPasteMatch: string;
  menuDelete: string;
  menuSelectAll: string;
  menuEmoji: string;
  menuView: string;
  menuSearch: string;
  menuMembers: string;
  menuDms: string;
  menuZoomIn: string;
  menuZoomOut: string;
  menuZoomReset: string;
  menuFullScreen: string;
  menuDevelop: string;
  menuDevTools: string;
  menuReload: string;
  menuVoice: string;
  menuCamera: string;
  menuShareScreen: string;
  menuLeave: string;
  menuWindow: string;
  menuMinimize: string;
  menuZoom: string;
  menuFront: string;
  menuHelp: string;
  menuWhatsNew: string;
  menuShortcuts: string;
  menuDocs: string;
  menuReportIssue: string;
  /** Web app views (ADR-0050 §4): the permission dialog; `{site}`, `{what}` placeholders. */
  webAppAsk: string;
  webAppAskDetail: string;
  webAppAllow: string;
  webAppDeny: string;
  webAppCamera: string;
  webAppMicrophone: string;
  webAppNotifications: string;
  webAppGeolocation: string;
  webAppClipboard: string;
  /** The context menu inside a site. */
  webAppBack: string;
  webAppForward: string;
  webAppReload: string;
  webAppOpenLink: string;
  webAppCopyLink: string;
  webAppOpenPage: string;
}

export const MAIN_STRING_KEYS = [
  'trayOpen',
  'trayMute',
  'trayDeafen',
  'trayDisconnect',
  'trayQuit',
  'trayInVoice',
  'trayInVoiceMuted',
  'updateAvailable',
  'trayRestartUpdate',
  'streamWindow',
  'quitInCall',
  'quitInCallDetail',
  'quitConfirm',
  'quitCancel',
  'trayHintTitle',
  'trayHintBody',
  'menuAbout',
  'menuCheckUpdates',
  'menuSettings',
  'menuServices',
  'menuHide',
  'menuHideOthers',
  'menuShowAll',
  'menuQuit',
  'menuFile',
  'menuNewMessage',
  'menuCreateRoom',
  'menuInvite',
  'menuCloseWindow',
  'menuEdit',
  'menuUndo',
  'menuRedo',
  'menuCut',
  'menuCopy',
  'menuPaste',
  'menuPasteMatch',
  'menuDelete',
  'menuSelectAll',
  'menuEmoji',
  'menuView',
  'menuSearch',
  'menuMembers',
  'menuDms',
  'menuZoomIn',
  'menuZoomOut',
  'menuZoomReset',
  'menuFullScreen',
  'menuDevelop',
  'menuDevTools',
  'menuReload',
  'menuVoice',
  'menuCamera',
  'menuShareScreen',
  'menuLeave',
  'menuWindow',
  'menuMinimize',
  'menuZoom',
  'menuFront',
  'menuHelp',
  'menuWhatsNew',
  'menuShortcuts',
  'menuDocs',
  'menuReportIssue',
  'webAppAsk',
  'webAppAskDetail',
  'webAppAllow',
  'webAppDeny',
  'webAppCamera',
  'webAppMicrophone',
  'webAppNotifications',
  'webAppGeolocation',
  'webAppClipboard',
  'webAppBack',
  'webAppForward',
  'webAppReload',
  'webAppOpenLink',
  'webAppCopyLink',
  'webAppOpenPage',
] as const satisfies ReadonlyArray<keyof MainStrings>;

export type PowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';

export type UpdateStatus =
  | { state: 'disabled' }
  | { state: 'checking' }
  | { state: 'none' }
  /**
   * Notify-only (unsigned macOS, Linux without AppImage, «Автоматически обновлять» off):
   * `downloadPage` is the feed / download page the user opens.
   */
  | {
      state: 'available';
      version: string;
      downloadPage?: string;
      /**
       * The update can be downloaded and installed in place (pinned build feed, platform able to
       * apply it) — «Скачать и установить» in «О программе». Absent → only `downloadPage`.
       */
      installable?: true;
    }
  /** Download in progress; `percent` is an integer 0–100, `bytesPerSecond` once progress is known. */
  | { state: 'downloading'; version: string; percent: number; bytesPerSecond?: number }
  /** Ready: installs on «Перезапустить» (at once, also in a call) or on quit (docs/09 #125). */
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

export interface TrayState {
  inVoice: boolean;
  muted: boolean;
  deafened: boolean;
}

export type TrayAction = 'toggle-mute' | 'toggle-deafen' | 'disconnect' | 'show';

export interface DownloadArgs {
  fileId: string;
  name: string;
}

/** Attachment download progress (main → renderer), from Chromium's DownloadItem. */
export interface DownloadProgress {
  fileId: string;
  received: number;
  /** 0 = unknown. */
  total: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
}

// ---------------------------------------------------------------- media

export type CaptureSourceKind = 'screen' | 'window';

export interface CaptureSource {
  id: string;
  name: string;
  kind: CaptureSourceKind;
  /** PNG data URL at the requested thumbnail size (shared/captureThumb). Empty when the OS denied screen recording. */
  thumbnail: string;
  displayId: string;
  /** PNG data URL of the owning app's icon (windows only; empty when unknown). */
  appIcon?: string;
}

export interface CaptureSelection {
  sourceId: string;
  /** Request system audio loopback (see docs/02-media.md, rule 4). */
  audio: boolean;
}

/**
 * PTT binding. Desktop: global uiohook key/mouse codes. Web: DOM `KeyboardEvent.code`
 * or `Mouse<button>` (works only while the tab is focused, ADR-0015).
 */
/**
 * PTT binding. `key`/`mouse` codes are libuiohook codes (see shared/pttKeys.ts), `dom` is the
 * web fallback (`KeyboardEvent.code` / `Mouse<N>`). `mode` defaults to 'hold'.
 * `remap: 'caps-f18'` (macOS fallback without the HID listener): Caps Lock is remapped to F18 with
 * hidutil while Calaba runs, the binding listens to F18. `source` (informational): which hook
 * source delivered the key at capture — 'hid' = the macOS IOHIDManager listener (Caps Lock).
 */
export type { PttMode };

export type PttBinding =
  | { kind: 'key'; code: number; label: string; mode?: PttMode; remap?: 'caps-f18'; source?: KeySource }
  | { kind: 'mouse'; code: number; label: string; mode?: PttMode }
  | { kind: 'dom'; code: string; label: string; mode?: PttMode };

export interface PttStatus {
  active: boolean;
  binding: PttBinding | null;
  /** macOS: Accessibility / Input Monitoring trust; always true elsewhere. */
  trusted: boolean;
  error: string | null;
  /** macOS Caps Lock → F18 remap: 'active' while applied. */
  capsRemap: 'unsupported' | 'available' | 'active';
  /** Linux Wayland: no global key hooks (and the GlobalShortcuts portal has no Caps Lock). */
  wayland: boolean;
  /**
   * macOS IOHIDManager listener (physical Caps Lock): 'running'; 'denied' = no Input Monitoring;
   * 'restart' = granted since, reopen failed (restart Calab); 'off' until the hook starts.
   */
  hid: PttHidState;
}

export type PttHidState = 'unsupported' | 'off' | 'starting' | 'running' | 'denied' | 'restart' | 'error';

export interface PttEvent {
  down: boolean;
  /** Off without the release tail (toggle-off, gate reset); a hold key-up leaves it unset. */
  immediate?: boolean;
  /** Date.now() when main saw the key (debug: IPC + release latency). */
  at?: number;
}

/** main → renderer while a PTT capture is armed: the last raw key event (diagnostics line). */
export interface PttRawKey {
  code: number;
  rawcode: number;
  source: KeySource;
  down: boolean;
  /** Dropped as a duplicate of the other source (shared/keySource.ts). */
  dropped: boolean;
}

export type PrivacyPane = 'accessibility' | 'input-monitoring' | 'screen' | 'microphone' | 'camera';

export interface PermissionStatus {
  /** 'granted' | 'denied' | 'not-determined' | 'restricted' | 'n/a' */
  microphone: string;
  camera: string;
  screen: string;
  /** Accessibility trust (global PTT on macOS); true elsewhere. */
  accessibility: boolean;
  notifications: 'granted' | 'denied' | 'default' | 'n/a';
}

export interface ScreenAccess {
  /** systemPreferences.getMediaAccessStatus('screen'): 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown' | 'n/a' */
  status: string;
  /**
   * A probe capture returned real pixels. Only probed when `status` is 'granted': macOS may
   * report the grant while this process still cannot capture until it is relaunched.
   */
  canCapture: boolean;
}

export interface ProcessMetrics {
  /** % of one core (like ps/top), averaged since the previous sample. */
  rendererCpu: number | null;
  gpuCpu: number | null;
  mainCpu: number | null;
  rendererPid: number;
}

/** Public local handoff capability. No verifier, ticket or tokens cross IPC. */
export interface SsoStart {
  workspaceId: string;
  purpose: 'login' | 'step_up' | 'link' | 'test';
}
export interface SsoResult {
  /** Validated public same-session web navigation context, never credentials. */
  returnTo?: string;
  workspaceId: string;
  purpose: SsoStart['purpose'];
  ok: boolean;
  session?: AuthSession;
  error?: ApiErrorJson;
}
