import type { Dict, Locale } from '@/i18n';
import { localePath } from '@/i18n/locales';
import { CONTACT_FORM_URL, GPTUNNEL_URL, REPO_URL, repoFile } from '@/lib/site';
import { Container } from './ui';

export function Footer({ t, locale }: { t: Dict['footer']; locale: Locale }) {
  const links = [
    { href: REPO_URL, label: 'GitHub' },
    { href: localePath(locale, 'bots/'), label: t.bots },
    { href: repoFile('LICENSE'), label: t.license },
    { href: repoFile('COMMERCIAL-LICENSE.md'), label: t.commercial },
    { href: repoFile('SECURITY.md'), label: t.security },
    { href: repoFile('TRADEMARKS.md'), label: t.trademarks },
    { href: CONTACT_FORM_URL, label: t.contact },
  ];
  return (
    <footer className="border-t border-line py-10">
      <Container className="flex flex-col gap-6 text-[14px] leading-5 text-fg-2 md:flex-row md:items-center md:justify-between">
        <nav aria-label={t.navLabel}>
          <ul className="flex flex-wrap gap-x-6 gap-y-3">
            {links.map((l) => (
              <li key={l.href}>
                <a href={l.href} className="rounded-md hover:text-fg">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {/* Required attribution (BSL 1.1 / NOTICE): never translated. */}
        <p className="shrink-0">
          © 2026 GPTunneL ·{' '}
          <a href={GPTUNNEL_URL} className="text-accent-text hover:underline" lang="en">
            Powered by GPTunneL
          </a>
        </p>
      </Container>
    </footer>
  );
}
