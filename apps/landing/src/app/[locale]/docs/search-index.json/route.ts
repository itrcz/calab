import { LOCALES, isLocale } from '@/i18n/locales';
import { getDocs } from '@/lib/docs';

// Client search index of the docs (ADR-0099): per page the title, section and, per heading, its id,
// text and the first 200 characters. Exported as /<locale>/docs/search-index.json; /docs.js loads it
// on the first focus of the search field.
export const dynamic = 'force-static';
export const dynamicParams = false;
export const generateStaticParams = () => LOCALES.map((locale) => ({ locale }));

export async function GET(_req: Request, { params }: { params: Promise<{ locale: string }> }): Promise<Response> {
  const { locale } = await params;
  if (!isLocale(locale)) return new Response('Not found', { status: 404 });
  const site = await getDocs();
  return new Response(JSON.stringify(site.searchIndex(locale)), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
