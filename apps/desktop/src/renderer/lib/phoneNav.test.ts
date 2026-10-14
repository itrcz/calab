import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PINNED,
  MAX_DEPTH,
  PHONE_TABS,
  barTabs,
  normalizePinned,
  pinTab,
  backStep,
  depthOfState,
  emptyPhoneNav,
  historyPlan,
  historyTarget,
  openChat,
  openSettingsSection,
  popScreen,
  pushOnTab,
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
    expect(switchTab(deep, 'boards')).toMatchObject({ tab: 'boards', stack: [] });
    expect(switchTab(deep, 'chats')).toMatchObject({ tab: 'chats', stack: [] });
    const root = nav({ tab: 'boards' });
    expect(switchTab(root, 'boards')).toBe(root);
  });

  it('a board or a task lives on «Доски»; the profile is a tab', () => {
    // From another tab: «tab root → screen» (a board link, a notification).
    const link = pushOnTab(openChat(nav(), room('a')), 'boards', { kind: 'board', ws: 'w' });
    expect(link).toMatchObject({ tab: 'boards', stack: [{ kind: 'board', ws: 'w' }] });
    // On the tab: the task goes over the board, back returns to the board, then the list.
    const task = pushOnTab(link, 'boards', { kind: 'task', id: 't' });
    expect(task.stack.map((x) => x.kind)).toEqual(['board', 'task']);
    expect(popScreen(popScreen(task))).toMatchObject({ tab: 'boards', stack: [] });
    // The profile is a tab of its own (owner, 07.10): settings pushed from it pop back to its root.
    const profile = switchTab(nav({ tab: 'dms' }), 'profile');
    expect(profile).toMatchObject({ tab: 'profile', stack: [] });
    const settings = pushOnTab(profile, 'profile', { kind: 'settings', section: 'voice' });
    expect(popScreen(settings)).toMatchObject({ tab: 'profile', stack: [] });
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

  it('needs one entry per screen and one per open layer (a menu and its sub-levels)', () => {
    expect(historyTarget(0, 0)).toBe(0);
    expect(historyTarget(2, 0)).toBe(2);
    expect(historyTarget(0, 1)).toBe(1);
    expect(historyTarget(2, 1)).toBe(3);
    // «+» → «Создать задачу ▸»: two cards, two backs before the screen.
    expect(historyTarget(1, 2)).toBe(3);
    expect(historyTarget(1, -1)).toBe(1);
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

describe('settings screens (ADR-0073, owner 07.10)', () => {
  const list = { kind: 'settings' as const, section: null };

  it('a section is pushed over the list: back pops one screen at a time', () => {
    const n = openSettingsSection(nav({ stack: [list] }), 'voice');
    expect(n.stack).toEqual([list, { kind: 'settings', section: 'voice' }]);
    expect(popScreen(n).stack).toEqual([list]);
    expect(historyTarget(n.stack.length, 0)).toBe(2);
  });

  it('the same section again does not grow the stack; another section is its own screen', () => {
    const a = openSettingsSection(nav({ stack: [list] }), 'voice');
    expect(openSettingsSection(a, 'voice')).toBe(a);
    expect(openSettingsSection(a, 'about').stack).toHaveLength(3);
  });

  it('the settings screens go together when the window closes', () => {
    const n = openSettingsSection(nav({ stack: [list] }), 'voice');
    expect(removeKind(n, 'settings').stack).toEqual([]);
  });

  it('a section opened straight from the profile has no list under it', () => {
    const n = pushScreen(nav({ stack: [] }), { kind: 'settings', section: 'general' });
    expect(popScreen(n).stack).toEqual([]);
  });
});

describe('pinned tabs (ADR-0095)', () => {
  it('pinning a fourth tab drops the oldest and reports it', () => {
    expect(pinTab(['chats', 'dms', 'boards'], 'disk')).toEqual({ pinned: ['dms', 'boards', 'disk'], unpinned: 'chats' });
  });
  it('an already pinned tab changes nothing (always exactly three)', () => {
    expect(pinTab(['chats', 'dms', 'boards'], 'dms')).toEqual({ pinned: ['chats', 'dms', 'boards'] });
  });
  it('a short list is topped up without dropping anything', () => {
    expect(pinTab(['chats', 'dms'], 'disk')).toEqual({ pinned: ['chats', 'dms', 'disk'] });
  });
  it('normalizes a stored value', () => {
    expect(normalizePinned(undefined)).toEqual(['chats', 'dms', 'boards']);
    expect(normalizePinned(['chats', 'chats', 'x', 'disk'])).toEqual(['chats', 'dms', 'boards']);
    expect(normalizePinned(['disk', 'profile', 'calendar'])).toEqual(['disk', 'profile', 'calendar']);
  });
  it('the bar shows the pinned tabs the account may open, topped up; «Ещё» only if something is hidden', () => {
    const all = ['chats', 'dms', 'boards', 'calendar', 'disk', 'profile'] as const;
    expect(barTabs(['chats', 'dms', 'boards'], all)).toEqual({ bar: ['chats', 'dms', 'boards'], more: true });
    expect(barTabs(['chats', 'dms', 'boards'], ['chats', 'profile'])).toEqual({ bar: ['chats', 'profile'], more: false });
    expect(barTabs(['calendar', 'disk', 'profile'], ['chats', 'profile', 'disk'])).toEqual({ bar: ['disk', 'profile', 'chats'], more: false });
  });
});

describe('disk screens (ADR-0094 §8)', () => {
  it('folders stack over the Disk tab; the same folder is returned to, the trash is its own screen', () => {
    let n = pushOnTab(nav({ tab: 'chats' }), 'disk', { kind: 'disk', folderId: 'a' });
    expect(n.tab).toBe('disk');
    n = pushScreen(n, { kind: 'disk', folderId: 'b' });
    n = pushScreen(n, { kind: 'disk', folderId: '', trash: true });
    expect(n.stack).toHaveLength(3);
    n = pushScreen(n, { kind: 'disk', folderId: 'a' });
    expect(n.stack).toEqual([{ kind: 'disk', folderId: 'a' }]);
  });
});

describe('wiki screens (ADR-0096 §7)', () => {
  it('pages stack over the Wiki tab; the same page is returned to, the trash is its own screen', () => {
    let n = pushOnTab(nav({ tab: 'chats' }), 'wiki', { kind: 'wiki', pageId: 'a' });
    expect(n.tab).toBe('wiki');
    n = pushScreen(n, { kind: 'wiki', pageId: 'b' });
    n = pushScreen(n, { kind: 'wiki', pageId: '', trash: true });
    expect(n.stack).toHaveLength(3);
    n = pushScreen(n, { kind: 'wiki', pageId: 'a' });
    expect(n.stack).toEqual([{ kind: 'wiki', pageId: 'a' }]);
  });
  it('the Wiki tab is behind «Ещё» by default and can be pinned', () => {
    expect(PHONE_TABS).toContain('wiki');
    expect(barTabs(DEFAULT_PINNED, PHONE_TABS).bar).toEqual(['chats', 'dms', 'boards']);
    expect(pinTab(['chats', 'dms', 'boards'], 'wiki')).toEqual({ pinned: ['dms', 'boards', 'wiki'], unpinned: 'chats' });
  });
});
