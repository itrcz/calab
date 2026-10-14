import { AttendeeStatus } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalEvent } from '../lib/calendar/freebusyApi';

/** «Приму / Отклоню / Может быть» of my external event (ADR-0045 amendment 2): optimistic on every occurrence, rolled back on a refusal. */

vi.mock('../platform', () => ({ platform: { kind: 'web', app: { openExternal: () => Promise.resolve(), log: () => undefined } } }));
vi.mock('../lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const respondExternal = vi.fn((_e: unknown, _s: AttendeeStatus) => Promise.resolve());
vi.mock('../lib/calendar/freebusyApi', async (orig) => {
  const real = await orig<typeof import('../lib/calendar/freebusyApi')>();
  return { ...real, freebusyApi: { ...real.freebusyApi, respondExternal: (e: unknown, s: AttendeeStatus) => respondExternal(e, s) } };
});

const { ApiError } = await import('../lib/api/client');
const { respondExternalEvent } = await import('./freebusy');
const { useFreeBusy } = await import('../stores/freebusy');
const { useToasts } = await import('../stores/toasts');

const ev = (start: number): ExternalEvent => ({
  uid: 'u1', start, end: start + 3_600_000, allDay: false, summary: 'Планёрка', location: '', attendees: [], organizer: 'boss@x.org',
  url: '', href: 'https://dav.example/cal/u1.ics', recurring: true, webUrl: '', myStatus: AttendeeStatus.PENDING,
});
const d15 = ev(Date.parse('2026-01-15T09:00:00Z'));
const d16 = ev(Date.parse('2026-01-16T09:00:00Z'));
const held = { '2026-01-15': [d15], '2026-01-16': [d16] };
const statuses = (): Array<AttendeeStatus | undefined> => Object.values(useFreeBusy.getState().external).map((l) => l[0]?.myStatus);

beforeEach(() => {
  respondExternal.mockReset();
  respondExternal.mockImplementation(() => Promise.resolve());
  useToasts.setState({ items: [] });
  useFreeBusy.setState({ external: held, externalWs: 'ws', externalChunks: { 1: true } });
});

describe('respondExternalEvent', () => {
  it('the answer shows on every occurrence at once; my events are asked again after it', async () => {
    const done = respondExternalEvent(d15, AttendeeStatus.ACCEPTED);
    expect(statuses()).toEqual([AttendeeStatus.ACCEPTED, AttendeeStatus.ACCEPTED]);
    expect(await done).toBe(true);
    expect(respondExternal).toHaveBeenCalledWith(d15, AttendeeStatus.ACCEPTED);
    expect(useFreeBusy.getState().externalChunks).toEqual({});
  });

  it('422 read-only: back, «только для чтения» toast', async () => {
    respondExternal.mockImplementation(() => Promise.reject(new ApiError('ERROR_CODE_VALIDATION', 'ro', 422, 'href', { reason: 'CALENDAR_READ_ONLY' })));
    expect(await respondExternalEvent(d15, AttendeeStatus.DECLINED)).toBe(false);
    expect(statuses()).toEqual([AttendeeStatus.PENDING, AttendeeStatus.PENDING]);
    expect(useFreeBusy.getState().externalChunks).toEqual({ 1: true });
    expect(useToasts.getState().items[0]).toMatchObject({ kind: 'error', text: 'Календарь только для чтения — ответить нельзя.' });
  });

  it('409: back, «изменилось» toast, my events asked again', async () => {
    respondExternal.mockImplementation(() => Promise.reject(new ApiError('ERROR_CODE_CONFLICT', 'changed', 409, undefined, { reason: 'EVENT_CHANGED' })));
    expect(await respondExternalEvent(d16, AttendeeStatus.MAYBE)).toBe(false);
    expect(statuses()).toEqual([AttendeeStatus.PENDING, AttendeeStatus.PENDING]);
    expect(useFreeBusy.getState().externalChunks).toEqual({});
    expect(useToasts.getState().items[0]).toMatchObject({ kind: 'error', text: 'Событие изменилось в календаре — обновили, ответьте ещё раз.' });
  });
});
