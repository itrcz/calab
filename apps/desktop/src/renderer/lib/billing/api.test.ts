import { create, fromJson, toJson, type DescMessage, type MessageInitShape } from '@bufbuild/protobuf';
import { AdminBillingAccountDetailsSchema, AdminBillingMutationResultSchema } from '@calaba/protocol';
import { describe, expect, it, vi } from 'vitest';
import { rejectRefundRequest } from './model';

const call = vi.fn();
// The real client pulls the platform layer (window); the adapter only needs call / body here.
vi.mock('../api/client', () => ({
  call: (...a: unknown[]): unknown => call(...a) as unknown,
  callEmpty: vi.fn(),
  qs: () => '',
  body: <T extends DescMessage>(schema: T, init: MessageInitShape<T>): unknown => toJson(schema, create(schema, init)),
}));

const { restAdminApi } = await import('./api');

describe('restAdminApi.account', () => {
  it('decodes GET …/accounts/{id} as AdminBillingAccountDetails (revision from .account)', async () => {
    // What the server writes (admin/read.go getAccount): the account nested in the details.
    const wire = {
      account: { accountId: 'acc-1', workspaceName: 'Calab', revision: '7', balance: { minor: '1500', currency: 'USD' } },
      freeAdvance: { minor: '1200', currency: 'USD' },
      pendingRefunds: { minor: '300', currency: 'USD' },
      openDisputes: [{ dispute: { id: 'd1', paymentId: 'p1', status: 'DISPUTE_STATUS_OPEN' }, accountId: 'acc-1' }],
    };
    call.mockImplementationOnce((_m: string, _p: string, schema: DescMessage) => Promise.resolve(fromJson(schema, wire)));
    const d = await restAdminApi.account('acc-1');
    expect(call).toHaveBeenLastCalledWith('GET', '/api/admin/billing/accounts/acc-1', AdminBillingAccountDetailsSchema, undefined, undefined);
    expect(d.account?.revision).toBe(7n);
    expect(d.account?.workspaceName).toBe('Calab');
    expect(d.freeAdvance?.minor).toBe(1200n);
    expect(d.pendingRefunds?.minor).toBe(300n);
    expect(d.openDisputes[0]?.dispute?.id).toBe('d1');
  });

  it('decodes enable as the mutation result the server answers', async () => {
    call.mockResolvedValueOnce({});
    await restAdminApi.enable('ws-1', { market: 'global', reason: 'r', requestId: 'q' });
    expect(call).toHaveBeenLastCalledWith('POST', '/api/admin/billing/workspaces/ws-1/enable', AdminBillingMutationResultSchema, expect.anything());
  });
});

describe('restAdminApi.decideRefundRequest', () => {
  it('rejects through POST …/refund-requests/{id}/decide with the reason and request id', async () => {
    call.mockResolvedValueOnce({});
    await restAdminApi.decideRefundRequest('rr/1', rejectRefundRequest({ reason: 'not eligible', requestId: 'req-1' }));
    expect(call).toHaveBeenCalledWith('POST', '/api/admin/billing/refund-requests/rr%2F1/decide', AdminBillingMutationResultSchema, {
      reason: 'not eligible',
      requestId: 'req-1',
    });
  });
});
