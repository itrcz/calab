import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { caresLookup, fetchText, probeServer } from './net';

/** A TCP server that accepts and never says anything (a filtering middlebox / a dead service). */
function silentServer(): Promise<{ server: Server; port: number; open: () => number }> {
  const sockets = new Set<Socket>();
  const server = createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, open: () => sockets.size });
    });
  });
}

/** The local test certificate (infra/docker/greenmail/gen-cert.sh); the test is skipped without it. */
const CERTS = resolve(__dirname, '../../../../../infra/docker/greenmail/certs');

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const waitFor = async (fn: () => boolean, ms = 2000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
};

describe('discovery network deadlines (ADR-0088 §4, §7)', () => {
  it('a probe to a server that never greets (implicit TLS, STARTTLS): fails in time, sockets closed', async () => {
    const { server, port, open } = await silentServer();
    servers.push(server);
    for (const security of ['tls', 'starttls'] as const) {
      const t0 = Date.now();
      const r = await probeServer('imap', { host: '127.0.0.1', port, security }, 300);
      expect(r).toEqual({ ok: false });
      expect(Date.now() - t0).toBeLessThan(1500);
    }
    // The hung TLS handshake's socket is destroyed too (it used to leak until the OS timeout).
    // On Linux one probe socket outlives the deadline until the OS closes it (docs/12, 2026-10-12);
    // macOS and Windows close it at once. The deadline itself is asserted above on every platform.
    if (process.platform !== 'linux') expect(await waitFor(() => open() === 0, 10_000)).toBe(true);
  }, 20_000);

  it.skipIf(!existsSync(join(CERTS, 'key.pem')))('STARTTLS completed: the probe closes TLS before TCP and the process survives', async () => {
    // 3.1.0 destroyed the TCP socket first, under the live TLS socket: SIGSEGV of the whole engine
    // (exit 11) a moment later, on discovery of any domain with a STARTTLS IMAP / SMTP host.
    const key = readFileSync(join(CERTS, 'key.pem'));
    const cert = readFileSync(join(CERTS, 'ca.pem'));
    const server = createServer((s) => {
      s.on('error', () => undefined);
      s.write('* OK IMAP ready\r\n');
      s.once('data', () => {
        s.write('a1 OK Begin TLS\r\n');
        const t = new TLSSocket(s, { isServer: true, key, cert });
        t.on('error', () => undefined);
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    for (let i = 0; i < 10; i++) {
      const r = await probeServer('imap', { host: 'localhost', port, security: 'starttls' }, 2000);
      expect(r.ok).toBe(true);
    }
    await new Promise((r) => setTimeout(r, 300));
  });

  it('fetchText: a server that never answers is aborted at the deadline', async () => {
    const hang: typeof fetch = (_u, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const t0 = Date.now();
    await expect(fetchText('https://autoconfig.example.org/x', 200, hang)).resolves.toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('fetchText: a body larger than the cap is dropped; a normal one is read', async () => {
    const big: typeof fetch = () => Promise.resolve(new Response('x'.repeat(300 * 1024), { status: 200 }));
    const okBody: typeof fetch = () => Promise.resolve(Object.defineProperty(new Response('<clientConfig/>', { status: 200 }), 'url', { value: 'https://a.example/x' }));
    const bigWithUrl: typeof fetch = async (u, i) => Object.defineProperty(await big(u, i), 'url', { value: 'https://a.example/x' });
    await expect(fetchText('https://a.example/x', 1000, bigWithUrl)).resolves.toBeNull();
    await expect(fetchText('https://a.example/x', 1000, okBody)).resolves.toBe('<clientConfig/>');
    await expect(fetchText('http://a.example/x', 1000, okBody)).resolves.toBeNull();
  });

  it('caresLookup: localhost without DNS; an unknown name fails (not hangs)', async () => {
    const one = await new Promise<[Error | null, unknown]>((r) => caresLookup('localhost', {}, (e, a) => r([e, a])));
    expect(one).toEqual([null, '127.0.0.1']);
    const t0 = Date.now();
    const bad = await new Promise<Error | null>((r) => caresLookup('no-such-host.invalid', {}, (e) => r(e)));
    expect(bad).toMatchObject({ code: 'ENOTFOUND' });
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});
