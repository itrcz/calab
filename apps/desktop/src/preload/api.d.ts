import type {
  AppInfo,
  AppSettings,
  AuthSession,
  CaptureSelection,
  CaptureSource,
  CheckoutWindowOutcome,
  DownloadArgs,
  LegalTexts,
  DownloadProgress,
  IpcResult,
  LoginArgs,
  LogoutReason,
  MainStrings,
  PowerEvent,
  PermissionStatus,
  PrivacyPane,
  ProcessMetrics,
  ScreenAccess,
  PttBinding,
  PttEvent,
  PttRawKey,
  PttStatus,
  RegisterArgs,
  TrayAction,
  TrayState,
  UpdateStatus,
  WebAppBounds,
  WebAppNavAction,
  WebAppNavState,
  WebAppTip,
} from '../shared/ipc';
import type { ThumbRequest } from '../shared/captureThumb';
import type { ResumeVoice, ResumeVoiceSeat } from '../shared/resumeVoice';
import type { MenuAction, MenuState } from '../shared/menu';
import type { AnnotOverlayEvent, AnnotOverlayTarget } from '../shared/annot';

type Unsubscribe = () => void;

/** API exposed to the renderer as `window.calaba` (see src/preload/index.ts). */
export interface CalabaApi {
  auth: {
    clearProtectedCache(): Promise<void>;
    recover(workspaceId: string, code: string): Promise<IpcResult<{ expiresAt: number }>>;
    ssoBegin(args: import('../shared/ipc').SsoStart): Promise<IpcResult<{ attemptId: string; expiresAt: number }>>;
    ssoCancel(attemptId: string): Promise<void>;
    onSsoResult(cb: (result: import('../shared/ipc').SsoResult) => void): Unsubscribe;
    /** Restores the stored session (refresh token in OS keychain). Rejects with 'offline' when the server is unreachable. */
    restore(): Promise<AuthSession | null>;
    login(args: LoginArgs): Promise<IpcResult<AuthSession>>;
    register(args: RegisterArgs): Promise<IpcResult<AuthSession>>;
    /** Guest sign-in by a room link (ADR-0016): creates a guest account, keeps its session like a login. */
    guestJoin(code: string, nickname: string): Promise<IpcResult<{ session: AuthSession; roomId: string; workspaceId: string; admission?: unknown }>>;
    logout(allSessions: boolean): Promise<void>;
    /** Fresh access JWT for the gateway IDENTIFY (null = logged out / offline). */
    accessToken(): Promise<string | null>;
    /** Forces a refresh after gateway close 4004; null = session is gone. */
    forceRefresh(): Promise<string | null>;
    /** Gateway close 4010: drop the local session without calling the server. */
    revoked(): Promise<void>;
    onLoggedOut(cb: (reason: LogoutReason) => void): Unsubscribe;
  };
  app: {
    info(): Promise<AppInfo>;
    getSettings(): Promise<AppSettings>;
    setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
    takeDeepLink(): Promise<string | null>;
    onDeepLink(cb: (url: string) => void): Unsubscribe;
    onPower(cb: (ev: PowerEvent) => void): Unsubscribe;
    /** Main closed the API connections after a stall / wake (docs/09 #146): retry failed loads. Web: never. */
    onApiReset(cb: () => void): Unsubscribe;
    checkUpdates(): Promise<UpdateStatus>;
    onUpdateStatus(cb: (s: UpdateStatus) => void): Unsubscribe;
    /** Current update status (after a renderer reload). */
    updateStatus(): Promise<UpdateStatus>;
    /**
     * «Перезапустить»: quit and install the downloaded update (main re-checks the feed first) —
     * at once, also during a call (the relaunched app rejoins it). false when none is downloaded.
     */
    installUpdate(): Promise<boolean>;
    /** «Скачать и установить»: download an `installable` available update; false when there is none. */
    downloadUpdate(): Promise<boolean>;
    /** Main is about to restart for an update: answer with setResumeVoice (docs/09 #126). */
    onPrepareRestart(cb: () => void): Unsubscribe;
    /** The answer to onPrepareRestart: the voice seat to take again after the relaunch, or null. */
    setResumeVoice(seat: ResumeVoiceSeat | null): Promise<void>;
    /** The seat left by the restart for an update, once per app run (null otherwise). */
    takeResumeVoice(): Promise<ResumeVoice | null>;
    /** The window's `online` event: main runs a throttled update check (main has no such event). */
    networkOnline(): void;
    log(level: 'info' | 'warn' | 'error', message: string): void;
    openExternal(url: string): Promise<void>;
    /**
     * A provider's hosted checkout (ADR-0084): the in-app checkout window on the desktop (rejects
     * for a URL off the provider allowlist), a new tab on the web (`external`). Resolves when the
     * person is back; the outcome is a hint, the checkout poll is the truth.
     */
    openCheckout(url: string): Promise<CheckoutWindowOutcome>;
    /** LICENSE, NOTICE and THIRD-PARTY-NOTICES.txt texts («О программе»). */
    legal(): Promise<LegalTexts>;
    /** Bounce the dock / flash the taskbar when the window is not focused. */
    attention(): void;
    /** The app badge: mentions + unread DM messages (0 clears it). */
    setBadge(n: number): void;
    setTheme(theme: 'dark' | 'light' | 'system'): void;
    /** Translated strings for the tray / notifications / window titles main shows (ADR-0022). */
    setStrings(strings: MainStrings): void;
  };
  tray: {
    setState(s: TrayState): void;
    onAction(cb: (a: TrayAction) => void): Unsubscribe;
  };
  /** macOS application / Dock menu (shared/menu.ts); a no-op elsewhere. */
  menu: {
    setState(s: MenuState): void;
    onAction(cb: (a: MenuAction) => void): Unsubscribe;
  };
  files: {
    /** Saves an attachment to ~/Downloads, reveals it, resolves with the path. */
    download(args: DownloadArgs): Promise<string>;
    /** Progress of downloads started with `download` (quarantined by Chromium's download manager). */
    onProgress(cb: (p: DownloadProgress) => void): Unsubscribe;
    /**
     * Drag-out of a chat image (main/dragOut.ts): fetches the original (an image attachment) into
     * the app's temp folder under its sanitized name; true once it is there. The web: false.
     */
    prepareDrag(args: DownloadArgs): Promise<boolean>;
    /** Starts the OS drag of a prepared file from this window; false when it is not ready. */
    startDrag(fileId: string): Promise<boolean>;
    /** Absolute path of a dropped/picked File (for display only). */
    pathOf(file: File): string;
    /**
     * A picture Chromium cannot decode (HEIC) as JPEG ≤ `maxSide`, decoded by the OS (macOS
     * always, Windows with the HEIF extension); null when it cannot (Linux, the web).
     */
    decodeImage(bytes: ArrayBuffer, maxSide: number): Promise<Uint8Array | null>;
  };
  capture: {
    /** Thumbnails at `thumbs` (device px per kind, shared/captureThumb); main clamps them. */
    listSources(thumbs?: ThumbRequest): Promise<CaptureSource[]>;
    /** Arms the next getDisplayMedia() call of this window with the chosen source. */
    selectSource(sel: CaptureSelection): Promise<void>;
  };
  ptt: {
    setBinding(binding: PttBinding | null): Promise<PttStatus>;
    /**
     * Resolves with the next key/mouse button pressed anywhere (global). Rejects on Esc,
     * `cancelCapture(id)`, a newer capture or after ~15 s. `id` identifies the caller (binder).
     */
    captureNext(id: number): Promise<PttBinding>;
    /** Disarms a pending `captureNext` started with the same `id` (the binder UI closed). */
    cancelCapture(id: number): void;
    status(): Promise<PttStatus>;
    onEvent(cb: (ev: PttEvent) => void): Unsubscribe;
    /** While a capture is armed: each raw key event seen by the hook (diagnostics line in the binder). */
    onRawKey(cb: (ev: PttRawKey) => void): Unsubscribe;
  };
  system: {
    openPrivacySettings(pane: PrivacyPane): Promise<void>;
    metrics(): Promise<ProcessMetrics>;
    /** OS permission statuses (onboarding, Settings → devices). */
    permissions(): Promise<PermissionStatus>;
    /** Ask the OS for microphone access (macOS prompt); resolves with the result. */
    requestMic(): Promise<boolean>;
    /** Screen Recording status and whether capture works in this process (no prompt). */
    screenAccess(): Promise<ScreenAccess>;
    /**
     * macOS: when not granted, makes a capture attempt (adds Calab to the Screen Recording list)
     * and opens that Privacy pane. Resolves with the status after the attempt.
     */
    requestScreenAccess(): Promise<ScreenAccess>;
    /** Quit and start the app again (a new Screen Recording grant needs it). */
    relaunch(): Promise<void>;
    /**
     * Seconds without keyboard/mouse input. Desktop: system-wide (powerMonitor, no permission
     * needed); web: input inside this tab only.
     */
    idleSeconds(): Promise<number>;
  };
  /**
   * Presenter's annotation overlay over the shared screen (ADR-0028). Web: no overlay (open →
   * false, the rest no-ops).
   */
  annotOverlay: {
    /** Opens (or re-targets) the overlay; false when this source / OS gets none. */
    open(target: AnnotOverlayTarget): Promise<boolean>;
    send(ev: AnnotOverlayEvent): void;
    close(): void;
  };
  /** This window (the caller's own BrowserWindow: the main window or a stream pop-out). */
  window: {
    /** Native full screen on / off; off restores the size saved on entry (docs/09 #18). */
    setFullScreen(on: boolean): Promise<boolean>;
    isFullScreen(): Promise<boolean>;
    /** Entered / left full screen, whoever caused it (our button, ⌃⌘F, the green button, Esc). */
    onFullScreenChange(cb: (on: boolean) => void): Unsubscribe;
    /**
     * On screen: shown and not minimized (the close button only hides the window). The page's own
     * visibility can't tell — `backgroundThrottling: false` keeps it «visible» (docs/14-energy.md).
     */
    isShown(): Promise<boolean>;
    onShownChange(cb: (shown: boolean) => void): Unsubscribe;
  };
  /**
   * Workspace web apps (ADR-0050 §4): main shows each site in its own sandboxed view over the
   * content area; the renderer only says which app, where, and ◀ ▶ ⟳. Electron only (the web
   * client embeds an iframe instead).
   */
  webApps?: {
    /** Show the app at `bounds` (CSS px of this window); loads `url` on first open or when it changed. */
    open(appId: string, url: string, bounds: WebAppBounds): Promise<void>;
    /** Hide the shown app (it stays alive, at most two do). */
    hide(): Promise<void>;
    setBounds(bounds: WebAppBounds): Promise<void>;
    navigate(action: WebAppNavAction): Promise<void>;
    /** The shown app's current page in the system browser. */
    openExternal(): Promise<void>;
    /** The app was deleted: its view and this device's site data of it go. */
    forget(appId: string): Promise<void>;
    onState(cb: (s: WebAppNavState) => void): Unsubscribe;
    /** Draw a tooltip that falls on the shown app above it (a native overlay; ADR-0053 «Поправка 1»). */
    tipShow(tip: WebAppTip): Promise<void>;
    tipHide(): Promise<void>;
  };
}

declare global {
  interface Window {
    calaba: CalabaApi;
  }
}
