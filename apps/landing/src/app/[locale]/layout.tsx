import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getDict, hreflangAlternates, isLocale, LOCALE_INFO, LOCALES, localePath } from '@/i18n';
import { SITE_URL } from '@/lib/site';
import { CookiePreferences } from '@/components/cookie-preferences';
import '../globals.css';

type Params = Promise<{ locale: string }>;

// Only /ru/, /en/, /es/, /zh/ exist in the export; anything else is the 404 page (Caddy: unknown locale → /en/).
export const dynamicParams = false;
export const generateStaticParams = () => LOCALES.map((locale) => ({ locale }));

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const { title, description, ogAlt } = getDict(locale).meta;
  const path = localePath(locale);
  return {
    metadataBase: new URL(SITE_URL),
    title,
    description,
    applicationName: 'Calab',
    alternates: { canonical: path, languages: hreflangAlternates() },
    icons: {
      icon: [
        { url: '/favicon.svg', type: 'image/svg+xml' },
        { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      ],
      apple: '/apple-touch-icon.png',
    },
    openGraph: {
      type: 'website',
      url: path,
      siteName: 'Calab',
      locale: LOCALE_INFO[locale].ogLocale,
      alternateLocale: LOCALES.filter((l) => l !== locale).map((l) => LOCALE_INFO[l].ogLocale),
      title,
      description,
      images: [{ url: `/og/${LOCALE_INFO[locale].lang}.png`, width: 1200, height: 630, alt: ogAlt }],
    },
    twitter: { card: 'summary_large_image', title, description, images: [`/og/${LOCALE_INFO[locale].lang}.png`] },
    formatDetection: { telephone: false },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0e0e10' },
  ],
  colorScheme: 'light dark',
};

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Params }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <html lang={LOCALE_INFO[locale].lang}>
      <body className="min-h-dvh text-fg">{children}<CookiePreferences locale={locale} /></body>
    </html>
  );
}
