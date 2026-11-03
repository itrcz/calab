import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DevelopersPage } from '@/components/developers';
import { ScrollProgress } from '@/components/scroll-progress';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { getPageCopy } from '@/i18n/pages';
import { getDict, hreflangAlternates, isLocale, LOCALE_INFO, localePath } from '@/i18n';

type Params = Promise<{ locale: string }>;

const PAGE = 'developers/';

// Title, description and URLs of this page; icons, OG image and the rest come from [locale]/layout.tsx.
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const { metaTitle: title, metaDescription: description } = getPageCopy(locale).developers;
  const path = localePath(locale, PAGE);
  return {
    title,
    description,
    alternates: { canonical: path, languages: hreflangAlternates(PAGE) },
    openGraph: {
      type: 'website',
      url: path,
      siteName: 'Calab',
      locale: LOCALE_INFO[locale].ogLocale,
      title,
      description,
      images: [{ url: `/og/${LOCALE_INFO[locale].lang}.png`, width: 1200, height: 630, alt: getDict(locale).meta.ogAlt }],
    },
    twitter: { card: 'summary_large_image', title, description, images: [`/og/${LOCALE_INFO[locale].lang}.png`] },
  };
}

export default async function Developers({ params }: { params: Params }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDict(locale);
  return (
    <>
      <ScrollProgress />
      <Header t={t.header} locale={locale} page={PAGE} />
      <main id="main" className="site">
        <DevelopersPage locale={locale} bots={t.bots} />
      </main>
      <Footer t={t.footer} locale={locale} />
    </>
  );
}
