import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import {
  EmptyWikiTrashResponseSchema,
  ListWikiPagesResponseSchema,
  PublicWikiPageSchema,
  SearchResponseSchema,
  SearchType,
  UploadFileResponseSchema,
  WIKI_BITS,
  WikiActivityKind,
  WikiActivityPageSchema,
  WikiLinkResponseSchema,
  WikiPageResponseSchema,
  WikiPathResponseSchema,
  WikiPermissionsResponseSchema,
  WikiSettingsSchema,
  WikiVersionsResponseSchema,
} from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { decodeStateStream } from '../lib/wiki/frames';
import { docPlainText } from '../lib/wiki/plainText';

/**
 * Responses captured from the real Go server (task W7, tools/wiki-walk.sh + e2e-web/wiki.spec.ts
 * stack): the client's schemas and helpers must read them as they are, without fallbacks.
 */
const files = import.meta.glob('./__fixtures__/wiki/*.json', { eager: true, import: 'default' });
const read = (name: string): JsonValue => files[`./__fixtures__/wiki/${name}.json`] as JsonValue;
const bytes = (name: string): Uint8Array => Uint8Array.from(atob((read(name) as { b64: string }).b64), (c) => c.charCodeAt(0));
const OWNER = WIKI_BITS.VIEW | WIKI_BITS.WRITE | WIKI_BITS.MANAGE;

describe('Wiki wire format of the server', () => {
  it('creates a page with an empty title (the client sends "" and shows «Без названия»)', () => {
    const p = fromJson(WikiPageResponseSchema, read('create-untitled')).page;
    expect(p?.title).toBe('');
    expect(p?.parentId).toBe('');
    expect(p?.myBits).toBe(OWNER);
  });

  it('reads the listings: order, has_children, cursor, the trash', () => {
    const top = fromJson(ListWikiPagesResponseSchema, read('list-top'));
    expect(top.pages.map((p) => p.title)).toEqual(['', 'Hello']);
    expect(top.pages[1]?.hasChildren).toBe(true);
    expect(top.nextCursor).toBe('');
    expect(fromJson(ListWikiPagesResponseSchema, read('list-children')).pages[0]?.parentId).toBe(top.pages[1]?.id);
    const trash = fromJson(ListWikiPagesResponseSchema, read('list-trash')).pages[0];
    expect(trash?.trashedRoot).toBe(true);
    expect(trash?.trashedAt).toBeDefined();
  });

  it('reads the path, a rename+icon, a move and a trash answer', () => {
    expect(fromJson(WikiPathResponseSchema, read('path')).pages.map((p) => p.title)).toEqual(['Hello', 'Kid']);
    const patched = fromJson(WikiPageResponseSchema, read('patch')).page;
    expect([patched?.title, patched?.icon]).toEqual(['Hello wiki', '📚']);
    const moved = fromJson(WikiPageResponseSchema, read('move')).page;
    expect([moved?.parentId, moved?.position]).toEqual(['', 0]);
    expect(fromJson(WikiPageResponseSchema, read('trash')).page?.trashedRoot).toBe(true);
  });

  it('the picture upload answers {file: FileMeta} (a wrapper, not the meta itself)', () => {
    const r = fromJson(UploadFileResponseSchema, read('upload'));
    expect(r.file?.id).toHaveLength(36);
    expect(r.file?.mime).toBe('image/png');
    expect(r.file?.width).toBe(1);
  });

  it('the link answer has the public address /w/{code}', () => {
    const r = fromJson(WikiLinkResponseSchema, read('link'));
    expect(r.link?.code).toHaveLength(43);
    expect(r.link?.includeChildren).toBe(true);
    expect(new URL(r.url).pathname).toBe(`/w/${r.link?.code}`);
  });

  it('reads the public page meta', () => {
    const p = fromJson(PublicWikiPageSchema, read('public'));
    expect(p.title).toBe('Hello wiki');
    expect(p.children).toEqual([]); // include_children, no live subpage left (Kid was moved to the top)
    expect(p.updatedAt).toBeDefined();
    expect(p.rootId).toBe(p.id);
  });

  it('reads the search section of type wiki', () => {
    const s = fromJson(SearchResponseSchema, read('search')).sections[0];
    expect(s?.type).toBe(SearchType.WIKI);
    const hit = s?.items[0];
    expect(hit?.title).toBe('Hello wiki');
    expect(hit?.ref.case).toBe('wiki');
    expect(hit?.ref.case === 'wiki' && hit.ref.value.icon).toBe('📚');
  });

  it('reads the access, the settings, the emptied trash', () => {
    expect(fromJson(WikiPermissionsResponseSchema, read('perms')).restricted).toBe(false);
    expect(fromJson(WikiSettingsSchema, read('settings')).trashDays).toBe(7);
    expect(fromJson(EmptyWikiTrashResponseSchema, read('trash-empty')).deleted).toBe(1);
  });

  it('reads the journal kinds', () => {
    const kinds = fromJson(WikiActivityPageSchema, read('activity')).activities.map((a) => a.kind);
    expect(kinds).toContain(WikiActivityKind.CREATE);
    expect(kinds).toContain(WikiActivityKind.RENAME);
    expect(kinds).toContain(WikiActivityKind.ICON);
    expect(kinds).toContain(WikiActivityKind.COVER);
    expect(kinds).toContain(WikiActivityKind.LINK_ON);
  });

  it('error bodies are {code, message, field}', () => {
    expect(read('not-found')).toMatchObject({ code: 'ERROR_CODE_NOT_FOUND' });
  });

  it('a synced page: the preview and the size come from the last snapshot', () => {
    const p = fromJson(WikiPageResponseSchema, read('page-synced')).page;
    expect(p?.preview).toBe('Привет от Алисы и Борис!?');
    expect(p?.docSize).toBeGreaterThan(0n);
    expect(p?.link?.views).toBeGreaterThanOrEqual(0);
  });

  it('versions: the list, and the state of a version is a Yjs update', () => {
    expect(fromJson(WikiVersionsResponseSchema, read('versions-empty')).versions).toEqual([]);
    const v = fromJson(WikiVersionsResponseSchema, read('versions')).versions[0];
    expect(v?.plainText).toBe('Привет от Алисы и Борис!?');
    expect(v?.authorIds).toHaveLength(2);
    expect(v?.size).toBe(123);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes('version-state'));
    expect(docPlainText(doc)).toContain('Привет от Алисы и Борис');
  });

  it('the public state is records `u32 length | frame`: a snapshot and the updates after it', () => {
    const updates = decodeStateStream(bytes('public-state'));
    expect(updates?.length).toBeGreaterThanOrEqual(1);
    const doc = new Y.Doc();
    for (const u of updates ?? []) Y.applyUpdate(doc, u);
    expect(docPlainText(doc)).toContain('Привет от Алисы и Борис');
    expect(decodeStateStream(Uint8Array.of(0, 0, 0, 9, 0))).toBeNull(); // truncated
  });
});
