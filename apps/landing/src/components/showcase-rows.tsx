import { ArrowUpRight } from 'lucide-react';
import type { Locale } from '@/i18n';
import { getCapabilities } from '@/i18n/capabilities';
import { localePath } from '@/i18n/locales';
import type { ScreenName } from '@/lib/screens';
import { Container, Frame, Screen, cx } from './ui';
import { ShotStage } from './shot-stickers';

// 2.0 shots: boards with categories and checklist progress.
const shots = { voice: 'voice', chat: 'chat', calendar: 'findtime', kanban: 'boards2' } as const satisfies Record<string, ScreenName>;
const anchors = { voice: 'voice', chat: 'chat', calendar: 'calendar', kanban: 'boards' } as const;

/** «How it looks»: four large screenshots in alternating text/screenshot rows. Static: no sticky, no scroll code. */
export function ShowcaseRows({ locale, more }: { locale: Locale; more: string }) {
  const t = getCapabilities(locale);
  return (
    <section id="showcase" aria-labelledby="showcase-title" className="py-16 sm:py-24">
      <Container>
        <div className="sticker-section-heading">
          <div className="max-w-[820px]">
          <h2 id="showcase-title" className="editorial-title text-balance">{t.showTitle}</h2>
          <p className="mt-4 text-[17px] leading-7 text-pretty text-fg-2 sm:text-[19px] sm:leading-8">{t.showLead}</p>
          </div>
          <img className="section-sticker" src="/editorial/sticker-video.webp" width={180} height={180} alt="" aria-hidden="true" loading="lazy" />
        </div>
        <div className="mt-12 flex flex-col gap-14 sm:gap-20">
          {t.rows.map((row, index) => (
            <div key={row.key} className="grid items-center gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14">
              <div className={cx(index % 2 === 1 && 'lg:order-2')}>
                <h3 className="text-[28px] leading-[1.15] font-bold text-balance sm:text-[36px]">{row.title}</h3>
                <p className="mt-4 text-[17px] leading-7 text-pretty text-fg-2">{row.text}</p>
                <a href={`${localePath(locale, 'features/')}#${anchors[row.key]}`} className="mt-5 inline-flex items-center gap-1.5 text-[15px] font-semibold text-accent-text hover:underline">
                  {more}
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
              </div>
              <ShotStage set={row.key} side={index % 2 === 1 ? 'right' : 'left'}>
                <Frame>
                  <Screen name={shots[row.key]} locale={locale} alt={row.alt} sizes="(min-width: 1024px) 700px, 92vw" />
                </Frame>
              </ShotStage>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}
