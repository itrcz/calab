/**
 * The open wiki page's document, as the main chunk may call it (ADR-0096 §5, §9): «Экспорт в
 * Markdown» and «Восстановить» a version need the live Y.Doc and the editor, which live in the lazy
 * chunk (features/wiki/WikiDoc.tsx). That component registers a handle here while it is mounted;
 * nothing in this module imports Yjs or Tiptap.
 */
export interface WikiDocHandle {
  pageId: string;
  /** The page as Markdown (the title as a leading `# …`). Null while the editor is not ready. */
  markdown(title: string): string | null;
  /** The live document's plain text (one line per block), as versions store it. */
  text(): string;
  /** Replaces the live document's content with a version's Yjs state, as one transaction. */
  restore(state: Uint8Array): void;
  /** Whether the document may be changed by me (WRITE, not in the trash, synced). */
  writable(): boolean;
}

let current: WikiDocHandle | null = null;

export function setDocHandle(h: WikiDocHandle | null): void {
  current = h;
}

/** The handle of `pageId` when that page's document is mounted. */
export function docHandle(pageId: string): WikiDocHandle | null {
  return current && current.pageId === pageId ? current : null;
}
