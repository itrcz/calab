/**
 * Opaque ids of the mail engine (shared/mail.ts: unique across accounts, a message id carries its
 * account so `messages.get(id)` needs no accountId). Node-free: main validates attachment URLs
 * with the same patterns.
 *
 * - account:    `a` + 16 hex                         a0123456789abcdef
 * - folder:     `<account>.<folderRow>` or `<account>.<virtual>` (starred / drafts / outbox)
 * - message:    `<account>.<folderRow>.<uidvalidity>.<uid>` — a new id after a move / UIDVALIDITY change
 * - thread:     `<account>.t<n>`
 * - draft:      `<account>.d<n>`, outgoing: `<account>.o<n>`
 * - attachment: the index of the attachment in the parsed message, `0`..`9999`
 */

export const ACCOUNT_ID_RE = /^a[0-9a-f]{16}$/;
export const MESSAGE_ID_RE = /^a[0-9a-f]{16}\.[0-9]{1,9}\.[0-9]{1,20}\.[0-9]{1,10}$/;
export const ATTACHMENT_ID_RE = /^[0-9]{1,4}$/;

export type VirtualFolder = 'starred' | 'drafts' | 'outbox';
const VIRTUAL: ReadonlySet<string> = new Set(['starred', 'drafts', 'outbox']);

export function newAccountId(randomHex: (bytes: number) => string): string {
  return `a${randomHex(8)}`;
}

export function folderId(accountId: string, row: number | VirtualFolder): string {
  return `${accountId}.${String(row)}`;
}

export function messageId(accountId: string, folderRow: number, uidValidity: number | bigint, uid: number): string {
  return `${accountId}.${String(folderRow)}.${String(uidValidity)}.${String(uid)}`;
}

/** The account an id belongs to (any kind), or null when it is not one of ours. */
export function accountOf(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const acc = id.slice(0, 17);
  return ACCOUNT_ID_RE.test(acc) && (id.length === 17 || id[17] === '.') ? acc : null;
}

export type ParsedFolderId = { accountId: string; row: number; virtual: null } | { accountId: string; row: null; virtual: VirtualFolder };

export function parseFolderId(id: unknown): ParsedFolderId | null {
  const acc = accountOf(id);
  if (!acc || typeof id !== 'string') return null;
  const rest = id.slice(18);
  if (VIRTUAL.has(rest)) return { accountId: acc, row: null, virtual: rest as VirtualFolder };
  if (!/^[0-9]{1,9}$/.test(rest)) return null;
  return { accountId: acc, row: Number(rest), virtual: null };
}

export interface ParsedMessageId {
  accountId: string;
  folderRow: number;
  uidValidity: string;
  uid: number;
}

export function parseMessageId(id: unknown): ParsedMessageId | null {
  if (typeof id !== 'string' || !MESSAGE_ID_RE.test(id)) return null;
  const [accountId, folderRow, uidValidity, uid] = id.split('.') as [string, string, string, string];
  return { accountId, folderRow: Number(folderRow), uidValidity, uid: Number(uid) };
}

/** `<account>.<prefix><n>` (threads `t`, drafts `d`, outgoing `o`). */
export function parseSeqId(id: unknown, prefix: 't' | 'd' | 'o'): { accountId: string; n: number } | null {
  const acc = accountOf(id);
  if (!acc || typeof id !== 'string') return null;
  const m = /^([tdo])([0-9]{1,12})$/.exec(id.slice(18));
  if (m?.[1] !== prefix || m[2] === undefined) return null;
  return { accountId: acc, n: Number(m[2]) };
}
