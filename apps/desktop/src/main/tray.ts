import { app, Menu, nativeTheme, Tray } from 'electron';
import { IPC, type TrayAction, type TrayState } from '../shared/ipc';
import { trayImage } from './icons';
import { getSettings } from './settings';
import { mainStrings, onMainStrings } from './strings';
import { getMainWindow, showMainWindow } from './windows';

let tray: Tray | null = null;
let state: TrayState = { inVoice: false, muted: false, deafened: false };
/** Mentions + unread DM messages (docs/09 item 22), shown in the tooltip. */
let badge = 0;
/** Version of the downloaded update («Перезапустить для обновления X»), null = none. */
let updateReady: string | null = null;
let installUpdate: () => void = () => undefined;

function send(action: TrayAction): void {
  if (action === 'show') {
    showMainWindow();
    return;
  }
  getMainWindow()?.webContents.send(IPC.trayAction, action);
}

function rebuild(): void {
  if (!tray) return;
  const s = mainStrings();
  const menu = Menu.buildFromTemplate([
    ...(updateReady
      ? [{ label: s.trayRestartUpdate.replaceAll('{version}', updateReady), click: () => installUpdate() }, { type: 'separator' as const }]
      : []),
    { label: s.trayOpen, click: () => send('show') },
    { type: 'separator' },
    { label: s.trayMute, type: 'checkbox', checked: state.muted, enabled: state.inVoice, click: () => send('toggle-mute') },
    { label: s.trayDeafen, type: 'checkbox', checked: state.deafened, enabled: state.inVoice, click: () => send('toggle-deafen') },
    { label: s.trayDisconnect, enabled: state.inVoice, click: () => send('disconnect') },
    { type: 'separator' },
    { label: s.trayQuit, click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  const base = state.inVoice ? (state.muted ? s.trayInVoiceMuted : s.trayInVoice) : 'Calab';
  tray.setToolTip(badge > 0 ? `${base} (${badge > 99 ? '99+' : badge})` : base);
}

export function createTray(): void {
  if (tray) return;
  tray = new Tray(trayImage(getSettings().monoTrayIcon));
  // The Windows taskbar light/dark switch is followed live (only the mono icon depends on it).
  if (process.platform === 'win32') nativeTheme.on('updated', refreshTrayIcon);
  tray.on('click', () => {
    if (process.platform !== 'darwin') showMainWindow();
  });
  rebuild();
  onMainStrings(rebuild);
}

/** Re-pick the icon: the «Монохромная иконка в трее» setting or the system theme changed. */
export function refreshTrayIcon(): void {
  if (tray) tray.setImage(trayImage(getSettings().monoTrayIcon));
}

/** Update status → the «Перезапустить для обновления X» item (main/updater.ts). */
export function setTrayUpdate(version: string | null, install: () => void): void {
  installUpdate = install;
  if (updateReady === version) return;
  updateReady = version;
  rebuild();
}

export function setTrayBadge(n: number): void {
  if (badge === n) return;
  badge = n;
  rebuild();
}

/** A voice room is joined (renderer tray state) — the quit confirmation asks (docs/09 #31). */
export const trayInVoice = (): boolean => state.inVoice;

/** Windows tray balloon; false where there is none (macOS, Linux) or no tray. */
export function showTrayBalloon(title: string, content: string): boolean {
  if (!tray || process.platform !== 'win32') return false;
  tray.displayBalloon({ title, content, iconType: 'info' });
  return true;
}

export function setTrayState(next: TrayState): void {
  state = next;
  rebuild();
}
