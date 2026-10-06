import { describe, expect, it } from 'vitest';
import {
  MAX_DEPTH,
  backStep,
  depthOfState,
  emptyPhoneNav,
  historyPlan,
  historyTarget,
  openChat,
  popScreen,
  pushScreen,
  removeKind,
  switchTab,
  topScreen,
  visibleRoom,
  type PhoneNav,
} from './phoneNav';

const nav = (over: Partial<PhoneNav> = {}): PhoneNav => ({ ...emptyPhoneNav(), on: true, ...over });
const room = (r: string, ws = 'w1') => ({ kind: 'room' as const, ws, room: r });

describe('phone navigation stack (ADR-0073 §1)', () => {
  it('opens a room from the list over the tab root', () => {
    const n = openChat(nav(), room('a'));
    expect(n.tab).toBe('chats');
    expect(n.stack).toEqual([room('a')]);
    expect(visibleRoom(n)).toBe('a');
  });

  it('a deep link into another tab builds «tab root → screen»', () => {
    const n = openChat(nav({ tab: 'calendar', stack: [{ kind: 'event', key: 'e@1' }] }), { kind: 'dm', room: 'd1' });
    expect(n.tab).toBe('dms');
    expect(n.stack).toEqual([{ kind: 'dm', room: 'd1' }]);
  });

  it('a link in a room pushes the next room; back returns to the first', () => {
    const n = openChat(openChat(nav(), room('a')), room('b'));
    expect(n.stack.map((s) => (s.kind === 'room' ? s.room : s.kind))).toEqual(['a', 'b']);
    expect(visibleRoom(popScreen(n))).toBe('a');
  });

  it('returning to a room already in the stack drops the screens above it', () => {
    const n = openChat(openChat(openChat(nav(), room('a')), room('b')), room('a'));
    expect(n.stack).toEqual([room('a')]);
  });

  it('opening a chat closes the non-chat screens (members, search…)', () => {
    const start = nav({ stack: [room('a'), { kind: 'members', ws: 'w1', room: 'a' }, { kind: 'search' }] });
    expect(openChat(start, room('b')).stack).toEqual([room('a'), room('b')]);
  });

  it('pushes members over the room and pops back to it', () => {
    const n = pushScreen(openChat(nav(), room('a')), { kind: 'members', ws: 'w1', room: 'a' });
    expect(topScreen(n)?.kind).toBe('members');
    expect(visibleRoom(n)).toBeNull();
    expect(topScreen(popScreen(n))).toEqual(room('a'));
  });

  it('pushing the top screen again is a no-op (same object)', () => {
    const n = pushScreen(nav(), { kind: 'search' });
    expect(pushScreen(n, { kind: 'search' })).toBe(n);
  });

  it('caps the depth', () => {
    let n = nav();
    for (let i = 0; i < MAX_DEPTH + 3; i++) n = pushScreen(n, room(`r${i}`));
    expect(n.stack).toHaveLength(MAX_DEPTH);
    expect(visibleRoom(n)).toBe(`r${MAX_DEPTH + 2}`);
  });

  it('removes a kind when its feature flag goes off elsewhere', () => {
    const n = nav({ stack: [room('a'), { kind: 'task', id: 't' }] });
    expect(removeKind(n, 'task').stack).toEqual([room('a')]);
    expect(removeKind(n, 'search')).toBe(n);
  });

  it('a tab switch shows its root; tapping the open tab returns to its root', () => {
    const deep = openChat(nav(), room('a'));
    expect(switchTab(deep, 'me')).toMatchObject({ tab: 'me', stack: [] });
    expect(switchTab(deep, 'chats')).toMatchObject({ tab: 'chats', stack: [] });
    const root = nav({ tab: 'me' });
    expect(switchTab(root, 'me')).toBe(root);
  });

  it('popping the root does nothing', () => {
    const n = nav();
    expect(popScreen(n)).toBe(n);
  });
});

describe('back and the browser history (ADR-0073 §2)', () => {
  it('back closes a sheet before a screen', () => {
    expect(backStep({ overlay: true, depth: 2 })).toBe('overlay');
    expect(backStep({ overlay: false, depth: 2 })).toBe('screen');
    expect(backStep({ overlay: false, depth: 0 })).toBe('none');
    expect(backStep({ overlay: true, depth: 0 })).toBe('overlay');
  });

  it('needs one entry per screen and one for an open sheet', () => {
    expect(historyTarget(0, false)).toBe(0);
    expect(historyTarget(2, false)).toBe(2);
    expect(historyTarget(0, true)).toBe(1);
    expect(historyTarget(2, true)).toBe(3);
  });

  it('plans pushes and back jumps', () => {
    expect(historyPlan(2, 0)).toEqual({ push: 2 });
    expect(historyPlan(1, 3)).toEqual({ go: -2 });
    expect(historyPlan(1, 1)).toBeNull();
  });

  it('reads our level from an entry, the base entry included', () => {
    expect(depthOfState({ calabaNav: 3 })).toBe(3);
    expect(depthOfState(null)).toBe(0);
    expect(depthOfState({ other: 1 })).toBe(0);
    expect(depthOfState({ calabaNav: -1 })).toBe(0);
  });
});
