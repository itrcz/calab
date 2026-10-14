import * as Y from 'yjs';
import type { SnapshotMeta } from './frames';

/** The Y.XmlFragment the editor binds to (Tiptap Collaboration's default `field`). */
export const WIKI_FIELD = 'default';
/** Optional page title kept in the doc (Y.Text); the page header may own it instead. */
export const WIKI_TITLE_FIELD = 'title';
export const PREVIEW_MAX = 200;

/** Blocks whose children are inline content (text, mentions, hard breaks). */
const TEXTBLOCKS = new Set(['paragraph', 'heading', 'codeBlock']);

function inline(el: Y.XmlElement): string {
  let s = '';
  for (const c of el.toArray()) {
    if (c instanceof Y.XmlText) {
      for (const d of c.toDelta() as Array<{ insert?: unknown }>) if (typeof d.insert === 'string') s += d.insert;
    } else if (c instanceof Y.XmlElement) {
      if (c.nodeName === 'mention') s += `@${c.getAttribute('label') ?? ''}`;
      else if (c.nodeName === 'hardBreak') s += '\n';
    }
  }
  return s;
}

function block(node: Y.XmlFragment | Y.XmlElement): string {
  if (node instanceof Y.XmlElement && TEXTBLOCKS.has(node.nodeName)) return inline(node);
  const parts: string[] = [];
  for (const c of node.toArray()) {
    if (c instanceof Y.XmlElement) {
      const s = block(c);
      if (s) parts.push(s);
    }
  }
  return parts.join('\n');
}

/** Plain text of a wiki doc: one line per text block, mentions as `@label` (search, versions). */
export function docPlainText(doc: Y.Doc, field = WIKI_FIELD): string {
  return block(doc.getXmlFragment(field));
}

/** A one-line preview: whitespace collapsed, ≤ 200 characters. */
export function previewOf(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX - 1)}…` : s;
}

/** SNAPSHOT_POST meta straight from the doc (the editor may override the title). */
export function docMeta(doc: Y.Doc, field = WIKI_FIELD): SnapshotMeta {
  const plain = docPlainText(doc, field);
  // Only read (never create) the title type: a page whose header owns the title has none.
  const title = doc.share.has(WIKI_TITLE_FIELD) ? doc.getText(WIKI_TITLE_FIELD).toJSON() : '';
  return { plain_text: plain, title, preview: previewOf(plain) };
}
