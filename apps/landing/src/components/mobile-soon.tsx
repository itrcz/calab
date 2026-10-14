import { Check } from 'lucide-react';
import type { Locale } from '@/i18n';
import { getCatalog } from '@/i18n/catalog';
import { rich } from '@/lib/rich';
import { APP_URL } from '@/lib/site';
import { PhoneShot } from './feature-catalog';
import { Container } from './ui';

const SHOTS = ['phone-rooms', 'phone-chat', 'phone-voice'] as const;

/**
 * «Скоро: iOS и Android» (landing 3.3, owner 13.10): a plain block on the page — no dates, no sign-up
 * form — with the phone screens of today's web client and a link to it.
 */
export function MobileSoon({ locale }: { locale: Locale }) {
  const t = getCatalog(locale).mobile;
  return (
    <section id="mobile" aria-labelledby="mobile-title" className="py-16 sm:py-24">
      <Container>
        <div className="mobile-soon grid items-center gap-10 rounded-[28px] p-6 sm:p-10 lg:grid-cols-12 lg:gap-12 lg:p-14">
          <div className="min-w-0 lg:col-span-5">
            <p className="inline-flex rounded-full bg-accent-strong px-3 py-1 text-[13px] leading-5 font-semibold tracking-wide text-white uppercase">{t.eyebrow}</p>
            <h2 id="mobile-title" className="editorial-title mt-5 text-balance">{t.title}</h2>
            <p className="mt-4 text-[17px] leading-7 text-pretty text-fg-2 sm:text-[19px] sm:leading-8">{t.lead}</p>
            <ul className="mt-6 flex flex-col gap-3 text-[16px] leading-6">
              {t.points.map((p) => (
                <li key={p} className="flex gap-3">
                  <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" strokeWidth={2.25} />
                  <span className="text-pretty">{p}</span>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-[15px] leading-6 text-pretty text-fg-2">
              {rich(t.now, { link: <a href={APP_URL} className="link">{t.nowLink}</a> })}
            </p>
          </div>
          <div className="mobile-soon-phones min-w-0 lg:col-span-7">
            {SHOTS.map((name, i) => (
              <PhoneShot key={name} name={name} locale={locale} alt={t.alts[i] ?? ''} sizes="(min-width: 1024px) 230px, 30vw" />
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}
