import { notFound } from 'next/navigation';
import { AiSection } from '@/components/ai-section';
import { ConferenceStrip } from '@/components/conference-strip';
import { ControlInfographic } from '@/components/control-infographic';
import { DayStory } from '@/components/day-story';
import { Downloads } from '@/components/downloads';
import { Faq } from '@/components/faq';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { Hero } from '@/components/hero';
import { MailLinkCard } from '@/components/mail-link-card';
import { PhoneSection } from '@/components/phone-section';
import { ScrollProgress } from '@/components/scroll-progress';
import { SectionCta } from '@/components/section-cta';
import { Pricing } from '@/components/pricing';
import { ReplaceStrip } from '@/components/replace-strip';
import { StickerFinale } from '@/components/sticker-finale';
import { StoryMotion } from '@/components/story-motion';
import { TelephonySection } from '@/components/telephony-section';
import { Container } from '@/components/ui';
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

/** Home page v6 (docs/plans/landing-v6.md §4): product → connections → special blocks → trust → price → download → FAQ. */
export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDict(locale);
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(locale) }} />
      <StoryMotion />
      <MailLinkCard t={t.mailLink} />
      <ScrollProgress />
      <Header t={t.header} locale={locale} />
      <main id="main" className="site">
        <Hero locale={locale} />
        <ReplaceStrip locale={locale} />
        <DayStory locale={locale} />
        <TelephonySection locale={locale} />
        <AiSection locale={locale} />
        <PhoneSection locale={locale} />
        <ConferenceStrip locale={locale} cta={<SectionCta locale={locale} className="section-cta-center" />} />
        <section id="control" className="section control-section" aria-labelledby="control-title">
          <Container>
            <ControlInfographic locale={locale} />
          </Container>
        </section>
        <Pricing locale={locale} t={t.pricing} />
        <Downloads t={t.downloads} />
        <Faq t={t.faq} locale={locale} />
        <StickerFinale locale={locale} />
      </main>
      <Footer t={t.footer} locale={locale} />
    </>
  );
}
