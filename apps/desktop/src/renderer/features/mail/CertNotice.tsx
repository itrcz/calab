import { ShieldAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { MailAccount, MailCertInfo, MailDiscovery, MailServerSettings } from '../../../shared/mail';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import { dateTimeFormat } from '../../lib/format';

/** «12 окт. 08:18 UTC» (the year too when it is not this year's): certificate dates and the clock. */
export function fmtUtc(ms: number, now: number): string {
  const sameYear = new Date(ms).getUTCFullYear() === new Date(now).getUTCFullYear();
  const day = dateTimeFormat({ day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
  const time = dateTimeFormat({ hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `${day.format(ms)} ${time.format(ms)} UTC`;
}

/** `2E:28:6B:96 … 54:A3:9E:8F`: enough to compare with what the server's admin reads out. */
export const shortFingerprint = (fp: string): string => {
  const b = fp.split(':');
  return b.length > 8 ? `${b.slice(0, 4).join(':')} … ${b.slice(-4).join(':')}` : fp;
};

/** `ab12`: the pinned certificate in an account row. */
export const pinTail = (fp: string): string => fp.replace(/:/g, '').slice(-4).toLowerCase();

const serverOf = (c: MailCertInfo): string => `${c.host}:${String(c.port)}`;

/** The certificate's dates do not cover this computer's clock (whatever the verification said). */
const outOfDates = (c: MailCertInfo, now: number): boolean => c.notBefore > 0 && c.notAfter > 0 && (now < c.notBefore || now > c.notAfter);

/** The notice's headline: why the certificate is not trusted, in words (§4). */
export function certTitle(c: MailCertInfo, now: number): string {
  switch (c.reason) {
    case 'self_signed':
      return t('mbox.cert.selfSigned');
    case 'untrusted':
      return t('mbox.cert.untrusted');
    case 'expired':
      return t('mbox.cert.expired', { date: fmtUtc(c.notAfter, now), now: fmtUtc(now, now) });
    case 'not_yet_valid':
      return t('mbox.cert.notYetValid', { date: fmtUtc(c.notBefore, now), now: fmtUtc(now, now) });
    case 'name_mismatch':
      return t('mbox.cert.nameMismatch', { subject: c.subject || '—' });
    case 'changed':
      return t('mbox.cert.changed');
    default:
      return t('mbox.cert.other');
  }
}

/** Detail lines under the headline; the clock hint for date problems (expired / not yet valid). */
export function certDetails(c: MailCertInfo, now: number): { lines: string[]; clock: boolean } {
  const clock = c.reason === 'expired' || c.reason === 'not_yet_valid' || outOfDates(c, now);
  const lines = [t('mbox.cert.server', { server: serverOf(c) })];
  if (c.notBefore > 0 && c.notAfter > 0) lines.push(t('mbox.cert.valid', { from: fmtUtc(c.notBefore, now), to: fmtUtc(c.notAfter, now) }));
  if (clock && c.reason !== 'expired' && c.reason !== 'not_yet_valid') lines.push(t('mbox.cert.now', { now: fmtUtc(now, now) }));
  if (c.issuer) lines.push(t('mbox.cert.issuer', { issuer: c.issuer }));
  if (c.fingerprint256) lines.push(t('mbox.cert.fingerprint', { fp: shortFingerprint(c.fingerprint256) }));
  return { lines, clock };
}

/**
 * The trust prompt (ADR-0088 §4): a server certificate that did not verify — the server, the reason
 * in words, dates with this computer's UTC clock when they are the problem, the issuer, the
 * fingerprint, and «Доверять этому серверу и подключиться» (pins exactly this certificate).
 */
export function CertNotice({ cert, now: at, busy, onTrust }: { cert: MailCertInfo; now?: number; busy?: boolean; onTrust: () => void }): ReactNode {
  // This computer's clock when the prompt appeared (a snapshot: no ticking timer, docs/14).
  const [shown] = useState(() => Date.now());
  const now = at ?? shown;
  const { lines, clock } = certDetails(cert, now);
  return (
    <div role="alert" className="flex flex-col gap-1 rounded-[var(--radius-card)] bg-warn-surface px-3 py-2.5 text-caption text-fg" data-testid="mail-cert-notice" data-reason={cert.reason}>
      <p className="flex items-start gap-1.5 font-semibold">
        <ShieldAlert className="mt-px size-4 shrink-0 text-warn" aria-hidden />
        <span>{certTitle(cert, now)}</span>
      </p>
      {lines.map((l) => (
        <p key={l} className="selectable break-words text-muted">
          {l}
        </p>
      ))}
      {clock ? <p>{t('mbox.cert.clockHint')}</p> : null}
      <div className="pt-1.5">
        <Button size="sm" busy={busy} onClick={onTrust} data-testid="mail-cert-trust">
          {t('mbox.cert.trust')}
        </Button>
      </div>
    </div>
  );
}

const sameServer = (s: MailServerSettings, c: MailCertInfo): boolean => s.host.toLowerCase() === c.host.toLowerCase() && s.port === c.port;

/** Certificates to ask about after a failed `accounts.add` / a discovery: the error's own first, one per server. */
export function certIssues(...items: Array<MailCertInfo | null | undefined>): MailCertInfo[] {
  const out: MailCertInfo[] = [];
  for (const c of items) if (c && !out.some((x) => x.host === c.host && x.port === c.port)) out.push(c);
  return out;
}

/** The discovery's probe findings (`certIssue`) as prompt items. */
export const discoveryIssues = (d: MailDiscovery | null | undefined): Array<MailCertInfo | undefined> => [d?.imap.certIssue, d?.smtp.certIssue];

/** Settings with `cert` pinned on the server it belongs to (IMAP and SMTP are pinned separately). */
export function withPin<T extends { imap: MailServerSettings; smtp: MailServerSettings }>(s: T, cert: MailCertInfo): T {
  const pin = (x: MailServerSettings): MailServerSettings => (sameServer(x, cert) ? { ...x, pinnedCert: cert.fingerprint256 } : x);
  return { ...s, imap: pin(s.imap), smtp: pin(s.smtp) };
}

/** Settings without a pin. */
export function unpin(s: MailServerSettings): MailServerSettings {
  return { host: s.host, port: s.port, security: s.security };
}

/** An existing account's certificate problems: IMAP from the sync error, SMTP from the last send. */
export function accountCertIssues(a: MailAccount): Array<{ kind: 'imap' | 'smtp'; cert: MailCertInfo }> {
  const out: Array<{ kind: 'imap' | 'smtp'; cert: MailCertInfo }> = [];
  const imap = a.state === 'error' ? a.error?.cert : undefined;
  if (imap && sameServer(a.imap, imap)) out.push({ kind: 'imap', cert: imap });
  if (a.smtpCertIssue && sameServer(a.smtp, a.smtpCertIssue)) out.push({ kind: 'smtp', cert: a.smtpCertIssue });
  return out;
}
