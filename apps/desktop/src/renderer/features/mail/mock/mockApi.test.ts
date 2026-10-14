import { describe, expect, it } from 'vitest';
import type { MailEvent, MailThreadRow } from '../../../../shared/mail';
import { MOCK_NOW } from './fixtures';
import { createMockMailApi } from './mockApi';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const make = () => createMockMailApi({ delayMs: 0, now: () => MOCK_NOW + 1000 });

describe('mock MailApi', () => {
  it('has two accounts with standard folders and ~60 threads', async () => {
    const api = make();
    const accounts = await api.accounts.list();
    expect(accounts.map((a) => a.provider)).toEqual(['gmail', 'other']);
    const folders = await api.folders.list('acc-work');
    expect(folders.map((f) => f.role)).toEqual(['inbox', 'starred', 'sent', 'drafts', 'outbox', 'archive', 'junk', 'trash', null, null]);
    let threads = 0;
    for (const a of accounts) {
      for (const f of await api.folders.list(a.id)) {
        if (f.role === 'starred') continue;
        threads += (await api.messages.list({ scope: a.id, folder: { id: f.id }, limit: 200 })).rows.length;
      }
    }
    expect(threads).toBeGreaterThanOrEqual(55);
    expect(threads).toBeLessThanOrEqual(65);
  });

  it('pages the unified inbox by keyset cursor without gaps or duplicates', async () => {
    const api = make();
    const all = (await api.messages.list({ scope: 'all', folder: 'inbox', limit: 200 })).rows;
    expect(all.length).toBeGreaterThan(20);
    const seen: MailThreadRow[] = [];
    let before: { date: number; id: string } | undefined;
    for (;;) {
      const page = await api.messages.list({ scope: 'all', folder: 'inbox', limit: 7, ...(before ? { before } : {}) });
      seen.push(...page.rows);
      if (!page.next) break;
      before = page.next;
    }
    expect(seen.map((r) => r.messageId)).toEqual(all.map((r) => r.messageId));
    for (let i = 1; i < seen.length; i++) expect((seen[i - 1]?.date ?? 0) >= (seen[i]?.date ?? 0)).toBe(true);
    // scope 'all' needs a role
    await expect(api.messages.list({ scope: 'all', folder: { id: 'acc-work/inbox' }, limit: 5 })).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('has the special fixtures: 3-message thread, cid image, tracking pixel, newsletter', async () => {
    const api = make();
    const thread = await api.messages.thread('thread-release');
    expect(thread).toHaveLength(3);
    const inbox = (await api.messages.list({ scope: 'acc-gmail', folder: 'inbox', limit: 200 })).rows;
    expect(inbox.find((r) => r.threadId === 'thread-release')?.count).toBe(3);
    const work = (await api.messages.list({ scope: 'acc-work', folder: 'inbox', limit: 200 })).rows;
    const logo = work.find((r) => r.subject.startsWith('New logo'));
    const msg = await api.messages.get(logo?.messageId ?? '');
    expect(msg.html).toContain('cid:logo@lumen');
    expect(msg.attachments[0]).toMatchObject({ cid: 'logo@lumen', inline: true });
    expect(api.attachmentUrl(msg.id, msg.attachments[0]?.id ?? '')).toMatch(/^data:image\/png/);
    const remote = await Promise.all(inbox.map((r) => api.messages.get(r.messageId)));
    expect(remote.filter((m) => m.remoteImages)).toHaveLength(2);
    expect(remote.some((m) => (m.html?.length ?? 0) > 5000)).toBe(true);
  });

  it('flags update rows, counters and emit events', async () => {
    const api = make();
    const events: MailEvent[] = [];
    api.onEvent((e) => events.push(e));
    const row = (await api.messages.list({ scope: 'acc-gmail', folder: 'inbox', limit: 50, unreadOnly: true })).rows[0];
    if (!row) throw new Error('no unread row');
    const unreadBefore = (await api.folders.list('acc-gmail')).find((f) => f.role === 'inbox')?.unread ?? 0;
    await api.messages.setFlags({ threads: [{ threadId: row.threadId, folderId: row.folderId }] }, { seen: true, flagged: true });
    await flush();
    const after = (await api.messages.list({ scope: 'acc-gmail', folder: 'inbox', limit: 200 })).rows.find((r) => r.threadId === row.threadId);
    expect(after).toMatchObject({ unread: false, flagged: true });
    expect((await api.folders.list('acc-gmail')).find((f) => f.role === 'inbox')?.unread).toBeLessThan(unreadBefore);
    const starred = (await api.messages.list({ scope: 'acc-gmail', folder: 'starred', limit: 200 })).rows;
    expect(starred.some((r) => r.threadId === row.threadId)).toBe(true);
    expect(events.some((e) => e.type === 'messages_changed' && e.folderId === row.folderId)).toBe(true);
    expect(events.some((e) => e.type === 'folders' && e.accountId === 'acc-gmail')).toBe(true);
  });

  it('archive / trash move threads and give new ids', async () => {
    const api = make();
    const row = (await api.messages.list({ scope: 'acc-work', folder: 'inbox', limit: 1 })).rows[0];
    if (!row) throw new Error('empty');
    await api.messages.archive({ threads: [{ threadId: row.threadId, folderId: row.folderId }] });
    const inbox = (await api.messages.list({ scope: 'acc-work', folder: 'inbox', limit: 200 })).rows;
    expect(inbox.some((r) => r.threadId === row.threadId)).toBe(false);
    const archived = (await api.messages.list({ scope: 'acc-work', folder: 'archive', limit: 200 })).rows.find((r) => r.threadId === row.threadId);
    expect(archived?.messageId).not.toBe(row.messageId);
    await expect(api.messages.get(row.messageId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await api.messages.trash({ messageIds: [archived?.messageId ?? ''] });
    const trashed = (await api.messages.list({ scope: 'acc-work', folder: 'trash', limit: 200 })).rows.find((r) => r.threadId === row.threadId);
    expect(trashed).toBeDefined();
    await api.messages.trash({ messageIds: [trashed?.messageId ?? ''] }); // in trash = delete
    expect((await api.messages.list({ scope: 'acc-work', folder: 'trash', limit: 200 })).rows.some((r) => r.threadId === row.threadId)).toBe(false);
  });

  it('send appends to Sent, emits outgoing + messages_added, marks the original answered', async () => {
    const api = make();
    const events: MailEvent[] = [];
    api.onEvent((e) => events.push(e));
    const orig = (await api.messages.thread('thread-release'))[0];
    const out = await api.compose.send({
      accountId: 'acc-gmail',
      to: [{ name: 'Игорь', address: 'igor@northwind.example' }],
      cc: [],
      bcc: [],
      subject: 'Re: Запуск 3.1: план релиза',
      text: 'Готово',
      ref: { messageId: orig?.id ?? '', kind: 'reply', quote: true },
      attachments: [],
    });
    expect(out.state).toBe('queued');
    await flush();
    const sent = (await api.messages.list({ scope: 'acc-gmail', folder: 'sent', limit: 1 })).rows[0];
    expect(sent).toMatchObject({ subject: 'Re: Запуск 3.1: план релиза', threadId: 'thread-release', count: 4 });
    expect(events.flatMap((e) => (e.type === 'outgoing' ? [[e.item.state, e.removed]] : []))).toEqual([
      ['queued', false],
      ['sending', false],
      ['sent', true],
    ]);
    expect(events.some((e) => e.type === 'messages_added' && e.folderId === 'acc-gmail/sent')).toBe(true);
    expect((await api.messages.get(orig?.id ?? '')).flags.answered).toBe(true);
    expect(await api.outgoing.list()).toEqual([]);
  });

  it('send to nowhere.invalid fails and stays in the outbox', async () => {
    const api = make();
    await api.compose.send({ accountId: 'acc-work', to: [{ name: '', address: 'x@nowhere.invalid' }], cc: [], bcc: [], subject: 's', text: 't', attachments: [] });
    await flush();
    const [item] = await api.outgoing.list('acc-work');
    expect(item).toMatchObject({ state: 'failed', attempts: 1, error: { code: 'NETWORK' } });
    expect((await api.folders.list('acc-work')).find((f) => f.role === 'outbox')).toMatchObject({ total: 1, unread: 1 });
    await api.outgoing.remove(item?.id ?? '');
    expect(await api.outgoing.list()).toEqual([]);
    await expect(api.compose.send({ accountId: 'acc-work', to: [], cc: [], bcc: [], subject: '', text: '', attachments: [] })).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('discover: known providers, Microsoft, failure with guesses', async () => {
    const api = make();
    await expect(api.accounts.discover('a@gmail.com')).resolves.toMatchObject({ source: 'known', provider: 'gmail', imap: { host: 'imap.gmail.com', port: 993, security: 'tls' } });
    await expect(api.accounts.discover('a@yandex.ru')).resolves.toMatchObject({ source: 'known', provider: 'yandex' });
    await expect(api.accounts.discover('a@outlook.com')).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });
    await expect(api.accounts.discover('a@nowhere.invalid')).rejects.toMatchObject({
      code: 'DISCOVERY_FAILED',
      discovery: { source: 'manual', imap: { host: 'imap.nowhere.invalid' } },
    });
  });

  it('add: wrong password → AUTH_FAILED; success adds folders and emits', async () => {
    const api = make();
    const events: MailEvent[] = [];
    api.onEvent((e) => events.push(e));
    await expect(api.accounts.add({ email: 'b@yandex.ru', password: 'wrong' })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(api.accounts.add({ email: 'b@outlook.com', password: 'x' })).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });
    const a = await api.accounts.add({ email: 'B@yandex.ru', password: 'secret' });
    expect(a).toMatchObject({ email: 'b@yandex.ru', provider: 'yandex' });
    expect(JSON.stringify(a)).not.toContain('secret');
    expect((await api.folders.list(a.id)).map((f) => f.role)).toContain('inbox');
    await flush();
    expect(events.flatMap((e) => (e.type === 'account_state' ? [e.account?.state] : []))).toEqual(['syncing', 'idle']);
    await api.accounts.remove(a.id);
    expect((await api.accounts.list()).map((x) => x.id)).not.toContain(a.id);
  });
});
