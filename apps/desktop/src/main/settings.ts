import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import type { AppSettings } from '../shared/ipc';

/**
 * Device-level app settings (userData/settings.json). Configuration comes from
 * env / build-time env only — no hosts are hard-coded (CLAUDE.md):
 * CALABA_SERVER_URL at runtime, MAIN_VITE_DEFAULT_SERVER_URL at build time.
 */
function defaultServerUrl(): string {
  const url = process.env['CALABA_SERVER_URL'] ?? import.meta.env.MAIN_VITE_DEFAULT_SERVER_URL ?? '';
  return normalizeServerUrl(url);
}

export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

const DEFAULTS = (): AppSettings => ({
  serverUrl: defaultServerUrl(),
  updateUrl: process.env['CALABA_UPDATE_URL'] ?? import.meta.env.MAIN_VITE_UPDATE_FEED ?? '',
  autostart: false,
  autoUpdate: true,
  autoCheckUpdates: true,
  closeToTray: true,
  windowTranslucency: true,
  trayHintShown: false,
});

let cache: AppSettings | null = null;

function file(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export function getSettings(): AppSettings {
  if (cache) return cache;
  let stored: Partial<AppSettings> = {};
  try {
    stored = JSON.parse(readFileSync(file(), 'utf8')) as Partial<AppSettings>;
  } catch {
    // first run or corrupt file → defaults
  }
  cache = { ...DEFAULTS(), ...stored };
  // Explicit env wins over a stored value (tests, staging builds).
  if (process.env['CALABA_SERVER_URL']) cache.serverUrl = defaultServerUrl();
  return cache;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...getSettings(), ...patch };
  next.serverUrl = normalizeServerUrl(next.serverUrl);
  cache = next;
  const f = file();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(next, null, 2));
  renameSync(`${f}.tmp`, f);
  if (patch.autostart !== undefined && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: next.autostart });
  }
  return next;
}
