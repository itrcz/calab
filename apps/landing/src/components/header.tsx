import type { Dict, Locale } from '@/i18n';
import { localePath } from '@/i18n/locales';
import { APP_URL } from '@/lib/site';
import { DrawnNavLink } from './drawn-nav-link';
import { LocaleSwitcher } from './locale-switcher';
import { Container } from './ui';

/** `page`: '' on the home page, 'bots/' on /<locale>/bots/ — section links then lead back to the home page. */
export function Header({ t, locale, page = '' }: { t: Dict['header']; locale: Locale; page?: string }) {
  const home = page === '' ? '' : localePath(locale);
  const nav = [
    { href: `${home}#features`, label: t.nav.features },
    { href: `${home}#pricing`, label: t.nav.pricing },
    { href: localePath(locale, 'bots/'), label: t.nav.bots },
    { href: `${home}#download`, label: t.nav.download },
  ];
  return (
    <header className="header-bar editorial-nav sticky top-0 z-10">
      <a
        href="#main"
        className="sr-only rounded-md bg-card-raised text-[14px] shadow-window focus:not-sr-only focus:absolute focus:top-2 focus:left-4 focus:z-20 focus:px-4 focus:py-2"
      >
        {t.skip}
      </a>
      <Container className="flex h-20 items-center justify-between gap-5">
        <a href={home === '' ? '#top' : home} className="nav-brand flex shrink-0 items-center gap-2 rounded-md" aria-label={t.home}>
          <img className="nav-wordmark" src="/calab-wordmark.svg" width={311} height={96} alt="Calab" />
        </a>
        <nav aria-label={t.navLabel} className="nav-island hidden lg:block">
          <ul className="flex items-center gap-7 text-[14px] text-fg">
            {nav.map((n) => (
              <li key={n.href}>
                <DrawnNavLink href={n.href} current={page === 'bots/' && n.href === localePath(locale, 'bots/')}>
                  {n.label}
                </DrawnNavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 items-center gap-2">
          <LocaleSwitcher locale={locale} label={t.language} page={page} />
          <details className="nav-mobile lg:hidden"><summary aria-label={t.navLabel}><span /><span /></summary><nav aria-label={t.navLabel}>{nav.map((n) => <a href={n.href} key={n.href}>{n.label}</a>)}</nav></details>
          {/* Phones: a short label, so logo + language + button fit 360 px in every locale. */}
          <a href={APP_URL} className="topbar-action" aria-label={t.openWeb}>
            <span className="topbar-action-dots" aria-hidden="true"><i /><i /><i /></span>
            <span className="topbar-action-labels" aria-hidden="true">
              <span className="topbar-action-label"><span className="sm:hidden">{t.openWebShort}</span><span className="hidden sm:inline">{t.openWeb}</span></span>
              <span className="topbar-action-label is-hover"><span className="sm:hidden">{t.openWebShort}</span><span className="hidden sm:inline">{t.openWeb}</span></span>
            </span>
          </a>
        </div>
      </Container>
    </header>
  );
}
