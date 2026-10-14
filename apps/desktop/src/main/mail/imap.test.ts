import { describe, expect, it } from 'vitest';
import { imapOptions, SYNC_SOCKET_TIMEOUT_MS } from './imap';

describe('sync connection options (3.1.2 audit)', () => {
  it('keeps the long socket timeout and the 15 s connect steps; no verify deadlines leak in', () => {
    const o = imapOptions({ server: { host: 'imap.example.org', port: 993, security: 'tls' }, login: 'me@example.org', password: 'x' });
    expect(o.socketTimeout).toBe(SYNC_SOCKET_TIMEOUT_MS);
    expect(SYNC_SOCKET_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(o.connectionTimeout).toBe(15_000);
    expect(o.greetingTimeout).toBe(15_000);
    expect(o.verifyOnly).toBeUndefined();
  });
});
