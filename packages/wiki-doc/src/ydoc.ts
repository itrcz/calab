/**
 * A wiki page's Yjs document ↔ ProseMirror JSON ↔ Markdown, headless (Node and browser). The doc
 * holds the page in the XmlFragment the editor binds to (WIKI_FIELD, Tiptap Collaboration's
 * `field`); the conversion goes through @tiptap/y-tiptap, the same binding the editor uses, so a
 * page written here opens in the editor exactly as written there.
 */
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { Node as PmModelNode } from '@tiptap/pm/model';
import type * as Y from 'yjs';
import { fromMarkdown, toMarkdown, type FromMarkdownOptions, type PmNode, type ToMarkdownOptions } from './markdown';
import { WIKI_FIELD } from './plainText';
import { wikiSchema } from './schema';

/** The page's content as ProseMirror JSON (a `doc` node). */
export function docToJSON(doc: Y.Doc, field = WIKI_FIELD): PmNode {
  return yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(field), wikiSchema()).toJSON() as PmNode;
}

/** The page as Markdown (no title line). */
export function docToMarkdown(doc: Y.Doc, opts: ToMarkdownOptions = {}, field = WIKI_FIELD): string {
  return toMarkdown(docToJSON(doc, field), opts);
}

/**
 * Makes the fragment equal to `json` (a `doc` node of the wiki schema) by a diff (the binding's
 * updateYFragment): unchanged blocks keep their Yjs items, so concurrent edits merge. Throws on
 * content the schema does not allow.
 */
export function setDocJSON(doc: Y.Doc, json: PmNode, field = WIKI_FIELD): void {
  const node = PmModelNode.fromJSON(wikiSchema(), json);
  node.check();
  doc.transact(() => {
    prosemirrorToYXmlFragment(node, doc.getXmlFragment(field));
  });
}

/** Replaces the page's content with Markdown. */
export function setDocMarkdown(doc: Y.Doc, md: string, opts: FromMarkdownOptions = {}, field = WIKI_FIELD): void {
  setDocJSON(doc, fromMarkdown(md, opts), field);
}

/** Appends Markdown blocks after the page's content (an empty page is replaced). */
export function appendDocMarkdown(doc: Y.Doc, md: string, opts: FromMarkdownOptions = {}, field = WIKI_FIELD): void {
  const cur = docToJSON(doc, field);
  const added = fromMarkdown(md, opts).content ?? [];
  const blocks = (cur.content ?? []).filter((b, i, all) => !(all.length === 1 && i === 0 && isEmptyParagraph(b)));
  setDocJSON(doc, { type: 'doc', content: [...blocks, ...added] }, field);
}

const isEmptyParagraph = (n: PmNode): boolean => n.type === 'paragraph' && !(n.content?.length ?? 0);
