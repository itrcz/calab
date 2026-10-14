/**
 * Wiki in the mock (ADR-0096, proto/calaba/v1/wiki.proto): the page tree of a workspace with
 * per-page access (the real TS rule `wikiPagePermissions` over the page's chain), public links,
 * the trash, versions, the trash retention — and the sync socket `GET /api/wiki/pages/{id}/sync`
 * speaking lib/wiki/frames.ts: token as the first text frame, SNAPSHOT + stored UPDATEs on connect,
 * UPDATEs get a seq and go to every socket of the page (the sender too), AWARENESS to the others,
 * SNAPSHOT_POST compacts silently (relayed as SNAPSHOT only with `broadcast`).
 * Routes, the WIKI_PAGE_* fan-out and the socket upgrade are wired in mock-server.ts.
 *
 * Shapes are those of the real server (W7: services/wiki.wire.test.ts holds its captured answers):
 * the upload answers {file}; the event page carries the recipient's my_bits but no link / shared.
 *
 * Simplifications against the server: no TrashSweep, no post budget / rate limits, no version
 * thinning (a version per post whose text changed) and the public page serves the same document without a socket (see publicMeta / publicState).
 */
import { create } from '@bufbuild/protobuf';
import { timestampMs, type Timestamp } from '@bufbuild/protobuf/wkt';
import {
  ErrorCode,
  WIKI_BITS,
  PublicWikiPageRefSchema,
  PublicWikiPageSchema,
  WikiLinkSchema,
  WikiPageSchema,
  WikiPermissionEntrySchema,
  WikiVersionSchema,
  WorkspaceRole,
  treeLevel,
  wikiPagePermissions,
  wikiStructureAllowed,
  type FileMeta,
  type PublicWikiPage,
  type Role,
  type WikiLink,
  type WikiPage,
  type WikiPermissionEntry,
  type WikiVersion,
} from '@calaba/protocol';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import { decodeFrame, encodeCompactRequest, encodeSnapshot, encodeUpdate, encodeAwareness, FRAME_AWARENESS, FRAME_SNAPSHOT_POST, FRAME_UPDATE } from '../src/renderer/lib/wiki/frames';
import { fromMarkdown, type PmNode } from '../src/renderer/lib/wiki/markdown';
import type { MemberRec, MockState } from './fixtures';

export class WikiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly field = '',
  ) {
    super(message);
  }
}

const notFound = (): WikiError => new WikiError(404, ErrorCode.NOT_FOUND, 'wiki page not found');
const forbidden = (what: string): WikiError => new WikiError(403, ErrorCode.FORBIDDEN, what);

export interface WikiDeps {
  state: MockState;
  member: (wsId: string, userId: string) => MemberRec | undefined;
  rolesOf: (m: MemberRec) => Role[];
  tick: () => Timestamp;
  nextId: () => string;
  /** `bitsOf(userId)`: the recipient's wiki bits on the page (0 = not delivered); the gateway puts them in my_bits. */
  emit: (wsId: string, page: WikiPage, removed: boolean, bitsOf: (userId: string) => bigint) => void;
}

/** One page's live document: the snapshot, the updates after it, the open sockets. */
interface DocRoom {
  state: Uint8Array;
  throughSeq: number;
  seq: number;
  updates: Array<{ seq: number; update: Uint8Array }>;
  sockets: Set<{ ws: WebSocket; uid: string; write: boolean }>;
}

const V = WIKI_BITS.VIEW;
const EMPTY_STATE = Y.encodeStateAsUpdate(new Y.Doc());

/** ProseMirror JSON → the Y.XmlFragment y-prosemirror binds (elements by node name, text with marks as attributes). */
function fillFragment(parent: Y.XmlFragment | Y.XmlElement, nodes: readonly PmNode[]): void {
  let text: Y.XmlText | null = null;
  for (const n of nodes) {
    if (n.type === 'text') {
      if (!text) {
        text = new Y.XmlText();
        parent.push([text]);
      }
      const attrs: Record<string, unknown> = {};
      for (const m of n.marks ?? []) attrs[m.type] = m.attrs ?? {};
      text.insert(text.length, n.text ?? '', attrs);
      continue;
    }
    text = null;
    const el = new Y.XmlElement(n.type);
    parent.push([el]);
    for (const [k, v] of Object.entries(n.attrs ?? {})) if (v !== null && v !== undefined) el.setAttribute(k, v as string);
    fillFragment(el, n.content ?? []);
  }
}

/** A Yjs state of a page written in Markdown (fixtures). */
export function stateFromMarkdown(md: string): Uint8Array {
  const doc = new Y.Doc();
  fillFragment(doc.getXmlFragment('default'), fromMarkdown(md).content ?? []);
  return Y.encodeStateAsUpdate(doc);
}

export class WikiMock {
  readonly pages = new Map<string, WikiPage>();
  readonly perms = new Map<string, WikiPermissionEntry[]>();
  readonly links = new Map<string, WikiLink>();
  readonly versions = new Map<string, Array<{ v: WikiVersion; state: Uint8Array }>>();
  readonly docs = new Map<string, DocRoom>();
  readonly trashDays = new Map<string, number>();
  private linkSeq = 0;

  constructor(private readonly d: WikiDeps) {}

  // ---------------------------------------------------------------- rights

  private chainOf(p: WikiPage): WikiPage[] {
    const out: WikiPage[] = [];
    let cur: WikiPage | undefined = p;
    for (let i = 0; cur && i < 40; i++) {
      out.unshift(cur);
      cur = cur.parentId ? this.pages.get(cur.parentId) : undefined;
    }
    return out;
  }

  bitsOf(p: WikiPage | null, wsId: string, uid: string): bigint {
    const m = this.d.member(wsId, uid);
    if (!m) return 0n;
    const chain = p ? this.chainOf(p).map((x) => treeLevel(x, this.perms.get(x.id) ?? [], uid)) : [];
    return wikiPagePermissions(this.d.rolesOf(m), chain, { guest: m.role === WorkspaceRole.GUEST });
  }

  private out(p: WikiPage, uid: string): WikiPage {
    const link = this.links.get(p.id);
    const hasChildren = [...this.pages.values()].some((c) => c.parentId === p.id && !c.trashedAt && this.bitsOf(c, c.workspaceId, uid) & V);
    return create(WikiPageSchema, { ...p, myBits: this.bitsOf(p, p.workspaceId, uid), shared: (this.perms.get(p.id)?.length ?? 0) > 0, hasChildren, ...(link ? { link } : {}) });
  }

  private visible(id: string, uid: string): WikiPage {
    const p = this.pages.get(id);
    if (!p || !(this.bitsOf(p, p.workspaceId, uid) & V)) throw notFound();
    return p;
  }

  private writable(id: string, uid: string): WikiPage {
    const p = this.visible(id, uid);
    if (!(this.bitsOf(p, p.workspaceId, uid) & (WIKI_BITS.WRITE | WIKI_BITS.MANAGE))) throw forbidden('WIKI_WRITE required');
    return p;
  }

  private structural(id: string, uid: string): WikiPage {
    const p = this.visible(id, uid);
    if (!wikiStructureAllowed(this.bitsOf(p, p.workspaceId, uid), p.ownerId === uid)) throw forbidden('the owner or WIKI_MANAGE');
    return p;
  }

  private emit(p: WikiPage, removed = false): void {
    this.d.emit(p.workspaceId, p, removed, (u) => this.bitsOf(p, p.workspaceId, u));
  }

  private siblings(wsId: string, parentId: string, except = ''): WikiPage[] {
    return [...this.pages.values()].filter((p) => p.workspaceId === wsId && p.parentId === parentId && !p.trashedAt && p.id !== except).sort((a, b) => a.position - b.position);
  }

  private renumber(wsId: string, parentId: string): void {
    this.siblings(wsId, parentId).forEach((p, i) => {
      if (p.position !== i) this.pages.set(p.id, { ...p, position: i });
    });
  }

  private subtree(id: string): WikiPage[] {
    const out: WikiPage[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop() as string;
      const p = this.pages.get(cur);
      if (p) out.push(p);
      for (const c of this.pages.values()) if (c.parentId === cur) stack.push(c.id);
    }
    return out;
  }

  // ---------------------------------------------------------------- tree

  /** Inserts a fixture (no rights, no events); `md` seeds its document. */
  put(init: Omit<Partial<WikiPage>, '$typeName' | '$unknown'> & { workspaceId: string; title: string; ownerId: string }, md?: string): WikiPage {
    const id = init.id ?? this.d.nextId();
    const position = init.position ?? this.siblings(init.workspaceId, init.parentId ?? '').length;
    const at = init.updatedAt ?? this.d.tick();
    const p = create(WikiPageSchema, { createdAt: at, updatedAt: at, updatedBy: init.ownerId, ...init, id, position });
    this.pages.set(id, p);
    if (md) this.docs.set(id, { state: stateFromMarkdown(md), throughSeq: 0, seq: 0, updates: [], sockets: new Set() });
    return p;
  }

  list(wsId: string, uid: string, p: { parent: string; trashed: boolean }): WikiPage[] {
    if (!this.d.member(wsId, uid)) throw notFound();
    if (p.parent && !p.trashed) this.visible(p.parent, uid);
    const ms = (t?: Timestamp): number => (t ? timestampMs(t) : 0);
    const all = p.trashed
      ? [...this.pages.values()].filter((x) => x.workspaceId === wsId && !!x.trashedAt && x.trashedRoot).sort((a, b) => ms(b.trashedAt) - ms(a.trashedAt))
      : this.siblings(wsId, p.parent);
    return all.filter((x) => this.bitsOf(x, wsId, uid) & V).map((x) => this.out(x, uid));
  }

  /** `GET /api/search?type=wiki&scope=<ws>&q=`: live pages whose title or text (the preview) contain q, that I see. */
  search(wsId: string, uid: string, q: string, limit: number): WikiPage[] {
    if (!this.d.member(wsId, uid)) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return [...this.pages.values()]
      .filter((x) => x.workspaceId === wsId && !x.trashedAt && this.bitsOf(x, wsId, uid) & V && `${x.title}\n${x.preview}`.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((x) => this.out(x, uid));
  }

  get(id: string, uid: string): WikiPage {
    return this.out(this.visible(id, uid), uid);
  }

  path(id: string, uid: string): WikiPage[] {
    return this.chainOf(this.visible(id, uid)).map((x) => this.out(x, uid));
  }

  create(wsId: string, uid: string, b: { parentId: string; title: string; icon: string }): WikiPage {
    if (b.parentId) {
      const parent = this.writable(b.parentId, uid);
      if (parent.workspaceId !== wsId || parent.trashedAt) throw notFound();
    } else if (!(this.bitsOf(null, wsId, uid) & (WIKI_BITS.WRITE | WIKI_BITS.MANAGE))) throw forbidden('WIKI_WRITE required');
    const p = this.put({ workspaceId: wsId, parentId: b.parentId, title: b.title.slice(0, 200), icon: b.icon, ownerId: uid });
    this.emit(p);
    return this.out(p, uid);
  }

  update(id: string, uid: string, b: { title?: string | undefined; icon?: string | undefined; coverFileId?: string | undefined; parentId?: string | undefined; position?: number | undefined; restricted?: boolean | undefined }, cover: (fileId: string) => FileMeta | undefined): WikiPage {
    const p = this.structural(id, uid);
    let next: WikiPage = { ...p, updatedAt: this.d.tick(), updatedBy: uid };
    if (b.title !== undefined) next.title = b.title.trim().slice(0, 200);
    if (b.icon !== undefined) next.icon = b.icon;
    if (b.restricted !== undefined) next.restricted = b.restricted;
    if (b.coverFileId !== undefined) {
      const meta = b.coverFileId ? cover(b.coverFileId) : undefined;
      next = { ...next, cover: meta };
    }
    if (b.parentId !== undefined || b.position !== undefined) {
      const parentId = b.parentId ?? p.parentId;
      if (parentId) {
        const target = this.writable(parentId, uid);
        if (this.chainOf(target).some((x) => x.id === id)) throw new WikiError(422, ErrorCode.VALIDATION, 'a page cannot move into itself', 'parent_id');
      }
      const sib = this.siblings(p.workspaceId, parentId, id);
      const at = Math.max(0, Math.min(sib.length, b.position ?? sib.length));
      sib.splice(at, 0, { ...next, parentId });
      sib.forEach((s, i) => this.pages.set(s.id, s.id === id ? { ...next, parentId, position: i } : { ...s, position: i }));
      if (parentId !== p.parentId) this.renumber(p.workspaceId, p.parentId);
      next = this.pages.get(id) ?? next;
    }
    this.pages.set(id, next);
    this.emit(next);
    return this.out(next, uid);
  }

  trash(id: string, uid: string): WikiPage {
    const p = this.structural(id, uid);
    const at = this.d.tick();
    for (const x of this.subtree(id)) if (!x.trashedAt) this.pages.set(x.id, { ...x, trashedAt: at, trashedBy: uid, trashedRoot: x.id === id });
    this.renumber(p.workspaceId, p.parentId);
    const next = this.pages.get(id) as WikiPage;
    this.emit(next);
    return this.out(next, uid);
  }

  restore(id: string, uid: string): WikiPage {
    const p = this.structural(id, uid);
    if (!p.trashedRoot) throw notFound();
    const parentGone = p.parentId && (!this.pages.get(p.parentId) || this.pages.get(p.parentId)?.trashedAt);
    for (const x of this.subtree(id)) if (x.trashedAt && timestampMs(x.trashedAt) === timestampMs(p.trashedAt as Timestamp)) this.pages.set(x.id, { ...x, trashedAt: undefined, trashedBy: '', trashedRoot: false });
    const cur = this.pages.get(id) as WikiPage;
    const next = { ...cur, parentId: parentGone ? '' : cur.parentId, position: this.siblings(cur.workspaceId, parentGone ? '' : cur.parentId, id).length };
    this.pages.set(id, next);
    this.emit(next);
    return this.out(next, uid);
  }

  remove(id: string, uid: string): void {
    const p = this.structural(id, uid);
    for (const x of this.subtree(id)) {
      this.pages.delete(x.id);
      this.docs.delete(x.id);
    }
    this.emit(p, true);
  }

  emptyTrash(wsId: string, uid: string): number {
    let n = 0;
    for (const p of [...this.pages.values()]) {
      if (p.workspaceId !== wsId || !p.trashedRoot || !this.pages.has(p.id)) continue;
      try {
        this.remove(p.id, uid);
        n++;
      } catch {
        // not mine
      }
    }
    return n;
  }

  permissions(id: string, uid: string): { entries: WikiPermissionEntry[]; restricted: boolean } {
    const p = this.structural(id, uid);
    return { entries: this.perms.get(id) ?? [], restricted: p.restricted };
  }

  setPermissions(id: string, uid: string, entries: readonly WikiPermissionEntry[], restricted?: boolean): void {
    const p = this.structural(id, uid);
    this.perms.set(id, entries.map((e) => create(WikiPermissionEntrySchema, e)));
    const next = { ...p, restricted: restricted ?? p.restricted };
    this.pages.set(id, next);
    this.emit(next);
  }

  createLink(id: string, uid: string, b: { includeChildren: boolean; expiresAt?: Timestamp | undefined }): { link: WikiLink; url: string } {
    const p = this.structural(id, uid);
    const prev = this.links.get(id);
    const code = prev?.code ?? `mockWiki${String(++this.linkSeq).padStart(4, '0')}`.padEnd(43, 'x');
    const link = create(WikiLinkSchema, { code, pageId: id, createdBy: prev?.createdBy ?? uid, createdAt: prev?.createdAt ?? this.d.tick(), views: prev?.views ?? 0, includeChildren: b.includeChildren, ...(b.expiresAt ? { expiresAt: b.expiresAt } : {}) });
    this.links.set(id, link);
    this.emit(p);
    return { link, url: `https://calab.test/w/${code}` };
  }

  /** A fixture link with a fixed code (the public page's visual tests open `/w/{code}`). */
  seedLink(pageId: string, code: string, includeChildren: boolean): void {
    const p = this.pages.get(pageId);
    if (!p) return;
    this.links.set(pageId, create(WikiLinkSchema, { code, pageId, createdBy: p.ownerId, createdAt: p.createdAt, includeChildren, views: 0 }));
  }

  deleteLink(id: string, uid: string): void {
    const p = this.structural(id, uid);
    if (this.links.delete(id)) this.emit(p);
  }

  listVersions(id: string, uid: string): WikiVersion[] {
    this.visible(id, uid);
    return (this.versions.get(id) ?? []).map((x) => x.v);
  }

  versionState(id: string, vid: string, uid: string): Uint8Array {
    this.visible(id, uid);
    const v = this.versions.get(id)?.find((x) => x.v.id === vid);
    if (!v) throw notFound();
    return v.state;
  }

  addVersion(pageId: string, md: string, authorIds: string[], createdAt: Timestamp): void {
    const p = this.pages.get(pageId);
    const state = stateFromMarkdown(md);
    const v = create(WikiVersionSchema, { id: this.d.nextId(), pageId, title: p?.title ?? '', plainText: md.replace(/^#+ |^[-*] (\[.\] )?|^> /gm, ''), authorIds, createdAt, size: state.length });
    this.versions.set(pageId, [{ v, state }, ...(this.versions.get(pageId) ?? [])]);
  }

  settings(wsId: string, uid: string): number {
    if (!(this.bitsOf(null, wsId, uid) & V)) throw notFound();
    return this.trashDays.get(wsId) ?? 0;
  }

  setSettings(wsId: string, uid: string, days: number): void {
    if (!(this.bitsOf(null, wsId, uid) & WIKI_BITS.MANAGE)) throw forbidden('WIKI_MANAGE required');
    this.trashDays.set(wsId, days);
  }

  /** An upload into the page needs WRITE on it. */
  canUpload(id: string, uid: string): void {
    this.writable(id, uid);
  }

  // ---------------------------------------------------------------- public pages (/w/{code})

  /** The live link of a code and its page (not in the trash); 404 otherwise, like the server. */
  private linked(code: string): { link: WikiLink; page: WikiPage } {
    for (const link of this.links.values()) {
      if (link.code !== code) continue;
      if (link.expiresAt && timestampMs(link.expiresAt) < Date.now()) break;
      const page = this.pages.get(link.pageId);
      if (page && !page.trashedAt) return { link, page };
    }
    throw notFound();
  }

  /** The visible branch below a linked page: not restricted, not below a restricted one, parents first. */
  private branch(link: WikiLink): WikiPage[] {
    if (!link.includeChildren) return [];
    const out: WikiPage[] = [];
    const walk = (parent: string): void => {
      for (const c of [...this.pages.values()].filter((p) => p.parentId === parent && !p.trashedAt && !p.restricted).sort((a, b) => a.position - b.position)) {
        out.push(c);
        walk(c.id);
      }
    };
    walk(link.pageId);
    return out;
  }

  private target(code: string, pageId: string): { link: WikiLink; root: WikiPage; page: WikiPage; branch: WikiPage[] } {
    const { link, page: root } = this.linked(code);
    const branch = this.branch(link);
    if (!pageId || pageId === root.id) return { link, root, page: root, branch };
    const page = branch.find((p) => p.id === pageId);
    if (!page) throw notFound();
    return { link, root, page, branch };
  }

  /** GET /api/public/wiki/{code}[?page=] */
  publicMeta(code: string, pageId: string): PublicWikiPage {
    const { link, root, page, branch } = this.target(code, pageId);
    if (!pageId) this.links.set(root.id, { ...link, views: link.views + 1 });
    return create(PublicWikiPageSchema, {
      id: page.id,
      title: page.title,
      icon: page.icon,
      coverFileId: page.cover?.id ?? '',
      updatedAt: page.updatedAt,
      rootId: root.id,
      ...(link.expiresAt ? { expiresAt: link.expiresAt } : {}),
      children: branch.map((c) => create(PublicWikiPageRefSchema, { id: c.id, parentId: c.parentId, title: c.title, icon: c.icon })),
    });
  }

  /** GET /api/public/wiki/{code}/state[?page=]: records of `u32 length | frame` (SNAPSHOT, then the UPDATEs). */
  publicState(code: string, pageId: string): Uint8Array {
    const { page } = this.target(code, pageId);
    const room = this.room(page.id);
    const frames = [encodeSnapshot(room.throughSeq, room.state), ...room.updates.map((u) => encodeUpdate(u.update, u.seq))];
    const out = new Uint8Array(frames.reduce((n, f) => n + 4 + f.length, 0));
    let at = 0;
    for (const f of frames) {
      new DataView(out.buffer).setUint32(at, f.length);
      out.set(f, at + 4);
      at += 4 + f.length;
    }
    return out;
  }

  /** Whether a public visit of `code` may read file `fileId` (the cover or a picture of the branch's pages; the mock allows the cover and any file a branch document names). */
  publicFileAllowed(code: string, fileId: string): boolean {
    const { link, page } = this.linked(code);
    const pages = [page, ...this.branch(link)];
    return pages.some((p) => p.cover?.id === fileId) || pages.some((p) => this.docMentions(p.id, fileId));
  }

  private docMentions(pageId: string, fileId: string): boolean {
    const room = this.docs.get(pageId);
    if (!room) return false;
    const d = new Y.Doc();
    Y.applyUpdate(d, room.state);
    for (const u of room.updates) Y.applyUpdate(d, u.update);
    const found = d.getXmlFragment('default').toJSON().includes(fileId);
    d.destroy();
    return found;
  }

  // ---------------------------------------------------------------- the sync socket

  /** A socket on `/api/wiki/pages/{id}/sync`; `auth` maps the first text frame (the token) to a user. */
  connect(ws: WebSocket, pageId: string, auth: (token: string) => string | null): void {
    let sock: { ws: WebSocket; uid: string; write: boolean } | null = null;
    ws.binaryType = 'nodebuffer';
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!sock) {
        if (isBinary) { ws.close(4004, 'token first'); return; }
        const uid = auth(data.toString('utf8'));
        if (!uid) { ws.close(4004, 'bad token'); return; }
        const p = this.pages.get(pageId);
        if (!p) { ws.close(4404, 'no page'); return; }
        const bits = this.bitsOf(p, p.workspaceId, uid);
        if (!(bits & V)) { ws.close(4003, 'no access'); return; }
        const room = this.room(pageId);
        sock = { ws, uid, write: !p.trashedAt && (bits & (WIKI_BITS.WRITE | WIKI_BITS.MANAGE)) !== 0n };
        room.sockets.add(sock);
        ws.send(encodeSnapshot(room.throughSeq, room.state));
        for (const u of room.updates) ws.send(encodeUpdate(u.update, u.seq));
        return;
      }
      if (!isBinary) return;
      const f = decodeFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      if (!f) return;
      const room = this.room(pageId);
      const me = sock;
      // A write frame from a socket without WIKI_WRITE: the server closes 4003 (sync.go onUpdate / onSnapshot).
      if ((f.type === FRAME_UPDATE || f.type === FRAME_SNAPSHOT_POST) && !me.write) {
        ws.close(4003, 'read only');
      } else if (f.type === FRAME_UPDATE && me.write) {
        const seq = ++room.seq;
        const update = f.update.slice();
        room.updates.push({ seq, update });
        const frame = encodeUpdate(update, seq);
        for (const s of room.sockets) s.ws.send(frame);
      } else if (f.type === FRAME_AWARENESS && me.write) {
        const frame = encodeAwareness(f.update.slice());
        for (const s of room.sockets) if (s !== me) s.ws.send(frame);
      } else if (f.type === FRAME_SNAPSHOT_POST && me.write) {
        if (f.throughSeq < room.throughSeq) {
          ws.send(encodeCompactRequest());
          return;
        }
        room.state = f.state.slice();
        room.throughSeq = f.throughSeq;
        room.updates = room.updates.filter((u) => u.seq > f.throughSeq);
        const p = this.pages.get(pageId);
        if (p) {
          const next = { ...p, preview: f.meta.preview, docSize: room.state.length, updatedAt: this.d.tick(), updatedBy: me.uid };
          this.pages.set(pageId, next);
          this.emit(next);
        }
        if (f.broadcast) {
          const frame = encodeSnapshot(room.throughSeq, room.state);
          for (const s of room.sockets) if (s !== me) s.ws.send(frame);
        }
      }
    });
    ws.on('close', () => {
      if (sock) this.docs.get(pageId)?.sockets.delete(sock);
    });
  }

  private room(pageId: string): DocRoom {
    let r = this.docs.get(pageId);
    if (!r) {
      r = { state: EMPTY_STATE, throughSeq: 0, seq: 0, updates: [], sockets: new Set() };
      this.docs.set(pageId, r);
    }
    return r;
  }

  /** Closes every sync socket (reset / shutdown). */
  closeAll(): void {
    for (const r of this.docs.values()) for (const s of r.sockets) s.ws.terminate();
  }
}
