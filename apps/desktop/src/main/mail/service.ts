/**
 * The mail engine's core (ADR-0088 §3–§7): accounts (handed over by main with passwords), one
 * store + sync + outbox per account, the `MailHandlers` table for renderer calls, and main's own
 * `verify` / `attachment` requests. Runs inside the utilityProcess (engine.ts); no Electron APIs.
 */
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MAIL_SETTINGS,
  MAIL_CERT_FINGERPRINT_RE,
  type MailAccount,
  type MailCertInfo,
  type MailAddress,
  type MailAttachmentData,
  type MailCursor,
  type MailDiscovery,
  type MailDraft,
  type MailDraftAttachment,
  type MailEngineAccount,
  type MailEvent,
  type MailFolderRef,
  type MailFolderRole,
  type MailHandlers,
  type MailHeader,
  type MailMessage,
  type MailOutgoing,
  type MailPage,
  type MailSelection,
  type MailServerSettings,
  type MailSettings,
  type MailThreadRow,
  type MailVerified,
  type MailVerifyInput,
  mailMethods,
} from '../../shared/mail';
import { appPasswordUrl, discover, domainOf, providerByDomain, resolveLogin, STEP_TIMEOUT_MS, type DiscoverNet } from './discover';
import { classify, invalid, mailError, notFound } from './errors';
import { accountOf, ATTACHMENT_ID_RE, folderId, parseFolderId, parseMessageId, parseSeqId } from './ids';
import type { MailTls } from './net';
import { buildBodies, compose, newMessageIdHeader, Outbox, type QuotedOriginal } from './send';
import type { ImapSession } from './session';
import { ftsQuery, MailStore, SettingsDb, type Scope } from './store';
import { AccountSync } from './sync';

const ROLES: ReadonlySet<string> = new Set(['inbox', 'starred', 'sent', 'drafts', 'outbox', 'archive', 'junk', 'trash']);
const ADDRESS_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/;

export interface EngineDeps {
  dataDir: string;
  emit(event: MailEvent): void;
  connectImap(acc: MailEngineAccount): Promise<ImapSession>;
  verifyImap(acc: { server: MailEngineAccount['imap']; login: string; password: string }): Promise<void>;
  verifySmtp(acc: { server: MailEngineAccount['smtp']; login: string; password: string }): Promise<void>;
  smtpSend(acc: MailEngineAccount, envelope: { from: string; to: string[] }, raw: Buffer): Promise<void>;
  discoverNet: DiscoverNet;
  now?: () => number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  tls?: MailTls;
}

interface Account {
  cfg: MailEngineAccount;
  dir: string;
  store: MailStore;
  sync: AccountSync;
  outbox: Outbox;
  /** The last send failed on the SMTP certificate (shown on the account row until fixed). */
  smtpCert: MailCertInfo | null;
}

/** Settings as given, with a well-formed pin kept (upper-cased) and anything else dropped. */
function serverOf(s: MailServerSettings): MailServerSettings {
  const out: MailServerSettings = { host: s.host.toLowerCase(), port: s.port, security: s.security };
  const pin = typeof s.pinnedCert === 'string' ? s.pinnedCert.toUpperCase() : undefined;
  if (pin && MAIL_CERT_FINGERPRINT_RE.test(pin)) out.pinnedCert = pin;
  return out;
}

// ---------------------------------------------------------------- input validation

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = 10_000): v is string => typeof v === 'string' && v.length <= max;

function addresses(v: unknown, field: string): MailAddress[] {
  if (!Array.isArray(v) || v.length > 500) throw invalid(`${field}: expected an address list`);
  return v.map((a) => {
    if (!isObj(a) || !isStr(a['address'], 320) || !ADDRESS_RE.test(a['address'].trim())) throw invalid(`${field}: bad address`);
    return { name: isStr(a['name'], 300) ? a['name'].replace(/[\r\n]/g, ' ') : '', address: a['address'].trim() };
  });
}

function cursor(v: unknown): MailCursor | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v) || typeof v['date'] !== 'number' || !isStr(v['id'], 200)) throw invalid('bad cursor');
  return { date: v['date'], id: v['id'] };
}

function limitOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 200) throw invalid('limit must be 1..200');
  return v;
}

function folderRef(v: unknown): MailFolderRef {
  if (typeof v === 'string' && ROLES.has(v)) return v as MailFolderRole;
  if (isObj(v) && isStr(v['id'], 100)) return { id: v['id'] };
  throw invalid('bad folder');
}

function draftOf(v: unknown): MailDraft {
  if (!isObj(v) || !isStr(v['accountId'], 40)) throw invalid('bad draft');
  const atts = v['attachments'];
  if (!Array.isArray(atts) || atts.length > 100) throw invalid('bad attachments');
  const attachments: MailDraftAttachment[] = atts.map((a): MailDraftAttachment => {
    if (!isObj(a) || !isStr(a['id'], 100) || !isStr(a['name'], 255) || !isStr(a['mime'], 200) || typeof a['size'] !== 'number') throw invalid('bad attachment');
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(a['mime']) ? a['mime'] : 'application/octet-stream';
    if (a['kind'] === 'file') {
      if (!(a['data'] instanceof Uint8Array)) throw invalid('attachment data must be bytes');
      return { kind: 'file', id: a['id'], name: a['name'], mime, size: a['data'].byteLength, data: a['data'] };
    }
    if (a['kind'] === 'message' && isStr(a['messageId'], 100) && isStr(a['attachmentId'], 10)) {
      return { kind: 'message', id: a['id'], name: a['name'], mime, size: a['size'], messageId: a['messageId'], attachmentId: a['attachmentId'] };
    }
    throw invalid('bad attachment');
  });
  const d: MailDraft = {
    accountId: v['accountId'],
    to: addresses(v['to'] ?? [], 'to'),
    cc: addresses(v['cc'] ?? [], 'cc'),
    bcc: addresses(v['bcc'] ?? [], 'bcc'),
    subject: isStr(v['subject'], 2000) ? v['subject'].replace(/[\r\n]+/g, ' ') : '',
    text: isStr(v['text'], 5_000_000) ? v['text'] : '',
    attachments,
  };
  if (isStr(v['id'], 60)) d.id = v['id'];
  const ref = v['ref'];
  if (isObj(ref)) {
    if (!isStr(ref['messageId'], 100) || !['reply', 'replyAll', 'forward'].includes(String(ref['kind']))) throw invalid('bad ref');
    d.ref = { messageId: ref['messageId'], kind: ref['kind'] as 'reply' | 'replyAll' | 'forward', quote: ref['quote'] === true };
  }
  return d;
}

/** Drafts on disk: attachment bytes as base64. */
type StoredDraft = Omit<MailDraft, 'attachments'> & { attachments: Array<Omit<MailDraftAttachment, 'data'> & { data64?: string }> };

function draftToJson(d: MailDraft): string {
  const s: StoredDraft = {
    ...d,
    attachments: d.attachments.map((a) => (a.kind === 'file' ? { kind: 'file', id: a.id, name: a.name, mime: a.mime, size: a.size, data64: Buffer.from(a.data).toString('base64') } : a)),
  };
  return JSON.stringify(s);
}

function draftFromJson(json: string): MailDraft | null {
  try {
    const s = JSON.parse(json) as StoredDraft;
    return {
      ...s,
      attachments: s.attachments.map((a): MailDraftAttachment => {
        if (a.kind === 'file') {
          const buf = Buffer.from(a.data64 ?? '', 'base64');
          return { kind: 'file', id: a.id, name: a.name, mime: a.mime, size: a.size, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
        }
        return a as MailDraftAttachment;
      }),
    };
  } catch {
    return null;
  }
}

function settingsPatch(v: unknown): Partial<MailSettings> {
  if (!isObj(v)) throw invalid('bad settings');
  const out: Partial<MailSettings> = {};
  if ('remoteImages' in v) {
    if (v['remoteImages'] !== 'ask' && v['remoteImages'] !== 'always') throw invalid('remoteImages');
    out.remoteImages = v['remoteImages'];
  }
  if ('remoteImageSenders' in v) {
    const l = v['remoteImageSenders'];
    if (!Array.isArray(l) || l.length > 5000 || !l.every((x) => isStr(x, 320))) throw invalid('remoteImageSenders');
    out.remoteImageSenders = [...new Set(l.map((x) => x.trim().toLowerCase()))];
  }
  if ('notify' in v) {
    if (typeof v['notify'] !== 'boolean') throw invalid('notify');
    out.notify = v['notify'];
  }
  if ('signatures' in v) {
    const s = v['signatures'];
    if (!isObj(s) || !Object.values(s).every((x) => isStr(x, 10_000))) throw invalid('signatures');
    out.signatures = s as Record<string, string>;
  }
  if ('cacheLimitBytes' in v) {
    const n = v['cacheLimitBytes'];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 50 * 1024 * 1024 || n > 100 * 1024 ** 3) throw invalid('cacheLimitBytes');
    out.cacheLimitBytes = Math.floor(n);
  }
  return out;
}

// ---------------------------------------------------------------- the engine

export class MailEngine {
  private readonly accounts = new Map<string, Account>();
  private readonly settingsDb: SettingsDb;
  private settingsCache: MailSettings;
  private readonly now: () => number;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;

  constructor(private readonly deps: EngineDeps) {
    // userData/mail holds every account's cache (bodies, addresses): owner-only where POSIX modes apply.
    mkdirSync(deps.dataDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(deps.dataDir, 0o700);
    } catch {
      // Windows: the profile's ACLs already restrict it.
    }
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => undefined);
    this.settingsDb = new SettingsDb(join(deps.dataDir, 'settings.sqlite'));
    this.settingsCache = { ...structuredClone(DEFAULT_MAIL_SETTINGS), ...(this.settingsDb.get() as Partial<MailSettings>) };
  }

  // ------------------------------------------------------------ accounts from main

  /** The account list from main (with passwords): start / restart / stop syncs by diff. */
  async setAccounts(list: MailEngineAccount[]): Promise<void> {
    const ids = new Set(list.map((a) => a.id));
    for (const [id, acc] of this.accounts) {
      if (ids.has(id)) continue;
      await this.closeAccount(acc);
      this.accounts.delete(id);
      rmSync(acc.dir, { recursive: true, force: true });
      const sigs = { ...this.settingsCache.signatures };
      if (id in sigs) {
        delete sigs[id];
        this.saveSettings({ signatures: sigs });
      }
      this.deps.emit({ type: 'account_state', accountId: id, account: null });
    }
    for (const cfg of list) {
      if (!/^a[0-9a-f]{16}$/.test(cfg.id)) continue;
      const cur = this.accounts.get(cfg.id);
      if (!cur) {
        this.openAccount(cfg);
        continue;
      }
      const reconnect =
        cur.cfg.password !== cfg.password || cur.cfg.login !== cfg.login || JSON.stringify(cur.cfg.imap) !== JSON.stringify(cfg.imap) || JSON.stringify(cur.cfg.smtp) !== JSON.stringify(cfg.smtp);
      if (JSON.stringify(cur.cfg.smtp) !== JSON.stringify(cfg.smtp)) cur.smtpCert = null;
      cur.cfg = cfg;
      if (reconnect) {
        await cur.sync.stop();
        cur.sync = this.newSync(cur);
        cur.sync.start();
        cur.outbox.kick();
      }
      this.emitAccount(cur);
    }
  }

  private openAccount(cfg: MailEngineAccount): void {
    const dir = join(this.deps.dataDir, cfg.id);
    const store = new MailStore(dir, cfg.id, this.now);
    const acc = { cfg, dir, store, smtpCert: null } as unknown as Account;
    acc.sync = this.newSync(acc);
    acc.outbox = new Outbox({
      store,
      accountId: cfg.id,
      dir,
      send: async (env, raw) => {
        try {
          await this.deps.smtpSend(acc.cfg, env, raw);
        } catch (e) {
          const cert = classify(e).cert ?? null;
          if (cert && cert.fingerprint256 !== acc.smtpCert?.fingerprint256) {
            acc.smtpCert = cert;
            this.emitAccount(acc);
          }
          throw e;
        }
        if (acc.smtpCert) {
          acc.smtpCert = null;
          this.emitAccount(acc);
        }
      },
      sent: async (raw, answers) => {
        if (answers) acc.sync.markAnswered(answers);
        await acc.sync.appendSent(raw);
      },
      emit: (e) => this.deps.emit(e),
      foldersChanged: () => acc.sync.emitFolders(),
      now: this.now,
      log: this.log,
    });
    this.accounts.set(cfg.id, acc);
    this.emitAccount(acc);
    acc.sync.start();
    acc.outbox.kick();
  }

  private newSync(acc: Account): AccountSync {
    return new AccountSync({
      store: acc.store,
      accountId: acc.cfg.id,
      email: acc.cfg.email.toLowerCase(),
      provider: acc.cfg.provider,
      connect: () => this.deps.connectImap(acc.cfg),
      emit: (e) => this.deps.emit(e),
      stateChanged: () => {
        this.emitAccount(acc);
        // Back online: retry what waits in the outbox.
        if (acc.sync.state === 'idle') acc.outbox.kick();
      },
      cacheLimit: () => this.settingsCache.cacheLimitBytes,
      now: this.now,
      log: this.log,
    });
  }

  private async closeAccount(acc: Account): Promise<void> {
    acc.outbox.stop();
    await acc.sync.stop();
    acc.store.close();
  }

  async shutdown(): Promise<void> {
    for (const acc of this.accounts.values()) await this.closeAccount(acc);
    this.accounts.clear();
    this.settingsDb.close();
  }

  private toAccount(acc: Account): MailAccount {
    const c = acc.cfg;
    return {
      id: c.id,
      email: c.email,
      name: c.name,
      provider: c.provider,
      imap: c.imap,
      smtp: c.smtp,
      login: c.login,
      state: acc.sync.state,
      error: acc.sync.error,
      lastSyncAt: acc.sync.lastSyncAt,
      ...(acc.smtpCert ? { smtpCertIssue: acc.smtpCert } : {}),
    };
  }

  private emitAccount(acc: Account): void {
    if (this.accounts.get(acc.cfg.id) !== acc) return;
    this.deps.emit({ type: 'account_state', accountId: acc.cfg.id, account: this.toAccount(acc) });
  }

  private account(id: unknown): Account {
    const acc = typeof id === 'string' ? this.accounts.get(accountOf(id) ?? '') : undefined;
    if (!acc) throw notFound('account');
    return acc;
  }

  // ------------------------------------------------------------ main's requests

  /** Discovery (unless settings are given) + real IMAP and SMTP logins (§4). Nothing is stored. */
  async verify(input: MailVerifyInput): Promise<MailVerified> {
    if (!isObj(input) || !isStr(input.email, 320) || !isStr(input.password, 1024)) throw invalid('bad account input');
    const email = input.email.trim().toLowerCase();
    if (!ADDRESS_RE.test(email)) throw invalid('not an e-mail address');
    let v: MailVerified;
    let disc: MailDiscovery;
    if (input.settings) {
      const s = input.settings;
      for (const srv of [s.imap, s.smtp]) {
        if (!isObj(srv) || !isStr(srv.host, 253) || !/^[a-z0-9.-]+$/i.test(srv.host) || !Number.isInteger(srv.port) || srv.port < 1 || srv.port > 65535 || !['tls', 'starttls'].includes(srv.security)) {
          throw invalid('bad server settings');
        }
        if (srv.pinnedCert !== undefined && (!isStr(srv.pinnedCert, 100) || !MAIL_CERT_FINGERPRINT_RE.test(srv.pinnedCert.toUpperCase()))) throw invalid('bad certificate pin');
      }
      if (!isStr(s.login, 320) || !s.login) throw invalid('bad login');
      const known = providerByDomain(domainOf(email));
      if (known?.id === 'microsoft') throw mailError('UNSUPPORTED_PROVIDER', 'Microsoft accounts need OAuth2, not supported yet');
      const provider = known?.id ?? (/\.gmail\.com$/i.test(s.imap.host) ? 'gmail' : 'other');
      v = { provider, imap: serverOf(s.imap), smtp: serverOf(s.smtp), login: s.login };
      disc = { imap: v.imap, smtp: v.smtp, source: 'manual', provider, loginTemplate: s.login, appPasswordUrl: appPasswordUrl(provider) };
    } else {
      disc = await discover(email, this.deps.discoverNet, this.now);
      v = { provider: disc.provider, imap: serverOf(disc.imap), smtp: serverOf(disc.smtp), login: resolveLogin(disc.loginTemplate, email) };
    }
    const fail = async (e: unknown, kind: 'imap' | 'smtp'): Promise<never> => {
      const c = classify(e);
      if (c.cert) {
        // The trust prompt (§4): this server's certificate, and — when IMAP failed first — whether
        // SMTP has the same problem (a probe: no login), so both are asked about at once.
        const { certIssue: _a, ...imap } = disc.imap;
        const { certIssue: _b, ...smtp } = disc.smtp;
        disc = { ...disc, imap, smtp, [kind]: { ...disc[kind], certIssue: c.cert } };
        if (kind === 'imap') {
          const other = await this.deps.discoverNet.probe('smtp', v.smtp, STEP_TIMEOUT_MS).catch(() => null);
          if (other?.ok && other.certIssue) disc = { ...disc, smtp: { ...disc.smtp, certIssue: other.certIssue } };
        }
      }
      throw mailError(c.code, c.message, c.code === 'AUTH_FAILED' || c.code === 'NETWORK' || c.code === 'TLS' ? disc : undefined, c.cert);
    };
    await this.deps.verifyImap({ server: v.imap, login: v.login, password: input.password }).catch((e: unknown) => fail(e, 'imap'));
    await this.deps.verifySmtp({ server: v.smtp, login: v.login, password: input.password }).catch((e: unknown) => fail(e, 'smtp'));
    return v;
  }

  /** Attachment bytes for main's `calaba-mail://` handler (downloads the message when evicted). */
  async attachment(messageId: string, attachmentId: string): Promise<MailAttachmentData> {
    if (!parseMessageId(messageId) || !ATTACHMENT_ID_RE.test(attachmentId)) throw invalid('bad attachment id');
    const acc = this.account(messageId);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!acc.store.header(messageId)?.bodyHash) await acc.sync.fetchBody(messageId);
      const att = acc.store.attachments(messageId).find((a) => a.id === attachmentId);
      if (!att) throw notFound('attachment');
      const data = att.hash ? acc.store.getBlob(att.hash) : null;
      if (data) return { name: att.name, mime: att.mime, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
      // Evicted: drop the body too, so the next round downloads the message again.
      acc.store.db.prepare('UPDATE messages SET body_hash = NULL WHERE id = ?').run(messageId);
    }
    throw notFound('attachment');
  }

  // ------------------------------------------------------------ folders & lists

  private resolveFolder(acc: Account, ref: MailFolderRef): { scope: Scope; rowFolder?: string; virtual?: 'drafts' | 'outbox'; row?: number } | null {
    if (typeof ref === 'string') {
      if (ref === 'drafts' || ref === 'outbox') return { scope: { kind: 'all', exclude: [] }, virtual: ref };
      const f = acc.store.folderByRole(ref);
      if (f) return { scope: { kind: 'folder', row: f.row }, row: f.row };
      if (ref === 'starred') return { scope: acc.sync.starredScope(), rowFolder: folderId(acc.cfg.id, 'starred') };
      return null;
    }
    const p = parseFolderId(ref.id);
    if (p?.accountId !== acc.cfg.id) throw notFound('folder');
    if (p.virtual === 'starred') return { scope: acc.sync.starredScope(), rowFolder: folderId(acc.cfg.id, 'starred') };
    if (p.virtual) return { scope: { kind: 'all', exclude: [] }, virtual: p.virtual };
    if (!acc.store.folder(p.row)) throw notFound('folder');
    return { scope: { kind: 'folder', row: p.row }, row: p.row };
  }

  private accountsFor(scope: unknown, ref: MailFolderRef | undefined): Account[] {
    if (scope === 'all') {
      if (ref !== undefined && typeof ref !== 'string') throw invalid("scope 'all' takes a folder role");
      return [...this.accounts.values()];
    }
    return [this.account(scope)];
  }

  private page(rows: MailThreadRow[], limit: number): MailPage {
    rows.sort((a, b) => b.date - a.date || (a.messageId < b.messageId ? 1 : a.messageId > b.messageId ? -1 : 0));
    const out = rows.slice(0, limit);
    const last = out[out.length - 1];
    return { rows: out, next: out.length === limit && last ? { date: last.date, id: last.messageId } : null };
  }

  list(q: unknown): MailPage {
    if (!isObj(q)) throw invalid('bad query');
    const ref = folderRef(q['folder']);
    const limit = limitOf(q['limit']);
    const before = cursor(q['before']);
    const rows: MailThreadRow[] = [];
    for (const acc of this.accountsFor(q['scope'], ref)) {
      const r = this.resolveFolder(acc, ref);
      if (!r || r.virtual) continue;
      if (r.row !== undefined) acc.sync.touchFolder(r.row);
      rows.push(...acc.store.listThreads(r.scope, { limit, ...(before ? { before } : {}), ...(q['unreadOnly'] === true ? { unreadOnly: true } : {}), ...(r.rowFolder ? { rowFolder: r.rowFolder } : {}) }));
    }
    return this.page(rows, limit);
  }

  search(q: unknown): MailPage {
    if (!isObj(q) || !isStr(q['text'], 500)) throw invalid('bad search');
    const limit = limitOf(q['limit']);
    const before = cursor(q['before']);
    const match = ftsQuery(q['text']);
    if (!match) return { rows: [], next: null };
    const ref = q['folder'] === undefined ? undefined : folderRef(q['folder']);
    const rows: MailThreadRow[] = [];
    for (const acc of this.accountsFor(q['scope'], ref)) {
      let scope: Scope;
      let rowFolder: string | undefined;
      if (ref === undefined) {
        const exclude = (['junk', 'trash'] as const).map((r) => acc.store.folderByRole(r)?.row).filter((x): x is number => x !== undefined);
        scope = { kind: 'all', exclude };
      } else {
        const r = this.resolveFolder(acc, ref);
        if (!r || r.virtual) continue;
        scope = r.scope;
        rowFolder = r.rowFolder;
      }
      rows.push(...acc.store.listThreads(scope, { limit, match, ...(before ? { before } : {}), ...(rowFolder ? { rowFolder } : {}) }));
    }
    return this.page(rows, limit);
  }

  async get(id: unknown): Promise<MailMessage> {
    if (!parseMessageId(id)) throw notFound('message');
    const mid = id as string;
    const acc = this.account(mid);
    let h = acc.store.header(mid);
    if (!h) throw notFound('message');
    let body = h.bodyHash ? acc.store.body(h.bodyHash) : null;
    if (!body) {
      await acc.sync.fetchBody(mid);
      h = acc.store.header(mid);
      body = h?.bodyHash ? acc.store.body(h.bodyHash) : null;
      if (!h || !body) throw notFound('message');
    }
    const { uid: _u, folderRow: _f, bodyHash: _b, references: _r, inReplyTo: _i, ...header } = h;
    return {
      ...header,
      html: body.html,
      text: body.text,
      attachments: acc.store.attachments(mid).map(({ hash: _h, ...a }) => a),
      inReplyTo: body.inReplyTo || h.inReplyTo,
      references: body.references.length ? body.references : h.references,
      remoteImages: body.remoteImages,
    };
  }

  private selection(sel: unknown): Map<Account, string[]> {
    const out = new Map<Account, string[]>();
    const add = (acc: Account, ids: string[]): void => {
      out.set(acc, [...(out.get(acc) ?? []), ...ids]);
    };
    if (!isObj(sel)) throw invalid('bad selection');
    const s = sel as MailSelection;
    if ('messageIds' in s) {
      if (!Array.isArray(s.messageIds) || s.messageIds.length > 10_000) throw invalid('bad selection');
      for (const id of s.messageIds) if (parseMessageId(id)) add(this.account(id), [id]);
    } else if ('threads' in s) {
      if (!Array.isArray(s.threads) || s.threads.length > 10_000) throw invalid('bad selection');
      for (const t of s.threads) {
        if (!isObj(t) || !parseSeqId(t.threadId, 't')) continue;
        const acc = this.account(t.threadId);
        const r = this.resolveFolder(acc, { id: t.folderId });
        if (!r || r.virtual) continue;
        add(acc, acc.store.threadMessageIds(t.threadId, r.scope));
      }
    } else throw invalid('bad selection');
    return out;
  }

  // ------------------------------------------------------------ compose

  private async send(d0: unknown): Promise<MailOutgoing> {
    const d = draftOf(d0);
    const acc = this.account(d.accountId);
    if (!d.to.length && !d.cc.length && !d.bcc.length) throw invalid('no recipients');
    let quote: QuotedOriginal | null = null;
    let inReplyTo = '';
    let references: string[] = [];
    let answers: string | undefined;
    if (d.ref) {
      const orig = await this.get(d.ref.messageId).catch(() => null);
      if (orig) {
        if (d.ref.kind !== 'forward') {
          answers = orig.id;
          inReplyTo = orig.messageIdHeader;
          references = [...orig.references, orig.messageIdHeader].filter(Boolean).slice(-30);
        }
        if (d.ref.quote) quote = { kind: d.ref.kind, from: orig.from, to: orig.to, date: orig.date, subject: orig.subject, text: orig.text ?? '' };
      }
    }
    const files: Array<{ name: string; mime: string; data: Uint8Array }> = [];
    for (const a of d.attachments) {
      if (a.kind === 'file') files.push({ name: a.name, mime: a.mime, data: a.data });
      else {
        const x = await this.attachment(a.messageId, a.attachmentId);
        files.push({ name: a.name || x.name, mime: x.mime, data: x.data });
      }
    }
    const messageIdHdr = newMessageIdHeader(acc.cfg.email);
    const raw = await compose({
      from: { name: acc.cfg.name, address: acc.cfg.email },
      draft: d,
      messageIdHdr,
      bodies: buildBodies(d.text, quote),
      inReplyTo,
      references,
      attachments: files,
      date: new Date(this.now()),
    });
    const recipients = [...new Set([...d.to, ...d.cc, ...d.bcc].map((a) => a.address))];
    const item = acc.outbox.enqueue(raw, { to: d.to, subject: d.subject, meta: { from: acc.cfg.email, recipients, messageIdHdr, ...(answers ? { answers } : {}) } });
    if (d.id) {
      const p = parseSeqId(d.id, 'd');
      if (p?.accountId === acc.cfg.id && acc.store.removeDraft(p.n)) acc.sync.emitFolders();
    }
    return item;
  }

  private saveDraft(d0: unknown): MailDraft {
    const d = draftOf(d0);
    const acc = this.account(d.accountId);
    const p = d.id ? parseSeqId(d.id, 'd') : null;
    if (d.id && p?.accountId !== acc.cfg.id) throw notFound('draft');
    const json = draftToJson({ ...d, id: '' });
    const r = acc.store.saveDraft(p ? p.n : null, json);
    acc.sync.emitFolders();
    return { ...d, id: `${acc.cfg.id}.d${String(r.n)}`, updatedAt: r.updatedAt };
  }

  private listDrafts(accountId: unknown): MailDraft[] {
    const accs = accountId === undefined || accountId === null ? [...this.accounts.values()] : [this.account(accountId)];
    const out: MailDraft[] = [];
    for (const acc of accs) {
      for (const r of acc.store.drafts()) {
        const d = draftFromJson(r.json);
        if (d) out.push({ ...d, id: `${acc.cfg.id}.d${String(r.n)}`, accountId: acc.cfg.id, updatedAt: r.updatedAt });
      }
    }
    return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  // ------------------------------------------------------------ settings

  private saveSettings(patch: Partial<MailSettings>): MailSettings {
    this.settingsDb.set(patch);
    this.settingsCache = { ...this.settingsCache, ...patch };
    if (patch.cacheLimitBytes !== undefined) for (const acc of this.accounts.values()) acc.store.evict(patch.cacheLimitBytes);
    return structuredClone(this.settingsCache);
  }

  // ------------------------------------------------------------ the handler table

  handlers(): MailHandlers {
    const byMain = (): Promise<never> => Promise.reject(invalid('handled by main'));
    const h: Record<string, (...a: unknown[]) => unknown> = {
      'accounts.list': () => [...this.accounts.values()].map((a) => this.toAccount(a)),
      'accounts.discover': (email) => {
        if (!isStr(email, 320)) throw invalid('bad address');
        return discover(email, this.deps.discoverNet, this.now);
      },
      'accounts.add': byMain,
      'accounts.update': byMain,
      'accounts.remove': byMain,
      'accounts.setPassword': byMain,
      'folders.list': (accountId) => this.account(accountId).sync.folders(),
      'messages.list': (q) => this.list(q),
      'messages.get': (id) => this.get(id),
      'messages.thread': (threadId): MailHeader[] => {
        if (!parseSeqId(threadId, 't')) throw notFound('thread');
        return this.account(threadId).store.thread(threadId as string);
      },
      'messages.setFlags': (sel, patch) => {
        if (!isObj(patch)) throw invalid('bad flags');
        const p: { seen?: boolean; flagged?: boolean } = {};
        if (typeof patch['seen'] === 'boolean') p.seen = patch['seen'];
        if (typeof patch['flagged'] === 'boolean') p.flagged = patch['flagged'];
        for (const [acc, ids] of this.selection(sel)) acc.sync.setFlags(ids, p);
      },
      'messages.move': (sel, target) => {
        const p = parseFolderId(target);
        if (!p || p.virtual) throw invalid('messages can only be moved into a real folder');
        for (const [acc, ids] of this.selection(sel)) {
          if (acc.cfg.id !== p.accountId) throw invalid('moving between accounts is not supported');
          acc.sync.move(ids, p.row);
        }
      },
      'messages.archive': (sel) => {
        for (const [acc, ids] of this.selection(sel)) acc.sync.archive(ids);
      },
      'messages.trash': (sel) => {
        for (const [acc, ids] of this.selection(sel)) acc.sync.trash(ids);
      },
      'messages.delete': (sel) => {
        for (const [acc, ids] of this.selection(sel)) acc.sync.delete(ids);
      },
      'messages.loadOlder': (fid) => {
        const p = parseFolderId(fid);
        if (!p) throw notFound('folder');
        if (p.virtual) return { exhausted: true };
        return this.account(p.accountId).sync.loadOlder(p.row);
      },
      'compose.send': (d) => this.send(d),
      'drafts.save': (d) => this.saveDraft(d),
      'drafts.list': (accountId) => this.listDrafts(accountId),
      'drafts.remove': (id) => {
        const p = parseSeqId(id, 'd');
        if (!p) throw notFound('draft');
        const acc = this.account(p.accountId);
        if (!acc.store.removeDraft(p.n)) throw notFound('draft');
        acc.sync.emitFolders();
      },
      'outgoing.list': (accountId) => {
        const accs = accountId === undefined || accountId === null ? [...this.accounts.values()] : [this.account(accountId)];
        return accs.flatMap((a) => a.outbox.list()).sort((a, b) => a.createdAt - b.createdAt);
      },
      'outgoing.retry': (id) => {
        const p = parseSeqId(id, 'o');
        if (!p) throw notFound('outgoing item');
        this.account(p.accountId).outbox.retry(p.n);
      },
      'outgoing.remove': (id) => {
        const p = parseSeqId(id, 'o');
        if (!p) throw notFound('outgoing item');
        this.account(p.accountId).outbox.remove(p.n);
      },
      search: (q) => this.search(q),
      'sync.now': (accountId) => {
        if (accountId === undefined || accountId === null) for (const a of this.accounts.values()) a.sync.syncNow();
        else this.account(accountId).sync.syncNow();
      },
      'settings.get': () => structuredClone(this.settingsCache),
      'settings.set': (patch) => this.saveSettings(settingsPatch(patch)),
      'settings.clearCache': (accountId) => {
        const accs = accountId === undefined || accountId === null ? [...this.accounts.values()] : [this.account(accountId)];
        for (const a of accs) a.store.clearBlobs();
      },
    };
    // Sync handlers throw (validation): every entry becomes a promise either way.
    const wrap =
      (fn: (...x: unknown[]) => unknown) =>
      (...args: unknown[]): Promise<unknown> => {
        try {
          return Promise.resolve(fn(...args));
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
    const table = Object.fromEntries(mailMethods.map((m) => [m, wrap(h[m] as (...x: unknown[]) => unknown)]));
    return table as unknown as MailHandlers;
  }
}
