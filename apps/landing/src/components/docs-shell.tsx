import type { ReactNode } from 'react';
import type { Locale } from '@/i18n';
import { getDict, localePath } from '@/i18n';
import { docPath, type DocsSite } from '@/lib/docs';
import { docLang, docsUi } from '@/lib/docs-ui';
import { Footer } from './footer';
import { LocaleSwitcher } from './locale-switcher';
import '../app/docs.css';

/**
 * Developer docs layout (ADR-0099, docs/08 «Сайт → Документация»): top bar with search and language,
 * left navigation (a drawer below 1100 px), content, and an optional right column (page TOC).
 * Server-rendered; behaviour (drawer, search, tabs, copy, scroll-spy) is /docs.js, loaded deferred.
 */
export function DocsShell({ site, locale, current, page, aside, children }: {
  site: DocsSite;
  locale: Locale;
  /** URL slug of the current page or section ('' on the docs home). */
  current: string;
  /** Path for the language switcher, e.g. `docs/bots/quickstart/`. */
  page: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const lang = docLang(locale);
  const ui = docsUi(lang);
  const t = getDict(locale);
  return (
    <div className="docs" data-copied={ui.copied} data-no-results={ui.noResults}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-4 focus:z-40 focus:rounded-md focus:bg-card-raised focus:px-4 focus:py-2 text-[14px]">
        {t.header.skip}
      </a>
      <header className="docs-top">
        <button type="button" className="docs-menu" aria-controls="docs-nav" aria-expanded="false" aria-label={ui.menu} data-docs-menu>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" fill="none" /></svg>
        </button>
        <a href={localePath(locale)} className="docs-brand" aria-label={ui.home}>
          <img src="/calab-wordmark.svg" width={311} height={96} alt="Calab" />
        </a>
        <a href={docPath(locale, '')} className="docs-brand-label" aria-current={current === '' ? 'page' : undefined}>{ui.docs}</a>
        <div className="docs-search" role="search">
          <label htmlFor="docs-q" className="sr-only">{ui.search}</label>
          <svg className="docs-search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.75" fill="none" /><path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" /></svg>
          <input
            id="docs-q"
            type="search"
            role="combobox"
            aria-expanded="false"
            aria-controls="docs-results"
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            placeholder={ui.searchShort}
            data-index={docPath(locale, 'search-index.json').replace(/\/$/, '')}
          />
          <kbd aria-hidden="true">/</kbd>
          <div id="docs-results" className="docs-results" role="listbox" aria-label={ui.search} hidden />
        </div>
        <LocaleSwitcher locale={locale} label={t.header.language} page={page} />
      </header>
      <div className="docs-body">
        <nav id="docs-nav" className="docs-nav" aria-label={ui.menu}>
          <ul>
            {site.nav.map((s) => (
              <li key={s.slug} className="docs-nav-section">
                <a href={docPath(locale, s.slug)} className="docs-nav-heading" aria-current={current === s.slug ? 'page' : undefined}>{s.section[lang]}</a>
                <ul>
                  {s.pages.filter((p) => p.slug !== 'index').map((p) => {
                    const url = `${s.slug}/${p.slug}`;
                    return (
                      <li key={p.slug}>
                        <a href={docPath(locale, url)} aria-current={current === url ? 'page' : undefined}>{p[lang]}</a>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </nav>
        <div className="docs-scrim" data-docs-scrim hidden />
        <main id="main" className="docs-main">{children}</main>
        {aside}
      </div>
      <Footer t={t.footer} locale={locale} />
      <script src="/docs.js" defer />
    </div>
  );
}
