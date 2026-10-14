import { lazy } from 'react';

/**
 * The lazy boundary of the wiki page document (ADR-0096 §3, §9): Yjs, the sync provider, Tiptap and
 * ProseMirror load as their own chunk the first time a page opens. Nothing outside the chunk may
 * import lib/wikiSync, lib/wiki/plainText or features/wiki/editor/* at runtime.
 */
export const WikiDocLazy = lazy(() => import('./WikiDoc'));

/** Warm the chunk (the section opened, a tree row hovered) without rendering it. */
export function preloadWikiDoc(): void {
  void import('./WikiDoc');
}
