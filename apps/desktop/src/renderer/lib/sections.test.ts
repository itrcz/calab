import { NotificationLevel, RoomType } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import type { Room } from '@calaba/protocol';
import { contextWorkspace, currentSection, dmBadge, otherWorkspacesBadge, rememberSection, sectionFor, UNREAD_DOT, workspaceBadge } from './sections';

const room = (id: string, workspaceId: string, type = RoomType.TEXT): Room => ({ id, workspaceId, type }) as Room;

function state(rooms: Room[], extra: { unread?: Record<string, number>; mentions?: Record<string, number> } = {}) {
  return {
    byId: Object.fromEntries(rooms.map((r) => [r.id, r])),
    readState: {},
    lastMessage: {},
    unread: extra.unread ?? {},
    mentions: extra.mentions ?? {},
    notify: {},
    wsNotify: {},
  };
}

describe('currentSection', () => {
  it('HOME is «Личные» whatever else is on', () => {
    expect(currentSection({ home: true, boards: true, calendar: true })).toBe('dms');
  });
  it('boards win over the day view, then the calendar, else the rooms', () => {
    expect(currentSection({ home: false, boards: true, calendar: true })).toBe('boards');
    expect(currentSection({ home: false, boards: false, calendar: true })).toBe('calendar');
    expect(currentSection({ home: false, boards: false, calendar: false })).toBe('chats');
  });
  it('an open web app selects no section', () => {
    expect(currentSection({ home: false, boards: false, calendar: false, app: true })).toBeNull();
  });
});

describe('section memory', () => {
  it('keeps the same object when nothing changes', () => {
    const m = { a: 'boards' as const };
    expect(rememberSection(m, 'a', 'boards')).toBe(m);
    expect(rememberSection(m, 'a', 'calendar')).toEqual({ a: 'calendar' });
    expect(rememberSection(m, 'b', 'chats')).toEqual({ a: 'boards', b: 'chats' });
  });
  it('opens on the remembered section, «Чаты» by default and for guests', () => {
    const m = { a: 'calendar' as const };
    expect(sectionFor(m, 'a', false)).toBe('calendar');
    expect(sectionFor(m, 'b', false)).toBe('chats');
    expect(sectionFor(m, 'a', true)).toBe('chats');
  });
});

describe('contextWorkspace', () => {
  const known = (id: string): boolean => ['a', 'b'].includes(id);
  it('is the open workspace', () => {
    expect(contextWorkspace('b', 'a', '@me', ['a', 'b'], known)).toBe('b');
  });
  it('from «Личные»: the last one used, else the first', () => {
    expect(contextWorkspace('@me', 'b', '@me', ['a', 'b'], known)).toBe('b');
    expect(contextWorkspace('@me', 'gone', '@me', ['a', 'b'], known)).toBe('a');
    expect(contextWorkspace(null, null, '@me', [], known)).toBeNull();
  });
});

describe('badges', () => {
  const rooms = [room('r1', 'a'), room('r2', 'a'), room('r3', 'b'), room('d1', '', RoomType.DM)];

  it('a workspace: mentions win, else the unread dot, else nothing', () => {
    expect(workspaceBadge(state(rooms, { unread: { r1: 3 }, mentions: { r2: 2 } }), 'a')).toBe(2);
    expect(workspaceBadge(state(rooms, { unread: { r1: 3 } }), 'a')).toBe(UNREAD_DOT);
    expect(workspaceBadge(state(rooms, { unread: { r3: 1 } }), 'a')).toBe(0);
  });
  it('DM messages count for «Личные», never for a workspace', () => {
    const s = state(rooms, { unread: { d1: 4 }, mentions: { d1: 4 } });
    expect(dmBadge(s)).toBe(4);
    expect(workspaceBadge(s, 'a')).toBe(0);
    expect(otherWorkspacesBadge(s, 'a')).toBe(0);
  });
  it('other workspaces leave the context one out', () => {
    const s = state(rooms, { unread: { r1: 1, r3: 1 }, mentions: { r1: 5 } });
    expect(otherWorkspacesBadge(s, 'a')).toBe(UNREAD_DOT);
    expect(otherWorkspacesBadge(s, 'b')).toBe(5);
    expect(otherWorkspacesBadge(s, null)).toBe(5);
  });
  it('a quiet workspace (level «Ничего») keeps only its mentions', () => {
    const s = { ...state(rooms, { unread: { r1: 2 } }), wsNotify: { a: { workspaceId: 'a', level: NotificationLevel.NONE } } };
    expect(workspaceBadge(s as never, 'a')).toBe(0);
  });
});
