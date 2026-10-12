/**
 * Mail client contract (ADR-0088 §7): the single source of truth for the renderer and the mail engine
 * (a utilityProcess, src/main/mail/engine.ts). Node-free: imported by the renderer, the preload, main
 * and the engine.
 *
 * General rules the engine must honour:
 * - Every id (`MailAccount.id`, `MailFolder.id`, message / thread / draft / outgoing / attachment ids)
 *   is an opaque string, unique across all accounts (calls like `messages.get(id)` carry no accountId).
 *   A message id is stable while the folder's UIDVALIDITY is unchanged; moving a message gives it a new
 *   id (`messages_removed` in the old folder + `messages_added` in the new one).
 * - Times are epoch milliseconds.
 * - A failed call rejects with a `MailApiError` (`code` + human-readable English `message`; the UI maps
 *   `code` to its own localized text and shows `message` only in details / logs).
 * - Every call is answered within 30 s (main's router gives up with `ENGINE_DOWN` after that). Long work
 *   (sync, sending, loading older mail) answers as soon as it is accepted and reports through events.
 * - Passwords never come back from the engine: no type below that flows engine → renderer has one.
 */

// ---------------------------------------------------------------- accounts

/** Known providers (ADR-0088 §4 step 1/2); `other` = any IMAP server. */
export type MailProvider = 'gmail' | 'yandex' | 'mailru' | 'icloud' | 'microsoft' | 'other';

/**
 * Transport security. Plain text is not supported in v1; certificates are always verified, a
 * certificate the user accepted once is pinned per server (`pinnedCert`, §4, §10).
 */
export type MailSecurity = 'tls' | 'starttls';

/** SHA-256 fingerprint as Node prints it (`fingerprint256`): 32 upper-case hex bytes joined by `:`. */
export const MAIL_CERT_FINGERPRINT_RE = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export interface MailServerSettings {
  host: string;
  port: number;
  /** `tls` = implicit TLS (993 / 465); `starttls` = upgrade after the greeting (143 / 587). */
  security: MailSecurity;
  /**
   * A certificate the user trusted for this server (trust on first use, §4): its SHA-256
   * fingerprint. Admits exactly that leaf certificate in addition to normally valid ones; another
   * untrusted certificate fails with `TLS` / `reason: 'changed'`. Absent = strict verification only.
   */
  pinnedCert?: string;
}

/**
 * Why a server certificate did not verify (Node / OpenSSL codes mapped, errors.ts):
 * `self_signed` — self-signed leaf or root; `untrusted` — an unknown issuer; `expired` /
 * `not_yet_valid` — outside its dates (often the computer's clock); `name_mismatch` — issued for
 * another host; `changed` — the server is pinned and now shows another untrusted certificate.
 */
export type MailCertReason = 'self_signed' | 'untrusted' | 'expired' | 'not_yet_valid' | 'name_mismatch' | 'changed' | 'other';

/** The server certificate behind a `TLS` error (or a discovery probe), for the trust prompt. */
export interface MailCertInfo {
  host: string;
  port: number;
  /** What `pinnedCert` takes to trust it. */
  fingerprint256: string;
  /** `CN=…, O=…` of the leaf ('' when unknown). */
  subject: string;
  issuer: string;
  /** Validity, epoch ms (0 = unknown). */
  notBefore: number;
  notAfter: number;
  reason: MailCertReason;
}

/** A discovered server: settings plus the certificate problem its probe saw, if any (§4). */
export interface MailDiscoveredServer extends MailServerSettings {
  /** The probe reached the server but its certificate did not verify: ask before the first login. */
  certIssue?: MailCertInfo;
}

/**
 * Account connection state:
 * - `syncing` — the first sync or a catch-up after reconnect is running;
 * - `idle` — synced, IDLE on the inbox;
 * - `offline` — network unreachable, retrying with backoff up to 15 min (§5);
 * - `auth_failed` — the server rejected the password: the account row asks for it (`accounts.setPassword`);
 * - `error` — anything else (TLS, server errors), see `MailAccount.error`.
 */
export type MailAccountState = 'syncing' | 'idle' | 'offline' | 'auth_failed' | 'error';

export interface MailAccount {
  id: string;
  /** The mailbox address, lower-cased. */
  email: string;
  /** Sender display name for outgoing mail ('' = none, the bare address is used). */
  name: string;
  provider: MailProvider;
  imap: MailServerSettings;
  smtp: MailServerSettings;
  /** The resolved login (usually the full address; autoconfig may say `%EMAILLOCALPART%`). */
  login: string;
  state: MailAccountState;
  /** Set for `auth_failed` / `error` / `offline`, null otherwise. */
  error: MailError | null;
  /** The last successful sync of any folder (null = never). */
  lastSyncAt: number | null;
  /**
   * The last send failed on the SMTP server's certificate (IMAP problems are in `error.cert`);
   * cleared by the next successful send or new SMTP settings.
   */
  smtpCertIssue?: MailCertInfo;
}

/**
 * Where discovered settings came from (§4): `known` provider table, `mx` record, `autoconfig`
 * (domain or Thunderbird ISPDB), DNS `srv` (RFC 6186), host `probe`, or `manual` (nothing worked —
 * the values are best guesses for pre-filling the manual form).
 */
export type MailDiscoverySource = 'known' | 'mx' | 'autoconfig' | 'srv' | 'probe' | 'manual';

export interface MailDiscovery {
  imap: MailDiscoveredServer;
  smtp: MailDiscoveredServer;
  source: MailDiscoverySource;
  provider: MailProvider;
  /**
   * Login template: `%EMAILADDRESS%` (default), `%EMAILLOCALPART%`, or a literal login. The engine
   * resolves it in `accounts.add`; the manual form shows it resolved.
   */
  loginTemplate: string;
  /**
   * The provider's «app password» help page (Gmail, Yandex, Mail.ru, iCloud), shown with `AUTH_FAILED`;
   * null when the provider takes the ordinary password.
   */
  appPasswordUrl: string | null;
}

/** `accounts.add` input. The password is the only time a secret crosses the renderer (§10). */
export interface MailAccountInput {
  email: string;
  password: string;
  /** Sender display name; default ''. */
  name?: string;
  /** Manual settings (the form after `DISCOVERY_FAILED`); absent = the engine discovers itself. */
  settings?: { imap: MailServerSettings; smtp: MailServerSettings; login: string };
}

/**
 * `accounts.update`: changed fields only. Changing servers / login re-checks the login like `add`;
 * a change of `pinnedCert` alone (trust a new certificate, «Сбросить») is stored without a login.
 */
export interface MailAccountPatch {
  name?: string;
  imap?: MailServerSettings;
  smtp?: MailServerSettings;
  login?: string;
}

// ---------------------------------------------------------------- folders

/**
 * Folder roles (SPECIAL-USE, else by name incl. Russian and `[Gmail]/…`; §5). Every account has exactly
 * one folder of each role except `null` (ordinary folders) — the engine synthesizes the missing ones:
 * - `starred` — the server's flagged folder (Gmail «Starred») or, where there is none, a virtual folder
 *   listing the account's flagged messages from every folder except junk / trash;
 * - `outbox` — always virtual: the outgoing queue (`outgoing.list`); `messages.list` on it returns [];
 * - `drafts` — local drafts in v1 (`drafts.list`); the server's Drafts folder is not synced (§6).
 */
export type MailFolderRole = 'inbox' | 'starred' | 'sent' | 'drafts' | 'outbox' | 'archive' | 'junk' | 'trash';

export interface MailFolder {
  id: string;
  accountId: string;
  /** The IMAP path ('' for virtual folders). */
  path: string;
  /** The display name: the last path segment (the UI localizes role folders itself). */
  name: string;
  role: MailFolderRole | null;
  /** The parent folder's id for nested folders, null at the top level. */
  parentId: string | null;
  /** Unread messages (for `outbox`: failed items). */
  unread: number;
  /** All messages (for `outbox`: queued + failed items). */
  total: number;
}

// ---------------------------------------------------------------- messages

export interface MailAddress {
  /** Display name, '' when the header has none. */
  name: string;
  address: string;
}

/**
 * Keyset cursor over the list order (row `date` desc, then row `messageId` desc): the next page starts
 * strictly after it. Built from the last row of a page (`{ date: row.date, id: row.messageId }`); stays
 * valid while rows are added above it.
 */
export interface MailCursor {
  date: number;
  /** The row's `messageId`. */
  id: string;
}

/** A folder by role (resolved per account; the only form allowed with `scope: 'all'`) or by id. */
export type MailFolderRef = MailFolderRole | { id: string };

export interface MailListQuery {
  /** An account id, or `'all'` for the unified mailbox («Все входящие»: the role across accounts). */
  scope: string;
  folder: MailFolderRef;
  /** The previous page's `next`; absent = the first (newest) page. */
  before?: MailCursor;
  /** Page size, 1..200. */
  limit: number;
  /** Only threads with at least one unread message in this folder. */
  unreadOnly?: boolean;
}

export interface MailSearchQuery {
  /** Free text: FTS over subject, sender, snippet and the text of downloaded bodies (§3). */
  text: string;
  /** An account id or `'all'`. */
  scope: string;
  /** Restrict to a folder; absent = every folder except junk and trash. */
  folder?: MailFolderRef;
  before?: MailCursor;
  limit: number;
}

/**
 * One list row: a thread as seen in one folder (key = threadId + folderId). The row shows the newest
 * message of the thread in that folder; `count` is the number of messages of the whole thread
 * across the account's folders (Apple Mail style: replies in «Sent» count too).
 */
export interface MailThreadRow {
  threadId: string;
  accountId: string;
  folderId: string;
  /** The newest message of the thread in this folder (opened on click). */
  messageId: string;
  /** That message's RFC 5322 Message-ID header ('' when it has none): In-Reply-To / References. */
  messageIdHeader: string;
  from: MailAddress;
  subject: string;
  /** Plain text preview, ≤ 200 chars, whitespace collapsed. */
  snippet: string;
  /** The newest message's date (also the cursor date). */
  date: number;
  count: number;
  /** At least one message of the thread in this folder is unread. */
  unread: boolean;
  /** At least one message of the thread in this folder is flagged. */
  flagged: boolean;
  hasAttachments: boolean;
}

export interface MailPage {
  rows: MailThreadRow[];
  /** Cursor for the next page, null = this was the last page of what is synced locally. */
  next: MailCursor | null;
}

export interface MailFlags {
  seen: boolean;
  flagged: boolean;
  answered: boolean;
}

/** Headers of one message (no body): the collapsed messages of a thread view. */
export interface MailHeader {
  id: string;
  threadId: string;
  accountId: string;
  folderId: string;
  /** The RFC 5322 Message-ID header ('' when the message has none). */
  messageIdHeader: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  /** Only known for our own sent messages; [] otherwise. */
  bcc: MailAddress[];
  replyTo: MailAddress[];
  subject: string;
  snippet: string;
  date: number;
  flags: MailFlags;
  hasAttachments: boolean;
  /** RFC822 size in bytes. */
  size: number;
}

export interface MailAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Content-ID without angle brackets, for `cid:` references in the HTML. */
  cid?: string;
  /** Content-Disposition inline (shown in the body, not in the attachment strip, when referenced). */
  inline: boolean;
}

/**
 * A full message. `messages.get` may download the body first (it is cached on disk, LRU, §3) — the
 * call resolves once the body is local.
 */
export interface MailMessage extends MailHeader {
  /**
   * The raw HTML part as sent, NOT sanitized: the renderer sanitizes it (DOMPurify, §10) and rewrites
   * `cid:` references with `MailApi.attachmentUrl`. null = no HTML part.
   */
  html: string | null;
  /** The text/plain part (or text derived from the HTML when there is none); null = no text either. */
  text: string | null;
  attachments: MailAttachment[];
  /** In-Reply-To header ('' = none). */
  inReplyTo: string;
  /** References header, oldest first. */
  references: string[];
  /** The HTML references remote (http/https) images: blocked until allowed (§8 «Картинки скрыты»). */
  remoteImages: boolean;
}

/** Flags to change; absent fields stay as they are. */
export interface MailFlagPatch {
  seen?: boolean;
  flagged?: boolean;
}

/**
 * The target of a message operation: explicit messages (the thread view), or whole thread rows (the
 * list) — a row acts on the thread's messages in that row's folder (for `setFlags` on a `starred`
 * row: on all the thread's flagged messages).
 */
export type MailSelection = { messageIds: string[] } | { threads: Array<{ threadId: string; folderId: string }> };

// ---------------------------------------------------------------- compose

export type MailDraftAttachment =
  /** A file picked / dropped in the composer; bytes travel in the call (≤ 25 MB per message, §6). */
  | { kind: 'file'; id: string; name: string; mime: string; size: number; data: Uint8Array }
  /** An attachment of an existing message (forward), fetched by the engine. */
  | { kind: 'message'; id: string; name: string; mime: string; size: number; messageId: string; attachmentId: string };

export interface MailDraft {
  /** Absent = a new draft (`drafts.save` assigns one). */
  id?: string;
  /** The sending account. */
  accountId: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  /** The body as typed (plain text; the engine adds the HTML part with autolinks, §6). */
  text: string;
  /**
   * The message this one answers / forwards. `reply` / `replyAll` set In-Reply-To / References and
   * `\Answered` on the original after sending; `quote` appends the original (blockquote in HTML,
   * `> ` lines in text, forward header for `forward`).
   */
  ref?: { messageId: string; kind: 'reply' | 'replyAll' | 'forward'; quote: boolean };
  attachments: MailDraftAttachment[];
  /** Set by the engine on save. */
  updatedAt?: number;
}

/** States of the outgoing queue (§6): retries 1 min → 1 h for up to 24 h, then `failed` for good. */
export type MailOutgoingState = 'queued' | 'sending' | 'failed' | 'sent';

export interface MailOutgoing {
  id: string;
  accountId: string;
  to: MailAddress[];
  subject: string;
  state: MailOutgoingState;
  /** Delivery attempts made so far. */
  attempts: number;
  /** The last attempt's error (null = none yet / sent). */
  error: MailError | null;
  /** The next automatic attempt (null = none: sending, sent, or given up). */
  nextAt: number | null;
  createdAt: number;
}

// ---------------------------------------------------------------- settings

export interface MailSettings {
  /** Remote images: `ask` = hidden with the «Показать» bar (default), `always` = shown. */
  remoteImages: 'ask' | 'always';
  /** Senders (lower-cased addresses) whose remote images are always shown («Всегда для этого отправителя»). */
  remoteImageSenders: string[];
  /** System notifications for new inbox mail (§8). */
  notify: boolean;
  /** Plain-text signature per account id ('' / absent = none). */
  signatures: Record<string, string>;
  /** Body / attachment cache limit per account, bytes (default 1 GiB, §3). */
  cacheLimitBytes: number;
}

export const DEFAULT_MAIL_SETTINGS: MailSettings = {
  remoteImages: 'ask',
  remoteImageSenders: [],
  notify: true,
  signatures: {},
  cacheLimitBytes: 1024 * 1024 * 1024,
};

// ---------------------------------------------------------------- events

/**
 * Engine → renderer events, one channel (`mail:event`). The engine coalesces them: at most one event
 * of a type per folder per 250 ms (rows merged, newest state wins). Row events are upserts / deletes
 * keyed by threadId + folderId; the renderer patches only what it holds (§9: one row + the badge).
 */
export type MailEvent =
  /** An account was added / changed state / settings; `account: null` = removed (with all its data). */
  | { type: 'account_state'; accountId: string; account: MailAccount | null }
  /** The account's complete folder list (sent on any change, counters included). */
  | { type: 'folders'; accountId: string; folders: MailFolder[] }
  /** New messages arrived in the folder: upsert `rows` (new or changed rows of their threads). */
  | { type: 'messages_added'; accountId: string; folderId: string; rows: MailThreadRow[]; messageIds: string[] }
  /** Flags / thread rows changed: upsert `rows`; `messageIds` = messages whose headers changed. */
  | { type: 'messages_changed'; accountId: string; folderId: string; rows: MailThreadRow[]; messageIds: string[] }
  /** Messages left the folder: drop `threadIds` rows (threads with nothing left here); other affected rows come as `messages_changed`. */
  | { type: 'messages_removed'; accountId: string; folderId: string; threadIds: string[]; messageIds: string[] }
  /** An outgoing item changed state; `removed` = gone from the queue (sent and filed, or deleted). */
  | { type: 'outgoing'; item: MailOutgoing; removed: boolean }
  /**
   * A new message in an inbox worth a notification: not junk, the account's first sync is over, not
   * a message we sent ourselves. Main / renderer apply DND and focus rules (§8).
   */
  | { type: 'new_mail'; accountId: string; messageId: string; threadId: string; from: MailAddress; subject: string }
  /**
   * Emitted by main, not the engine: the engine process went down (crash; requests fail with
   * `ENGINE_DOWN` until it is back) or came back up (refetch what is on screen).
   */
  | { type: 'engine'; state: 'up' | 'down' };

// ---------------------------------------------------------------- errors

export type MailErrorCode =
  /** The engine does not implement the method yet. */
  | 'NOT_IMPLEMENTED'
  /** The server rejected the login / password. */
  | 'AUTH_FAILED'
  /** No settings found (§4 step 6): `discovery` carries best guesses for the manual form. */
  | 'DISCOVERY_FAILED'
  /** Microsoft (personal and 365) — needs OAuth2, not supported in v1. */
  | 'UNSUPPORTED_PROVIDER'
  /** Connection refused / timed out / DNS. */
  | 'NETWORK'
  /** TLS handshake or certificate verification failed. */
  | 'TLS'
  /** The account / folder / message / draft / outgoing item does not exist (any more). */
  | 'NOT_FOUND'
  /** The server throttles us (Gmail «too many simultaneous connections», SMTP 4xx rate limits). */
  | 'RATE_LIMITED'
  /** The engine process is down or did not answer in 30 s (set by main's router). */
  | 'ENGINE_DOWN'
  /** Malformed arguments (unknown method, bad address, too large attachments, …). */
  | 'INVALID';

export interface MailError {
  code: MailErrorCode;
  message: string;
  /**
   * With `DISCOVERY_FAILED`: best guesses (`source: 'manual'`) to pre-fill the manual form.
   * With `AUTH_FAILED` from `accounts.add` / `setPassword`: the settings that were tried (for the
   * provider's `appPasswordUrl`).
   */
  discovery?: MailDiscovery;
  /** With `TLS` when a certificate did not verify: the certificate, for the trust prompt (§4). */
  cert?: MailCertInfo;
}

/** What a `MailApi` promise rejects with. */
export class MailApiError extends Error implements MailError {
  readonly code: MailErrorCode;
  readonly discovery?: MailDiscovery;
  readonly cert?: MailCertInfo;
  constructor(err: MailError) {
    super(err.message);
    this.name = 'MailApiError';
    this.code = err.code;
    if (err.discovery) this.discovery = err.discovery;
    if (err.cert) this.cert = err.cert;
  }
  toJSON(): MailError {
    return { code: this.code, message: this.message, ...(this.discovery ? { discovery: this.discovery } : {}), ...(this.cert ? { cert: this.cert } : {}) };
  }
}

export function isMailError(e: unknown): e is MailError {
  return typeof e === 'object' && e !== null && typeof (e as MailError).code === 'string' && typeof (e as MailError).message === 'string';
}

// ---------------------------------------------------------------- the API

/**
 * The mail API seen by the renderer (`getMailApi()` in features/mail/api.ts): Electron — a thin
 * wrapper over the preload bridge; dev / e2e — the in-memory mock (`CALABA_MAIL_MOCK=1`).
 * Every method except `attachmentUrl` and `onEvent` is a request to the engine (`mailMethods`).
 */
export interface MailApi {
  accounts: {
    list(): Promise<MailAccount[]>;
    /** Settings for an address (§4; ≤ 10 s). Rejects `UNSUPPORTED_PROVIDER` (Microsoft) or `DISCOVERY_FAILED`. */
    discover(email: string): Promise<MailDiscovery>;
    /**
     * Discover (unless `settings` given), log in to IMAP and SMTP, store the account (password
     * encrypted by main, §3) and start syncing. Rejects `AUTH_FAILED` / `DISCOVERY_FAILED` /
     * `UNSUPPORTED_PROVIDER` / `NETWORK` / `TLS`; nothing is stored then.
     */
    add(input: MailAccountInput): Promise<MailAccount>;
    update(accountId: string, patch: MailAccountPatch): Promise<MailAccount>;
    /** Removes the account and deletes its local data (`userData/mail/<accountId>`). */
    remove(accountId: string): Promise<void>;
    /** A new password after `auth_failed`: checked by logging in, then stored. */
    setPassword(accountId: string, password: string): Promise<MailAccount>;
  };
  folders: {
    list(accountId: string): Promise<MailFolder[]>;
  };
  messages: {
    /** A page of thread rows, newest first, from the local database (never waits for the network). */
    list(query: MailListQuery): Promise<MailPage>;
    /** A full message; downloads the body when it is not cached (may take seconds; `NETWORK` offline). */
    get(messageId: string): Promise<MailMessage>;
    /** All messages of a thread across the account's folders, oldest first, headers only. */
    thread(threadId: string): Promise<MailHeader[]>;
    /** Applied locally at once (events follow), queued to IMAP; rolled back with an event on failure. */
    setFlags(sel: MailSelection, patch: MailFlagPatch): Promise<void>;
    move(sel: MailSelection, folderId: string): Promise<void>;
    /** Move to the account's `archive` folder (Gmail: remove the Inbox label). */
    archive(sel: MailSelection): Promise<void>;
    /** Move to `trash`; in `trash` itself — the same as `delete`. */
    trash(sel: MailSelection): Promise<void>;
    /** Delete permanently (\Deleted + EXPUNGE). */
    delete(sel: MailSelection): Promise<void>;
    /** «Загрузить более ранние»: sync the next 90 days back of the folder; `exhausted` = nothing older. */
    loadOlder(folderId: string): Promise<{ exhausted: boolean }>;
  };
  compose: {
    /** Queue for sending; resolves with the queued item (progress via `outgoing` events). Removes the draft `draft.id`. */
    send(draft: MailDraft): Promise<MailOutgoing>;
  };
  drafts: {
    save(draft: MailDraft): Promise<MailDraft>;
    /** Local drafts, newest first; `accountId` absent = all accounts. */
    list(accountId?: string): Promise<MailDraft[]>;
    remove(draftId: string): Promise<void>;
  };
  outgoing: {
    /** The queue (queued, sending, failed), oldest first; `accountId` absent = all accounts. */
    list(accountId?: string): Promise<MailOutgoing[]>;
    retry(outgoingId: string): Promise<void>;
    remove(outgoingId: string): Promise<void>;
  };
  search(query: MailSearchQuery): Promise<MailPage>;
  sync: {
    /** Sync now (one account or all); resolves when started. */
    now(accountId?: string): Promise<void>;
  };
  settings: {
    get(): Promise<MailSettings>;
    set(patch: Partial<MailSettings>): Promise<MailSettings>;
    /**
     * «Очистить»: drops the cached bodies and attachments (one account, or all when absent); headers,
     * drafts and the outbox stay. Bodies download again when opened.
     */
    clearCache(accountId?: string): Promise<void>;
  };
  /**
   * A URL for an attachment usable in <img> / for download: `calaba-mail://attachment/<messageId>/<attachmentId>`
   * in Electron (inline only for image/*, §7/§10), a data: URL in the mock. Local, not a request.
   * Main answers `image/*` inline (for `<img>`); anything else is never rendered. To save any
   * attachment, navigate the app window to the URL (a plain `<a href>` click in the main frame, no
   * `download` attribute — the renderer CSP does not allow fetching it): main cancels that
   * navigation and downloads the file into Downloads through Chromium's download manager
   * (quarantine / Mark-of-the-Web, like `downloads.ts`), then reveals it in the file manager.
   */
  attachmentUrl(messageId: string, attachmentId: string): string;
  /** Subscribe to engine events; returns the unsubscribe function. Local, not a request. */
  onEvent(cb: (event: MailEvent) => void): () => void;
}

/** Members of `MailApi` that are not engine requests. */
type MailLocalMember = 'attachmentUrl' | 'onEvent';

type MethodPaths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends (...args: never[]) => unknown ? `${P}${K}` : MethodPaths<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Engine request names: `accounts.list`, `messages.setFlags`, `search`, … */
export type MailMethod = Exclude<MethodPaths<MailApi>, MailLocalMember>;

type Lookup<T, P extends string> = P extends `${infer H}.${infer R}`
  ? H extends keyof T
    ? Lookup<T[H], R>
    : never
  : P extends keyof T
    ? T[P]
    : never;

type MailFn<M extends MailMethod> = Extract<Lookup<MailApi, M>, (...args: never[]) => unknown>;
/** Positional arguments of a method (the wire `params`). */
export type MailParams<M extends MailMethod> = Parameters<MailFn<M>>;
/** The resolved value of a method. */
export type MailResult<M extends MailMethod> = Awaited<ReturnType<MailFn<M>>>;
/** The engine's dispatch table: one handler per method. */
export type MailHandlers = { [M in MailMethod]: (...args: MailParams<M>) => Promise<MailResult<M>> };

/** Every engine method, for validation in main and the engine (checked against `MailApi` below and in tests). */
export const mailMethods = [
  'accounts.list',
  'accounts.discover',
  'accounts.add',
  'accounts.update',
  'accounts.remove',
  'accounts.setPassword',
  'folders.list',
  'messages.list',
  'messages.get',
  'messages.thread',
  'messages.setFlags',
  'messages.move',
  'messages.archive',
  'messages.trash',
  'messages.delete',
  'messages.loadOlder',
  'compose.send',
  'drafts.save',
  'drafts.list',
  'drafts.remove',
  'outgoing.list',
  'outgoing.retry',
  'outgoing.remove',
  'search',
  'sync.now',
  'settings.get',
  'settings.set',
  'settings.clearCache',
] as const satisfies readonly MailMethod[];

/** Compile-time: `mailMethods` lists every `MailMethod` (a missing one makes this `false`). */
export type MailMethodsComplete = [Exclude<MailMethod, (typeof mailMethods)[number]>] extends [never] ? true : false;
/** Fails to compile when a `MailApi` method is missing from `mailMethods`. */
export const mailMethodsComplete: MailMethodsComplete = true;

const METHOD_SET: ReadonlySet<string> = new Set(mailMethods);

export function isMailMethod(v: unknown): v is MailMethod {
  return typeof v === 'string' && METHOD_SET.has(v);
}

// ---------------------------------------------------------------- wire format

/**
 * renderer → main (preload `calaba.mail.request`, IPC `mail:request`): a call without an id — main
 * correlates the reply itself (ipcMain.handle) and assigns its own ids towards the engine.
 */
export interface MailCall {
  method: MailMethod;
  /** Positional arguments (`MailParams<method>`), structured-clone safe. */
  params: unknown[];
}

/** The outcome of a call: what `mail:request` resolves with (it never rejects for mail errors). */
export type MailReply = { ok: true; result: unknown } | { ok: false; error: MailError };

/** main → engine request; `id` unique per engine process lifetime. */
export interface MailRequest extends MailCall {
  id: number;
}

/** engine → main response to `MailRequest.id`. */
export type MailResponse = MailReply & { id: number };

/**
 * An account as main hands it to the engine (main → engine only, never to the renderer): the stored
 * settings plus the password decrypted from `userData/mail/accounts.bin` (§3).
 */
export interface MailEngineAccount {
  id: string;
  email: string;
  name: string;
  provider: MailProvider;
  imap: MailServerSettings;
  smtp: MailServerSettings;
  login: string;
  password: string;
}

/**
 * `verify` input: log in to IMAP and SMTP before main stores an account (`accounts.add`, `update`
 * with new servers, `setPassword`). Without `settings` the engine discovers them first (§4).
 */
export interface MailVerifyInput {
  email: string;
  password: string;
  settings?: { imap: MailServerSettings; smtp: MailServerSettings; login: string };
}

/** The `verify` result: the settings that logged in (main stores them with the password). */
export interface MailVerified {
  provider: MailProvider;
  imap: MailServerSettings;
  smtp: MailServerSettings;
  login: string;
}

/** The `attachment` result (main's `calaba-mail://` handler): the bytes and what to serve them as. */
export interface MailAttachmentData {
  name: string;
  mime: string;
  data: Uint8Array;
}

/**
 * Messages main → engine (utilityProcess `postMessage`):
 * - `request` — a renderer call relayed by main;
 * - `init` — first message after every fork: where the engine keeps its data (`userData/mail`);
 * - `accounts` — the complete account list with passwords, after `init` and on every change (the
 *   engine starts / stops / restarts account syncs by diffing it);
 * - `verify` / `attachment` — main's own requests, answered with a `response` of the same `id`
 *   (result `MailVerified` / `MailAttachmentData`); ids share the `request` id space.
 */
export type MailToEngine =
  | { kind: 'request'; req: MailRequest }
  | { kind: 'init'; dataDir: string }
  | { kind: 'accounts'; accounts: MailEngineAccount[] }
  | { kind: 'verify'; id: number; input: MailVerifyInput }
  | { kind: 'attachment'; id: number; messageId: string; attachmentId: string };

/** Messages engine → main (`process.parentPort.postMessage`). */
export type MailFromEngine = { kind: 'response'; res: MailResponse } | { kind: 'event'; event: MailEvent };

/** Prefix of attachment URLs served by main (§7). */
export const MAIL_ATTACHMENT_URL = 'calaba-mail://attachment/';

/**
 * Remote images through main (§10): `calaba-mail://remote/<base64url(http(s) URL)>`. Main fetches
 * it in a cookie-less in-memory session (no referrer), raster `image/*` only, ≤ 10 MB, 10 s.
 */
export const MAIL_REMOTE_URL = 'calaba-mail://remote/';

export function mailRemoteImageUrl(url: string): string {
  const bytes = new TextEncoder().encode(url);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return MAIL_REMOTE_URL + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A `mailto:` click inside a message body (§10): main's frame guard cancels the iframe navigation
 * and delivers this deep link through the usual path (IPC `app:deepLink`, ≤ 512 chars):
 * `calab://mail/compose?to=a@b,c@d&cc=…&subject=…&body=…`, every value URL-encoded
 * (`encodeURIComponent`), empty fields left out, the body (then the subject) cut to fit.
 */
export const MAIL_COMPOSE_LINK = 'calab://mail/compose';

export function mailComposeLink(f: { to: string[]; cc: string[]; subject: string; body: string }): string {
  const build = (subject: string, body: string): string => {
    const q: string[] = [];
    if (f.to.length) q.push(`to=${encodeURIComponent(f.to.join(','))}`);
    if (f.cc.length) q.push(`cc=${encodeURIComponent(f.cc.join(','))}`);
    if (subject) q.push(`subject=${encodeURIComponent(subject)}`);
    if (body) q.push(`body=${encodeURIComponent(body)}`);
    return q.length ? `${MAIL_COMPOSE_LINK}?${q.join('&')}` : MAIL_COMPOSE_LINK;
  };
  // Halve by code points: a lone surrogate would make encodeURIComponent throw.
  const half = (v: string): string => {
    const cps = Array.from(v);
    return cps.slice(0, Math.floor(cps.length / 2)).join('');
  };
  let body = f.body;
  let subject = f.subject;
  let link = build(subject, body);
  while (link.length > 512 && body) {
    body = half(body);
    link = build(subject, body);
  }
  while (link.length > 512 && subject) {
    subject = half(subject);
    link = build(subject, body);
  }
  return link.length > 512 ? MAIL_COMPOSE_LINK : link;
}

export function mailAttachmentUrl(messageId: string, attachmentId: string): string {
  return `${MAIL_ATTACHMENT_URL}${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}`;
}

/**
 * Builds a `MailApi` over a transport (the preload bridge in Electron): each method sends
 * `{method, params}` and resolves the result or rejects with `MailApiError`.
 */
export function createMailClient(transport: {
  request(call: MailCall): Promise<MailReply>;
  onEvent(cb: (event: MailEvent) => void): () => void;
}): MailApi {
  const root: Record<string, unknown> = {
    attachmentUrl: mailAttachmentUrl,
    onEvent: (cb: (event: MailEvent) => void) => transport.onEvent(cb),
  };
  for (const method of mailMethods) {
    const parts = method.split('.');
    let node = root;
    for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Record<string, unknown>;
    node[parts[parts.length - 1] ?? method] = async (...params: unknown[]): Promise<unknown> => {
      const reply = await transport.request({ method, params });
      if (!reply.ok) throw new MailApiError(reply.error);
      return reply.result;
    };
  }
  return root as unknown as MailApi;
}
