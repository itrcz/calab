import { notFound } from 'next/navigation';
import { Downloads } from '@/components/downloads';
import { Faq } from '@/components/faq';
import { StoryMotion } from '@/components/story-motion';
import { Capabilities } from '@/components/capabilities';
import { ShowcaseRows } from '@/components/showcase-rows';
import { ControlInfographic } from '@/components/control-infographic';
import { Container } from '@/components/ui';
import { StickerFinale } from '@/components/sticker-finale';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { ConferenceStrip } from '@/components/conference-strip';
import { Hero } from '@/components/hero';
import { Pricing } from '@/components/pricing';
import { getCapabilities } from '@/i18n/capabilities';
import { getStory } from '@/i18n/story';
import { getDict, isLocale, LOCALE_INFO, localePath } from '@/i18n';
import { APP_URL, DOWNLOADS, REPO_URL, SITE_URL } from '@/lib/site';

/** schema.org SoftwareApplication of the page's language (search engines; no runtime cost). */
function jsonLd(locale: Parameters<typeof getDict>[0]): string {
  const t = getDict(locale);
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Calab',
    url: `${SITE_URL}${localePath(locale)}`,
    inLanguage: LOCALE_INFO[locale].lang,
    description: t.meta.description,
    applicationCategory: 'CommunicationApplication',
    operatingSystem: 'macOS, Windows, Linux, Web',
    image: `${SITE_URL}/og/${LOCALE_INFO[locale].lang}.png`,
    screenshot: `${SITE_URL}/screens/${LOCALE_INFO[locale].lang}/voice@2x.webp`,
    downloadUrl: [DOWNLOADS.macArm64, DOWNLOADS.win, DOWNLOADS.appImage],
    installUrl: APP_URL,
    sameAs: [REPO_URL],
    license: 'https://spdx.org/licenses/BUSL-1.1.html',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: { '@type': 'Organization', name: 'GPTunneL', url: 'https://gptunnel.ai' },
  }).replace(/</g, '\\u003c');
}

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDict(locale);
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(locale) }} />
      <StoryMotion />
      <Header t={t.header} locale={locale} />
      <main id="main">
        <Hero t={t.hero} locale={locale} />
        <Capabilities locale={locale} />
        <ShowcaseRows locale={locale} more={getCapabilities(locale).more} />
        <ConferenceStrip locale={locale} />
        <section id="control" className="story-section control-section" aria-labelledby="control-title">
          <Container><ControlInfographic locale={locale} title={getStory(locale).control} /></Container>
        </section>
        <Pricing locale={locale} t={t.pricing} />
        <Downloads t={t.downloads} />
        <Faq t={t.faq} />
        <StickerFinale locale={locale} />
      </main>
      <Footer t={t.footer} locale={locale} />
    </>
  );
}
