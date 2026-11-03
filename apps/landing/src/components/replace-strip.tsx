import type { Locale } from '@/i18n';
import { getHome } from '@/i18n/home';
import { accented, Container, nb, Sticker } from './ui';
import { SectionCta } from './section-cta';

/** «Вместо семи сервисов — одно окно» (§4.2): a centred pause between the hero and the story (owner, 24.10). */
export function ReplaceStrip({ locale }: { locale: Locale }) {
  const t = getHome(locale).replace;
  return (
    <section id="one-window" aria-labelledby="replace-title" className="section replace" data-reveal>
      <Container className="heading-center replace-copy">
        <h2 id="replace-title" className="h2">
          {accented(t.title, t.accent)}
        </h2>
        <p className="lead">{nb(t.lead)}</p>
        {/* Many tools, one hand: the high five sits in the free field right of the centred text (wide screens only). */}
        <SectionCta locale={locale} className="section-cta-center" />
        <Sticker name="highfive" size={180} className="replace-sticker" />
      </Container>
    </section>
  );
}
