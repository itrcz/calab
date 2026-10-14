import type { Metadata } from 'next';
import { LOCALE_INFO, type Locale } from '../i18n/locales';
import { docPath } from './docs';
import type { DocLang } from './docs-ui';

/**
 * Title, description, canonical and hreflang of a docs URL. The docs exist in ru and en: es/zh
 * pages (English content) and pages shown in the other language are canonicalised to the page
 * whose language matches the content.
 */
export function docsMetadata({ locale, url, title, description, languages, contentLang }: {
  locale: Locale;
  url: string;
  title: string;
  description: string;
  /** Languages that have this page natively. */
  languages: readonly DocLang[];
  /** Language of the content shown under this locale. */
  contentLang: DocLang;
}): Metadata {
  const canonical = docPath(locale === contentLang ? locale : contentLang, url);
  const alternates: Record<string, string> = Object.fromEntries(languages.map((l) => [LOCALE_INFO[l].lang, docPath(l, url)]));
  if (languages.includes('en')) alternates['x-default'] = docPath('en', url);
  const fullTitle = `${title} — Calab Docs`;
  return {
    title: fullTitle,
    description,
    alternates: { canonical, languages: alternates },
    openGraph: {
      type: 'article',
      url: canonical,
      siteName: 'Calab',
      locale: LOCALE_INFO[locale].ogLocale,
      title: fullTitle,
      description,
      images: [{ url: `/og/${LOCALE_INFO[locale].lang}.png`, width: 1200, height: 630, alt: 'Calab' }],
    },
    twitter: { card: 'summary_large_image', title: fullTitle, description, images: [`/og/${LOCALE_INFO[locale].lang}.png`] },
  };
}
