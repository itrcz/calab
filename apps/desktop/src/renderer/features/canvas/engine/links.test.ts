// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, serialize, toInits } from '../../../lib/canvas/clipboard';
import { isLinkUrl, pastedLink, type ObjectRec } from '../../../lib/canvas/types';
import { panelModelOf } from '../view/selectionModel';
import type { ClipboardItemLike } from './engine';
import { LINK_CLICK_MS, PASTE_FALLBACK_MS } from './input';
import { destroyRigs, rig } from './testRig';

afterEach(() => {
  destroyRigs();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const URL_A = 'https://example.com/board?id=7#top';

describe('links (owner 23.11: a pasted URL, as in Miro)', () => {
  it('only an absolute http(s) URL without spaces is a link', () => {
    expect(isLinkUrl(URL_A)).toBe(true);
    expect(isLinkUrl('http://localhost:3000/x')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'ftp://example.com', 'https://', 'example.com', 'https://a b.com', `https://x.com/${'a'.repeat(2100)}`, 42, null]) {
      expect(isLinkUrl(bad)).toBe(false);
    }
    expect(pastedLink(`  ${URL_A}\n`)).toBe(URL_A);
    expect(pastedLink(`see ${URL_A}`)).toBeNull();
  });

  it('the doc keeps a valid link on a sticky, text or shape, drops a bad one, and a patch removes it', () => {
    const r = rig();
    const [a, b, c] = r.make(
      { init: { kind: 'text', x: 0, y: 0, text: 'a', link: URL_A } },
      { init: { kind: 'sticky', x: 0, y: 0, link: 'javascript:alert(1)' } },
      { init: { kind: 'shape', x: 0, y: 0, link: URL_A } },
    );
    const rec = (id: string | undefined): ObjectRec | undefined => r.engine.scene.get(id ?? '');
    expect(rec(a)).toMatchObject({ link: URL_A });
    expect(rec(b)).not.toHaveProperty('link');
    expect(rec(c)).toMatchObject({ link: URL_A });
    r.engine.doc.patch(a ?? '', { link: 'data:text/html,x' });
    expect(rec(a)).toMatchObject({ link: URL_A }); // a bad value is not written
    r.engine.doc.patch(a ?? '', { link: null });
    expect(rec(a)).not.toHaveProperty('link');
  });

  it('copy and paste carry the link', () => {
    const r = rig();
    const [a] = r.make({ init: { kind: 'sticky', x: 0, y: 0, text: 'docs', link: URL_A } });
    const text = serialize(r.engine.scene, r.engine.doc, [a ?? '']);
    const payload = text ? parse(text) : null;
    expect(payload).not.toBeNull();
    if (!payload) return;
    expect(toInits(payload, 10, 10)[0]?.init).toMatchObject({ kind: 'sticky', link: URL_A });
  });

  it('a pasted URL becomes a linked text; other text stays plain', () => {
    const r = rig();
    const [id] = r.engine.pasteText(`  ${URL_A} `);
    expect(r.engine.scene.get(id ?? '')).toMatchObject({ kind: 'text', text: URL_A, link: URL_A });
    const [plain] = r.engine.pasteText(`read ${URL_A}`);
    expect(r.engine.scene.get(plain ?? '')).not.toHaveProperty('link');
  });

  it('⌘/Ctrl+click on a linked object opens it without selecting; a plain click selects and opens nothing', () => {
    const openLink = vi.fn();
    const r = rig({ openLink });
    const [a] = r.make({ init: { kind: 'sticky', x: 100, y: 100, text: 'x', link: URL_A } });
    r.click(150, 150, { metaKey: true });
    expect(openLink).toHaveBeenCalledWith(URL_A);
    expect(r.engine.selection.size).toBe(0);
    r.click(150, 150, { ctrlKey: true });
    expect(openLink).toHaveBeenCalledTimes(2);
    r.click(150, 150);
    expect(openLink).toHaveBeenCalledTimes(2);
    expect([...r.engine.selection]).toEqual([a]);
    // ⌘+click on an object without a link is the usual ⌘-click (no open).
    r.make({ init: { kind: 'sticky', x: 500, y: 100 } });
    r.click(550, 150, { metaKey: true });
    expect(openLink).toHaveBeenCalledTimes(2);
  });

  it('viewers open links too', () => {
    const openLink = vi.fn();
    const r = rig({ openLink });
    r.make({ init: { kind: 'text', x: 100, y: 100, text: 'site', link: URL_A } });
    r.engine.setReadOnly(true);
    r.click(110, 110, { metaKey: true });
    expect(openLink).toHaveBeenCalledWith(URL_A);
  });

  it('a dropped link (text/uri-list) lands as a linked text where it was dropped', () => {
    const r = rig();
    const id = r.engine.dropLink(`# a comment\r\n${URL_A}\r\nhttps://other.example`, { x: 300, y: 200 });
    expect(r.engine.scene.get(id ?? '')).toMatchObject({ kind: 'text', x: 300, link: URL_A });
    expect(r.engine.dropLink('javascript:alert(1)', { x: 0, y: 0 })).toBeNull();
  });

  it('the panel shows the link of one selected object only', () => {
    const one = { kind: 'text', id: 'a', z: 'a', x: 0, y: 0, w: 10, h: 10, size: 20, color: 'text', text: 'x', link: URL_A } as const;
    expect(panelModelOf([one])?.link).toBe(URL_A);
    expect(panelModelOf([one, { ...one, id: 'b' }])?.link).toBeUndefined();
  });
});

describe('pictures from outside (owner 23.11)', () => {
  const item = (type: string, body = 'x'): ClipboardItemLike => ({ types: [type], getType: () => Promise.resolve(new Blob([body], { type })) });

  it('a copied picture on the clipboard goes to pasteImages, not into a text', async () => {
    const pasteImages = vi.fn();
    const clip = { readText: () => Promise.resolve('ignored'), writeText: () => Promise.resolve(), read: () => Promise.resolve([item('text/html'), item('image/png')]) };
    const r2 = rig({ pasteImages, clipboard: clip });
    expect(await r2.engine.paste()).toEqual([]);
    expect(pasteImages).toHaveBeenCalledTimes(1);
    const [files, at] = pasteImages.mock.calls[0] as [File[], unknown];
    expect(files.map((f) => f.type)).toEqual(['image/png']);
    expect(at).toBeNull();
    expect(r2.engine.doc.count).toBe(0);
  });

  it('without a picture on the clipboard the text is pasted as before', async () => {
    const pasteImages = vi.fn();
    const clip = { text: URL_A, readText: () => Promise.resolve(URL_A), writeText: () => Promise.resolve(), read: () => Promise.resolve([item('text/plain', URL_A)]) };
    const r = rig({ pasteImages, clipboard: clip });
    const ids = await r.engine.paste();
    expect(pasteImages).not.toHaveBeenCalled();
    expect(r.engine.scene.get(ids[0] ?? '')).toMatchObject({ link: URL_A });
  });

  it('a drop keeps only pictures; a drop of no picture says so', () => {
    const pasteImages = vi.fn();
    const onRefused = vi.fn();
    const r = rig({ pasteImages, onRefused });
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    r.engine.dropImages([pdf, png], { x: 5, y: 6 });
    expect(pasteImages).toHaveBeenCalledWith([png], { x: 5, y: 6 });
    r.engine.dropImages([pdf], { x: 0, y: 0 });
    expect(onRefused).toHaveBeenCalledWith('notImage');
    expect(pasteImages).toHaveBeenCalledTimes(1);
  });

  it('read-only takes no pictures', () => {
    const pasteImages = vi.fn();
    const r = rig({ pasteImages, readOnly: true });
    expect(r.engine.acceptsImages).toBe(false);
    r.engine.dropImages([new File(['x'], 'a.png', { type: 'image/png' })], { x: 0, y: 0 });
    expect(pasteImages).not.toHaveBeenCalled();
  });

  it('a picture from outside is placed at its point, its own size up to a cap; a sticker keeps the default size', () => {
    const r = rig();
    const big = r.engine.insertImage('/api/files/0b7c6a52-3f7a-4a7e-9d8e-2f6c1f0e9a11', 2000, 1000, undefined, { x: 1000, y: 500 });
    expect(r.engine.scene.get(big ?? '')).toMatchObject({ x: 760, y: 380, w: 480, h: 240 });
    const small = r.engine.insertImage('/api/files/0b7c6a52-3f7a-4a7e-9d8e-2f6c1f0e9a11', 100, 50, undefined, { x: 0, y: 0 });
    expect(r.engine.scene.get(small ?? '')).toMatchObject({ w: 100, h: 50 });
    const sticker = r.engine.insertImage('/api/files/0b7c6a52-3f7a-4a7e-9d8e-2f6c1f0e9a11', 512, 512, 'st1', { x: 0, y: 0 });
    expect(r.engine.scene.get(sticker ?? '')).toMatchObject({ w: 200, h: 200 });
  });
});

describe('⌘V through the paste event (Electron refuses clipboard-read)', () => {
  const pasteEvent = (files: File[], text: string): Event => {
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { files, getData: (t: string) => (t === 'text/plain' ? text : '') } });
    return e;
  };
  const macrotask = (): Promise<void> => new Promise((done) => setTimeout(done, PASTE_FALLBACK_MS + 20));

  it('the event brings text or pictures; the async read is not used then', async () => {
    const pasteImages = vi.fn();
    const r = rig({ pasteImages });
    const readText = vi.spyOn(r.clip, 'readText');
    r.key('v', { metaKey: true });
    const e = pasteEvent([], URL_A);
    r.canvas.dispatchEvent(e);
    await macrotask();
    expect(e.defaultPrevented).toBe(true);
    expect(readText).not.toHaveBeenCalled();
    expect(r.engine.doc.count).toBe(1); // pasted once
    expect(r.engine.scene.all()[0]).toMatchObject({ link: URL_A });
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    r.canvas.dispatchEvent(pasteEvent([png], 'image.png'));
    expect(pasteImages).toHaveBeenCalledWith([png], null);
    expect(r.engine.doc.count).toBe(1);
  });

  it('Electron order: the event before the keydown, or a while after it — the clipboard is not read again', async () => {
    const r = rig();
    const readText = vi.spyOn(r.clip, 'readText');
    // The menu's paste first, then the keydown.
    r.canvas.dispatchEvent(pasteEvent([], 'first'));
    r.key('v', { metaKey: true });
    await macrotask();
    // The keydown first, the event 100 ms later.
    r.key('v', { metaKey: true });
    await new Promise((done) => setTimeout(done, 100));
    r.canvas.dispatchEvent(pasteEvent([], 'second'));
    await macrotask();
    expect(readText).not.toHaveBeenCalled();
    expect(r.engine.scene.all().map((o) => (o.kind === 'text' ? o.text : ''))).toEqual(['first', 'second']);
  });

  it('without a paste event ⌘V still reads the clipboard', async () => {
    const r = rig();
    r.clip.text = 'words';
    r.key('v', { metaKey: true });
    await macrotask();
    await Promise.resolve();
    expect(r.engine.scene.all()[0]).toMatchObject({ kind: 'text', text: 'words' });
  });

  it('viewers paste nothing', () => {
    const r = rig({ readOnly: true });
    r.canvas.dispatchEvent(pasteEvent([], 'hello'));
    expect(r.engine.doc.count).toBe(0);
  });
});

describe('a click on the selected linked object opens it (owner 23.11, as in Miro)', () => {
  const later = (): Promise<void> => new Promise((done) => setTimeout(done, LINK_CLICK_MS + 30));
  const dbl = (r: ReturnType<typeof rig>, x: number, y: number): void => {
    r.click(x, y);
    r.click(x, y);
    r.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  };

  it('the first click selects, a clean click on the selected one opens after the double-click interval', async () => {
    const openLink = vi.fn();
    const r = rig({ openLink });
    const [a] = r.make({ init: { kind: 'sticky', x: 100, y: 100, text: 'site', link: URL_A } });
    r.click(150, 150);
    await later();
    expect([...r.engine.selection]).toEqual([a]);
    expect(openLink).not.toHaveBeenCalled();
    r.click(150, 150);
    expect(openLink).not.toHaveBeenCalled(); // not yet: it may become a double click
    await later();
    expect(openLink).toHaveBeenCalledWith(URL_A);
  });

  it('a double click on the selected one edits the text and opens nothing', async () => {
    const openLink = vi.fn();
    const r = rig({ openLink });
    r.make({ init: { kind: 'sticky', x: 100, y: 100, text: 'site', link: URL_A } });
    r.click(150, 150);
    await later();
    dbl(r, 150, 150);
    await later();
    expect(openLink).not.toHaveBeenCalled();
    expect(r.engine.getState().editing).toBe(true);
  });

  it('dragging the selected one moves it and opens nothing; an object without a link opens nothing', async () => {
    const openLink = vi.fn();
    const r = rig({ openLink });
    const [a] = r.make({ init: { kind: 'sticky', x: 100, y: 100, text: 'site', link: URL_A } }, { init: { kind: 'sticky', x: 500, y: 100 } });
    r.click(150, 150);
    r.drag([150, 150], [250, 200]);
    await later();
    expect(openLink).not.toHaveBeenCalled();
    expect(r.engine.scene.get(a ?? '')).toMatchObject({ x: 200, y: 150 });
    r.click(550, 150);
    r.click(550, 150);
    await later();
    expect(openLink).not.toHaveBeenCalled();
  });

  it('in a multi-selection or with Shift a click does not open', async () => {
    const openLink = vi.fn();
    const r = rig({ openLink });
    const [a, b] = r.make({ init: { kind: 'sticky', x: 100, y: 100, link: URL_A } }, { init: { kind: 'sticky', x: 500, y: 100 } });
    r.engine.setSelection([a ?? '', b ?? '']);
    r.click(150, 150); // narrows to a, does not open
    await later();
    expect(openLink).not.toHaveBeenCalled();
    r.click(150, 150, { shiftKey: true });
    await later();
    expect(openLink).not.toHaveBeenCalled();
  });

  it('hover: a hand and the address under the selected linked object, or under any with ⌘ held', () => {
    const r = rig();
    const [a] = r.make({ init: { kind: 'sticky', x: 100, y: 100, link: URL_A } });
    r.move(150, 150);
    expect(r.canvas.style.cursor).not.toBe('pointer');
    expect(r.engine['overlay'].link ?? null).toBeNull();
    r.move(152, 150, { metaKey: true });
    expect(r.canvas.style.cursor).toBe('pointer');
    expect(r.engine['overlay'].link).toMatchObject({ at: { x: 100, y: 260 }, text: URL_A });
    r.engine.setSelection([a ?? '']);
    r.move(155, 150);
    expect(r.canvas.style.cursor).toBe('pointer');
    r.move(900, 700);
    expect(r.engine['overlay'].link ?? null).toBeNull();
  });
});

