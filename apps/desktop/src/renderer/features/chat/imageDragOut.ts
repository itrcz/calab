import type { DragEvent, PointerEvent } from 'react';
import { downloadUrlData } from '../../../shared/imageDrag';
import { filePath } from '../../lib/api/endpoints';
import { beginDragOut, endDragOut } from '../../lib/dragOut';
import { platform } from '../../platform';

/**
 * Drag a chat image out of the app into Finder / Explorer / the desktop: the original file
 * (full size, its own name) lands there (docs/01 «Файлы» п. 5).
 *
 * - Electron: a mouse press on the image asks main to fetch the original into its temp folder
 *   (main/dragOut.ts); `dragstart` cancels the HTML drag and, once the file is there and the button
 *   is still down, main starts the OS drag of that file (`webContents.startDrag`).
 * - Web: Chromium's `DownloadURL` drag type with the original's blob: URL from the media cache
 *   (the press warms it; the lightbox shows the same blob). Not loaded yet / other browsers: no drag.
 *
 * The element carries `data-drag-file` / `-name` / `-mime` (dragOutAttrs) and spreads the constant
 * `dragOutHandlers`, so memoized rows get no new props. While the drag runs, our own drop targets
 * ignore it (lib/dragOut.ts): dropping the image back on a chat must not upload it again.
 */

/** Electron always; the web only with a mouse (a touch long-press stays the context menu). */
export const canDragOut: boolean =
  platform.kind === 'electron' || (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

interface DragFile {
  id: string;
  name: string;
  mime: string | undefined;
}

export function dragOutAttrs(f: { id: string; name: string; mime?: string }): Record<string, string | undefined> {
  return { 'data-drag-file': f.id, 'data-drag-name': f.name, 'data-drag-mime': f.mime };
}

function fileOf(el: HTMLElement): DragFile | null {
  const id = el.dataset['dragFile'];
  const name = el.dataset['dragName'];
  return id && name ? { id, name, mime: el.dataset['dragMime'] } : null;
}

/** Electron: the press in progress and its prepared file. */
let press: { fileId: string; ready: Promise<boolean> } | null = null;

function prepare(f: DragFile): Promise<boolean> {
  return platform.files.prepareDrag({ fileId: f.id, name: f.name }).catch(() => false);
}

function onPointerDown(e: PointerEvent<HTMLElement>): void {
  if (e.pointerType !== 'mouse' || e.button !== 0 || !canDragOut) return;
  const f = fileOf(e.currentTarget);
  if (!f) return;
  if (platform.kind === 'electron') press = { fileId: f.id, ready: prepare(f) };
  else void platform.mediaUrl(filePath(f.id)).catch(() => undefined);
}

/** Electron: the OS drag once the file is ready, unless the button was released meanwhile. */
function electronDrag(f: DragFile): void {
  const ready = press?.fileId === f.id ? press.ready : prepare(f);
  press = null;
  let released = false;
  const up = (): void => {
    released = true;
  };
  window.addEventListener('pointerup', up, true);
  window.addEventListener('mouseup', up, true);
  beginDragOut();
  void ready
    .then((ok) => {
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('mouseup', up, true);
      return ok && !released ? platform.files.startDrag(f.id) : false;
    })
    .catch(() => false)
    .finally(() => {
      endDragOut();
      // The cancelled HTML drag never sends dragend: drop zones that saw the dragstart reset now.
      window.dispatchEvent(new Event('dragend'));
    });
}

function onDragStart(e: DragEvent<HTMLElement>): void {
  const f = canDragOut ? fileOf(e.currentTarget) : null;
  if (!f) {
    e.preventDefault();
    return;
  }
  if (platform.kind === 'electron') {
    e.preventDefault();
    electronDrag(f);
    return;
  }
  const url = platform.loadedMediaUrl?.(filePath(f.id));
  const data = url ? downloadUrlData(f.mime, f.name, url) : null;
  if (!data) {
    e.preventDefault();
    return;
  }
  e.dataTransfer.setData('DownloadURL', data);
  e.dataTransfer.effectAllowed = 'copy';
  beginDragOut();
  // dragend normally; a source removed mid-drag may not bubble it — then our own drop or the next
  // press ends the flag.
  const ends = ['dragend', 'drop', 'pointerdown'] as const;
  const end = (): void => {
    for (const t of ends) window.removeEventListener(t, end, true);
    endDragOut();
  };
  for (const t of ends) window.addEventListener(t, end, true);
}

/** Constant handlers (no per-row closures): spread together with `dragOutAttrs(file)`. */
export const dragOutHandlers = { draggable: canDragOut, onPointerDown, onDragStart } as const;
