import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MailAccount, MailCertInfo, MailCertReason } from '../../../shared/mail';
import { accountCertIssues, CertNotice, certIssues, pinTail, shortFingerprint, unpin, withPin } from './CertNotice';

const FP = Array.from({ length: 32 }, (_, i) => (i + 0xa0).toString(16).toUpperCase()).join(':');
const NOW = Date.UTC(2026, 9, 12, 5, 36);
const cert = (reason: MailCertReason, over: Partial<MailCertInfo> = {}): MailCertInfo => ({
  host: 'mail.example.org',
  port: 993,
  fingerprint256: FP,
  subject: 'CN=other.example.net',
  issuer: "CN=R11, O=Let's Encrypt",
  notBefore: Date.UTC(2026, 9, 12, 8, 18),
  notAfter: Date.UTC(2027, 0, 10, 8, 18),
  reason,
  ...over,
});
const render = (c: MailCertInfo): string => renderToStaticMarkup(createElement(CertNotice, { cert: c, now: NOW, onTrust: () => undefined })).replace(/&#x27;/g, "'");
const text = (html: string): string => html.replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n').trim();

describe('the certificate trust prompt (ADR-0088 §4)', () => {
  it('not yet valid: the issue time and this computer’s UTC clock, the clock hint, issuer, short fingerprint, the trust button', () => {
    const t = text(render(cert('not_yet_valid')));
    expect(t).toContain('Сертификат ещё не действует: выдан 12 окт. 08:18 UTC, на этом компьютере сейчас 12 окт. 05:36 UTC — проверьте часы');
    expect(t).toContain('Сервер mail.example.org:993');
    expect(t).toContain('Действует с 12 окт. 08:18 UTC по 10 янв. 2027 г. 08:18 UTC');
    expect(t).toContain('Если дата на компьютере неверна, исправьте её в настройках системы');
    expect(t).toContain("Выдан: CN=R11, O=Let's Encrypt");
    expect(t).toContain(`Отпечаток SHA-256: A0:A1:A2:A3 … BC:BD:BE:BF`);
    expect(t).toContain('Доверять этому серверу и подключиться');
    expect(render(cert('not_yet_valid'))).toContain('data-reason="not_yet_valid"');
  });

  it('expired: the end date and the clock, with the hint', () => {
    const t = text(render(cert('expired', { notBefore: Date.UTC(2026, 0, 1), notAfter: Date.UTC(2026, 9, 1, 12, 0) })));
    expect(t).toContain('Сертификат истёк 1 окт. 12:00 UTC, на этом компьютере сейчас 12 окт. 05:36 UTC');
    expect(t).toContain('Если дата на компьютере неверна');
  });

  it('self-signed / untrusted / name mismatch / changed / other: their own headline, no clock hint while the dates are fine', () => {
    const ok = { notBefore: Date.UTC(2026, 0, 1), notAfter: Date.UTC(2027, 0, 1) };
    const cases: Array<[MailCertReason, string]> = [
      ['self_signed', 'Сертификат самоподписанный'],
      ['untrusted', 'Сертификат выдан неизвестным центром сертификации'],
      ['name_mismatch', 'Имя в сертификате не совпадает: CN=other.example.net'],
      ['changed', 'Сертификат сервера изменился'],
      ['other', 'Сертификат сервера не прошёл проверку'],
    ];
    for (const [reason, headline] of cases) {
      const t = text(render(cert(reason, ok)));
      expect(t.split('\n')[0]).toBe(headline);
      expect(t).not.toContain('Если дата на компьютере неверна');
      expect(t).toContain('Доверять этому серверу и подключиться');
    }
  });

  it('a self-signed certificate outside its dates also gets the clock line and hint', () => {
    const t = text(render(cert('self_signed')));
    expect(t).toContain('На этом компьютере сейчас 12 окт. 05:36 UTC');
    expect(t).toContain('Если дата на компьютере неверна');
  });

  it('helpers: one prompt per server, pins go to the matching server only, account issues', () => {
    const imapIssue = cert('self_signed');
    const smtpIssue = cert('self_signed', { port: 465 });
    expect(certIssues(imapIssue, undefined, cert('expired'), smtpIssue)).toEqual([imapIssue, smtpIssue]);
    const s = { imap: { host: 'mail.example.org', port: 993, security: 'tls' as const }, smtp: { host: 'mail.example.org', port: 465, security: 'tls' as const }, login: 'x' };
    expect(withPin(s, smtpIssue)).toEqual({ ...s, smtp: { ...s.smtp, pinnedCert: FP } });
    expect(unpin({ ...s.imap, pinnedCert: FP })).toEqual(s.imap);
    expect(shortFingerprint('AB:CD')).toBe('AB:CD');
    expect(pinTail(FP)).toBe('bebf');
    const acc = { ...s, id: 'a', email: 'e', name: '', provider: 'other', state: 'error', error: { code: 'TLS', message: '', cert: cert('changed') }, lastSyncAt: null, smtpCertIssue: smtpIssue } as MailAccount;
    expect(accountCertIssues(acc)).toEqual([
      { kind: 'imap', cert: cert('changed') },
      { kind: 'smtp', cert: smtpIssue },
    ]);
    expect(accountCertIssues({ ...acc, state: 'syncing', smtpCertIssue: undefined } as unknown as MailAccount)).toEqual([]);
  });
});
