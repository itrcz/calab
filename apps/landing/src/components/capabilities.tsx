import { ArrowUpRight, AudioLines, Bot, CalendarCheck, LayoutGrid, MessagesSquare, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { Locale } from '@/i18n';
import { getCapabilities, type CapCard } from '@/i18n/capabilities';
import { localePath } from '@/i18n/locales';
import { Container } from './ui';

const icons: Record<CapCard['key'], LucideIcon> = {
  voice: AudioLines,
  chat: MessagesSquare,
  meetings: CalendarCheck,
  boards: LayoutGrid,
  bots: Bot,
  company: ShieldCheck,
};
// Anchors on /features.
const anchors: Record<CapCard['key'], string> = {
  voice: 'voice',
  chat: 'chat',
  meetings: 'calendar',
  boards: 'boards',
  bots: 'bots',
  company: 'self-hosted',
};
const badge = { team: 'Team', business: 'Business' } as const;

/** «What Calab can do»: six static cards, everything visible without tabs, hover or scripts. */
export function Capabilities({ locale }: { locale: Locale }) {
  const t = getCapabilities(locale);
  return (
    <section id="features" aria-labelledby="capabilities-title" className="py-16 sm:py-24">
      <Container>
        <div className="sticker-section-heading">
          <div className="max-w-[820px]">
          <h2 id="capabilities-title" className="editorial-title text-balance">{t.title}</h2>
          <p className="mt-4 text-[17px] leading-7 text-pretty text-fg-2 sm:text-[19px] sm:leading-8">{t.lead}</p>
          </div>
          <img className="section-sticker" src="/editorial/sticker-tasks.webp" width={180} height={180} alt="" aria-hidden="true" loading="lazy" />
        </div>
        <ul className="mt-10 grid list-none gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {t.cards.map((card) => {
            const Icon = icons[card.key];
            return (
              <li key={card.key} className="flex flex-col rounded-[20px] bg-card p-5 sm:p-6">
                <h3 className="flex items-center gap-3 text-[22px] leading-7 font-bold">
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-tint text-accent-text">
                    <Icon aria-hidden="true" className="size-5" strokeWidth={2} />
                  </span>
                  {card.title}
                </h3>
                <ul className="mt-4 flex flex-1 list-none flex-col gap-2.5 text-[15px] leading-6 text-fg-2">
                  {card.lines.map((line) => (
                    <li key={line.t} className="flex gap-2.5">
                      <span aria-hidden="true" className="mt-[9px] size-1.5 shrink-0 rounded-full bg-accent" />
                      <span className="text-pretty">
                        {line.t}
                        {line.plan && <span className="ml-2 inline-block rounded-full bg-accent-tint px-2 py-px align-[1px] text-[12px] leading-5 font-semibold whitespace-nowrap text-accent-text">{badge[line.plan]}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
                <a href={`${localePath(locale, 'features/')}#${anchors[card.key]}`} className="mt-5 inline-flex items-center gap-1.5 self-start text-[15px] font-semibold text-accent-text hover:underline">
                  {t.more}
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
              </li>
            );
          })}
        </ul>
        <p className="mt-6 text-[14px] leading-6 text-fg-2">{t.legend}</p>
      </Container>
    </section>
  );
}
