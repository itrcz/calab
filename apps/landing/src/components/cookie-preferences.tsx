'use client';

import { Settings2, X } from 'lucide-react';
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

export function CookiePreferences({ locale }: { locale: Locale }) {
  const t = COOKIE_COPY[locale];
  const raw = useSyncExternalStore(subscribePreferences, readPreferences, serverPreferences);
  const preferences = parsePreferences(raw);
  const [opened, setOpened] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [settings, setSettings] = useState(false);
  const [language, setLanguage] = useState(false);
  const [error, setError] = useState(false);
  const [, refresh] = useState(0);
  const launcher = useRef<HTMLButtonElement>(null);
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
      setLanguage(parsePreferences(readPreferences())?.language ?? false);
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
    (previousFocus.current?.isConnected ? previousFocus.current : launcher.current)?.focus();
  };

  const save = (allow: boolean) => {
    if (!savePreferences(allow, locale)) { setError(true); return; }
    setError(false);
    close();
  };
  const action = 'min-h-11 cursor-pointer rounded-xl border border-white/20 bg-card-raised px-3 py-2 text-[13px] font-medium hover:border-white/50';

  return (
    <div className="fixed right-4 bottom-4 z-50 max-w-[calc(100vw-2rem)] print:hidden">
      {visible && (
        <section id="site-cookie-panel" role="region" aria-labelledby="cookie-title"
          className="mb-3 max-h-[calc(100dvh-6rem)] w-[400px] max-w-full overflow-y-auto rounded-2xl border border-white/20 bg-card p-5 shadow-xl"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
          <div className="flex items-start justify-between gap-3">
            <h2 id="cookie-title" ref={heading} tabIndex={-1} className="pt-2 text-[17px] font-semibold">{t.title}</h2>
            <button type="button" aria-label={t.close} onClick={close} className="-mr-2 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-card-raised"><X size={19} aria-hidden="true" /></button>
          </div>
          <p className="mt-2 text-[14px] leading-6 text-fg-2">{t.body}</p>
          {settings && (
            <div className="mt-4 space-y-4 border-y border-white/10 py-4 text-[14px] leading-5">
              <div><p className="font-medium">{t.necessary}</p><p className="mt-1 text-fg-2">{t.necessaryDetail}</p></div>
              <label className="flex min-h-11 cursor-pointer items-start gap-3">
                <input type="checkbox" checked={language} onChange={(event) => { setLanguage(event.target.checked); }} className="mt-1 size-5 shrink-0 accent-accent" />
                <span><span className="block font-medium">{t.language}</span><span className="mt-1 block text-fg-2">{t.languageDetail}</span></span>
              </label>
              <div className="space-y-2 text-fg-2">
                <p className="flex justify-between gap-3"><span>{t.analytics}</span><span>{t.inactive}</span></p>
                <p className="flex justify-between gap-3"><span>{t.marketing}</span><span>{t.inactive}</span></p>
                <p className="text-[12px] leading-5">{t.future}</p>
              </div>
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-[13px] leading-5 text-fg">{t.error}</p>}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button type="button" className={action} onClick={() => { save(false); }}>{t.reject}</button>
            <button type="button" className={action} onClick={() => { save(true); }}>{t.allow}</button>
          </div>
          {settings ? <button type="button" className={`${action} mt-2 w-full`} onClick={() => { save(language); }}>{t.save}</button> :
            <button type="button" className={`${action} mt-2 w-full`} onClick={() => { setLanguage(preferences?.language ?? false); setSettings(true); }}>{t.settings}</button>}
          <a href={localePath(locale, 'legal/cookies/')} className="link mt-3 inline-flex min-h-11 items-center text-[13px]">{t.policy}</a>
        </section>
      )}
      <button ref={launcher} type="button" aria-controls="site-cookie-panel" aria-expanded={visible}
        aria-label={t.title} className="ml-auto flex size-11 cursor-pointer items-center justify-center rounded-full border border-white/20 bg-card shadow-lg hover:bg-card-raised"
        onClick={() => { if (visible) close(); else window.dispatchEvent(new Event(OPEN_PREFERENCES)); }}>
        <Settings2 size={19} aria-hidden="true" />
      </button>
    </div>
  );
}
