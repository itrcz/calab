import { describe, expect, it } from 'vitest';
import {
  daysOf,
  deletePrompt,
  deleteRole,
  restoreExternal,
  withoutExternal,
  eventsByDay,
  externalKey,
  externalSignature,
  isExternalKey,
  mergeDays,
  parseExternalKey,
  parseExternalSignature,
  sharedLabel,
  splitAttendees,
} from './external';
import type { ExternalAttendee, ExternalEvent } from './freebusyApi';
import { dayStart } from './time';

const at = (d: number, h: number, m = 0): number => new Date(2026, 0, d, h, m).getTime();

function ev(uid: string, start: number, end: number, extra: Partial<ExternalEvent> = {}): ExternalEvent {
  return { uid, start, end, allDay: false, summary: uid, location: '', attendees: [], organizer: '', url: '', href: '', recurring: false, webUrl: '', ...extra };
}

const att = (email: string, userId = '', name = ''): ExternalAttendee => ({ email, userId, name });

describe('attendees of an external event → the meeting dialog (ADR-0045 §3)', () => {
  const members = new Set(['u-boris', 'u-vera']);
  const opts = { me: 'u-anna', myEmail: 'Anna@Example.com', canInvite: (id: string) => members.has(id) };

  it('members here are invited, the rest listed by address; me in neither', () => {
    const r = splitAttendees([att('anna@example.com', 'u-anna'), att('boris@x.ru', 'u-boris'), att('out@partner.org'), att('vera@x.ru', 'u-vera')], opts);
    expect(r).toEqual({ members: ['u-boris', 'u-vera'], outside: ['out@partner.org'] });
  });

  it('my address without an id is me too; a matched id that cannot be invited (a guest, a bot) goes to the outside line', () => {
    const r = splitAttendees([att('ANNA@example.com'), att('guest@x.ru', 'u-guest')], opts);
    expect(r).toEqual({ members: [], outside: ['guest@x.ru'] });
  });

  it('no repeats', () => {
    const r = splitAttendees([att('b@x', 'u-boris'), att('b2@x', 'u-boris'), att('o@x'), att('o@x')], opts);
    expect(r).toEqual({ members: ['u-boris'], outside: ['o@x'] });
  });
});

describe('a colleague’s external interval label (ADR-0045 §4)', () => {
  it('busy / title / title with attendees', () => {
    expect(sharedLabel({ title: '', attendees: [] })).toBeNull();
    expect(sharedLabel({ title: '  ', attendees: ['a'] })).toBeNull();
    expect(sharedLabel({ title: ' Board ', attendees: [] })).toEqual({ title: 'Board', count: 0 });
    expect(sharedLabel({ title: 'Board', attendees: ['a', 'b'] })).toEqual({ title: 'Board', count: 2 });
  });
});

describe('external events by day', () => {
  it('keys round-trip and are told from meeting keys', () => {
    const e = ev('abc123', at(15, 11), at(15, 12));
    const k = externalKey(e);
    expect(isExternalKey(k)).toBe(true);
    expect(isExternalKey('evt~1')).toBe(false);
    expect(parseExternalKey(k)).toEqual({ uid: 'abc123', start: e.start, end: e.end });
  });

  it('an event is on every local day it touches; an end at midnight is not the next day', () => {
    expect(daysOf(ev('a', at(15, 23), at(16, 1)))).toEqual(['2026-01-15', '2026-01-16']);
    expect(daysOf(ev('a', at(15, 0), at(16, 0)))).toEqual(['2026-01-15']);
  });

  it('a window gives every day a list, earliest first', () => {
    const days = eventsByDay([ev('b', at(15, 14), at(15, 15)), ev('a', at(15, 9), at(15, 10))], dayStart('2026-01-15'), dayStart('2026-01-17'));
    expect(Object.keys(days)).toEqual(['2026-01-15', '2026-01-16']);
    expect(days['2026-01-15']?.map((e) => e.uid)).toEqual(['a', 'b']);
    expect(days['2026-01-16']).toEqual([]);
  });

  it('a day wholly inside the window is replaced; a day on its edge keeps the other window’s events', () => {
    const edge = at(15, 12);
    const held = { '2026-01-15': [ev('morning', at(15, 9), at(15, 10))], '2026-01-14': [ev('old', at(14, 9), at(14, 10))] };
    const incoming = eventsByDay([ev('evening', at(15, 18), at(15, 19))], edge, dayStart('2026-01-17'));
    const out = mergeDays(held, incoming, edge, dayStart('2026-01-17'));
    expect(out['2026-01-15']?.map((e) => e.uid)).toEqual(['morning', 'evening']);
    expect(out['2026-01-14']?.map((e) => e.uid)).toEqual(['old']);
    const again = mergeDays(out, eventsByDay([], dayStart('2026-01-15'), dayStart('2026-01-16')), dayStart('2026-01-15'), dayStart('2026-01-16'));
    expect(again['2026-01-15']).toEqual([]);
  });

  it('a day’s signature round-trips (the grid re-renders only when it changes)', () => {
    const list = [ev('a', at(15, 9), at(15, 10)), ev('b', at(15, 0), at(16, 0), { allDay: true })];
    const sig = externalSignature(list);
    expect(externalSignature(undefined)).toBe('');
    expect(parseExternalSignature(sig)).toEqual([
      { key: externalKey(list[0] as ExternalEvent), start: at(15, 9), end: at(15, 10), allDay: false },
      { key: externalKey(list[1] as ExternalEvent), start: at(15, 0), end: at(16, 0), allDay: true },
    ]);
    // A new title (not a time) keeps the signature: only the card re-renders.
    expect(externalSignature([{ ...(list[0] as ExternalEvent), summary: 'x' }, list[1] as ExternalEvent])).toBe(sig);
  });
});

describe('«Удалить из календаря» (ADR-0045 amendment 1)', () => {
  const me = ['Anna@Example.com', 'anna@yandex.ru'];

  it('the organizer with others warns about the cancellation; an attendee or a private event — only my calendar', () => {
    const others = [att('anna@example.com'), att('boris@x.ru')];
    expect(deleteRole({ organizer: 'anna@yandex.ru', attendees: others }, me)).toBe('organizer');
    expect(deleteRole({ organizer: 'boris@x.ru', attendees: others }, me)).toBe('attendee');
    expect(deleteRole({ organizer: 'anna@example.com', attendees: [att('anna@example.com')] }, me)).toBe('attendee');
    expect(deleteRole({ organizer: '', attendees: [] }, me)).toBe('attendee');
    expect(deleteRole({ organizer: 'anna@example.com', attendees: others }, ['', ''])).toBe('attendee');
  });

  it('the confirmation names what goes and whom it reaches', () => {
    const mine = ev('s', at(15, 9), at(15, 10), { summary: 'Планёрка', organizer: 'anna@example.com', attendees: [att('boris@x.ru')] });
    expect(deletePrompt(mine, 'this', me)).toEqual({
      title: 'Удалить «Планёрка» из календаря?',
      text: 'Вы организатор — участникам уйдёт отмена от вашего календаря.',
      action: 'Удалить',
    });
    const invited = { ...mine, organizer: 'boris@x.ru', recurring: true };
    expect(deletePrompt(invited, 'series', me)).toMatchObject({ title: 'Удалить все повторения «Планёрка»?', text: 'Событие исчезнет только из вашего календаря.' });
    expect(deletePrompt(invited, 'this', me).title).toMatch(/^Удалить событие .*15 января.* из календаря\?$/);
    expect(deletePrompt({ ...mine, summary: '' }, 'this', me).title).toBe('Удалить «Без названия» из календаря?');
  });

  it('gone at once: this occurrence or every one of the uid; back on a refusal, without doubles', () => {
    const a1 = ev('a', at(15, 9), at(15, 10), { recurring: true });
    const a2 = ev('a', at(16, 9), at(16, 10), { recurring: true });
    const b = ev('b', at(15, 11), at(15, 12));
    const days = { '2026-01-15': [a1, b], '2026-01-16': [a2] };
    const one = withoutExternal(days, a1, false);
    expect(one.days['2026-01-15']).toEqual([b]);
    expect(one.days['2026-01-16']).toBe(days['2026-01-16']);
    expect(one.removed).toEqual({ '2026-01-15': [a1] });
    const all = withoutExternal(days, a1, true);
    expect(all.days).toEqual({ '2026-01-15': [b], '2026-01-16': [] });
    expect(restoreExternal(all.days, all.removed)).toEqual(days);
    // Loaded again meanwhile: not doubled.
    expect(restoreExternal({ '2026-01-15': [a1, b], '2026-01-16': [] }, all.removed)).toEqual(days);
  });
});
