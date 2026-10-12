import { MailApiError, type MailCertInfo, type MailCertReason, type MailDiscovery, type MailError, type MailErrorCode } from '../../shared/mail';

export function mailError(code: MailErrorCode, message: string, discovery?: MailDiscovery, cert?: MailCertInfo): MailApiError {
  return new MailApiError({ code, message, ...(discovery ? { discovery } : {}), ...(cert ? { cert } : {}) });
}

/**
 * A server certificate that did not verify (net.ts): thrown into imapflow / nodemailer through the
 * socket, so it may come back with their `code` (nodemailer sets `ESOCKET`); `mailCert` survives.
 */
export class MailCertError extends Error {
  readonly mailCert: MailCertInfo;
  constructor(cert: MailCertInfo) {
    super(`server certificate of ${cert.host}:${String(cert.port)} not trusted (${cert.reason})`);
    this.name = 'MailCertError';
    this.mailCert = cert;
  }
}

/** Node / OpenSSL verification codes (`authorizationError`, error `code`) → the reason the UI words. */
export function certReason(code: string | undefined | null): MailCertReason {
  switch (code ?? '') {
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'self_signed';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'CERT_UNTRUSTED':
    case 'CERT_CHAIN_TOO_LONG':
    case 'INVALID_CA':
    case 'CERT_SIGNATURE_FAILURE':
    case 'CERT_REJECTED':
      return 'untrusted';
    case 'CERT_HAS_EXPIRED':
      return 'expired';
    case 'CERT_NOT_YET_VALID':
      return 'not_yet_valid';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'HOSTNAME_MISMATCH':
      return 'name_mismatch';
    default:
      return 'other';
  }
}

/** The parts of `TLSSocket.getPeerCertificate()` we read. */
export interface PeerCert {
  subject?: Record<string, unknown> | null;
  issuer?: Record<string, unknown> | null;
  valid_from?: string;
  valid_to?: string;
  fingerprint256?: string;
}

function dn(v: Record<string, unknown> | null | undefined): string {
  if (!v) return '';
  const order = ['CN', 'O', 'OU', 'L', 'ST', 'C'];
  const keys = Object.keys(v).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return keys
    .map((k) => {
      const x = v[k];
      return `${k}=${Array.isArray(x) ? x.join('+') : String(x)}`;
    })
    .join(', ')
    .slice(0, 300);
}

const dateOf = (s: string | undefined): number => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : 0;
};

export function certInfo(cert: PeerCert | null | undefined, host: string, port: number, reason: MailCertReason): MailCertInfo {
  return {
    host,
    port,
    fingerprint256: typeof cert?.fingerprint256 === 'string' ? cert.fingerprint256.toUpperCase() : '',
    subject: dn(cert?.subject),
    issuer: dn(cert?.issuer),
    notBefore: dateOf(cert?.valid_from),
    notAfter: dateOf(cert?.valid_to),
    reason,
  };
}

export const notFound = (what: string): MailApiError => mailError('NOT_FOUND', `${what} not found`);
export const invalid = (message: string): MailApiError => mailError('INVALID', message);

const TLS_CODES = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|ERR_OSSL)/;
const NET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ESOCKET',
  'ECONNECTION',
  'EDNS',
  'NoConnection',
  'EConnectionClosed',
  'ClosedAfterConnectText',
  'ClosedAfterConnectTLS',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'ETIMEOUT',
]);

interface ErrLike {
  code?: unknown;
  authenticationFailed?: unknown;
  tlsFailed?: unknown;
  responseCode?: unknown;
  message?: unknown;
  reason?: unknown;
  cause?: unknown;
  mailCert?: unknown;
}

function certOf(err: ErrLike): MailCertInfo | undefined {
  for (let e: ErrLike | undefined = err, i = 0; e && i < 4; e = e.cause as ErrLike | undefined, i++) {
    const c = e.mailCert;
    if (typeof c === 'object' && c !== null && typeof (c as MailCertInfo).reason === 'string') return c as MailCertInfo;
  }
  return undefined;
}

/**
 * Maps an IMAP (imapflow) / SMTP (nodemailer) / socket error to a mail error code. Messages never
 * carry secrets (libraries do not echo the password; we never add it).
 */
export function classify(e: unknown): MailError {
  if (e instanceof MailApiError) return { code: e.code, message: e.message, ...(e.cert ? { cert: e.cert } : {}), ...(e.report ? { report: e.report } : {}) };
  const err = (typeof e === 'object' && e !== null ? e : {}) as ErrLike;
  const message = typeof err.message === 'string' ? err.message.slice(0, 300) : String(e);
  // Our certificate check (net.ts), whatever code the library put on top of it.
  const cert = certOf(err);
  if (cert) return { code: 'TLS', message, cert };
  const code = typeof err.code === 'string' ? err.code : '';
  const cause = err.cause as ErrLike | undefined;
  const causeCode = typeof cause?.code === 'string' ? cause.code : '';
  if (err.authenticationFailed === true || code === 'EAUTH' || code === 'AUTHENTICATIONFAILED') return { code: 'AUTH_FAILED', message };
  if (err.tlsFailed === true || TLS_CODES.test(code) || TLS_CODES.test(causeCode) || code === 'ETLS') return { code: 'TLS', message };
  if (typeof err.responseCode === 'number' && (err.responseCode === 421 || err.responseCode === 450 || err.responseCode === 451 || err.responseCode === 452)) {
    return { code: 'RATE_LIMITED', message };
  }
  if (code === 'ETHROTTLE' || /THROTTL|too many (simultaneous )?connections/i.test(message)) return { code: 'RATE_LIMITED', message };
  if (NET_CODES.has(code) || NET_CODES.has(causeCode)) return { code: 'NETWORK', message };
  return { code: 'INVALID', message };
}

/**
 * A hard deadline over a network step whose library timeouts may not cover everything (DNS inside
 * imapflow / nodemailer, a server that stalls mid-login): rejects with a NETWORK-classified
 * `ETIMEDOUT` after `ms` and calls `onTimeout` (close the client) — ADR-0088 §7.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // closing anyway
      }
      reject(Object.assign(new Error(`${what}: no answer in ${Math.round(ms / 1000)} s`), { code: 'ETIMEDOUT' }));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function toMailError(e: unknown): MailApiError {
  const c = classify(e);
  return mailError(c.code, c.message, undefined, c.cert);
}
