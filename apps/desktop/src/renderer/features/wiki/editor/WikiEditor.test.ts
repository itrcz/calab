// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { fromMarkdown, toMarkdown, type PmNode } from '../../../lib/wiki/markdown';
import { docPlainText } from '../../../lib/wiki/plainText';
import WikiEditor from './WikiEditor';

vi.mock('../../../platform', () => ({ platform: { kind: 'web', apiBase: '', directMedia: false, mediaUrl: () => new Promise<string>(() => undefined), apiFetch: vi.fn() } }));
import type { Editor } from '@tiptap/core';
import { Slice } from '@tiptap/pm/model';
import type { WikiEditorApi, WikiEditorProps } from './types';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout: ProseMirror asks for rects when it scrolls the selection into view.
  const rect = (): DOMRect => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  document.elementFromPoint = () => null;
  Element.prototype.scrollIntoView = () => undefined;
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(doc: Y.Doc, editable: boolean, extra: Partial<WikiEditorProps> = {}): { api: () => WikiEditorApi; el: HTMLElement; editor: () => Editor } {
  host = document.createElement('div');
  document.body.append(host);
  let api: WikiEditorApi | null = null;
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(WikiEditor, {
        doc,
        editable,
        me: { id: 'u1', name: 'Анна' },
        onReady: (a) => {
          api = a;
        },
        ...extra,
      }),
    );
  });
  return {
    api: () => {
      if (!api) throw new Error('editor not ready');
      return api;
    },
    el: host,
    // Tiptap hangs the editor on its DOM node.
    editor: () => (host?.querySelector('.wiki-prose') as (HTMLElement & { editor?: Editor }) | null)?.editor as Editor,
  };
}

function clipboard(text: string, files: File[] = [], html = ''): ClipboardEvent {
  return {
    clipboardData: { files, types: html ? ['text/plain', 'text/html'] : ['text/plain'], getData: (t: string) => (t === 'text/plain' ? text : t === 'text/html' ? html : '') },
    preventDefault: () => undefined,
  } as unknown as ClipboardEvent;
}

function paste(editor: Editor, ev: ClipboardEvent): boolean {
  let handled = false;
  act(() => {
    handled = !!editor.view.someProp('handlePaste', (f) => f(editor.view, ev, Slice.empty));
  });
  return handled;
}

/** A Y.Doc holding the markdown, in the XML shape y-prosemirror writes (marks = text attributes). */
function seeded(md: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getXmlFragment('default').push((fromMarkdown(md).content ?? []).map(toXml));
  return doc;
}

function toXml(n: PmNode): Y.XmlElement | Y.XmlText {
  if (n.type === 'text') return texts([n]);
  const el = new Y.XmlElement(n.type);
  for (const [k, v] of Object.entries(n.attrs ?? {})) el.setAttribute(k, v as string);
  // Consecutive text nodes are one XmlText with formatted runs (as y-prosemirror writes them).
  const kids: Array<Y.XmlElement | Y.XmlText> = [];
  let run: PmNode[] = [];
  for (const c of n.content ?? []) {
    if (c.type === 'text') run.push(c);
    else {
      if (run.length) kids.push(texts(run));
      run = [];
      kids.push(toXml(c));
    }
  }
  if (run.length) kids.push(texts(run));
  el.insert(0, kids);
  return el;
}

function texts(nodes: PmNode[]): Y.XmlText {
  const t = new Y.XmlText();
  t.applyDelta(
    nodes.map((n) => {
      const attrs: Record<string, unknown> = {};
      for (const m of n.marks ?? []) attrs[m.type] = m.attrs ?? {};
      return Object.keys(attrs).length ? { insert: n.text ?? '', attributes: attrs } : { insert: n.text ?? '' };
    }),
  );
  return t;
}

describe('WikiEditor', () => {
  it('renders a Y.Doc and follows remote changes', () => {
    const doc = seeded('# Plan\n\nFirst **bold** line\n\n- one\n- two');
    const { el, api } = mount(doc, true);
    const prose = el.querySelector('.wiki-prose');
    expect(prose?.getAttribute('contenteditable')).toBe('true');
    expect(prose?.querySelector('h1')?.textContent).toBe('Plan');
    expect(prose?.querySelector('strong')?.textContent).toBe('bold');
    expect(prose?.querySelectorAll('li')).toHaveLength(2);
    // A co-author's edit arrives through Yjs.
    act(() => {
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText('from peer')]);
      doc.getXmlFragment('default').push([p]);
    });
    expect(api().getText()).toContain('from peer');
    expect(docPlainText(doc)).toContain('from peer');
    expect(toMarkdown(api().getJSON() as PmNode)).toBe('# Plan\n\nFirst **bold** line\n\n- one\n- two\n\nfrom peer\n');
  });

  it('is read-only with editable=false', () => {
    const doc = seeded('text');
    const { el } = mount(doc, false);
    expect(el.querySelector('.wiki-prose')?.getAttribute('contenteditable')).toBe('false');
    expect(el.querySelector('[role="toolbar"]')).toBeNull();
  });

  it('folds a toggle locally without touching the doc', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    const toggle = toXml({ type: 'toggle', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Summary' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] });
    frag.push([toggle]);
    const { el } = mount(doc, true);
    const node = el.querySelector<HTMLElement>('.wiki-toggle');
    const before = Y.encodeStateAsUpdate(doc);
    expect(node?.dataset['open']).toBe('true');
    act(() => node?.querySelector<HTMLButtonElement>('.wiki-toggle-btn')?.click());
    expect(node?.dataset['open']).toBe('false');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('keeps only file ids for images (no src, no data: URLs)', () => {
    const doc = new Y.Doc();
    doc.getXmlFragment('default').push([toXml({ type: 'image', attrs: { fileId: 'f-1', width: 40, height: 20, alt: 'x' } })]);
    const { api } = mount(doc, true);
    const json = JSON.stringify(api().getJSON());
    expect(json).toContain('"fileId":"f-1"');
    expect(json).not.toContain('data:');
  });

  it('opens the / menu, filters it and turns the line into the picked block', async () => {
    const doc = seeded('');
    const { editor } = mount(doc, true);
    await act(async () => {
      editor().chain().focus('end').insertContent('/заг').run();
      await new Promise((r) => setTimeout(r, 0));
    });
    const rows = [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((r) => r.textContent);
    expect(rows).toEqual(['Заголовок 1#', 'Заголовок 2##', 'Заголовок 3###']);
    act(() => {
      document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')[1]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(editor().getJSON().content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    expect(editor().getText().trim()).toBe(''); // the "/заг" query is gone
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('converts pasted markdown text, leaves HTML pastes to ProseMirror', () => {
    const { editor } = mount(seeded(''), true);
    act(() => {
      editor().commands.focus('end');
    });
    expect(paste(editor(), clipboard('# Title\n\n- [ ] task\n- [x] done'))).toBe(true);
    const content = editor().getJSON().content;
    expect(content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(content.some((n) => n.type === 'taskList')).toBe(true);
    expect(paste(editor(), clipboard('# Title', [], '<h1>Title</h1>'))).toBe(false);
  });

  it('uploads a pasted image behind a local placeholder and stores only the file id', async () => {
    let resolve: (v: { fileId: string; width: number; height: number }) => void = () => undefined;
    const upload = vi.fn(() => new Promise<{ fileId: string; width: number; height: number }>((r) => (resolve = r)));
    const doc = seeded('text');
    const { editor, el } = mount(doc, true, { onUploadImage: upload });
    URL.createObjectURL = () => 'blob:local';
    URL.revokeObjectURL = () => undefined;
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    act(() => {
      editor().commands.focus('end');
    });
    expect(paste(editor(), clipboard('', [file]))).toBe(true);
    expect(upload).toHaveBeenCalledWith(file);
    expect(el.querySelector('.wiki-upload')).not.toBeNull();
    expect(JSON.stringify(editor().getJSON())).not.toContain('image');
    await act(async () => {
      resolve({ fileId: 'file-9', width: 640, height: 480 });
      await Promise.resolve();
    });
    expect(el.querySelector('.wiki-upload')).toBeNull();
    const json = JSON.stringify(editor().getJSON());
    expect(json).toContain('"fileId":"file-9"');
    expect(json).not.toContain('blob:');
    expect(docPlainText(doc)).toBe('text');
  });
});
