import type { MailAccount, MailAddress, MailAttachment, MailFolder, MailFolderRole } from '../src/shared/mail';
import type { Copy3 } from './copy3';

/**
 * The landing mailbox (landing-mail.spec.ts): a drop-in for the renderer mock's fixtures
 * (src/renderer/features/mail/mock/fixtures.ts — same exports), bundled in its place with esbuild and
 * run in Electron's main process. The letters come from `globalThis.__calabMailData` (copy3.ts `mail`
 * of the page language + the scene's clock), set right before the bundle is evaluated.
 */
interface Data {
  mail: Copy3['mail'];
  /** The scene's «now», ms. */
  now: number;
}

const data = (): Data => (globalThis as unknown as { __calabMailData: Data }).__calabMailData;

export const MOCK_NOW = data().now;
export const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==';

export interface MockMessage {
  id: string;
  threadId: string;
  accountId: string;
  folderId: string;
  messageIdHeader: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  subject: string;
  date: number;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  html: string | null;
  text: string | null;
  attachments: MailAttachment[];
  inReplyTo: string;
  references: string[];
  remoteImages: boolean;
}

export const ROLES: MailFolderRole[] = ['inbox', 'starred', 'sent', 'drafts', 'outbox', 'archive', 'junk', 'trash'];
const PATHS: Record<MailFolderRole, string> = { inbox: 'INBOX', starred: '', sent: 'Sent', drafts: 'Drafts', outbox: '', archive: 'Archive', junk: 'Junk', trash: 'Trash' };

export const folderId = (accountId: string, role: string): string => `${accountId}/${role}`;

const WORK = 'acc-work';
const HOME = 'acc-personal';

export function mockAccounts(): MailAccount[] {
  const { mail, now } = data();
  const acc = (id: string, email: string, provider: MailAccount['provider']): MailAccount => ({
    id,
    email,
    name: mail.work.name,
    provider,
    imap: { host: `imap.${email.split('@')[1] ?? ''}`, port: 993, security: 'tls' },
    smtp: { host: `smtp.${email.split('@')[1] ?? ''}`, port: 465, security: 'tls' },
    login: email,
    state: 'idle',
    error: null,
    lastSyncAt: now - 60_000,
  });
  return [acc(WORK, mail.work.email, 'other'), acc(HOME, mail.personal.email, 'gmail')];
}

export function mockFolders(): MailFolder[] {
  const list: MailFolder[] = [];
  const add = (accountId: string, extra: string[]): void => {
    for (const role of ROLES) list.push({ id: folderId(accountId, role), accountId, path: PATHS[role], name: PATHS[role] || role, role, parentId: null, unread: 0, total: 0 });
    for (const name of extra) list.push({ id: folderId(accountId, name), accountId, path: name, name, role: null, parentId: null, unread: 0, total: 0 });
  };
  add(WORK, data().mail.folders);
  add(HOME, []);
  return list;
}

const MIME: Record<string, string> = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', png: 'image/png' };

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function mockMessages(): MockMessage[] {
  const { mail, now } = data();
  return mail.letters.map((l, i) => {
    const id = `m${String(i + 1).padStart(3, '0')}`;
    const accountId = l.personal ? HOME : WORK;
    const me: MailAddress = { name: mail.work.name, address: l.personal ? mail.personal.email : mail.work.email };
    return {
      id,
      threadId: `t-${id}`,
      accountId,
      folderId: folderId(accountId, 'inbox'),
      messageIdHeader: `<${id}@calab.example>`,
      from: { name: l.from[0], address: l.from[1] },
      to: [me],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: l.subject,
      date: now - l.ago * 60_000,
      seen: !l.unread,
      flagged: !!l.flagged,
      answered: false,
      html: `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;line-height:1.5">${l.text
        .split('\n')
        .map((p) => (p ? `<p style="margin:0 0 4px">${esc(p)}</p>` : '<br>'))
        .join('')}</div>`,
      text: l.text,
      attachments: (l.files ?? []).map((name, k) => ({ id: `${id}-a${k + 1}`, name, mime: MIME[name.split('.').pop() ?? ''] ?? 'application/octet-stream', size: [482_113, 91_230, 1_204_331][k] ?? 50_000, inline: false })),
      inReplyTo: '',
      references: [],
      remoteImages: false,
    };
  });
}
