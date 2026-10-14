// Plan prices of the landing (ADR-0083). The server owns the numbers: GET {APP_URL}/api/billing/public/offers
// answers with the sales mode and the per-seat-day prices of the open markets. Pure logic only (parse, pick,
// format) — no DOM — so scripts/check-offers.mjs can run it; the fetch and the cookie are in offers-store.ts.

export type SalesMode = 'both' | 'ru_only' | 'global_only' | 'contact';
export type Market = 'ru' | 'global';
export type PaidPlan = 'team' | 'business';

/** Price per seat per day in minor units (cents / kopecks). */
export type Price = { minor: number; currency: 'USD' | 'RUB' };
export type Offers = {
  mode: SalesMode;
  /** market → plan → price; only complete markets (both paid plans) are kept. */
  prices: Partial<Record<Market, Record<PaidPlan, Price>>>;
  /** «Contact us» target of the paid plans (http(s) or mailto), '' when the server sent none. */
  contact: string;
};

/**
 * Build-time snapshot — what the page shows until the server answers and when it cannot be reached
 * (ADR-0024 plans, ADR-0083 prices; equal to the dictionaries' static prices). It is the last known price list,
 * not a promise: the checkout in the app always shows the server's number. «On request» would hide prices from
 * every visitor whenever the API hiccups; a stale-by-a-few-days price is the lesser evil, and the paid buttons
 * stay the safe «Contact us» form link in this state.
 */
export const SNAPSHOT: Record<Market, Record<PaidPlan, Price>> = {
  ru: { team: { minor: 600, currency: 'RUB' }, business: { minor: 1800, currency: 'RUB' } },
  global: { team: { minor: 10, currency: 'USD' }, business: { minor: 30, currency: 'USD' } },
};

const MODES: Record<string, SalesMode> = {
  BILLING_SALES_MODE_BOTH: 'both',
  BILLING_SALES_MODE_RU_ONLY: 'ru_only',
  BILLING_SALES_MODE_GLOBAL_ONLY: 'global_only',
  BILLING_SALES_MODE_CONTACT: 'contact',
  '1': 'both',
  '2': 'ru_only',
  '3': 'global_only',
  '4': 'contact',
};
const PLANS: Record<string, PaidPlan> = { PLAN_TEAM: 'team', '2': 'team', PLAN_ENTERPRISE: 'business', '4': 'business' };
const CURRENCY: Record<Market, Price['currency']> = { ru: 'RUB', global: 'USD' };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** protojson body → Offers; null for anything the page cannot trust (the caller then keeps the snapshot). */
export function parseOffers(body: unknown): Offers | null {
  if (!isRecord(body)) return null;
  const mode = MODES[String(body.mode)];
  if (!mode || !Array.isArray(body.offers)) return null;
  const found: Partial<Record<Market, Partial<Record<PaidPlan, Price>>>> = {};
  for (const o of body.offers) {
    if (!isRecord(o) || !isRecord(o.unitPrice)) continue;
    const plan = PLANS[String(o.plan)];
    const market: Market | null = o.market === 'ru' || o.market === 'global' ? o.market : null;
    const minor = Number(o.unitPrice.minor); // int64 comes as a JSON string
    if (!plan || !market || !Number.isSafeInteger(minor) || minor <= 0) continue;
    if (o.unitPrice.currency !== CURRENCY[market]) continue;
    (found[market] ??= {})[plan] = { minor, currency: CURRENCY[market] };
  }
  const prices: Offers['prices'] = {};
  for (const market of ['ru', 'global'] as const) {
    const m = found[market];
    if (m?.team && m.business) prices[market] = { team: m.team, business: m.business };
  }
  const open = mode === 'ru_only' ? prices.ru : mode === 'both' ? prices.ru && prices.global : prices.global;
  if (!open) return null;
  const contact = typeof body.contact === 'string' && /^(https?:\/\/|mailto:)/i.test(body.contact) ? body.contact : '';
  return { mode, prices, contact };
}

export type View = {
  mode: SalesMode | 'snapshot';
  market: Market;
  prices: Record<PaidPlan, Price>;
  /** both markets are open: the visitor may switch. */
  switchable: boolean;
  /** paid plans are sold by request (contact mode). */
  contactOnly: boolean;
  contact: string;
};

/** Which market the page shows: the server's mode decides, an explicit choice and the language only inside `both`. */
export function pickView(offers: Offers | null, lang: string, choice: Market | null): View {
  const byLang: Market = lang === 'ru' ? 'ru' : 'global';
  if (!offers) {
    return { mode: 'snapshot', market: byLang, prices: SNAPSHOT[byLang], switchable: false, contactOnly: false, contact: '' };
  }
  const market: Market =
    offers.mode === 'ru_only' ? 'ru' : offers.mode === 'both' ? (choice ?? byLang) : 'global'; // global_only, contact
  const prices = offers.prices[market] ?? SNAPSHOT[market];
  return {
    mode: offers.mode,
    market,
    prices,
    switchable: offers.mode === 'both',
    contactOnly: offers.mode === 'contact',
    contact: offers.contact,
  };
}

const NBSP = ' ';

/** «6 ₽», «$0.10» (ru: «0,10 $»). Whole amounts drop the fraction. */
export function formatMoney(minor: number, currency: Price['currency'], lang: string): string {
  const whole = minor % 100 === 0;
  const n = new Intl.NumberFormat(lang === 'ru' ? 'ru-RU' : 'en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(minor / 100);
  if (currency === 'RUB') return `${n}${NBSP}₽`;
  return lang === 'ru' ? `${n}${NBSP}$` : `$${n}`;
}

/** Per seat per 30 days (the app's plan screen: «≈ … за человека за 30 дней»). */
export const monthMinor = (p: Price): number => p.minor * 30;
