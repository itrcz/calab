/**
 * Real network for discovery (engine side): DNS, https fetch and the TLS greeting probes (§4).
 * Certificates are always verified; `tls` lets the opt-in integration test trust its own CA.
 */
import { resolveMx, resolveSrv } from 'node:dns/promises';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import type { MailServerSettings } from '../../shared/mail';
import type { DiscoverNet } from './discover';

/** Extra TLS options (tests only: a private CA). Never weakens verification. */
export interface MailTls {
  ca?: ConnectionOptions['ca'];
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

function tlsUp(opts: ConnectionOptions, extra: MailTls): Promise<TLSSocket | null> {
  return new Promise((resolve) => {
    const s = tlsConnect({ ...opts, ...(extra.ca ? { ca: extra.ca } : {}), rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    s.once('secureConnect', () => resolve(s));
    s.once('error', () => {
      s.destroy();
      resolve(null);
    });
  });
}

/** TCP + TLS (implicit or STARTTLS) + server greeting; true when a verified TLS mail server answers. */
export async function probeServer(kind: 'imap' | 'smtp', server: MailServerSettings, timeoutMs: number, extra: MailTls = {}): Promise<boolean> {
  const sockets: Array<Socket | TLSSocket> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), timeoutMs)));
  const attempt = async (): Promise<boolean> => {
    if (server.security === 'tls') {
      const s = await tlsUp({ host: server.host, port: server.port, servername: server.host }, extra);
      if (!s) return false;
      sockets.push(s);
      return converse(s, greetingOk(kind));
    }
    const plain = netConnect({ host: server.host, port: server.port });
    sockets.push(plain);
    const connected = await new Promise<boolean>((r) => {
      plain.once('connect', () => r(true));
      plain.once('error', () => r(false));
    });
    if (!connected || !(await converse(plain, greetingOk(kind)))) return false;
    if (kind === 'imap') {
      plain.write('a1 STARTTLS\r\n');
      if (!(await converse(plain, (l) => (/^a1 OK/i.test(l) ? 'ok' : /^a1 /i.test(l) ? 'fail' : 'more')))) return false;
    } else {
      plain.write('EHLO calab.local\r\n');
      if (!(await converse(plain, (l) => (/^250 /.test(l) ? 'ok' : /^250-/.test(l) ? 'more' : 'fail')))) return false;
      plain.write('STARTTLS\r\n');
      if (!(await converse(plain, (l) => (/^220[ ]/.test(l) ? 'ok' : 'fail')))) return false;
    }
    const s = await tlsUp({ socket: plain, servername: server.host }, extra);
    if (!s) return false;
    sockets.push(s);
    return true;
  };
  try {
    return await Promise.race([attempt().catch(() => false), timeout]);
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
