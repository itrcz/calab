/**
 * Real network for discovery (engine side): DNS, https fetch and the TLS greeting probes (§4), and
 * the certificate check every IMAP / SMTP connection goes through (`mailTlsOptions`, §4, §10).
 * Certificates are always verified; a certificate the user trusted once (`pinnedCert`) is admitted
 * by its exact fingerprint. `tls` lets the opt-in integration test trust its own CA.
 */
import { resolveMx, resolveSrv } from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { connect as netConnect, type Socket } from 'node:net';
import tls, { type ConnectionOptions, type TLSSocket } from 'node:tls';
import type { MailCertInfo, MailServerSettings } from '../../shared/mail';
import type { DiscoverNet, ProbeResult } from './discover';
import { certInfo, certReason, MailCertError, type PeerCert } from './errors';

/** Extra TLS options (tests only: a private CA). Never weakens verification. */
export interface MailTls {
  ca?: ConnectionOptions['ca'];
}

// ---------------------------------------------------------------- the certificate check

/** What the guarded `tls.connect` checks for one connection (carried in the TLS options). */
interface CertCheck {
  host: string;
  port: number;
  pin: string | undefined;
}

/** The option key imapflow / nodemailer pass through to `tls.connect` untouched (Object.assign). */
const CHECK_KEY = 'calabMailCertCheck';

/**
 * The verdict on a finished handshake: null = go on (a valid certificate, or exactly the pinned
 * one), else the certificate and why it is not trusted (`changed` when a pin exists).
 */
export function judgeCert(sock: Pick<TLSSocket, 'authorized' | 'authorizationError' | 'getPeerCertificate'>, check: CertCheck): MailCertInfo | null {
  if (sock.authorized) return null;
  const cert = sock.getPeerCertificate(true) as PeerCert | null;
  const fp = typeof cert?.fingerprint256 === 'string' ? cert.fingerprint256.toUpperCase() : '';
  if (check.pin && fp && fp === check.pin) return null;
  const err = sock.authorizationError as unknown;
  const code = err instanceof Error ? (err as { code?: string }).code ?? err.message : typeof err === 'string' ? err : undefined;
  return certInfo(cert, check.host, check.port, check.pin ? 'changed' : certReason(code));
}

type Connect = typeof tls.connect;
let original: Connect | null = null;
let guarded: Connect | null = null;

/**
 * Wraps `tls.connect` once per process (imapflow and nodemailer call it on the module object). For
 * options carrying `CHECK_KEY` only — every other caller is untouched — the handshake runs with
 * `rejectUnauthorized: false` so the peer certificate stays readable, and we decide before any
 * `secureConnect` listener runs: an untrusted certificate destroys the socket with a
 * `MailCertError`, the library never sees the handshake finish, no command (LOGIN / AUTH) is written.
 * Without the wrapper the options stay `rejectUnauthorized: true`: strict, never open.
 */
function installGuard(): void {
  if (guarded && tls.connect === guarded) return;
  const orig = tls.connect;
  original = orig;
  guarded = function guardedConnect(this: unknown, ...args: unknown[]): TLSSocket {
    const i = args.findIndex((a) => typeof a === 'object' && a !== null);
    const opts = i >= 0 ? (args[i] as Record<string, unknown>) : undefined;
    const check = opts?.[CHECK_KEY] as CertCheck | undefined;
    if (!opts || !check) return (orig as (...a: unknown[]) => TLSSocket).apply(this, args);
    const { [CHECK_KEY]: _drop, ...rest } = opts;
    const call = [...args];
    call[i] = { ...rest, rejectUnauthorized: false };
    const sock = (orig as (...a: unknown[]) => TLSSocket).apply(this, call);
    // Node announces the finished handshake with this.emit('secureConnect'): we judge first, and an
    // untrusted certificate never reaches any listener (the library's callback included).
    const emit: (event: string | symbol, ...a: unknown[]) => boolean = sock.emit.bind(sock);
    sock.emit = function (event: string | symbol, ...a: unknown[]): boolean {
      if (event === 'secureConnect') {
        const bad = judgeCert(sock, check);
        if (bad) {
          sock.destroy(new MailCertError(bad));
          return false;
        }
      }
      return emit(event, ...a);
    } as typeof sock.emit;
    return sock;
  };
  tls.connect = guarded;
  // ESM importers of `node:tls` read the named export: keep it in step with the module object.
  syncBuiltinESMExports();
}

/** Whether the guarded `tls.connect` is in place (tests). */
export function tlsGuardInstalled(): boolean {
  return guarded !== null && tls.connect === guarded && original !== null;
}

/**
 * TLS options for an IMAP / SMTP connection to `server` (imapflow `tls`, nodemailer `tls`): strict
 * verification, plus `pinnedCert` admitted by fingerprint. See `installGuard`.
 */
export function mailTlsOptions(server: MailServerSettings, extra: MailTls = {}): ConnectionOptions {
  installGuard();
  const check: CertCheck = { host: server.host, port: server.port, pin: server.pinnedCert?.toUpperCase() };
  return { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(extra.ca ? { ca: extra.ca } : {}), [CHECK_KEY]: check } as ConnectionOptions;
}

const MAX_XML = 256 * 1024;

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  if (!url.startsWith('https://')) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { Accept: 'application/xml, text/xml' } });
    // A redirect off https is not followed into plain http (fetch keeps the scheme check to us).
    if (!res.ok || !res.url.startsWith('https://')) return null;
    const text = await res.text();
    return text.length > MAX_XML ? null : text;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

type Step = (line: string) => 'more' | 'ok' | 'fail';

/** Reads CRLF lines from a socket until `step` decides. */
function converse(sock: Socket | TLSSocket, step: Step): Promise<boolean> {
  return new Promise((resolve) => {
    let buf = '';
    const finish = (v: boolean): void => {
      sock.off('data', onData);
      sock.off('error', onErr);
      sock.off('close', onErr);
      resolve(v);
    };
    const onErr = (): void => finish(false);
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('latin1');
      if (buf.length > 16384) { finish(false); return; }
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        const r = step(line);
        if (r !== 'more') { finish(r === 'ok'); return; }
      }
    };
    sock.on('data', onData);
    sock.once('error', onErr);
    sock.once('close', onErr);
  });
}

const greetingOk = (kind: 'imap' | 'smtp'): Step => (l) => (kind === 'imap' ? (/^\* (OK|PREAUTH)/i.test(l) ? 'ok' : 'fail') : /^220[ -]/.test(l) ? (l[3] === '-' ? 'more' : 'ok') : 'fail');

/**
 * A TLS handshake for a probe: never refused for the certificate (nothing secret is sent on a
 * probe), the verdict comes back with the socket.
 */
function tlsUp(opts: ConnectionOptions, check: CertCheck, extra: MailTls): Promise<{ s: TLSSocket; issue: MailCertInfo | null } | null> {
  return new Promise((resolve) => {
    const s = tls.connect({ ...opts, ...(extra.ca ? { ca: extra.ca } : {}), rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    s.once('secureConnect', () => resolve({ s, issue: judgeCert(s, check) }));
    s.once('error', () => {
      s.destroy();
      resolve(null);
    });
  });
}

/**
 * TCP + TLS (implicit or STARTTLS) + server greeting. `ok` when a TLS mail server answers; a
 * certificate that does not verify (and is not the pinned one) still counts, marked `certIssue`.
 */
export async function probeServer(kind: 'imap' | 'smtp', server: MailServerSettings, timeoutMs: number, extra: MailTls = {}): Promise<ProbeResult> {
  const sockets: Array<Socket | TLSSocket> = [];
  const check: CertCheck = { host: server.host, port: server.port, pin: server.pinnedCert?.toUpperCase() };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail: ProbeResult = { ok: false };
  const timeout = new Promise<ProbeResult>((r) => (timer = setTimeout(() => r(fail), timeoutMs)));
  const result = (issue: MailCertInfo | null): ProbeResult => (issue ? { ok: true, certIssue: issue } : { ok: true });
  const attempt = async (): Promise<ProbeResult> => {
    if (server.security === 'tls') {
      const up = await tlsUp({ host: server.host, port: server.port, servername: server.host }, check, extra);
      if (!up) return fail;
      sockets.push(up.s);
      return (await converse(up.s, greetingOk(kind))) ? result(up.issue) : fail;
    }
    const plain = netConnect({ host: server.host, port: server.port });
    sockets.push(plain);
    const connected = await new Promise<boolean>((r) => {
      plain.once('connect', () => r(true));
      plain.once('error', () => r(false));
    });
    if (!connected || !(await converse(plain, greetingOk(kind)))) return fail;
    if (kind === 'imap') {
      plain.write('a1 STARTTLS\r\n');
      if (!(await converse(plain, (l) => (/^a1 OK/i.test(l) ? 'ok' : /^a1 /i.test(l) ? 'fail' : 'more')))) return fail;
    } else {
      plain.write('EHLO calab.local\r\n');
      if (!(await converse(plain, (l) => (/^250 /.test(l) ? 'ok' : /^250-/.test(l) ? 'more' : 'fail')))) return fail;
      plain.write('STARTTLS\r\n');
      if (!(await converse(plain, (l) => (/^220[ ]/.test(l) ? 'ok' : 'fail')))) return fail;
    }
    const up = await tlsUp({ socket: plain, servername: server.host }, check, extra);
    if (!up) return fail;
    sockets.push(up.s);
    return result(up.issue);
  };
  try {
    return await Promise.race([attempt().catch(() => fail), timeout]);
  } finally {
    clearTimeout(timer);
    for (const s of sockets) s.destroy();
  }
}

export function realDiscoverNet(extra: MailTls = {}): DiscoverNet {
  return {
    resolveMx: (d) => resolveMx(d),
    resolveSrv: (n) => resolveSrv(n),
    fetchText,
    probe: (kind, server, ms) => probeServer(kind, server, ms, extra),
  };
}
