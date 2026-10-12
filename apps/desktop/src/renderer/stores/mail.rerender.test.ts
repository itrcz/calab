import { beforeEach, describe, expect, it } from 'vitest';
import type { MailAccount, MailEvent, MailFolder, MailThreadRow } from '../../shared/mail';
import { ALL_INBOXES, boxUnread, firstSyncAccount, inboxUnread, reduceEvent, resetMail, rowKey, scopeProblem, scopeSyncing, useMail } from './mail';
import { clearPicked, pickAll, togglePick, useMailUi } from './mailUi';

/**
 * Re-renders of a mail event (ADR-0088 §9, CLAUDE.md «Ререндеры»), proven on the store like
 * boards.rerender.test.ts: every selector the column, its rows and the rail tile subscribe with is
 * evaluated for a 200-row mailbox before and after an event; a component re-renders only when its
 * selector's result changes (Object.is), so the changed results are the re-rendered components.
 */

const N = 200;
const row = (i: number, over: Partial<MailThreadRow> = {}): MailThreadRow => ({
  threadId: `t${i}`,
  accountId: 'a1',
  folderId: 'a1/inbox',
  messageId: `m${String(i).padStart(4, '0')}`,
  messageIdHeader: '',
  from: { name: `S${i}`, address: `s${i}@x.io` },
  subject: `Subject ${i}`,
  snippet: 'preview',
  date: 10_000_000 - i * 1000,
  count: 1,
  unread: i % 3 === 0,
  flagged: false,
  hasAttachments: false,
  ...over,
});
const account = (id: string, over: Partial<MailAccount> = {}): MailAccount => ({
  id,
  email: `${id}@x.io`,
  name: '',
  provider: 'other',
  imap: { host: 'imap.x.io', port: 993, security: 'tls' },
  smtp: { host: 'smtp.x.io', port: 465, security: 'tls' },
  login: `${id}@x.io`,
  state: 'idle',
  error: null,
  lastSyncAt: 1,
  ...over,
});
const folder = (unread: number): MailFolder => ({ id: 'a1/inbox', accountId: 'a1', path: 'INBOX', name: 'INBOX', role: 'inbox', parentId: null, unread, total: N });

function apply(e: MailEvent): void {
  const patch = reduceEvent(useMail.getState(), e);
  if (patch) useMail.setState(patch);
}

/** The selectors components use, keyed by what they render. */
function snapshot(): Map<string, unknown> {
  const s = useMail.getState();
  const out = new Map<string, unknown>();
  out.set('list', s.order); // ThreadList
  out.set('badge', inboxUnread(s)); // MailTile on the rail
  out.set('switcher count', boxUnread(s, ALL_INBOXES)); // BoxItem (only while the switcher is open)
  out.set('screen', s.accountIds.length > 0); // MailScreen
  out.set('sync', scopeSyncing(s, s.box.scope)); // SyncControl (spinner ↔ button, progress line)
  out.set('notice', scopeProblem(s, s.box.scope)); // AccountNotice
  const first = firstSyncAccount(s, s.box.scope);
  out.set('first sync', first); // SyncControl / FirstSyncRow / EmptyList
  const p = s.syncProgress[first];
  // FirstSyncProgress: a useShallow slice of primitives (equal fields = no re-render).
  out.set('progress', first ? JSON.stringify([p?.phase, p?.folder?.name, p?.folder?.role, p?.done, p?.total]) : '');
  const picked = useMailUi.getState().picked;
  out.set('batch', picked.size > 1); // MailScreen: BatchView ↔ MailThread
  for (const k of s.order) {
    out.set(`row ${k}`, s.rows[k]); // MailRow
    out.set(`selected ${k}`, s.selected === k);
    out.set(`picked ${k}`, picked.has(k));
  }
  return out;
}

const changed = (a: Map<string, unknown>, b: Map<string, unknown>): string[] => [...a.keys()].filter((k) => !Object.is(a.get(k), b.get(k)));

describe('a mail event on a mailbox of 200 rows', () => {
  beforeEach(() => {
    resetMail();
    clearPicked();
    const rows = Array.from({ length: N }, (_, i) => row(i));
    useMail.setState({
      loaded: true,
      accountIds: ['a1', 'a2'],
      accounts: { a1: account('a1'), a2: account('a2') },
      folders: { a1: [folder(67)] },
      folderById: { 'a1/inbox': folder(67) },
      box: ALL_INBOXES,
      rows: Object.fromEntries(rows.map((r) => [rowKey(r), r])),
      order: rows.map(rowKey),
      next: { date: 0, id: '' },
      selected: rowKey(row(5)),
    });
  });

  it('messages_changed of one row re-renders that row only', () => {
    const before = snapshot();
    apply({ type: 'messages_changed', accountId: 'a1', folderId: 'a1/inbox', rows: [row(42, { unread: false, flagged: true })], messageIds: ['m0042'] });
    expect(changed(before, snapshot())).toEqual([`row ${rowKey(row(42))}`]);
  });

  it('the folder counters that follow re-render the badge (and the switcher count), no row', () => {
    const before = snapshot();
    apply({ type: 'folders', accountId: 'a1', folders: [folder(66)] });
    expect(changed(before, snapshot()).sort()).toEqual(['badge', 'switcher count']);
  });

  it('the same event twice changes nothing the second time', () => {
    const e: MailEvent = { type: 'messages_changed', accountId: 'a1', folderId: 'a1/inbox', rows: [row(7, { flagged: true })], messageIds: ['m0007'] };
    apply(e);
    const mid = snapshot();
    apply({ ...e, rows: [row(7, { flagged: true })] });
    expect(changed(mid, snapshot())).toEqual([]);
  });

  it('a new message on top re-renders the list and adds one row; the others keep their objects', () => {
    const before = snapshot();
    apply({ type: 'messages_added', accountId: 'a1', folderId: 'a1/inbox', rows: [row(-1)], messageIds: ['m00-1'] });
    const after = snapshot();
    expect(changed(before, after).filter((k) => before.has(k))).toEqual(['list']);
    expect(useMail.getState().order[0]).toBe(rowKey(row(-1)));
  });

  it('account_state (syncing) of one account re-renders the sync leaf only', () => {
    const before = snapshot();
    apply({ type: 'account_state', accountId: 'a2', account: account('a2', { state: 'syncing' }) });
    expect(changed(before, snapshot())).toEqual(['sync']);
    const mid = snapshot();
    // The other account starting too, or a second state event while syncing: nothing more.
    apply({ type: 'account_state', accountId: 'a1', account: account('a1', { state: 'syncing' }) });
    expect(changed(mid, snapshot())).toEqual([]);
  });

  it('sync_progress of a first sync re-renders the progress leaf only — never the list or a row', () => {
    apply({ type: 'account_state', accountId: 'a2', account: account('a2', { state: 'syncing', lastSyncAt: null }) });
    const before = snapshot();
    const progress = (done: number): MailEvent => ({ type: 'sync_progress', accountId: 'a2', folder: { id: 'a2/inbox', name: 'INBOX', role: 'inbox' }, done, total: 8400, phase: 'headers' });
    apply(progress(50));
    expect(changed(before, snapshot())).toEqual(['progress']);
    const mid = snapshot();
    apply(progress(250));
    expect(changed(mid, snapshot())).toEqual(['progress']);
    const mid2 = snapshot();
    apply(progress(250)); // the same numbers: nothing
    expect(changed(mid2, snapshot())).toEqual([]);
    // The sync ends: the leaves go (sync, first sync, progress); still no row.
    const end = snapshot();
    apply({ type: 'account_state', accountId: 'a2', account: account('a2', { state: 'idle', lastSyncAt: 5 }) });
    expect(changed(end, snapshot()).sort()).toEqual(['first sync', 'progress', 'sync']);
  });

  it('an account going offline re-renders the notice row only', () => {
    const before = snapshot();
    apply({ type: 'account_state', accountId: 'a1', account: account('a1', { state: 'offline', error: { code: 'NETWORK', message: 'x' } }) });
    expect(changed(before, snapshot())).toEqual(['notice']);
  });

  it('⌘-click picks re-render the toggled rows only (and the centre once it becomes a batch)', () => {
    const k = (i: number): string => rowKey(row(i));
    const before = snapshot();
    togglePick(k(9)); // row 5 was open: it joins the selection
    expect(changed(before, snapshot()).sort()).toEqual(['batch', `picked ${k(5)}`, `picked ${k(9)}`].sort());
    const mid = snapshot();
    togglePick(k(12));
    expect(changed(mid, snapshot())).toEqual([`picked ${k(12)}`]);
    const mid2 = snapshot();
    togglePick(k(12));
    expect(changed(mid2, snapshot())).toEqual([`picked ${k(12)}`]);
  });

  it('⌘A picks every loaded row; a second ⌘A changes nothing', () => {
    pickAll();
    expect(useMailUi.getState().picked.size).toBe(N);
    const mid = snapshot();
    pickAll();
    expect(changed(mid, snapshot())).toEqual([]);
  });
});
