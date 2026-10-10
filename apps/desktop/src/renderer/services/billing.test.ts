import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api/client';
import { useBilling } from '../stores/billing';

const get = vi.fn();
vi.mock('../lib/billing/api', () => ({ restOwnerApi: { get: (...a: unknown[]): unknown => get(...a) as unknown }, restAdminApi: {} }));

const openExternal = vi.fn((_url: string) => Promise.resolve());
const openCheckoutWindow = vi.fn((_url: string): Promise<string> => Promise.resolve('returned'));
vi.mock('../platform', () => ({
  platform: { app: { openExternal: (url: string) => openExternal(url), openCheckout: (url: string) => openCheckoutWindow(url) } },
}));

const { loadBilling, onBillingUpdate, onCheckoutReturn, openCheckout, openReceipt, resyncBilling } = await import('./billing');

const off = () => new ApiError('NOT_IMPLEMENTED', 'billing off', 501, undefined, { reason: 'BILLING_DISABLED' });
const noAccount = () => new ApiError('NOT_FOUND', 'no account', 404, undefined, { reason: 'BILLING_ACCOUNT_NOT_FOUND' });

describe('billing off / no account (501 / 404)', () => {
  beforeEach(() => {
    useBilling.getState().reset();
    get.mockReset();
  });

  it('501 -> unavailable, 404 BILLING_ACCOUNT_NOT_FOUND -> none, one GET each', async () => {
    get.mockRejectedValueOnce(off());
    await loadBilling('w1');
    expect(useBilling.getState().byWs['w1']?.load).toBe('unavailable');
    get.mockRejectedValueOnce(noAccount());
    await loadBilling('w2');
    expect(useBilling.getState().byWs['w2']?.load).toBe('none');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('events and reconnect do not re-ask after 501 / 404', async () => {
    get.mockRejectedValueOnce(off());
    await loadBilling('w1');
    get.mockRejectedValueOnce(noAccount());
    await loadBilling('w2');
    get.mockClear();
    onBillingUpdate('w1', 0n);
    resyncBilling(new Set(['w1', 'w2']));
    await Promise.resolve();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('openCheckout (ADR-0084: the checkout window and its outcome)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  beforeEach(() => {
    openExternal.mockClear();
    openCheckoutWindow.mockReset();
  });

  it('desktop: every outcome of the window makes the open dialog poll, once per return', async () => {
    const seen: string[] = [];
    const off = onCheckoutReturn((o) => seen.push(o));
    for (const o of ['returned', 'success', 'fail', 'closed']) {
      openCheckoutWindow.mockResolvedValueOnce(o);
      openCheckout(' https://checkout.stripe.com/c/pay/cs_1 ');
      await flush();
    }
    expect(openCheckoutWindow).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_1');
    expect(seen).toEqual(['returned', 'success', 'fail', 'closed']);
    expect(openExternal).not.toHaveBeenCalled();
    off();
    openCheckoutWindow.mockResolvedValueOnce('returned');
    openCheckout('https://checkout.stripe.com/c/pay/cs_1');
    await flush();
    expect(seen).toHaveLength(4);
  });

  it('web: a new tab (external) — nobody is told the payer is back', async () => {
    const cb = vi.fn();
    const off = onCheckoutReturn(cb);
    openCheckoutWindow.mockResolvedValueOnce('external');
    openCheckout('https://merch.securepaytb.ru/order/?uuid=1');
    await flush();
    expect(cb).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    off();
  });

  it('a URL main refuses for the window goes to the system browser', async () => {
    openCheckoutWindow.mockRejectedValueOnce(new Error('checkout: not a provider checkout url'));
    openCheckout('https://pay.sandbox.example/x');
    await flush();
    expect(openExternal).toHaveBeenCalledWith('https://pay.sandbox.example/x');
  });

  it('non-https is never opened; receipts go to the browser', async () => {
    openCheckout('javascript:alert(1)');
    openCheckout('http://checkout.stripe.com/x');
    await flush();
    expect(openCheckoutWindow).not.toHaveBeenCalled();
    openReceipt('https://pay.stripe.com/receipts/1');
    expect(openExternal).toHaveBeenCalledWith('https://pay.stripe.com/receipts/1');
    expect(openCheckoutWindow).not.toHaveBeenCalled();
  });
});
