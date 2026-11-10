import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { DISK_BITS, DiskActivityKind, DiskActivitySchema, DiskItemKind, DiskItemSchema, DiskUsageSchema, type DiskItem } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import {
  activityDays,
  applyListing,
  applyRemove,
  applyUpsert,
  canMoveInto,
  canShare,
  canWrite,
  crumbs,
  describeActivity,
  dropWorkspace,
  fileKind,
  folderCountParts,
  folderKey,
  matchesQuery,
  previewable,
  trashDaysOption,
  trashKey,
  usageBar,
  visibleIds,
  type DiskData,
  columnFolders,
  columnsNav,
  phoneDiskView,
} from './disk';

const WS = 'w1';
const col = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

function item(id: string, p: Partial<{ name: string; folder: boolean; parent: string; size: number; updated: number; mime: string; bits: bigint; trashed: boolean; root: boolean; owner: string; thumb: boolean }> = {}): DiskItem {
  return create(DiskItemSchema, {
    id,
    workspaceId: WS,
    parentId: p.parent ?? '',
    kind: p.folder ? DiskItemKind.FOLDER : DiskItemKind.FILE,
    name: p.name ?? id,
    ownerId: p.owner ?? '',
    myBits: p.bits ?? 0n,
    updatedAt: timestampFromMs(p.updated ?? 0),
    ...(p.folder ? {} : { file: { id: `f-${id}`, name: p.name ?? id, mime: p.mime ?? 'application/octet-stream', size: BigInt(p.size ?? 0), thumbnailUrl: p.thumb ? '/t' : '' } }),
    ...(p.trashed ? { trashedAt: timestampFromMs(1), trashedRoot: p.root ?? true } : {}),
  });
}

const byId = (...xs: DiskItem[]): Record<string, DiskItem> => Object.fromEntries(xs.map((x) => [x.id, x]));

describe('sorting and the search', () => {
  const items = byId(
    item('a', { name: 'Отчёт 10.pdf', size: 5, updated: 300 }),
    item('b', { name: 'Отчёт 2.pdf', size: 50, updated: 100 }),
    item('c', { name: 'Яблоко', folder: true, updated: 200 }),
    item('d', { name: 'архив', folder: true, updated: 400 }),
  );
  const ids = ['a', 'b', 'c', 'd'];

  it('name: folders first, then A–Z with numbers in order', () => {
    expect(visibleIds(ids, items, 'name', '', col)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('updated: newest first, folders mixed in', () => {
    expect(visibleIds(ids, items, 'updated', '', col)).toEqual(['d', 'a', 'c', 'b']);
  });

  it('size: folders first by name, then the largest file', () => {
    expect(visibleIds(ids, items, 'size', '', col)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('the query filters by a case-insensitive substring; unknown ids are skipped', () => {
    expect(visibleIds([...ids, 'zz'], items, 'name', 'ОТЧЁТ', col)).toEqual(['b', 'a']);
    expect(matchesQuery('Report.PDF', ' pdf ')).toBe(true);
    expect(matchesQuery('x', '')).toBe(true);
    expect(visibleIds(undefined, items, 'name', '', col)).toEqual([]);
  });
});

describe('crumbs', () => {
  it('the root first, then the path from GET …/path', () => {
    expect(crumbs('Диск', [item('p', { name: 'Проекты' }), item('q', { name: 'Q4' })])).toEqual([
      { id: '', name: 'Диск' },
      { id: 'p', name: 'Проекты' },
      { id: 'q', name: 'Q4' },
    ]);
    expect(crumbs('Диск', [])).toEqual([{ id: '', name: 'Диск' }]);
  });
});

describe('the store reducers', () => {
  const base = (): DiskData => applyListing({ items: {}, lists: {} }, folderKey(WS, ''), [item('a'), item('f', { folder: true })]);

  it('a listing replaces its list and stores the items', () => {
    const s = base();
    expect(s.lists[folderKey(WS, '')]).toEqual(['a', 'f']);
    expect(Object.keys(s.items)).toEqual(['a', 'f']);
  });

  it('an upsert moves the item between loaded lists of its workspace', () => {
    let s = applyListing(base(), folderKey(WS, 'f'), []);
    s = applyUpsert(s, item('a', { parent: 'f' }));
    expect(s.lists[folderKey(WS, '')]).toEqual(['f']);
    expect(s.lists[folderKey(WS, 'f')]).toEqual(['a']);
  });

  it('a new item joins its parent list; a list not loaded stays absent', () => {
    const s = applyUpsert(base(), item('n', { parent: 'zzz' }));
    expect(s.lists[folderKey(WS, 'zzz')]).toBeUndefined();
    const t = applyUpsert(base(), item('n'));
    expect(t.lists[folderKey(WS, '')]).toEqual(['a', 'f', 'n']);
  });

  it('a trashed root goes from its folder to the loaded trash; a trashed child to neither', () => {
    let s = applyListing(base(), trashKey(WS), []);
    s = applyUpsert(s, item('a', { trashed: true }));
    expect(s.lists[folderKey(WS, '')]).toEqual(['f']);
    expect(s.lists[trashKey(WS)]).toEqual(['a']);
    s = applyUpsert(s, item('f', { trashed: true, root: false }));
    expect(s.lists[folderKey(WS, '')]).toEqual([]);
    expect(s.lists[trashKey(WS)]).toEqual(['a']);
  });

  it('an event upsert (my_bits 0) keeps the known bits', () => {
    const s = applyUpsert(applyListing({ items: {}, lists: {} }, folderKey(WS, ''), [item('a', { bits: DISK_BITS.VIEW })]), item('a', { name: 'b' }), true);
    expect(s.items['a']?.myBits).toBe(DISK_BITS.VIEW);
    expect(s.items['a']?.name).toBe('b');
  });

  it('other workspaces keep their lists (same reference when untouched)', () => {
    const other = applyListing(base(), 'w2/root', ['x'].map((id) => create(DiskItemSchema, { id, workspaceId: 'w2' })));
    const s = applyUpsert(other, item('n'));
    expect(s.lists['w2/root']).toBe(other.lists['w2/root']);
  });

  it('remove drops the item everywhere; an unknown id changes nothing', () => {
    const s = base();
    expect(applyRemove(s, 'nope')).toBe(s);
    const r = applyRemove(s, 'a');
    expect(r.items['a']).toBeUndefined();
    expect(r.lists[folderKey(WS, '')]).toEqual(['f']);
  });

  it('dropWorkspace forgets the workspace only', () => {
    const s = applyListing(base(), 'w2/root', [create(DiskItemSchema, { id: 'x', workspaceId: 'w2' })]);
    const r = dropWorkspace(s, WS);
    expect(Object.keys(r.items)).toEqual(['x']);
    expect(Object.keys(r.lists)).toEqual(['w2/root']);
  });
});

describe('moving', () => {
  it('not into itself, its own subtree or where it already is', () => {
    const a = item('a', { parent: 'p', folder: true });
    expect(canMoveInto(a, 'p', [])).toBe(false);
    expect(canMoveInto(a, 'a', ['p'])).toBe(false);
    expect(canMoveInto(a, 'c', ['p', 'a', 'b'])).toBe(false);
    expect(canMoveInto(a, '', [])).toBe(true);
    expect(canMoveInto(a, 'x', ['x'])).toBe(true);
  });
});

describe('rights (UI only)', () => {
  it('write with WRITE or MANAGE; share for the owner or MANAGE', () => {
    expect(canWrite(DISK_BITS.VIEW)).toBe(false);
    expect(canWrite(DISK_BITS.VIEW | DISK_BITS.WRITE)).toBe(true);
    expect(canWrite(DISK_BITS.MANAGE)).toBe(true);
    expect(canShare({ ownerId: 'me', myBits: DISK_BITS.VIEW }, 'me')).toBe(true);
    expect(canShare({ ownerId: '', myBits: DISK_BITS.VIEW }, '')).toBe(false);
    expect(canShare({ ownerId: 'x', myBits: DISK_BITS.MANAGE }, 'me')).toBe(true);
  });
});

describe('the storage meter', () => {
  const u = (quota: number, used: number, disk: number, trash: number, other: number) =>
    usageBar(create(DiskUsageSchema, { quotaBytes: BigInt(quota), usedBytes: BigInt(used), diskBytes: BigInt(disk), trashBytes: BigInt(trash), otherBytes: BigInt(other) }));

  it('three shares of the limit: the disk without its trash, the trash, everything else', () => {
    const b = u(1000, 600, 400, 100, 200);
    expect(b).toMatchObject({ disk: 0.3, trash: 0.1, other: 0.2, used: 600, limit: 1000, warn: false, full: false });
  });

  it('warns from 90 %, full at the limit; over the limit the bar is relative to the usage', () => {
    expect(u(1000, 900, 900, 0, 0).warn).toBe(true);
    const over = u(1000, 1250, 1000, 0, 250);
    expect(over.full).toBe(true);
    expect(over.disk + over.other).toBeCloseTo(1);
  });

  it('no limit: relative to the usage, never a warning', () => {
    const b = u(0, 100, 50, 0, 50);
    expect(b).toMatchObject({ disk: 0.5, other: 0.5, limit: 0, warn: false });
  });
});

describe('files', () => {
  it('kind by MIME, then by extension', () => {
    expect(fileKind({ mime: 'image/png', name: 'a.png' })).toBe('image');
    expect(fileKind({ mime: 'application/pdf', name: 'a' })).toBe('pdf');
    expect(fileKind({ mime: 'application/octet-stream', name: 'Book.XLSX' })).toBe('sheet');
    expect(fileKind({ mime: 'text/plain', name: 'notes' })).toBe('text');
    expect(fileKind({ mime: '', name: 'noext' })).toBe('other');
    expect(fileKind(undefined)).toBe('other');
  });

  it('previews: images (a thumbnail not required, owner 28.10) and videos', () => {
    expect(previewable(item('a', { mime: 'image/png', thumb: true }).file)).toBe('image');
    expect(previewable(item('a', { mime: 'image/png' }).file)).toBe('image');
    expect(previewable(item('a', { mime: 'image/svg+xml' }).file)).toBeNull();
    expect(previewable(item('a', { mime: 'video/mp4' }).file)).toBe('video');
    expect(previewable(undefined)).toBeNull();
  });
});

describe('the journal', () => {
  const act = (kind: DiskActivityKind, before: Record<string, string> | null, after: Record<string, string> | null, itemName = 'x', at = 0) =>
    create(DiskActivitySchema, { id: String(at), kind, itemName, createdAt: timestampFromMs(at), ...(before ? { before } : {}), ...(after ? { after } : {}) });

  it('sentences from the snapshots, falling back to the item name', () => {
    expect(describeActivity(act(DiskActivityKind.UPLOAD, null, null, 'a.pdf'))).toEqual({ key: 'disk.act.upload', params: { name: 'a.pdf' } });
    expect(describeActivity(act(DiskActivityKind.RENAME, { name: 'A' }, { name: 'B' }))).toEqual({ key: 'disk.act.rename', params: { from: 'A', to: 'B' } });
    expect(describeActivity(act(DiskActivityKind.MOVE, null, { parent_name: 'Q4' }, 'a'))).toEqual({ key: 'disk.act.move', params: { name: 'a', to: 'Q4' } });
    expect(describeActivity(act(DiskActivityKind.MOVE, null, {}, 'a')).key).toBe('disk.act.moveRoot');
    expect(describeActivity(act(DiskActivityKind.UNSPECIFIED, null, null)).key).toBe('disk.act.other');
  });

  it('the link password and «Без скачивания» (ADR-0167)', () => {
    expect(describeActivity(act(DiskActivityKind.LINK_PASSWORD_ON, null, null, 'Docs')).key).toBe('disk.act.passwordOn');
    expect(describeActivity(create(DiskActivitySchema, { kind: DiskActivityKind.LINK_PASSWORD_ON, itemName: 'Docs', after: { changed: true } })).key).toBe('disk.act.passwordChange');
    expect(describeActivity(act(DiskActivityKind.LINK_PASSWORD_OFF, null, null)).key).toBe('disk.act.passwordOff');
    expect(describeActivity(act(DiskActivityKind.LINK_VIEW_ONLY_ON, null, null)).key).toBe('disk.act.viewOnlyOn');
    expect(describeActivity(act(DiskActivityKind.LINK_VIEW_ONLY_OFF, null, null)).key).toBe('disk.act.viewOnlyOff');
  });

  it('groups by local day keeping the order', () => {
    const day = Date.UTC(2026, 9, 14, 12);
    const g = activityDays([act(DiskActivityKind.UPLOAD, null, null, 'a', day), act(DiskActivityKind.UPLOAD, null, null, 'b', day - 60_000), act(DiskActivityKind.UPLOAD, null, null, 'c', day - 3 * 86_400_000)]);
    expect(g.map((x) => x.items.length)).toEqual([2, 1]);
  });
});

describe('trash retention', () => {
  it('a stored value maps onto an option', () => {
    expect(trashDaysOption(0)).toBe(0);
    expect(trashDaysOption(30)).toBe(30);
    expect(trashDaysOption(10)).toBe(30);
    expect(trashDaysOption(365)).toBe(90);
  });
});

describe('columns view (CBF-21)', () => {
  const cols = [
    { folder: '', ids: ['a', 'b', 'c'] },
    { folder: 'b', ids: ['b1', 'b2'] },
    { folder: 'b2', ids: ['f'] },
  ];
  it('the column folders are the root and the path, or the open folder until the path is loaded', () => {
    expect(columnFolders('', undefined)).toEqual(['']);
    expect(columnFolders('b2', [{ id: 'b' }, { id: 'b2' }])).toEqual(['', 'b', 'b2']);
    expect(columnFolders('b2', undefined)).toEqual(['', 'b2']);
  });
  it('up and down stay in the column and stop at the ends', () => {
    expect(columnsNav(cols, 'a', 'ArrowDown')).toBe('b');
    expect(columnsNav(cols, 'c', 'ArrowDown')).toBe('c');
    expect(columnsNav(cols, 'a', 'ArrowUp')).toBe('a');
    expect(columnsNav(cols, 'b2', 'ArrowUp')).toBe('b1');
  });
  it('right goes into the open folder, left back to its parent folder', () => {
    expect(columnsNav(cols, 'b', 'ArrowRight')).toBe('b1');
    expect(columnsNav(cols, 'a', 'ArrowRight')).toBeNull();
    expect(columnsNav(cols, 'b1', 'ArrowRight')).toBeNull();
    expect(columnsNav(cols, 'b1', 'ArrowLeft')).toBe('b');
    expect(columnsNav(cols, 'f', 'ArrowLeft')).toBe('b2');
    expect(columnsNav(cols, 'a', 'ArrowLeft')).toBeNull();
  });
  it('without a cursor (or with a filtered-out one) the first row of the last column is picked', () => {
    expect(columnsNav(cols, null, 'ArrowDown')).toBe('f');
    expect(columnsNav(cols, 'gone', 'ArrowRight')).toBe('f');
    expect(columnsNav([], null, 'ArrowDown')).toBeNull();
  });
  it('the phone has no columns', () => {
    expect(phoneDiskView('columns')).toBe('list');
    expect(phoneDiskView('tiles')).toBe('tiles');
  });
});

describe('folderCountParts (the folder card, CBF-66)', () => {
  it('lists only the non-zero counters, files first', () => {
    expect(folderCountParts(3, 2)).toEqual([
      { kind: 'files', n: 3 },
      { kind: 'folders', n: 2 },
    ]);
    expect(folderCountParts(0, 4)).toEqual([{ kind: 'folders', n: 4 }]);
    expect(folderCountParts(1, 0)).toEqual([{ kind: 'files', n: 1 }]);
  });
  it('is empty for an empty folder', () => {
    expect(folderCountParts(0, 0)).toEqual([]);
  });
});
