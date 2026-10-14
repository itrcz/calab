import { BillingSalesMode, PaymentMethodKind, type BillingPlanOffer, type GetBillingResponse, type PaymentMethodOption } from '@calaba/protocol';
import type { MessageKey } from '../../i18n';

/**
 * Markets of balance billing in the client (ADR-0083): Global ($, Stripe) and Russia (₽, Tochka).
 * The server decides which markets a new account may be opened in (sales_mode, markets) and fixes
 * the account's market at its first payment; the client only preselects one — by the owner's
 * remembered choice, else by the UI language, and only when both are open — and sends the explicit
 * choice with the ACTIVATE quote. Pure rules, unit-tested.
 */

export type Market = 'global' | 'ru';

const isMarket = (m: string | undefined): m is Market => m === 'global' || m === 'ru';

/** The markets the owner may choose between now (BOTH only; empty when there is nothing to choose). */
export function choosableMarkets(d: GetBillingResponse | null | undefined): Market[] {
  if (!d || d.salesMode !== BillingSalesMode.BOTH) return [];
  return d.markets.filter(isMarket);
}

/** No acquirer takes new clients: paid plans by «contact us», Global prices, no payment step. */
export const contactOnly = (d: GetBillingResponse | null | undefined): boolean => d?.salesMode === BillingSalesMode.CONTACT;

/**
 * The market the plan screen shows: the account's once fixed; in BOTH the remembered choice, else
 * ru for a Russian UI, else global; otherwise the server's default (the only open one / Global).
 */
export function screenMarket(d: GetBillingResponse | null | undefined, remembered: string | undefined, locale: string): Market {
  if (!d) return 'global';
  const own = d.summary?.market;
  if (d.salesMode === BillingSalesMode.UNSPECIFIED) return isMarket(own) ? own : 'global';
  if (d.salesMode === BillingSalesMode.CONTACT) return 'global';
  const open = d.markets.filter(isMarket);
  if (d.salesMode === BillingSalesMode.BOTH) {
    if (isMarket(remembered) && open.includes(remembered)) return remembered;
    return locale.toLowerCase().startsWith('ru') && open.includes('ru') ? 'ru' : 'global';
  }
  if (isMarket(d.defaultMarket) && open.includes(d.defaultMarket)) return d.defaultMarket;
  return open[0] ?? 'global';
}

/** The market to send with the ACTIVATE quote: only before the first payment (else undefined). */
export function quoteMarket(d: GetBillingResponse | null | undefined, market: Market): Market | undefined {
  if (!d || d.salesMode === BillingSalesMode.UNSPECIFIED || d.salesMode === BillingSalesMode.CONTACT) return undefined;
  return market;
}

/** The plan offers of one market (offers of an older server carry no market: all of them). */
export function offersOf(offers: readonly BillingPlanOffer[], market: Market): BillingPlanOffer[] {
  if (!offers.some((o) => o.market)) return [...offers];
  return offers.filter((o) => o.market === market);
}

/** The seller and currency line of a market (ADR-0080 §2.1: shown before paying). */
export const MARKET_SELLER: Record<Market, MessageKey> = {
  global: 'billing.market.sellerGlobal',
  ru: 'billing.market.sellerRu',
};

/** The switch labels. */
export const MARKET_LABEL: Record<Market, MessageKey> = {
  global: 'billing.market.global',
  ru: 'billing.market.ru',
};

/** The name of a payment method: Tochka's card is «Карта МИР», SBP «СБП», Stripe's card «Банковская карта». */
export function methodLabel(m: Pick<PaymentMethodOption, 'provider' | 'kind'>): MessageKey {
  if (m.kind === PaymentMethodKind.SBP) return 'billing.method.sbp';
  if (m.kind === PaymentMethodKind.BANK_TRANSFER) return 'billing.method.bank';
  return m.provider === 'tochka' ? 'billing.method.cardMir' : 'billing.method.card';
}

/** The acquirer shown next to a method (a brand name, not translated). */
export function providerTag(provider: string): string {
  if (provider === 'stripe') return 'Stripe';
  if (provider === 'tochka') return 'Точка';
  return '';
}
