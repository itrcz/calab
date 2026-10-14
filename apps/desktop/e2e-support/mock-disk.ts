/**
 * Disk in the mock (ADR-0094, proto/calaba/v1/disk.proto): folders and files of a workspace,
 * per-item access (the real TS rule `diskItemPermissions` over the item's chain), public links,
 * the trash, the journal, the trash retention and DiskUsage. The routes and the DISK_ITEM_* fan-out
 * are wired in mock-server.ts (`diskRoutes`); file bytes live in the mock's `files` map.
 *
 * Simplifications against the server: no TrashSweep, no orphan cleanup (deleted files keep their
 * bytes), the public link page is not served, the journal has no 5-minute merging, listings are
 * paged like the server (`limit`, opaque `next_cursor`; the journal is one page), the quota is not reserved (an upload over it answers 413 like files.go).
 */
import { create } from '@bufbuild/protobuf';
import { timestampMs, type Timestamp } from '@bufbuild/protobuf/wkt';
import {
  DISK_BITS,
  DiskActivityKind,
  DiskActivitySchema,
  DiskItemKind,
  DiskItemSchema,
  DiskLinkSchema,
  DiskPermissionEntrySchema,
  DiskUsageSchema,
  ErrorCode,
  PermissionTargetType,
  WorkspaceRole,
  diskItemPermissions,
  diskLevel,
  type DiskActivity,
  type DiskItem,
  type DiskLink,
  type DiskPermissionEntry,
  type DiskUsage,
  type FileMeta,
  type Role,
} from '@calaba/protocol';
import type { JsonObject } from '@bufbuild/protobuf';
import type { MemberRec, MockState } from './fixtures';

export class DiskError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly field = '',
    readonly extra: { reason?: string; used?: bigint; limit?: bigint } = {},
  ) {
    super(message);
  }
}

const notFound = (): DiskError => new DiskError(404, ErrorCode.NOT_FOUND, 'disk item not found');
const forbidden = (what: string): DiskError => new DiskError(403, ErrorCode.FORBIDDEN, what);
const invalid = (field: string, msg: string): DiskError => new DiskError(422, ErrorCode.VALIDATION, msg, field);

export interface DiskDeps {
  state: MockState;
  member: (wsId: string, userId: string) => MemberRec | undefined;
  rolesOf: (m: MemberRec) => Role[];
  membersOf: (wsId: string) => MemberRec[];
  /** The workspace's effective storage limit in bytes (0 = none). */
  quotaOf: (wsId: string) => bigint;
  tick: () => Timestamp;
  nextId: () => string;
  /** DISK_ITEM_UPSERT / DISK_ITEM_REMOVE to the members who see (or saw) the item. */
  emit: (wsId: string, item: DiskItem, removed: boolean, viewers: (userId: string) => boolean) => void;
}

const V = DISK_BITS.VIEW;

export class DiskMock {
  readonly items = new Map<string, DiskItem>();
  readonly perms = new Map<string, DiskPermissionEntry[]>();
  readonly links = new Map<string, DiskLink>();
  readonly activity: DiskActivity[] = [];
  readonly trashDays = new Map<string, number>();
  private linkSeq = 0;

  constructor(private readonly d: DiskDeps) {}

  // ---------------------------------------------------------------- rights

  private chainOf(it: DiskItem): DiskItem[] {
    const out: DiskItem[] = [];
    let cur: DiskItem | undefined = it;
    for (let i = 0; cur && i < 40; i++) {
      out.unshift(cur);
      cur = cur.parentId ? this.items.get(cur.parentId) : undefined;
    }
    return out;
  }

  bitsOf(it: DiskItem | null, wsId: string, uid: string): bigint {
    const m = this.d.member(wsId, uid);
    if (!m) return 0n;
    const roles = this.d.rolesOf(m);
    const guest = m.role === WorkspaceRole.GUEST;
    const chain = it ? this.chainOf(it).map((x) => diskLevel(x, this.perms.get(x.id) ?? [], uid)) : [];
    return diskItemPermissions(roles, chain, { guest });
  }

  private out(it: DiskItem, uid: string): DiskItem {
    const link = this.links.get(it.id);
    return create(DiskItemSchema, { ...it, myBits: this.bitsOf(it, it.workspaceId, uid), shared: (this.perms.get(it.id)?.length ?? 0) > 0, ...(link ? { link } : {}) });
  }

  private visible(id: string, uid: string): DiskItem {
    const it = this.items.get(id);
    if (!it || !(this.bitsOf(it, it.workspaceId, uid) & V)) throw notFound();
    return it;
  }

  private writable(id: string, uid: string): DiskItem {
    const it = this.visible(id, uid);
    const bits = this.bitsOf(it, it.workspaceId, uid);
    if (!(bits & (DISK_BITS.WRITE | DISK_BITS.MANAGE))) throw forbidden('DISK_WRITE required');
    return it;
  }

  private sharer(id: string, uid: string): DiskItem {
    const it = this.visible(id, uid);
    if (it.ownerId !== uid && !(this.bitsOf(it, it.workspaceId, uid) & DISK_BITS.MANAGE)) throw forbidden('the owner or DISK_MANAGE');
    return it;
  }

  private requireWsBit(wsId: string, uid: string, bit: bigint): void {
    const bits = this.bitsOf(null, wsId, uid);
    if (!(bits & bit)) throw bits & V ? forbidden('missing disk permission') : notFound();
  }

  private emit(it: DiskItem, removed = false): void {
    this.d.emit(it.workspaceId, it, removed, (u) => (this.bitsOf(it, it.workspaceId, u) & V) !== 0n);
  }

  private log(it: DiskItem, actor: string, kind: DiskActivityKind, before?: JsonObject, after?: JsonObject): void {
    this.activity.unshift(
      create(DiskActivitySchema, { id: this.d.nextId(), workspaceId: it.workspaceId, itemId: it.id, actorId: actor, kind, itemName: it.name, createdAt: this.d.tick(), ...(before ? { before } : {}), ...(after ? { after } : {}) }),
    );
  }

  // ---------------------------------------------------------------- listing

  private nameTaken(wsId: string, parentId: string, name: string, except = ''): boolean {
    const n = name.toLowerCase();
    for (const it of this.items.values()) if (it.workspaceId === wsId && it.parentId === parentId && !it.trashedAt && it.id !== except && it.name.toLowerCase() === n) return true;
    return false;
  }

  /** «name (2).ext», as Finder. */
  private freeName(wsId: string, parentId: string, name: string): string {
    if (!this.nameTaken(wsId, parentId, name)) return name;
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let i = 2; ; i++) {
      const next = `${stem} (${i})${ext}`;
      if (!this.nameTaken(wsId, parentId, next)) return next;
    }
  }

  /** Page size when the request has no `limit` (the server's PageMax = 200); tests lower it. */
  pageMax = 200;

  list(wsId: string, uid: string, p: { parent: string; trashed: boolean; sort: string; cursor?: string; limit?: number }): { items: DiskItem[]; nextCursor: string } {
    const all = this.sorted(wsId, uid, p);
    const lim = p.limit && p.limit >= 1 && p.limit <= 200 ? p.limit : this.pageMax;
    const from = p.cursor ? Number(Buffer.from(p.cursor, 'base64url').toString('utf8')) : 0;
    if (!Number.isInteger(from) || from < 0) throw invalid('cursor', 'invalid cursor');
    const items = all.slice(from, from + lim);
    return { items, nextCursor: from + lim < all.length ? Buffer.from(String(from + lim)).toString('base64url') : '' };
  }

  private sorted(wsId: string, uid: string, p: { parent: string; trashed: boolean; sort: string }): DiskItem[] {
    if (!this.d.member(wsId, uid)) throw notFound();
    if (p.parent && !p.trashed) this.visible(p.parent, uid);
    const ms = (t?: Timestamp): number => (t ? timestampMs(t) : 0);
    const all = [...this.items.values()].filter((it) => it.workspaceId === wsId && (p.trashed ? !!it.trashedAt && it.trashedRoot : !it.trashedAt && it.parentId === p.parent));
    const shown = all.filter((it) => this.bitsOf(it, wsId, uid) & V).map((it) => this.out(it, uid));
    const folder = (it: DiskItem): number => (it.kind === DiskItemKind.FOLDER ? 0 : 1);
    const size = (it: DiskItem): number => Number(it.file?.size ?? 0n);
    if (p.trashed) return shown.sort((a, b) => ms(b.trashedAt) - ms(a.trashedAt));
    if (p.sort === 'updated') return shown.sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt));
    if (p.sort === 'size') return shown.sort((a, b) => folder(a) - folder(b) || size(b) - size(a) || a.name.localeCompare(b.name));
    return shown.sort((a, b) => folder(a) - folder(b) || a.name.localeCompare(b.name, 'ru', { numeric: true }));
  }

  path(id: string, uid: string): DiskItem[] {
    const it = this.visible(id, uid);
    return this.chainOf(it).map((x) => this.out(x, uid));
  }

  // ---------------------------------------------------------------- changes

  private parentFor(wsId: string, parentId: string, uid: string): void {
    if (!parentId) {
      this.requireWsBit(wsId, uid, DISK_BITS.WRITE | DISK_BITS.MANAGE);
      return;
    }
    const p = this.writable(parentId, uid);
    if (p.workspaceId !== wsId || p.kind !== DiskItemKind.FOLDER || p.trashedAt) throw notFound();
  }

  /** Inserts a fixture or a new item (no rights, no events). */
  put(init: {
    id?: string;
    workspaceId: string;
    parentId?: string;
    kind: DiskItemKind;
    name: string;
    ownerId?: string;
    restricted?: boolean;
    file?: FileMeta;
    createdAt?: Timestamp;
    updatedAt?: Timestamp;
    trashedAt?: Timestamp;
    trashedBy?: string;
    trashedRoot?: boolean;
  }): DiskItem {
    const at = init.createdAt ?? this.d.tick();
    const it = create(DiskItemSchema, { id: init.id ?? this.d.nextId(), parentId: '', ownerId: '', ...init, createdAt: at, updatedAt: init.updatedAt ?? at });
    this.items.set(it.id, it);
    return it;
  }

  createFolder(wsId: string, uid: string, parentId: string, name: string): DiskItem {
    const n = name.trim();
    if (!n || n.length > 255) throw invalid('name', 'name: 1..255 characters');
    this.parentFor(wsId, parentId, uid);
    const it = this.put({ workspaceId: wsId, parentId, kind: DiskItemKind.FOLDER, name: this.freeName(wsId, parentId, n), ownerId: uid });
    this.log(it, uid, DiskActivityKind.CREATE, undefined, { name: it.name });
    this.emit(it);
    return this.out(it, uid);
  }

  upload(wsId: string, uid: string, parentId: string, file: FileMeta): DiskItem {
    this.parentFor(wsId, parentId, uid);
    const used = this.d.state.workspaces.get(wsId)?.storageUsedBytes ?? 0n;
    const quota = this.d.quotaOf(wsId);
    if (quota > 0n && used + file.size > quota) throw new DiskError(413, ErrorCode.FILE_QUOTA_EXCEEDED, 'storage quota exceeded', '', { reason: 'PLAN_LIMIT', used, limit: quota });
    const ws = this.d.state.workspaces.get(wsId);
    if (ws) ws.storageUsedBytes += file.size;
    const it = this.put({ workspaceId: wsId, parentId, kind: DiskItemKind.FILE, name: this.freeName(wsId, parentId, file.name), ownerId: uid, file });
    this.log(it, uid, DiskActivityKind.UPLOAD, undefined, { name: it.name });
    this.emit(it);
    return this.out(it, uid);
  }

  update(id: string, uid: string, b: { name?: string | undefined; parentId?: string | undefined; restricted?: boolean | undefined }): DiskItem {
    let it = this.writable(id, uid);
    if (it.trashedAt) throw notFound();
    if (b.restricted !== undefined) {
      this.sharer(id, uid);
      it = create(DiskItemSchema, { ...it, restricted: b.restricted });
      this.log(it, uid, DiskActivityKind.SHARE);
    }
    if (b.name !== undefined && b.name.trim() !== it.name) {
      const n = b.name.trim();
      if (!n || n.length > 255) throw invalid('name', 'name: 1..255 characters');
      if (this.nameTaken(it.workspaceId, it.parentId, n, it.id)) throw new DiskError(409, ErrorCode.CONFLICT, 'name taken', 'name');
      this.log(it, uid, DiskActivityKind.RENAME, { name: it.name }, { name: n });
      it = create(DiskItemSchema, { ...it, name: n });
    }
    if (b.parentId !== undefined && b.parentId !== it.parentId) {
      const to = b.parentId;
      this.parentFor(it.workspaceId, to, uid);
      for (let p = to ? this.items.get(to) : undefined; p; p = p.parentId ? this.items.get(p.parentId) : undefined) if (p.id === it.id) throw invalid('parent_id', 'a folder cannot go into itself');
      this.log(it, uid, DiskActivityKind.MOVE, { parent_name: this.items.get(it.parentId)?.name ?? '' }, { parent_name: this.items.get(to)?.name ?? '' });
      it = create(DiskItemSchema, { ...it, parentId: to, name: this.freeName(it.workspaceId, to, it.name) });
    }
    it.updatedAt = this.d.tick();
    this.items.set(id, it);
    this.emit(it);
    return this.out(it, uid);
  }

  private subtree(id: string): DiskItem[] {
    const out: DiskItem[] = [];
    const walk = (pid: string): void => {
      for (const c of this.items.values()) if (c.parentId === pid) {
        out.push(c);
        walk(c.id);
      }
    };
    const root = this.items.get(id);
    if (root) out.push(root);
    walk(id);
    return out;
  }

  trash(id: string, uid: string): DiskItem {
    const it = this.writable(id, uid);
    if (it.trashedAt) return this.out(it, uid);
    const at = this.d.tick();
    for (const x of this.subtree(id)) this.items.set(x.id, create(DiskItemSchema, { ...x, trashedAt: at, trashedBy: uid, trashedRoot: x.id === id }));
    const after = this.items.get(id) ?? it;
    this.log(after, uid, DiskActivityKind.TRASH);
    this.emit(after);
    return this.out(after, uid);
  }

  restore(id: string, uid: string): DiskItem {
    const it = this.writable(id, uid);
    if (!it.trashedAt) return this.out(it, uid);
    const parent = it.parentId ? this.items.get(it.parentId) : undefined;
    const parentId = parent && !parent.trashedAt ? it.parentId : '';
    for (const x of this.subtree(id)) {
      const { trashedAt: _t, ...rest } = x;
      this.items.set(x.id, create(DiskItemSchema, { ...rest, trashedBy: '', trashedRoot: false, ...(x.id === id ? { parentId, name: this.freeName(x.workspaceId, parentId, x.name) } : {}) }));
    }
    const after = this.items.get(id) ?? it;
    this.log(after, uid, DiskActivityKind.RESTORE);
    this.emit(after);
    return this.out(after, uid);
  }

  /** Deletes forever; the quota is released at once (ADR-0094 §4). Returns the freed bytes. */
  remove(id: string, uid: string): bigint {
    const it = this.writable(id, uid);
    let freed = 0n;
    for (const x of this.subtree(id)) {
      freed += x.file?.size ?? 0n;
      this.items.delete(x.id);
      this.links.delete(x.id);
      this.perms.delete(x.id);
    }
    const ws = this.d.state.workspaces.get(it.workspaceId);
    if (ws) ws.storageUsedBytes = ws.storageUsedBytes > freed ? ws.storageUsedBytes - freed : 0n;
    this.log(it, uid, DiskActivityKind.DELETE);
    this.d.emit(it.workspaceId, it, true, (u) => !!this.d.member(it.workspaceId, u));
    return freed;
  }

  emptyTrash(wsId: string, uid: string): { deleted: number; freed: bigint } {
    let deleted = 0;
    let freed = 0n;
    for (const it of [...this.items.values()]) {
      if (it.workspaceId !== wsId || !it.trashedRoot || !it.trashedAt) continue;
      const bits = this.bitsOf(it, wsId, uid);
      if (!(bits & DISK_BITS.MANAGE) && it.ownerId !== uid) continue;
      freed += this.remove(it.id, uid);
      deleted++;
    }
    return { deleted, freed };
  }

  // ---------------------------------------------------------------- access and links

  permissions(id: string, uid: string): { entries: DiskPermissionEntry[]; restricted: boolean } {
    const it = this.sharer(id, uid);
    return { entries: this.perms.get(id) ?? [], restricted: it.restricted };
  }

  setPermissions(id: string, uid: string, entries: readonly DiskPermissionEntry[], restricted?: boolean): void {
    const it = this.sharer(id, uid);
    const mask = DISK_BITS.VIEW | DISK_BITS.WRITE;
    const clean = entries
      .filter((e) => e.targetType === PermissionTargetType.ROLE || e.targetType === PermissionTargetType.USER)
      .map((e) => create(DiskPermissionEntrySchema, { targetType: e.targetType, targetId: e.targetId, allow: e.allow & mask, deny: e.deny & mask }));
    if (clean.length) this.perms.set(id, clean);
    else this.perms.delete(id);
    const next = restricted === undefined ? it : create(DiskItemSchema, { ...it, restricted });
    this.items.set(id, next);
    this.log(next, uid, DiskActivityKind.SHARE);
    this.emit(next);
  }

  createLink(id: string, uid: string, expiresAt?: Timestamp): { link: DiskLink; url: string } {
    const it = this.sharer(id, uid);
    if (it.kind !== DiskItemKind.FILE) throw invalid('item', 'links are for files only');
    let link = this.links.get(id);
    if (!link) {
      const code = `mockLink${String(++this.linkSeq).padStart(4, '0')}`.padEnd(43, 'x');
      link = create(DiskLinkSchema, { code, itemId: id, createdBy: uid, createdAt: this.d.tick(), ...(expiresAt ? { expiresAt } : {}) });
      this.links.set(id, link);
      this.log(it, uid, DiskActivityKind.LINK_ON);
      this.emit(it);
    }
    return { link, url: `https://calab.test/d/${link.code}` };
  }

  deleteLink(id: string, uid: string): void {
    const it = this.sharer(id, uid);
    if (!this.links.delete(id)) return;
    this.log(it, uid, DiskActivityKind.LINK_OFF);
    this.emit(it);
  }

  // ---------------------------------------------------------------- journal, usage, settings

  itemActivity(id: string, uid: string): DiskActivity[] {
    this.visible(id, uid);
    return this.activity.filter((a) => a.itemId === id);
  }

  wsActivity(wsId: string, uid: string): DiskActivity[] {
    this.requireWsBit(wsId, uid, DISK_BITS.MANAGE);
    return this.activity.filter((a) => a.workspaceId === wsId);
  }

  usage(wsId: string, uid: string): DiskUsage {
    this.requireWsBit(wsId, uid, V);
    let disk = 0n;
    let trash = 0n;
    for (const it of this.items.values()) {
      if (it.workspaceId !== wsId) continue;
      const size = it.file?.size ?? 0n;
      disk += size;
      if (it.trashedAt) trash += size;
    }
    const used = this.d.state.workspaces.get(wsId)?.storageUsedBytes ?? 0n;
    const plan = this.d.quotaOf(wsId);
    return create(DiskUsageSchema, { quotaBytes: plan, planBytes: plan, addonBytes: 0n, usedBytes: used, diskBytes: disk, trashBytes: trash, otherBytes: used > disk ? used - disk : 0n });
  }

  settings(wsId: string, uid: string): number {
    this.requireWsBit(wsId, uid, V);
    return this.trashDays.get(wsId) ?? 0;
  }

  setSettings(wsId: string, uid: string, days: number): void {
    this.requireWsBit(wsId, uid, DISK_BITS.MANAGE);
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw invalid('trash_days', 'trash_days: 0..3650');
    if (days) this.trashDays.set(wsId, days);
    else this.trashDays.delete(wsId);
  }
}
