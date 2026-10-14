import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { WIKI_BITS, WikiPageSchema, type WikiPage } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { ancestorsOf, applyList, applyRemove, applyUpsert, canStructure, childKey, dropPlan, exportName, filterPages, trashKey, zoneAt, type WikiData } from './tree';

const WS = 'w1';
const page = (id: string, parentId = '', extra: Omit<Partial<WikiPage>, '$typeName' | '$unknown'> = {}): WikiPage => create(WikiPageSchema, { id, workspaceId: WS, parentId, title: id.toUpperCase(), ...extra });

/** a → (a1, a2 → (a21)), b; all lists loaded. */
function tree(): WikiData {
  let s: WikiData = { pages: {}, lists: {} };
  s = applyList(s, childKey(WS, ''), [page('a', '', { hasChildren: true }), page('b')]);
  s = applyList(s, childKey(WS, 'a'), [page('a1', 'a'), page('a2', 'a', { hasChildren: true })]);
  s = applyList(s, childKey(WS, 'a2'), [page('a21', 'a2')]);
  return s;
}

describe('wiki tree reducers', () => {
  it('upsert moves a page between loaded lists at its position', () => {
    const s = applyUpsert(tree(), page('a21', '', { position: 1 }));
    expect(s.lists[childKey(WS, 'a2')]).toEqual([]);
    expect(s.lists[childKey(WS, '')]).toEqual(['a', 'a21', 'b']);
  });

  it('a trashed root leaves its list and goes to the front of a loaded trash', () => {
    let s = applyList(tree(), trashKey(WS), [page('old', '', { trashedAt: timestampFromMs(1), trashedRoot: true })]);
    s = applyUpsert(s, page('a1', 'a', { trashedAt: timestampFromMs(2), trashedRoot: true }));
    expect(s.lists[childKey(WS, 'a')]).toEqual(['a2']);
    expect(s.lists[trashKey(WS)]).toEqual(['a1', 'old']);
  });

  it('a list read older than an event does not bring back the old title', () => {
    let s = applyList({ pages: {}, lists: {} }, childKey(WS, ''), [page('a')]);
    s = applyUpsert(s, page('a', '', { title: 'Renamed', updatedAt: timestampFromMs(2000) }), true);
    s = applyList(s, childKey(WS, ''), [page('a', '', { title: '', updatedAt: timestampFromMs(1000), myBits: WIKI_BITS.VIEW })]);
    expect(s.pages['a']?.title).toBe('Renamed');
    expect(s.pages['a']?.myBits).toBe(WIKI_BITS.VIEW); // the fetched rights are taken
    s = applyList(s, childKey(WS, ''), [page('a', '', { title: 'Newer', updatedAt: timestampFromMs(3000) })]);
    expect(s.pages['a']?.title).toBe('Newer');
  });

  it('an event keeps the known bits and marks the parent as having children', () => {
    let s = applyUpsert(tree(), { ...page('b'), myBits: WIKI_BITS.VIEW });
    s = applyUpsert(s, page('b1', 'b'), true);
    s = applyUpsert(s, { ...page('b'), myBits: 0n, hasChildren: false }, true);
    expect(s.pages['b']?.myBits).toBe(WIKI_BITS.VIEW);
    s = applyList(s, childKey(WS, 'b'), []);
    s = applyUpsert(s, page('b2', 'b'));
    expect(s.pages['b']?.hasChildren).toBe(true);
  });

  it('remove drops the loaded subtree and its lists', () => {
    const s = applyRemove(tree(), 'a');
    expect(Object.keys(s.pages).sort()).toEqual(['b']);
    expect(s.lists[childKey(WS, '')]).toEqual(['b']);
    expect(s.lists[childKey(WS, 'a')]).toBeUndefined();
    expect(s.lists[childKey(WS, 'a2')]).toBeUndefined();
  });

  it('ancestors run from the top level down', () => {
    expect(ancestorsOf(tree().pages, 'a21')).toEqual(['a', 'a2']);
    expect(ancestorsOf(tree().pages, 'b')).toEqual([]);
  });
});

describe('wiki drop plan', () => {
  it('between rows: the index among the siblings without the dragged one', () => {
    expect(dropPlan(tree(), 'b', 'a1', 'after')).toEqual({ parentId: 'a', position: 1 });
    expect(dropPlan(tree(), 'a2', 'a1', 'before')).toEqual({ parentId: 'a', position: 0 });
    expect(dropPlan(tree(), 'a1', 'a2', 'after')).toEqual({ parentId: 'a', position: 1 });
  });

  it('inside appends to loaded children, first when not loaded', () => {
    expect(dropPlan(tree(), 'b', 'a', 'inside')).toEqual({ parentId: 'a', position: 2 });
    expect(dropPlan(tree(), 'a1', 'b', 'inside')).toEqual({ parentId: 'b', position: 0 });
  });

  it('refuses no-ops and drops into the own subtree', () => {
    expect(dropPlan(tree(), 'a1', 'a2', 'before')).toBeNull();
    expect(dropPlan(tree(), 'a', 'a21', 'inside')).toBeNull();
    expect(dropPlan(tree(), 'a', 'a2', 'after')).toBeNull();
    expect(dropPlan(tree(), 'a', 'a', 'inside')).toBeNull();
  });

  it('zones: quarters between rows, the middle inside', () => {
    expect(zoneAt(101, 100, 32)).toBe('before');
    expect(zoneAt(116, 100, 32)).toBe('inside');
    expect(zoneAt(131, 100, 32)).toBe('after');
  });
});

describe('wiki helpers', () => {
  it('filters loaded live pages by title', () => {
    const s = applyUpsert(tree(), page('gone', '', { title: 'A gone', trashedAt: timestampFromMs(1) }));
    expect(filterPages(s.pages, WS, 'a2').sort()).toEqual(['a2', 'a21']);
    expect(filterPages(s.pages, WS, '  ')).toEqual([]);
  });

  it('structure needs the owner or MANAGE', () => {
    expect(canStructure({ ownerId: 'me', myBits: WIKI_BITS.VIEW }, 'me')).toBe(true);
    expect(canStructure({ ownerId: 'x', myBits: WIKI_BITS.VIEW | WIKI_BITS.WRITE }, 'me')).toBe(false);
    expect(canStructure({ ownerId: 'x', myBits: WIKI_BITS.VIEW | WIKI_BITS.MANAGE }, 'me')).toBe(true);
  });

  it('export names drop characters file systems refuse', () => {
    expect(exportName('Q4: план / итоги', 'x')).toBe('Q4 план итоги.md');
    expect(exportName('  ', 'Без названия')).toBe('Без названия.md');
  });
});
