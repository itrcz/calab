import type { Dict, Locale } from '@/i18n';
import { getHome } from '@/i18n/home';
import { localePath } from '@/i18n/locales';
import { APP_URL } from '@/lib/site';
import { DrawnLink } from './drawn-link';
import { LocaleSwitcher } from './locale-switcher';
import { SiteMenu } from './site-menu';
import { Container } from './ui';

/**
 * A 72 px row, sticky on a solid backing (owner, #142; was «scrolls away», 24.10).
 * `page`: '' on the home page, 'developers/' etc. elsewhere — section links then lead back to the home page.
 */
export function Header({ t, locale, page = '' }: { t: Dict['header']; locale: Locale; page?: string }) {
  const n = getHome(locale).nav;
  const home = page === '' ? '' : localePath(locale);
  const developers = localePath(locale, 'developers/');
  const nav = [
    { href: localePath(locale, 'features/'), label: n.features, current: page === 'features/' },
    { href: `${home}#telephony`, label: n.telephony },
    { href: developers, label: n.developers, current: page === 'developers/' },
    { href: `${home}#pricing`, label: n.pricing },
    { href: `${home}#download`, label: n.download },
  ];
  return (
    <header className="site-header">
      <a href="#main" className="skip-link">
        {t.skip}
      </a>
      <Container className="site-header-row">
        <a href={home === '' ? '#top' : home} className="site-brand" aria-label={t.home}>
          <img className="site-wordmark" src="/calab-wordmark.svg" width={311} height={87} alt="Calab" />
        </a>
        <nav aria-label={t.navLabel} className="site-nav">
          <ul>
            {nav.map((l) => (
              <li key={l.href}>
                <DrawnLink href={l.href} current={l.current}>
                  {l.label}
                </DrawnLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="site-header-actions">
          <LocaleSwitcher locale={locale} label={t.language} page={page} />
          <SiteMenu label={t.navLabel}>
            <nav aria-label={t.navLabel}>
              {nav.map((l) => (
                <a href={l.href} key={l.href} aria-current={l.current ? 'page' : undefined}>
                  {l.label}
                </a>
              ))}
            </nav>
          </SiteMenu>
          {/* Phones: the short label, so logo + language + menu + button fit 360 px in every locale. */}
          <a href={APP_URL} className="topbar-action">
            <span className="topbar-action-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="topbar-action-labels">
              <span className="topbar-action-label">
                <span className="sm:hidden">{t.openWebShort}</span>
                <span className="hidden sm:inline">{t.openWeb}</span>
              </span>
              <span className="topbar-action-label is-hover" aria-hidden="true">
                <span className="sm:hidden">{t.openWebShort}</span>
                <span className="hidden sm:inline">{t.openWeb}</span>
              </span>
            </span>
          </a>
        </div>
      </Container>
    </header>
  );
}
