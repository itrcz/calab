import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { app, nativeImage, net, type NativeImage, type WebContents } from 'electron';
import { safeFileName } from '../shared/fileName';
import { DRAG_MAX_BYTES, isFileId, isImageContentType } from '../shared/imageDrag';
import { API_ORIGIN } from '../shared/ipc';
import { currentServerUrl } from './auth';
import { markFromInternet } from './downloads';
import { appIconImage } from './icons';
import { log } from './logging';

/**
 * Dragging a chat image out of the window into Finder / Explorer (docs/01 «Файлы» п. 5).
 *
 * `webContents.startDrag` needs a local file when the drag begins, so the renderer asks for it
 * ahead (`prepareDragOut` on a mouse press on the image) and starts the OS drag only once it is
 * on disk (`startDragOut`, from its `dragstart`). The file:
 * - is fetched by main through the `calaba-api://` scheme (apiProtocol.ts) — the same proxy,
 *   bearer token and HTTP cache as the <img> in the chat; the URL is built here from a validated
 *   attachment id, the renderer never passes a URL, so no other origin is ever requested;
 * - must answer `image/*` and stay under DRAG_MAX_BYTES (streamed, counted);
 * - is saved under its sanitized original name (shared/fileName.ts) in the app's own temp folder
 *   `<temp>/calab-drag/<pid>/<fileId>/`, marked as downloaded from the Internet (quarantine /
 *   Mark-of-the-Web, like downloads.ts) so the copy the user drops keeps the mark;
 * - is kept for the last MAX_ENTRIES images (a second drag is instant), evicted folders are
 *   deleted, the whole folder goes at quit and folders of dead processes at the next start.
 */

const MAX_ENTRIES = 8;
const ICON_PX = 96;
/** Whole-download deadline (the scheme's idle timeout already ends a stalled body). */
const FETCH_DEADLINE_MS = 5 * 60_000;

interface Ready {
  path: string;
  icon: NativeImage;
}

interface Entry {
  dir: string;
  ready: Promise<Ready | null>;
  done: Ready | null;
}

/** By file id; Map order = LRU order. */
const cache = new Map<string, Entry>();
let rootDir: string | null = null;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** This process's folder; on first use, leftovers of crashed / other finished runs are removed. */
function root(): string {
  if (rootDir) return rootDir;
  const base = join(app.getPath('temp'), 'calab-drag');
  try {
    for (const name of readdirSync(base)) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid === process.pid || !alive(pid)) rmSync(join(base, name), { recursive: true, force: true });
    }
  } catch {
    // no folder yet
  }
  rootDir = join(base, String(process.pid));
  mkdirSync(rootDir, { recursive: true });
  return rootDir;
}

/** At quit: nothing of ours stays in temp. */
export function cleanupDragOut(): void {
  cache.clear();
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  rootDir = null;
}

function evict(): void {
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.entries().next().value;
    if (!oldest) break;
    cache.delete(oldest[0]);
    void rm(oldest[1].dir, { recursive: true, force: true });
  }
}

async function fetchTo(fileId: string, dest: string): Promise<void> {
  const res = await net.fetch(`${API_ORIGIN}/api/files/${fileId}`, { signal: AbortSignal.timeout(FETCH_DEADLINE_MS) });
  if (!res.ok || !res.body) {
    void res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  if (!isImageContentType(res.headers.get('content-type'))) {
    void res.body.cancel();
    throw new Error('not an image');
  }
  if (Number(res.headers.get('content-length') ?? 0) > DRAG_MAX_BYTES) {
    void res.body.cancel();
    throw new Error('too large');
  }
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > DRAG_MAX_BYTES) cb(new Error('too large'));
      else cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>), limit, createWriteStream(dest, { flags: 'wx' }));
}

async function dragIcon(path: string): Promise<NativeImage> {
  try {
    // macOS / Windows: the OS thumbnailer, off the main thread, without decoding the full image.
    const thumb = await nativeImage.createThumbnailFromPath(path, { width: ICON_PX, height: ICON_PX });
    if (!thumb.isEmpty()) return thumb;
  } catch {
    // Linux (no thumbnailer) or a format the OS cannot preview
  }
  if (process.platform === 'linux') {
    const img = nativeImage.createFromPath(path);
    if (!img.isEmpty()) return img.resize({ width: ICON_PX });
  }
  return appIconImage(64); // startDrag refuses an empty icon on macOS
}

async function load(fileId: string, name: string, dir: string): Promise<Ready> {
  await rm(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, safeFileName(name));
  const part = `${path}.part`;
  await fetchTo(fileId, part);
  await rename(part, path);
  await markFromInternet(path, new URL(currentServerUrl()).origin);
  return { path, icon: await dragIcon(path) };
}

/**
 * Makes the original of attachment `fileId` ready for a drag; true once it is on disk.
 * Repeated calls share one download; a file the user already moved out is fetched again.
 */
export function prepareDragOut(fileId: string, name: string): Promise<boolean> {
  if (!isFileId(fileId)) return Promise.reject(new Error('invalid file id'));
  const hit = cache.get(fileId);
  if (hit && (!hit.done || existsSync(hit.done.path))) {
    cache.delete(fileId);
    cache.set(fileId, hit);
    return hit.ready.then((r) => r !== null);
  }
  const dir = join(root(), fileId.toLowerCase());
  const entry: Entry = { dir, done: null, ready: Promise.resolve(null) };
  entry.ready = load(fileId, name, dir).then(
    (r) => {
      entry.done = r;
      return r;
    },
    (e: unknown) => {
      log.warn('[drag-out] could not prepare the file', e);
      if (cache.get(fileId) === entry) cache.delete(fileId);
      void rm(dir, { recursive: true, force: true });
      return null;
    },
  );
  cache.set(fileId, entry);
  evict();
  return entry.ready.then((r) => r !== null);
}

/**
 * Starts the OS drag of a prepared file from `sender` (the window the press began in). False when
 * the file is not ready — the renderer only asks after `prepareDragOut` resolved true. On macOS
 * and Windows `startDrag` returns when the drop is over.
 */
export function startDragOut(sender: WebContents, fileId: string): boolean {
  if (!isFileId(fileId)) throw new Error('invalid file id');
  const done = cache.get(fileId)?.done;
  if (!done || !existsSync(done.path)) return false;
  sender.startDrag({ file: done.path, icon: done.icon });
  return true;
}
