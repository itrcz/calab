import type { MailAddress, MailErrorCode, MailFolder, MailFolderRole, MailProvider } from '../../../shared/mail';
import { t, type MessageKey } from '../../i18n';
import { dateTimeFormat, fmt } from '../../lib/format';

/** List time (Apple Mail): today — the time, this year — «12 окт.», older — «12.10.2025». */
export function mailListTime(ms: number, now = new Date()): string {
  const d = new Date(ms);
  if (d.toDateString() === now.toDateString()) return fmt.time(d);
  if (d.getFullYear() === now.getFullYear()) return dateTimeFormat({ day: 'numeric', month: 'short' }).format(d);
  return dateTimeFormat({ day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

/** The message header's date: «12 октября 2026 г., 14:05» (the year only when not this one). */
export const mailHeaderTime = (ms: number, now = new Date()): string => fmt.dateTime(new Date(ms), 'long', now);

/** A sender as shown: the name, else the address. */
export const addressLabel = (a: MailAddress): string => a.name.trim() || a.address;

/** «Анна Петрова <anna@x.ru>» — the full form («Подробнее», quotes). */
export const addressFull = (a: MailAddress): string => (a.name.trim() ? `${a.name.trim()} <${a.address}>` : a.address);

/** Two initials for the avatar: from the name, else the address' local part. */
export function mailInitials(a: MailAddress): string {
  const name = a.name.trim();
  if (name) {
    const words = name.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    const first = (w: string | undefined): string => Array.from(w ?? '').find((c) => /[\p{L}\p{N}]/u.test(c)) ?? '';
    if (words.length >= 2) return (first(words[0]) + first(words[1])).toUpperCase();
    if (words[0]) return first(words[0]).toUpperCase();
  }
  return (Array.from(a.address).find((c) => /[\p{L}\p{N}]/u.test(c)) ?? '?').toUpperCase();
}

/** A stable avatar colour token (--avatar-1…8) for an address. */
export function avatarTone(address: string): string {
  let h = 0;
  for (const c of address.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `var(--avatar-${(Math.abs(h) % 8) + 1})`;
}

const ROLE_KEY: Record<MailFolderRole, MessageKey> = {
  inbox: 'mbox.folder.inbox',
  starred: 'mbox.folder.starred',
  sent: 'mbox.folder.sent',
  drafts: 'mbox.folder.drafts',
  outbox: 'mbox.folder.outbox',
  archive: 'mbox.folder.archive',
  junk: 'mbox.folder.junk',
  trash: 'mbox.folder.trash',
};

/** Role folders by their localized name (§5), ordinary folders by their own. */
export const folderLabel = (f: Pick<MailFolder, 'role' | 'name'>): string => (f.role ? t(ROLE_KEY[f.role]) : f.name);
export const roleLabel = (role: MailFolderRole): string => t(ROLE_KEY[role]);

/** The «Все …» label of a role across accounts. */
export const allLabel = (role: MailFolderRole): string => (role === 'inbox' ? t('mbox.allInboxes') : t('mbox.allOf', { folder: t(ROLE_KEY[role]) }));

/** Order of role folders in the switcher (§8): Входящие, Отмеченные, Отправленные, Черновики, Исходящие, Архив, Спам, Корзина. */
export const ROLE_ORDER: MailFolderRole[] = ['inbox', 'starred', 'sent', 'drafts', 'outbox', 'archive', 'junk', 'trash'];

const ERROR_KEY: Record<MailErrorCode, MessageKey> = {
  NOT_IMPLEMENTED: 'mbox.err.notImplemented',
  AUTH_FAILED: 'mbox.err.auth',
  DISCOVERY_FAILED: 'mbox.err.discovery',
  UNSUPPORTED_PROVIDER: 'mbox.err.unsupported',
  NETWORK: 'mbox.err.network',
  TLS: 'mbox.err.tls',
  NOT_FOUND: 'mbox.err.notFound',
  RATE_LIMITED: 'mbox.err.rateLimited',
  ENGINE_DOWN: 'mbox.err.engineDown',
  INVALID: 'mbox.err.invalid',
};

/** The UI's text for a contract error code (the engine's English `message` goes to details only). */
export const mailErrorText = (code: MailErrorCode): string => t(ERROR_KEY[code]);

/** App-password help pages (§4): the provider's own instructions. */
export const APP_PASSWORD_URL: Partial<Record<MailProvider, string>> = {
  gmail: 'https://support.google.com/accounts/answer/185833',
  yandex: 'https://yandex.ru/support/id/authorization/app-passwords.html',
  mailru: 'https://help.mail.ru/mail/security/protection/external',
  icloud: 'https://support.apple.com/102654',
};

/** The provider of an address by its domain (known table only; the engine knows MX too). */
export function providerOf(email: string): MailProvider {
  const d = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if (/^(gmail|googlemail)\.com$/.test(d)) return 'gmail';
  if (/^(yandex\.[a-z]+|ya\.ru)$/.test(d)) return 'yandex';
  if (/^(mail|bk|list|inbox|internet)\.ru$/.test(d)) return 'mailru';
  if (/^(icloud|me|mac)\.com$/.test(d)) return 'icloud';
  if (/^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(d)) return 'microsoft';
  return 'other';
}
