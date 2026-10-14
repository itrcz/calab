/**
 * The wiki document schema (ADR-0096 §3) as headless Tiptap extensions: what a page may contain,
 * with no views, commands, suggestions or DOM. The desktop editor (features/wiki/editor) builds
 * on these nodes — it extends them with node views and commands — so the editor, the Markdown
 * bridge and the bot SDK agree on one schema. Runs in Node (getSchema needs no DOM).
 */
import { getSchema, mergeAttributes, Node, type AnyExtension } from '@tiptap/core';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Highlight } from '@tiptap/extension-highlight';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Mention } from '@tiptap/extension-mention';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import type { Schema } from '@tiptap/pm/model';
import { StarterKit } from '@tiptap/starter-kit';
import { str } from './markdown';

/** Only http(s) and mailto links (the doc is shared: no javascript:, file:, custom schemes). */
export const isAllowedHref = (url: string): boolean => /^(https?:\/\/|mailto:)/i.test(url.trim());

const EMOJI_MAX = 16;
export const DEFAULT_CALLOUT_ICON = '💡';

/** Callout: an icon and blocks. */
export const CalloutNode = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      icon: {
        default: DEFAULT_CALLOUT_ICON,
        parseHTML: (el) => (el.getAttribute('data-icon') ?? '').slice(0, EMOJI_MAX) || DEFAULT_CALLOUT_ICON,
        renderHTML: (a) => ({ 'data-icon': str(a['icon'], '') }),
      },
    };
  },
  parseHTML: () => [{ tag: 'div[data-callout]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'wiki-callout' }), 0],
});

/** Toggle: the first paragraph is the summary, the rest folds (folding is never in the doc). */
export const ToggleNode = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'paragraph block*',
  defining: true,
  parseHTML: () => [{ tag: 'div[data-toggle]' }, { tag: 'details' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-toggle': '', class: 'wiki-toggle' }), 0],
});

/** Image: an uploaded file of the page; never a URL or base64 in the doc. */
export const ImageNode = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    const num = (name: string) => ({
      default: null,
      parseHTML: (el: HTMLElement) => {
        const v = Number.parseInt(el.getAttribute(name) ?? '', 10);
        return Number.isFinite(v) && v > 0 ? v : null;
      },
    });
    return {
      fileId: { default: null, parseHTML: (el) => el.getAttribute('data-file-id'), renderHTML: (a) => ({ 'data-file-id': str(a['fileId']) }) },
      width: num('width'),
      height: num('height'),
      alt: { default: '', parseHTML: (el) => (el.getAttribute('alt') ?? '').slice(0, 300) },
    };
  },
  // Only our own images (copied between wiki pages) parse; foreign <img> (URLs, data:) are dropped.
  parseHTML: () => [{ tag: 'img[data-file-id]' }],
  renderHTML: ({ HTMLAttributes }) => ['img', mergeAttributes(HTMLAttributes, { class: 'wiki-image' })],
});

export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'red', 'purple'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

/** Highlight colours are names (themed by CSS), never raw CSS from the doc. */
export const HighlightMark = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: 'yellow',
        parseHTML: (el) => {
          const c = el.getAttribute('data-color');
          return (HIGHLIGHT_COLORS as readonly string[]).includes(c ?? '') ? c : 'yellow';
        },
        renderHTML: (a) => ({ 'data-color': str(a['color'], 'yellow') }),
      },
    };
  },
}).configure({ multicolor: true });

/** StarterKit as the wiki configures it (the editor adds its own code block, undo comes from Yjs). */
export const wikiStarterKit = (): AnyExtension =>
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    codeBlock: false,
    undoRedo: false, // Yjs undo (Collaboration) instead: only my own changes are undone
    underline: false,
    link: {
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: 'https',
      // Scheme-less («example.com») gets https:// (defaultProtocol); any other scheme is refused.
      isAllowedUri: (url, ctx) => ctx.defaultValidate(url) && (isAllowedHref(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url.trim())),
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank', class: 'wiki-link' },
    },
  });

/**
 * The schema's extensions without any view: the same node and mark set as the editor
 * (buildExtensions in the desktop), in the same order.
 */
export function wikiDocExtensions(): AnyExtension[] {
  return [
    wikiStarterKit(),
    CodeBlock.configure({ defaultLanguage: null }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false, HTMLAttributes: { class: 'wiki-table' } }),
    TableRow,
    TableHeader,
    TableCell,
    HighlightMark,
    ImageNode,
    CalloutNode,
    ToggleNode,
    Mention,
  ];
}

let cached: Schema | null = null;

/** The ProseMirror schema of a wiki page (built once). */
export function wikiSchema(): Schema {
  cached ??= getSchema(wikiDocExtensions());
  return cached;
}
