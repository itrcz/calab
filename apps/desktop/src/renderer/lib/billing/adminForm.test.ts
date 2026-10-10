import { PaymentOrigin } from '@calaba/protocol';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';

vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn() } }));

const { ApiError } = await import('../api/client');
const { adminFormError, reasonError, reasonHint, reasonProblem, refundManualOnly } = await import('./adminForm');

beforeAll(() => setLocale('ru'));

const validation = (field: string, message: string) => new ApiError('ERROR_CODE_VALIDATION', message, 422, field);

describe('admin billing reason (server: 5..1000)', () => {
  it('checks the trimmed length like the server', () => {
    expect(reasonProblem('abc')).toBe('short');
    expect(reasonProblem('   abcd   ')).toBe('short');
    expect(reasonProblem('abcde')).toBeNull();
    expect(reasonProblem('x'.repeat(1001))).toBe('long');
  });

  it('counter hint, and an inline error only after a submit', () => {
    expect(reasonHint(' test ')).toContain('4 / 1000');
    expect(reasonHint('')).toContain('5');
    expect(reasonError('abc', false)).toBeNull();
    expect(reasonError('abc', true)).toBe('Причина — не короче 5 символов');
    expect(reasonError('возврат по просьбе', true)).toBeNull();
  });
});

describe('admin billing refusals', () => {
  it('a 422 with a field goes to that field, localized', () => {
    // The prod refund of 2026-10-10: 97 bytes, «reason must be 5..1000 characters».
    expect(adminFormError(validation('reason', 'reason must be 5..1000 characters'))).toEqual({ field: 'reason', text: 'Причина — не короче 5 символов' });
    expect(adminFormError(validation('discountBps', 'discount_bps must be 0..10000'))).toEqual({ field: 'discountBps', text: 'Скидка — от 0 до 100 %' });
    expect(adminFormError(validation('somethingNew', 'x')).text).toContain('somethingNew');
  });

  it('a billing reason keeps its sentence; recent auth asks for the password', () => {
    const e = new ApiError('ERROR_CODE_CONFLICT', 'x', 409, undefined, { reason: 'BILLING_REFUND_EXCEEDS_REFUNDABLE' });
    expect(adminFormError(e)).toEqual({ field: null, text: 'Сумма больше, чем можно вернуть по этому платежу.' });
    const reauth = new ApiError('ERROR_CODE_RECENT_AUTH_REQUIRED', 'x', 403);
    expect(adminFormError(reauth).field).toBeNull();
    expect(adminFormError(reauth).text).not.toBe('');
  });

  it('never a bare generic line for an ApiError', () => {
    const odd = new ApiError('ERROR_CODE_SOMETHING', 'x', 400);
    expect(adminFormError(odd).text).toBe('Сервер отказал (код 400)');
  });
});

describe('refunds Tochka cannot do through the API', () => {
  const p = (provider: string, providerPaymentId: string, origin: PaymentOrigin) => ({ provider, providerPaymentId, payment: { origin } as never });
  it('subscription charges and one-click top-ups of Tochka: by hand (needs review)', () => {
    expect(refundManualOnly(p('tochka', 'sub-1:ord-2', PaymentOrigin.AUTO_TOPUP))).toBe(true);
    expect(refundManualOnly(p('tochka', 'sub-1:ord-3', PaymentOrigin.SAVED_METHOD))).toBe(true);
    expect(refundManualOnly(p('tochka', 'sub-1:ord-4', PaymentOrigin.IMPORT))).toBe(true);
  });
  it('payment links and Stripe: a normal refund', () => {
    expect(refundManualOnly(p('tochka', 'op-1', PaymentOrigin.CHECKOUT))).toBe(false);
    expect(refundManualOnly(p('stripe', 'pi_1', PaymentOrigin.SAVED_METHOD))).toBe(false);
  });
});
