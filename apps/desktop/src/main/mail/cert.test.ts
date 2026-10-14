import { describe, expect, it } from 'vitest';
import { MailApiError } from '../../shared/mail';
import { certInfo, certReason, classify, MailCertError } from './errors';
import { judgeCert, mailTlsOptions, tlsGuardInstalled } from './net';

const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase().padStart(2, '0')).join(':');
const PEER = {
  subject: { CN: 'mail.example.org', O: 'Example' },
  issuer: { O: 'Example', CN: 'Example CA' },
  valid_from: 'Oct 12 08:18:00 2026 GMT',
  valid_to: 'Jan 10 08:18:00 2027 GMT',
  fingerprint256: FP,
};

function sock(authorized: boolean, authorizationError?: string | Error) {
  return { authorized, authorizationError: authorizationError as Error, getPeerCertificate: () => PEER as never };
}

describe('certificate errors (ADR-0088 §4)', () => {
  it('maps Node / OpenSSL codes to reasons', () => {
    expect(certReason('DEPTH_ZERO_SELF_SIGNED_CERT')).toBe('self_signed');
    expect(certReason('SELF_SIGNED_CERT_IN_CHAIN')).toBe('self_signed');
    expect(certReason('UNABLE_TO_VERIFY_LEAF_SIGNATURE')).toBe('untrusted');
    expect(certReason('UNABLE_TO_GET_ISSUER_CERT')).toBe('untrusted');
    expect(certReason('UNABLE_TO_GET_ISSUER_CERT_LOCALLY')).toBe('untrusted');
    expect(certReason('CERT_HAS_EXPIRED')).toBe('expired');
    expect(certReason('CERT_NOT_YET_VALID')).toBe('not_yet_valid');
    expect(certReason('ERR_TLS_CERT_ALTNAME_INVALID')).toBe('name_mismatch');
    expect(certReason('CERT_REVOKED')).toBe('other');
    expect(certReason(undefined)).toBe('other');
  });

  it('reads the peer certificate: DN with CN first, dates as epoch ms', () => {
    expect(certInfo(PEER, 'mail.example.org', 993, 'not_yet_valid')).toEqual({
      host: 'mail.example.org',
      port: 993,
      fingerprint256: FP,
      subject: 'CN=mail.example.org, O=Example',
      issuer: 'CN=Example CA, O=Example',
      notBefore: Date.UTC(2026, 9, 12, 8, 18),
      notAfter: Date.UTC(2027, 0, 10, 8, 18),
      reason: 'not_yet_valid',
    });
    expect(certInfo(null, 'h', 1, 'other')).toMatchObject({ fingerprint256: '', subject: '', notBefore: 0 });
  });

  it('classify keeps the certificate whatever code a library put on the error', () => {
    const cert = certInfo(PEER, 'h', 465, 'self_signed');
    const e = Object.assign(new MailCertError(cert), { code: 'ESOCKET' }); // nodemailer's _formatError
    expect(classify(e)).toMatchObject({ code: 'TLS', cert });
    expect(classify(Object.assign(new Error('upgrade failed'), { tlsFailed: true, cause: new MailCertError(cert) }))).toMatchObject({ code: 'TLS', cert });
    expect(classify(new MailApiError({ code: 'TLS', message: 'x', cert }))).toEqual({ code: 'TLS', message: 'x', cert });
    expect(new MailApiError({ code: 'TLS', message: 'x', cert }).toJSON()).toEqual({ code: 'TLS', message: 'x', cert });
    expect(classify(Object.assign(new Error('self signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }))).toEqual({ code: 'TLS', message: 'self signed' });
  });
});

describe('the pin check (judgeCert)', () => {
  const check = { host: 'mail.example.org', port: 993, pin: undefined };
  it('a valid certificate passes, pinned or not (a renewed trusted certificate is no «changed»)', () => {
    expect(judgeCert(sock(true), check)).toBeNull();
    expect(judgeCert(sock(true), { ...check, pin: 'AA' })).toBeNull();
  });
  it('unpinned: the reason from authorizationError', () => {
    expect(judgeCert(sock(false, 'DEPTH_ZERO_SELF_SIGNED_CERT'), check)).toMatchObject({ reason: 'self_signed', fingerprint256: FP, host: 'mail.example.org', port: 993 });
    expect(judgeCert(sock(false, Object.assign(new Error('Hostname/IP does not match'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })), check)).toMatchObject({ reason: 'name_mismatch' });
    expect(judgeCert(sock(false, 'CERT_NOT_YET_VALID'), check)).toMatchObject({ reason: 'not_yet_valid' });
  });
  it('pinned: exactly that fingerprint passes, another one is changed', () => {
    expect(judgeCert(sock(false, 'CERT_HAS_EXPIRED'), { ...check, pin: FP })).toBeNull();
    expect(judgeCert(sock(false, 'CERT_HAS_EXPIRED'), { ...check, pin: FP.replace(/^10/, '11') })).toMatchObject({ reason: 'changed', fingerprint256: FP });
  });
  it('connection options stay strict; only the guarded tls.connect relaxes them for its own check', () => {
    const o = mailTlsOptions({ host: 'h', port: 993, security: 'tls', pinnedCert: FP.toLowerCase() }) as Record<string, unknown>;
    expect(o['rejectUnauthorized']).toBe(true);
    expect(o['calabMailCertCheck']).toEqual({ host: 'h', port: 993, pin: FP });
    expect(tlsGuardInstalled()).toBe(true);
  });
});
