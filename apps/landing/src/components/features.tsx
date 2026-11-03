import {
  ArrowRight,
  CalendarCheck,
  CalendarClock,
  CalendarSync,
  Check,
  KeyRound,
  Lock,
  ShieldCheck,
  Globe,
  Guitar,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { Dict, Locale } from '@/i18n';
import { localePath } from '@/i18n/locales';
import { fmt } from '@/lib/rich';
import type { ScreenName } from '@/lib/screens';
import type { SceneName } from '@/i18n/home';
import { BotCode } from './bot-code';
import { getCatalog } from '@/i18n/catalog';
import { getHome } from '@/i18n/home';
import { getPageCopy } from '@/i18n/pages';
import { SectionCta } from './section-cta';
import { Container, nb, Shot, cx } from './ui';

type T = Dict['features'];

/** Section title block: a large title and the text (no eyebrow above headings, owner 24.10). */
function Intro({ id, title, text, center }: { id: string; title: string; text: string; center?: boolean }) {
  return (
    <div className={center ? 'mx-auto max-w-[760px] text-center' : undefined}>
      <h2 id={id} className="h2">
        {nb(title)}
      </h2>
      <p className="lead">{nb(text)}</p>
    </div>
  );
}

function Points({ items, className }: { items: string[]; className?: string }) {
  return (
    <ul className={cx('flex flex-col gap-3 text-[16px] leading-6', className)}>
      {items.map((p) => (
        <li key={p} className="flex gap-3">
          <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" strokeWidth={2.25} />
          <span className="text-pretty">{p}</span>
        </li>
      ))}
    </ul>
  );
}

/** Text beside a screenshot (40 / 60), stacked on phones; `flip` puts the picture first on wide screens. */
function Split({ id, locale, flip, alt, text, shot }: { id: string; locale: Locale; flip?: boolean; alt?: boolean; text: ReactNode; shot: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cx('section', alt && 'surface-alt')}>
      <Container className="grid items-center gap-10 lg:grid-cols-12 lg:gap-14">
        <div className={cx('min-w-0 lg:col-span-5', flip && 'lg:order-2')}>{text}</div>
        <div className={cx('min-w-0 lg:col-span-7', flip && 'lg:order-1')}>{shot}</div>
        <SectionCta locale={locale} className="lg:col-span-12 lg:order-3" />
      </Container>
    </section>
  );
}

const shot = (name: ScreenName | SceneName, locale: Locale, alt: string, sizes = '(min-width: 1232px) 660px, (min-width: 1024px) 55vw, calc(100vw - 32px)') => (
  <Shot scene={name} locale={locale} alt={alt} sizes={sizes} />
);

function Card({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <li className="card">
      <Icon aria-hidden="true" className="size-6 text-accent" strokeWidth={1.75} />
      <h3 className="mt-3 text-[17px] leading-6 font-semibold">{title}</h3>
      <p className="mt-1.5 text-[15px] leading-6 text-pretty text-fg-2">{text}</p>
    </li>
  );
}

/** Room audio quality levels (docs/02 «Битрейт»): the bar is the Opus band of the level, 4…20 kHz. */
const BAND_KHZ = [4, 8, 12, 20] as const;

function QualityLadder({ t }: { t: T['sound'] }) {
  return (
    <div className="card">
      <h3 className="text-[17px] leading-6 font-semibold">{t.tiersTitle}</h3>
      <p className="mt-1 text-[14px] leading-5 text-fg-2">{t.bandHint}</p>
      <ol className="mt-6 flex flex-col gap-5">
        {t.tiers.map((tier, i) => (
          <li key={tier.name}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[17px] leading-6 font-semibold">{tier.name}</span>
              <span className="text-[15px] leading-6 text-fg-2 tabular-nums">{tier.kbps}</span>
            </div>
            <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-accent-tint" role="img" aria-label={`${t.band}: ${tier.band}`}>
              <div className={cx('h-full rounded-full', i === 3 ? 'bg-accent-strong' : 'bg-accent')} style={{ width: `${(BAND_KHZ[i] ?? 20) * 5}%` }} />
            </div>
            <p className="mt-1.5 text-[14px] leading-5 text-fg-2">
              {t.band}: {tier.band}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

const figure = (name: ScreenName | SceneName, locale: Locale, alt: string, caption: string, sizes: string) => (
  <figure className="min-w-0">
    <Shot scene={name} locale={locale} alt={alt} sizes={sizes} />
    <figcaption className="caption mt-3 text-center">{caption}</figcaption>
  </figure>
);

/**
 * Landing v3 feature sections (docs/09 #139), in the order of the brief: voice and video, chat,
 * calendar, boards, mail, search, wiki, disk, guests, web apps, bots, self-hosted. Every screenshot is the app in the page's
 * language with that language's team; nothing here needs JS.
 */
export function Features({ t, locale }: { t: T; locale: Locale }) {
  const x = getPageCopy(locale).features;
  const home = getHome(locale);
  const notify = getCatalog(locale).notify;
  return (
    <div id="features">
      <Split
        locale={locale}
        id="voice"
        text={
          <>
            <span id="video" className="anchor-alias" />
            <Intro id="voice-title" {...t.voice} />
            <Points items={t.voice.points} className="mt-7" />
          </>
        }
        shot={shot('call', locale, t.voice.alt)}
      />

      <Split
        locale={locale}
        id="sound"
        alt
        flip
        text={
          <>
            <Intro id="sound-title" {...t.sound} />
            <Points items={t.sound.points} className="mt-7" />
            <div id="musician" className="mt-8 rounded-[20px] border border-line bg-card p-6">
              <p className="flex items-center gap-2 text-[14px] leading-5 font-semibold text-accent-text">
                <Guitar aria-hidden="true" className="size-5" strokeWidth={1.75} />
                {t.sound.musician.eyebrow}
              </p>
              <h3 className="mt-2 text-[17px] leading-6 font-semibold">{t.sound.musician.title}</h3>
              <p className="mt-2 text-[15px] leading-6 text-pretty text-fg-2">{t.sound.musician.text}</p>
            </div>
          </>
        }
        shot={<QualityLadder t={t.sound} />}
      />

      <section id="telephony" aria-labelledby="sip-title" className="section">
        <span id="sip" className="anchor-alias" />
        <Container>
          <div className="grid items-center gap-10 lg:grid-cols-12 lg:gap-14">
            <div className="min-w-0 lg:col-span-5">
              <Intro id="sip-title" {...t.sip} />
              <Points items={t.sip.points} className="mt-7" />
              <p className="mt-5 text-[14px] leading-5 text-fg-2">{t.sip.note}</p>
            </div>
            <div className="min-w-0 lg:col-span-7">
              {figure('sipdial', locale, t.sip.dialAlt, t.sip.dialTitle, '(min-width: 1232px) 660px, (min-width: 1024px) 55vw, calc(100vw - 32px)')}
            </div>
          </div>
          <div className="mt-10">{figure('siproom', locale, t.sip.roomAlt, t.sip.roomTitle, '(min-width: 1232px) 1152px, calc(100vw - 32px)')}</div>
          <div className="mt-10 grid gap-6 md:grid-cols-2">
            {figure('sipsettings', locale, t.sip.settingsAlt, t.sip.settingsTitle, '(min-width: 1232px) 564px, (min-width: 768px) 48vw, calc(100vw - 32px)')}
            {figure('siplog', locale, t.sip.logAlt, t.sip.logTitle, '(min-width: 1232px) 564px, (min-width: 768px) 48vw, calc(100vw - 32px)')}
          </div>
          <SectionCta locale={locale} />
        </Container>
      </section>

      <Split
        locale={locale}
        id="chat"
        alt
        flip
        text={
          <>
            <Intro id="chat-title" {...t.chat} />
            <Points items={t.chat.points} className="mt-7" />
          </>
        }
        shot={shot('chat', locale, t.chat.alt)}
      />

      <Split
        locale={locale}
        id="canvas"
        flip
        text={
          <>
            <Intro id="canvas-title" {...x.canvas} />
            <Points items={x.canvas.points} className="mt-7" />
          </>
        }
        shot={shot('canvas-panel', locale, home.alts['canvas-panel'])}
      />

      <Split
        locale={locale}
        id="recording"
        alt
        text={
          <>
            <Intro id="recording-title" {...x.recording} />
            <Points items={x.recording.points} className="mt-7" />
          </>
        }
        shot={shot('recording-focus', locale, home.alts['recording-focus'])}
      />

      <section id="calendar" aria-labelledby="calendar-title" className="section">
        <Container>
          <Intro id="calendar-title" center {...t.calendar} />
          <ul className="mt-10 grid gap-4 md:grid-cols-3">
            <Card icon={CalendarCheck} {...t.calendar.cards.invites} />
            <Card icon={CalendarClock} {...t.calendar.cards.find} />
            <Card icon={CalendarSync} {...t.calendar.cards.caldav} />
          </ul>
          <div className="mt-10 grid gap-6 md:grid-cols-2">
            {shot('calendar', locale, t.calendar.alt, '(min-width: 1232px) 564px, (min-width: 768px) 48vw, calc(100vw - 32px)')}
            {shot('findtime', locale, t.calendar.findAlt, '(min-width: 1232px) 564px, (min-width: 768px) 48vw, calc(100vw - 32px)')}
          </div>
          <SectionCta locale={locale} />
        </Container>
      </section>

      <section id="boards" aria-labelledby="boards-title" className="section surface-alt">
        <Container>
          <div className="grid gap-8 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-7">
              <Intro id="boards-title" {...t.boards} />
            </div>
            <div className="lg:col-span-5">
              <Points items={t.boards.points} />
              <p className="mt-4 text-[14px] leading-5 text-fg-2">{t.boards.free}</p>
            </div>
          </div>
          <div className="mt-12">{shot('kanban', locale, t.boards.alt, '(min-width: 1232px) 1152px, calc(100vw - 32px)')}</div>
          {/* Timeline and the task panel side by side: widths in the ratio of the shots (1110 : 510), so both are as tall. */}
          <div className="mt-6 grid gap-6 md:grid-cols-[1110fr_510fr]">
            {shot('timeline', locale, t.boards.timelineAlt, '(min-width: 1232px) 780px, (min-width: 768px) 66vw, calc(100vw - 32px)')}
            {shot('task', locale, t.boards.taskAlt, '(min-width: 1232px) 360px, (min-width: 768px) 30vw, calc(100vw - 32px)')}
          </div>
          <div className="mt-6">{figure('taskhistory', locale, t.boards.historyAlt, t.boards.historyTitle, '(min-width: 1232px) 1152px, calc(100vw - 32px)')}</div>
          <SectionCta locale={locale} />
        </Container>
      </section>

      <Split
        locale={locale}
        id="mail"
        text={
          <>
            <Intro id="mail-title" {...t.mail} />
            <Points items={t.mail.points} className="mt-7" />
            <p className="mt-5 text-[14px] leading-5 text-fg-2">{t.mail.note}</p>
          </>
        }
        shot={shot('mail', locale, t.mail.alt)}
      />

      <Split
        locale={locale}
        id="search"
        alt
        flip
        text={
          <>
            <Intro id="search-title" {...t.search} />
            <Points items={t.search.points} className="mt-7" />
          </>
        }
        shot={
          <div className="mx-auto max-w-[560px]">
            <Shot scene="search" locale={locale} alt={t.search.alt} sizes="(min-width: 1024px) 560px, calc(100vw - 32px)" />
          </div>
        }
      />

      <Split
        locale={locale}
        id="wiki"
        text={
          <>
            <Intro id="wiki-title" {...t.wiki} />
            <Points items={t.wiki.points} className="mt-7" />
          </>
        }
        shot={shot('wiki', locale, t.wiki.alt)}
      />

      <Split
        locale={locale}
        id="disk"
        alt
        flip
        text={
          <>
            <Intro id="disk-title" {...t.disk} />
            <Points items={t.disk.points} className="mt-7" />
          </>
        }
        shot={shot('disk', locale, t.disk.alt)}
      />

      <Split
        locale={locale}
        id="guests"
        text={
          <>
            <Intro id="guests-title" {...t.guests} />
            <Points items={t.guests.points} className="mt-7" />
          </>
        }
        shot={
          // The waiting card on a stage of the app's background (the guest's whole window is mostly empty).
          <div className="guest-stage flex items-center justify-center rounded-[20px] px-4 py-10 sm:py-14">
            <div className="w-full max-w-[420px]">
              <Shot scene="guest" locale={locale} alt={t.guests.alt} sizes="420px" />
            </div>
          </div>
        }
      />

      <Split
        locale={locale}
        id="webapps"
        alt
        flip
        text={
          <>
            <Intro id="webapps-title" {...t.webapps} />
            <Points items={t.webapps.points} className="mt-7" />
          </>
        }
        shot={shot('webapps', locale, t.webapps.alt)}
      />

      <Split
        locale={locale}
        id="notifications"
        text={
          <>
            <Intro id="notifications-title" title={notify.title} text={notify.lead} />
            <Points items={notify.levels} className="mt-7" />
          </>
        }
        shot={shot('notifyrelay', locale, notify.alt)}
      />

      <Split
        locale={locale}
        id="ai"
        alt
        flip
        text={
          <>
            <Intro id="ai-title" {...x.ai} />
            <Points items={x.ai.points} className="mt-7" />
          </>
        }
        shot={shot('aitask', locale, home.alts.aitask)}
      />

      <Split
        locale={locale}
        id="bots"
        text={
          <>
            <Intro id="bots-title" {...t.bots} />
            <Points items={t.bots.points} className="mt-7" />
            <a href={localePath(locale, 'developers/')} className="link mt-7 inline-flex items-center gap-1 text-[16px] leading-6 font-medium">
              {t.bots.link}
              <ArrowRight aria-hidden="true" className="size-4" strokeWidth={2} />
            </a>
          </>
        }
        shot={
          <div className="code-window">
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <span aria-hidden="true" className="size-3 rounded-full bg-[#ff5f57]" />
              <span aria-hidden="true" className="size-3 rounded-full bg-[#febc2e]" />
              <span aria-hidden="true" className="size-3 rounded-full bg-[#28c840]" />
              <span className="ml-2 font-mono text-[13px] text-[#a1a1a8]">standup.ts</span>
            </div>
            <pre className="overflow-x-auto px-5 py-5 font-mono text-[13px] leading-6 text-[#e8e8ed] sm:text-[14px]" lang="en">
              <BotCode />
            </pre>
          </div>
        }
      />

      <section id="self-hosted" aria-labelledby="self-hosted-title" className="section">
        <span id="roles" className="anchor-alias" />
        <Container>
          <Intro id="self-hosted-title" center {...t.selfhost} />
          <ol className="mt-12 grid gap-4 md:grid-cols-3 md:gap-6">
            {(['server', 'install', 'invite'] as const).map((id, i) => (
              <li key={id} className="card">
                <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-accent-strong text-[15px] font-semibold text-white">
                  {i + 1}
                </span>
                <h3 className="mt-4 text-[21px] leading-7 font-semibold tracking-tight">
                  <span className="sr-only">{fmt(t.selfhost.step, { n: i + 1 })} </span>
                  {t.selfhost.steps[id].title}
                </h3>
                <p className="mt-2 text-[15px] leading-6 text-pretty text-fg-2">{t.selfhost.steps[id].text}</p>
                {id === 'server' && (
                  <pre className="mt-4 overflow-x-auto rounded-lg bg-code px-3 py-2 font-mono text-[13px] leading-5">
                    <code>infra/docker/deploy.sh</code>
                  </pre>
                )}
              </li>
            ))}
          </ol>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card icon={Lock} {...t.selfhost.security.tls} />
            <Card icon={ShieldCheck} {...t.selfhost.security.data} />
            <Card icon={Globe} {...t.selfhost.security.network} />
            <Card icon={KeyRound} {...t.selfhost.security.roles} />
          </ul>
          <SectionCta locale={locale} />
        </Container>
      </section>
    </div>
  );
}
