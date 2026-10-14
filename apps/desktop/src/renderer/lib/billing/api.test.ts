import { create, fromJson, toJson, type DescMessage, type MessageInitShape } from '@bufbuild/protobuf';
import { AdminBillingAccountDetailsSchema, AdminBillingMutationResultSchema } from '@calaba/protocol';
import { describe, expect, it, vi } from 'vitest';

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

describe('restAdminApi issues («Требует внимания»)', () => {
  it('lists, imports and dismisses through …/issues', async () => {
    call.mockResolvedValue({});
    await restAdminApi.issues({ accountId: 'acc 1', open: true });
    expect(call).toHaveBeenLastCalledWith('GET', '/api/admin/billing/issues', expect.anything(), undefined, undefined); // qs is stubbed here
    await restAdminApi.importIssue('is/1', { reason: 'bank refund', requestId: 'req-1' });
    expect(call).toHaveBeenLastCalledWith('POST', '/api/admin/billing/issues/is%2F1/import', AdminBillingMutationResultSchema, { reason: 'bank refund', requestId: 'req-1' });
    await restAdminApi.dismissIssue('is-2', { reason: 'checked', requestId: 'req-2' });
    expect(call).toHaveBeenLastCalledWith('POST', '/api/admin/billing/issues/is-2/dismiss', AdminBillingMutationResultSchema, { reason: 'checked', requestId: 'req-2' });
  });
});
