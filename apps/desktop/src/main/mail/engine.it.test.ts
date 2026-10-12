/**
 * Opt-in integration test of the mail engine against a real IMAP / SMTP server (ADR-0088 §11):
 * `CALABA_MAIL_IT=1`, GreenMail from the dev compose (profile `mail`, see TESTING.md). Strict TLS:
 * the server's localhost certificate (infra/docker/greenmail/gen-cert.sh) is trusted as the CA.
 * Overrides: CALABA_MAIL_IT_HOST, _IMAP_PORT, _SMTP_PORT, _CA (PEM path).
 */
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MailDraft, MailEngineAccount, MailEvent, MailMessage, MailPage } from '../../shared/mail';
import { ImapFlowSession, imapOptions, verifyImap } from './imap';
import { classify } from './errors';
import { probeServer, realDiscoverNet, type MailTls } from './net';
import { smtpSend, verifySmtp } from './send';
import { MailEngine } from './service';

const IT = process.env['CALABA_MAIL_IT'] === '1';
const HOST = process.env['CALABA_MAIL_IT_HOST'] ?? 'localhost';
const IMAP_PORT = Number(process.env['CALABA_MAIL_IT_IMAP_PORT'] ?? 3993);
const SMTP_PORT = Number(process.env['CALABA_MAIL_IT_SMTP_PORT'] ?? 3465);
const CA = process.env['CALABA_MAIL_IT_CA'] ?? resolve(__dirname, '../../../../../infra/docker/greenmail/certs/ca.pem');

const imap = { host: HOST, port: IMAP_PORT, security: 'tls' as const };
const smtp = { host: HOST, port: SMTP_PORT, security: 'tls' as const };
const ALICE: MailEngineAccount = { id: 'a1111111111111111', email: 'alice@example.test', name: 'Alice', provider: 'other', imap, smtp, login: 'alice', password: 'secret' };

async function waitFor<T>(fn: () => T | Promise<T>, ms = 20_000): Promise<Exclude<T, undefined | null | false>> {
  const end = Date.now() + ms;
  for (;;) {
    const v: unknown = await fn();
    if (v !== undefined && v !== null && v !== false) return v as Exclude<T, undefined | null | false>;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!IT)('mail engine against a real IMAP / SMTP server', () => {
  let tls: MailTls;
  let dir: string;
  let engine: MailEngine;
  const events: MailEvent[] = [];

  beforeAll(() => {
    tls = { ca: readFileSync(CA) };
    dir = mkdtempSync(join(tmpdir(), 'calab-mail-it-'));
    engine = new MailEngine({
      dataDir: dir,
      emit: (e) => events.push(e),
      connectImap: (a) => ImapFlowSession.open({ server: a.imap, login: a.login, password: a.password }, tls),
      verifyImap: (l) => verifyImap(l, tls),
      verifySmtp: (l) => verifySmtp(l, tls),
      smtpSend: (a, env, raw) => smtpSend({ server: a.smtp, login: a.login, password: a.password }, env, raw, tls),
      discoverNet: realDiscoverNet(tls),
    });
  });

  afterAll(async () => {
    await engine.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('verify: a wrong password is AUTH_FAILED (with the tried settings), the right one passes', async () => {
    const settings = { imap, smtp, login: 'alice' };
    await expect(engine.verify({ email: ALICE.email, password: 'wrong', settings })).rejects.toMatchObject({ code: 'AUTH_FAILED', discovery: { imap: { host: HOST } } });
    await expect(engine.verify({ email: ALICE.email, password: 'secret', settings })).resolves.toMatchObject({ provider: 'other', login: 'alice' });
  }, 30_000);

  it('syncs, sends, receives over IDLE, reads, flags, searches and archives', async () => {
    const h = engine.handlers();
    await engine.setAccounts([ALICE]);
    await waitFor(() => events.some((e) => e.type === 'account_state' && e.account?.state === 'idle'));

    // 1. Our own message: queued, sent, delivered to the inbox (picked up by IDLE).
    const subject = `IT ${String(Date.now())}`;
    const draft: MailDraft = {
      accountId: ALICE.id,
      to: [{ name: 'Alice', address: ALICE.email }],
      cc: [],
      bcc: [],
      subject,
      text: 'Hello from the engine https://calab.io',
      attachments: [{ kind: 'file', id: 'f1', name: 'a.txt', mime: 'text/plain', size: 3, data: new TextEncoder().encode('abc') }],
    };
    await h['compose.send'](draft);
    await waitFor(() => events.some((e) => e.type === 'outgoing' && e.removed));
    const list = (): Promise<MailPage> => h['messages.list']({ scope: ALICE.id, folder: 'inbox', limit: 50 });
    const row = await waitFor(async () => (await list()).rows.find((r) => r.subject === subject));
    expect(row).toMatchObject({ unread: true, hasAttachments: true, from: { address: ALICE.email } });
    expect(row.messageIdHeader).toMatch(/^<.+@example\.test>$/);

    // 2. Body + attachment through the engine.
    const msg: MailMessage = await h['messages.get'](row.messageId);
    expect(msg.text).toContain('Hello from the engine');
    expect(msg.html).toContain('<a href="https://calab.io">');
    const att = msg.attachments.find((a) => a.name === 'a.txt');
    if (!att) throw new Error('no attachment');
    expect(new TextDecoder().decode((await engine.attachment(msg.id, att.id)).data)).toBe('abc');

    // 3. Mail from someone else → new_mail.
    await smtpSend({ server: smtp, login: 'bob', password: 'secret' }, { from: 'bob@example.test', to: [ALICE.email] }, Buffer.from(`From: Bob <bob@example.test>\r\nTo: ${ALICE.email}\r\nSubject: Ping ${subject}\r\nMessage-ID: <ping-${String(Date.now())}@example.test>\r\n\r\nping\r\n`), tls);
    await waitFor(() => events.find((e) => e.type === 'new_mail' && e.subject === `Ping ${subject}`));

    // 4. Flags reach the server.
    await h['messages.setFlags']({ messageIds: [msg.id] }, { seen: true, flagged: true });
    const probe = new ImapFlow({ ...imapOptions({ server: imap, login: 'alice', password: 'secret' }, tls) });
    await probe.connect();
    try {
      await waitFor(async () => {
        await probe.mailboxOpen('INBOX');
        const all = await probe.fetchAll('1:*', { flags: true, envelope: true });
        const mine = all.find((x) => x.envelope?.subject === subject);
        return mine?.flags?.has('\\Seen') && mine.flags.has('\\Flagged');
      });

      // 5. Search (FTS over subject + downloaded body).
      const found = await h.search({ text: 'engine', scope: ALICE.id, limit: 10 });
      expect(found.rows.map((r) => r.subject)).toContain(subject);

      // 6. Archive: the folder is created on demand, the message moves there.
      await h['messages.archive']({ messageIds: [msg.id] });
      expect((await list()).rows.find((r) => r.subject === subject)).toBeUndefined();
      await waitFor(async () => {
        const boxes = await probe.list();
        if (!boxes.some((b) => b.path === 'Archive')) return false;
        const st = await probe.status('Archive', { messages: true });
        return st && (st.messages ?? 0) >= 1;
      });
      await h['settings.clearCache'](ALICE.id);
      const folders = await h['folders.list'](ALICE.id);
      expect(folders.map((f) => f.role)).toEqual(expect.arrayContaining(['inbox', 'archive', 'starred', 'drafts', 'outbox']));
    } finally {
      await probe.logout();
    }
  }, 90_000);
});

/**
 * Trust on first use (§4): the same server WITHOUT trusting its CA — its certificate is self-signed,
 * exactly what a small company's mail server shows. Fails strictly with the certificate in the
 * error; the pinned fingerprint passes; another pin is `changed`.
 */
describe.skipIf(!IT)('untrusted certificates: the trust prompt and pinning', () => {
  let fp: string;
  const WRONG = Array.from({ length: 32 }, () => 'AB').join(':');
  const pinned = <T extends { host: string; port: number; security: 'tls' }>(s: T, pin: string): T & { pinnedCert: string } => ({ ...s, pinnedCert: pin });
  const certOf = async (p: Promise<unknown>): Promise<ReturnType<typeof classify>> => classify(await p.then(() => null, (e: unknown) => e));

  beforeAll(() => {
    fp = new X509Certificate(readFileSync(CA)).fingerprint256;
  });

  it('IMAP: self_signed with the certificate; the pin passes; another pin is changed', async () => {
    const strict = await certOf(verifyImap({ server: imap, login: 'alice', password: 'secret' }));
    expect(strict).toMatchObject({ code: 'TLS', cert: { host: HOST, port: IMAP_PORT, fingerprint256: fp, reason: 'self_signed', subject: 'CN=localhost', issuer: 'CN=localhost' } });
    expect(strict.cert?.notAfter).toBeGreaterThan(Date.now());
    await expect(verifyImap({ server: pinned(imap, fp), login: 'alice', password: 'secret' })).resolves.toBeUndefined();
    expect(await certOf(verifyImap({ server: pinned(imap, WRONG), login: 'alice', password: 'secret' }))).toMatchObject({ code: 'TLS', cert: { fingerprint256: fp, reason: 'changed' } });
    // A pinned session syncs like any other.
    const s = await ImapFlowSession.open({ server: pinned(imap, fp), login: 'alice', password: 'secret' });
    expect((await s.list()).length).toBeGreaterThan(0);
    await s.close();
  }, 30_000);

  it('SMTP: the same for verify and send', async () => {
    expect(await certOf(verifySmtp({ server: smtp, login: 'alice', password: 'secret' }))).toMatchObject({ code: 'TLS', cert: { port: SMTP_PORT, fingerprint256: fp, reason: 'self_signed' } });
    await expect(verifySmtp({ server: pinned(smtp, fp), login: 'alice', password: 'secret' })).resolves.toBeUndefined();
    expect(await certOf(verifySmtp({ server: pinned(smtp, WRONG), login: 'alice', password: 'secret' }))).toMatchObject({ code: 'TLS', cert: { reason: 'changed' } });
    const raw = Buffer.from('From: alice@example.test\r\nTo: alice@example.test\r\nSubject: pinned\r\n\r\nhi\r\n');
    expect(await certOf(smtpSend({ server: smtp, login: 'alice', password: 'secret' }, { from: 'alice@example.test', to: ['alice@example.test'] }, raw))).toMatchObject({ code: 'TLS', cert: { reason: 'self_signed' } });
    await expect(smtpSend({ server: pinned(smtp, fp), login: 'alice', password: 'secret' }, { from: 'alice@example.test', to: ['alice@example.test'] }, raw)).resolves.toBeUndefined();
  }, 30_000);

  it('probe: found with certIssue; pinned → no issue', async () => {
    expect(await probeServer('imap', imap, 3000)).toMatchObject({ ok: true, certIssue: { reason: 'self_signed', fingerprint256: fp } });
    expect(await probeServer('smtp', smtp, 3000)).toMatchObject({ ok: true, certIssue: { reason: 'self_signed' } });
    expect(await probeServer('imap', pinned(imap, fp), 3000)).toEqual({ ok: true });
    expect(await probeServer('imap', pinned(imap, WRONG), 3000)).toMatchObject({ ok: true, certIssue: { reason: 'changed' } });
  }, 30_000);

  it('engine.verify: both servers in the prompt at once; with both pins the account verifies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calab-mail-it-pin-'));
    const e = new MailEngine({
      dataDir: dir,
      emit: () => undefined,
      connectImap: (a) => ImapFlowSession.open({ server: a.imap, login: a.login, password: a.password }),
      verifyImap: (l) => verifyImap(l),
      verifySmtp: (l) => verifySmtp(l),
      smtpSend: (a, env, raw) => smtpSend({ server: a.smtp, login: a.login, password: a.password }, env, raw),
      discoverNet: realDiscoverNet(),
    });
    try {
      const err = await e.verify({ email: ALICE.email, password: 'secret', settings: { imap, smtp, login: 'alice' } }).catch((x: unknown) => x);
      expect(err).toMatchObject({
        code: 'TLS',
        cert: { port: IMAP_PORT, reason: 'self_signed' },
        discovery: { imap: { certIssue: { port: IMAP_PORT, fingerprint256: fp } }, smtp: { certIssue: { port: SMTP_PORT, fingerprint256: fp } } },
      });
      const v = await e.verify({ email: ALICE.email, password: 'secret', settings: { imap: pinned(imap, fp), smtp: pinned(smtp, fp.toLowerCase()), login: 'alice' } });
      expect(v).toMatchObject({ imap: { pinnedCert: fp }, smtp: { pinnedCert: fp } });
    } finally {
      await e.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
