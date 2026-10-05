import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalEvent } from '../lib/calendar/freebusyApi';

/** «Удалить из календаря» (ADR-0045 amendment 1): optimistic, rolled back on a refusal, a toast by the reason. */

vi.mock('../platform', () => ({ platform: { kind: 'web', app: { openExternal: () => Promise.resolve(), log: () => undefined } } }));
vi.mock('../lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const deleteExternal = vi.fn((_e: unknown, _scope: string) => Promise.resolve());
vi.mock('../lib/calendar/freebusyApi', async (orig) => {
  const real = await orig<typeof import('../lib/calendar/freebusyApi')>();
  return { ...real, freebusyApi: { ...real.freebusyApi, deleteExternal: (e: unknown, s: string) => deleteExternal(e, s) } };
});

const { ApiError } = await import('../lib/api/client');
const { deleteExternalEvent } = await import('./freebusy');
const { useFreeBusy } = await import('../stores/freebusy');
const { useToasts } = await import('../stores/toasts');

const ev = (start: number, extra: Partial<ExternalEvent> = {}): ExternalEvent => ({
  uid: 'u1', start, end: start + 3_600_000, allDay: false, summary: 'Планёрка', location: '', attendees: [], organizer: '',
  url: '', href: 'https://dav.example/cal/u1.ics', recurring: true, webUrl: '', myStatus: 0, ...extra,
});
const d15 = ev(Date.parse('2026-01-15T09:00:00Z'));
const d16 = ev(Date.parse('2026-01-16T09:00:00Z'));
const held = { '2026-01-15': [d15], '2026-01-16': [d16] };

beforeEach(() => {
  deleteExternal.mockReset();
  deleteExternal.mockImplementation(() => Promise.resolve());
  useToasts.setState({ items: [] });
  useFreeBusy.setState({ external: held, externalWs: 'ws', externalChunks: { 1: true } });
});

describe('deleteExternalEvent', () => {
  it('this occurrence of a series: gone at once, the request names it', async () => {
    const done = deleteExternalEvent(d15, 'this');
    expect(useFreeBusy.getState().external['2026-01-15']).toEqual([]);
    expect(useFreeBusy.getState().external['2026-01-16']).toEqual([d16]);
    expect(await done).toBe(true);
    expect(deleteExternal).toHaveBeenCalledWith(d15, 'this');
  });

  it('the series, or an event without repeats, takes every occurrence', async () => {
    expect(await deleteExternalEvent(d16, 'series')).toBe(true);
    expect(useFreeBusy.getState().external).toEqual({ '2026-01-15': [], '2026-01-16': [] });
    useFreeBusy.setState({ external: held });
    await deleteExternalEvent({ ...d15, recurring: false }, 'this');
    expect(deleteExternal).toHaveBeenLastCalledWith({ ...d15, recurring: false }, 'series');
  });

  it('409: back, «изменилось» toast, my events asked again', async () => {
    deleteExternal.mockImplementation(() => Promise.reject(new ApiError('ERROR_CODE_CONFLICT', 'changed', 409, undefined, { reason: 'EVENT_CHANGED' })));
    expect(await deleteExternalEvent(d15, 'this')).toBe(false);
    expect(useFreeBusy.getState().external).toEqual(held);
    expect(useFreeBusy.getState().externalChunks).toEqual({});
    expect(useToasts.getState().items[0]).toMatchObject({ kind: 'error', text: 'Событие изменилось в календаре — обновили, попробуйте ещё раз.' });
  });

  it('422 read-only: back, «только для чтения» toast', async () => {
    deleteExternal.mockImplementation(() => Promise.reject(new ApiError('ERROR_CODE_VALIDATION', 'ro', 422, 'href', { reason: 'CALENDAR_READ_ONLY' })));
    expect(await deleteExternalEvent(d15, 'series')).toBe(false);
    expect(useFreeBusy.getState().external).toEqual(held);
    expect(useFreeBusy.getState().externalChunks).toEqual({ 1: true });
    expect(useToasts.getState().items[0]).toMatchObject({ kind: 'error', text: 'Календарь только для чтения — удалить событие нельзя.' });
  });
});
