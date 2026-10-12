import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailApiError, type MailApi, type MailFolder, type MailListQuery, type MailPage, type MailThreadRow } from '../../shared/mail';
import { createMockMailApi } from '../features/mail/mock/mockApi';
import {
  ALL_INBOXES,
  applyRows,
  inboxUnread,
  initMail,
  loadMore,
  moveRows,
  placeRow,
  reduceEvent,
  resetMail,
  rowKey,
  selectBox,
  setRowFlags,
  useMail,
  type MailState,
} from './mail';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const row = (n: number, over: Partial<MailThreadRow> = {}): MailThreadRow => ({
  threadId: `t${n}`,
  accountId: 'a1',
  folderId: 'a1/inbox',
  messageId: `m${String(n).padStart(3, '0')}`,
  messageIdHeader: '',
  from: { name: `Sender ${n}`, address: `s${n}@x.io` },
  subject: `Subject ${n}`,
  snippet: 'text',
  date: 1_000_000 - n * 1000,
  count: 1,
  unread: false,
  flagged: false,
  hasAttachments: false,
  ...over,
});

const inbox: MailFolder = { id: 'a1/inbox', accountId: 'a1', path: 'INBOX', name: 'INBOX', role: 'inbox', parentId: null, unread: 3, total: 10 };

/** A paged fake engine: `rows` sorted newest first, pages of `limit`. */
function pagedApi(all: MailThreadRow[], over: Partial<MailApi['messages']> = {}): MailApi {
  const list = vi.fn((q: MailListQuery): Promise<MailPage> => {
    const after = q.before ? all.filter((r) => r.date < (q.before?.date ?? 0)) : all;
    const rows = after.slice(0, q.limit);
    const last = rows[rows.length - 1];
    return Promise.resolve({ rows, next: after.length > q.limit && last ? { date: last.date, id: last.messageId } : null });
  });
  return {
    accounts: { list: () => Promise.resolve([{ id: 'a1', email: 'me@x.io', name: '', provider: 'other', imap: { host: 'h', port: 993, security: 'tls' }, smtp: { host: 'h', port: 465, security: 'tls' }, login: 'me@x.io', state: 'idle', error: null, lastSyncAt: null }]) },
    folders: { list: () => Promise.resolve([inbox]) },
    settings: { get: () => Promise.resolve({ remoteImages: 'ask', remoteImageSenders: [], notify: true, signatures: {}, cacheLimitBytes: 1 }) },
    outgoing: { list: () => Promise.resolve([]) },
    messages: { list, thread: () => Promise.resolve([]), get: () => Promise.reject(new Error('no')), ...over },
    onEvent: () => () => undefined,
  } as unknown as MailApi;
}

beforeEach(() => resetMail());
afterEach(() => resetMail());

describe('placeRow', () => {
  const rows = Object.fromEntries([1, 2, 4].map((n) => [rowKey(row(n)), row(n)]));
  const order = [1, 2, 4].map((n) => rowKey(row(n)));
  it('inserts in date order inside the loaded range', () => {
    const r3 = row(3);
    const map = { ...rows, [rowKey(r3)]: r3 };
    expect(placeRow(order, map, r3, false)).toEqual([1, 2, 3, 4].map((n) => rowKey(row(n))));
  });
  it('leaves rows older than the last loaded one to the next page', () => {
    const r9 = row(9);
    expect(placeRow(order, { ...rows, [rowKey(r9)]: r9 }, r9, false)).toBe(order);
    expect(placeRow(order, { ...rows, [rowKey(r9)]: r9 }, r9, true)).toEqual([...order, rowKey(r9)]);
  });
  it('moves a row whose thread got a newer message to the top', () => {
    const newer = row(4, { date: 2_000_000, messageId: 'm999' });
    expect(placeRow(order, { ...rows, [rowKey(newer)]: newer }, newer, false)[0]).toBe(rowKey(newer));
  });
});

describe('paging', () => {
  it('loads the first page, then the next one by cursor without duplicates', async () => {
    const all = Array.from({ length: 120 }, (_, i) => row(i + 1));
    await initMail(pagedApi(all));
    let s = useMail.getState();
    expect(s.order).toHaveLength(50);
    expect(s.next).not.toBeNull();
    await loadMore();
    await loadMore();
    s = useMail.getState();
    expect(s.order).toHaveLength(120);
    expect(new Set(s.order).size).toBe(120);
    expect(s.next).toBeNull();
    expect(s.order[0]).toBe(rowKey(row(1)));
  });
});

describe('optimistic actions roll back on refusal (§5)', () => {
  it('flags: applied at once, restored when the engine refuses', async () => {
    let reject: (e: unknown) => void = () => undefined;
    const api = pagedApi([row(1, { unread: true }), row(2)], { setFlags: () => new Promise((_, r) => (reject = r)) });
    await initMail(api);
    const k = rowKey(row(1));
    const before = useMail.getState().rows[k];
    const p = setRowFlags([k], { seen: true });
    expect(useMail.getState().rows[k]?.unread).toBe(false);
    reject(new MailApiError({ code: 'NETWORK', message: 'down' }));
    await p;
    expect(useMail.getState().rows[k]).toBe(before);
  });

  it('move: the row leaves at once, the selection goes to the next row, and it comes back on failure', async () => {
    const api = pagedApi([row(1), row(2), row(3)], { trash: () => Promise.reject(new MailApiError({ code: 'NETWORK', message: 'down' })) });
    await initMail(api);
    const [k1, k2] = [rowKey(row(1)), rowKey(row(2))];
    useMail.setState({ selected: k2 });
    const p = moveRows([k2], { kind: 'trash' });
    expect(useMail.getState().order).not.toContain(k2);
    expect(useMail.getState().selected).toBe(rowKey(row(3)));
    await p;
    expect(useMail.getState().order).toEqual([k1, k2, rowKey(row(3))]);
  });
});

describe('events', () => {
  const base = (): MailState => ({ ...useMail.getState(), folders: { a1: [inbox] }, folderById: { [inbox.id]: inbox }, box: ALL_INBOXES });

  it('an identical row keeps its object (no re-render)', () => {
    const r = row(1);
    const s: MailState = { ...base(), rows: { [rowKey(r)]: r }, order: [rowKey(r)] };
    expect(applyRows(s, [{ ...r }], true)).toBeNull();
  });

  it('a row of another folder is ignored; a search does not take new rows', () => {
    const s = { ...base(), order: [], rows: {} };
    expect(applyRows(s, [row(5, { folderId: 'a1/sent' })], true)).toBeNull();
    expect(applyRows({ ...s, query: 'x' }, [row(5)], true)).toBeNull();
    expect(applyRows(s, [row(5)], true)?.order).toEqual([rowKey(row(5))]);
  });

  it('messages_removed drops the rows; account removal clears its data and the box', () => {
    const r = row(1);
    const s: MailState = { ...base(), rows: { [rowKey(r)]: r }, order: [rowKey(r)], box: { scope: 'a1', folder: 'inbox' }, accounts: {}, accountIds: ['a1'] };
    expect(reduceEvent(s, { type: 'messages_removed', accountId: 'a1', folderId: 'a1/inbox', threadIds: ['t1'], messageIds: ['m001'] })?.order).toEqual([]);
    s.accounts = { a1: {} as never };
    const gone = reduceEvent(s, { type: 'account_state', accountId: 'a1', account: null });
    expect(gone?.order).toEqual([]);
    expect(gone?.box).toEqual(ALL_INBOXES);
  });

  it('the rail badge is one number: inbox unread across accounts', () => {
    const f2: MailFolder = { ...inbox, id: 'a2/inbox', accountId: 'a2', unread: 4 };
    const spam: MailFolder = { ...inbox, id: 'a2/junk', role: 'junk', unread: 9 };
    expect(inboxUnread({ folders: { a1: [inbox], a2: [f2, spam] } })).toBe(7);
  });
});

describe('against the mock engine', () => {
  it('opens «Все входящие», switches mailboxes and patches rows from events', async () => {
    await initMail(createMockMailApi({ delayMs: 0, now: () => Date.UTC(2026, 9, 12, 9) }));
    const s = useMail.getState();
    expect(s.accountIds).toEqual(['acc-gmail', 'acc-work']);
    expect(s.order.length).toBeGreaterThan(10);
    expect(inboxUnread(s)).toBeGreaterThan(0);
    const k = s.order[0] ?? '';
    const r = s.rows[k];
    if (!r) throw new Error('no row');
    await setRowFlags([k], { flagged: !r.flagged });
    await flush();
    expect(useMail.getState().rows[k]?.flagged).toBe(!r.flagged);
    selectBox({ scope: 'acc-work', folder: 'sent' });
    await flush();
    const sent = useMail.getState();
    expect(sent.order.length).toBeGreaterThan(0);
    expect(sent.order.every((key) => sent.rows[key]?.folderId === 'acc-work/sent')).toBe(true);
  });
});
