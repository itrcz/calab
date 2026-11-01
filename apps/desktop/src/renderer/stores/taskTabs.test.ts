import { describe, expect, it } from 'vitest';
import { MAX_TABS, reduceActivate, reduceAdd, reduceClose, reduceSync, sanitizeTabs, type TabsState, type TaskTab } from './taskTabs';

const tab = (id: string, at = 1): TaskTab => ({ id, ws: 'w', board: 'b', key: `K-${id}`, title: `Task ${id}`, at });
const pin = (id: string, at = 1): TaskTab => ({ ...tab(id, at), pinned: true });
const pv = (id: string): TaskTab => ({ ...tab(id), pinned: false });
const ids = (s: TabsState): string[] => s.tabs.map((x) => x.id);
const empty: TabsState = { tabs: [], cur: null };

describe('reduceActivate', () => {
  it('creates no tab for a single task', () => {
    expect(reduceActivate(empty, tab('a'))).toBe(empty);
  });
  it('makes an existing tab current without moving it', () => {
    const s = reduceActivate({ tabs: [tab('a'), tab('b')], cur: 'a' }, tab('b', 9));
    expect(ids(s)).toEqual(['a', 'b']);
    expect(s.cur).toBe('b');
    expect(s.tabs[1]?.at).toBe(9);
  });
  it('a task without a tab gets none: the strip stays, nothing is current (#137)', () => {
    const s = reduceActivate({ tabs: [pin('a'), pin('b')], cur: 'a' }, tab('x'));
    expect(ids(s)).toEqual(['a', 'b']);
    expect(s.cur).toBeNull();
  });
  it('two tabs via add, then a plain open of a third: two tabs, cur null (#137)', () => {
    const s = reduceActivate(reduceAdd(reduceAdd(empty, tab('a')), tab('b')), tab('c'));
    expect(ids(s)).toEqual(['a', 'b']);
    expect(s.cur).toBeNull();
    expect(s.tabs.every((x) => x.pinned)).toBe(true);
  });
  it('a plain click on a pinned task just switches to it', () => {
    const s = reduceActivate({ tabs: [pin('a'), pin('b')], cur: 'a' }, tab('b', 9));
    expect(ids(s)).toEqual(['a', 'b']);
    expect(s.cur).toBe('b');
  });
  it('never replaces a file tab', () => {
    const f: TaskTab = { ...tab('f:1'), kind: 'file', itemId: 'i' };
    expect(ids(reduceActivate({ tabs: [f, pin('a')], cur: 'f:1' }, tab('x')))).toEqual(['f:1', 'a']);
  });
  it('a tab of another workspace is pinned and kept like any other', () => {
    const other: TaskTab = { ...tab('o'), ws: 'w2', board: 'b2' };
    const s = reduceActivate(reduceAdd({ tabs: [pin('a')], cur: 'a' }, other), tab('x'));
    expect(ids(s)).toEqual(['a', 'o']);
    expect(s.tabs[1]).toMatchObject({ ws: 'w2', pinned: true });
  });
});

describe('reduceAdd', () => {
  it('appends in the background and keeps the current one', () => {
    const s = reduceAdd({ tabs: [tab('a')], cur: 'a' }, tab('b'));
    expect(ids(s)).toEqual(['a', 'b']);
    expect(s.cur).toBe('a');
  });
  it('takes the open task along when it is not a tab yet', () => {
    expect(ids(reduceAdd(empty, tab('b'), tab('a')))).toEqual(['a', 'b']);
  });
  it('pins the new tab, the open task that joins, and a preview tab that is added', () => {
    const s = reduceAdd({ tabs: [pv('p')], cur: 'p' }, tab('p'), tab('o'));
    expect(s.tabs.map((x) => [x.id, x.pinned])).toEqual([['p', true], ['o', true]]);
  });
  it('does not duplicate', () => {
    expect(ids(reduceAdd({ tabs: [tab('a')], cur: null }, tab('a')))).toEqual(['a']);
  });
  it('with every tab pinned, past the limit the oldest non-open one closes quietly', () => {
    const many = Array.from({ length: MAX_TABS }, (_, i) => pin(`t${i}`, 100 + i));
    const a = reduceAdd({ tabs: many, cur: 't9' }, tab('n2', 600), tab('t0', 100));
    expect(a.tabs).toHaveLength(MAX_TABS);
    expect(ids(a)).toContain('t0');
    expect(ids(a)).not.toContain('t1');
  });
  it('drops the least recently used tab past the limit, never the open one', () => {
    const many = Array.from({ length: MAX_TABS }, (_, i) => tab(`t${i}`, 100 + i));
    const s = reduceAdd({ tabs: many, cur: null }, tab('new', 500), tab('t0', 100));
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(ids(s)).toContain('t0');
    expect(ids(s)).not.toContain('t1');
    expect(ids(s)).toContain('new');
  });
});

describe('reduceClose', () => {
  it('offers the right neighbour, else the left one', () => {
    const s: TabsState = { tabs: [tab('a'), tab('b'), tab('c')], cur: 'b' };
    expect(reduceClose(s, 'b').next?.id).toBe('c');
    expect(reduceClose(s, 'c').next?.id).toBe('b');
    expect(reduceClose(s, 'b').state.cur).toBeNull();
  });
  it('has no neighbour for the last tab, and ignores an unknown id', () => {
    const one: TabsState = { tabs: [tab('a')], cur: 'a' };
    expect(reduceClose(one, 'a').next).toBeNull();
    expect(reduceClose(one, 'zzz').state).toBe(one);
  });
});

describe('reduceSync / sanitizeTabs', () => {
  it('keeps the same state when the snapshot is current', () => {
    const s: TabsState = { tabs: [tab('a')], cur: null };
    expect(reduceSync(s, 'a', 'K-a', 'Task a')).toBe(s);
    expect(reduceSync(s, 'a', 'K-a', 'Renamed').tabs[0]?.title).toBe('Renamed');
  });
  it('migrates tabs stored without the flag as pinned, drops a legacy preview tab (#137)', () => {
    const s = sanitizeTabs({ tabs: [{ id: 'a', ws: 'w', board: 'b' }, { id: 'p', ws: 'w', board: 'b', pinned: false }, { id: 'c', ws: 'w', board: 'b', pinned: true }] });
    expect(s.tabs.map((x) => x.pinned)).toEqual([true, true]);
  });
  it('survives garbage from storage', () => {
    expect(sanitizeTabs(null)).toEqual(empty);
    expect(sanitizeTabs({ tabs: 5 })).toEqual(empty);
    const s = sanitizeTabs({ tabs: [{ id: 'a', ws: 'w', board: 'b' }, { id: 'a', ws: 'w', board: 'b' }, { id: 3 }, null], cur: 'nope' });
    expect(ids(s)).toEqual(['a']);
    expect(s.cur).toBeNull();
  });
});
