import { LOCALE_STORAGE_KEY, type Locale } from '@/i18n/locales';

export const PREFERENCES_KEY = 'calab.site-preferences';
export const PREFERENCES_VERSION = 1;
export const PREFERENCES_TTL = 180 * 24 * 60 * 60 * 1000;
export const PREFERENCES_CHANGED = 'calab:preferences-changed';
export const OPEN_PREFERENCES = 'calab:open-preferences';

// No vendors are connected yet. Adding one requires a disclosed provider/purpose,
// a version bump (fresh choice), and consent-gated loading, including after withdrawal.
export const AVAILABLE_PURPOSES = { language: true, analytics: false, marketing: false } as const;
export type OptionalPurpose = keyof typeof AVAILABLE_PURPOSES;
export type SitePreferences = {
  version: number;
  savedAt: number;
  expiresAt: number;
  language: boolean;
  analytics: boolean;
  marketing: boolean;
};

export function parsePreferences(raw: string | null | undefined, now = Date.now()): SitePreferences | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const p = value as Partial<SitePreferences>;
    if (p.version !== PREFERENCES_VERSION || typeof p.savedAt !== 'number' || !Number.isFinite(p.savedAt) ||
      typeof p.expiresAt !== 'number' || !Number.isFinite(p.expiresAt) || p.savedAt > now ||
      p.expiresAt <= now || p.expiresAt > p.savedAt + PREFERENCES_TTL ||
      typeof p.language !== 'boolean' || p.analytics !== false || p.marketing !== false) return null;
    return p as SitePreferences;
  } catch {
    return null;
  }
}

export function readPreferences(): string | null {
  try { return localStorage.getItem(PREFERENCES_KEY); } catch { return null; }
}

export function removeSavedLanguage() {
  try { localStorage.removeItem(LOCALE_STORAGE_KEY); } catch { /* Unavailable storage stays optional-off. */ }
}

export function hasSiteConsent(purpose: OptionalPurpose): boolean {
  const preferences = parsePreferences(readPreferences());
  if (!preferences?.language) removeSavedLanguage();
  return AVAILABLE_PURPOSES[purpose] && preferences?.[purpose] === true;
}

export function rememberLocale(locale: Locale) {
  if (!hasSiteConsent('language')) return;
  try { localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Navigation still works. */ }
}

export function savePreferences(language: boolean, locale: Locale): boolean {
  const now = Date.now();
  const preferences: SitePreferences = {
    version: PREFERENCES_VERSION, savedAt: now, expiresAt: now + PREFERENCES_TTL,
    language, analytics: false, marketing: false,
  };
  try {
    // Remove a previous grant first, so a failed write never grants optional storage.
    localStorage.removeItem(LOCALE_STORAGE_KEY);
    localStorage.removeItem(PREFERENCES_KEY);
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    if (language) localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    window.dispatchEvent(new Event(PREFERENCES_CHANGED));
    return true;
  } catch {
    removeSavedLanguage();
    try { localStorage.removeItem(PREFERENCES_KEY); } catch { /* Storage is blocked. */ }
    window.dispatchEvent(new Event(PREFERENCES_CHANGED));
    return false;
  }
}

export function subscribePreferences(onChange: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === PREFERENCES_KEY || event.key === null) onChange();
  };
  window.addEventListener('storage', storage);
  window.addEventListener(PREFERENCES_CHANGED, onChange);
  return () => {
    window.removeEventListener('storage', storage);
    window.removeEventListener(PREFERENCES_CHANGED, onChange);
  };
}

// Used by useSyncExternalStore to keep the initial server/client render identical.
export const serverPreferences = (): undefined => undefined;
