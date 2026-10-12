/**
 * Local mail database of one account (ADR-0088 §3): `userData/mail/<accountId>/mail.sqlite` on the
 * built-in `node:sqlite` (WAL), plus content-addressed blobs (`blobs/<sha256>`: parsed bodies and
 * attachments) with LRU eviction down to the cache limit. IMAP stays the source of truth: anything
 * evicted is fetched again on demand. No passwords here (main keeps them, §3).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import type { MailAddress, MailAttachment, MailCursor, MailFlags, MailFolderRole, MailHeader, MailThreadRow } from '../../shared/mail';
import { folderId, messageId } from './ids';

type Row = Record<string, SQLOutputValue>;

const str = (v: SQLOutputValue | undefined): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: SQLOutputValue | undefined): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : v == null ? 0 : Number(v));
const numOrNull = (v: SQLOutputValue | undefined): number | null => (v == null ? null : num(v));
const json = <T>(v: SQLOutputValue | undefined, fallback: T): T => {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/** Schema migrations, applied in order; `migrations` remembers the last one. Never edit a shipped step. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE folders (
    row INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    delimiter TEXT NOT NULL DEFAULT '/',
    parent_path TEXT NOT NULL DEFAULT '',
    role TEXT,
    special_use TEXT,
    uidvalidity TEXT,
    highestmodseq TEXT,
    uidnext INTEGER,
    synced_since INTEGER,
    exhausted INTEGER NOT NULL DEFAULT 0,
    last_sync INTEGER
  );
  CREATE TABLE threads (n INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL);
  CREATE TABLE thread_keys (key TEXT PRIMARY KEY, thread_id TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE messages (
    rid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    folder_row INTEGER NOT NULL,
    uid INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    message_id_hdr TEXT NOT NULL DEFAULT '',
    in_reply_to TEXT NOT NULL DEFAULT '',
    refs TEXT NOT NULL DEFAULT '[]',
    from_name TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    bcc_json TEXT NOT NULL DEFAULT '[]',
    reply_to_json TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL DEFAULT '',
    subject_norm TEXT NOT NULL DEFAULT '',
    snippet TEXT NOT NULL DEFAULT '',
    date INTEGER NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    flagged INTEGER NOT NULL DEFAULT 0,
    answered INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    has_att INTEGER NOT NULL DEFAULT 0,
    body_hash TEXT,
    UNIQUE (folder_row, uid)
  );
  CREATE INDEX messages_folder_date ON messages (folder_row, date DESC, id DESC);
  CREATE INDEX messages_folder_thread ON messages (folder_row, thread_id);
  CREATE INDEX messages_thread ON messages (thread_id);
  CREATE INDEX messages_msgid ON messages (message_id_hdr);
  CREATE INDEX messages_subject ON messages (subject_norm, date);
  CREATE INDEX messages_flagged ON messages (flagged) WHERE flagged = 1;
  CREATE INDEX messages_body ON messages (body_hash) WHERE body_hash IS NOT NULL;
  CREATE TABLE attachments (
    message_id TEXT NOT NULL,
    idx TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    cid TEXT,
    inline INTEGER NOT NULL DEFAULT 0,
    hash TEXT,
    PRIMARY KEY (message_id, idx)
  ) WITHOUT ROWID;
  CREATE TABLE blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, accessed INTEGER NOT NULL) WITHOUT ROWID;
  CREATE INDEX blobs_lru ON blobs (accessed);
  CREATE TABLE drafts (n INTEGER PRIMARY KEY AUTOINCREMENT, updated_at INTEGER NOT NULL, json TEXT NOT NULL);
  CREATE TABLE outgoing (
    n INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error_json TEXT,
    next_at INTEGER,
    to_json TEXT NOT NULL,
    subject TEXT NOT NULL,
    meta_json TEXT NOT NULL
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  CREATE VIRTUAL TABLE fts USING fts5(subject, sender, snippet, body, tokenize = 'unicode61 remove_diacritics 2');
  `,
];

export function migrate(db: DatabaseSync, steps: readonly string[] = MIGRATIONS): number {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER NOT NULL)');
  const cur = num(db.prepare('SELECT MAX(version) AS v FROM migrations').get()?.['v']);
  for (let v = cur; v < steps.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(steps[v] ?? '');
      db.prepare('INSERT INTO migrations (version) VALUES (?)').run(v + 1);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return steps.length;
}

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000; PRAGMA cache_size = -2000;');
  return db;
}

// ---------------------------------------------------------------- subjects & threading

const PREFIX = /^\s*((re|fwd?|aw|wg|sv|vs|tr|rif|antw|odp|ответ|отв|пересл|fw)\s*(\[\d+\]|\(\d+\))?\s*[:：]\s*)+/i;

/** Lower-cased subject without reply / forward prefixes (incl. Russian) and extra spaces. */
export function normalizeSubject(subject: string): string {
  let s = subject.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 5; i++) {
    const next = s.replace(PREFIX, '').replace(/^\[[^\]]{1,40}\]\s*/, (m) => (PREFIX.test(s.slice(m.length)) ? '' : m));
    if (next === s) break;
    s = next.trim();
  }
  return s.toLowerCase();
}

export function hasReplyPrefix(subject: string): boolean {
  return PREFIX.test(subject.trim());
}

/** The 7-day window of the normalized-subject fallback (§5). */
export const SUBJECT_WINDOW_MS = 7 * 24 * 3600_000;

// ---------------------------------------------------------------- records

export interface FolderRecord {
  row: number;
  path: string;
  name: string;
  delimiter: string;
  parentPath: string;
  role: MailFolderRole | null;
  specialUse: string | null;
  uidValidity: string | null;
  highestModseq: string | null;
  uidNext: number | null;
  syncedSince: number | null;
  exhausted: boolean;
  lastSync: number | null;
}

export interface NewMessage {
  folderRow: number;
  uidValidity: string;
  uid: number;
  messageIdHdr: string;
  inReplyTo: string;
  references: string[];
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  subject: string;
  snippet: string;
  date: number;
  flags: MailFlags;
  size: number;
  hasAttachments: boolean;
}

export interface LocalFlags extends MailFlags {
  id: string;
  threadId: string;
}

export interface StoredAttachment extends MailAttachment {
  hash: string | null;
}

export interface StoredBody {
  html: string | null;
  text: string | null;
  inReplyTo: string;
  references: string[];
  remoteImages: boolean;
}

/** Which messages a list / search runs over. */
export type Scope = { kind: 'folder'; row: number } | { kind: 'flagged'; exclude: number[] } | { kind: 'all'; exclude: number[] };

export interface OutgoingRecord {
  n: number;
  createdAt: number;
  state: 'queued' | 'sending' | 'failed' | 'sent';
  attempts: number;
  error: { code: string; message: string } | null;
  nextAt: number | null;
  to: MailAddress[];
  subject: string;
  meta: OutgoingMeta;
}

export interface OutgoingMeta {
  /** SMTP envelope. */
  from: string;
  recipients: string[];
  /** The original for `\Answered` after a reply. */
  answers?: string;
  messageIdHdr: string;
}

const addrJson = (a: MailAddress[]): string => JSON.stringify(a.map((x) => ({ name: x.name, address: x.address })));

export class MailStore {
  readonly db: DatabaseSync;
  private readonly blobDir: string;

  constructor(
    readonly dir: string,
    readonly accountId: string,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dir, { recursive: true });
    this.blobDir = join(dir, 'blobs');
    mkdirSync(this.blobDir, { recursive: true });
    this.db = openDb(join(dir, 'mail.sqlite'));
    migrate(this.db);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ------------------------------------------------------------ meta

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return r ? str(r['value']) : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ------------------------------------------------------------ folders

  private folderFrom(r: Row): FolderRecord {
    return {
      row: num(r['row']),
      path: str(r['path']),
      name: str(r['name']),
      delimiter: str(r['delimiter']),
      parentPath: str(r['parent_path']),
      role: (r['role'] ?? null) as MailFolderRole | null,
      specialUse: r['special_use'] == null ? null : str(r['special_use']),
      uidValidity: r['uidvalidity'] == null ? null : str(r['uidvalidity']),
      highestModseq: r['highestmodseq'] == null ? null : str(r['highestmodseq']),
      uidNext: numOrNull(r['uidnext']),
      syncedSince: numOrNull(r['synced_since']),
      exhausted: num(r['exhausted']) === 1,
      lastSync: numOrNull(r['last_sync']),
    };
  }

  folders(): FolderRecord[] {
    return this.db
      .prepare('SELECT * FROM folders ORDER BY path')
      .all()
      .map((r) => this.folderFrom(r));
  }

  folder(row: number): FolderRecord | null {
    const r = this.db.prepare('SELECT * FROM folders WHERE row = ?').get(row);
    return r ? this.folderFrom(r) : null;
  }

  folderByRole(role: MailFolderRole): FolderRecord | null {
    const r = this.db.prepare('SELECT * FROM folders WHERE role = ? ORDER BY row LIMIT 1').get(role);
    return r ? this.folderFrom(r) : null;
  }

  folderByPath(path: string): FolderRecord | null {
    const r = this.db.prepare('SELECT * FROM folders WHERE path = ?').get(path);
    return r ? this.folderFrom(r) : null;
  }

  /** Inserts or updates a folder from the server's LIST; returns its row. */
  upsertFolder(f: { path: string; name: string; delimiter: string; parentPath: string; role: MailFolderRole | null; specialUse: string | null }): number {
    const ex = this.db.prepare('SELECT row FROM folders WHERE path = ?').get(f.path);
    if (ex) {
      this.db
        .prepare('UPDATE folders SET name = ?, delimiter = ?, parent_path = ?, role = ?, special_use = ? WHERE row = ?')
        .run(f.name, f.delimiter, f.parentPath, f.role, f.specialUse, num(ex['row']));
      return num(ex['row']);
    }
    const r = this.db
      .prepare('INSERT INTO folders (path, name, delimiter, parent_path, role, special_use) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.path, f.name, f.delimiter, f.parentPath, f.role, f.specialUse);
    return num(r.lastInsertRowid);
  }

  updateFolderSync(row: number, p: Partial<Pick<FolderRecord, 'uidValidity' | 'highestModseq' | 'uidNext' | 'syncedSince' | 'exhausted' | 'lastSync'>>): void {
    const cols: Record<string, SQLInputValue> = {};
    if ('uidValidity' in p) cols['uidvalidity'] = p.uidValidity ?? null;
    if ('highestModseq' in p) cols['highestmodseq'] = p.highestModseq ?? null;
    if ('uidNext' in p) cols['uidnext'] = p.uidNext ?? null;
    if ('syncedSince' in p) cols['synced_since'] = p.syncedSince ?? null;
    if ('exhausted' in p) cols['exhausted'] = p.exhausted ? 1 : 0;
    if ('lastSync' in p) cols['last_sync'] = p.lastSync ?? null;
    const keys = Object.keys(cols);
    if (!keys.length) return;
    this.db.prepare(`UPDATE folders SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE row = ?`).run(...keys.map((k) => cols[k] ?? null), row);
  }

  /** Drops a folder (gone from the server) with its messages; returns the removed message ids. */
  deleteFolder(row: number): string[] {
    return this.tx(() => {
      const ids = this.clearFolderInTx(row);
      this.db.prepare('DELETE FROM folders WHERE row = ?').run(row);
      return ids;
    });
  }

  /** Removes every message of a folder (UIDVALIDITY changed); returns their ids. */
  clearFolder(row: number): string[] {
    return this.tx(() => this.clearFolderInTx(row));
  }

  private clearFolderInTx(row: number): string[] {
    const rows = this.db.prepare('SELECT rid, id FROM messages WHERE folder_row = ?').all(row);
    this.deleteRows(rows);
    return rows.map((r) => str(r['id']));
  }

  folderCounts(row: number): { unread: number; total: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(seen = 0), 0) AS unread FROM messages WHERE folder_row = ?').get(row);
    return { unread: num(r?.['unread']), total: num(r?.['total']) };
  }

  flaggedCounts(exclude: number[]): { unread: number; total: number } {
    const ex = exclude.length ? `AND folder_row NOT IN (${exclude.map(() => '?').join(',')})` : '';
    const r = this.db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(seen = 0), 0) AS unread FROM messages WHERE flagged = 1 ${ex}`).get(...exclude);
    return { unread: num(r?.['unread']), total: num(r?.['total']) };
  }

  // ------------------------------------------------------------ messages: sync side

  /** uid → flags of what is stored for a folder. */
  localFlags(row: number): Map<number, LocalFlags> {
    const m = new Map<number, LocalFlags>();
    for (const r of this.db.prepare('SELECT uid, id, thread_id, seen, flagged, answered FROM messages WHERE folder_row = ?').all(row)) {
      m.set(num(r['uid']), { id: str(r['id']), threadId: str(r['thread_id']), seen: num(r['seen']) === 1, flagged: num(r['flagged']) === 1, answered: num(r['answered']) === 1 });
    }
    return m;
  }

  uidRange(row: number): { min: number; max: number; count: number } | null {
    const r = this.db.prepare('SELECT MIN(uid) AS mn, MAX(uid) AS mx, COUNT(*) AS c FROM messages WHERE folder_row = ?').get(row);
    if (!r || num(r['c']) === 0) return null;
    return { min: num(r['mn']), max: num(r['mx']), count: num(r['c']) };
  }

  /** Finds or allocates the thread of a new message (References / In-Reply-To, then subject ≤ 7 days). */
  private threadFor(m: NewMessage, subjectNorm: string): string {
    const keys = [m.messageIdHdr, m.inReplyTo, ...m.references].filter(Boolean);
    const get = this.db.prepare('SELECT thread_id FROM thread_keys WHERE key = ?');
    let thread: string | null = null;
    // Ancestors first (the closest reply parent), then our own id (a reply that arrived earlier).
    for (const k of [m.inReplyTo, ...[...m.references].reverse(), m.messageIdHdr].filter(Boolean)) {
      const r = get.get(k);
      if (r) {
        thread = str(r['thread_id']);
        break;
      }
    }
    // Subject fallback only for replies / forwards whose references did not match (a lost parent),
    // so unrelated mail with the same subject («Your order») does not merge.
    if (!thread && subjectNorm && (hasReplyPrefix(m.subject) || m.inReplyTo || m.references.length)) {
      const r = this.db
        .prepare('SELECT thread_id FROM messages WHERE subject_norm = ? AND date BETWEEN ? AND ? ORDER BY ABS(date - ?) LIMIT 1')
        .get(subjectNorm, m.date - SUBJECT_WINDOW_MS, m.date + SUBJECT_WINDOW_MS, m.date);
      if (r) thread = str(r['thread_id']);
    }
    if (!thread) {
      const r = this.db.prepare('INSERT INTO threads (created) VALUES (?)').run(this.now());
      thread = `${this.accountId}.t${String(r.lastInsertRowid)}`;
    }
    const put = this.db.prepare('INSERT OR IGNORE INTO thread_keys (key, thread_id) VALUES (?, ?)');
    for (const k of keys) put.run(k, thread);
    return thread;
  }

  /** Stores a new message (idempotent by folder + uid); returns its id and thread. */
  insertMessage(m: NewMessage): { id: string; threadId: string; inserted: boolean } {
    const id = messageId(this.accountId, m.folderRow, BigInt(m.uidValidity), m.uid);
    const ex = this.db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(id);
    if (ex) return { id, threadId: str(ex['thread_id']), inserted: false };
    const subjectNorm = normalizeSubject(m.subject);
    const threadId = this.threadFor(m, subjectNorm);
    const r = this.db
      .prepare(
        `INSERT INTO messages (id, folder_row, uid, thread_id, message_id_hdr, in_reply_to, refs, from_name, from_addr, to_json, cc_json, bcc_json,
          reply_to_json, subject, subject_norm, snippet, date, seen, flagged, answered, size, has_att)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        m.folderRow,
        m.uid,
        threadId,
        m.messageIdHdr,
        m.inReplyTo,
        JSON.stringify(m.references),
        m.from.name,
        m.from.address.toLowerCase(),
        addrJson(m.to),
        addrJson(m.cc),
        addrJson(m.bcc),
        addrJson(m.replyTo),
        m.subject,
        subjectNorm,
        m.snippet,
        m.date,
        m.flags.seen ? 1 : 0,
        m.flags.flagged ? 1 : 0,
        m.flags.answered ? 1 : 0,
        m.size,
        m.hasAttachments ? 1 : 0,
      );
    this.db
      .prepare('INSERT INTO fts (rowid, subject, sender, snippet, body) VALUES (?, ?, ?, ?, ?)')
      .run(r.lastInsertRowid, m.subject, `${m.from.name} ${m.from.address}`, m.snippet, '');
    return { id, threadId, inserted: true };
  }

  setFlags(id: string, patch: Partial<MailFlags>): boolean {
    const sets: string[] = [];
    const vals: SQLInputValue[] = [];
    for (const k of ['seen', 'flagged', 'answered'] as const) {
      const v = patch[k];
      if (v !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(v ? 1 : 0);
      }
    }
    if (!sets.length) return false;
    return Number(this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id).changes) > 0;
  }

  private deleteRows(rows: Row[]): void {
    const delMsg = this.db.prepare('DELETE FROM messages WHERE rid = ?');
    const delFts = this.db.prepare('DELETE FROM fts WHERE rowid = ?');
    const delAtt = this.db.prepare('DELETE FROM attachments WHERE message_id = ?');
    for (const r of rows) {
      delMsg.run(r['rid'] ?? null);
      delFts.run(r['rid'] ?? null);
      delAtt.run(r['id'] ?? null);
    }
  }

  /** Deletes messages by id; returns what was removed (id, thread, folder). */
  deleteMessages(ids: string[]): Array<{ id: string; threadId: string; folderRow: number }> {
    if (!ids.length) return [];
    return this.tx(() => {
      const out: Array<{ id: string; threadId: string; folderRow: number }> = [];
      const get = this.db.prepare('SELECT rid, id, thread_id, folder_row FROM messages WHERE id = ?');
      const rows: Row[] = [];
      for (const id of ids) {
        const r = get.get(id);
        if (!r) continue;
        rows.push(r);
        out.push({ id, threadId: str(r['thread_id']), folderRow: num(r['folder_row']) });
      }
      this.deleteRows(rows);
      return out;
    });
  }

  /** The raw rows needed to restore messages after a failed server operation (rollback). */
  snapshot(ids: string[]): Row[] {
    const get = this.db.prepare('SELECT * FROM messages WHERE id = ?');
    return ids.map((id) => get.get(id)).filter((r): r is Row => r !== undefined);
  }

  restore(rows: Row[]): void {
    this.tx(() => {
      for (const r of rows) {
        const cols = Object.keys(r);
        this.db.prepare(`INSERT OR REPLACE INTO messages (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => (r[c] ?? null) as SQLInputValue));
        this.db.prepare('INSERT OR REPLACE INTO fts (rowid, subject, sender, snippet, body) VALUES (?, ?, ?, ?, ?)').run(r['rid'] ?? null, str(r['subject']), `${str(r['from_name'])} ${str(r['from_addr'])}`, str(r['snippet']), '');
      }
    });
  }

  // ------------------------------------------------------------ messages: read side

  private headerFrom(r: Row): MailHeader {
    return {
      id: str(r['id']),
      threadId: str(r['thread_id']),
      accountId: this.accountId,
      folderId: folderId(this.accountId, num(r['folder_row'])),
      messageIdHeader: str(r['message_id_hdr']),
      from: { name: str(r['from_name']), address: str(r['from_addr']) },
      to: json<MailAddress[]>(r['to_json'], []),
      cc: json<MailAddress[]>(r['cc_json'], []),
      bcc: json<MailAddress[]>(r['bcc_json'], []),
      replyTo: json<MailAddress[]>(r['reply_to_json'], []),
      subject: str(r['subject']),
      snippet: str(r['snippet']),
      date: num(r['date']),
      flags: { seen: num(r['seen']) === 1, flagged: num(r['flagged']) === 1, answered: num(r['answered']) === 1 },
      hasAttachments: num(r['has_att']) === 1,
      size: num(r['size']),
    };
  }

  header(id: string): (MailHeader & { uid: number; folderRow: number; bodyHash: string | null; references: string[]; inReplyTo: string }) | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    if (!r) return null;
    return {
      ...this.headerFrom(r),
      uid: num(r['uid']),
      folderRow: num(r['folder_row']),
      bodyHash: r['body_hash'] == null ? null : str(r['body_hash']),
      references: json<string[]>(r['refs'], []),
      inReplyTo: str(r['in_reply_to']),
    };
  }

  /** All messages of a thread, oldest first. */
  thread(threadId: string): MailHeader[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC, id ASC')
      .all(threadId)
      .map((r) => this.headerFrom(r));
  }

  /** Message ids of a thread inside a scope (a list row's selection). */
  threadMessageIds(threadId: string, scope: Scope): string[] {
    const { sql, args } = scopeSql('m', scope);
    return this.db
      .prepare(`SELECT id FROM messages m WHERE m.thread_id = ? AND ${sql}`)
      .all(threadId, ...args)
      .map((r) => str(r['id']));
  }

  /**
   * One page of thread rows in a scope: per thread the newest message inside the scope, newest
   * first, keyset-paged by (date, id). `rowFolder` overrides the row's folderId (virtual folders).
   */
  listThreads(scope: Scope, opts: { before?: MailCursor; limit: number; unreadOnly?: boolean; flaggedOnly?: boolean; rowFolder?: string; match?: string }): MailThreadRow[] {
    const p = (a: string): { sql: string; args: SQLInputValue[] } => scopeSql(a, scope);
    const m = p('m');
    const n = p('n');
    const u = p('u');
    const f = p('f');
    const a = p('x');
    const g = p('g');
    const args: SQLInputValue[] = [];
    let where = m.sql;
    args.push(...m.args);
    // Search: the matching rows come from a CTE (FTS5 MATCH needs the table itself, not an alias)
    // and the row is the newest *matching* message per thread and folder.
    const cte = opts.match ? 'WITH hits AS (SELECT rowid AS rid FROM fts WHERE fts MATCH ?) ' : '';
    if (opts.match) where += ' AND m.rid IN hits';
    const newest = opts.match
      ? `NOT EXISTS (SELECT 1 FROM messages n WHERE ${n.sql} AND n.rid IN hits AND n.thread_id = m.thread_id AND n.folder_row = m.folder_row AND (n.date > m.date OR (n.date = m.date AND n.id > m.id)))`
      : `NOT EXISTS (SELECT 1 FROM messages n WHERE ${n.sql} AND n.thread_id = m.thread_id AND (n.date > m.date OR (n.date = m.date AND n.id > m.id)))`;
    where += ` AND ${newest}`;
    args.push(...n.args);
    if (opts.before) {
      where += ' AND (m.date < ? OR (m.date = ? AND m.id < ?))';
      args.push(opts.before.date, opts.before.date, opts.before.id);
    }
    if (opts.unreadOnly) {
      where += ` AND EXISTS (SELECT 1 FROM messages u WHERE ${u.sql} AND u.thread_id = m.thread_id AND u.seen = 0)`;
      args.push(...u.args);
    }
    if (opts.flaggedOnly) {
      where += ` AND EXISTS (SELECT 1 FROM messages g WHERE ${g.sql} AND g.thread_id = m.thread_id AND g.flagged = 1)`;
      args.push(...g.args);
    }
    const sql = `${cte}SELECT m.*,
        (SELECT COUNT(DISTINCT CASE WHEN c.message_id_hdr = '' THEN c.id ELSE c.message_id_hdr END) FROM messages c WHERE c.thread_id = m.thread_id) AS cnt,
        (SELECT MAX(f.seen = 0) FROM messages f WHERE ${f.sql} AND f.thread_id = m.thread_id) AS any_unread,
        (SELECT MAX(x.flagged) FROM messages x WHERE ${a.sql} AND x.thread_id = m.thread_id) AS any_flagged,
        (SELECT MAX(x.has_att) FROM messages x WHERE ${a.sql} AND x.thread_id = m.thread_id) AS any_att
      FROM messages m
      WHERE ${where}
      ORDER BY m.date DESC, m.id DESC
      LIMIT ?`;
    // Parameters in text order: the CTE, the select-list subqueries, then FROM / WHERE.
    const all = [...(opts.match ? [opts.match] : []), ...f.args, ...a.args, ...a.args, ...args, opts.limit];
    return this.db
      .prepare(sql)
      .all(...all)
      .map((r) => ({
        threadId: str(r['thread_id']),
        accountId: this.accountId,
        folderId: opts.rowFolder ?? folderId(this.accountId, num(r['folder_row'])),
        messageId: str(r['id']),
        messageIdHeader: str(r['message_id_hdr']),
        from: { name: str(r['from_name']), address: str(r['from_addr']) },
        subject: str(r['subject']),
        snippet: str(r['snippet']),
        date: num(r['date']),
        count: Math.max(1, num(r['cnt'])),
        unread: num(r['any_unread']) === 1,
        flagged: num(r['any_flagged']) === 1,
        hasAttachments: num(r['any_att']) === 1,
      }));
  }

  /** The current row of a thread in a scope (null = nothing of the thread left there). */
  threadRow(threadId: string, scope: Scope, rowFolder?: string): MailThreadRow | null {
    const { sql, args } = scopeSql('t', scope);
    const newest = this.db.prepare(`SELECT date, id FROM messages t WHERE t.thread_id = ? AND ${sql} ORDER BY date DESC, id DESC LIMIT 1`).get(threadId, ...args);
    if (!newest) return null;
    // A cursor just above the newest message: the page holds exactly that row (plus older threads).
    const rows = this.listThreads(scope, { before: { date: num(newest['date']), id: `${str(newest['id'])}\u{10FFFF}` }, limit: 50, ...(rowFolder ? { rowFolder } : {}) });
    return rows.find((r) => r.threadId === threadId) ?? null;
  }

  // ------------------------------------------------------------ bodies, attachments, blobs

  putBlob(data: Uint8Array | string): string {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const hash = createHash('sha256').update(buf).digest('hex');
    const p = join(this.blobDir, hash);
    const ex = this.db.prepare('SELECT 1 FROM blobs WHERE hash = ?').get(hash);
    if (!ex) {
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, buf);
      renameSync(tmp, p);
      this.db.prepare('INSERT OR REPLACE INTO blobs (hash, size, accessed) VALUES (?, ?, ?)').run(hash, buf.length, this.now());
    } else {
      this.db.prepare('UPDATE blobs SET accessed = ? WHERE hash = ?').run(this.now(), hash);
    }
    return hash;
  }

  getBlob(hash: string): Buffer | null {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    try {
      const b = readFileSync(join(this.blobDir, hash));
      this.db.prepare('UPDATE blobs SET accessed = ? WHERE hash = ?').run(this.now(), hash);
      return b;
    } catch {
      this.dropBlob(hash);
      return null;
    }
  }

  private dropBlob(hash: string): void {
    rmSync(join(this.blobDir, hash), { force: true });
    this.db.prepare('DELETE FROM blobs WHERE hash = ?').run(hash);
    this.db.prepare('UPDATE messages SET body_hash = NULL WHERE body_hash = ?').run(hash);
    this.db.prepare('UPDATE attachments SET hash = NULL WHERE hash = ?').run(hash);
  }

  blobBytes(): number {
    return num(this.db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM blobs').get()?.['s']);
  }

  /** Drops every cached body and attachment (settings «Очистить»); headers stay. */
  clearBlobs(): void {
    for (const r of this.db.prepare('SELECT hash FROM blobs').all()) this.dropBlob(str(r['hash']));
  }

  /** LRU eviction down to `limit` bytes; returns the number of blobs dropped. */
  evict(limit: number): number {
    let total = this.blobBytes();
    if (total <= limit) return 0;
    let dropped = 0;
    for (const r of this.db.prepare('SELECT hash, size FROM blobs ORDER BY accessed ASC').all()) {
      if (total <= limit) break;
      this.dropBlob(str(r['hash']));
      total -= num(r['size']);
      dropped++;
    }
    return dropped;
  }

  /** Stores a parsed body (blob) and its attachments; indexes the text for search. */
  setBody(id: string, body: StoredBody, attachments: Array<MailAttachment & { data: Uint8Array | null }>, snippet?: string): void {
    const hash = this.putBlob(JSON.stringify(body));
    this.tx(() => {
      const r = this.db.prepare('SELECT rid FROM messages WHERE id = ?').get(id);
      if (!r) return;
      this.db.prepare('UPDATE messages SET body_hash = ?, has_att = ? WHERE id = ?').run(hash, attachments.some((a) => !a.inline) ? 1 : 0, id);
      if (snippet !== undefined) this.db.prepare('UPDATE messages SET snippet = ? WHERE id = ? AND snippet = ?').run(snippet, id, '');
      this.db.prepare('DELETE FROM attachments WHERE message_id = ?').run(id);
      const ins = this.db.prepare('INSERT INTO attachments (message_id, idx, name, mime, size, cid, inline, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const a of attachments) ins.run(id, a.id, a.name, a.mime, a.size, a.cid ?? null, a.inline ? 1 : 0, a.data ? this.putBlob(a.data) : null);
      this.db.prepare('UPDATE fts SET body = ? WHERE rowid = ?').run((body.text ?? '').slice(0, 200_000), r['rid'] ?? null);
    });
  }

  body(hash: string): StoredBody | null {
    const b = this.getBlob(hash);
    if (!b) return null;
    try {
      return JSON.parse(b.toString('utf8')) as StoredBody;
    } catch {
      return null;
    }
  }

  attachments(id: string): StoredAttachment[] {
    return this.db
      .prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY CAST(idx AS INTEGER)')
      .all(id)
      .map((r) => {
        const a: StoredAttachment = { id: str(r['idx']), name: str(r['name']), mime: str(r['mime']), size: num(r['size']), inline: num(r['inline']) === 1, hash: r['hash'] == null ? null : str(r['hash']) };
        if (r['cid'] != null) a.cid = str(r['cid']);
        return a;
      });
  }

  // ------------------------------------------------------------ drafts

  saveDraft(n: number | null, jsonText: string): { n: number; updatedAt: number } {
    const at = this.now();
    if (n !== null && this.db.prepare('UPDATE drafts SET json = ?, updated_at = ? WHERE n = ?').run(jsonText, at, n).changes) return { n, updatedAt: at };
    const r = this.db.prepare('INSERT INTO drafts (updated_at, json) VALUES (?, ?)').run(at, jsonText);
    return { n: Number(r.lastInsertRowid), updatedAt: at };
  }

  drafts(): Array<{ n: number; updatedAt: number; json: string }> {
    return this.db
      .prepare('SELECT * FROM drafts ORDER BY updated_at DESC')
      .all()
      .map((r) => ({ n: num(r['n']), updatedAt: num(r['updated_at']), json: str(r['json']) }));
  }

  removeDraft(n: number): boolean {
    return Number(this.db.prepare('DELETE FROM drafts WHERE n = ?').run(n).changes) > 0;
  }

  // ------------------------------------------------------------ outgoing

  private outgoingFrom(r: Row): OutgoingRecord {
    return {
      n: num(r['n']),
      createdAt: num(r['created_at']),
      state: str(r['state']) as OutgoingRecord['state'],
      attempts: num(r['attempts']),
      error: json<OutgoingRecord['error']>(r['error_json'], null),
      nextAt: numOrNull(r['next_at']),
      to: json<MailAddress[]>(r['to_json'], []),
      subject: str(r['subject']),
      meta: json<OutgoingMeta>(r['meta_json'], { from: '', recipients: [], messageIdHdr: '' }),
    };
  }

  addOutgoing(o: { to: MailAddress[]; subject: string; meta: OutgoingMeta }): OutgoingRecord {
    const at = this.now();
    const r = this.db
      .prepare('INSERT INTO outgoing (created_at, state, attempts, next_at, to_json, subject, meta_json) VALUES (?, ?, 0, ?, ?, ?, ?)')
      .run(at, 'queued', at, addrJson(o.to), o.subject, JSON.stringify(o.meta));
    const rec = this.outgoing(Number(r.lastInsertRowid));
    if (!rec) throw new Error('outgoing insert failed');
    return rec;
  }

  outgoing(n: number): OutgoingRecord | null {
    const r = this.db.prepare('SELECT * FROM outgoing WHERE n = ?').get(n);
    return r ? this.outgoingFrom(r) : null;
  }

  outgoingAll(): OutgoingRecord[] {
    return this.db
      .prepare('SELECT * FROM outgoing ORDER BY created_at ASC, n ASC')
      .all()
      .map((r) => this.outgoingFrom(r));
  }

  updateOutgoing(n: number, p: Partial<Pick<OutgoingRecord, 'state' | 'attempts' | 'error' | 'nextAt'>>): void {
    const cur = this.outgoing(n);
    if (!cur) return;
    const next = { ...cur, ...p };
    this.db
      .prepare('UPDATE outgoing SET state = ?, attempts = ?, error_json = ?, next_at = ? WHERE n = ?')
      .run(next.state, next.attempts, next.error ? JSON.stringify(next.error) : null, next.nextAt, n);
  }

  removeOutgoing(n: number): boolean {
    return Number(this.db.prepare('DELETE FROM outgoing WHERE n = ?').run(n).changes) > 0;
  }

  /** Recipient addresses seen in sent mail (compose autocomplete is the renderer's; kept for later). */
  messageIdsByHeader(hdr: string): string[] {
    return this.db
      .prepare('SELECT id FROM messages WHERE message_id_hdr = ?')
      .all(hdr)
      .map((r) => str(r['id']));
  }
}

/** SQL for a scope over the alias `a` (+ its parameters). */
export function scopeSql(a: string, scope: Scope): { sql: string; args: SQLInputValue[] } {
  if (scope.kind === 'folder') return { sql: `${a}.folder_row = ?`, args: [scope.row] };
  const ex = scope.exclude.length ? ` AND ${a}.folder_row NOT IN (${scope.exclude.map(() => '?').join(',')})` : '';
  if (scope.kind === 'flagged') return { sql: `${a}.flagged = 1${ex}`, args: [...scope.exclude] };
  return { sql: `1 = 1${ex}`, args: [...scope.exclude] };
}

/** Free text → an FTS5 query: every word as a quoted prefix term (no operators from the user). */
export function ftsQuery(text: string): string | null {
  const words = text
    .normalize('NFKC')
    .split(/[\s"'()*:^{}[\]+\-~<>@.,;!?/\\|]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 12);
  if (!words.length) return null;
  return words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' ');
}

/** The shared settings database `userData/mail/settings.sqlite` (§7 `settings.get/set`). */
export class SettingsDb {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = openDb(file);
    migrate(this.db, ['CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;']);
  }
  get(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.db.prepare('SELECT key, value FROM settings').all()) {
      try {
        out[str(r['key'])] = JSON.parse(str(r['value']));
      } catch {
        // skip a corrupt value: the default applies
      }
    }
    return out;
  }
  set(values: Record<string, unknown>): void {
    const st = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(values)) st.run(k, JSON.stringify(v));
  }
  close(): void {
    this.db.close();
  }
}
