import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MailEvent, MailFlags } from '../../shared/mail';
import type { ImapSession, RemoteFlags, RemoteFolder, RemoteHeader, SelectInfo } from './session';
import { MailStore } from './store';
import { AccountSync, assignRoles, diffFlags, vanished, WINDOW_MS } from './sync';

const ACC = 'a00000000000000aa';
const NOW = 1_750_000_000_000;

interface FakeFolder {
  info: RemoteFolder;
  uidValidity: string;
  uidNext: number;
  modseq: number;
  msgs: Map<number, { h: RemoteHeader; modseq: number }>;
}

const flags = (f: Partial<MailFlags> = {}): MailFlags => ({ seen: false, flagged: false, answered: false, ...f });

/** An in-memory IMAP server behind the ImapSession interface. */
class FakeImap implements ImapSession {
  condstore = true;
  folders = new Map<string, FakeFolder>();
  selected = '';
  calls: string[] = [];
  private closeCbs: Array<() => void> = [];

  addFolder(path: string, specialUse: string | null = null): FakeFolder {
    const f: FakeFolder = { info: { path, name: path.split('/').pop() ?? path, delimiter: '/', parentPath: '', specialUse, flags: [] }, uidValidity: '1', uidNext: 1, modseq: 1, msgs: new Map() };
    this.folders.set(path, f);
    return f;
  }

  deliver(path: string, h: Partial<RemoteHeader> = {}): number {
    const f = this.folders.get(path);
    if (!f) throw new Error('no folder');
    const uid = f.uidNext++;
    f.modseq++;
    f.msgs.set(uid, {
      modseq: f.modseq,
      h: {
        uid,
        flags: flags(),
        messageIdHdr: `<${path}-${String(uid)}@x>`,
        inReplyTo: '',
        references: [],
        from: { name: 'Sender', address: 'sender@example.org' },
        to: [],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: `Message ${String(uid)}`,
        snippet: 'text',
        date: NOW - 1000 * uid,
        size: 10,
        hasAttachments: false,
        ...h,
      },
    });
    return uid;
  }

  setFlag(path: string, uid: number, f: Partial<MailFlags>): void {
    const fo = this.folders.get(path);
    const m = fo?.msgs.get(uid);
    if (!fo || !m) throw new Error('no message');
    fo.modseq++;
    m.h = { ...m.h, flags: { ...m.h.flags, ...f } };
    m.modseq = fo.modseq;
  }

  private cur(): FakeFolder {
    const f = this.folders.get(this.selected);
    if (!f) throw new Error('nothing selected');
    return f;
  }

  private range(r: string): number[] {
    const f = this.cur();
    const uids = [...f.msgs.keys()].sort((a, b) => a - b);
    const max = uids[uids.length - 1] ?? 0;
    const out = new Set<number>();
    for (const part of r.split(',')) {
      const [a, b] = part.split(':');
      const lo = Number(a);
      const hi = b === undefined ? lo : b === '*' ? max : Number(b);
      const [x, y] = lo <= hi ? [lo, hi] : [hi, lo];
      for (const u of uids) if (u >= x && u <= y) out.add(u);
      // IMAP quirk: `n:*` with n > max still returns the last message.
      if (b === '*' && lo > max && max) out.add(max);
    }
    return [...out];
  }

  list(): Promise<RemoteFolder[]> {
    return Promise.resolve([...this.folders.values()].map((f) => f.info));
  }
  select(path: string): Promise<SelectInfo> {
    this.selected = path;
    this.calls.push(`select ${path}`);
    const f = this.cur();
    return Promise.resolve({ uidValidity: f.uidValidity, uidNext: f.uidNext, exists: f.msgs.size, highestModseq: this.condstore ? String(f.modseq) : null });
  }
  searchDate(since?: Date, before?: Date): Promise<number[]> {
    return Promise.resolve(
      [...this.cur().msgs.values()].filter((m) => (!since || m.h.date >= since.getTime()) && (!before || m.h.date < before.getTime())).map((m) => m.h.uid),
    );
  }
  searchUids(range: string): Promise<number[]> {
    return Promise.resolve(this.range(range));
  }
  fetchHeaders(uids: number[] | string): Promise<RemoteHeader[]> {
    const list = typeof uids === 'string' ? this.range(uids) : uids;
    this.calls.push(`headers ${String(list.length)}`);
    return Promise.resolve(list.map((u) => this.cur().msgs.get(u)?.h).filter((h): h is RemoteHeader => !!h));
  }
  fetchFlags(range: string, changedSince?: string): Promise<RemoteFlags[]> {
    this.calls.push(`flags ${changedSince ?? 'all'}`);
    return Promise.resolve(
      this.range(range)
        .map((u) => this.cur().msgs.get(u))
        .filter((m): m is { h: RemoteHeader; modseq: number } => !!m && (!changedSince || m.modseq > Number(changedSince)))
        .map((m) => ({ uid: m.h.uid, flags: m.h.flags })),
    );
  }
  fetchSource(): Promise<Buffer | null> {
    return Promise.resolve(Buffer.from('Subject: x\r\n\r\nbody'));
  }
  failNext: Error | null = null;
  storeFlags(uids: number[], add: string[], remove: string[]): Promise<void> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      return Promise.reject(e);
    }
    for (const u of uids) {
      const p: Partial<MailFlags> = {};
      for (const f of add) if (f === '\\Seen') p.seen = true;
      for (const f of remove) if (f === '\\Seen') p.seen = false;
      for (const f of add) if (f === '\\Flagged') p.flagged = true;
      for (const f of remove) if (f === '\\Flagged') p.flagged = false;
      this.setFlag(this.selected, u, p);
    }
    return Promise.resolve();
  }
  move(uids: number[], destination: string): Promise<Map<number, number> | null> {
    const src = this.cur();
    const map = new Map<number, number>();
    for (const u of uids) {
      const m = src.msgs.get(u);
      if (!m) continue;
      src.msgs.delete(u);
      const prev = this.selected;
      const nu = this.deliver(destination, { ...m.h });
      this.selected = prev;
      map.set(u, nu);
    }
    return Promise.resolve(map);
  }
  expunge(uids: number[]): Promise<void> {
    for (const u of uids) this.cur().msgs.delete(u);
    return Promise.resolve();
  }
  expungeAll(): Promise<void> {
    this.calls.push('expunge all');
    this.cur().msgs.clear();
    return Promise.resolve();
  }
  append(): Promise<void> {
    return Promise.resolve();
  }
  createFolder(path: string): Promise<void> {
    this.addFolder(path);
    return Promise.resolve();
  }
  rest(inbox: string): Promise<void> {
    this.selected = inbox;
    return Promise.resolve();
  }
  onChange(): void {
    // the fake has no unsolicited updates
  }
  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }
  close(): Promise<void> {
    for (const cb of this.closeCbs) cb();
    return Promise.resolve();
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(imap = new FakeImap()): { imap: FakeImap; store: MailStore; sync: AccountSync; events: MailEvent[]; states: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'calab-mail-sync-'));
  dirs.push(dir);
  const store = new MailStore(dir, ACC, () => NOW);
  const events: MailEvent[] = [];
  const states: string[] = [];
  const sync: AccountSync = new AccountSync({
    store,
    accountId: ACC,
    email: 'me@example.org',
    provider: 'other',
    connect: () => Promise.resolve(imap),
    emit: (e) => events.push(e),
    stateChanged: () => states.push(sync.state),
    cacheLimit: () => 1 << 30,
    now: () => NOW,
    log: () => undefined,
    // No timers in these tests: polls / backoff never fire.
    setTimer: () => null,
    clearTimer: () => undefined,
  });
  return { imap, store, sync, events, states };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

describe('pure reconciliation', () => {
  it('diffFlags reports only changed known messages', () => {
    const local = new Map([
      [1, { id: 'm1', threadId: 't1', ...flags() }],
      [2, { id: 'm2', threadId: 't2', ...flags({ seen: true }) }],
    ]);
    const d = diffFlags(local, [
      { uid: 1, flags: flags({ seen: true }) },
      { uid: 2, flags: flags({ seen: true }) },
      { uid: 3, flags: flags({ flagged: true }) },
    ]);
    expect(d).toEqual([{ uid: 1, id: 'm1', threadId: 't1', flags: flags({ seen: true }) }]);
  });
  it('vanished = local uids up to max missing on the server', () => {
    expect(vanished([1, 2, 3, 9], new Set([1, 3]), 5)).toEqual([2]);
  });
  it('assigns roles: SPECIAL-USE, Gmail \\All as archive, Russian names, one folder per role', () => {
    const f = (path: string, specialUse: string | null = null, fl: string[] = []): RemoteFolder => ({ path, name: path.split('/').pop() ?? path, delimiter: '/', parentPath: '', specialUse, flags: fl });
    const roles = assignRoles([
      f('INBOX'),
      f('[Gmail]', null, ['\\Noselect']),
      f('[Gmail]/All Mail', '\\All'),
      f('[Gmail]/Starred', '\\Flagged'),
      f('Отправленные'),
      f('Корзина'),
      f('Спам'),
      f('Trash'),
    ]);
    expect(Object.fromEntries(roles)).toEqual({
      INBOX: 'inbox',
      '[Gmail]/All Mail': 'archive',
      '[Gmail]/Starred': 'starred',
      Отправленные: 'sent',
      Корзина: 'trash',
      Спам: 'junk',
    });
  });
});

describe('AccountSync against a fake server', () => {
  it('initial sync: 90-day window, folders listed, no new_mail on the first sync, then new_mail', async () => {
    const { imap, store, sync, events } = setup();
    imap.addFolder('INBOX');
    imap.addFolder('Sent', '\\Sent');
    imap.deliver('INBOX');
    imap.deliver('INBOX', { date: NOW - WINDOW_MS - 1000 }); // outside the window
    sync.start();
    await settle();
    expect(sync.state).toBe('idle');
    const inbox = store.folderByRole('inbox');
    if (!inbox) throw new Error('no inbox');
    expect(store.folderCounts(inbox.row).total).toBe(1);
    expect(events.some((e) => e.type === 'new_mail')).toBe(false);
    const roles = sync.folders().map((f) => f.role);
    expect(roles).toEqual(expect.arrayContaining(['inbox', 'sent', 'starred', 'drafts', 'outbox']));

    imap.deliver('INBOX', { subject: 'Fresh', from: { name: 'Boss', address: 'boss@example.org' } });
    imap.deliver('INBOX', { subject: 'Mine', from: { name: 'Me', address: 'me@example.org' } });
    events.length = 0;
    await sync.run((s) => sync.syncFolder(s, inbox));
    const nm = events.filter((e) => e.type === 'new_mail');
    expect(nm).toHaveLength(1);
    expect(nm[0]).toMatchObject({ subject: 'Fresh' });
    expect(events.some((e) => e.type === 'messages_added')).toBe(true);
  });

  it('flag changes: CONDSTORE delta, and a full diff without it', async () => {
    const { imap, store, sync, events } = setup();
    imap.addFolder('INBOX');
    const u = imap.deliver('INBOX');
    sync.start();
    await settle();
    const inbox = store.folderByRole('inbox');
    if (!inbox) throw new Error('no inbox');
    imap.setFlag('INBOX', u, { seen: true });
    imap.calls.length = 0;
    events.length = 0;
    await sync.run((s) => sync.syncFolder(s, inbox));
    expect(imap.calls).toContain('flags 2');
    expect(store.localFlags(inbox.row).get(u)?.seen).toBe(true);
    expect(events.find((e) => e.type === 'messages_changed')).toMatchObject({ rows: [{ unread: false }] });

    imap.condstore = false;
    imap.setFlag('INBOX', u, { flagged: true });
    imap.calls.length = 0;
    await sync.run((s) => sync.syncFolder(s, store.folder(inbox.row) ?? inbox));
    expect(imap.calls).toContain('flags all');
    expect(store.localFlags(inbox.row).get(u)?.flagged).toBe(true);
  });

  it('expunged on the server → removed locally with messages_removed', async () => {
    const { imap, store, sync, events } = setup();
    const f = imap.addFolder('INBOX');
    imap.deliver('INBOX');
    const u2 = imap.deliver('INBOX');
    sync.start();
    await settle();
    f.msgs.delete(u2);
    events.length = 0;
    const inbox = store.folderByRole('inbox');
    if (!inbox) throw new Error('no inbox');
    await sync.run((s) => sync.syncFolder(s, inbox));
    expect(store.folderCounts(inbox.row).total).toBe(1);
    expect(events.find((e) => e.type === 'messages_removed')).toMatchObject({ messageIds: [expect.stringMatching(/\.2$/)] });
  });

  it('UIDVALIDITY change rebuilds the folder with new ids', async () => {
    const { imap, store, sync, events } = setup();
    const f = imap.addFolder('INBOX');
    imap.deliver('INBOX');
    sync.start();
    await settle();
    const inbox = store.folderByRole('inbox');
    if (!inbox) throw new Error('no inbox');
    const before = [...store.localFlags(inbox.row).values()].map((x) => x.id);
    f.uidValidity = '99';
    events.length = 0;
    await sync.run((s) => sync.syncFolder(s, store.folder(inbox.row) ?? inbox));
    const after = [...store.localFlags(inbox.row).values()].map((x) => x.id);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0]).toContain('.99.');
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['messages_removed', 'messages_added']));
  });

  it('threads replies across folders', async () => {
    const { imap, store, sync } = setup();
    imap.addFolder('INBOX');
    imap.addFolder('Sent', '\\Sent');
    imap.deliver('INBOX', { messageIdHdr: '<q@x>', subject: 'Question', date: NOW - 5000 });
    imap.deliver('Sent', { messageIdHdr: '<a@x>', inReplyTo: '<q@x>', references: ['<q@x>'], subject: 'Re: Question', date: NOW - 4000 });
    sync.start();
    await settle();
    const inbox = store.folderByRole('inbox');
    if (!inbox) throw new Error('no inbox');
    const rows = store.listThreads({ kind: 'folder', row: inbox.row }, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(2);
    expect(store.thread(rows[0]?.threadId ?? '').map((h) => h.subject)).toEqual(['Question', 'Re: Question']);
  });

  it('local-first flags, rolled back when the server rejects them', async () => {
    const { imap, store, sync, events } = setup();
    imap.addFolder('INBOX');
    const u = imap.deliver('INBOX');
    sync.start();
    await settle();
    const inbox = store.folderByRole('inbox');
    if (!inbox) throw new Error('no inbox');
    const id = store.localFlags(inbox.row).get(u)?.id ?? '';
    imap.failNext = Object.assign(new Error('NO [CANNOT] read-only'), { code: 'NOPE' });
    events.length = 0;
    sync.setFlags([id], { seen: true });
    expect(store.header(id)?.flags.seen).toBe(true); // at once
    await settle();
    expect(store.header(id)?.flags.seen).toBe(false); // rolled back
    expect(events.filter((e) => e.type === 'messages_changed').length).toBeGreaterThanOrEqual(2);
    sync.setFlags([id], { seen: true });
    await settle();
    expect(imap.folders.get('INBOX')?.msgs.get(u)?.h.flags.seen).toBe(true);
  });

  it('archive creates the folder when missing and moves; trash in trash deletes', async () => {
    const { imap, store, sync } = setup();
    imap.addFolder('INBOX');
    imap.addFolder('Trash', '\\Trash');
    const u = imap.deliver('INBOX');
    imap.deliver('Trash');
    sync.start();
    await settle();
    const inbox = store.folderByRole('inbox');
    const trash = store.folderByRole('trash');
    if (!inbox || !trash) throw new Error('folders');
    const id = store.localFlags(inbox.row).get(u)?.id ?? '';
    sync.archive([id]);
    expect(store.header(id)).toBeNull();
    await settle();
    expect(imap.folders.get('Archive')?.msgs.size).toBe(1);
    const arch = store.folderByRole('archive');
    expect(arch && store.folderCounts(arch.row).total).toBe(1);
    const tid = [...store.localFlags(trash.row).values()][0]?.id ?? '';
    sync.trash([tid]);
    await settle();
    expect(imap.folders.get('Trash')?.msgs.size).toBe(0);
  });

  it('folders.empty: trash / junk only; expunges everything on the server (beyond the window too), then locally', async () => {
    const { imap, store, sync, events } = setup();
    imap.addFolder('INBOX');
    imap.addFolder('Trash', '\\Trash');
    imap.deliver('INBOX');
    imap.deliver('Trash');
    imap.deliver('Trash');
    // Older than the 90-day window: never synced locally, still deleted on the server.
    imap.deliver('Trash', { date: NOW - 200 * 86_400_000 });
    sync.start();
    await settle();
    const inbox = store.folderByRole('inbox');
    const trash = store.folderByRole('trash');
    if (!inbox || !trash) throw new Error('folders');
    expect(store.localFlags(trash.row).size).toBe(2);
    await expect(sync.emptyFolder(inbox.row)).rejects.toMatchObject({ code: 'INVALID' });
    expect(imap.folders.get('INBOX')?.msgs.size).toBe(1);
    events.length = 0;
    await sync.emptyFolder(trash.row);
    expect(imap.calls).toContain('expunge all');
    expect(imap.folders.get('Trash')?.msgs.size).toBe(0);
    expect(store.localFlags(trash.row).size).toBe(0);
    expect(store.localFlags(inbox.row).size).toBe(1);
    expect(events.some((e) => e.type === 'messages_removed' && e.messageIds.length === 2)).toBe(true);
    expect(events.some((e) => e.type === 'folders')).toBe(true);
  });

  it('folders.empty offline: NETWORK, nothing removed locally', async () => {
    const { imap, store, sync } = setup();
    imap.addFolder('INBOX');
    imap.addFolder('Junk', '\\Junk');
    imap.deliver('Junk');
    sync.start();
    await settle();
    const junk = store.folderByRole('junk');
    if (!junk) throw new Error('no junk');
    await sync.stop();
    await expect(sync.emptyFolder(junk.row)).rejects.toMatchObject({ code: 'NETWORK' });
    expect(store.localFlags(junk.row).size).toBe(1);
  });

  it('an auth failure stops in auth_failed (no reconnect loop)', async () => {
    const failing = setup();
    const states: string[] = [];
    const bad = new AccountSync({
      store: failing.store,
      accountId: ACC,
      email: 'me@example.org',
      provider: 'other',
      connect: () => Promise.reject(Object.assign(new Error('Authentication failed'), { authenticationFailed: true })),
      emit: () => undefined,
      stateChanged: () => states.push(bad.state),
      cacheLimit: () => 1 << 30,
      now: () => NOW,
      log: () => undefined,
      setTimer: () => null,
      clearTimer: () => undefined,
    });
    bad.start();
    await settle();
    expect(bad.state).toBe('auth_failed');
    expect(bad.error?.code).toBe('AUTH_FAILED');
  });
});
