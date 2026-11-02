import { notFound } from 'next/navigation';
import { Features } from '@/components/features';
import { ScrollProgress } from '@/components/scroll-progress';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { Performance } from '@/components/performance';
import { Container } from '@/components/ui';
import { getDict, isLocale } from '@/i18n';
import { getStory } from '@/i18n/story';

/** /<locale>/features/: every section in detail (the header's «Возможности» leads here). */
export default async function FeaturesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDict(locale);
  const s = getStory(locale);
  return (
    <>
      <ScrollProgress />
      <Header t={t.header} locale={locale} page="features/" />
      <main id="main" className="site">
        <section className="section page-hero" aria-labelledby="features-page-title">
          <Container>
            <h1 id="features-page-title" className="h1 heading-h1">
              {s.detail}
            </h1>
          </Container>
        </section>
        <Features t={t.features} locale={locale} />
        <Performance t={t.perf} locale={locale} />
      </main>
      <Footer t={t.footer} locale={locale} />
    </>
  );
}
