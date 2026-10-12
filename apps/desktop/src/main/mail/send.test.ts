import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MailEvent } from '../../shared/mail';
import { buildBodies, compose, GIVE_UP_MS, isTransient, linkify, nextAttemptAt, Outbox, textToHtml } from './send';
import { MailStore } from './store';

const ACC = 'a00000000000000bb';
const MIN = 60_000;

describe('retry schedule', () => {
  it('1 min, doubling, capped at 1 h', () => {
    const t0 = 0;
    expect(nextAttemptAt(1, t0, t0)).toBe(MIN);
    expect(nextAttemptAt(2, t0, t0)).toBe(2 * MIN);
    expect(nextAttemptAt(3, t0, t0)).toBe(4 * MIN);
    expect(nextAttemptAt(7, t0, t0)).toBe(60 * MIN);
    expect(nextAttemptAt(20, t0, t0)).toBe(60 * MIN);
  });
  it('gives up after 24 h from queuing', () => {
    expect(nextAttemptAt(10, 0, GIVE_UP_MS - 30 * MIN)).toBeNull();
    expect(nextAttemptAt(10, 0, GIVE_UP_MS - 61 * MIN)).not.toBeNull();
  });
  it('retries network and 4xx, not 5xx or auth', () => {
    expect(isTransient(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { responseCode: 451 }))).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { responseCode: 550 }))).toBe(false);
    expect(isTransient(Object.assign(new Error('x'), { code: 'EAUTH', responseCode: 535 }))).toBe(false);
  });
});

describe('bodies', () => {
  it('escapes and autolinks', () => {
    expect(linkify('see https://ex.org/a?b=1&c=2. or <x> a@b.co')).toBe(
      'see <a href="https://ex.org/a?b=1&amp;c=2">https://ex.org/a?b=1&amp;c=2</a>. or &lt;x&gt; <a href="mailto:a@b.co">a@b.co</a>',
    );
    expect(linkify('javascript:alert(1)')).toBe('javascript:alert(1)');
  });
  it('paragraphs and line breaks', () => {
    expect(textToHtml('a\nb\n\n\nc')).toBe('<p>a<br>b</p>\n<p>c</p>');
  });
  it('quotes the original as blockquote / "> " lines, forward header for forwards', () => {
    const q = { from: { name: 'Ann', address: 'ann@x.org' }, to: [{ name: '', address: 'me@x.org' }], date: Date.UTC(2026, 0, 2), subject: 'S', text: 'line1\n> old' };
    const r = buildBodies('Thanks', { ...q, kind: 'reply' });
    expect(r.text).toContain('Ann <ann@x.org> wrote:\n> line1\n>> old');
    expect(r.html).toContain('<blockquote type="cite"');
    const f = buildBodies('FYI', { ...q, kind: 'forward' });
    expect(f.text).toContain('---------- Forwarded message ----------\nFrom: Ann <ann@x.org>');
  });
  it('composes RFC 822 with our Message-ID, threading headers, no Bcc header', async () => {
    const raw = (
      await compose({
        from: { name: 'Me', address: 'me@x.org' },
        draft: { accountId: ACC, to: [{ name: 'Ann', address: 'ann@x.org' }], cc: [], bcc: [{ name: '', address: 'hidden@x.org' }], subject: 'Re: S', text: 'hi', attachments: [] },
        messageIdHdr: '<id1@x.org>',
        bodies: { text: 'hi', html: '<p>hi</p>' },
        inReplyTo: '<p@x.org>',
        references: ['<r@x.org>', '<p@x.org>'],
        attachments: [{ name: 'a.txt', mime: 'text/plain', data: new TextEncoder().encode('att') }],
        date: new Date(0),
      })
    ).toString();
    expect(raw).toMatch(/^Message-ID: <id1@x\.org>/m);
    expect(raw).toMatch(/^In-Reply-To: <p@x\.org>/m);
    expect(raw).toMatch(/^References: <r@x\.org> <p@x\.org>/m);
    expect(raw).not.toMatch(/hidden@x\.org/);
    expect(raw).toMatch(/multipart\/alternative/);
    expect(raw).toMatch(/filename=a\.txt/);
  });
  it('rejects attachments over 25 MB', async () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    await expect(
      compose({
        from: { name: '', address: 'me@x.org' },
        draft: { accountId: ACC, to: [], cc: [], bcc: [], subject: '', text: '', attachments: [] },
        messageIdHdr: '<a@b>',
        bodies: { text: '', html: '' },
        inReplyTo: '',
        references: [],
        attachments: [{ name: 'big', mime: 'application/octet-stream', data: big }],
        date: new Date(0),
      }),
    ).rejects.toMatchObject({ code: 'INVALID' });
  });
});

describe('outbox queue', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(sendImpl: () => Promise<void>): { outbox: Outbox; store: MailStore; events: MailEvent[]; clock: { t: number }; timers: Array<{ fn: () => void; ms: number }>; sent: string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'calab-mail-send-'));
    dirs.push(dir);
    const clock = { t: 1_000_000 };
    const store = new MailStore(dir, ACC, () => clock.t);
    const events: MailEvent[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const sent: string[] = [];
    const outbox = new Outbox({
      store,
      accountId: ACC,
      dir,
      send: sendImpl,
      sent: (_raw, answers) => {
        sent.push(answers ?? '');
        return Promise.resolve();
      },
      emit: (e) => events.push(e),
      foldersChanged: () => undefined,
      now: () => clock.t,
      log: () => undefined,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => undefined,
    });
    return { outbox, store, events, clock, timers, sent };
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  const meta = { from: 'me@x.org', recipients: ['a@x.org'], messageIdHdr: '<m@x>', answers: 'orig' };

  it('sends, files and leaves the queue', async () => {
    const { outbox, events, sent } = setup(() => Promise.resolve());
    outbox.enqueue(Buffer.from('raw'), { to: [{ name: '', address: 'a@x.org' }], subject: 'S', meta });
    await settle();
    expect(outbox.list()).toEqual([]);
    expect(sent).toEqual(['orig']);
    expect(events.flatMap((e) => (e.type === 'outgoing' ? [`${e.item.state}${e.removed ? '-' : ''}`] : []))).toEqual(['queued', 'sending', 'sent-']);
  });

  it('retries transient failures on schedule, fails permanent ones', async () => {
    let fail: Error | null = Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
    const { outbox, clock, timers } = setup(() => (fail ? Promise.reject(fail) : Promise.resolve()));
    outbox.enqueue(Buffer.from('raw'), { to: [], subject: 'S', meta });
    await settle();
    expect(outbox.list()[0]).toMatchObject({ state: 'queued', attempts: 1, error: { code: 'NETWORK' } });
    expect(timers.at(-1)?.ms).toBe(MIN);
    clock.t += MIN;
    fail = Object.assign(new Error('mailbox unavailable'), { responseCode: 550 });
    timers.at(-1)?.fn();
    await settle();
    expect(outbox.list()[0]).toMatchObject({ state: 'failed', attempts: 2, nextAt: null });
    fail = null;
    const id = outbox.list()[0]?.id ?? '';
    outbox.retry(Number(id.split('.o')[1]));
    await settle();
    expect(outbox.list()).toEqual([]);
  });

  it('a crash mid-send is re-queued on start', () => {
    const { store } = setup(() => Promise.resolve());
    const r = store.addOutgoing({ to: [], subject: 'S', meta });
    store.updateOutgoing(r.n, { state: 'sending' });
    const again = new Outbox({
      store,
      accountId: ACC,
      dir: store.dir,
      send: () => new Promise(() => undefined),
      sent: () => Promise.resolve(),
      emit: () => undefined,
      foldersChanged: () => undefined,
      now: () => 0,
      log: () => undefined,
    });
    expect(again.list()[0]?.state).toBe('queued');
    again.stop();
  });
});
