import type { JsonObject } from '@bufbuild/protobuf';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { DISK_BITS, DiskActivityKind, DiskItemKind, type DiskActivity, type DiskItem, type DiskUsage, type FileMeta } from '@calaba/protocol';

/**
 * Disk (ADR-0094) — pure helpers of the desktop screen: listing keys, sorting and the search
 * filter, the breadcrumbs, the file kind for an icon, the three-segment storage meter and the
 * normalized store's reducers (stores/disk.ts). No store or React imports: unit-tested in Node.
 */

export type DiskSort = 'name' | 'updated' | 'size';
export type DiskView = 'tiles' | 'list';
export const DISK_SORTS: readonly DiskSort[] = ['name', 'updated', 'size'];
export const DISK_VIEWS: readonly DiskView[] = ['tiles', 'list'];

export const isDiskSort = (v: unknown): v is DiskSort => typeof v === 'string' && (DISK_SORTS as readonly string[]).includes(v);
export const isDiskView = (v: unknown): v is DiskView => typeof v === 'string' && (DISK_VIEWS as readonly string[]).includes(v);

/** The root folder's id in listings and in the UI memory (DiskItem.parent_id is empty for it). */
export const ROOT = '';

/** The key of a listing in the store: a folder of a workspace, or its trash. */
export const folderKey = (wsId: string, parentId: string): string => `${wsId}/${parentId || 'root'}`;
export const trashKey = (wsId: string): string => `${wsId}/trash`;

export const isFolder = (i: Pick<DiskItem, 'kind'>): boolean => i.kind === DiskItemKind.FOLDER;

const ms = (ts: DiskItem['updatedAt']): number => (ts ? timestampMs(ts) : 0);
const sizeOf = (i: DiskItem): number => (i.file ? Number(i.file.size) : 0);

/**
 * The server's orders (disk.proto ListDiskItemsResponse): name — folders first, A–Z; updated —
 * newest first; size — folders first (by name), then the largest file first. Ties by name, then id.
 */
export function compareItems(a: DiskItem, b: DiskItem, sort: DiskSort, collator: Intl.Collator): number {
  const byName = collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (sort === 'updated') return ms(b.updatedAt) - ms(a.updatedAt) || byName;
  const folders = Number(isFolder(b)) - Number(isFolder(a));
  if (folders) return folders;
  if (sort === 'size' && !isFolder(a)) return sizeOf(b) - sizeOf(a) || byName;
  return byName;
}

/** Case-insensitive substring match of the name (the bar's search filters the open folder). */
export function matchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return !q || name.toLocaleLowerCase().includes(q);
}

/** The ids of a listing shown: filtered by the query and sorted; unknown ids are skipped. */
export function visibleIds(
  ids: readonly string[] | undefined,
  items: Readonly<Record<string, DiskItem>>,
  sort: DiskSort,
  query: string,
  collator: Intl.Collator,
): string[] {
  if (!ids) return [];
  const list: DiskItem[] = [];
  for (const id of ids) {
    const it = items[id];
    if (it && matchesQuery(it.name, query)) list.push(it);
  }
  list.sort((a, b) => compareItems(a, b, sort, collator));
  return list.map((i) => i.id);
}

/** Crumbs of the open folder: the root, then its ancestors (GET …/path: the root's child first). */
export interface Crumb {
  id: string;
  name: string;
}
export function crumbs(rootName: string, path: readonly Pick<DiskItem, 'id' | 'name'>[]): Crumb[] {
  return [{ id: ROOT, name: rootName }, ...path.map((p) => ({ id: p.id, name: p.name }))];
}

/** What a file looks like in a tile / row without a thumbnail. */
export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'sheet' | 'slides' | 'doc' | 'code' | 'text' | 'other';

const EXT: Record<string, FileKind> = {
  zip: 'archive', rar: 'archive', '7z': 'archive', gz: 'archive', tgz: 'archive', tar: 'archive', bz2: 'archive', xz: 'archive',
  xls: 'sheet', xlsx: 'sheet', ods: 'sheet', csv: 'sheet', numbers: 'sheet',
  ppt: 'slides', pptx: 'slides', odp: 'slides', key: 'slides',
  doc: 'doc', docx: 'doc', odt: 'doc', rtf: 'doc', pages: 'doc',
  txt: 'text', md: 'text', log: 'text',
  js: 'code', ts: 'code', tsx: 'code', json: 'code', go: 'code', py: 'code', html: 'code', css: 'code', yml: 'code', yaml: 'code', sh: 'code', sql: 'code',
};

export function fileKind(f: Pick<FileMeta, 'mime' | 'name'> | undefined): FileKind {
  if (!f) return 'other';
  const mime = f.mime.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  const dot = f.name.lastIndexOf('.');
  const ext = dot > 0 ? f.name.slice(dot + 1).toLowerCase() : '';
  return EXT[ext] ?? (mime.startsWith('text/') ? 'text' : 'other');
}

/** Can the item be previewed in the app (Lightbox / the video player); the rest is downloaded. */
export const previewable = (f: FileMeta | undefined): 'image' | 'video' | null =>
  !f ? null : f.mime.startsWith('image/') && !!f.thumbnailUrl ? 'image' : f.mime.startsWith('video/') ? 'video' : null;

// ---------------------------------------------------------------- rights (UI only; the server decides)

export const canView = (bits: bigint): boolean => (bits & DISK_BITS.VIEW) !== 0n;
export const canWrite = (bits: bigint): boolean => (bits & (DISK_BITS.WRITE | DISK_BITS.MANAGE)) !== 0n;
export const canManage = (bits: bigint): boolean => (bits & DISK_BITS.MANAGE) !== 0n;

/** Access and the public link: the item's owner or DISK_MANAGE (ADR-0094 §2, §3). */
export const canShare = (item: Pick<DiskItem, 'ownerId' | 'myBits'>, me: string): boolean => (item.ownerId !== '' && item.ownerId === me) || canManage(item.myBits);

// ---------------------------------------------------------------- the storage meter

/** The three segments of the meter (ADR-0094 §6) as shares of the bar, 0…1 each, and the warning. */
export interface UsageBar {
  /** Files of the Disk outside the trash. */
  disk: number;
  trash: number;
  /** Chat and board attachments, stickers … (used − disk). */
  other: number;
  used: number;
  /** The effective limit in bytes, 0 = unlimited (the bar is then relative to the usage). */
  limit: number;
  /** ≥ 90 % of a limit. */
  warn: boolean;
  /** At or over the limit. */
  full: boolean;
}

export function usageBar(u: Pick<DiskUsage, 'quotaBytes' | 'usedBytes' | 'diskBytes' | 'trashBytes' | 'otherBytes'>): UsageBar {
  const trash = Number(u.trashBytes);
  const disk = Math.max(0, Number(u.diskBytes) - trash);
  const other = Number(u.otherBytes);
  const used = Math.max(Number(u.usedBytes), disk + trash + other);
  const limit = Number(u.quotaBytes);
  const scale = limit > 0 ? Math.max(limit, used) : Math.max(used, 1);
  const share = (n: number): number => (scale > 0 ? n / scale : 0);
  return {
    disk: share(disk),
    trash: share(trash),
    other: share(other),
    used,
    limit,
    warn: limit > 0 && used / limit >= 0.9,
    full: limit > 0 && used >= limit,
  };
}

// ---------------------------------------------------------------- store reducers

/** The normalized data of stores/disk.ts. */
export interface DiskData {
  items: Readonly<Record<string, DiskItem>>;
  /** folderKey / trashKey → the ids of that listing (loaded ones only). */
  lists: Readonly<Record<string, readonly string[]>>;
}

/** A listing loaded: its items replace the stored ones (fresh bits), the list is replaced. */
export function applyListing(s: DiskData, key: string, items: readonly DiskItem[]): DiskData {
  const next = { ...s.items };
  for (const it of items) next[it.id] = it;
  return { items: next, lists: { ...s.lists, [key]: items.map((i) => i.id) } };
}

const without = (ids: readonly string[], id: string): readonly string[] => (ids.includes(id) ? ids.filter((x) => x !== id) : ids);

/**
 * DISK_ITEM_UPSERT (or a local answer): the item is stored and moved between the loaded listings
 * of its workspace — out of every list it no longer belongs to (another parent, trashed), into
 * its parent's list (or the trash's, for a trash root). An event's item carries my_bits = 0: the
 * known bits are kept (the caller refetches the open listing for the real ones).
 */
export function applyUpsert(s: DiskData, item: DiskItem, fromEvent = false): DiskData {
  const prev = s.items[item.id];
  const stored = fromEvent && prev && item.myBits === 0n ? { ...item, myBits: prev.myBits } : item;
  const ws = item.workspaceId;
  const home = item.trashedAt ? (item.trashedRoot ? trashKey(ws) : null) : folderKey(ws, item.parentId);
  const lists: Record<string, readonly string[]> = {};
  let changed = false;
  for (const [key, ids] of Object.entries(s.lists)) {
    if (!key.startsWith(`${ws}/`)) {
      lists[key] = ids;
      continue;
    }
    let next = key === home ? ids : without(ids, item.id);
    if (key === home && !next.includes(item.id)) next = [...next, item.id];
    if (next !== ids) changed = true;
    lists[key] = next;
  }
  return { items: { ...s.items, [item.id]: stored }, lists: changed ? lists : s.lists };
}

/** DISK_ITEM_REMOVE (deleted forever, or my access gone): out of the items and every listing. */
export function applyRemove(s: DiskData, id: string): DiskData {
  if (!s.items[id] && !Object.values(s.lists).some((ids) => ids.includes(id))) return s;
  const items = { ...s.items };
  delete items[id];
  const lists: Record<string, readonly string[]> = {};
  for (const [key, ids] of Object.entries(s.lists)) lists[key] = without(ids, id);
  return { items, lists };
}

/** Everything of a workspace dropped (left it, deleted, or the listings are stale). */
export function dropWorkspace(s: DiskData, wsId: string): DiskData {
  const items: Record<string, DiskItem> = {};
  for (const [id, it] of Object.entries(s.items)) if (it.workspaceId !== wsId) items[id] = it;
  const lists: Record<string, readonly string[]> = {};
  for (const [key, ids] of Object.entries(s.lists)) if (!key.startsWith(`${wsId}/`)) lists[key] = ids;
  return { items, lists };
}

/** The «Переместить» picker: may `item` go into `target` (not itself or into its own subtree, not where it is). */
export function canMoveInto(item: Pick<DiskItem, 'id' | 'parentId'>, target: string, ancestorsOfTarget: readonly string[]): boolean {
  if (target === item.parentId) return false;
  if (target === item.id) return false;
  return !ancestorsOfTarget.includes(item.id);
}

// ---------------------------------------------------------------- the journal (ADR-0094 §5)

export type ActivityKey =
  | 'disk.act.create'
  | 'disk.act.upload'
  | 'disk.act.rename'
  | 'disk.act.move'
  | 'disk.act.moveRoot'
  | 'disk.act.share'
  | 'disk.act.linkOn'
  | 'disk.act.linkOff'
  | 'disk.act.trash'
  | 'disk.act.restore'
  | 'disk.act.delete'
  | 'disk.act.other';

/** The first string among `keys` of a before / after snapshot (Struct keys as the server writes them: snake_case, e.g. `parent_name`). */
function snap(o: JsonObject | undefined, ...keys: string[]): string {
  if (!o) return '';
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/**
 * One journal entry as a sentence key and its params (the actor's name goes before it): «загрузил(а)
 * «отчёт.pdf»», «переименовал(а) «A» в «B»», «переместил(а) «A» в «Папка»» (no folder name in the
 * snapshot = the root). Names come from the snapshots, falling back to the entry's item_name.
 */
export function describeActivity(a: Pick<DiskActivity, 'kind' | 'before' | 'after' | 'itemName'>): { key: ActivityKey; params: Record<string, string> } {
  const name = snap(a.after, 'name') || a.itemName || snap(a.before, 'name');
  switch (a.kind) {
    case DiskActivityKind.CREATE:
      return { key: 'disk.act.create', params: { name } };
    case DiskActivityKind.UPLOAD:
      return { key: 'disk.act.upload', params: { name } };
    case DiskActivityKind.RENAME:
      return { key: 'disk.act.rename', params: { from: snap(a.before, 'name') || a.itemName, to: snap(a.after, 'name') || a.itemName } };
    case DiskActivityKind.MOVE: {
      const to = snap(a.after, 'parent_name');
      return to ? { key: 'disk.act.move', params: { name, to } } : { key: 'disk.act.moveRoot', params: { name } };
    }
    case DiskActivityKind.SHARE:
      return { key: 'disk.act.share', params: { name } };
    case DiskActivityKind.LINK_ON:
      return { key: 'disk.act.linkOn', params: { name } };
    case DiskActivityKind.LINK_OFF:
      return { key: 'disk.act.linkOff', params: { name } };
    case DiskActivityKind.TRASH:
      return { key: 'disk.act.trash', params: { name } };
    case DiskActivityKind.RESTORE:
      return { key: 'disk.act.restore', params: { name } };
    case DiskActivityKind.DELETE:
      return { key: 'disk.act.delete', params: { name } };
    default:
      return { key: 'disk.act.other', params: { name } };
  }
}

/** Journal entries by local day, newest first (the order they come in). */
export function activityDays<T extends Pick<DiskActivity, 'createdAt'>>(list: readonly T[]): Array<{ day: string; at: number; items: T[] }> {
  const out: Array<{ day: string; at: number; items: T[] }> = [];
  for (const a of list) {
    const at = a.createdAt ? timestampMs(a.createdAt) : 0;
    const d = new Date(at);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(a);
    else out.push({ day, at, items: [a] });
  }
  return out;
}

/** Trash retention options of the workspace settings (ADR-0094 §1): 0 = never. */
export const TRASH_DAYS = [0, 7, 30, 90] as const;
export type TrashDays = (typeof TRASH_DAYS)[number];
/** A stored value outside the options shows as the nearest longer one (never shortens the term silently). */
export const trashDaysOption = (n: number): TrashDays => (n <= 0 ? 0 : (TRASH_DAYS.find((d) => d >= n) ?? 90));

/** The storage packs of «Докупить место» (ADR-0094 §6), in GB; buying is off until payments are on. */
export const STORAGE_PACKS = [
  { sku: 'storage.10gb.day', gb: 10 },
  { sku: 'storage.100gb.day', gb: 100 },
  { sku: 'storage.500gb.day', gb: 500 },
  { sku: 'storage.1tb.day', gb: 1024 },
] as const;
