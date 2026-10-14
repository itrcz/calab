import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MailEngineAccount } from '../../shared/mail';
import { MailAccountsFile, serverSettings, type SecretBox } from './accounts';

const box: SecretBox = {
  available: () => true,
  encrypt: (s) => Buffer.from(s, 'utf8').reverse(),
  decrypt: (b) => Buffer.from(b).reverse().toString('utf8'),
};
const FP = Array.from({ length: 32 }, () => 'C3').join(':');
const ACC: MailEngineAccount = {
  id: 'a0123456789abcdef',
  email: 'ivan@example.org',
  name: '',
  provider: 'other',
  imap: { host: 'mail.example.org', port: 993, security: 'tls', pinnedCert: FP },
  smtp: { host: 'mail.example.org', port: 465, security: 'tls' },
  login: 'ivan@example.org',
  password: 'p',
};

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('mail accounts file: certificate pins (ADR-0088 §4)', () => {
  it('a pin survives the encrypted round trip, per server', () => {
    dir = mkdtempSync(join(tmpdir(), 'calab-acc-'));
    const file = join(dir, 'accounts.bin');
    new MailAccountsFile(file, box, () => undefined).put(ACC);
    const again = new MailAccountsFile(file, box, () => undefined).get(ACC.id);
    expect(again?.imap).toEqual({ host: 'mail.example.org', port: 993, security: 'tls', pinnedCert: FP });
    expect(again?.smtp.pinnedCert).toBeUndefined();
  });
  it('input settings: a pin is upper-cased, a malformed one dropped, the rest validated as before', () => {
    expect(serverSettings({ host: 'h', port: 1, security: 'tls', pinnedCert: FP.toLowerCase() })).toEqual({ host: 'h', port: 1, security: 'tls', pinnedCert: FP });
    expect(serverSettings({ host: 'h', port: 1, security: 'starttls', pinnedCert: 'nope', extra: 1 })).toEqual({ host: 'h', port: 1, security: 'starttls' });
    expect(serverSettings({ host: 'h', port: '1', security: 'tls' })).toBeNull();
  });
});
