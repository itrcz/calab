/**
 * A task description ↔ the rich editor's document (docs/08 «Доски»). The description stays
 * markdown-lite on the server (bots, the phone, search, notifications and AI read it); the editor
 * gets a ProseMirror doc of the wiki schema converted here on entering edit and back on save.
 * Pictures are the task's own `![name](calaba-file:<id>)` lines (inlineImages.ts); wiki page
 * addresses stay plain links (no page links outside the wiki). Pure: unit-tested in
 * descriptionDoc.test.ts.
 */
import { fromMarkdown, toMarkdown, type PmNode } from '@calaba/wiki-doc/markdown';

const FILE_URL_RE = /^calaba-file:([A-Za-z0-9-]{1,64})$/;

export function descriptionToDoc(md: string, mentionLabel?: (id: string) => string): PmNode {
  return fromMarkdown(md, {
    imageFileId: (url) => FILE_URL_RE.exec(url)?.[1] ?? null,
    pageLinks: false,
    emptyParagraphs: true,
    ...(mentionLabel ? { mentionLabel } : {}),
  });
}

export function docToDescription(doc: PmNode): string {
  return toMarkdown(doc, { lite: true, imageUrl: (id) => `calaba-file:${id}` });
}

/** File ids of the pictures in a doc (create dialog: what to attach). */
export function docImageIds(doc: PmNode): string[] {
  const out: string[] = [];
  const walk = (n: PmNode): void => {
    if (n.type === 'image' && typeof n.attrs?.['fileId'] === 'string') out.push(n.attrs['fileId']);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}
