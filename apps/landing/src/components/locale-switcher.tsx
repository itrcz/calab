'use client';

import { Globe } from 'lucide-react';
import { useEffect, useRef, type MouseEvent } from 'react';
import { LOCALE_INFO, LOCALES, localePath, type Locale } from '@/i18n/locales';
import { rememberLocale } from '@/lib/site-preferences';

/**
 * Icon-only language control in the header (ADR-0022 §3): a native <details> menu of plain links, so it works without JS.
 * With JS and storage consent: remembers the choice. Keeps the current page and navigates to #top,
 * closes on outside click / Escape.
 */
export function LocaleSwitcher({ locale, label, page = '' }: { locale: Locale; label: string; page?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        el.open = false;
        el.querySelector('summary')?.focus();
      } else if (!el.contains(e.target as Node)) {
        el.open = false;
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);

  const choose = (l: Locale) => (e: MouseEvent<HTMLAnchorElement>) => {
    rememberLocale(l);
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    window.location.assign(localePath(l, page) + '#top');
  };

  const current = LOCALE_INFO[locale];
  return (
    <details ref={ref} className="locale-control relative">
      <summary
        aria-label={`${label}: ${current.name}`}
        className="locale-globe"
        title={`${label}: ${current.name}`}
      >
        <Globe aria-hidden="true" size={21} strokeWidth={1.7} />
      </summary>
      <ul className="locale-menu absolute right-0 mt-2 min-w-40 p-1 text-[14px]">
        {LOCALES.map((l) => (
          <li key={l}>
            <a
              href={localePath(l, page) + '#top'}
              hrefLang={LOCALE_INFO[l].lang}
              lang={LOCALE_INFO[l].lang}
              aria-current={l === locale ? 'page' : undefined}
              onClick={choose(l)}
              className={
                'flex h-9 items-center rounded-lg px-3 hover:bg-accent-tint ' +
                (l === locale ? 'font-semibold text-accent-text' : 'text-fg')
              }
            >
              {LOCALE_INFO[l].name}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
