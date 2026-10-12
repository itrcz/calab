import { describe, expect, expectTypeOf, it } from 'vitest';
import { DEFAULT_MAIL_SETTINGS, createMailClient, mailMethods, type MailApi, type MailMethod, type MailMethodsComplete } from '../../shared/mail';
import { createHandlers, dispatch } from './handlers';

describe('mail contract', () => {
  it('mailMethods covers every MailApi request method (type level)', () => {
    expectTypeOf<MailMethodsComplete>().toEqualTypeOf<true>();
    expectTypeOf<(typeof mailMethods)[number]>().toEqualTypeOf<MailMethod>();
  });

  it('mailMethods matches the client built from it (runtime)', () => {
    const api = createMailClient({ request: () => Promise.resolve({ ok: true, result: null }), onEvent: () => () => undefined });
    const paths: string[] = [];
    const walk = (o: object, prefix: string): void => {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'function') paths.push(prefix + k);
        else walk(v as object, `${prefix}${k}.`);
      }
    };
    walk(api, '');
    expect(paths.filter((p) => p !== 'attachmentUrl' && p !== 'onEvent').sort()).toEqual([...mailMethods].sort());
    expectTypeOf(api).toEqualTypeOf<MailApi>();
  });

  it('client rejects with MailApiError carrying the code', async () => {
    const api = createMailClient({
      request: (c) => Promise.resolve(c.method === 'accounts.list' ? { ok: true, result: [] } : { ok: false, error: { code: 'AUTH_FAILED', message: 'no' } }),
      onEvent: () => () => undefined,
    });
    await expect(api.accounts.list()).resolves.toEqual([]);
    await expect(api.accounts.setPassword('a', 'b')).rejects.toMatchObject({ name: 'MailApiError', code: 'AUTH_FAILED', message: 'no' });
  });
});

describe('engine handlers (T0 skeleton)', () => {
  const h = createHandlers();
  it('answers the implemented methods', async () => {
    await expect(dispatch(h, { id: 1, method: 'accounts.list', params: [] })).resolves.toEqual({ id: 1, ok: true, result: [] });
    await expect(dispatch(h, { id: 2, method: 'settings.get', params: [] })).resolves.toEqual({ id: 2, ok: true, result: DEFAULT_MAIL_SETTINGS });
    await expect(dispatch(h, { id: 3, method: 'sync.now', params: [] })).resolves.toMatchObject({ id: 3, ok: true });
  });
  it('NOT_IMPLEMENTED for the rest, INVALID for unknown methods', async () => {
    for (const m of mailMethods.filter((x) => !['accounts.list', 'settings.get', 'sync.now'].includes(x))) {
      await expect(dispatch(h, { id: 9, method: m, params: [] })).resolves.toMatchObject({ ok: false, error: { code: 'NOT_IMPLEMENTED' } });
    }
    await expect(dispatch(h, { id: 10, method: 'nope' as MailMethod, params: [] })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID' } });
  });
});
