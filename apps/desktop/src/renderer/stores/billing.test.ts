import { create } from '@bufbuild/protobuf';
import { BillingState, GetBillingResponseSchema } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_ENTRY, applyFailed, applyLoaded, applyUpdate, beginLoad, useBilling } from './billing';

const resp = (revision: bigint, state = BillingState.ACTIVE) => create(GetBillingResponseSchema, { status: { state }, summary: { accountId: 'a', revision } });
const memberResp = () => create(GetBillingResponseSchema, { status: { state: BillingState.SUSPENDED } });

describe('billing store reducers', () => {
  it('first load shows loading, a reload keeps what is shown', () => {
    expect(beginLoad(undefined)).toBe(EMPTY_ENTRY);
    const ready = applyLoaded(undefined, resp(3n));
    expect(ready).toMatchObject({ load: 'ready', revision: 3n, stale: false });
    expect(beginLoad(ready)).toBe(ready);
  });

  it('drops an answer older than the revision shown', () => {
    const shown = applyLoaded(undefined, resp(5n));
    const older = applyLoaded({ ...shown, stale: true }, resp(4n));
    expect(older.revision).toBe(5n);
    expect(older.stale).toBe(false);
    expect(older.data).toBe(shown.data);
    expect(applyLoaded(shown, resp(6n)).revision).toBe(6n);
  });

  it('a member answer (no summary) replaces with revision 0', () => {
    const e = applyLoaded(undefined, memberResp());
    expect(e).toMatchObject({ load: 'ready', revision: 0n });
    expect(e.data?.summary).toBeUndefined();
  });

  it('BILLING_UPDATE marks stale only when newer', () => {
    const shown = applyLoaded(undefined, resp(5n));
    expect(applyUpdate(shown, 5n)).toBe(shown);
    expect(applyUpdate(shown, 4n)).toBe(shown);
    expect(applyUpdate(shown, 6n)?.stale).toBe(true);
    // revision 0 (unknown) always reloads.
    expect(applyUpdate(shown, 0n)?.stale).toBe(true);
    expect(applyUpdate(undefined, 6n)).toBeUndefined();
  });

  it('failures: 501 / 404 replace, an error keeps a shown summary', () => {
    expect(applyFailed(undefined, 'unavailable', null)).toMatchObject({ load: 'unavailable', data: null });
    expect(applyFailed(undefined, 'none', null)).toMatchObject({ load: 'none', data: null });
    const shown = applyLoaded(undefined, resp(2n));
    const err = applyFailed(shown, 'error', 'boom');
    expect(err).toMatchObject({ load: 'ready', data: shown.data, error: 'boom' });
    expect(applyFailed(undefined, 'error', 'boom')).toMatchObject({ load: 'error', data: null, error: 'boom' });
  });
});

describe('useBilling', () => {
  beforeEach(() => useBilling.getState().reset());

  it('keeps entries per workspace and reports a due reload', () => {
    const st = useBilling.getState();
    st.begin('w1');
    expect(useBilling.getState().byWs['w1']?.load).toBe('loading');
    st.loaded('w1', resp(2n));
    const before = useBilling.getState().byWs['w1'];
    expect(useBilling.getState().update('w1', 2n)).toBe(false);
    expect(useBilling.getState().byWs['w1']).toBe(before); // no new object: no re-render
    expect(useBilling.getState().update('w1', 3n)).toBe(true);
    expect(useBilling.getState().update('w2', 3n)).toBe(false); // nothing loaded for w2
    st.drop('w1');
    expect(useBilling.getState().byWs['w1']).toBeUndefined();
  });
});
