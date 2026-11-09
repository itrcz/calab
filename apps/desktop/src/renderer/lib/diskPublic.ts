import { create } from '@bufbuild/protobuf';
import { FileMetaSchema, type FileMeta, type PublicDiskEntry, type PublicDiskFile } from '@calaba/protocol';
import { previewKind } from './diskPreview';

/**
 * The public Disk link page (ADR-0165): pure helpers, unit-tested in Node. A file of the page is
 * either the linked file itself (`id` = '') or a file inside the linked folder.
 */
export interface PublicFile {
  /** '' = the linked file of a file link. */
  id: string;
  name: string;
  mime: string;
  size: bigint;
  width: number;
  height: number;
  hasThumbnail: boolean;
  office: boolean;
}

export const fromEntry = (e: PublicDiskEntry): PublicFile => ({
  id: e.id, name: e.name, mime: e.mime, size: e.size, width: e.width, height: e.height, hasThumbnail: e.hasThumbnail, office: e.office,
});

export const fromLinkedFile = (f: PublicDiskFile): PublicFile => ({
  id: '', name: f.name, mime: f.mime, size: f.size, width: f.width, height: f.height, hasThumbnail: f.hasThumbnail, office: f.office,
});

/** A FileMeta of the file for the app's shared helpers (type icon, viewer choice). */
export const metaOf = (f: PublicFile): FileMeta =>
  create(FileMetaSchema, { id: f.id, name: f.name, mime: f.mime, size: f.size, width: f.width, height: f.height, thumbnailUrl: f.hasThumbnail ? 'thumbnail' : '' });

export type PublicView = 'image' | 'video' | 'office' | 'pdf' | 'audio' | 'text' | 'card';

/**
 * What a file opens in, in the order of the app's `openItem`: images and video in their viewers,
 * office documents in the read-only office viewer (when the server offers it), PDF (not on the
 * phone), audio, text-like files; anything else is the card with «Скачать».
 */
export function publicView(f: PublicFile, phone: boolean): PublicView {
  const k = previewKind(metaOf(f), phone);
  if (k === 'image' || k === 'video') return k;
  if (f.office) return 'office';
  return k;
}

/** `?folder=<id>` of the page: the open folder below the linked one ('' = the linked folder). */
export function folderParam(search: string): string {
  const v = new URLSearchParams(search).get('folder') ?? '';
  return /^[0-9a-f-]{36}$/i.test(v) ? v : '';
}
