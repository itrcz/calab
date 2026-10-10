import { create } from '@bufbuild/protobuf';
import { BillingPlanOfferSchema, BillingSalesMode, BillingSummarySchema, GetBillingResponseSchema, PaymentMethodKind, Plan } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { choosableMarkets, contactOnly, methodLabel, offersOf, quoteMarket, screenMarket } from './market';

const resp = (salesMode: BillingSalesMode, markets: string[], defaultMarket = '', accountMarket?: string) =>
  create(GetBillingResponseSchema, { salesMode, markets, defaultMarket, ...(accountMarket ? { summary: create(BillingSummarySchema, { market: accountMarket }) } : {}) });

describe('billing markets (ADR-0083)', () => {
  it('preselects by language only when both markets are open', () => {
    const both = resp(BillingSalesMode.BOTH, ['global', 'ru'], 'global');
    expect(screenMarket(both, undefined, 'ru')).toBe('ru');
    expect(screenMarket(both, undefined, 'en')).toBe('global');
    expect(screenMarket(both, 'global', 'ru')).toBe('global'); // the remembered choice wins
    expect(screenMarket(both, 'ru', 'zh-CN')).toBe('ru');
    expect(choosableMarkets(both)).toEqual(['global', 'ru']);
    expect(quoteMarket(both, 'ru')).toBe('ru');
  });

  it('follows the server when one market is open', () => {
    const ruOnly = resp(BillingSalesMode.RU_ONLY, ['ru'], 'ru');
    expect(screenMarket(ruOnly, 'global', 'en')).toBe('ru');
    expect(choosableMarkets(ruOnly)).toEqual([]);
    const globalOnly = resp(BillingSalesMode.GLOBAL_ONLY, ['global'], 'global');
    expect(screenMarket(globalOnly, 'ru', 'ru')).toBe('global');
  });

  it('contact mode: Global prices, no payment market', () => {
    const contact = resp(BillingSalesMode.CONTACT, [], 'global');
    expect(contactOnly(contact)).toBe(true);
    expect(screenMarket(contact, 'ru', 'ru')).toBe('global');
    expect(quoteMarket(contact, 'global')).toBeUndefined();
  });

  it('a fixed account keeps its market', () => {
    const fixed = resp(BillingSalesMode.UNSPECIFIED, ['ru'], '', 'ru');
    expect(screenMarket(fixed, 'global', 'en')).toBe('ru');
    expect(quoteMarket(fixed, 'ru')).toBeUndefined();
    expect(choosableMarkets(fixed)).toEqual([]);
  });

  it('filters offers by market, keeps an older server’s offers', () => {
    const offers = [
      create(BillingPlanOfferSchema, { plan: Plan.TEAM, market: 'global' }),
      create(BillingPlanOfferSchema, { plan: Plan.TEAM, market: 'ru' }),
    ];
    expect(offersOf(offers, 'ru').map((o) => o.market)).toEqual(['ru']);
    const old = [create(BillingPlanOfferSchema, { plan: Plan.TEAM })];
    expect(offersOf(old, 'ru')).toHaveLength(1);
  });

  it('names the methods', () => {
    expect(methodLabel({ provider: 'tochka', kind: PaymentMethodKind.CARD })).toBe('billing.method.cardMir');
    expect(methodLabel({ provider: 'tochka', kind: PaymentMethodKind.SBP })).toBe('billing.method.sbp');
    expect(methodLabel({ provider: 'stripe', kind: PaymentMethodKind.CARD })).toBe('billing.method.card');
  });
});
