/**
 * The lazy boundary of the wiki editor (ADR-0096 §3): Tiptap, ProseMirror and Yjs bindings load
 * as their own chunk the first time a wiki page (or the public page) renders. Import only from
 * here outside features/wiki/editor; types are free.
 */
import { lazy } from 'react';

export const WikiEditor = lazy(() => import('./WikiEditor'));

/** Warm the chunk (hover over a page in the tree) without rendering it. */
export function preloadWikiEditor(): void {
  void import('./WikiEditor');
}

export type { MentionSource, UploadedImage, WikiEditorApi, WikiEditorProps, WikiEditorUser } from './types';
