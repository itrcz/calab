import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api/client';
import { useBilling } from '../stores/billing';

const get = vi.fn();
vi.mock('../lib/billing/api', () => ({ restOwnerApi: { get: (...a: unknown[]): unknown => get(...a) as unknown }, restAdminApi: {} }));

vi.mock('../platform', () => ({ platform: { app: { openExternal: vi.fn() } } }));

const { loadBilling, onBillingUpdate, resyncBilling } = await import('./billing');

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
