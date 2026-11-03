import { AudioLines, BookOpenText, CalendarDays, HardDrive, Mail, MessagesSquare, Phone, Shapes, SquareKanban, type LucideIcon } from 'lucide-react';
import { preload } from 'react-dom';
import type { Locale } from '@/i18n';
import { getHome, HERO_SHOT, type HeroSceneKey } from '@/i18n/home';
import { APP_URL } from '@/lib/site';
import { SceneSwitcher } from './scene-switcher';
import { accented, Button, Container, nb, Shot } from './ui';

const ICONS: Record<HeroSceneKey, LucideIcon> = {
  voice: AudioLines,
  chat: MessagesSquare,
  tasks: SquareKanban,
  calendar: CalendarDays,
  mail: Mail,
  wiki: BookOpenText,
  canvas: Shapes,
  disk: HardDrive,
  phone: Phone,
};

/**
 * Hero «одно окно — семь сцен» (§4.1): the live H1, the lead, two buttons on the left; the real app window on the
 * right, tilted in perspective and bleeding past the page edge (desktop); quiet scene pills underneath.
 */
export function Hero({ locale }: { locale: Locale }) {
  const t = getHome(locale);
  const h = t.hero;
  // The H1 face for the page's script (~50 KB, CJK uses the system face): without it the title reflows on swap.
  const serif = { ru: 'cyrillic', en: 'latin', es: 'latin', zh: null }[locale];
  if (serif) {
    preload(`/fonts/source-serif-4-${serif}.woff2`, { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
    preload(`/fonts/source-serif-4-italic-${serif}.woff2`, { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
  }
  // Desktop: the right column plus the bleed past the page edge (.hero-stage); below 1024 the full column.
  const sizes = '(min-width: 1024px) 64vw, (min-width: 640px) calc(100vw - 64px), calc(100vw - 40px)';
  return (
    <section id="top" aria-labelledby="hero-title" className="hero">
      <Container>
        <SceneSwitcher
          copy={
            <>
              <h1 id="hero-title" className="h1">
                {accented(h.title, h.accent)}
              </h1>
              <ul className="hero-list">
                {h.list.map((item) => (
                  <li key={item}>{nb(item)}</li>
                ))}
              </ul>
              <p className="hero-note">{nb(h.lead)}</p>
              <div className="hero-actions">
                <div className="hero-buttons">
                  <Button href="#download">{h.download}</Button>
                  <Button href={APP_URL} variant="secondary">
                    {h.startFree}
                  </Button>
                </div>
                <p className="hero-platforms">{h.platforms}</p>
              </div>
            </>
          }
          label={h.scenesLabel}
          chips={h.scenes.map((s) => {
            const Icon = ICONS[s.key];
            return { key: s.key, label: s.label, icon: <Icon aria-hidden="true" size={15} strokeWidth={1.9} /> };
          })}
          panels={h.scenes.map((s, i) => (
            <Shot
              key={s.key}
              scene={HERO_SHOT[s.key]}
              locale={locale}
              alt={t.alts[HERO_SHOT[s.key]]}
              sizes={sizes}
              priority={i === 0}
              className="hero-shot"
            />
          ))}
        />
      </Container>
    </section>
  );
}
