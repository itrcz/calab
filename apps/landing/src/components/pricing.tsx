import { ChevronDown, Lock } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { localePath, type Dict, type Locale } from '@/i18n';
import { APP_URL, CONTACT_FORM_URL, repoFile } from '@/lib/site';
import { Button, Section, SectionHeading } from './ui';

const PLAN_IDS = ['free', 'team', 'business', 'enterprise'] as const;
type PlanId = (typeof PLAN_IDS)[number];
type RowId = keyof Dict['pricing']['table']['rows'];
const ROW_IDS = Object.keys({
  room: 0,
  members: 0,
  audio: 0,
  video: 0,
  streams: 0,
  cameras: 0,
  files: 0,
  bots: 0,
  stickers: 0,
  boards: 0,
  calendar: 0,
  caldav: 0,
  musician: 0,
  checklists: 0,
  approvals: 0,
  webapps: 0,
  sip: 0,
  webhook: 0,
  sso: 0,
  whitelabel: 0,
  onprem: 0,
  support: 0,
  price: 0,
} satisfies Record<RowId, 0>) as RowId[];


const CTA: Record<PlanId, (t: Dict['pricing']) => ReactNode> = {
  free: (t) => (
    <div className="flex gap-2">
      <Button href="#download" size="card" className="min-w-0 flex-1">
        {t.cta.download}
      </Button>
      <Button href={APP_URL} variant="secondary" size="card" className="min-w-0 flex-1">
        {t.cta.web}
      </Button>
    </div>
  ),
  team: (t) => (
    <Button href={CONTACT_FORM_URL} variant="secondary" className="w-full">
      {t.cta.contact}
    </Button>
  ),
  business: (t) => (
    <Button href={CONTACT_FORM_URL} variant="secondary" className="w-full">
      {t.cta.contact}
    </Button>
  ),
  enterprise: (t) => (
    <Button href={repoFile('COMMERCIAL-LICENSE.md')} variant="secondary" className="w-full">
      {t.cta.license}
    </Button>
  ),
};

/** A table value: '∞', '—' and '✓' are symbols for the eye and words for a screen reader. */
function Cell({ value, t }: { value: string; t: Dict['pricing']['table'] }) {
  if (value === '✗') {
    return (
      <>
        <Lock aria-hidden="true" className="size-4 text-fg-2" strokeWidth={1.75} />
        <span className="sr-only">{t.locked}</span>
      </>
    );
  }
  const spoken = { '∞': t.unlimited, '—': t.no, '✓': t.yes }[value];
  if (!spoken) return <>{value}</>;
  return (
    <>
      <span aria-hidden="true" className={value === '∞' ? 'text-[19px] leading-none' : value === '—' ? 'text-fg-2' : 'text-accent'}>
        {value}
      </span>
      <span className="sr-only">{spoken}</span>
    </>
  );
}

/**
 * Plans (README «Тарифы», ADR-0024; Free · Team · Business · Enterprise = own server): four plan cards (Free is where to start) and one comparison
 * table from md up, expanded by default; on phones the table would need a sideways scroll, so each card carries its own
 * values in a native <details> instead (no JS).
 */
export function Pricing({ t, locale }: { t: Dict['pricing']; locale: Locale }) {
  const tb = t.table;
  return (
    <Section id="pricing" labelledBy="pricing-title">
      <div className="sticker-section-heading">
      <SectionHeading id="pricing-title" eyebrow={t.eyebrow} title={t.title} lead={t.lead} />
        <img className="section-sticker" src="/editorial/sticker-pricing.webp" width={180} height={180} alt="" loading="lazy" />
      </div>
      <ul className="mt-12 grid gap-4 sm:mt-16 md:grid-cols-2 lg:grid-cols-4">
        {PLAN_IDS.map((id, col) => {
          const plan = t.plans[id];
          const start = id === 'free';
          return (
            <li
              key={id}
              className={
                'relative flex flex-col rounded-[24px] border bg-card p-6 ' + (start ? 'border-2 border-accent' : 'border-line')
              }
            >
              {start && (
                <p className="absolute -top-3 left-6 rounded-full bg-accent-strong px-3 py-0.5 text-[13px] leading-5 font-semibold text-white">
                  {t.startHere}
                </p>
              )}
              <h3 id={`plan-${id}`} className="text-[17px] leading-6 font-semibold">
                {plan.name}
              </h3>
              <p className="mt-1 text-[24px] leading-8 font-semibold tracking-tight">{plan.price}</p>
              {(id === 'team' || id === 'business') && (
                <p className="mt-1 text-[14px] leading-5 text-fg-2">{t.perSeatDay}</p>
              )}
              <p className="mt-1 text-[14px] leading-5 text-pretty text-fg-2">{plan.note}</p>
              <details className="group mt-4 md:hidden">
                <summary className="flex min-h-11 cursor-pointer items-center justify-between rounded-md text-[15px] font-medium text-accent-text">
                  {tb.details}
                  <ChevronDown aria-hidden="true" className="chevron size-5 motion-safe:transition-transform" strokeWidth={1.75} />
                </summary>
                <dl className="divide-y divide-line border-t border-line text-[15px] leading-6">
                  {ROW_IDS.map((row) => (
                    <div key={row} className="flex justify-between gap-4 py-2">
                      <dt className="text-fg-2">{tb.rows[row]}</dt>
                      <dd className="text-right font-medium">
                        <Cell value={tb.cells[row][col] ?? ''} t={tb} />
                        {row === 'price' && (id === 'team' || id === 'business') && (
                          <span className="block text-[12px] font-normal text-fg-2">{t.perSeatDay}</span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
              <div className="mt-auto pt-6">{CTA[id](t)}</div>
            </li>
          );
        })}
      </ul>
      <p className="mt-6 max-w-[860px] text-[14px] leading-6 text-fg-2">
        {t.billingNote}{' '}
        <Link href={localePath(locale, 'legal/offer/')} className="link">{t.offerLink}</Link>
      </p>
      <div className="mt-10 hidden overflow-hidden rounded-[24px] md:block">
        <table className="w-full table-fixed border-collapse text-[15px] leading-6">
          <caption className="sr-only">{tb.caption}</caption>
          <colgroup>
            <col className="w-[24%]" />
            <col span={4} />
          </colgroup>
          <thead className="bg-bg-alt">
            <tr>
              <th scope="col" className="px-4 py-3 text-left text-[13px] font-semibold tracking-wide text-fg-2 uppercase">
                {tb.feature}
              </th>
              {PLAN_IDS.map((id) => (
                <th key={id} scope="col" className={'px-4 py-3 text-left font-semibold' + (id === 'free' ? ' text-accent-text' : '')}>
                  {t.plans[id].name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {ROW_IDS.map((row) => (
              <tr key={row}>
                <th scope="row" className="px-4 py-3 text-left align-top font-normal text-fg-2">
                  {tb.rows[row]}
                </th>
                {tb.cells[row].map((v, col) => (
                  <td key={PLAN_IDS[col]} className="px-4 py-3 align-top text-pretty">
                    <Cell value={v} t={tb} />
                    {row === 'price' && (col === 1 || col === 2) && (
                      <span className="block text-[12px] text-fg-2">{t.perSeatDay}</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-10 max-w-[860px] border-l-4 border-accent pl-6 text-[14px] leading-5 text-pretty text-fg-2">
        {t.license}{' '}
        <a href={repoFile('LICENSE')} className="link">
          {t.licenseLink}
        </a>
      </p>
    </Section>
  );
}
