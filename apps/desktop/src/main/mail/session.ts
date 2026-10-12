/**
 * The IMAP operations the sync needs (§5), as a narrow interface: imap.ts implements it over
 * imapflow, the unit tests over an in-memory fake. All calls run on one connection, serialized by
 * the caller (AccountSync); `select` changes the selected mailbox, and `rest` puts the connection
 * back on the inbox, where it IDLEs.
 */
import type { MailAddress, MailFlags } from '../../shared/mail';

export interface RemoteFolder {
  path: string;
  name: string;
  delimiter: string;
  parentPath: string;
  /** `\Sent`, `\Trash`, … (SPECIAL-USE, or imapflow's name guess), null when none. */
  specialUse: string | null;
  /** LIST flags (`\Noselect`, `\HasChildren`, …). */
  flags: string[];
}

export interface SelectInfo {
  uidValidity: string;
  uidNext: number;
  exists: number;
  /** null without CONDSTORE. */
  highestModseq: string | null;
}

export interface RemoteHeader {
  uid: number;
  flags: MailFlags;
  messageIdHdr: string;
  inReplyTo: string;
  references: string[];
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  subject: string;
  snippet: string;
  date: number;
  size: number;
  hasAttachments: boolean;
}

export interface RemoteFlags {
  uid: number;
  flags: MailFlags;
}

export interface ImapSession {
  /** CONDSTORE is enabled (flag changes via CHANGEDSINCE). */
  readonly condstore: boolean;
  list(): Promise<RemoteFolder[]>;
  select(path: string): Promise<SelectInfo>;
  /** UIDs of messages with an internal date ≥ since and / or < before (day granularity, IMAP SEARCH). */
  searchDate(since?: Date, before?: Date): Promise<number[]>;
  /** UIDs that exist in a UID range (`min:max`). */
  searchUids(range: string): Promise<number[]>;
  fetchHeaders(uids: number[] | string): Promise<RemoteHeader[]>;
  /** Flags of a UID range; with `changedSince` only those changed after that modseq. */
  fetchFlags(range: string, changedSince?: string): Promise<RemoteFlags[]>;
  fetchSource(uid: number): Promise<Buffer | null>;
  storeFlags(uids: number[], add: string[], remove: string[]): Promise<void>;
  /** MOVE (or COPY + EXPUNGE); the UID map when the server reports one. */
  move(uids: number[], destination: string): Promise<Map<number, number> | null>;
  /** \Deleted + (UID) EXPUNGE. */
  expunge(uids: number[]): Promise<void>;
  /** Every message of the selected mailbox: `UID STORE 1:* +FLAGS (\Deleted)` + EXPUNGE. */
  expungeAll(): Promise<void>;
  append(path: string, raw: Buffer, flags: string[]): Promise<void>;
  createFolder(path: string): Promise<void>;
  /** Back to the inbox: imapflow IDLEs on the selected mailbox when idle. */
  rest(inboxPath: string): Promise<void>;
  /** The selected mailbox changed on the server (new mail, flags, expunge). */
  onChange(cb: (path: string) => void): void;
  onClose(cb: () => void): void;
  /** The last error the connection reported (for the log when it closes while idle), if any. */
  readonly lastError?: unknown;
  close(): Promise<void>;
}

export const flagsFrom = (set: Set<string> | string[] | undefined): MailFlags => {
  const s = set instanceof Set ? set : new Set(set ?? []);
  return { seen: s.has('\\Seen'), flagged: s.has('\\Flagged'), answered: s.has('\\Answered') };
};
