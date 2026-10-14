import type { MetadataRoute } from 'next';
import { hreflangAlternates, LOCALES, localePath } from '@/i18n/locales';
import { SITE_URL } from '@/lib/site';
import { LEGAL_IDS } from '@/lib/legal';
import { docPath, getDocs } from '@/lib/docs';

export const dynamic = 'force-static';

// Pages under each locale ('' = the home page); the root `/` is only a redirect.
const PAGES = [
  { page: '', priority: 1 },
  { page: 'features/', priority: 0.8 },
  { page: 'bots/', priority: 0.6 },
] as const;

// Each entry lists every language version of its page (hreflang).
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const docs = await getDocs();
  return [...PAGES.flatMap(({ page, priority }) => {
    const languages = Object.fromEntries(
      Object.entries(hreflangAlternates(page)).map(([lang, path]) => [lang, `${SITE_URL}${path}`]),
    );
    return LOCALES.map((l) => ({
      url: `${SITE_URL}${localePath(l, page)}`,
      changeFrequency: 'monthly' as const,
      priority,
      alternates: { languages },
    }));
  }), ...(['ru', 'en'] as const).flatMap((locale) => LEGAL_IDS.map((id) => ({
    url: `${SITE_URL}${localePath(locale, `legal/${id}/`)}`,
    changeFrequency: 'monthly' as const,
    priority: 0.4,
  }))),
  // Developer docs (ADR-0099): the home, sections and pages in ru and en (es/zh show English).
  ...['', ...docs.urls].flatMap((url) => {
    const page = url === '' ? null : docs.page('en', url);
    const langs = page === null ? (['ru', 'en'] as const) : page.languages;
    const languages = Object.fromEntries(langs.map((l) => [l, `${SITE_URL}${docPath(l, url)}`]));
    return langs.map((l) => ({
      url: `${SITE_URL}${docPath(l, url)}`,
      lastModified: page?.entry.lastModified,
      changeFrequency: 'weekly' as const,
      priority: url === '' ? 0.6 : 0.5,
      alternates: { languages },
    }));
  })];
}
