/* eslint-disable @typescript-eslint/require-await -- the mock mirrors the async MailApi with synchronous bodies; `async` turns throws into rejections */
import {
  DEFAULT_MAIL_SETTINGS,
  MailApiError,
  type MailAccount,
  type MailApi,
  type MailDiscovery,
  type MailDraft,
  type MailErrorCode,
  type MailEvent,
  type MailFolder,
  type MailFolderRef,
  type MailHeader,
  type MailMessage,
  type MailOutgoing,
  type MailPage,
  type MailSelection,
  type MailSettings,
  type MailThreadRow,
} from '../../../../shared/mail';
import { MOCK_NOW, PIXEL_PNG, folderId, mockAccounts, mockFolders, mockMessages, ROLES, type MockMessage } from './fixtures';

export interface MockMailOptions {
  /** Steps of sending / syncing are this far apart (default 400 ms; 0 = all at once, for tests). */
  delayMs?: number;
  /** The clock for new items (default: max(fixture «now», Date.now())). */
  now?: () => number;
  /**
   * `syncing` → `idle` takes this long on `sync.now`, a new account and the first load (default
   * 1500 ms, 0 with `delayMs: 0`): the column's spinner / progress line are visible in dev.
   */
  syncDelayMs?: number;
}

const fail = (code: MailErrorCode, message: string): never => {
  throw new MailApiError({ code, message });
};

const clone = <T>(v: T): T => structuredClone(v);

const snippetOf = (m: MockMessage): string => (m.text ?? m.html?.replace(/<[^>]+>/g, ' ') ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

interface Known {
  domains: RegExp;
  provider: MailDiscovery['provider'];
  imap: string;
  smtp: string;
  smtpPort: number;
  url: string | null;
}

const KNOWN: Known[] = [
  { domains: /^(gmail|googlemail)\.com$/, provider: 'gmail', imap: 'imap.gmail.com', smtp: 'smtp.gmail.com', smtpPort: 465, url: 'https://support.google.com/accounts/answer/185833' },
  { domains: /^(yandex\.[a-z]+|ya\.ru)$/, provider: 'yandex', imap: 'imap.yandex.ru', smtp: 'smtp.yandex.ru', smtpPort: 465, url: 'https://yandex.ru/support/id/authorization/app-passwords.html' },
  { domains: /^(mail|bk|list|inbox|internet)\.ru$/, provider: 'mailru', imap: 'imap.mail.ru', smtp: 'smtp.mail.ru', smtpPort: 465, url: 'https://help.mail.ru/mail/security/protection/external' },
  { domains: /^(icloud|me|mac)\.com$/, provider: 'icloud', imap: 'imap.mail.me.com', smtp: 'smtp.mail.me.com', smtpPort: 587, url: 'https://support.apple.com/102654' },
];
const MICROSOFT = /^(outlook|hotmail|live|msn)\.[a-z.]+$/;

function mockDiscover(email: string): MailDiscovery {
  const at = email.lastIndexOf('@');
  const domain = email.slice(at + 1).toLowerCase();
  if (at < 1 || !domain.includes('.')) return fail('INVALID', 'not an email address');
  if (MICROSOFT.test(domain)) return fail('UNSUPPORTED_PROVIDER', 'Microsoft accounts need OAuth2');
  const k = KNOWN.find((x) => x.domains.test(domain));
  if (k) {
    return {
      imap: { host: k.imap, port: 993, security: 'tls' },
      smtp: { host: k.smtp, port: k.smtpPort, security: k.smtpPort === 465 ? 'tls' : 'starttls' },
      source: 'known',
      provider: k.provider,
      loginTemplate: '%EMAILADDRESS%',
      appPasswordUrl: k.url,
    };
  }
  const guess: MailDiscovery = {
    imap: { host: `imap.${domain}`, port: 993, security: 'tls' },
    smtp: { host: `smtp.${domain}`, port: 465, security: 'tls' },
    source: 'manual',
    provider: 'other',
    loginTemplate: '%EMAILADDRESS%',
    appPasswordUrl: null,
  };
  if (domain.endsWith('.invalid')) throw new MailApiError({ code: 'DISCOVERY_FAILED', message: `no mail settings for ${domain}`, discovery: guess });
  return { ...guess, imap: { ...guess.imap, host: `mail.${domain}` }, smtp: { host: `mail.${domain}`, port: 587, security: 'starttls' }, source: 'probe' };
}

/**
 * In-memory `MailApi` with deterministic fixtures (ADR-0088 §7): for `CALABA_MAIL_MOCK=1` dev runs, QA
 * screenshots and unit tests. Follows the contract's semantics (ids, cursors, events) closely enough
 * to build the UI against; no persistence.
 */
export function createMockMailApi(opts: MockMailOptions = {}): MailApi {
  const delay = opts.delayMs ?? 400;
  const syncDelay = opts.syncDelayMs ?? (delay === 0 ? 0 : 1500);
  const now = opts.now ?? (() => Math.max(MOCK_NOW, Date.now()));
  const accounts = new Map(mockAccounts().map((a) => [a.id, a]));
  const folders = new Map(mockFolders().map((f) => [f.id, f]));
  const messages = new Map(mockMessages().map((m) => [m.id, m]));
  const outgoing = new Map<string, MailOutgoing>();
  const outgoingDrafts = new Map<string, MailDraft>();
  const drafts = new Map<string, MailDraft>();
  let settings: MailSettings = clone(DEFAULT_MAIL_SETTINGS);
  const listeners = new Set<(e: MailEvent) => void>();
  let seq = 0;
  const nextId = (p: string): string => `${p}-${++seq}`;

  const emit = (e: MailEvent): void => {
    const copy = clone(e);
    queueMicrotask(() => {
      for (const l of listeners) l(copy);
    });
  };
  const later = (fn: () => void, ms = delay): void => {
    if (ms === 0) fn();
    else setTimeout(fn, ms);
  };

  const account = (id: string): MailAccount => accounts.get(id) ?? fail('NOT_FOUND', `no account ${id}`);
  const folder = (id: string): MailFolder => folders.get(id) ?? fail('NOT_FOUND', `no folder ${id}`);
  const message = (id: string): MockMessage => messages.get(id) ?? fail('NOT_FOUND', `no message ${id}`);
  const byRole = (accountId: string, role: string): MailFolder => folder(folderId(accountId, role));
  const isJunkOrTrash = (m: MockMessage): boolean => /\/(junk|trash)$/.test(m.folderId);

  /** Messages listed in a folder (virtual folders included). */
  function inFolder(f: MailFolder): MockMessage[] {
    const all = [...messages.values()];
    if (f.role === 'starred') return all.filter((m) => m.accountId === f.accountId && m.flagged && !isJunkOrTrash(m));
    if (f.role === 'outbox' || f.role === 'drafts') return [];
    return all.filter((m) => m.folderId === f.id);
  }

  function recount(accountId: string): MailFolder[] {
    const list = [...folders.values()].filter((f) => f.accountId === accountId);
    for (const f of list) {
      if (f.role === 'outbox') {
        const q = [...outgoing.values()].filter((o) => o.accountId === accountId && o.state !== 'sent');
        f.total = q.length;
        f.unread = q.filter((o) => o.state === 'failed').length;
      } else if (f.role === 'drafts') {
        f.total = [...drafts.values()].filter((d) => d.accountId === accountId).length;
        f.unread = 0;
      } else {
        const ms = inFolder(f);
        f.total = ms.length;
        f.unread = ms.filter((m) => !m.seen).length;
      }
    }
    return list;
  }
  for (const a of accounts.keys()) recount(a);

  const emitFolders = (accountId: string): void => emit({ type: 'folders', accountId, folders: clone(recount(accountId)) });

  function rowsOf(f: MailFolder, list: MockMessage[]): MailThreadRow[] {
    const groups = new Map<string, MockMessage[]>();
    for (const m of list) {
      const g = groups.get(m.threadId);
      if (g) g.push(m);
      else groups.set(m.threadId, [m]);
    }
    const rows: MailThreadRow[] = [];
    for (const [threadId, g] of groups) {
      g.sort((a, b) => b.date - a.date || (b.id < a.id ? -1 : 1));
      const top = g[0];
      if (!top) continue;
      rows.push({
        threadId,
        accountId: top.accountId,
        folderId: f.id,
        messageId: top.id,
        messageIdHeader: top.messageIdHeader,
        from: top.from,
        subject: top.subject,
        snippet: snippetOf(top),
        date: top.date,
        count: [...messages.values()].filter((m) => m.threadId === threadId && m.accountId === top.accountId).length,
        unread: g.some((m) => !m.seen),
        flagged: g.some((m) => m.flagged),
        hasAttachments: g.some((m) => m.attachments.some((a) => !a.inline)),
      });
    }
    return rows;
  }

  function page(rows: MailThreadRow[], before: { date: number; id: string } | undefined, limit: number): MailPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('INVALID', 'limit must be 1..200');
    rows.sort((a, b) => b.date - a.date || (b.messageId < a.messageId ? -1 : b.messageId > a.messageId ? 1 : 0));
    const after = before ? rows.filter((r) => r.date < before.date || (r.date === before.date && r.messageId < before.id)) : rows;
    const out = after.slice(0, limit);
    const last = out[out.length - 1];
    return { rows: clone(out), next: after.length > limit && last ? { date: last.date, id: last.messageId } : null };
  }

  function resolveFolders(scope: string, ref: MailFolderRef): MailFolder[] {
    if (typeof ref === 'string') {
      const ids = scope === 'all' ? [...accounts.keys()] : [account(scope).id];
      return ids.map((a) => byRole(a, ref));
    }
    if (scope === 'all') return fail('INVALID', "scope 'all' takes a folder role");
    const f = folder(ref.id);
    if (f.accountId !== scope) fail('INVALID', 'folder of another account');
    return [f];
  }

  function selected(sel: MailSelection): MockMessage[] {
    if ('messageIds' in sel) return sel.messageIds.map(message);
    const out: MockMessage[] = [];
    for (const { threadId, folderId: fid } of sel.threads) {
      for (const m of inFolder(folder(fid))) if (m.threadId === threadId) out.push(m);
    }
    return out;
  }

  /** Emits row upserts / removals for the given folders and threads after a change. */
  function emitRows(type: 'messages_added' | 'messages_changed', touched: Map<string, Set<string>>, messageIds: string[]): void {
    for (const [fid, threads] of touched) {
      const f = folders.get(fid);
      if (!f) continue;
      const rows = rowsOf(
        f,
        inFolder(f).filter((m) => threads.has(m.threadId)),
      );
      const gone = [...threads].filter((t) => !rows.some((r) => r.threadId === t));
      if (rows.length) emit({ type, accountId: f.accountId, folderId: fid, rows, messageIds });
      if (gone.length) emit({ type: 'messages_removed', accountId: f.accountId, folderId: fid, threadIds: gone, messageIds });
    }
  }

  function touch(map: Map<string, Set<string>>, m: MockMessage): void {
    for (const fid of [m.folderId, folderId(m.accountId, 'starred')]) {
      let s = map.get(fid);
      if (!s) map.set(fid, (s = new Set()));
      s.add(m.threadId);
    }
  }

  function moveTo(list: MockMessage[], target: MailFolder): void {
    if (!target.path) fail('INVALID', 'cannot move into a virtual folder');
    const removed = new Map<string, Set<string>>();
    const added = new Map<string, Set<string>>();
    const accountsTouched = new Set<string>();
    for (const m of list) {
      if (m.accountId !== target.accountId) fail('INVALID', 'cannot move between accounts');
      if (m.folderId === target.id) continue;
      touch(removed, m);
      messages.delete(m.id);
      const moved: MockMessage = { ...m, id: nextId('mv'), folderId: target.id };
      moved.attachments = m.attachments.map((a) => ({ ...a }));
      messages.set(moved.id, moved);
      touch(added, moved);
      accountsTouched.add(m.accountId);
    }
    emitRows('messages_changed', removed, list.map((m) => m.id));
    emitRows('messages_added', added, []);
    for (const a of accountsTouched) emitFolders(a);
  }

  function header(m: MockMessage): MailHeader {
    return clone({
      id: m.id,
      threadId: m.threadId,
      accountId: m.accountId,
      folderId: m.folderId,
      messageIdHeader: m.messageIdHeader,
      from: m.from,
      to: m.to,
      cc: m.cc,
      bcc: m.bcc,
      replyTo: m.replyTo,
      subject: m.subject,
      snippet: snippetOf(m),
      date: m.date,
      flags: { seen: m.seen, flagged: m.flagged, answered: m.answered },
      hasAttachments: m.attachments.some((a) => !a.inline),
      size: (m.html?.length ?? 0) + (m.text?.length ?? 0) + m.attachments.reduce((s, a) => s + a.size, 0),
    });
  }

  function setAccount(a: MailAccount): void {
    accounts.set(a.id, a);
    emit({ type: 'account_state', accountId: a.id, account: a });
  }

  /** `syncing` now, `idle` after the sync delay (a catch-up: nothing new arrives in the mock). */
  function startSync(ids: string[]): void {
    for (const id of ids) setAccount({ ...account(id), state: 'syncing' });
    later(() => {
      for (const id of ids) if (accounts.has(id)) setAccount({ ...account(id), state: 'idle', lastSyncAt: now() });
    }, syncDelay);
  }
  let firstLoad = syncDelay > 0;

  function deliver(item: MailOutgoing): void {
    const draft = outgoingDrafts.get(item.id);
    if (!draft) return;
    item.state = 'sending';
    item.nextAt = null;
    emit({ type: 'outgoing', item, removed: false });
    later(() => {
      item.attempts++;
      if ([...draft.to, ...draft.cc, ...draft.bcc].some((a) => a.address.toLowerCase().endsWith('@nowhere.invalid'))) {
        item.state = 'failed';
        item.error = { code: 'NETWORK', message: 'nowhere.invalid: host not found' };
        item.nextAt = now() + 60_000;
        emit({ type: 'outgoing', item, removed: false });
        emitFolders(item.accountId);
        return;
      }
      item.state = 'sent';
      item.error = null;
      outgoing.delete(item.id);
      outgoingDrafts.delete(item.id);
      const a = account(item.accountId);
      const orig = draft.ref ? messages.get(draft.ref.messageId) : undefined;
      const sent: MockMessage = {
        id: nextId('sent'),
        threadId: orig && draft.ref?.kind !== 'forward' ? orig.threadId : nextId('t'),
        accountId: a.id,
        folderId: folderId(a.id, 'sent'),
        messageIdHeader: `<${item.id}@mock.calab>`,
        from: { name: a.name, address: a.email },
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        replyTo: [],
        subject: draft.subject,
        date: now(),
        seen: true,
        flagged: false,
        answered: false,
        html: draft.html ?? null,
        text: draft.text,
        attachments: draft.attachments.map((x) => ({ id: x.id, name: x.name, mime: x.mime, size: x.size, inline: false })),
        inReplyTo: orig && draft.ref?.kind !== 'forward' ? orig.messageIdHeader : '',
        references: orig && draft.ref?.kind !== 'forward' ? [...orig.references, orig.messageIdHeader] : [],
        remoteImages: false,
      };
      messages.set(sent.id, sent);
      emit({ type: 'outgoing', item, removed: true });
      const added = new Map<string, Set<string>>([[sent.folderId, new Set([sent.threadId])]]);
      emitRows('messages_added', added, [sent.id]);
      if (orig && draft.ref?.kind !== 'forward') {
        orig.answered = true;
        const changed = new Map<string, Set<string>>();
        touch(changed, orig);
        emitRows('messages_changed', changed, [orig.id]);
      }
      emitFolders(a.id);
    });
  }

  const api: MailApi = {
    accounts: {
      list: async () => {
        // The first load of the section catches up like the engine after a start (spinner in dev);
        // after the store has applied this list.
        if (firstLoad) {
          firstLoad = false;
          setTimeout(() => startSync([...accounts.keys()]), 50);
        }
        return clone([...accounts.values()]);
      },
      discover: (email) => Promise.resolve().then(() => mockDiscover(email)),
      add: async (input) => {
        const email = input.email.trim().toLowerCase();
        const found = input.settings
          ? { ...input.settings, provider: 'other' as const }
          : { ...mockDiscover(email), login: email };
        if ([...accounts.values()].some((a) => a.email === email)) fail('INVALID', 'account already added');
        if (input.password === 'wrong') fail('AUTH_FAILED', 'Invalid credentials (Failure)');
        const a: MailAccount = {
          id: nextId('acc'),
          email,
          name: input.name ?? '',
          provider: found.provider,
          imap: found.imap,
          smtp: found.smtp,
          login: found.login,
          state: 'syncing',
          error: null,
          lastSyncAt: null,
        };
        for (const role of ROLES) {
          const path = role === 'inbox' ? 'INBOX' : role === 'outbox' || role === 'starred' ? '' : role.charAt(0).toUpperCase() + role.slice(1);
          folders.set(folderId(a.id, role), { id: folderId(a.id, role), accountId: a.id, path, name: path || role, role, parentId: null, unread: 0, total: 0 });
        }
        setAccount(a);
        emitFolders(a.id);
        later(() => setAccount({ ...a, state: 'idle', lastSyncAt: now() }), syncDelay);
        return clone(a);
      },
      update: async (id, patch) => {
        const a = { ...account(id), ...patch };
        setAccount(a);
        return clone(a);
      },
      remove: async (id) => {
        account(id);
        accounts.delete(id);
        for (const [k, f] of folders) if (f.accountId === id) folders.delete(k);
        for (const [k, m] of messages) if (m.accountId === id) messages.delete(k);
        for (const [k, o] of outgoing) if (o.accountId === id) outgoing.delete(k);
        for (const [k, d] of drafts) if (d.accountId === id) drafts.delete(k);
        emit({ type: 'account_state', accountId: id, account: null });
      },
      setPassword: async (id, password) => {
        const a = account(id);
        if (password === 'wrong') fail('AUTH_FAILED', 'Invalid credentials (Failure)');
        const next: MailAccount = { ...a, state: 'idle', error: null, lastSyncAt: now() };
        setAccount(next);
        return clone(next);
      },
    },
    folders: {
      list: async (accountId) => {
        account(accountId);
        return clone(recount(accountId));
      },
      empty: async (fid) => {
        const f = folder(fid);
        if (f.role !== 'trash' && f.role !== 'junk') fail('INVALID', 'only the trash and junk folders can be emptied');
        const list = inFolder(f);
        const touched = new Map<string, Set<string>>();
        for (const m of list) {
          touch(touched, m);
          messages.delete(m.id);
        }
        emitRows('messages_changed', touched, list.map((m) => m.id));
        emitFolders(f.accountId);
      },
    },
    messages: {
      list: async (q) => {
        const rows = resolveFolders(q.scope, q.folder).flatMap((f) => rowsOf(f, inFolder(f)));
        return page(
          rows.filter((r) => (!q.unreadOnly || r.unread) && (!q.flaggedOnly || r.flagged)),
          q.before,
          q.limit,
        );
      },
      get: async (id) => {
        const m = message(id);
        const full: MailMessage = {
          ...header(m),
          html: m.html,
          text: m.text,
          attachments: clone(m.attachments),
          inReplyTo: m.inReplyTo,
          references: [...m.references],
          remoteImages: m.remoteImages,
        };
        return full;
      },
      raw: async (id) => {
        const m = message(id);
        const addr = (a: { name: string; address: string }): string => (a.name ? `"${a.name}" <${a.address}>` : a.address);
        const head = [
          `Message-ID: ${m.messageIdHeader}`,
          `Date: ${new Date(m.date).toUTCString()}`,
          `From: ${addr(m.from)}`,
          `To: ${m.to.map(addr).join(', ')}`,
          `Subject: ${m.subject}`,
          'MIME-Version: 1.0',
          `Content-Type: ${m.html ? 'text/html' : 'text/plain'}; charset=utf-8`,
          'Content-Transfer-Encoding: 8bit',
        ];
        return new TextEncoder().encode(`${head.join('\r\n')}\r\n\r\n${m.html ?? m.text ?? ''}\r\n`);
      },
      thread: async (threadId) => {
        const list = [...messages.values()].filter((m) => m.threadId === threadId).sort((a, b) => a.date - b.date);
        if (!list.length) fail('NOT_FOUND', `no thread ${threadId}`);
        return list.map(header);
      },
      setFlags: async (sel, patch) => {
        const list = selected(sel);
        const touched = new Map<string, Set<string>>();
        for (const m of list) {
          touch(touched, m);
          if (patch.seen !== undefined) m.seen = patch.seen;
          if (patch.flagged !== undefined) m.flagged = patch.flagged;
        }
        emitRows('messages_changed', touched, list.map((m) => m.id));
        for (const a of new Set(list.map((m) => m.accountId))) emitFolders(a);
      },
      move: async (sel, target) => moveTo(selected(sel), folder(target)),
      archive: async (sel) => {
        const list = selected(sel);
        for (const a of new Set(list.map((m) => m.accountId))) {
          moveTo(
            list.filter((m) => m.accountId === a),
            byRole(a, 'archive'),
          );
        }
      },
      trash: async (sel) => {
        const list = selected(sel);
        const inTrash = list.filter((m) => m.folderId.endsWith('/trash'));
        if (inTrash.length) await api.messages.delete({ messageIds: inTrash.map((m) => m.id) });
        const rest = list.filter((m) => !m.folderId.endsWith('/trash'));
        for (const a of new Set(rest.map((m) => m.accountId))) {
          moveTo(
            rest.filter((m) => m.accountId === a),
            byRole(a, 'trash'),
          );
        }
      },
      delete: async (sel) => {
        const list = selected(sel);
        const touched = new Map<string, Set<string>>();
        for (const m of list) {
          touch(touched, m);
          messages.delete(m.id);
        }
        emitRows('messages_changed', touched, list.map((m) => m.id));
        for (const a of new Set(list.map((m) => m.accountId))) emitFolders(a);
      },
      loadOlder: async (fid) => {
        folder(fid);
        return { exhausted: true };
      },
    },
    compose: {
      send: async (draft) => {
        const a = account(draft.accountId);
        if (draft.to.length + draft.cc.length + draft.bcc.length === 0) fail('INVALID', 'no recipients');
        if (draft.attachments.reduce((s, x) => s + x.size, 0) > 25 * 1024 * 1024) fail('INVALID', 'attachments exceed 25 MB');
        const item: MailOutgoing = {
          id: nextId('out'),
          accountId: a.id,
          to: clone(draft.to),
          subject: draft.subject,
          state: 'queued',
          attempts: 0,
          error: null,
          nextAt: null,
          createdAt: now(),
        };
        outgoing.set(item.id, item);
        outgoingDrafts.set(item.id, clone(draft));
        if (draft.id) drafts.delete(draft.id);
        const queued = clone(item);
        emit({ type: 'outgoing', item, removed: false });
        emitFolders(a.id);
        later(() => deliver(item));
        return queued;
      },
    },
    drafts: {
      save: async (draft) => {
        account(draft.accountId);
        const saved: MailDraft = { ...clone(draft), id: draft.id ?? nextId('draft'), updatedAt: now() };
        drafts.set(saved.id ?? '', saved);
        emitFolders(saved.accountId);
        return clone(saved);
      },
      list: async (accountId) =>
        clone([...drafts.values()].filter((d) => !accountId || d.accountId === accountId).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))),
      remove: async (id) => {
        const d = drafts.get(id) ?? fail('NOT_FOUND', `no draft ${id}`);
        drafts.delete(id);
        emitFolders(d.accountId);
      },
    },
    outgoing: {
      list: async (accountId) => clone([...outgoing.values()].filter((o) => !accountId || o.accountId === accountId).sort((a, b) => a.createdAt - b.createdAt)),
      retry: async (id) => {
        const item = outgoing.get(id) ?? fail('NOT_FOUND', `no outgoing ${id}`);
        if (item.state === 'failed') later(() => deliver(item));
      },
      remove: async (id) => {
        const item = outgoing.get(id) ?? fail('NOT_FOUND', `no outgoing ${id}`);
        outgoing.delete(id);
        outgoingDrafts.delete(id);
        emit({ type: 'outgoing', item, removed: true });
        emitFolders(item.accountId);
      },
    },
    search: async (q) => {
      const text = q.text.trim().toLowerCase();
      const fs = q.folder
        ? resolveFolders(q.scope, q.folder)
        : [...folders.values()].filter((f) => (q.scope === 'all' || f.accountId === q.scope) && f.path && f.role !== 'junk' && f.role !== 'trash' && f.role !== 'starred');
      const hit = (m: MockMessage): boolean =>
        !text || [m.subject, m.from.name, m.from.address, m.text ?? ''].some((s) => s.toLowerCase().includes(text));
      return page(
        fs.flatMap((f) => rowsOf(f, inFolder(f).filter(hit))),
        q.before,
        q.limit,
      );
    },
    sync: {
      now: async (accountId) => {
        const ids = accountId ? [account(accountId).id] : [...accounts.keys()];
        startSync(ids);
      },
    },
    settings: {
      get: async () => clone(settings),
      set: async (patch) => {
        settings = { ...settings, ...clone(patch) };
        return clone(settings);
      },
      // Bodies are in memory in the mock: nothing to drop.
      clearCache: async () => undefined,
    },
    attachmentUrl: (messageId, attachmentId) => {
      const a = messages.get(messageId)?.attachments.find((x) => x.id === attachmentId);
      if (!a || a.mime.startsWith('image/')) return PIXEL_PNG;
      return `data:${a.mime};base64,${btoa(`mock attachment ${a.name.replace(/[^\x20-\x7e]/g, '_')}`)}`;
    },
    onEvent: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
  return api;
}
