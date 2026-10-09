import { create, toJson, type DescMessage, type MessageInitShape } from '@bufbuild/protobuf';
import { AdminBillingMutationResultSchema } from '@calaba/protocol';
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
