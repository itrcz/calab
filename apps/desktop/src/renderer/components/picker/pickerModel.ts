/*
 * Pure model of the one picker (docs/08 «Выбор участника», docs/09 #33): search, groups, the
 * flat row list the view renders (headers + items) and keyboard movement. No React here.
 */

import { foldQuery, haystackOf, matchHaystack, parseQuery, type Match, type ParsedQuery } from '../../lib/memberSearch';

/** One choosable entry. `search` holds every field the query matches (name, nickname, email…). */
export interface PickerItem {
  id: string;
  search: readonly string[];
  /** Contact fields (email, phone, extension) the query also matches, kept out of `search` (lib/memberSearch.ts). */
  searchHidden?: readonly string[];
  /** Set by the filter when only a contact field matched: the row shows it instead of its secondary text. */
  matchedBy?: string;
  /** Shown but not choosable (e.g. the owner in room permissions: always full access). */
  disabled?: boolean;
}

export interface PickerGroup<T extends PickerItem> {
  id: string;
  /** Group header («Роли», «Участники»); empty = no header. */
  label: string;
  items: readonly T[];
  /** Collapsed (header only) until opened, unless a search is active (found items always show). */
  collapsible?: boolean;
}

export type PickerRow<T extends PickerItem> =
  | { kind: 'header'; key: string; label: string; toggle?: { id: string; open: boolean } }
  /** `nav`: index among the choosable rows (keyboard order); -1 for a disabled item. */
  | { kind: 'item'; key: string; item: T; nav: number };

/** Search debounce (ms): typing stays instant, the list follows a beat later. */
export const PICKER_DEBOUNCE_MS = 150;
/** Above this many rows the list is virtualized (react-virtuoso). */
export const PICKER_VIRTUAL_MIN = 50;
/** Row height (px): 32 on the desktop (docs/08). */
export const PICKER_ROW_PX = 32;

export { foldQuery as normalize };

/**
 * Match of an item for a parsed query (lib/memberSearch.ts, the one matcher): rank 0 exact name …
 * 4 contact field only (`hint` = that contact), null = no match. Empty query matches everything.
 */
export function matchItem(item: PickerItem, q: ParsedQuery): Match | null {
  return matchHaystack(haystackOf(item.search, item.searchHidden), q);
}

/** Items of a group that match the query, best matches first (stable within a rank). */
export function filterItems<T extends PickerItem>(items: readonly T[], query: string): T[] {
  const q = parseQuery(query);
  if (!q.words.length) return [...items];
  const ranked: Array<{ item: T; rank: number; i: number }> = [];
  items.forEach((item, i) => {
    const m = matchItem(item, q);
    if (!m) return;
    // Found by a contact (email, phone…) only: the row shows it as its secondary line.
    ranked.push({ item: m.hint ? { ...item, matchedBy: m.hint } : item, rank: m.rank, i });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return ranked.map((r) => r.item);
}

/**
 * The flat list the view renders: empty groups dropped, a header before each group with a label
 * — shown only when more than one group has rows (a single group needs no title) unless
 * `alwaysHeaders`. `serverFiltered`: the items are already the server's answer, not filtered again.
 */
export function buildRows<T extends PickerItem>(
  groups: readonly PickerGroup<T>[],
  query: string,
  opts: { alwaysHeaders?: boolean; serverFiltered?: boolean; open?: ReadonlySet<string> } = {},
): PickerRow<T>[] {
  const visible = groups
    .map((g) => ({ g, items: opts.serverFiltered ? [...g.items] : filterItems(g.items, query) }))
    .filter((x) => x.items.length > 0);
  const headers = opts.alwaysHeaders || visible.length > 1;
  const rows: PickerRow<T>[] = [];
  let nav = 0;
  for (const { g, items } of visible) {
    const fold = !!g.collapsible && !query.trim();
    const isOpen = !fold || !!opts.open?.has(g.id);
    if (headers && g.label) rows.push({ kind: 'header', key: `h:${g.id}`, label: g.label, ...(g.collapsible ? { toggle: { id: g.id, open: isOpen } } : {}) });
    if (!isOpen) continue;
    for (const item of items) rows.push({ kind: 'item', key: `${g.id}:${item.id}`, item, nav: item.disabled ? -1 : nav++ });
  }
  return rows;
}

/** Number of choosable rows. */
export function navCount(rows: readonly PickerRow<PickerItem>[]): number {
  let n = 0;
  for (const r of rows) if (r.kind === 'item' && r.nav >= 0) n++;
  return n;
}

/** The row index of the nav-th choosable row, -1 if none. */
export function rowOfNav(rows: readonly PickerRow<PickerItem>[], nav: number): number {
  return rows.findIndex((r) => r.kind === 'item' && r.nav === nav);
}

export type PickerKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | 'PageDown' | 'PageUp';

/** Next active choosable index after a key (clamped, no wrap; -1 stays -1 when nothing is choosable). */
export function moveActive(active: number, count: number, key: PickerKey, page = 8): number {
  if (count <= 0) return -1;
  const cur = Math.min(Math.max(active, 0), count - 1);
  switch (key) {
    case 'ArrowDown':
      return active < 0 ? 0 : Math.min(count - 1, cur + 1);
    case 'ArrowUp':
      return Math.max(0, cur - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'PageDown':
      return Math.min(count - 1, cur + page);
    case 'PageUp':
      return Math.max(0, cur - page);
  }
}
