import { create } from '@bufbuild/protobuf';
import { FileMetaSchema, type FileMeta } from '@calaba/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A task attachment did nothing on click in the desktop app (owner 15.10): the chip was
// `<a href="/api/files/{id}" target="_blank">` — in the packaged file:// renderer that is
// file:///api/files/{id}, which the window-open guard drops (only http(s) goes to the browser),
// and the API wants a bearer header a link cannot send. Now a click opens a viewer or downloads
// through platform.files.download (ADR-0103).
const download = vi.fn((_a: { fileId: string; name: string }) => Promise.resolve('/Users/x/Downloads/a'));
vi.mock('../platform', () => ({ platform: { kind: 'electron', files: { download: (a: { fileId: string; name: string }) => download(a) }, app: { log: () => undefined } } }));
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });

const { openAttachment } = await import('./files');
const { useUi } = await import('../stores/ui');
const { AttachmentChip } = await import('../features/boards/AttachmentChip');
const { PDF_PREVIEW_MAX, filePreview } = await import('../lib/filePreview');

const file = (id: string, name: string, mime: string, extra: { width?: number; height?: number; thumbnailUrl?: string } = {}): FileMeta =>
  create(FileMetaSchema, { id, name, mime, size: 1000n, url: `/api/files/${id}`, ...extra });
const txt = file('11111111-1111-1111-1111-111111111111', 'log.txt', 'text/plain');
const pdf = file('22222222-2222-2222-2222-222222222222', 'отчёт.pdf', 'application/pdf');
const png = file('33333333-3333-3333-3333-333333333333', 'a.png', 'image/png', { width: 800, height: 600, thumbnailUrl: '/api/files/3/thumbnail' });
const heic = file('44444444-4444-4444-4444-444444444444', 'b.heic', 'image/heic');
const jpg = file('55555555-5555-5555-5555-555555555555', 'c.jpg', 'image/jpeg', { width: 10, height: 10, thumbnailUrl: '/api/files/5/thumbnail' });

beforeEach(() => {
  download.mockClear();
  useUi.setState({ dialog: null, phone: { ...useUi.getState().phone, on: false } });
});

describe('filePreview', () => {
  it('pictures with a server thumbnail, PDFs up to the cap and not on the phone, nothing else', () => {
    expect(filePreview(png, false)).toBe('image');
    expect(filePreview(heic, false)).toBeNull();
    expect(filePreview(pdf, false)).toBe('pdf');
    expect(filePreview({ ...pdf, mime: 'Application/PDF' }, false)).toBe('pdf');
    expect(filePreview(pdf, true)).toBeNull();
    expect(filePreview({ ...pdf, size: BigInt(PDF_PREVIEW_MAX) + 1n }, false)).toBeNull();
    expect(filePreview(txt, false)).toBeNull();
  });
});

describe('openAttachment', () => {
  it('another file: downloaded through the platform (main: ~/Downloads, quarantined)', () => {
    openAttachment(txt, [txt, pdf]);
    expect(download).toHaveBeenCalledWith({ fileId: txt.id, name: 'log.txt' });
    expect(useUi.getState().dialog).toBeNull();
  });

  it('a PDF: the viewer with name and size; on the phone it is downloaded', () => {
    openAttachment(pdf, [txt, pdf]);
    expect(useUi.getState().dialog).toEqual({ kind: 'pdf', file: { id: pdf.id, name: 'отчёт.pdf', size: 1000n } });
    expect(download).not.toHaveBeenCalled();
    useUi.setState({ dialog: null, phone: { ...useUi.getState().phone, on: true } });
    openAttachment(pdf, [pdf]);
    expect(useUi.getState().dialog).toBeNull();
    expect(download).toHaveBeenCalledWith({ fileId: pdf.id, name: 'отчёт.pdf' });
  });

  it("a picture: the Lightbox over the list's previewable pictures, at this one", () => {
    openAttachment(jpg, [png, txt, heic, jpg]);
    const d = useUi.getState().dialog;
    expect(d?.kind).toBe('image');
    if (d?.kind !== 'image') return;
    expect(d.images.map((i) => i.fileId)).toEqual([png.id, jpg.id]);
    expect(d.index).toBe(1);
  });
});

describe('AttachmentChip', () => {
  it('opens the file with a button: no link to /api/files (dead in the file:// renderer)', () => {
    const html = renderToStaticMarkup(createElement(AttachmentChip, { file: pdf, list: [pdf] }));
    expect(html).not.toContain('href');
    expect(html).toMatch(/<button type="button"[^>]*data-testid="task-attachment-open"[^>]*>отчёт\.pdf<\/button>/);
    expect(html).not.toContain('aria-label="Убрать');
  });

  it('has a «Скачать» button next to the name that never opens the file', () => {
    const html = renderToStaticMarkup(createElement(AttachmentChip, { file: pdf, list: [pdf] }));
    expect(html).toMatch(/aria-label="Скачать отчёт\.pdf"[^>]*data-testid="task-attachment-download"/);
  });
});
