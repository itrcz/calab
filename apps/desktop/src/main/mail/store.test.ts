import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ftsQuery, migrate, MailStore, normalizeSubject, type NewMessage } from './store';

const ACC = 'a0123456789abcdef';
const DAY = 24 * 3600_000;
const dirs: string[] = [];

function store(now = () => 1_700_000_000_000): MailStore {
  const d = mkdtempSync(join(tmpdir(), 'calab-mail-store-'));
  dirs.push(d);
  return new MailStore(d, ACC, now);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let uid = 1;
function msg(folderRow: number, over: Partial<NewMessage> = {}): NewMessage {
  return {
    folderRow,
    uidValidity: '7',
    uid: uid++,
    messageIdHdr: '',
    inReplyTo: '',
    references: [],
    from: { name: 'Ivan', address: 'ivan@example.org' },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Hello',
    snippet: 'hi there',
    date: 1_700_000_000_000,
    flags: { seen: false, flagged: false, answered: false },
    size: 100,
    hasAttachments: false,
    ...over,
  };
}

describe('migrations', () => {
  it('are applied once and recorded', () => {
    const db = new DatabaseSync(':memory:');
    const steps = ['CREATE TABLE a (x INTEGER);', 'CREATE TABLE b (y INTEGER);'];
    expect(migrate(db, steps.slice(0, 1))).toBe(1);
    expect(migrate(db, steps)).toBe(2);
    expect(migrate(db, steps)).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS c FROM migrations').get()?.['c']).toBe(2);
  });
  it('roll back a failing step', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => migrate(db, ['CREATE TABLE a (x INTEGER); CREATE TABLE a (x INTEGER);'])).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'a'").get()?.['c']).toBe(0);
  });
  it('a store reopens its database without re-running steps', () => {
    const s = store();
    const dir = s.dir;
    s.upsertFolder({ path: 'INBOX', name: 'INBOX', delimiter: '/', parentPath: '', role: 'inbox', specialUse: null });
    s.close();
    const again = new MailStore(dir, ACC);
    expect(again.folders()).toHaveLength(1);
    again.close();
  });
});

describe('subjects', () => {
  it('normalizes reply / forward prefixes incl. Russian', () => {
    expect(normalizeSubject('Re: RE[2]: Fwd:  Hello   world')).toBe('hello world');
    expect(normalizeSubject('Ответ: Отв: Привет')).toBe('привет');
    expect(normalizeSubject('AW: WG: Bericht')).toBe('bericht');
    expect(normalizeSubject('Re:')).toBe('');
  });
});

describe('threading', () => {
  it('joins by In-Reply-To / References in either arrival order', () => {
    const s = store();
    const f = s.upsertFolder({ path: 'INBOX', name: 'INBOX', delimiter: '/', parentPath: '', role: 'inbox', specialUse: null });
    const root = s.insertMessage(msg(f, { messageIdHdr: '<1@x>' }));
    const reply = s.insertMessage(msg(f, { messageIdHdr: '<2@x>', inReplyTo: '<1@x>', references: ['<1@x>'], subject: 'Re: Hello' }));
    expect(reply.threadId).toBe(root.threadId);
    // A child that arrived before its parent: the parent joins the child's thread.
    const child = s.insertMessage(msg(f, { messageIdHdr: '<11@x>', inReplyTo: '<10@x>', references: ['<10@x>'], subject: 'Re: Other' }));
    const parent = s.insertMessage(msg(f, { messageIdHdr: '<10@x>', subject: 'Other' }));
    expect(parent.threadId).toBe(child.threadId);
    expect(parent.threadId).not.toBe(root.threadId);
  });
  it('falls back to the normalized subject within 7 days, for replies only', () => {
    const s = store();
    const f = s.upsertFolder({ path: 'INBOX', name: 'INBOX', delimiter: '/', parentPath: '', role: 'inbox', specialUse: null });
    const t0 = 1_700_000_000_000;
    const a = s.insertMessage(msg(f, { messageIdHdr: '<a@x>', subject: 'Budget', date: t0 }));
    const b = s.insertMessage(msg(f, { messageIdHdr: '<b@x>', inReplyTo: '<lost@x>', subject: 'Re: Budget', date: t0 + 2 * DAY }));
    expect(b.threadId).toBe(a.threadId);
    const late = s.insertMessage(msg(f, { messageIdHdr: '<c@x>', subject: 'Re: Budget', date: t0 + 10 * DAY }));
    expect(late.threadId).not.toBe(a.threadId);
    // Same subject, not a reply: a separate thread («Your order» mail does not merge).
    const plain = s.insertMessage(msg(f, { messageIdHdr: '<d@x>', subject: 'Budget', date: t0 + DAY }));
    expect(plain.threadId).not.toBe(a.threadId);
  });
  it('is idempotent per folder + uid', () => {
    const s = store();
    const f = s.upsertFolder({ path: 'INBOX', name: 'INBOX', delimiter: '/', parentPath: '', role: 'inbox', specialUse: null });
    const m = msg(f);
    expect(s.insertMessage(m).inserted).toBe(true);
    expect(s.insertMessage(m).inserted).toBe(false);
  });
});

describe('thread rows and paging', () => {
  it('one row per thread (its newest message), keyset pages, counts across folders', () => {
    const s = store();
    const inbox = s.upsertFolder({ path: 'INBOX', name: 'INBOX', delimiter: '/', parentPath: '', role: 'inbox', specialUse: null });
    const sent = s.upsertFolder({ path: 'Sent', name: 'Sent', delimiter: '/', parentPath: '', role: 'sent', specialUse: '\\Sent' });
    const t0 = 1_700_000_000_000;
    s.insertMessage(msg(inbox, { messageIdHdr: '<1@x>', date: t0, flags: { seen: true, flagged: false, answered: false } }));
    s.insertMessage(msg(sent, { messageIdHdr: '<2@x>', inReplyTo: '<1@x>', date: t0 + 1000 }));
    s.insertMessage(msg(inbox, { messageIdHdr: '<3@x>', inReplyTo: '<2@x>', references: ['<1@x>', '<2@x>'], date: t0 + 2000, flags: { seen: false, flagged: true, answered: false } }));
    for (let i = 0; i < 5; i++) s.insertMessage(msg(inbox, { messageIdHdr: `<solo${String(i)}@x>`, subject: `Solo ${String(i)}`, date: t0 - (i + 1) * 1000 }));
    const p1 = s.listThreads({ kind: 'folder', row: inbox }, { limit: 3 });
    expect(p1.map((r) => r.subject)).toEqual(['Hello', 'Solo 0', 'Solo 1']);
    expect(p1[0]).toMatchObject({ count: 3, unread: true, flagged: true });
    const last = p1[2];
    if (!last) throw new Error('no row');
    const p2 = s.listThreads({ kind: 'folder', row: inbox }, { limit: 3, before: { date: last.date, id: last.messageId } });
    expect(p2.map((r) => r.subject)).toEqual(['Solo 2', 'Solo 3', 'Solo 4']);
    expect(s.listThreads({ kind: 'folder', row: inbox }, { limit: 50, unreadOnly: true })).toHaveLength(6);
    const starred = s.listThreads({ kind: 'flagged', exclude: [] }, { limit: 10, rowFolder: `${ACC}.starred` });
    expect(starred).toHaveLength(1);
    expect(starred[0]?.folderId).toBe(`${ACC}.starred`);
  });
  it('threadRow finds the current row or null after removal', () => {
    const s = store();
    const inbox = s.upsertFolder({ path: 'INBOX', name: 'INBOX', delimiter: '/', parentPath: '', role: 'inbox', specialUse: null });
    const a = s.insertMessage(msg(inbox, { messageIdHdr: '<1@x>' }));
    expect(s.threadRow(a.threadId, { kind: 'folder', row: inbox })?.messageId).toBe(a.id);
    s.deleteMessages([a.id]);
    expect(s.threadRow(a.threadId, { kind: 'folder', row: inbox })).toBeNull();
  });
});

describe('search (FTS5)', () => {
  it('matches subject, sender, snippet and body text by prefix, Cyrillic included', () => {
    const s = store();
    const inbox = s.upsertFolder({ path: 'INBOX', name: 'INBOX', delimiter: '/', parentPath: '', role: 'inbox', specialUse: null });
    const a = s.insertMessage(msg(inbox, { subject: 'Квартальный отчёт', from: { name: 'Мария', address: 'maria@corp.ru' } }));
    s.insertMessage(msg(inbox, { subject: 'Lunch', snippet: 'pizza today?' }));
    s.setBody(a.id, { html: null, text: 'Бюджет на третий квартал утверждён', inReplyTo: '', references: [], remoteImages: false }, []);
    const q = (t: string): string[] => s.listThreads({ kind: 'all', exclude: [] }, { limit: 10, match: ftsQuery(t) ?? '' }).map((r) => r.subject);
    expect(q('квартал')).toEqual(['Квартальный отчёт']);
    expect(q('мари')).toEqual(['Квартальный отчёт']);
    expect(q('утвержд')).toEqual(['Квартальный отчёт']);
    expect(q('pizza')).toEqual(['Lunch']);
    expect(q('nothing')).toEqual([]);
  });
  it('turns user text into safe quoted prefix terms', () => {
    expect(ftsQuery('hello "world" OR x*')).toBe('"hello"* "world"* "OR"* "x"*');
    expect(ftsQuery('  ')).toBeNull();
  });
});

describe('blobs', () => {
  it('evicts least recently used blobs down to the limit and forgets their bodies', () => {
    let t = 1000;
    const s = store(() => t);
    const inbox = s.upsertFolder({ path: 'INBOX', name: 'INBOX', delimiter: '/', parentPath: '', role: 'inbox', specialUse: null });
    const a = s.insertMessage(msg(inbox));
    const b = s.insertMessage(msg(inbox));
    s.setBody(a.id, { html: null, text: 'a'.repeat(1000), inReplyTo: '', references: [], remoteImages: false }, [
      { id: '0', name: 'x.bin', mime: 'application/octet-stream', size: 2000, inline: false, data: new Uint8Array(2000) },
    ]);
    t = 2000;
    s.setBody(b.id, { html: null, text: 'b'.repeat(1000), inReplyTo: '', references: [], remoteImages: false }, []);
    expect(s.blobBytes()).toBeGreaterThan(3000);
    expect(s.evict(1500)).toBe(2);
    expect(s.header(a.id)?.bodyHash).toBeNull();
    expect(s.attachments(a.id)[0]?.hash).toBeNull();
    expect(s.header(b.id)?.bodyHash).not.toBeNull();
    s.clearBlobs();
    expect(s.blobBytes()).toBe(0);
    expect(s.header(b.id)?.bodyHash).toBeNull();
    expect(s.header(b.id)?.subject).toBe('Hello');
  });
});
