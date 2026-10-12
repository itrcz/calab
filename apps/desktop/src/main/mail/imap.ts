/**
 * ImapSession over imapflow (§5): one connection per account, TLS / STARTTLS with strict
 * certificate checks, IDLE on the selected mailbox (imapflow's auto-IDLE), CONDSTORE when offered.
 */
import { ImapFlow, type FetchMessageObject, type ImapFlowOptions, type MessageAddressObject } from 'imapflow';
import type { MailAddress, MailServerSettings } from '../../shared/mail';
import { hasAttachments, referencesFromHeaders, SNIPPET_FETCH, snippetFrom, snippetPart } from './mime';
import type { MailTls } from './net';
import { flagsFrom, type ImapSession, type RemoteFlags, type RemoteFolder, type RemoteHeader, type SelectInfo } from './session';

export interface ImapLogin {
  server: MailServerSettings;
  login: string;
  password: string;
}

export function imapOptions(l: ImapLogin, tls: MailTls = {}): ImapFlowOptions {
  return {
    host: l.server.host,
    port: l.server.port,
    secure: l.server.security === 'tls',
    // starttls: required (never a silent plain-text fallback); tls: not applicable.
    doSTARTTLS: l.server.security === 'starttls' ? true : undefined,
    servername: l.server.host,
    auth: { user: l.login, pass: l.password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(tls.ca ? { ca: tls.ca } : {}) },
    logger: false,
    clientInfo: { name: 'Calab', vendor: 'Calab' },
    qresync: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 5 * 60_000,
    // IDLE 1 s after the last command (imapflow's default 15 s delays new mail by as much);
    // re-issued every maxIdleTime, servers drop IDLE after ~29 min.
    autoIdleDelay: 1000,
    maxIdleTime: 25 * 60_000,
  };
}

/** Login check for `accounts.add` (§4): connect, authenticate, log out. */
export async function verifyImap(l: ImapLogin, tls: MailTls = {}): Promise<void> {
  const c = new ImapFlow({ ...imapOptions(l, tls), verifyOnly: true });
  c.on('error', () => undefined);
  try {
    await c.connect();
  } finally {
    c.close();
  }
}

const addr = (a: MessageAddressObject[] | undefined): MailAddress[] =>
  (a ?? []).filter((x) => x.address).map((x) => ({ name: x.name ?? '', address: (x.address ?? '').toLowerCase() }));

const dateOf = (v: Date | string | undefined): number => {
  const t = v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
};

const CHUNK = 200;

function chunks<T>(list: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

export class ImapFlowSession implements ImapSession {
  private closeCbs: Array<() => void> = [];
  private changeCbs: Array<(path: string) => void> = [];

  private constructor(private readonly c: ImapFlow) {
    const changed = (ev: { path?: string }): void => {
      for (const cb of this.changeCbs) cb(ev.path ?? '');
    };
    c.on('exists', changed);
    c.on('expunge', changed);
    c.on('flags', changed);
    c.on('close', () => {
      for (const cb of this.closeCbs) cb();
      this.closeCbs = [];
    });
    // Errors also end in 'close'; without a listener an 'error' would crash the engine.
    c.on('error', () => undefined);
  }

  static async open(l: ImapLogin, tls: MailTls = {}): Promise<ImapFlowSession> {
    const c = new ImapFlow(imapOptions(l, tls));
    c.on('error', () => undefined);
    await c.connect();
    return new ImapFlowSession(c);
  }

  get condstore(): boolean {
    return this.c.enabled.has('CONDSTORE') || this.c.capabilities.has('CONDSTORE');
  }

  async list(): Promise<RemoteFolder[]> {
    const l = await this.c.list();
    return l.map((f) => ({
      path: f.path,
      name: f.name,
      delimiter: f.delimiter || '/',
      parentPath: f.parentPath,
      specialUse: f.specialUse ?? null,
      flags: [...f.flags],
    }));
  }

  async select(path: string): Promise<SelectInfo> {
    const m = await this.c.mailboxOpen(path);
    return { uidValidity: String(m.uidValidity), uidNext: m.uidNext, exists: m.exists, highestModseq: m.highestModseq !== undefined && !m.noModseq ? String(m.highestModseq) : null };
  }

  async searchDate(since?: Date, before?: Date): Promise<number[]> {
    const q = { ...(since ? { since } : {}), ...(before ? { before } : {}) };
    const r = await this.c.search(Object.keys(q).length ? q : { all: true }, { uid: true });
    return Array.isArray(r) ? r : [];
  }

  async searchUids(range: string): Promise<number[]> {
    const r = await this.c.search({ uid: range }, { uid: true });
    return Array.isArray(r) ? r : [];
  }

  async fetchHeaders(uids: number[] | string): Promise<RemoteHeader[]> {
    const ranges = typeof uids === 'string' ? [uids] : chunks(uids, CHUNK).map((c) => c.join(','));
    const out: RemoteHeader[] = [];
    for (const range of ranges) {
      const msgs: FetchMessageObject[] = await this.c.fetchAll(range, { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true, headers: ['references'] }, { uid: true });
      // Snippets: one partial fetch per distinct text part number (usually "1" / "1.1").
      const byPart = new Map<string, number[]>();
      const partOf = new Map<number, ReturnType<typeof snippetPart>>();
      for (const m of msgs) {
        const p = snippetPart(m.bodyStructure);
        partOf.set(m.uid, p);
        if (p) byPart.set(p.part, [...(byPart.get(p.part) ?? []), m.uid]);
      }
      const snippets = new Map<number, string>();
      for (const [part, list] of byPart) {
        const parts = await this.c.fetchAll(list.join(','), { uid: true, bodyParts: [{ key: part, maxLength: SNIPPET_FETCH }] }, { uid: true });
        for (const p of parts) {
          const raw = p.bodyParts?.get(part) ?? p.bodyParts?.values().next().value;
          const info = partOf.get(p.uid);
          if (raw && info) snippets.set(p.uid, snippetFrom(raw, info));
        }
      }
      for (const m of msgs) {
        const e = m.envelope ?? {};
        const from = addr(e.from)[0] ?? addr(e.sender)[0] ?? { name: '', address: '' };
        out.push({
          uid: m.uid,
          flags: flagsFrom(m.flags),
          messageIdHdr: e.messageId ?? '',
          inReplyTo: (e.inReplyTo ?? '').trim().split(/\s+/)[0] ?? '',
          references: referencesFromHeaders(m.headers),
          from,
          to: addr(e.to),
          cc: addr(e.cc),
          bcc: addr(e.bcc),
          replyTo: addr(e.replyTo),
          subject: e.subject ?? '',
          snippet: snippets.get(m.uid) ?? '',
          date: dateOf(e.date) || dateOf(m.internalDate),
          size: m.size ?? 0,
          hasAttachments: hasAttachments(m.bodyStructure),
        });
      }
    }
    return out;
  }

  async fetchFlags(range: string, changedSince?: string): Promise<RemoteFlags[]> {
    const msgs = await this.c.fetchAll(range, { uid: true, flags: true }, changedSince ? { uid: true, changedSince: BigInt(changedSince) } : { uid: true });
    return msgs.map((m) => ({ uid: m.uid, flags: flagsFrom(m.flags) }));
  }

  async fetchSource(uid: number): Promise<Buffer | null> {
    const m = await this.c.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    return m && m.source ? m.source : null;
  }

  async storeFlags(uids: number[], add: string[], remove: string[]): Promise<void> {
    const range = uids.join(',');
    if (add.length) await this.c.messageFlagsAdd(range, add, { uid: true });
    if (remove.length) await this.c.messageFlagsRemove(range, remove, { uid: true });
  }

  async move(uids: number[], destination: string): Promise<Map<number, number> | null> {
    const r = await this.c.messageMove(uids.join(','), destination, { uid: true });
    if (!r) throw new Error('MOVE failed');
    return r.uidMap ?? null;
  }

  async expunge(uids: number[]): Promise<void> {
    const ok = await this.c.messageDelete(uids.join(','), { uid: true });
    if (!ok) throw new Error('EXPUNGE failed');
  }

  async append(path: string, raw: Buffer, flags: string[]): Promise<void> {
    const r = await this.c.append(path, raw, flags);
    if (!r) throw new Error('APPEND failed');
  }

  async createFolder(path: string): Promise<void> {
    await this.c.mailboxCreate(path);
  }

  async rest(inboxPath: string): Promise<void> {
    if (this.c.mailbox && this.c.mailbox.path === inboxPath) return;
    await this.c.mailboxOpen(inboxPath);
  }

  onChange(cb: (path: string) => void): void {
    this.changeCbs.push(cb);
  }

  onClose(cb: () => void): void {
    if (!this.c.usable) {
      cb();
      return;
    }
    this.closeCbs.push(cb);
  }

  async close(): Promise<void> {
    try {
      await Promise.race([this.c.logout(), new Promise((r) => setTimeout(r, 2000))]);
    } catch {
      // closing anyway
    }
    this.c.close();
  }
}
