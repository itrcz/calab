import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc';
import type { CalabaApi } from './api';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed per channel by the caller
function on<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, v: T): void => cb(v);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

// Narrow, typed bridge. No raw ipcRenderer is exposed to the renderer.
const api: CalabaApi = {
  auth: {
    clearProtectedCache: () => ipcRenderer.invoke(IPC.authIdentityClearCache),
    recover: (workspaceId, code) => ipcRenderer.invoke(IPC.authIdentityRecover, { workspaceId, code }),
    ssoBegin: (args) => ipcRenderer.invoke(IPC.authSsoBegin, args),
    ssoCancel: (id) => ipcRenderer.invoke(IPC.authSsoCancel, id),
    onSsoResult: (cb) => on(IPC.authSsoResult, cb),
    restore: () => ipcRenderer.invoke(IPC.authRestore),
    login: (a) => ipcRenderer.invoke(IPC.authLogin, a),
    register: (a) => ipcRenderer.invoke(IPC.authRegister, a),
    guestJoin: (code, nickname) => ipcRenderer.invoke(IPC.authGuestJoin, { code, nickname }),
    logout: (all) => ipcRenderer.invoke(IPC.authLogout, all),
    accessToken: () => ipcRenderer.invoke(IPC.authAccessToken),
    forceRefresh: () => ipcRenderer.invoke(IPC.authForceRefresh),
    revoked: () => ipcRenderer.invoke(IPC.authForceRefresh, 'revoked'),
    onLoggedOut: (cb) => on(IPC.authLoggedOut, cb),
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    getSettings: () => ipcRenderer.invoke(IPC.appGetSettings),
    setSettings: (p) => ipcRenderer.invoke(IPC.appSetSettings, p),
    takeDeepLink: () => ipcRenderer.invoke(IPC.appTakeDeepLink),
    onDeepLink: (cb) => on(IPC.appDeepLink, cb),
    onPower: (cb) => on(IPC.appPower, cb),
    onApiReset: (cb) => on(IPC.appApiReset, cb),
    checkUpdates: () => ipcRenderer.invoke(IPC.appCheckUpdates),
    onUpdateStatus: (cb) => on(IPC.appUpdateStatus, cb),
    updateStatus: () => ipcRenderer.invoke(IPC.appGetUpdateStatus),
    installUpdate: () => ipcRenderer.invoke(IPC.appInstallUpdate),
    downloadUpdate: () => ipcRenderer.invoke(IPC.appDownloadUpdate),
    onPrepareRestart: (cb) => on(IPC.appPrepareRestart, cb),
    setResumeVoice: (seat) => ipcRenderer.invoke(IPC.appResumeVoice, seat),
    takeResumeVoice: () => ipcRenderer.invoke(IPC.appTakeResumeVoice),
    networkOnline: () => void ipcRenderer.invoke(IPC.appNetworkOnline),
    log: (level, message) => void ipcRenderer.invoke(IPC.appLog, { level, message }),
    openExternal: (url) => ipcRenderer.invoke(IPC.appOpenExternal, url),
    openCheckout: (url) => ipcRenderer.invoke(IPC.appOpenCheckout, url),
    legal: () => ipcRenderer.invoke(IPC.appLegal),
    attention: () => void ipcRenderer.invoke(IPC.appAttention),
    setBadge: (n) => void ipcRenderer.invoke(IPC.appSetBadge, n),
    setTheme: (theme) => void ipcRenderer.invoke(IPC.appSetTheme, theme),
    setStrings: (s) => void ipcRenderer.invoke(IPC.appSetStrings, s),
  },
  tray: {
    setState: (s) => void ipcRenderer.invoke(IPC.trayState, s),
    onAction: (cb) => on(IPC.trayAction, cb),
  },
  menu: {
    setState: (s) => void ipcRenderer.invoke(IPC.menuState, s),
    onAction: (cb) => on(IPC.menuAction, cb),
  },
  files: {
    download: (a) => ipcRenderer.invoke(IPC.filesDownload, a),
    onProgress: (cb) => on(IPC.filesProgress, cb),
    prepareDrag: (a) => ipcRenderer.invoke(IPC.filesDragPrepare, a),
    startDrag: (fileId) => ipcRenderer.invoke(IPC.filesDragStart, fileId),
    pathOf: (f) => webUtils.getPathForFile(f),
    decodeImage: (bytes, maxSide) => ipcRenderer.invoke(IPC.filesDecodeImage, { bytes, maxSide }),
  },
  capture: {
    listSources: (thumbs) => ipcRenderer.invoke(IPC.captureListSources, thumbs),
    selectSource: (sel) => ipcRenderer.invoke(IPC.captureSelectSource, sel),
  },
  ptt: {
    setBinding: (b) => ipcRenderer.invoke(IPC.pttSetBinding, b),
    captureNext: (id: number) => ipcRenderer.invoke(IPC.pttCaptureNext, id),
    cancelCapture: (id: number) => void ipcRenderer.invoke(IPC.pttCancelCapture, id),
    status: () => ipcRenderer.invoke(IPC.pttStatus),
    onEvent: (cb) => on(IPC.pttEvent, cb),
    onRawKey: (cb) => on(IPC.pttRawKey, cb),
  },
  system: {
    openPrivacySettings: (pane) => ipcRenderer.invoke(IPC.systemOpenPrivacySettings, pane),
    metrics: () => ipcRenderer.invoke(IPC.systemMetrics),
    permissions: () => ipcRenderer.invoke(IPC.systemPermissions),
    requestMic: () => ipcRenderer.invoke(IPC.systemRequestMic),
    screenAccess: () => ipcRenderer.invoke(IPC.screenAccess),
    requestScreenAccess: () => ipcRenderer.invoke(IPC.screenRequestAccess),
    relaunch: () => ipcRenderer.invoke(IPC.appRelaunch),
    idleSeconds: () => ipcRenderer.invoke(IPC.systemIdleSeconds),
  },
  annotOverlay: {
    open: (target) => ipcRenderer.invoke(IPC.annotOverlayOpen, target),
    send: (ev) => void ipcRenderer.invoke(IPC.annotOverlaySend, ev),
    close: () => void ipcRenderer.invoke(IPC.annotOverlayClose),
  },
  window: {
    setFullScreen: (on) => ipcRenderer.invoke(IPC.windowSetFullScreen, on),
    isFullScreen: () => ipcRenderer.invoke(IPC.windowIsFullScreen),
    onFullScreenChange: (cb) => on(IPC.windowFullScreenChanged, cb),
    isShown: () => ipcRenderer.invoke(IPC.windowIsShown),
    onShownChange: (cb) => on(IPC.windowShownChanged, cb),
  },
  webApps: {
    open: (appId, url, bounds) => ipcRenderer.invoke(IPC.webAppOpen, { appId, url, bounds }),
    hide: () => ipcRenderer.invoke(IPC.webAppHide),
    setBounds: (bounds) => ipcRenderer.invoke(IPC.webAppSetBounds, bounds),
    navigate: (action) => ipcRenderer.invoke(IPC.webAppNavigate, action),
    openExternal: () => ipcRenderer.invoke(IPC.webAppOpenExternal),
    forget: (appId) => ipcRenderer.invoke(IPC.webAppForget, appId),
    onState: (cb) => on(IPC.webAppState, cb),
    tipShow: (tip) => ipcRenderer.invoke(IPC.webAppTipShow, tip),
    tipHide: () => ipcRenderer.invoke(IPC.webAppTipHide),
  },
};

contextBridge.exposeInMainWorld('calaba', api);
