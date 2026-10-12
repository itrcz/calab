/**
 * Synchronization of one account (ADR-0088 §5): one IMAP connection, IDLE on the inbox, other
 * folders polled every 5 min and when opened (stale > 60 s), CONDSTORE flag deltas when offered
 * (else a full UID / flags diff), UIDVALIDITY change = folder rebuild, a 90-day window plus
 * «load older», local-first actions with a pending-ops queue and rollback, reconnect backoff up to
 * 15 min, `auth_failed` on a rejected login. All IMAP work is serialized on the one connection.
 */
import type { MailAccountState, MailError, MailEvent, MailFlagPatch, MailFlags, MailFolder, MailFolderRole, MailThreadRow } from '../../shared/mail';
import { classify, mailError, notFound } from './errors';
import { folderId } from './ids';
import { parseBody } from './mime';
import { flagsFrom, type ImapSession, type RemoteFlags, type RemoteFolder, type RemoteHeader } from './session';
import type { FolderRecord, LocalFlags, MailStore, Scope } from './store';

export const WINDOW_MS = 90 * 24 * 3600_000;
export const POLL_MS = 5 * 60_000;
export const STALE_MS = 60_000;
export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
export const PREFETCH_COUNT = 50;
export const PREFETCH_MAX_SIZE = 512 * 1024;
const INBOX_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------- folder roles

const SPECIAL: Record<string, MailFolderRole> = {
  '\\inbox': 'inbox',
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\trash': 'trash',
  '\\junk': 'junk',
  '\\archive': 'archive',
  '\\flagged': 'starred',
};

const NAMES: Array<[RegExp, MailFolderRole]> = [
  [/^(inbox|входящие)$/i, 'inbox'],
  [/^(sent|sent items|sent messages|sent mail|отправленные|отправленные письма|исходящие)$/i, 'sent'],
  [/^(drafts?|черновики)$/i, 'drafts'],
  [/^(trash|deleted|deleted items|deleted messages|bin|корзина|удаленные|удалённые)$/i, 'trash'],
  [/^(junk|spam|junk e-?mail|bulk mail|спам|нежелательная почта)$/i, 'junk'],
  [/^(archive|archives|архив)$/i, 'archive'],
  [/^(starred|flagged|помеченные|отмеченные)$/i, 'starred'],
];

export function isSelectable(f: RemoteFolder): boolean {
  return !f.flags.some((x) => /^\\(noselect|nonexistent)$/i.test(x));
}

/**
 * Roles for a folder list (§5): SPECIAL-USE first (`\All` = archive only without `\Archive`, Gmail),
 * then names (incl. Russian and `[Gmail]/…`). Each role goes to one folder.
 */
export function assignRoles(folders: RemoteFolder[]): Map<string, MailFolderRole> {
  const out = new Map<string, MailFolderRole>();
  const taken = new Set<MailFolderRole>();
  const give = (path: string, role: MailFolderRole): void => {
    if (taken.has(role) || out.has(path)) return;
    out.set(path, role);
    taken.add(role);
  };
  const usable = folders.filter(isSelectable);
  const inbox = usable.find((f) => f.path.toUpperCase() === 'INBOX');
  if (inbox) give(inbox.path, 'inbox');
  for (const f of usable) {
    const r = f.specialUse ? SPECIAL[f.specialUse.toLowerCase()] : undefined;
    if (r) give(f.path, r);
  }
  for (const f of usable) if (f.specialUse?.toLowerCase() === '\\all') give(f.path, 'archive');
  for (const f of usable) {
    const last = f.name || f.path.split(f.delimiter).pop() || f.path;
    const hit = NAMES.find(([re]) => re.test(last.trim()));
    if (hit) give(f.path, hit[1]);
  }
  return out;
}

// ---------------------------------------------------------------- reconciliation (pure)

/** Messages whose flags differ between the local copy and the server's answer. */
export function diffFlags(local: Map<number, LocalFlags>, remote: RemoteFlags[]): Array<{ uid: number; id: string; threadId: string; flags: MailFlags }> {
  const out: Array<{ uid: number; id: string; threadId: string; flags: MailFlags }> = [];
  for (const r of remote) {
    const l = local.get(r.uid);
    if (!l) continue;
    if (l.seen !== r.flags.seen || l.flagged !== r.flags.flagged || l.answered !== r.flags.answered) out.push({ uid: r.uid, id: l.id, threadId: l.threadId, flags: r.flags });
  }
  return out;
}

/** Local UIDs ≤ maxUid the server no longer has (expunged / moved away elsewhere). */
export function vanished(localUids: Iterable<number>, remote: ReadonlySet<number>, maxUid: number): number[] {
  const out: number[] = [];
  for (const u of localUids) if (u <= maxUid && !remote.has(u)) out.push(u);
  return out;
}

// ---------------------------------------------------------------- the account sync

export interface SyncHost {
  readonly store: MailStore;
  readonly accountId: string;
  /** The account's own address (lower-cased): mail from it is not «new mail». */
  readonly email: string;
  connect(): Promise<ImapSession>;
  emit(event: MailEvent): void;
  /** State / lastSyncAt changed: the engine re-emits `account_state`. */
  stateChanged(): void;
  cacheLimit(): number;
  now(): number;
  log(message: string, meta?: Record<string, unknown>): void;
  /** Timer seam (tests). */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
  /** Gmail files sent mail itself (§6) and archives into All Mail. */
  readonly provider: string;
}

type OpTarget = { kind: 'role'; role: 'archive' | 'trash' } | { kind: 'folder'; row: number };

interface Op {
  folderRow: number;
  uids: number[];
  action: { kind: 'flags'; add: string[]; remove: string[] } | { kind: 'move'; to: OpTarget } | { kind: 'expunge' };
  rollback(): void;
  /** After success (e.g. sync the destination folder). */
  after?(s: ImapSession): Promise<void>;
}

const IMAP_FLAG: Record<keyof MailFlagPatch, string> = { seen: '\\Seen', flagged: '\\Flagged' };

export class AccountSync {
  state: MailAccountState = 'syncing';
  error: MailError | null = null;
  lastSyncAt: number | null;

  private session: ImapSession | null = null;
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();
  private jobs = 0;
  private backoff = BACKOFF_MIN_MS;
  private sleepTimer: unknown = null;
  private wake: (() => void) | null = null;
  private pollTimer: unknown = null;
  private inboxTimer: unknown = null;
  private pendingOps: Op[] = [];
  private readonly queuedFolders = new Set<number>();
  private initialDone = false;

  constructor(private readonly host: SyncHost) {
    const v = host.store.getMeta('lastSyncAt');
    this.lastSyncAt = v ? Number(v) : null;
  }

  private get store(): MailStore {
    return this.host.store;
  }

  private timer(fn: () => void, ms: number): unknown {
    if (this.host.setTimer) return this.host.setTimer(fn, ms);
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  }

  private clear(t: unknown): void {
    if (t === null) return;
    if (this.host.clearTimer) this.host.clearTimer(t);
    else clearTimeout(t as ReturnType<typeof setTimeout>);
  }

  // ------------------------------------------------------------ lifecycle

  start(): void {
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clear(this.pollTimer);
    this.clear(this.inboxTimer);
    this.clear(this.sleepTimer);
    this.wake?.();
    const s = this.session;
    this.session = null;
    if (s) await s.close();
  }

  /** `sync.now`: a full sync now (wakes a sleeping reconnect). */
  syncNow(): void {
    if (this.stopped) return;
    if (!this.session) {
      this.backoff = BACKOFF_MIN_MS;
      this.wake?.();
      return;
    }
    void this.run((s) => this.fullSync(s)).catch((e: unknown) => this.host.log('mail: sync failed', { error: classify(e).code }));
  }

  private setState(state: MailAccountState, error: MailError | null): void {
    const certKey = (e: MailError | null): string => (e?.cert ? `${e.cert.reason}:${e.cert.fingerprint256}` : '');
    if (this.state === state && this.error?.code === error?.code && certKey(this.error) === certKey(error)) return;
    this.state = state;
    this.error = error;
    this.host.stateChanged();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        this.clear(this.sleepTimer);
        this.sleepTimer = null;
        this.wake = null;
        resolve();
      };
      this.wake = done;
      this.sleepTimer = this.timer(done, ms);
    });
  }

  /** Read through a call: `stopped` / `session` change across awaits (no narrowing). */
  private halted(): boolean {
    return this.stopped;
  }

  private connected(): boolean {
    return this.session !== null;
  }

  private async loop(): Promise<void> {
    while (!this.halted()) {
      this.setState('syncing', null);
      let s: ImapSession;
      try {
        s = await this.host.connect();
      } catch (e) {
        const c = classify(e);
        if (this.halted()) return;
        if (c.code === 'AUTH_FAILED') {
          // Stays here until main hands over a new password (a new AccountSync).
          this.setState('auth_failed', c);
          return;
        }
        this.setState(c.code === 'NETWORK' || c.code === 'RATE_LIMITED' ? 'offline' : 'error', c);
        await this.sleep(this.backoff);
        this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
        continue;
      }
      if (this.halted()) {
        await s.close();
        return;
      }
      const closed = new Promise<void>((r) => s.onClose(r));
      this.session = s;
      s.onChange((path) => this.onServerChange(path));
      try {
        await this.flushOps();
        await this.run((x) => this.fullSync(x));
        this.backoff = BACKOFF_MIN_MS;
        this.setState('idle', null);
      } catch (e) {
        const c = classify(e);
        this.host.log('mail: sync error', { code: c.code });
        if (this.connected()) this.setState(c.code === 'NETWORK' ? 'offline' : 'error', c);
      }
      this.schedulePoll();
      await closed;
      this.session = null;
      this.clear(this.pollTimer);
      this.pollTimer = null;
      if (this.halted()) return;
      this.setState('offline', { code: 'NETWORK', message: 'connection closed' });
      await this.sleep(this.backoff);
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    }
  }

  private schedulePoll(): void {
    this.clear(this.pollTimer);
    this.pollTimer = this.timer(() => {
      this.pollTimer = null;
      if (!this.session || this.stopped) return;
      void this.run((s) => this.fullSync(s))
        .then(() => {
          if (this.state !== 'idle') this.setState('idle', null);
        })
        .catch((e: unknown) => this.host.log('mail: poll failed', { code: classify(e).code }))
        .finally(() => this.schedulePoll());
    }, POLL_MS);
  }

  private onServerChange(path: string): void {
    // IDLE / unsolicited updates of the inbox (other folders are only selected during our own jobs).
    const inbox = this.store.folderByRole('inbox');
    if (!inbox || path !== inbox.path || this.inboxTimer !== null) return;
    this.inboxTimer = this.timer(() => {
      this.inboxTimer = null;
      this.queueFolderSync(inbox.row);
    }, INBOX_DEBOUNCE_MS);
  }

  /** Runs a job on the connection, serialized; offline → NETWORK. */
  run<T>(fn: (s: ImapSession) => Promise<T>): Promise<T> {
    this.jobs++;
    const p = this.queue.then(async () => {
      const s = this.session;
      try {
        if (!s) throw mailError('NETWORK', 'the account is offline');
        return await fn(s);
      } finally {
        this.jobs--;
        // Idle again: back to the inbox, where imapflow IDLEs.
        if (this.jobs === 0 && s && this.session === s) {
          const inbox = this.store.folderByRole('inbox');
          if (inbox) await s.rest(inbox.path).catch(() => undefined);
        }
      }
    });
    this.queue = p.catch(() => undefined);
    return p;
  }

  private queueFolderSync(row: number): void {
    if (this.queuedFolders.has(row) || !this.session) return;
    this.queuedFolders.add(row);
    void this.run(async (s) => {
      this.queuedFolders.delete(row);
      const f = this.store.folder(row);
      if (f) await this.syncFolder(s, f);
    }).catch((e: unknown) => {
      this.queuedFolders.delete(row);
      this.host.log('mail: folder sync failed', { code: classify(e).code });
    });
  }

  /** `messages.list` opened a folder: refresh it when stale (> 60 s), without waiting. */
  touchFolder(row: number): void {
    const f = this.store.folder(row);
    if (!f || f.role === 'drafts') return;
    if (f.lastSync === null || this.host.now() - f.lastSync > STALE_MS) this.queueFolderSync(row);
  }

  // ------------------------------------------------------------ full sync

  async fullSync(s: ImapSession): Promise<void> {
    const remote = await s.list();
    const roles = assignRoles(remote);
    const seen = new Set<string>();
    for (const f of remote) {
      if (!isSelectable(f)) continue;
      seen.add(f.path);
      this.store.upsertFolder({ path: f.path, name: f.name || f.path, delimiter: f.delimiter, parentPath: f.parentPath, role: roles.get(f.path) ?? null, specialUse: f.specialUse });
    }
    for (const f of this.store.folders()) {
      if (seen.has(f.path)) continue;
      const removed = this.store.deleteFolder(f.row);
      if (removed.length) this.host.log('mail: folder gone', { count: removed.length });
    }
    this.emitFolders();
    const order: Array<MailFolderRole | null> = ['inbox', 'sent', 'archive', 'starred', 'junk', 'trash', null];
    const folders = this.store
      .folders()
      .filter((f) => f.role !== 'drafts')
      .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
    for (const f of folders) {
      try {
        await this.syncFolder(s, f);
      } catch (e) {
        const c = classify(e);
        if (c.code === 'NETWORK') throw e;
        this.host.log('mail: folder sync failed', { code: c.code, role: f.role });
      }
      if (f.role === 'inbox' && !this.initialDone) await this.prefetch(s, f);
    }
    this.initialDone = true;
    this.lastSyncAt = this.host.now();
    this.store.setMeta('lastSyncAt', String(this.lastSyncAt));
    this.host.stateChanged();
  }

  /** Bodies of the newest inbox messages, so the first open is instant (§3). */
  private async prefetch(s: ImapSession, inbox: FolderRecord): Promise<void> {
    const rows = this.store.db
      .prepare('SELECT id, uid FROM messages WHERE folder_row = ? AND body_hash IS NULL AND size <= ? ORDER BY date DESC LIMIT ?')
      .all(inbox.row, PREFETCH_MAX_SIZE, PREFETCH_COUNT);
    if (!rows.length) return;
    await s.select(inbox.path);
    for (const r of rows) {
      if (this.stopped) return;
      try {
        await this.loadBody(s, String(r['id']), Number(r['uid']));
      } catch (e) {
        if (classify(e).code === 'NETWORK') throw e;
      }
    }
  }

  async syncFolder(s: ImapSession, f0: FolderRecord): Promise<void> {
    const now = this.host.now();
    const info = await s.select(f0.path);
    let f = f0;
    if (f.uidValidity !== null && f.uidValidity !== info.uidValidity) {
      // UIDVALIDITY changed: every local copy is invalid — rebuild the folder.
      this.host.log('mail: uidvalidity changed, rebuilding folder', { role: f.role });
      const before = this.store.localFlags(f.row);
      const threads = new Set([...before.values()].map((x) => x.threadId));
      const ids = this.store.clearFolder(f.row);
      this.store.updateFolderSync(f.row, { uidValidity: null, highestModseq: null, uidNext: null, syncedSince: null, exhausted: false });
      this.emitRemoved(f.row, [...threads], ids);
      f = this.store.folder(f.row) ?? f;
    }
    const first = f.uidValidity === null;
    const since = f.syncedSince ?? now - WINDOW_MS;
    const range = this.store.uidRange(f.row);
    let newUids: number[];
    if (first || !range) {
      newUids = await s.searchDate(new Date(since));
    } else {
      // New = above both what we hold and the UIDNEXT seen last time (older UIDs outside the
      // window were skipped on purpose; «load older» fetches them).
      const top = Math.max(range.max, (f.uidNext ?? 1) - 1);
      newUids = info.uidNext > top + 1 ? (await s.searchUids(`${String(top + 1)}:*`)).filter((u) => u > top) : [];
    }
    const headers = newUids.length ? await s.fetchHeaders(newUids) : [];
    const added = this.insertHeaders(f, info.uidValidity, headers);

    const changedThreads = new Set<string>();
    const changedIds: string[] = [];
    const removedIds: string[] = [];
    const removedThreads = new Set<string>();
    if (range) {
      const local = this.store.localFlags(f.row);
      const remoteUids = new Set(await s.searchUids(`${String(range.min)}:${String(range.max)}`));
      const gone = vanished(local.keys(), remoteUids, range.max);
      for (const u of gone) {
        const l = local.get(u);
        if (l) {
          removedIds.push(l.id);
          removedThreads.add(l.threadId);
        }
      }
      if (removedIds.length) this.store.deleteMessages(removedIds);
      let remoteFlags: RemoteFlags[];
      if (s.condstore && f.highestModseq && info.highestModseq && !first) {
        remoteFlags = f.highestModseq === info.highestModseq ? [] : await s.fetchFlags(`${String(range.min)}:${String(range.max)}`, f.highestModseq);
      } else remoteFlags = await s.fetchFlags(`${String(range.min)}:${String(range.max)}`);
      const diff = diffFlags(local, remoteFlags.filter((r) => remoteUids.has(r.uid)));
      if (diff.length) {
        this.store.tx(() => {
          for (const d of diff) this.store.setFlags(d.id, d.flags);
        });
        for (const d of diff) {
          changedIds.push(d.id);
          changedThreads.add(d.threadId);
        }
      }
    }
    this.store.updateFolderSync(f.row, { uidValidity: info.uidValidity, highestModseq: info.highestModseq, uidNext: info.uidNext, syncedSince: since, lastSync: now });

    if (added.length) {
      this.emitRows('messages_added', f.row, new Set(added.map((a) => a.threadId)), added.map((a) => a.id));
      this.updateStarred(new Set(added.filter((a) => a.header.flags.flagged).map((a) => a.threadId)));
    }
    if (changedIds.length) {
      this.emitRows('messages_changed', f.row, changedThreads, changedIds);
      this.updateStarred(changedThreads);
    }
    if (removedIds.length) {
      this.emitRemoved(f.row, [...removedThreads], removedIds);
      this.updateStarred(removedThreads);
    }
    if (added.length || changedIds.length || removedIds.length) this.emitFolders();

    if (f.role === 'inbox' && !first) {
      for (const a of added) {
        if (a.header.flags.seen || a.header.from.address === this.host.email) continue;
        this.host.emit({ type: 'new_mail', accountId: this.host.accountId, messageId: a.id, threadId: a.threadId, from: a.header.from, subject: a.header.subject });
      }
    }
    this.lastSyncAt = now;
  }

  private insertHeaders(f: FolderRecord, uidValidity: string, headers: RemoteHeader[]): Array<{ id: string; threadId: string; header: RemoteHeader }> {
    if (!headers.length) return [];
    // Oldest first: a parent is stored before its replies, so threading by References works.
    const sorted = [...headers].sort((a, b) => a.date - b.date || a.uid - b.uid);
    return this.store.tx(() => {
      const out: Array<{ id: string; threadId: string; header: RemoteHeader }> = [];
      for (const h of sorted) {
        const r = this.store.insertMessage({ ...h, folderRow: f.row, uidValidity });
        if (r.inserted) out.push({ id: r.id, threadId: r.threadId, header: h });
      }
      return out;
    });
  }

  /** «Загрузить более ранние»: the next 90 days back. */
  async loadOlder(row: number): Promise<{ exhausted: boolean }> {
    const f = this.store.folder(row);
    if (!f) throw notFound('folder');
    if (f.exhausted) return { exhausted: true };
    return this.run(async (s) => {
      const info = await s.select(f.path);
      if (f.uidValidity !== null && f.uidValidity !== info.uidValidity) {
        await this.syncFolder(s, f);
        return { exhausted: false };
      }
      const since = f.syncedSince ?? this.host.now() - WINDOW_MS;
      const from = since - WINDOW_MS;
      const local = this.store.localFlags(f.row);
      const uids = (await s.searchDate(new Date(from), new Date(since))).filter((u) => !local.has(u));
      const added = this.insertHeaders(f, info.uidValidity, uids.length ? await s.fetchHeaders(uids) : []);
      const older = await s.searchDate(undefined, new Date(from));
      const exhausted = older.length === 0;
      this.store.updateFolderSync(f.row, { syncedSince: from, exhausted, uidValidity: info.uidValidity });
      if (added.length) {
        this.emitRows('messages_added', f.row, new Set(added.map((a) => a.threadId)), added.map((a) => a.id));
        this.emitFolders();
      }
      return { exhausted };
    });
  }

  // ------------------------------------------------------------ bodies

  private async loadBody(s: ImapSession, id: string, uid: number): Promise<void> {
    const src = await s.fetchSource(uid);
    if (!src) throw notFound('message');
    const parsed = await parseBody(src);
    this.store.setBody(id, parsed.body, parsed.attachments);
    this.store.evict(this.host.cacheLimit());
  }

  /** Downloads and caches a message body (the folder is selected for it). */
  fetchBody(id: string): Promise<void> {
    const h = this.store.header(id);
    if (!h) return Promise.reject(notFound('message'));
    const f = this.store.folder(h.folderRow);
    if (!f) return Promise.reject(notFound('folder'));
    return this.run(async (s) => {
      if (this.store.header(id)?.bodyHash) return;
      await s.select(f.path);
      await this.loadBody(s, id, h.uid);
    });
  }

  // ------------------------------------------------------------ local-first actions

  private enqueueOp(op: Op): void {
    if (!this.session) {
      this.pendingOps.push(op);
      return;
    }
    void this.run((s) => this.execOp(s, op)).catch((e: unknown) => this.opFailed(op, e));
  }

  private opFailed(op: Op, e: unknown): void {
    // Stopped (account removed / restarted): the store may be closed; the server stays the truth.
    if (this.halted()) return;
    const c = classify(e);
    if (c.code === 'NETWORK') {
      // Not rejected by the server: keep it for the next connection.
      this.pendingOps.push(op);
      return;
    }
    this.host.log('mail: action failed, rolled back', { code: c.code, kind: op.action.kind });
    op.rollback();
  }

  private async flushOps(): Promise<void> {
    const ops = this.pendingOps;
    this.pendingOps = [];
    for (const op of ops) await this.run((s) => this.execOp(s, op)).catch((e: unknown) => this.opFailed(op, e));
  }

  private async targetFolder(s: ImapSession, to: OpTarget): Promise<FolderRecord> {
    if (to.kind === 'folder') {
      const f = this.store.folder(to.row);
      if (!f) throw notFound('folder');
      return f;
    }
    const ex = this.store.folderByRole(to.role);
    if (ex) return ex;
    const path = to.role === 'archive' ? 'Archive' : 'Trash';
    await s.createFolder(path);
    const row = this.store.upsertFolder({ path, name: path, delimiter: '/', parentPath: '', role: to.role, specialUse: null });
    this.emitFolders();
    const f = this.store.folder(row);
    if (!f) throw notFound('folder');
    return f;
  }

  private async execOp(s: ImapSession, op: Op): Promise<void> {
    const f = this.store.folder(op.folderRow);
    if (!f) return;
    await s.select(f.path);
    const a = op.action;
    if (a.kind === 'flags') await s.storeFlags(op.uids, a.add, a.remove);
    else if (a.kind === 'expunge') await s.expunge(op.uids);
    else {
      const dest = await this.targetFolder(s, a.to);
      if (dest.row !== f.row) {
        await s.move(op.uids, dest.path);
        await this.syncFolder(s, dest);
      }
    }
    if (op.after) await op.after(s);
  }

  /** Resolved message rows of this account, grouped by folder. */
  private group(ids: string[]): Map<number, Array<{ id: string; uid: number; threadId: string; flags: MailFlags }>> {
    const by = new Map<number, Array<{ id: string; uid: number; threadId: string; flags: MailFlags }>>();
    for (const id of ids) {
      const h = this.store.header(id);
      if (!h) continue;
      const list = by.get(h.folderRow) ?? [];
      list.push({ id, uid: h.uid, threadId: h.threadId, flags: h.flags });
      by.set(h.folderRow, list);
    }
    return by;
  }

  setFlags(ids: string[], patch: MailFlagPatch): void {
    for (const [row, list] of this.group(ids)) {
      const add: string[] = [];
      const remove: string[] = [];
      for (const k of ['seen', 'flagged'] as const) {
        const v = patch[k];
        if (v === true) add.push(IMAP_FLAG[k]);
        if (v === false) remove.push(IMAP_FLAG[k]);
      }
      const touched = list.filter((m) => (patch.seen !== undefined && m.flags.seen !== patch.seen) || (patch.flagged !== undefined && m.flags.flagged !== patch.flagged));
      if (!touched.length || (!add.length && !remove.length)) continue;
      const apply = (which: 'new' | 'old'): void => {
        this.store.tx(() => {
          for (const m of touched) this.store.setFlags(m.id, which === 'new' ? patch : m.flags);
        });
        const threads = new Set(touched.map((m) => m.threadId));
        this.emitRows('messages_changed', row, threads, touched.map((m) => m.id));
        this.updateStarred(threads);
        this.emitFolders();
      };
      apply('new');
      this.enqueueOp({ folderRow: row, uids: touched.map((m) => m.uid), action: { kind: 'flags', add, remove }, rollback: () => apply('old') });
    }
  }

  /** Removes messages locally at once (move / trash / delete); the server op is queued with a rollback. */
  private removeLocal(ids: string[], action: (row: number) => Op['action'] | null, after?: (row: number, uids: number[]) => Op['after']): void {
    for (const [row, list] of this.group(ids)) {
      const act = action(row);
      if (!act) continue;
      const msgIds = list.map((m) => m.id);
      const snap = this.store.snapshot(msgIds);
      const removed = this.store.deleteMessages(msgIds);
      const threads = new Set(removed.map((r) => r.threadId));
      this.emitRemoved(row, [...threads], msgIds);
      this.updateStarred(threads);
      this.emitFolders();
      const uids = list.map((m) => m.uid);
      const op: Op = {
        folderRow: row,
        uids,
        action: act,
        rollback: () => {
          this.store.restore(snap);
          this.emitRows('messages_added', row, threads, msgIds);
          this.updateStarred(threads);
          this.emitFolders();
        },
      };
      const af = after?.(row, uids);
      if (af) op.after = af;
      this.enqueueOp(op);
    }
  }

  move(ids: string[], destRow: number): void {
    if (!this.store.folder(destRow)) throw notFound('folder');
    this.removeLocal(ids, (row) => (row === destRow ? null : { kind: 'move', to: { kind: 'folder', row: destRow } }));
  }

  archive(ids: string[]): void {
    const arch = this.store.folderByRole('archive');
    this.removeLocal(ids, (row) => (arch && row === arch.row ? null : { kind: 'move', to: { kind: 'role', role: 'archive' } }));
  }

  trash(ids: string[]): void {
    const trash = this.store.folderByRole('trash');
    this.removeLocal(ids, (row) => (trash && row === trash.row ? { kind: 'expunge' } : { kind: 'move', to: { kind: 'role', role: 'trash' } }));
  }

  delete(ids: string[]): void {
    this.removeLocal(ids, () => ({ kind: 'expunge' }));
  }

  /** `\Answered` on the original after a reply was sent (§6). */
  markAnswered(id: string): void {
    const h = this.store.header(id);
    if (!h || h.flags.answered) return;
    this.store.setFlags(id, { answered: true });
    this.emitRows('messages_changed', h.folderRow, new Set([h.threadId]), [id]);
    this.enqueueOp({ folderRow: h.folderRow, uids: [h.uid], action: { kind: 'flags', add: ['\\Answered'], remove: [] }, rollback: () => this.store.setFlags(id, { answered: false }) });
  }

  /** APPEND to Sent (not for Gmail, it files sent mail itself, §6), then refresh Sent. */
  async appendSent(raw: Buffer): Promise<void> {
    if (this.host.provider === 'gmail') return;
    const sent = this.store.folderByRole('sent');
    if (!sent) return;
    await this.run(async (s) => {
      await s.append(sent.path, raw, ['\\Seen']);
      await this.syncFolder(s, sent);
    });
  }

  // ------------------------------------------------------------ events & folder list

  /** Virtual folders exist where the server has none: starred (flagged across folders), drafts, outbox. */
  hasVirtualStarred(): boolean {
    return this.store.folderByRole('starred') === null;
  }

  starredScope(): Scope {
    const ex = (['junk', 'trash'] as const).map((r) => this.store.folderByRole(r)?.row).filter((x): x is number => x !== undefined);
    return { kind: 'flagged', exclude: ex };
  }

  private rowsFor(row: number, threads: Iterable<string>): { rows: MailThreadRow[]; gone: string[] } {
    const rows: MailThreadRow[] = [];
    const gone: string[] = [];
    for (const t of threads) {
      const r = this.store.threadRow(t, { kind: 'folder', row });
      if (r) rows.push(r);
      else gone.push(t);
    }
    return { rows, gone };
  }

  emitRows(type: 'messages_added' | 'messages_changed', row: number, threads: Set<string>, messageIds: string[]): void {
    const { rows, gone } = this.rowsFor(row, threads);
    const fid = folderId(this.host.accountId, row);
    if (rows.length || messageIds.length) this.host.emit({ type, accountId: this.host.accountId, folderId: fid, rows, messageIds });
    if (gone.length) this.host.emit({ type: 'messages_removed', accountId: this.host.accountId, folderId: fid, threadIds: gone, messageIds: [] });
  }

  emitRemoved(row: number, threads: string[], messageIds: string[]): void {
    const { rows, gone } = this.rowsFor(row, threads);
    const fid = folderId(this.host.accountId, row);
    if (gone.length || messageIds.length) this.host.emit({ type: 'messages_removed', accountId: this.host.accountId, folderId: fid, threadIds: gone, messageIds });
    if (rows.length) this.host.emit({ type: 'messages_changed', accountId: this.host.accountId, folderId: fid, rows, messageIds: [] });
  }

  /** Keeps the virtual starred folder's rows in step with flag / move changes. */
  private updateStarred(threads: Set<string>): void {
    if (!threads.size || !this.hasVirtualStarred()) return;
    const fid = folderId(this.host.accountId, 'starred');
    const scope = this.starredScope();
    const rows: MailThreadRow[] = [];
    const gone: string[] = [];
    for (const t of threads) {
      const r = this.store.threadRow(t, scope, fid);
      if (r) rows.push(r);
      else gone.push(t);
    }
    if (rows.length) this.host.emit({ type: 'messages_changed', accountId: this.host.accountId, folderId: fid, rows, messageIds: [] });
    if (gone.length) this.host.emit({ type: 'messages_removed', accountId: this.host.accountId, folderId: fid, threadIds: gone, messageIds: [] });
  }

  folders(): MailFolder[] {
    const acc = this.host.accountId;
    const all = this.store.folders();
    const byPath = new Map(all.map((f) => [f.path, f]));
    const out: MailFolder[] = [];
    for (const f of all) {
      if (f.role === 'drafts') continue;
      const parent = f.parentPath ? byPath.get(f.parentPath) : undefined;
      const c = this.store.folderCounts(f.row);
      out.push({ id: folderId(acc, f.row), accountId: acc, path: f.path, name: f.name, role: f.role, parentId: parent && parent.role !== 'drafts' ? folderId(acc, parent.row) : null, unread: c.unread, total: c.total });
    }
    if (this.hasVirtualStarred()) {
      const sc = this.starredScope();
      const c = this.store.flaggedCounts(sc.kind === 'flagged' ? sc.exclude : []);
      out.push({ id: folderId(acc, 'starred'), accountId: acc, path: '', name: 'Starred', role: 'starred', parentId: null, unread: c.unread, total: c.total });
    }
    const drafts = this.store.drafts().length;
    out.push({ id: folderId(acc, 'drafts'), accountId: acc, path: '', name: 'Drafts', role: 'drafts', parentId: null, unread: 0, total: drafts });
    const outq = this.store.outgoingAll().filter((o) => o.state !== 'sent');
    out.push({ id: folderId(acc, 'outbox'), accountId: acc, path: '', name: 'Outbox', role: 'outbox', parentId: null, unread: outq.filter((o) => o.state === 'failed').length, total: outq.length });
    return out;
  }

  emitFolders(): void {
    this.host.emit({ type: 'folders', accountId: this.host.accountId, folders: this.folders() });
  }

  /** The current flags of a stored message from the server's view (tests / diagnostics). */
  static flags(set: string[]): MailFlags {
    return flagsFrom(set);
  }
}
