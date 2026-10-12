/**
 * Mail accounts in main (ADR-0088 §3, §10): `userData/mail/accounts.bin`, the whole list with the
 * IMAP / SMTP settings and passwords encrypted by `safeStorage` (Keychain / DPAPI / libsecret), the
 * same pattern as the refresh token in auth.ts. Without OS encryption the list is kept in memory
 * only (with a warning): accounts are gone after a restart, but no password is written in clear.
 * Passwords leave main only towards the engine (`MailToEngine.accounts`), never to the renderer
 * or the log.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MAIL_CERT_FINGERPRINT_RE, type MailEngineAccount, type MailProvider, type MailSecurity, type MailServerSettings } from '../../shared/mail';

/** `safeStorage` as main uses it (a fake in tests). */
export interface SecretBox {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

const PROVIDERS: ReadonlySet<string> = new Set(['gmail', 'yandex', 'mailru', 'icloud', 'microsoft', 'other']);

function validServer(v: unknown): v is { host: string; port: number; security: MailSecurity } {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s['host'] === 'string' && typeof s['port'] === 'number' && (s['security'] === 'tls' || s['security'] === 'starttls');
}

/**
 * Server settings from untrusted input (the renderer, the file): host / port / security, plus a
 * well-formed `pinnedCert` (a certificate the user trusted, §4) — a malformed pin is dropped.
 */
export function serverSettings(v: unknown): MailServerSettings | null {
  if (!validServer(v)) return null;
  const out: MailServerSettings = { host: v.host, port: v.port, security: v.security };
  const pin = (v as { pinnedCert?: unknown }).pinnedCert;
  if (typeof pin === 'string' && MAIL_CERT_FINGERPRINT_RE.test(pin.toUpperCase())) out.pinnedCert = pin.toUpperCase();
  return out;
}

function validAccount(v: unknown): v is MailEngineAccount {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a['id'] === 'string' &&
    /^a[0-9a-f]{16}$/.test(a['id']) &&
    typeof a['email'] === 'string' &&
    typeof a['name'] === 'string' &&
    typeof a['login'] === 'string' &&
    typeof a['password'] === 'string' &&
    typeof a['provider'] === 'string' &&
    PROVIDERS.has(a['provider']) &&
    validServer(a['imap']) &&
    validServer(a['smtp'])
  );
}

export class MailAccountsFile {
  private list: MailEngineAccount[] = [];
  private loaded = false;
  private warned = false;

  constructor(
    private readonly file: string,
    private readonly box: SecretBox,
    private readonly warn: (message: string) => void,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.file) || !this.box.available()) return;
      const data = JSON.parse(this.box.decrypt(readFileSync(this.file))) as { v?: number; accounts?: unknown[] };
      this.list = (data.accounts ?? []).filter(validAccount).map((a) => ({ ...a, imap: serverSettings(a.imap) ?? a.imap, smtp: serverSettings(a.smtp) ?? a.smtp }));
    } catch {
      // Never log the content: it holds passwords.
      this.warn('mail accounts file unreadable, ignoring');
    }
  }

  all(): MailEngineAccount[] {
    this.load();
    return this.list.map((a) => ({ ...a, imap: { ...a.imap }, smtp: { ...a.smtp } }));
  }

  get(id: string): MailEngineAccount | null {
    return this.all().find((a) => a.id === id) ?? null;
  }

  byEmail(email: string): MailEngineAccount | null {
    const e = email.trim().toLowerCase();
    return this.all().find((a) => a.email === e) ?? null;
  }

  /** Insert or replace by id, then persist. */
  put(acc: MailEngineAccount): void {
    this.load();
    const i = this.list.findIndex((a) => a.id === acc.id);
    if (i >= 0) this.list[i] = acc;
    else this.list.push(acc);
    this.persist();
  }

  remove(id: string): boolean {
    this.load();
    const n = this.list.length;
    this.list = this.list.filter((a) => a.id !== id);
    if (this.list.length === n) return false;
    this.persist();
    return true;
  }

  private persist(): void {
    if (!this.list.length) {
      rmSync(this.file, { force: true });
      return;
    }
    if (!this.box.available()) {
      if (!this.warned) this.warn('safeStorage unavailable: mail accounts kept in memory only (added again after restart)');
      this.warned = true;
      return;
    }
    // Owner-only where POSIX modes apply: the directory also holds the mail caches (engine).
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      chmodSync(dirname(this.file), 0o700);
    } catch {
      // Windows: the profile's ACLs already restrict it.
    }
    // Atomic: a crash mid-write leaves the previous list, not a truncated file.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, this.box.encrypt(JSON.stringify({ v: 1, accounts: this.list })), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export function isProvider(v: string): v is MailProvider {
  return PROVIDERS.has(v);
}
