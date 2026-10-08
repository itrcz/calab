import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Plan toasts (ADR-0024): the text from the error, «Связаться» only with a usable contact. */

const openExternal = vi.fn((_url: string) => Promise.resolve());
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { openExternal: (u: string) => openExternal(u), log: () => undefined } } }));
vi.mock('../lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { ApiError } = await import('../lib/api/client');
const { reportPlanError, planOffersAllowed, planContact, openPlanContact } = await import('./plan');
const { platform } = await import('../platform');
const { useSession } = await import('../stores/session');
const { useToasts } = await import('../stores/toasts');

const roomFull = new ApiError('ERROR_CODE_ROOM_FULL', 'full', 409, undefined, { reason: 'PLAN_LIMIT', used: 5, limit: 5 });

beforeEach(() => {
  useToasts.setState({ items: [] });
  openExternal.mockClear();
  delete platform.sessionActivity;
});

describe('reportPlanError', () => {
  it('409 PLAN_LIMIT → info toast with «Связаться» that opens the contact', () => {
    useSession.getState().set({ planContact: 'mailto:it@gptunnel.ai' });
    expect(reportPlanError(roomFull, null)).toBe(true);
    const [toast] = useToasts.getState().items;
    expect(toast).toMatchObject({ kind: 'info', text: 'В бесплатном тарифе до 5 человек в комнате' });
    expect(toast?.action?.label).toBe('Связаться');
    toast?.action?.run();
    expect(openExternal).toHaveBeenCalledWith('mailto:it@gptunnel.ai');
  });

  it('no usable contact → the toast without a button', () => {
    useSession.getState().set({ planContact: 'javascript:alert(1)' });
    expect(reportPlanError(roomFull, null)).toBe(true);
    expect(useToasts.getState().items[0]?.action).toBeUndefined();
  });

  it('other errors are left to the caller', () => {
    expect(reportPlanError(new ApiError('ERROR_CODE_ROOM_FULL', 'full', 409), null)).toBe(false);
    expect(reportPlanError(new Error('boom'), null)).toBe(false);
    expect(useToasts.getState().items).toHaveLength(0);
  });

  it('keeps limits but removes sales actions in the native companion client', () => {
    platform.sessionActivity = { publish: vi.fn(), clear: vi.fn() };
    useSession.getState().set({ planContact: 'mailto:it@gptunnel.ai' });
    expect(planOffersAllowed()).toBe(false);
    expect(planContact()).toBeNull();
    expect(reportPlanError(roomFull, null)).toBe(true);
    expect(useToasts.getState().items[0]).toMatchObject({ kind: 'info', text: 'В бесплатном тарифе до 5 человек в комнате' });
    expect(useToasts.getState().items[0]?.action).toBeUndefined();
    openPlanContact();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('keeps website sales offers available', () => {
    useSession.getState().set({ planContact: 'https://calab.ru/' });
    expect(planOffersAllowed()).toBe(true);
    expect(planContact()).toBe('https://calab.ru/');
  });
});
