import type { PublicWikiPageRef } from '@calaba/protocol';

/** A row of the public page's outline: the page, its depth below the linked page. */
export interface OutlineRow {
  id: string;
  title: string;
  icon: string;
  depth: number;
}

/**
 * The outline of a public branch as a flat list in reading order (the linked page first, then its
 * subpages depth-first; the server sends parents before children, siblings by position). A ref
 * whose parent is not in the branch is dropped (the server never sends one).
 */
export function outlineRows(root: { id: string; title: string; icon: string }, refs: readonly PublicWikiPageRef[]): OutlineRow[] {
  const kids = new Map<string, PublicWikiPageRef[]>();
  for (const r of refs) {
    const list = kids.get(r.parentId);
    if (list) list.push(r);
    else kids.set(r.parentId, [r]);
  }
  const out: OutlineRow[] = [{ id: root.id, title: root.title, icon: root.icon, depth: 0 }];
  const seen = new Set<string>([root.id]);
  const walk = (id: string, depth: number): void => {
    for (const c of kids.get(id) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ id: c.id, title: c.title, icon: c.icon, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(root.id, 1);
  return out;
}
