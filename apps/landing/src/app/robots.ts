import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    // App-mode legal pages (#139, docs/adr/0148) exist only for the native shell's in-app browser;
    // `noindex` on the page covers indexing, this keeps crawlers from fetching them at all.
    rules: [{ userAgent: '*', allow: '/', disallow: '/*/legal/app/' }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
