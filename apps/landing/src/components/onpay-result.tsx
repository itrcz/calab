'use client';

import { CircleAlert, CircleCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ONPAY_COPY } from '@/i18n/onpay';
import { isLocale, LOCALE_INFO, LOCALE_STORAGE_KEY, type Locale } from '@/i18n/locales';
import { hasSiteConsent } from '@/lib/site-preferences';
import { APP_URL, CONTACT_FORM_URL } from '@/lib/site';
import { Button } from './ui';

/** The visitor's language, as the root router picks it: saved choice (with permission), then the browser, else Russian. */
function detect(): Locale {
  try {
    if (hasSiteConsent('language')) {
      const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (saved && isLocale(saved)) return saved;
    }
  } catch { /* Storage is optional. */ }
  for (const raw of navigator.languages.length ? navigator.languages : [navigator.language]) {
    const p = raw.toLowerCase().split(/[-_]/)[0] ?? '';
    if (/^(ru|uk|be|kk)$/.test(p)) return 'ru';
    if (p === 'zh' || p === 'es' || p === 'en') return p;
  }
  return 'en';
}

/**
 * Return page of the payment form (Tochka merchant URLs). Fixed text per language; the query string the bank
 * appends is never read or shown. Prerendered in Russian (the payer's market), switched after hydration.
 */
export function OnpayResult({ kind }: { kind: 'success' | 'fail' }) {
  const [locale, setLocale] = useState<Locale>('ru');
  useEffect(() => {
    setLocale(detect());
  }, []);
  const t = ONPAY_COPY[kind][locale];
  const Icon = kind === 'success' ? CircleCheck : CircleAlert;
  return (
    <main id="main" lang={LOCALE_INFO[locale].lang} className="flex min-h-dvh flex-col items-center justify-center px-5 py-16 text-center">
      <a href={`/${locale}/`} aria-label={t.home} className="mb-12 rounded-md">
        <img src="/calab-wordmark.svg" width={311} height={96} alt="Calab" className="h-8 w-auto" />
      </a>
      <Icon
        aria-hidden="true"
        className={kind === 'success' ? 'size-14 text-accent-text' : 'size-14 text-fg-2'}
        strokeWidth={1.5}
      />
      <h1 className="mt-6 text-[32px] leading-10 font-semibold tracking-tight text-balance sm:text-[40px] sm:leading-[48px]">{t.title}</h1>
      <p className="mt-4 max-w-[520px] text-[17px] leading-7 text-pretty text-fg-2">{t.text}</p>
      <div className="mt-10 flex w-full max-w-[420px] flex-col gap-3 sm:max-w-none sm:flex-row sm:justify-center">
        <Button href={APP_URL} size="lg">{t.web}</Button>
        <Button href="calab://open" variant="secondary" size="lg">{t.app}</Button>
      </div>
      <p className="mt-10 text-[14px] leading-6 text-fg-2">
        {t.support}{' '}
        <a href={CONTACT_FORM_URL} className="link">{t.supportLink}</a>
      </p>
    </main>
  );
}
