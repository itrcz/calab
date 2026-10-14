import { describe, expect, it } from 'vitest';
import type { MailEvent, MailThreadRow } from '../../shared/mail';
import { EventCoalescer } from './events';

const row = (threadId: string, subject = 's'): MailThreadRow => ({
  threadId,
  accountId: 'a',
  folderId: 'f',
  messageId: `${threadId}m`,
  messageIdHeader: '',
  from: { name: '', address: 'x@y.z' },
  subject,
  snippet: '',
  date: 1,
  count: 1,
  unread: false,
  flagged: false,
  hasAttachments: false,
});

function setup(): { c: EventCoalescer; sent: MailEvent[]; tick: () => void } {
  const sent: MailEvent[] = [];
  let pending: Array<() => void> = [];
  const c = new EventCoalescer((e) => sent.push(e), 250, {
    set: (fn) => {
      pending.push(fn);
      return pending.length;
    },
    clear: () => undefined,
  });
  return {
    c,
    sent,
    tick: () => {
      const p = pending;
      pending = [];
      for (const fn of p) fn();
    },
  };
}

describe('event coalescing', () => {
  it('first event at once, the rest merged into one per window (rows by thread, newest wins)', () => {
    const { c, sent, tick } = setup();
    c.emit({ type: 'messages_changed', accountId: 'a', folderId: 'f', rows: [row('t1', 'v1')], messageIds: ['m1'] });
    c.emit({ type: 'messages_changed', accountId: 'a', folderId: 'f', rows: [row('t1', 'v2'), row('t2')], messageIds: ['m2'] });
    c.emit({ type: 'messages_changed', accountId: 'a', folderId: 'f', rows: [row('t1', 'v3')], messageIds: ['m1'] });
    expect(sent).toHaveLength(1);
    tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ rows: [{ threadId: 't1', subject: 'v3' }, { threadId: 't2' }], messageIds: ['m2', 'm1'] });
    tick(); // nothing pending: the window closes
    tick();
    expect(sent).toHaveLength(2);
    c.emit({ type: 'messages_changed', accountId: 'a', folderId: 'f', rows: [row('t3')], messageIds: [] });
    expect(sent).toHaveLength(3);
  });
  it('separate folders and types do not wait for each other; new_mail is never merged', () => {
    const { c, sent } = setup();
    c.emit({ type: 'messages_added', accountId: 'a', folderId: 'f1', rows: [row('t1')], messageIds: [] });
    c.emit({ type: 'messages_added', accountId: 'a', folderId: 'f2', rows: [row('t1')], messageIds: [] });
    c.emit({ type: 'messages_changed', accountId: 'a', folderId: 'f1', rows: [row('t1')], messageIds: [] });
    for (let i = 0; i < 3; i++) c.emit({ type: 'new_mail', accountId: 'a', messageId: String(i), threadId: 't', from: { name: '', address: 'x@y.z' }, subject: '' });
    expect(sent).toHaveLength(6);
  });
  it('an upsert cancels a pending removal of the same thread and vice versa', () => {
    const { c, sent, tick } = setup();
    c.emit({ type: 'messages_removed', accountId: 'a', folderId: 'f', threadIds: ['t0'], messageIds: [] });
    c.emit({ type: 'messages_changed', accountId: 'a', folderId: 'f', rows: [row('t9')], messageIds: [] });
    c.emit({ type: 'messages_removed', accountId: 'a', folderId: 'f', threadIds: ['t1'], messageIds: [] }); // pending
    c.emit({ type: 'messages_changed', accountId: 'a', folderId: 'f', rows: [row('t2')], messageIds: [] }); // pending
    c.emit({ type: 'messages_added', accountId: 'a', folderId: 'f', rows: [row('t1')], messageIds: [] }); // t1 back
    c.emit({ type: 'messages_removed', accountId: 'a', folderId: 'f', threadIds: ['t2'], messageIds: [] }); // t2 gone
    tick();
    const removed = sent.filter((e) => e.type === 'messages_removed');
    expect(removed.at(-1)).toMatchObject({ threadIds: ['t2'] });
    const changed = sent.flatMap((e) => (e.type === 'messages_changed' ? [e.rows.map((r) => r.threadId)] : []));
    expect(changed).toEqual([['t9']]);
  });
  it('sync_progress: ≤ 2 per second per account (500 ms window, newest wins); an account state drops the pending one', () => {
    const sent: MailEvent[] = [];
    const windows: number[] = [];
    let pending: Array<() => void> = [];
    const c = new EventCoalescer((e) => sent.push(e), 250, {
      set: (fn, ms) => {
        windows.push(ms);
        pending.push(fn);
        return pending.length;
      },
      clear: () => undefined,
    });
    const tick = (): void => {
      const p = pending;
      pending = [];
      for (const fn of p) fn();
    };
    const progress = (accountId: string, done: number): MailEvent => ({ type: 'sync_progress', accountId, folder: { id: 'f', name: 'INBOX', role: 'inbox' }, done, total: 100, phase: 'headers' });
    for (let i = 1; i <= 10; i++) c.emit(progress('a', i * 10));
    c.emit(progress('b', 5));
    expect(sent.map((e) => (e.type === 'sync_progress' ? `${e.accountId}:${String(e.done)}` : e.type))).toEqual(['a:10', 'b:5']);
    expect(windows).toEqual([500, 500]);
    tick();
    expect(sent.at(-1)).toMatchObject({ accountId: 'a', done: 100 });
    c.emit(progress('a', 100));
    c.emit({ type: 'account_state', accountId: 'a', account: null });
    tick();
    expect(sent.filter((e) => e.type === 'sync_progress')).toHaveLength(3);
  });
});
