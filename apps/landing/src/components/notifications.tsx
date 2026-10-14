import { Bell, BellOff, Check, ListChecks, Monitor, Send, Smartphone, type LucideIcon } from 'lucide-react';
import type { Locale } from '@/i18n';
import { getCatalog } from '@/i18n/catalog';
import { Container, Frame, Screen, SectionHeading } from './ui';

function List({ items }: { items: string[] }) {
  return (
    <ul className="mt-3 flex flex-col gap-2.5 text-[15px] leading-6 text-fg-2">
      {items.map((p) => (
        <li key={p} className="flex gap-2.5">
          <Check aria-hidden="true" className="mt-0.5 size-4.5 shrink-0 text-accent" strokeWidth={2.25} />
          <span className="text-pretty">{p}</span>
        </li>
      ))}
    </ul>
  );
}

function Block({ icon: Icon, title, items }: { icon: LucideIcon; title: string; items: string[] }) {
  return (
    <li className="rounded-[20px] bg-card p-5 sm:p-6">
      <h3 className="flex items-center gap-3 text-[19px] leading-6 font-bold">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-tint text-accent-text">
          <Icon aria-hidden="true" className="size-5" strokeWidth={2} />
        </span>
        {title}
      </h3>
      <List items={items} />
    </li>
  );
}

/**
 * «Уведомления» (landing 3.3): what arrives and where — the desktop, the phone, Telegram through your
 * own bot (ADR-0090) — the levels per workspace / room, Do not disturb and the task triggers
 * (ADR-0089), with the real settings screen.
 */
export function Notifications({ locale }: { locale: Locale }) {
  const t = getCatalog(locale).notify;
  return (
    <section id="notifications" aria-labelledby="notifications-title" className="py-16 sm:py-24">
      <Container>
        <SectionHeading id="notifications-title" eyebrow={t.eyebrow} title={t.title} lead={t.lead} />
        <ul className="mt-10 grid list-none gap-5 md:grid-cols-3">
          <Block icon={Monitor} title={t.channels.desktop.title} items={t.channels.desktop.points} />
          <Block icon={Smartphone} title={t.channels.phone.title} items={t.channels.phone.points} />
          <Block icon={Send} title={t.channels.telegram.title} items={t.channels.telegram.points} />
        </ul>
        <div className="mt-5 grid items-start gap-5 lg:grid-cols-12">
          <figure className="min-w-0 rounded-[20px] bg-card p-5 sm:p-7 lg:col-span-7">
            <Frame>
              <Screen name="notifyrelay" locale={locale} alt={t.alt} sizes="(min-width: 1360px) 720px, (min-width: 1024px) 54vw, calc(100vw - 72px)" />
            </Frame>
            <figcaption className="mt-3 text-center text-[14px] leading-5 text-fg-2">{t.shotCaption}</figcaption>
          </figure>
          <div className="grid min-w-0 gap-5 lg:col-span-5">
            <div className="rounded-[20px] bg-card p-5 sm:p-6">
              <h3 className="flex items-center gap-3 text-[19px] leading-6 font-bold">
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-tint text-accent-text">
                  <BellOff aria-hidden="true" className="size-5" strokeWidth={2} />
                </span>
                {t.levelsTitle}
              </h3>
              <List items={t.levels} />
            </div>
            <div className="rounded-[20px] bg-card p-5 sm:p-6">
              <h3 className="flex items-center gap-3 text-[19px] leading-6 font-bold">
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-tint text-accent-text">
                  <ListChecks aria-hidden="true" className="size-5" strokeWidth={2} />
                </span>
                {t.tasksTitle}
              </h3>
              <List items={t.tasks} />
              <p className="mt-4 flex gap-2 text-[14px] leading-5 text-fg-2">
                <Bell aria-hidden="true" className="mt-0.5 size-4 shrink-0" strokeWidth={2} />
                {t.tasksNote}
              </p>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
