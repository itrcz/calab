import { ArrowUpRight } from 'lucide-react';
import type { Locale } from '@/i18n';
import { getCatalog, type CatalogKey } from '@/i18n/catalog';
import { localePath } from '@/i18n/locales';
import type { ScreenName } from '@/lib/screens';
import { Container, Frame, Screen, cx } from './ui';

/** The screenshot of a card; `phone` is three phone screens side by side. */
const shots: Record<Exclude<CatalogKey, 'phone'>, ScreenName> = {
  voice: 'voice',
  gallery: 'gallery',
  chat: 'chat',
  boards: 'taskhistory',
  calendar: 'findtime',
  search: 'search',
  mail: 'mail',
  wiki: 'wiki',
  disk: 'disk',
  notify: 'notifyrelay',
  apps: 'webapps',
  sip: 'sipdial',
};
/** Wide cards span both columns with the text beside the picture. */
const WIDE = new Set<CatalogKey>(['voice', 'boards', 'disk', 'mail', 'phone']);
/** Where «Подробнее» leads: a section of /features/ or of this page (`#…`). */
const links: Record<CatalogKey, string> = {
  voice: 'features/#voice',
  gallery: 'features/#voice',
  chat: 'features/#chat',
  boards: 'features/#boards',
  calendar: 'features/#calendar',
  search: 'features/#search',
  mail: 'features/#mail',
  wiki: 'features/#wiki',
  disk: 'features/#disk',
  phone: '#mobile',
  notify: '#notifications',
  apps: 'features/#webapps',
  sip: 'features/#sip',
};
/** Display order: the two-column cards come in pairs between the wide ones. */
const ORDER: CatalogKey[] = ['voice', 'gallery', 'chat', 'boards', 'calendar', 'search', 'disk', 'mail', 'wiki', 'notify', 'phone', 'apps', 'sip'];
/** Two-column cards show their shot in one 16:11 window (cover); the part that matters stays in view. */
const FOCUS: Partial<Record<CatalogKey, string>> = { chat: 'object-bottom', apps: '!object-contain object-center', sip: '!object-contain object-center' };
export const PHONE_SHOTS = ['phone-rooms', 'phone-chat', 'phone-board'] as const satisfies readonly ScreenName[];

/** A phone screenshot in a rounded device edge (the capture is the 390×844 iPhone 14 viewport). */
export function PhoneShot({ name, locale, alt, sizes }: { name: ScreenName; locale: Locale; alt: string; sizes: string }) {
  return (
    <div className="phone-frame">
      <Screen name={name} locale={locale} alt={alt} sizes={sizes} />
    </div>
  );
}

/**
 * «Что есть в Calab» (landing 3.3): every big feature as a real screenshot and one or two sentences,
 * in two columns (one on phones); the widest scenes span the row. Static, no scripts.
 */
export function FeatureCatalog({ locale }: { locale: Locale }) {
  const t = getCatalog(locale);
  return (
    <section id="features" aria-labelledby="catalog-title" className="py-16 sm:py-24">
      <Container>
        <div className="sticker-section-heading">
          <div className="max-w-[820px]">
            <h2 id="catalog-title" className="editorial-title text-balance">{t.title}</h2>
            <p className="mt-4 text-[17px] leading-7 text-pretty text-fg-2 sm:text-[19px] sm:leading-8">{t.lead}</p>
          </div>
          <img className="section-sticker" src="/editorial/sticker-tasks.webp" width={180} height={180} alt="" aria-hidden="true" loading="lazy" />
        </div>
        <ul className="mt-10 grid list-none gap-5 sm:mt-12 lg:grid-cols-2">
          {ORDER.map((key) => t.cards.find((c) => c.key === key)).filter((c) => c !== undefined).map((card) => {
            const wide = WIDE.has(card.key);
            const href = links[card.key].startsWith('#') ? links[card.key] : `${localePath(locale, '')}${links[card.key]}`;
            const text = (
              <div className={cx('min-w-0', wide && 'lg:col-span-4')}>
                <h3 className="text-[22px] leading-7 font-bold text-balance sm:text-[26px] sm:leading-8">
                  {card.title}
                  {card.key === 'mail' && <span className="catalog-badge">{t.desktopOnly}</span>}
                </h3>
                <p className="mt-3 text-[16px] leading-6 text-pretty text-fg-2 sm:text-[17px] sm:leading-7">{card.text}</p>
                <a href={href} className="mt-4 inline-flex items-center gap-1.5 text-[15px] font-semibold text-accent-text hover:underline">
                  {t.more}
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
              </div>
            );
            const picture =
              card.key === 'phone' ? (
                <div className={cx('catalog-phones', wide && 'order-first lg:order-none lg:col-span-8')}>
                  {PHONE_SHOTS.map((name, i) => (
                    <PhoneShot key={name} name={name} locale={locale} alt={`${card.alt}: ${t.mobile.alts[i] ?? ''}`} sizes="(min-width: 1024px) 250px, 30vw" />
                  ))}
                </div>
              ) : (
                <div className={cx('min-w-0', wide && 'order-first lg:order-none lg:col-span-8')}>
                  <Frame className={wide ? '' : 'catalog-shot'}>
                    <Screen
                      name={shots[card.key]}
                      locale={locale}
                      alt={card.alt}
                      className={wide ? '' : cx('h-full object-cover', FOCUS[card.key] ?? 'object-top')}
                      sizes={wide ? '(min-width: 1360px) 860px, (min-width: 1024px) 62vw, calc(100vw - 72px)' : '(min-width: 1360px) 620px, (min-width: 1024px) 46vw, calc(100vw - 72px)'}
                    />
                  </Frame>
                </div>
              );
            return (
              <li key={card.key} id={`catalog-${card.key}`} className={cx('catalog-card rounded-[20px] bg-card p-5 sm:p-7', wide ? 'grid items-center gap-6 lg:col-span-2 lg:grid-cols-12 lg:gap-10' : 'flex flex-col gap-6')}>
                {wide ? (
                  <>
                    {text}
                    {picture}
                  </>
                ) : (
                  <>
                    {picture}
                    {text}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </Container>
    </section>
  );
}
