import { MailApiError, type MailDiscovery, type MailErrorCode } from '../../shared/mail';

export function mailError(code: MailErrorCode, message: string, discovery?: MailDiscovery): MailApiError {
  return new MailApiError(discovery ? { code, message, discovery } : { code, message });
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
}

/**
 * Maps an IMAP (imapflow) / SMTP (nodemailer) / socket error to a mail error code. Messages never
 * carry secrets (libraries do not echo the password; we never add it).
 */
export function classify(e: unknown): { code: MailErrorCode; message: string } {
  if (e instanceof MailApiError) return { code: e.code, message: e.message };
  const err = (typeof e === 'object' && e !== null ? e : {}) as ErrLike;
  const message = typeof err.message === 'string' ? err.message.slice(0, 300) : String(e);
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

export function toMailError(e: unknown): MailApiError {
  const c = classify(e);
  return mailError(c.code, c.message);
}
