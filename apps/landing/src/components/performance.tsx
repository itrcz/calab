import type { Dict, Locale } from '@/i18n';
import { LOCALE_INFO } from '@/i18n/locales';
import { repoFile } from '@/lib/site';
import { Section, SectionHeading, cx } from './ui';
import { SectionCta } from './section-cta';

type T = Dict['perf'];

/**
 * Measured numbers only (docs/14-energy.md, docs/18-optimization-audit.md): CPU as % of one core, MacBook Air M4,
 * `top` over all processes of the app, tools/energy-bench.py. Change a number here only together with its source.
 *  - IDLE: scenarios A / B — Calab (optimised build) vs Discord 0.0.413, the same machine, back to back.
 *  - GAINS: Calab 0.5.1 vs the optimised build — C (voice, quiet), E2 (video, window hidden), «Без стекла» E (video + menu),
 *    «Бесконечные анимации: REC» (app sum), docs/18 #2 (macOS dmg, MB).
 * Voice / video of Discord were not measured (docs/14 «Discord: что сравнимо») — no claim about them.
 */
const IDLE = [
  { id: 'visible', calab: 0.05, discord: 0.97 },
  { id: 'hidden', calab: 0.2, discord: 0.85 },
] as const;

const GAINS = [
  { id: 'voice', before: 14.96, after: 6.92, unit: '%' },
  { id: 'video', before: 17.46, after: 6.98, unit: '%' },
  { id: 'menu', before: 17.19, after: 11.38, unit: '%' },
  { id: 'rec', before: 59.1, after: 11.7, unit: '%' },
  { id: 'bundle', before: 146.2, after: 130.0, unit: 'mb' },
] as const;

function Bar({ value, max, strong, label }: { value: number; max: number; strong?: boolean; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-accent-tint" aria-hidden="true">
        <div className={cx('h-full rounded-full', strong ? 'bg-accent-strong' : 'bg-fg-2/50')} style={{ width: `${Math.max(1.5, (value / max) * 100)}%` }} />
      </div>
      <span className="w-[72px] shrink-0 text-right text-[15px] leading-6 font-semibold tabular-nums">{label}</span>
    </div>
  );
}

export function Performance({ t, locale }: { t: T; locale: Locale }) {
  const lang = LOCALE_INFO[locale].lang;
  const num = (n: number, digits: number): string => new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  const pct = (n: number): string => new Intl.NumberFormat(lang, { style: 'percent', minimumFractionDigits: n < 1 ? 2 : 1, maximumFractionDigits: n < 1 ? 2 : 1 }).format(n / 100);
  const val = (n: number, unit: 'mb' | '%'): string => (unit === 'mb' ? `${num(n, 1)}\u00a0${t.mb}` : pct(n));
  return (
    <Section id="performance" labelledBy="performance-title">
      <SectionHeading id="performance-title" title={t.title} lead={t.lead} />

      <div className="mt-12 rounded-[20px] border border-line bg-card p-6 sm:mt-16 sm:p-8">
        <h3 className="text-[21px] leading-7 font-semibold tracking-tight">{t.idleTitle}</h3>
        <p className="mt-1 max-w-[680px] text-[15px] leading-6 text-pretty text-fg-2">{t.idleText}</p>
        <div className="mt-6 grid gap-8 md:grid-cols-2">
          {IDLE.map((row) => {
            const max = Math.max(row.calab, row.discord);
            return (
              <div key={row.id}>
                <p className="text-[15px] leading-6 font-semibold">{t[row.id]}</p>
                <div className="mt-3 flex flex-col gap-3">
                  <div>
                    <p className="text-[14px] leading-5 text-fg-2">{t.calab}</p>
                    <Bar value={row.calab} max={max} strong label={pct(row.calab)} />
                  </div>
                  <div>
                    <p className="text-[14px] leading-5 text-fg-2">{t.discord}</p>
                    <Bar value={row.discord} max={max} label={pct(row.discord)} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <h3 className="mt-12 text-center text-[21px] leading-7 font-semibold tracking-tight">{t.gainsTitle}</h3>
      <ul className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {GAINS.map((g) => {
          const card = t.cards[g.id];
          return (
            <li key={g.id} className="rounded-[18px] border border-line bg-card p-6">
              <h4 className="text-[17px] leading-6 font-semibold">{card.title}</h4>
              <p className="mt-1.5 text-[15px] leading-6 text-pretty text-fg-2">{card.text}</p>
              <div className="mt-4 flex flex-col gap-2.5">
                <div>
                  <p className="text-[13px] leading-5 text-fg-2">{t.before}</p>
                  <Bar value={g.before} max={g.before} label={val(g.before, g.unit)} />
                </div>
                <div>
                  <p className="text-[13px] leading-5 text-fg-2">{t.after}</p>
                  <Bar value={g.after} max={g.before} strong label={val(g.after, g.unit)} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mx-auto mt-10 max-w-[820px] text-[14px] leading-5 text-pretty text-fg-2">
        <p>{t.notMeasured}</p>
        <p className="mt-3">
          <span className="font-semibold text-fg">{t.methodTitle}.</span> {t.method}{' '}
          <a href={repoFile('docs/14-energy.md')} className="link">
            {t.source}
          </a>
        </p>
      </div>
      <SectionCta locale={locale} />
    </Section>
  );
}
