import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttendeeStatus } from '@calaba/protocol';
import { IDS, startMockServer, type MockServer } from './mock-server';

// Free / busy, find a time, work hours, CalDAV in the mock (ADR-0041):
//   pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts mock-freebusy

let server: MockServer;

beforeAll(async () => {
  server = await startMockServer({ scenario: 'data' });
});
afterAll(async () => {
  await server.close();
});

async function login(email = 'owner@calaba.test'): Promise<string> {
  const res = await fetch(`${server.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', deviceName: 'vitest' }),
  });
  return ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
}

const api = (token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

interface FbUser {
  userId: string;
  timezone: string;
  workHours: { startMin: number; endMin: number; days: number[] };
  busy: { startsAt: string; endsAt: string; eventId?: string; kind: string }[];
}

const H = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const W = IDS.workspaces.main;
// Thursday 15 January 2026, 00:00 MSK.
const DAY0 = Date.parse('2026-01-14T21:00:00Z');

describe('free / busy (ADR-0041)', () => {
  it('lists busy time: meetings (event_id only when the asker sees it), declined ones left out, external busy', async () => {
    server.reset();
    server.setClock(DAY0 + 9 * H);
    const anna = await login();
    // Борис's meeting with Григорий, no room: Анна does not see it → no event_id.
    const hidden = server.addEvent({ workspaceId: W, organizerId: IDS.users.boris, title: 'Секрет', startMs: DAY0 + 12 * H, endMs: DAY0 + 13 * H, attendees: [{ userId: IDS.users.grigory }] });
    // Анна invited Борис, who declined: not his busy time.
    const declined = server.addEvent({ workspaceId: W, title: 'Обед', startMs: DAY0 + 14 * H, endMs: DAY0 + 15 * H, attendees: [{ userId: IDS.users.boris, status: AttendeeStatus.DECLINED }] });
    server.setBusy(IDS.users.boris, [{ startMs: DAY0 + 16 * H, endMs: DAY0 + 17 * H }]);
    const r = await api(anna, `/api/workspaces/${W}/freebusy?users=${IDS.users.boris},${IDS.users.anna}&from=${iso(DAY0)}&to=${iso(DAY0 + 24 * H)}`);
    expect(r.status).toBe(200);
    const users = ((await r.json()) as { users: FbUser[] }).users;
    const boris = users.find((u) => u.userId === IDS.users.boris);
    expect(boris?.timezone).toBe('Asia/Yekaterinburg');
    expect(boris?.workHours).toEqual({ startMin: 600, endMin: 1140, days: [1, 2, 3, 4, 5] });
    expect(boris?.busy).toEqual([
      { startsAt: iso(DAY0 + 12 * H), endsAt: iso(DAY0 + 13 * H), kind: 'BUSY_KIND_MEETING', allDay: false },
      { startsAt: iso(DAY0 + 16 * H), endsAt: iso(DAY0 + 17 * H), kind: 'BUSY_KIND_EXTERNAL', allDay: false },
    ]);
    const mine = users.find((u) => u.userId === IDS.users.anna);
    expect(mine?.busy.map((b) => b.eventId)).toEqual([declined.id]);
    expect(hidden.id).toBeTruthy();

    // Limits: > 14 days, a stranger.
    expect((await api(anna, `/api/workspaces/${W}/freebusy?users=${IDS.users.boris}&from=${iso(DAY0)}&to=${iso(DAY0 + 15 * 24 * H)}`)).status).toBe(422);
    expect((await api(anna, `/api/workspaces/${W}/freebusy?users=nobody&from=${iso(DAY0)}&to=${iso(DAY0 + H)}`)).status).toBe(422);
  });

  it('suggests the nearest common windows and answers 409 NO_COMMON_HOURS', async () => {
    server.reset();
    server.setClock(DAY0 + 9 * H);
    const anna = await login();
    // Анна busy 10:00–11:00 MSK, Вера 11:00–12:30 MSK: from 10:00 MSK the first 60-min window is 12:30.
    server.addEvent({ workspaceId: W, title: 'A', startMs: DAY0 + 10 * H, endMs: DAY0 + 11 * H, attendees: [] });
    server.addEvent({ workspaceId: W, organizerId: IDS.users.vera, title: 'B', startMs: DAY0 + 11 * H, endMs: DAY0 + 12.5 * H, attendees: [] });
    const body = { users: [IDS.users.anna, IDS.users.vera], durationMin: 60, from: iso(DAY0 + 10 * H), to: iso(DAY0 + 3 * 24 * H), withinWorkHours: true };
    const r = await api(anna, `/api/workspaces/${W}/freebusy/suggest`, { method: 'POST', body });
    expect(r.status).toBe(200);
    const slots = ((await r.json()) as { slots: { startsAt: string; endsAt: string }[] }).slots;
    expect(slots[0]).toEqual({ startsAt: iso(DAY0 + 12.5 * H), endsAt: iso(DAY0 + 13.5 * H) });
    // Friday's window starts at 10:00 MSK (work hours), the weekend has none.
    expect(slots[1]).toEqual({ startsAt: iso(DAY0 + 34 * H), endsAt: iso(DAY0 + 35 * H) });
    expect(slots).toHaveLength(2);

    server.setWorkHours(IDS.users.vera, { startMin: 20 * 60, endMin: 22 * 60, days: [1, 2, 3, 4, 5] });
    const none = await api(anna, `/api/workspaces/${W}/freebusy/suggest`, { method: 'POST', body });
    expect(none.status).toBe(409);
    expect(((await none.json()) as { code?: string }).code).toBe('ERROR_CODE_NO_COMMON_HOURS');
    const any = await api(anna, `/api/workspaces/${W}/freebusy/suggest`, { method: 'POST', body: { ...body, withinWorkHours: false } });
    expect(any.status).toBe(200);
  });

  it('keeps work hours with PATCH /api/me and returns them in Me.settings', async () => {
    server.reset();
    const anna = await login();
    const p = await api(anna, '/api/me', { method: 'PATCH', body: { workHours: { startMin: 540, endMin: 1080, days: [1, 2, 3, 4] } } });
    expect(p.status).toBe(200);
    const me = (await (await api(anna, '/api/me')).json()) as { me: { settings: { workHours: unknown } } };
    expect(me.me.settings.workHours).toEqual({ startMin: 540, endMin: 1080, days: [1, 2, 3, 4] });
    expect((await api(anna, '/api/me', { method: 'PATCH', body: { workHours: { startMin: 600, endMin: 600, days: [1] } } })).status).toBe(422);
  });

  it('connects a CalDAV account, picks a calendar, imports busy time, disconnects', async () => {
    server.reset();
    server.setClock(DAY0 + 9 * H);
    const anna = await login();
    expect(await (await api(anna, '/api/me/caldav')).json()).toEqual({});
    expect((await api(anna, '/api/me/caldav', { method: 'POST', body: { url: 'https://fail.example', username: 'a', password: 'b' } })).status).toBe(422);
    const c = await api(anna, '/api/me/caldav', { method: 'POST', body: { url: 'https://caldav.example.com', username: 'anna', password: 'app-pass' } });
    const acc = ((await c.json()) as { account: { calendars: { href: string }[]; password?: string } }).account;
    expect(acc.calendars).toHaveLength(2);
    expect(acc.password).toBeUndefined();
    const href = acc.calendars[0]?.href ?? '';
    const u = await api(anna, '/api/me/caldav', { method: 'PUT', body: { calendarHref: href, import: true, push: true } });
    expect(((await u.json()) as { account: { lastSyncAt?: string } }).account.lastSyncAt).toBeTruthy();
    const fb = await api(anna, `/api/workspaces/${W}/freebusy?users=${IDS.users.anna}&from=${iso(DAY0)}&to=${iso(DAY0 + 24 * H)}`);
    const busy = ((await fb.json()) as { users: FbUser[] }).users[0]?.busy ?? [];
    expect(busy).toEqual([{ startsAt: iso(DAY0 + 11 * H), endsAt: iso(DAY0 + 12 * H), kind: 'BUSY_KIND_EXTERNAL', allDay: false }]);
    expect((await api(anna, '/api/me/caldav', { method: 'DELETE' })).status).toBe(204);
    expect(await (await api(anna, '/api/me/caldav')).json()).toEqual({});
  });
});

describe('external event details (ADR-0045)', () => {
  it('the owner sees every detail; a colleague by the share level; members matched by address', async () => {
    server.reset();
    server.setClock(DAY0 + 9 * H);
    const anna = await login();
    const boris = await login('boris@calaba.test');
    server.setCalDav(IDS.users.anna);
    server.setBusy(IDS.users.anna, [
      {
        startMs: DAY0 + 11 * H,
        endMs: DAY0 + 12 * H,
        uid: 'u1',
        summary: 'Подрядчик',
        location: 'Zoom',
        url: 'https://zoom.us/j/1',
        organizer: 'pm@partner.org',
        attendees: [{ email: 'Boris@calaba.test', name: 'Борис' }, { email: 'pm@partner.org' }],
      },
    ]);
    const mine: unknown = await (await api(anna, `/api/me/external-events?from=${iso(DAY0)}&to=${iso(DAY0 + 24 * H)}&workspace=${W}`)).json();
    expect(mine).toEqual({
      events: [
        {
          uid: 'u1',
          startsAt: iso(DAY0 + 11 * H),
          endsAt: iso(DAY0 + 12 * H),
          summary: 'Подрядчик',
          location: 'Zoom',
          attendees: [{ email: 'boris@calaba.test', name: 'Борис', userId: IDS.users.boris }, { email: 'pm@partner.org', name: '' }],
          organizer: 'pm@partner.org',
          url: 'https://zoom.us/j/1',
          href: '',
          recurring: false,
          webUrl: '',
        },
      ],
    });
    const seen = async (): Promise<Record<string, unknown> | undefined> => {
      const r = await api(boris, `/api/workspaces/${W}/freebusy?users=${IDS.users.anna}&from=${iso(DAY0)}&to=${iso(DAY0 + 24 * H)}`);
      const users = ((await r.json()) as { users: Array<{ busy: Array<Record<string, unknown>> }> }).users;
      return users[0]?.busy.find((b) => b['kind'] === 'BUSY_KIND_EXTERNAL');
    };
    expect(await seen()).toEqual({ startsAt: iso(DAY0 + 11 * H), endsAt: iso(DAY0 + 12 * H), kind: 'BUSY_KIND_EXTERNAL', allDay: false });
    expect((await api(anna, '/api/me/caldav', { method: 'PATCH', body: { shareLevel: 'CAL_DAV_SHARE_LEVEL_TITLE' } })).status).toBe(200);
    expect(await seen()).toMatchObject({ title: 'Подрядчик' });
    expect((await api(anna, '/api/me/caldav', { method: 'PATCH', body: { shareLevel: 'CAL_DAV_SHARE_LEVEL_DETAILS' } })).status).toBe(200);
    expect(await seen()).toMatchObject({ title: 'Подрядчик', attendeeUserIds: [IDS.users.boris] });
    expect((await api(anna, '/api/me/caldav', { method: 'PATCH', body: {} })).status).toBe(422);
  });
});
