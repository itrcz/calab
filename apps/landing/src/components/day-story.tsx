import type { CSSProperties } from 'react';
import type { Locale } from '@/i18n';
import { getHome } from '@/i18n/home';
import { StoryScroller } from './story-scroller';
import { nb, Section, Shot } from './ui';
import { SectionCta } from './section-cta';

/**
 * «Один день команды» (§4.3): the steps of one day across chat, board, calendar, recording, wiki, disk, canvas.
 * The heading is visually hidden (owner, 24.10): the section opens straight with the steps.
 */
export function DayStory({ locale }: { locale: Locale }) {
  const t = getHome(locale);
  const s = t.story;
  return (
    <Section id="story" labelledBy="story-title" className="story">
      <h2 id="story-title" className="sr-only">
        {s.title}
      </h2>
      <StoryScroller>
        {s.steps.map((step, i) => (
          <li key={step.shot} data-step={i} className="story-step" style={{ '--row': i + 1 } as CSSProperties}>
            <div className="story-text">
              <h3 className="h3 h3-sm">{nb(step.title)}</h3>
              <p className="tile-text">{nb(step.text)}</p>
            </div>
            <div className="story-shot">
              <Shot scene={step.shot} locale={locale} alt={t.alts[step.shot]} sizes="(min-width: 1024px) 720px, (min-width: 640px) 56vw, 86vw" />
            </div>
          </li>
        ))}
      </StoryScroller>
      <SectionCta locale={locale} />
    </Section>
  );
}
