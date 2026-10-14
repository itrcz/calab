import { create } from '@bufbuild/protobuf';
import { AdminBillingMutationResultSchema, RefundStatus } from '@calaba/protocol';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';

vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn() } }));

const { ApiError } = await import('../api/client');
const { adminFormError, reasonError, reasonHint, reasonProblem, refundOutcome } = await import('./adminForm');

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

describe('synchronous admin refund outcome', () => {
  const res = (status?: RefundStatus, manual = false) =>
    create(AdminBillingMutationResultSchema, {
      refunds: status === undefined ? [] : [{ refund: { status } }],
      ...(manual ? { manualRefund: { provider: 'tochka', operation: '…299c', charge: '7824819' } } : {}),
    });
  it('manual / done / refused / waiting', () => {
    expect(refundOutcome(res(undefined, true))).toBe('manual');
    expect(refundOutcome(res(RefundStatus.SUCCEEDED))).toBe('done');
    expect(refundOutcome(res(RefundStatus.FAILED))).toBe('refused');
    expect(refundOutcome(res(RefundStatus.PENDING))).toBe('waiting');
  });
});
