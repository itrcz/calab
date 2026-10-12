/**
 * Sending (ADR-0088 §6): the user's own SMTP via nodemailer, text/plain + text/html built from the
 * draft text (paragraphs, autolinks, the quoted original as a blockquote), attachments ≤ 25 MB, own
 * Message-ID, In-Reply-To / References, an `outgoing` queue with retries 1 min → 1 h for 24 h,
 * APPEND to Sent unless the provider files it itself (Gmail), `\Answered` on the original.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTransport } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { MailAddress, MailDraft, MailError, MailEvent, MailOutgoing, MailServerSettings } from '../../shared/mail';
import { classify, invalid, mailError, notFound, withDeadline } from './errors';
import { mailTlsOptions, type MailTls } from './net';
import type { MailStore, OutgoingRecord } from './store';

export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;
export const RETRY_MIN_MS = 60_000;
export const RETRY_MAX_MS = 3600_000;
export const GIVE_UP_MS = 24 * 3600_000;

/**
 * When to try again after `attempts` failed attempts (1 min, doubling, capped at 1 h), or null
 * once that would pass 24 h after queuing (§6).
 */
export function nextAttemptAt(attempts: number, createdAt: number, now: number): number | null {
  const delay = Math.min(RETRY_MIN_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
  const at = now + delay;
  return at > createdAt + GIVE_UP_MS ? null : at;
}

/** SMTP errors worth retrying: network, TLS hiccups, 4xx; 5xx / auth / bad addresses are final. */
export function isTransient(e: unknown): boolean {
  const c = classify(e);
  if (c.code === 'NETWORK' || c.code === 'RATE_LIMITED') return true;
  const rc = (e as { responseCode?: unknown } | null)?.responseCode;
  return typeof rc === 'number' && rc >= 400 && rc < 500;
}

// ---------------------------------------------------------------- text → html

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const LINK = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}])|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** One line of plain text → escaped HTML with http(s) and e-mail autolinks. */
export function linkify(line: string): string {
  let out = '';
  let last = 0;
  for (const m of line.matchAll(LINK)) {
    const i = m.index;
    out += esc(line.slice(last, i));
    const url = m[1];
    const mail = m[2];
    if (url) out += `<a href="${esc(url)}">${esc(url)}</a>`;
    else if (mail) out += `<a href="mailto:${esc(mail)}">${esc(mail)}</a>`;
    last = i + m[0].length;
  }
  return out + esc(line.slice(last));
}

/** Plain text → HTML: blank lines split paragraphs, single newlines become <br>. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== '')
    .map((p) => `<p>${p.split('\n').map(linkify).join('<br>')}</p>`)
    .join('\n');
}

export interface QuotedOriginal {
  kind: 'reply' | 'replyAll' | 'forward';
  from: MailAddress;
  to: MailAddress[];
  date: number;
  subject: string;
  text: string;
}

const fmtAddr = (a: MailAddress): string => (a.name ? `${a.name} <${a.address}>` : a.address);

/** The text and HTML bodies of a draft, with the quoted original appended (§6). */
export function buildBodies(text: string, quote: QuotedOriginal | null): { text: string; html: string } {
  const html = textToHtml(text);
  if (!quote) return { text, html: `<div>${html}</div>` };
  const date = new Date(quote.date).toUTCString();
  if (quote.kind === 'forward') {
    const head = ['---------- Forwarded message ----------', `From: ${fmtAddr(quote.from)}`, `Date: ${date}`, `Subject: ${quote.subject}`, `To: ${quote.to.map(fmtAddr).join(', ')}`];
    return {
      text: `${text}\n\n${head.join('\n')}\n\n${quote.text}`,
      html: `<div>${html}</div>\n<div><br>${head.map(esc).join('<br>')}<br><br></div>\n<div>${textToHtml(quote.text)}</div>`,
    };
  }
  const intro = `On ${date}, ${fmtAddr(quote.from)} wrote:`;
  const quoted = quote.text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l.startsWith('>') ? `>${l}` : `> ${l}`))
    .join('\n');
  return {
    text: `${text}\n\n${intro}\n${quoted}`,
    html: `<div>${html}</div>\n<div>${esc(intro)}</div>\n<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${textToHtml(quote.text)}</blockquote>`,
  };
}

export function newMessageIdHeader(email: string): string {
  const domain = email.slice(email.lastIndexOf('@') + 1) || 'calab.local';
  return `<${randomBytes(12).toString('hex')}.${Date.now().toString(36)}@${domain}>`;
}

export interface ComposeInput {
  from: MailAddress;
  draft: MailDraft;
  messageIdHdr: string;
  bodies: { text: string; html: string };
  inReplyTo: string;
  references: string[];
  attachments: Array<{ name: string; mime: string; data: Uint8Array }>;
  date: Date;
}

/** RFC 822 bytes (Bcc not in the headers; the SMTP envelope carries it). No file / URL access. */
export async function compose(c: ComposeInput): Promise<Buffer> {
  const total = c.attachments.reduce((n, a) => n + a.data.byteLength, 0);
  if (total > MAX_ATTACHMENTS_BYTES) throw invalid('attachments exceed 25 MB');
  const mc = new MailComposer({
    from: c.from,
    to: c.draft.to,
    cc: c.draft.cc,
    subject: c.draft.subject,
    text: c.bodies.text,
    html: c.bodies.html,
    messageId: c.messageIdHdr,
    date: c.date,
    ...(c.inReplyTo ? { inReplyTo: c.inReplyTo } : {}),
    ...(c.references.length ? { references: c.references } : {}),
    attachments: c.attachments.map((a) => ({ filename: a.name, contentType: a.mime, content: Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength) })),
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return mc.compile().build();
}

// ---------------------------------------------------------------- SMTP

export interface SmtpLogin {
  server: MailServerSettings;
  login: string;
  password: string;
}

/** Login check (§4): connect / greeting 10 s, the whole check 22 s (see imap.ts VERIFY_*). */
const VERIFY_STEP_MS = 10_000;
const VERIFY_TOTAL_MS = 22_000;
/** One send attempt of the outbox (in the background, not a call): bounds a server that stalls. */
const SEND_TOTAL_MS = 5 * 60_000;

function transport(l: SmtpLogin, tls: MailTls, verify = false) {
  return createTransport({
    host: l.server.host,
    port: l.server.port,
    secure: l.server.security === 'tls',
    requireTLS: l.server.security === 'starttls',
    auth: { user: l.login, pass: l.password },
    tls: { ...mailTlsOptions(l.server, tls), servername: l.server.host },
    connectionTimeout: verify ? VERIFY_STEP_MS : 15_000,
    greetingTimeout: verify ? VERIFY_STEP_MS : 15_000,
    socketTimeout: verify ? VERIFY_TOTAL_MS : 60_000,
    dnsTimeout: verify ? VERIFY_STEP_MS : 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

/** Login check for `accounts.add` (§4). */
export async function verifySmtp(l: SmtpLogin, tls: MailTls = {}): Promise<void> {
  const t = transport(l, tls, true);
  try {
    await withDeadline(t.verify(), VERIFY_TOTAL_MS, 'SMTP login check', () => t.close());
  } finally {
    t.close();
  }
}

export async function smtpSend(l: SmtpLogin, envelope: { from: string; to: string[] }, raw: Buffer, tls: MailTls = {}): Promise<void> {
  const t = transport(l, tls);
  try {
    await withDeadline(t.sendMail({ envelope, raw }), SEND_TOTAL_MS, 'SMTP send', () => t.close());
  } finally {
    t.close();
  }
}

// ---------------------------------------------------------------- the queue

export interface OutboxHost {
  readonly store: MailStore;
  readonly accountId: string;
  /** The account's directory (outgoing raw messages live in `<dir>/outgoing/<n>.eml`). */
  readonly dir: string;
  send(envelope: { from: string; to: string[] }, raw: Buffer): Promise<void>;
  /** After a successful send: APPEND to Sent (provider permitting) and `\Answered` on the original. */
  sent(raw: Buffer, answers: string | undefined): Promise<void>;
  emit(event: MailEvent): void;
  foldersChanged(): void;
  now(): number;
  log(message: string, meta?: Record<string, unknown>): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

export function outgoingId(accountId: string, n: number): string {
  return `${accountId}.o${String(n)}`;
}

export function toOutgoing(accountId: string, r: OutgoingRecord): MailOutgoing {
  return {
    id: outgoingId(accountId, r.n),
    accountId,
    to: r.to,
    subject: r.subject,
    state: r.state,
    attempts: r.attempts,
    error: r.error ? ({ code: r.error.code, message: r.error.message } as MailError) : null,
    nextAt: r.nextAt,
    createdAt: r.createdAt,
  };
}

export class Outbox {
  private timer: unknown = null;
  private busy = false;
  private stopped = false;

  constructor(private readonly host: OutboxHost) {
    mkdirSync(join(host.dir, 'outgoing'), { recursive: true });
    // A crash mid-send leaves `sending`: back to the queue.
    for (const r of host.store.outgoingAll()) if (r.state === 'sending') host.store.updateOutgoing(r.n, { state: 'queued', nextAt: host.now() });
  }

  private rawPath(n: number): string {
    return join(this.host.dir, 'outgoing', `${String(n)}.eml`);
  }

  private isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    if (this.host.clearTimer) this.host.clearTimer(this.timer);
    else clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
  }

  list(): MailOutgoing[] {
    return this.host.store
      .outgoingAll()
      .filter((r) => r.state !== 'sent')
      .map((r) => toOutgoing(this.host.accountId, r));
  }

  enqueue(raw: Buffer, rec: Parameters<MailStore['addOutgoing']>[0]): MailOutgoing {
    const r = this.host.store.addOutgoing(rec);
    writeFileSync(this.rawPath(r.n), raw);
    const item = toOutgoing(this.host.accountId, r);
    this.host.emit({ type: 'outgoing', item, removed: false });
    this.host.foldersChanged();
    this.kick();
    return item;
  }

  retry(n: number): void {
    const r = this.host.store.outgoing(n);
    if (!r) throw notFound('outgoing item');
    if (r.state === 'sending') return;
    // A manual retry restarts the 24 h window.
    this.host.store.db.prepare('UPDATE outgoing SET created_at = ? WHERE n = ?').run(this.host.now(), n);
    this.host.store.updateOutgoing(n, { state: 'queued', nextAt: this.host.now(), error: null });
    this.changed(n, false);
    this.kick();
  }

  remove(n: number): void {
    const r = this.host.store.outgoing(n);
    if (!r) throw notFound('outgoing item');
    if (r.state === 'sending') throw mailError('INVALID', 'the message is being sent');
    this.host.store.removeOutgoing(n);
    rmSync(this.rawPath(n), { force: true });
    this.host.emit({ type: 'outgoing', item: toOutgoing(this.host.accountId, r), removed: true });
    this.host.foldersChanged();
  }

  private changed(n: number, removed: boolean): void {
    const r = this.host.store.outgoing(n);
    if (r) this.host.emit({ type: 'outgoing', item: toOutgoing(this.host.accountId, r), removed });
    this.host.foldersChanged();
  }

  /** Sends what is due now and arms one timer for the next due item. */
  kick(): void {
    if (this.stopped || this.busy) return;
    this.clearTimer();
    void this.drain();
  }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      for (;;) {
        if (this.stopped) return;
        const now = this.host.now();
        const due = this.host.store.outgoingAll().find((r) => r.state === 'queued' && (r.nextAt ?? 0) <= now);
        if (!due) break;
        await this.attempt(due);
      }
    } finally {
      this.busy = false;
    }
    const next = this.host.store
      .outgoingAll()
      .filter((r) => r.state === 'queued' && r.nextAt !== null)
      .reduce<number | null>((m, r) => (m === null || (r.nextAt ?? 0) < m ? r.nextAt : m), null);
    if (next !== null && !this.isStopped()) {
      const ms = Math.max(0, next - this.host.now());
      const fn = (): void => {
        this.timer = null;
        this.kick();
      };
      if (this.host.setTimer) this.timer = this.host.setTimer(fn, ms);
      else {
        const t = setTimeout(fn, ms);
        t.unref();
        this.timer = t;
      }
    }
  }

  private async attempt(r: OutgoingRecord): Promise<void> {
    const store = this.host.store;
    let raw: Buffer;
    try {
      raw = readFileSync(this.rawPath(r.n));
    } catch {
      store.updateOutgoing(r.n, { state: 'failed', nextAt: null, error: { code: 'NOT_FOUND', message: 'the message file is missing' } });
      this.changed(r.n, false);
      return;
    }
    store.updateOutgoing(r.n, { state: 'sending', nextAt: null });
    this.changed(r.n, false);
    const attempts = r.attempts + 1;
    try {
      await this.host.send({ from: r.meta.from, to: r.meta.recipients }, raw);
    } catch (e) {
      if (this.isStopped()) return; // the store may be closed; `sending` is re-queued on next start
      const c = classify(e);
      const next = isTransient(e) ? nextAttemptAt(attempts, r.createdAt, this.host.now()) : null;
      this.host.log('mail: send failed', { code: c.code, attempts, retry: next !== null });
      store.updateOutgoing(r.n, { state: next === null ? 'failed' : 'queued', attempts, nextAt: next, error: { code: c.code, message: c.message } });
      this.changed(r.n, false);
      return;
    }
    let item: OutgoingRecord | null;
    try {
      // Even when stopping (quit mid-send): forget it now, or the next start sends it again.
      store.updateOutgoing(r.n, { state: 'sent', attempts, nextAt: null, error: null });
      item = store.outgoing(r.n);
      store.removeOutgoing(r.n);
      rmSync(this.rawPath(r.n), { force: true });
    } catch {
      return; // the store is closed (account removed)
    }
    if (this.isStopped()) return;
    if (item) this.host.emit({ type: 'outgoing', item: toOutgoing(this.host.accountId, item), removed: true });
    this.host.foldersChanged();
    try {
      await this.host.sent(raw, r.meta.answers);
    } catch (e) {
      this.host.log('mail: filing sent mail failed', { code: classify(e).code });
    }
  }
}
