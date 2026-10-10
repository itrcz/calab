import { create } from '@bufbuild/protobuf';
import { BillingSummarySchema, PaymentMethodKind, SavedMethodTopupSchema, SavedMethodTopupState, SavedPaymentMethodSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { IDLE, checkoutReducer } from './checkout';
import { asCheckoutStatus, brandName, cardLabel, optionForSaved, savedChoices, savedFailureKey } from './savedTopup';

const card = (o: Partial<{ id: string; provider: string; brand: string; last4: string; oneClick: boolean }>) =>
  create(SavedPaymentMethodSchema, { id: 'pm-1', kind: PaymentMethodKind.CARD, provider: 'stripe', brand: 'visa', last4: '4242', oneClick: true, ...o });

describe('one-click top-up with a saved card', () => {
  it('offers only the cards the server allows, charged under their provider row', () => {
    const s = create(BillingSummarySchema, {
      methods: [
        { id: 'tochka:card', provider: 'tochka', kind: PaymentMethodKind.CARD },
        { id: 'tochka:sbp', provider: 'tochka', kind: PaymentMethodKind.SBP },
      ],
      savedMethods: [card({ id: 'a', provider: 'tochka', brand: 'mir', last4: '0792' }), card({ id: 'b', oneClick: false })],
    });
    const got = savedChoices(s);
    expect(got.map((m) => m.id)).toEqual(['a']);
    const first = got[0];
    expect(first && optionForSaved(s, first)?.id).toBe('tochka:card');
    expect(optionForSaved(s, card({ provider: 'stripe' }))).toBeUndefined();
  });

  it('labels cards by network and last four digits', () => {
    expect(cardLabel(card({ brand: 'mir', last4: '0792' }))).toBe('МИР •••• 0792');
    expect(cardLabel(card({ brand: 'Visa' }))).toBe('Visa •••• 4242');
    expect(cardLabel(card({ brand: '', last4: '1111' }))).toBe('•••• 1111');
    expect(cardLabel(card({ brand: '', last4: '' }))).toBe('••••');
    expect(brandName('elo')).toBe('Elo');
  });

  it('maps the answer onto the checkout flow: paid, 3-D Secure page, declined', () => {
    const answer = (state: SavedMethodTopupState, extra: object = {}) => create(SavedMethodTopupSchema, { id: 'sm-1', state, ...extra });
    const run = (a: ReturnType<typeof answer>) => {
      let f = checkoutReducer(IDLE, { type: 'create' });
      f = checkoutReducer(f, { type: 'created', checkoutId: a.id, url: a.actionUrl, now: 1 });
      return checkoutReducer(f, { type: 'polled', status: asCheckoutStatus(a), now: 2 });
    };
    expect(run(answer(SavedMethodTopupState.SUCCEEDED, { credited: true }))).toMatchObject({ phase: 'done', outcome: 'credited' });
    expect(run(answer(SavedMethodTopupState.FAILED, { failureCode: 'card_declined' }))).toMatchObject({ phase: 'done', outcome: 'failed' });
    expect(run(answer(SavedMethodTopupState.REQUIRES_ACTION, { actionUrl: 'https://hooks.stripe.com/3d' }))).toMatchObject({
      phase: 'waiting',
      url: 'https://hooks.stripe.com/3d',
      paid: false,
    });
    // Succeeded but not credited yet (the credit is in the same transaction; defensive): «зачисляем».
    expect(run(answer(SavedMethodTopupState.SUCCEEDED))).toMatchObject({ phase: 'waiting', paid: true });
    expect(run(answer(SavedMethodTopupState.PROCESSING))).toMatchObject({ phase: 'waiting', url: '' });
  });

  it('explains failures', () => {
    expect(savedFailureKey('authentication_required')).toBe('billing.saved.failedAuth');
    expect(savedFailureKey('insufficient_funds')).toBe('billing.saved.failedFunds');
    expect(savedFailureKey('declined')).toBe('billing.saved.failed');
  });
});
