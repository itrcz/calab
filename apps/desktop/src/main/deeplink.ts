import { app } from 'electron';
import { IPC } from '../shared/ipc';
import { getMainWindow, showMainWindow } from './windows';
import { isSsoDeepLink } from './ssoHandoff';

/**
 * Deep links: `calab://join/<code>` (workspace invite, docs/04), `calab://mail/…` (ADR-0088 §12: the
 * add-account payload carries a password — never logged here or in the renderer) and `calab://r/<code>` (room link,
 * ADR-0016). `calaba://` — the scheme before the rename (docs/10) — stays registered as an alias
 * so links already shared keep opening the app.
 */
export const PROTOCOLS = ['calab', 'calaba'] as const;

const isDeepLink = (s: string): boolean => PROTOCOLS.some((p) => s.startsWith(`${p}://`));

let pending: string | null = null;
let ssoHandler: ((url: string) => Promise<unknown>) | null = null;

/** Main-only hook. Reserved SSO links are dropped when no broker is installed. */
export function setSsoDeepLinkHandler(handler: ((url: string) => Promise<unknown>) | null): void {
  ssoHandler = handler;
}

export function registerProtocolClient(): void {
  if (process.defaultApp && process.argv.length >= 2 && process.argv[1]) {
    // Dev: electron <entry> — register with the entry script so the OS can launch us.
    for (const p of PROTOCOLS) app.setAsDefaultProtocolClient(p, process.execPath, [process.argv[1]]);
  } else {
    for (const p of PROTOCOLS) app.setAsDefaultProtocolClient(p);
  }
}

export function findDeepLink(argv: readonly string[]): string | null {
  return argv.find(isDeepLink) ?? null;
}

export function handleDeepLink(url: string): void {
  if (isSsoDeepLink(url)) {
    // Never queue/forward callback tickets, including malformed or unknown flows.
    try { void ssoHandler?.(url).catch(() => undefined); } catch { /* No raw callback logging. */ }
    return;
  }
  if (!isDeepLink(url) || url.length > 512) return;
  const win = getMainWindow();
  if (win && !win.webContents.isLoading()) {
    win.webContents.send(IPC.appDeepLink, url);
    showMainWindow();
  } else {
    pending = url;
  }
}

/** Renderer pulls a link that arrived before it was ready. */
export function takePendingDeepLink(): string | null {
  const u = pending;
  pending = null;
  return u;
}
