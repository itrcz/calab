'use client';

import { X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { COOKIE_COPY } from '@/i18n/cookies';
import { localePath, type Locale } from '@/i18n/locales';
import {
  OPEN_PREFERENCES, parsePreferences, readPreferences, removeSavedLanguage,
  savePreferences, serverPreferences, subscribePreferences,
} from '@/lib/site-preferences';

export function CookieSettingsButton({ children }: { children: React.ReactNode }) {
  return <button type="button" className="cursor-pointer rounded-md text-left hover:text-fg" onClick={() => window.dispatchEvent(new Event(OPEN_PREFERENCES))}>{children}</button>;
}

/** A cookie in the sticker style (thick dark outline, white rim, flat fills), decorative. */
function CookieIcon() {
  return (
    <svg className="cookie-icon" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
      <path d="M22 3.5a5.5 5.5 0 0 0 6.6 6.4 6 6 0 0 0 6.3 6.6A18.5 18.5 0 1 1 22 3.5Z" fill="#fff" />
      <path d="M22 6.5a5.5 5.5 0 0 0 6 5.6 6 6 0 0 0 5.6 6.1A15.5 15.5 0 1 1 22 6.5Z" fill="#f6b24a" stroke="#111" strokeWidth="2.2" strokeLinejoin="round" />
      <circle cx="16" cy="18" r="2.4" fill="#5b3214" />
      <circle cx="24.5" cy="26" r="2.6" fill="#5b3214" />
      <circle cx="15" cy="29" r="2" fill="#5b3214" />
      <circle cx="29.5" cy="21" r="1.8" fill="#5b3214" />
      <circle cx="21" cy="34" r="1.6" fill="#5b3214" />
    </svg>
  );
}

/**
 * The consent banner: asked once (no floating button afterwards); the choice is kept for 180 days and the footer
 * link «Настройки cookies» reopens it with the per-purpose switches. Yandex Metrika loads only after `analytics`.
 */
export function CookiePreferences({ locale }: { locale: Locale }) {
  const t = COOKIE_COPY[locale];
  // The app-mode legal pages (#139, docs/adr/0148) stay inside app mode: the public cookies page
  // carries the landing header/footer (pricing, the public offer, payments), which a native-shell
  // reviewer must not reach from a privacy/terms page in one more tap.
  const pathname = usePathname();
  const inAppMode = pathname.includes('/legal/app/');
  const cookiesHref = inAppMode ? `${localePath(locale, 'legal/app/')}cookies/` : localePath(locale, 'legal/cookies/');
  const raw = useSyncExternalStore(subscribePreferences, readPreferences, serverPreferences);
  const preferences = parsePreferences(raw);
  const [opened, setOpened] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [settings, setSettings] = useState(false);
  const [language, setLanguage] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [error, setError] = useState(false);
  const [, refresh] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const visible = opened || (raw !== undefined && !preferences && !dismissed);

  useEffect(() => {
    if (!preferences?.language) removeSavedLanguage();
    if (!preferences) return;
    // Timers are limited to signed 32-bit milliseconds; revisit at least daily.
    const timer = window.setTimeout(() => {
      if (!parsePreferences(readPreferences())) setDismissed(false);
      refresh((n) => n + 1);
    }, Math.min(preferences.expiresAt - Date.now() + 1, 86_400_000));
    return () => { window.clearTimeout(timer); };
  }, [raw, preferences?.expiresAt, preferences?.language, preferences]);

  useEffect(() => {
    const open = () => {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const saved = parsePreferences(readPreferences());
      setLanguage(saved?.language ?? false);
      setAnalytics(saved?.analytics ?? false);
      setSettings(true);
      setError(false);
      setOpened(true);
    };
    window.addEventListener(OPEN_PREFERENCES, open);
    return () => { window.removeEventListener(OPEN_PREFERENCES, open); };
  }, []);

  useEffect(() => { if (opened) heading.current?.focus(); }, [opened]);

  const close = () => {
    setOpened(false);
    setDismissed(true);
    if (previousFocus.current?.isConnected) previousFocus.current.focus();
  };

  const save = (language: boolean, analytics: boolean) => {
    if (!savePreferences(language, locale, analytics)) { setError(true); return; }
    setError(false);
    close();
  };
  const customise = () => {
    setLanguage(preferences?.language ?? false);
    setAnalytics(preferences?.analytics ?? false);
    setSettings(true);
  };

  if (!visible) return null;
  return (
    <section id="site-cookie-panel" role="region" aria-labelledby="cookie-title" className="cookie-banner print:hidden"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <div className="cookie-banner-head">
        <CookieIcon />
        <div className="min-w-0 flex-1">
          <h2 id="cookie-title" ref={heading} tabIndex={-1} className="cookie-banner-title">{t.title}</h2>
          <p className="cookie-banner-text">
            {settings ? t.body : t.short}{' '}
            <a href={cookiesHref} className="link">{t.policy}</a>
          </p>
        </div>
        {settings && (
          <button type="button" aria-label={t.close} onClick={close} className="cookie-banner-close"><X size={18} aria-hidden="true" /></button>
        )}
      </div>
      {settings && (
        <div className="cookie-banner-options">
          <div><p className="font-medium">{t.necessary}</p><p className="mt-1 text-fg-2">{t.necessaryDetail}</p></div>
          <label className="flex min-h-11 cursor-pointer items-start gap-3">
            <input type="checkbox" checked={language} onChange={(event) => { setLanguage(event.target.checked); }} className="mt-1 size-5 shrink-0 accent-accent" />
            <span><span className="block font-medium">{t.language}</span><span className="mt-1 block text-fg-2">{t.languageDetail}</span></span>
          </label>
          <label className="flex min-h-11 cursor-pointer items-start gap-3">
            <input type="checkbox" checked={analytics} onChange={(event) => { setAnalytics(event.target.checked); }} className="mt-1 size-5 shrink-0 accent-accent" />
            <span><span className="block font-medium">{t.analytics}</span><span className="mt-1 block text-fg-2">{t.analyticsDetail}</span></span>
          </label>
          <p className="text-[12px] leading-5 text-fg-2">{t.future}</p>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-[13px] leading-5 text-fg">{t.error}</p>}
      <div className="cookie-banner-actions">
        {settings ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => { save(language, analytics); }}>{t.save}</button>
        ) : (
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { save(false, false); }}>{t.decline}</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => { save(true, true); }}>{t.accept}</button>
            <button type="button" className="cookie-banner-more" onClick={customise}>{t.settings}</button>
          </>
        )}
      </div>
    </section>
  );
}
