import { create } from '@bufbuild/protobuf';
import { CheckoutState, CheckoutStatusSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { IDLE, POLL_GIVE_UP_MS, checkoutReducer, checkoutWaitingView, pollDelay, polling, type CheckoutEvent, type CheckoutFlow } from './checkout';

describe('checkout waiting wording (ADR-0084: the desktop window is not the browser)', () => {
  const base = { phase: 'waiting', paid: false, saved: false, hasUrl: true } as const;
  it('window open: «open in a separate window» + «show the window», no external icon', () => {
    expect(checkoutWaitingView({ ...base, place: 'window' })).toEqual({ text: 'billing.checkout.window', button: 'billing.checkout.showWindow', external: false, spinner: true });
  });
  it('back from the return page: checking; closed by the person: not finished + open again, no spinner', () => {
    expect(checkoutWaitingView({ ...base, place: 'returned' })).toMatchObject({ text: 'billing.checkout.checking', button: 'billing.checkout.reopen', spinner: true });
    expect(checkoutWaitingView({ ...base, place: 'closed' })).toEqual({ text: 'billing.checkout.notFinished', button: 'billing.checkout.reopen', external: false, spinner: false });
  });
  it('a browser tab keeps «waiting in the browser» with the external page button', () => {
    expect(checkoutWaitingView({ ...base, place: 'browser' })).toEqual({ text: 'billing.checkout.waiting', button: 'billing.checkout.open', external: true, spinner: true });
    expect(checkoutWaitingView({ ...base, saved: true, place: 'browser' })).toMatchObject({ text: 'billing.saved.waiting', button: 'billing.saved.open' });
  });
  it('paid, stalled and a one-click charge without a page', () => {
    expect(checkoutWaitingView({ ...base, paid: true, place: 'closed' })).toMatchObject({ text: 'billing.checkout.crediting', button: null });
    expect(checkoutWaitingView({ ...base, phase: 'stalled', place: 'window' })).toMatchObject({ text: 'billing.checkout.stalled', button: 'billing.checkout.showWindow', spinner: false });
    expect(checkoutWaitingView({ ...base, saved: true, hasUrl: false, place: 'closed' })).toMatchObject({ text: 'billing.saved.processing', button: null });
  });
});

const status = (state: CheckoutState, credited = false, checkoutId = 'co-1') => create(CheckoutStatusSchema, { checkoutId, state, credited });
const run = (events: CheckoutEvent[], from: CheckoutFlow = IDLE): CheckoutFlow => events.reduce(checkoutReducer, from);
const T0 = 1_000_000;

describe('checkout polling state machine', () => {
  it('create → waiting → credited', () => {
    let s = run([{ type: 'create' }]);
    expect(s.phase).toBe('creating');
    s = checkoutReducer(s, { type: 'created', checkoutId: 'co-1', url: 'https://checkout.stripe.com/c/1', now: T0 });
    expect(s).toMatchObject({ phase: 'waiting', checkoutId: 'co-1', polls: 0, paid: false });
    expect(polling(s)).toBe(true);
    s = checkoutReducer(s, { type: 'polled', status: status(CheckoutState.OPEN), now: T0 + 2000 });
    expect(s).toMatchObject({ phase: 'waiting', polls: 1, paid: false });
    // Paid at the provider, not on the balance yet: keep polling, show «зачисляем».
    s = checkoutReducer(s, { type: 'polled', status: status(CheckoutState.COMPLETED), now: T0 + 4000 });
    expect(s).toMatchObject({ phase: 'waiting', polls: 2, paid: true });
    s = checkoutReducer(s, { type: 'polled', status: status(CheckoutState.COMPLETED, true), now: T0 + 6000 });
    expect(s).toEqual({ phase: 'done', checkoutId: 'co-1', outcome: 'credited' });
    expect(polling(s)).toBe(false);
    expect(pollDelay(s)).toBeNull();
  });

  it('ends on expired / canceled / failed', () => {
    const waiting = run([{ type: 'create' }, { type: 'created', checkoutId: 'co-1', url: 'u', now: T0 }]);
    expect(checkoutReducer(waiting, { type: 'polled', status: status(CheckoutState.EXPIRED), now: T0 })).toMatchObject({ phase: 'done', outcome: 'expired' });
    expect(checkoutReducer(waiting, { type: 'polled', status: status(CheckoutState.CANCELED), now: T0 })).toMatchObject({ phase: 'done', outcome: 'canceled' });
    expect(checkoutReducer(waiting, { type: 'polled', status: status(CheckoutState.FAILED), now: T0 })).toMatchObject({ phase: 'done', outcome: 'failed' });
  });

  it('ignores answers about another checkout and events out of phase', () => {
    const waiting = run([{ type: 'create' }, { type: 'created', checkoutId: 'co-1', url: 'u', now: T0 }]);
    expect(checkoutReducer(waiting, { type: 'polled', status: status(CheckoutState.COMPLETED, true, 'co-2'), now: T0 })).toBe(waiting);
    expect(checkoutReducer(IDLE, { type: 'created', checkoutId: 'x', url: 'u', now: T0 })).toBe(IDLE);
    expect(checkoutReducer(waiting, { type: 'create' })).toBe(waiting); // a double click opens no second checkout
    expect(checkoutReducer(IDLE, { type: 'pollFailed', now: T0 })).toBe(IDLE);
  });

  it('a failed create shows the error; reset goes back', () => {
    const s = run([{ type: 'create' }, { type: 'createFailed', message: 'nope' }]);
    expect(s).toEqual({ phase: 'error', message: 'nope' });
    expect(checkoutReducer(s, { type: 'reset' })).toBe(IDLE);
  });

  it('slows down, then stalls after the give-up time; recheck resumes', () => {
    let s = run([{ type: 'create' }, { type: 'created', checkoutId: 'co-1', url: 'u', now: T0 }]);
    expect(pollDelay(s)).toBe(2000);
    for (let i = 0; i < 20; i++) s = checkoutReducer(s, { type: 'pollFailed', now: T0 + i });
    expect(pollDelay(s)).toBe(5000);
    for (let i = 0; i < 30; i++) s = checkoutReducer(s, { type: 'polled', status: status(CheckoutState.OPEN), now: T0 + i });
    expect(pollDelay(s)).toBe(15_000);
    s = checkoutReducer(s, { type: 'polled', status: status(CheckoutState.OPEN), now: T0 + POLL_GIVE_UP_MS });
    expect(s).toEqual({ phase: 'stalled', checkoutId: 'co-1', url: 'u', paid: false });
    expect(pollDelay(s)).toBeNull();
    s = checkoutReducer(s, { type: 'recheck', now: T0 + POLL_GIVE_UP_MS + 1 });
    expect(s).toMatchObject({ phase: 'waiting', polls: 0, startedAt: T0 + POLL_GIVE_UP_MS + 1 });
  });
});
