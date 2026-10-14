import { WIKI_BITS, wikiStructureAllowed, type WikiPage } from '@calaba/protocol';

/**
 * Wiki (ADR-0096) — pure helpers of the desktop section: the keys of the lazily loaded child lists,
 * the normalized store's reducers (stores/wiki.ts), ancestors for the crumbs, the drop plan of a
 * dragged tree row, the title filter and the rights shortcuts. No store or React imports.
 */

/** The top level's parent id (WikiPage.parent_id is empty for it). */
export const TOP = '';

/** The key of a child list in the store: the children of a page (or the top level) of a workspace. */
export const childKey = (wsId: string, parentId: string): string => `${wsId}/${parentId || 'top'}`;
export const trashKey = (wsId: string): string => `${wsId}/trash`;

export interface WikiData {
  pages: Readonly<Record<string, WikiPage>>;
  /** childKey / trashKey → page ids in the server's order (position; the trash newest first). */
  lists: Readonly<Record<string, readonly string[]>>;
}

/** A loaded child list (or the trash): its pages are stored, the list replaced. */
export function applyList(s: WikiData, key: string, pages: readonly WikiPage[]): WikiData {
  const next = { ...s.pages };
  for (const p of pages) next[p.id] = freshest(s.pages[p.id], p);
  return { pages: next, lists: { ...s.lists, [key]: pages.map((p) => p.id) } };
}

const stamp = (p: WikiPage): bigint => (p.updatedAt ? p.updatedAt.seconds * 1_000_000_000n + BigInt(p.updatedAt.nanos) : 0n);

/**
 * A fetched list row against the stored page: a list read that started before an event (a rename
 * a moment after the page was created) may arrive after it — the newer content stays, the fetched
 * rights, sharing and link are taken (the event has none of the last two).
 */
function freshest(prev: WikiPage | undefined, p: WikiPage): WikiPage {
  return prev && stamp(prev) > stamp(p) ? { ...prev, myBits: p.myBits, shared: p.shared, link: p.link } : keepBits(prev, p);
}

/** An event's page normally carries my_bits (the gateway fills them); a 0 (an older server) keeps the known ones. */
function keepBits(prev: WikiPage | undefined, p: WikiPage, fromEvent = false): WikiPage {
  return fromEvent && prev && p.myBits === 0n ? { ...p, myBits: prev.myBits } : p;
}

const without = (ids: readonly string[], id: string): readonly string[] => (ids.includes(id) ? ids.filter((x) => x !== id) : ids);

/**
 * WIKI_PAGE_UPSERT or a local answer: the page is stored and moved between the loaded lists of
 * its workspace — out of every list it no longer belongs to, into its parent's list at its
 * position (or the trash's front, for a trash root). The parent learns it has children.
 */
export function applyUpsert(s: WikiData, page: WikiPage, fromEvent = false): WikiData {
  const prev = s.pages[page.id];
  const stored = keepBits(prev, page, fromEvent);
  const ws = page.workspaceId;
  const home = page.trashedAt ? (page.trashedRoot ? trashKey(ws) : null) : childKey(ws, page.parentId);
  const lists: Record<string, readonly string[]> = {};
  let changed = false;
  for (const [key, ids] of Object.entries(s.lists)) {
    if (!key.startsWith(`${ws}/`)) {
      lists[key] = ids;
      continue;
    }
    let next = key === home ? ids : without(ids, page.id);
    if (key === home && !next.includes(page.id)) {
      if (key === trashKey(ws)) next = [page.id, ...next];
      else {
        const at = Math.max(0, Math.min(next.length, page.position));
        next = [...next.slice(0, at), page.id, ...next.slice(at)];
      }
    }
    if (next !== ids) changed = true;
    lists[key] = next;
  }
  const pages: Record<string, WikiPage> = { ...s.pages, [page.id]: stored };
  const parent = !page.trashedAt && page.parentId ? pages[page.parentId] : undefined;
  if (parent && !parent.hasChildren) pages[parent.id] = { ...parent, hasChildren: true };
  return { pages, lists: changed ? lists : s.lists };
}

/** WIKI_PAGE_REMOVE (deleted forever, or my access gone): the page and its loaded subtree go. */
export function applyRemove(s: WikiData, id: string): WikiData {
  const page = s.pages[id];
  if (!page && !Object.values(s.lists).some((ids) => ids.includes(id))) return s;
  const gone = new Set<string>([id]);
  if (page) {
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop() as string;
      for (const c of s.lists[childKey(page.workspaceId, cur)] ?? []) {
        if (!gone.has(c)) {
          gone.add(c);
          stack.push(c);
        }
      }
    }
  }
  const pages = { ...s.pages };
  for (const g of gone) delete pages[g];
  const lists: Record<string, readonly string[]> = {};
  for (const [key, ids] of Object.entries(s.lists)) {
    const slash = key.indexOf('/');
    if (gone.has(key.slice(slash + 1))) continue;
    lists[key] = ids.some((x) => gone.has(x)) ? ids.filter((x) => !gone.has(x)) : ids;
  }
  return { pages, lists };
}

/** Everything of a workspace dropped (left it, deleted). */
export function dropWorkspace(s: WikiData, wsId: string): WikiData {
  const pages: Record<string, WikiPage> = {};
  for (const [id, p] of Object.entries(s.pages)) if (p.workspaceId !== wsId) pages[id] = p;
  const lists: Record<string, readonly string[]> = {};
  for (const [key, ids] of Object.entries(s.lists)) if (!key.startsWith(`${wsId}/`)) lists[key] = ids;
  return { pages, lists };
}

/** The ancestors of a page, the top-level one first (stops at an unknown one); empty for the top level. */
export function ancestorsOf(pages: Readonly<Record<string, WikiPage>>, id: string): string[] {
  const out: string[] = [];
  let cur = pages[id]?.parentId ?? '';
  for (let i = 0; cur && i < 40; i++) {
    out.unshift(cur);
    cur = pages[cur]?.parentId ?? '';
  }
  return out;
}

/** Is `id` the page `root` or inside its subtree (by the known parents)? */
export function isInSubtree(pages: Readonly<Record<string, WikiPage>>, id: string, root: string): boolean {
  let cur = id;
  for (let i = 0; cur && i < 40; i++) {
    if (cur === root) return true;
    cur = pages[cur]?.parentId ?? '';
  }
  return false;
}

// ---------------------------------------------------------------- drag and drop in the tree

/** Where a dragged row lands relative to the row under the pointer. */
export type DropZone = 'before' | 'inside' | 'after';

/** The zone from the pointer's height inside the row: the top and bottom quarters go between rows. */
export function zoneAt(pointerY: number, top: number, height: number): DropZone {
  const f = height > 0 ? (pointerY - top) / height : 0.5;
  return f < 0.28 ? 'before' : f > 0.72 ? 'after' : 'inside';
}

export interface DropPlan {
  parentId: string;
  /** The index among the new siblings (the dragged page itself not counted), as PATCH takes it. */
  position: number;
}

/**
 * The PATCH a drop asks for, or null when it is a no-op or not allowed (into itself or its own
 * subtree). `inside` appends to the target's loaded children (first when they are not loaded).
 */
export function dropPlan(s: WikiData, dragId: string, overId: string, zone: DropZone): DropPlan | null {
  const drag = s.pages[dragId];
  const over = s.pages[overId];
  if (!drag || !over || dragId === overId) return null;
  const ws = drag.workspaceId;
  const parentId = zone === 'inside' ? over.id : over.parentId;
  if (parentId && isInSubtree(s.pages, parentId, dragId)) return null;
  const siblings = (s.lists[childKey(ws, parentId)] ?? []).filter((x) => x !== dragId);
  let position: number;
  if (zone === 'inside') position = s.lists[childKey(ws, parentId)] ? siblings.length : 0;
  else {
    const i = siblings.indexOf(over.id);
    if (i < 0) return null;
    position = zone === 'before' ? i : i + 1;
  }
  if (parentId === drag.parentId) {
    const cur = (s.lists[childKey(ws, parentId)] ?? []).indexOf(dragId);
    if (cur === position) return null;
  }
  return { parentId, position };
}

// ---------------------------------------------------------------- search, rights

/** Case-insensitive substring match of the title. */
export function matchesTitle(title: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return !q || title.toLocaleLowerCase().includes(q);
}

/** Loaded live pages of a workspace whose title matches (the tree's filter), at most `limit`. */
export function filterPages(pages: Readonly<Record<string, WikiPage>>, wsId: string, query: string, limit = 50): string[] {
  if (!query.trim()) return [];
  const out: string[] = [];
  for (const p of Object.values(pages)) {
    if (p.workspaceId !== wsId || p.trashedAt || !matchesTitle(p.title, query)) continue;
    out.push(p.id);
    if (out.length >= limit) break;
  }
  return out;
}

export const canView = (bits: bigint): boolean => (bits & WIKI_BITS.VIEW) !== 0n;
/** Edit the content and add subpages (ADR-0096 §2). */
export const canWrite = (bits: bigint): boolean => (bits & (WIKI_BITS.WRITE | WIKI_BITS.MANAGE)) !== 0n;
export const canManage = (bits: bigint): boolean => (bits & WIKI_BITS.MANAGE) !== 0n;
/** Rename, icon, cover, move, trash, access and the link: the owner or WIKI_MANAGE. */
export const canStructure = (p: Pick<WikiPage, 'ownerId' | 'myBits'>, me: string): boolean => wikiStructureAllowed(p.myBits, p.ownerId !== '' && p.ownerId === me);

/** The page's file name for «Экспорт в Markdown»: the title without characters file systems refuse. */
export function exportName(title: string, fallback: string): string {
  const base = title
    .replace(/[\\/:*?"<>|]+|\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${base || fallback}.md`;
}
