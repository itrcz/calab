import { beforeEach, describe, expect, it } from 'vitest';
import type { MailEvent, MailFolder, MailThreadRow } from '../../shared/mail';
import { ALL_INBOXES, boxUnread, inboxUnread, reduceEvent, resetMail, rowKey, useMail } from './mail';

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
  for (const k of s.order) {
    out.set(`row ${k}`, s.rows[k]); // MailRow
    out.set(`selected ${k}`, s.selected === k);
  }
  return out;
}

const changed = (a: Map<string, unknown>, b: Map<string, unknown>): string[] => [...a.keys()].filter((k) => !Object.is(a.get(k), b.get(k)));

describe('a mail event on a mailbox of 200 rows', () => {
  beforeEach(() => {
    resetMail();
    const rows = Array.from({ length: N }, (_, i) => row(i));
    useMail.setState({
      loaded: true,
      accountIds: ['a1'],
      accounts: { a1: {} as never },
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
});
