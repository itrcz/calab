import { describe, expect, it } from 'vitest';
import { emptyHistory, HISTORY_LIMIT, locOf, pushLoc, recordNav, step, type Loc, type NavSnapshot } from './navHistory';

const L = (room: string, ws = 'w'): Loc => ({ kind: 'room', ws, room });
const all = (): boolean => true;
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected a value');
  return v;
}

describe('navigation history', () => {
  it('push → back → forward', () => {
    let h = emptyHistory();
    h = pushLoc(h, L('a'), L('b'));
    h = pushLoc(h, L('b'), L('c'));
    expect(h.back).toEqual([L('a'), L('b')]);
    const b1 = step(h, L('c'), -1, all);
    expect(b1?.to).toEqual(L('b'));
    const b2 = step(must(b1).history, L('b'), -1, all);
    expect(b2?.to).toEqual(L('a'));
    expect(step(must(b2).history, L('a'), -1, all)).toBeNull();
    const f1 = step(must(b2).history, L('a'), 1, all);
    expect(f1?.to).toEqual(L('b'));
    expect(f1?.history.back).toEqual([L('a')]);
    expect(f1?.history.forward).toEqual([L('c')]);
  });

  it('navigating clears forward and ignores no-op moves', () => {
    let h = pushLoc(emptyHistory(), L('a'), L('b'));
    h = must(step(h, L('b'), -1, all)).history;
    expect(h.forward).toEqual([L('b')]);
    h = pushLoc(h, L('a'), L('a'));
    expect(h.forward).toEqual([L('b')]);
    h = pushLoc(h, L('a'), L('z'));
    expect(h.forward).toEqual([]);
    expect(pushLoc(h, null, L('q'))).toBe(h);
  });

  it('skips invalid entries (deleted rooms)', () => {
    let h = pushLoc(emptyHistory(), L('a'), L('gone'));
    h = pushLoc(h, L('gone'), L('c'));
    const r = step(h, L('c'), -1, (l) => l.kind !== 'room' || l.room !== 'gone');
    expect(r?.to).toEqual(L('a'));
  });

  it('works across workspaces', () => {
    const h = pushLoc(emptyHistory(), L('a', 'w1'), L('b', 'w2'));
    expect(step(h, L('b', 'w2'), -1, all)?.to).toEqual(L('a', 'w1'));
  });

  it('a task, a room from its comments, back to the task, forward to the room (board #113)', () => {
    const task: Loc = { kind: 'task', ws: 'w', board: 'b', task: 't1', from: '' };
    const room = L('r');
    const h = recordNav(emptyHistory(), task, room);
    const back = must(step(h, room, -1, all));
    expect(back.to).toEqual(task);
    const fwd = must(step(back.history, task, 1, all));
    expect(fwd.to).toEqual(room);
    expect(fwd.history.back).toEqual([task]);
  });

  it('replace (J/K) moves within the entry: nothing pushed, forward kept', () => {
    const t1: Loc = { kind: 'task', ws: 'w', board: 'b', task: 't1', from: '' };
    const t2: Loc = { ...t1, task: 't2' };
    let h = recordNav(emptyHistory(), L('a'), t1);
    h = { ...h, forward: [L('z')] };
    expect(recordNav(h, t1, t2, true)).toBe(h);
    // A task link in a comment is a navigation: it pushes.
    expect(recordNav(h, t1, t2).back.at(-1)).toEqual(t1);
  });

  it('the same place is not a navigation; the board or search a task is opened over does not matter', () => {
    const t1: Loc = { kind: 'task', ws: 'w', board: 'b', task: 't1', from: '' };
    const h = recordNav(emptyHistory(), L('a'), t1);
    expect(recordNav(h, t1, { ...t1, board: 'mine', from: 'q' })).toBe(h);
    const mail: Loc = { kind: 'mail', box: { scope: 'all', folder: 'inbox' }, boxKey: 'all\ninbox', thread: 'th', message: 'm1', row: 'r' };
    expect(recordNav(h, mail, { ...mail, message: 'm2' })).toBe(h);
    expect(recordNav(h, mail, { ...mail, thread: null, message: null }).back.at(-1)).toEqual(mail);
  });

  it('caps the stacks', () => {
    let h = emptyHistory();
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) h = recordNav(h, L(`r${i}`), L(`r${i + 1}`));
    expect(h.back).toHaveLength(HISTORY_LIMIT);
    expect(h.back[0]).toEqual(L('r10'));
  });

  it('skips entries no longer reachable in both directions', () => {
    const app: Loc = { kind: 'app', ws: 'w', app: 'gone' };
    let h = recordNav(emptyHistory(), L('a'), app);
    h = recordNav(h, app, L('c'));
    const r = must(step(h, L('c'), -1, (l) => l.kind !== 'app'));
    expect(r.to).toEqual(L('a'));
    expect(r.history.back).toEqual([]);
    expect(r.history.forward).toEqual([L('c')]);
  });
});

const SNAP: NavSnapshot = { ws: 'w', home: false, guest: false, room: 'r', fileTab: null, mail: null, app: null, disk: null, wiki: null, canvas: null, tel: null, boards: null, cal: null };

describe('locOf: the place on screen', () => {
  it('a room by default; a workspace without rooms has none', () => {
    expect(locOf(SNAP)).toEqual(L('r'));
    expect(locOf({ ...SNAP, room: null })).toEqual({ kind: 'room', ws: 'w', room: null });
    expect(locOf({ ...SNAP, ws: null })).toBeNull();
  });

  it('follows the shell: file over mail over «Личные» over a web app over the sections over the day', () => {
    const boards = { board: 'b', task: 't', from: '' };
    const cal = { day: '2026-10-30', event: null };
    expect(locOf({ ...SNAP, boards, cal })).toEqual({ kind: 'task', ws: 'w', board: 'b', task: 't', from: '' });
    expect(locOf({ ...SNAP, boards: { ...boards, task: null } })).toEqual({ kind: 'board', ws: 'w', board: 'b' });
    expect(locOf({ ...SNAP, cal })).toEqual({ kind: 'cal', ws: 'w', ...cal });
    expect(locOf({ ...SNAP, boards, disk: { folder: 'f', trash: false } })).toEqual({ kind: 'disk', ws: 'w', folder: 'f', trash: false });
    expect(locOf({ ...SNAP, boards, app: 'x' })).toEqual({ kind: 'app', ws: 'w', app: 'x' });
    expect(locOf({ ...SNAP, home: true, ws: '@me', app: 'x', room: 'dm' })).toEqual({ kind: 'room', ws: '@me', room: 'dm' });
    const mail = { box: { scope: 'all', folder: 'inbox' as const }, boxKey: 'k', thread: null, message: null, row: null };
    expect(locOf({ ...SNAP, home: true, mail })?.kind).toBe('mail');
    expect(locOf({ ...SNAP, mail, fileTab: 'f1' })).toEqual({ kind: 'file', ws: 'w', tab: 'f1' });
    // CBF-195: a file opened from a DM or a guest room is a place of its own, so «back» returns to the chat.
    expect(locOf({ ...SNAP, home: true, ws: '@me', room: 'dm', fileTab: 'f1' })).toEqual({ kind: 'file', ws: '@me', tab: 'f1' });
    expect(locOf({ ...SNAP, guest: true, fileTab: 'f1' })).toEqual({ kind: 'file', ws: 'w', tab: 'f1' });
  });

  it('a guest has no sections: the room', () => {
    expect(locOf({ ...SNAP, guest: true, boards: { board: 'b', task: null, from: '' }, wiki: { page: 'p' } })).toEqual(L('r'));
  });
});
