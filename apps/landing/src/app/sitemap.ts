import type { MetadataRoute } from 'next';
import { hreflangAlternates, LOCALES, localePath } from '@/i18n/locales';
import { SITE_URL } from '@/lib/site';
import { LEGAL_IDS } from '@/lib/legal';

export const dynamic = 'force-static';

// Pages under each locale ('' = the home page); the root `/` is only a redirect.
const PAGES = [
  { page: '', priority: 1 },
  { page: 'features/', priority: 0.8 },
  { page: 'bots/', priority: 0.6 },
] as const;

// Each entry lists every language version of its page (hreflang).
export default function sitemap(): MetadataRoute.Sitemap {
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
  }), ...LEGAL_IDS.map((id) => ({
    url: `${SITE_URL}${localePath('ru', `legal/${id}/`)}`,
    changeFrequency: 'monthly' as const,
    priority: 0.4,
  }))];
}
