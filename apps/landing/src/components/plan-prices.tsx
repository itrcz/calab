'use client';

import type { Dict, Locale } from '@/i18n';
import { LOCALE_INFO } from '@/i18n/locales';
import { formatMoney, monthMinor, type Market, type PaidPlan } from '@/lib/offers';
import { useOffersView } from '@/lib/offers-store';
import { APP_URL, CONTACT_FORM_URL } from '@/lib/site';
import { Button, cx } from './ui';

// Leaves of the pricing section that show the server's prices (ADR-0083). Server-rendered with the build-time
// snapshot, so the first paint already has the final text and size; they only re-render when the answer differs.

type Live = Dict['pricing']['live'];

const useLang = (locale: Locale) => LOCALE_INFO[locale].lang;

/** «6 ₽» / «$0.10» — per seat per day. */
export function PlanPrice({ plan, locale }: { plan: PaidPlan; locale: Locale }) {
  const lang = useLang(locale);
  const { view } = useOffersView(lang);
  const p = view.prices[plan];
  return <>{formatMoney(p.minor, p.currency, lang)}</>;
}

/** «≈ 180 ₽ за человека за 30 дней» (the app's wording). */
export function PlanMonth({ plan, locale, t, className }: { plan: PaidPlan; locale: Locale; t: Live; className?: string }) {
  const lang = useLang(locale);
  const { view } = useOffersView(lang);
  const p = view.prices[plan];
  return <p className={className}>{t.perMonth.replace('{amount}', formatMoney(monthMinor(p), p.currency, lang))}</p>;
}

/**
 * Button of a paid plan. Open sales → straight into the app; contact mode → «On request» to the server's contact
 * link; before/without an answer → the intake form, as before billing existed.
 */
export function PlanCta({ locale, t, label }: { locale: Locale; t: Live; label: string }) {
  const { view } = useOffersView(useLang(locale));
  if (view.mode === 'snapshot') {
    return <Button href={CONTACT_FORM_URL} variant="secondary" className="w-full">{label}</Button>;
  }
  if (view.contactOnly) {
    return <Button href={view.contact || CONTACT_FORM_URL} variant="secondary" className="w-full">{t.request}</Button>;
  }
  return <Button href={APP_URL} variant="secondary" className="w-full">{t.connect}</Button>;
}

const MARKETS: Market[] = ['ru', 'global'];

/** «Prices in …» line with the ₽ / $ switch (only while both markets are open). Fixed height: nothing moves. */
export function PricesBar({ locale, t }: { locale: Locale; t: Live }) {
  const { view, choose } = useOffersView(useLang(locale));
  const caption = view.contactOnly ? t.contactNote : view.market === 'ru' ? t.pricesInRub : t.pricesInUsd;
  return (
    <div className="mt-8 flex min-h-11 flex-wrap items-center justify-between gap-x-6 gap-y-2 sm:mt-10">
      <p className="text-[14px] leading-5 text-fg-2">{caption}</p>
      {view.switchable && (
      <div role="group" aria-label={t.switchLabel} className="inline-flex rounded-full bg-card p-1">
        {MARKETS.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={view.market === m}
            onClick={() => {
              choose(m);
            }}
            className={cx(
              'h-9 min-w-14 cursor-pointer rounded-full px-4 text-[14px] font-semibold motion-safe:transition-colors motion-safe:duration-150',
              view.market === m ? 'bg-accent-strong text-white' : 'text-fg-2 hover:text-fg',
            )}
          >
            {m === 'ru' ? t.currencyRub : t.currencyUsd}
          </button>
        ))}
      </div>
      )}
    </div>
  );
}
