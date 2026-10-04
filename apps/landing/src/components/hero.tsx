import type { Dict, Locale } from '@/i18n';
import { getStory } from '@/i18n/story';
import { APP_URL } from '@/lib/site';
import { Container } from './ui';
import { HeroDiscover } from './hero-discover';
import { LivingTitle } from './living-title';
import { CursorStickerTrail } from './cursor-sticker-trail';

export function Hero({ t, locale }: { t: Dict['hero']; locale: Locale }) {
  const s = getStory(locale);
  return <section id="top" aria-labelledby="hero-title" className="story-hero">
    <Container>
      <div className="story-hero-layout">
        <LivingTitle lines={s.title} />
        <div className="story-hero-copy">
          <p>{s.lead}</p>
          <div className="hero-actions mt-7 flex flex-wrap gap-5">
            <a href="#download" className="kinetic-button"><span className="kinetic-label">{t.download}</span></a>
            <a href={APP_URL} className="kinetic-button kinetic-button-light"><span className="kinetic-label">{t.openWeb}</span></a>
          </div>
          <p className="story-platforms">macOS · Windows · Linux · Web</p>
        </div>
      </div>
      <HeroDiscover label={s.more} />
    </Container>
    <CursorStickerTrail quiet />
  </section>;
}
