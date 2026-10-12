import { create } from 'zustand';
import {
  DEFAULT_MAIL_SETTINGS,
  isMailError,
  type MailAccount,
  type MailApi,
  type MailCursor,
  type MailDraft,
  type MailErrorCode,
  type MailEvent,
  type MailFlagPatch,
  type MailFolder,
  type MailFolderRef,
  type MailFolderRole,
  type MailHeader,
  type MailMessage,
  type MailOutgoing,
  type MailPage,
  type MailSelection,
  type MailSettings,
  type MailThreadRow,
} from '../../shared/mail';

/**
 * The mail client's data (ADR-0088 §8–§9): accounts, folders, the current page(s) of thread rows of
 * the selected mailbox, the open thread, the outgoing queue and settings. The store holds what is on
 * screen, never the whole mailbox; engine events (already coalesced, §7) patch only what is held.
 *
 * Re-renders (CLAUDE.md «Ререндеры»): rows live in `rows` by key and `order` lists the keys — an
 * event about one row replaces that row object only (the list reads `order`, which keeps its
 * identity unless rows are inserted / removed); the rail badge is a number (`inboxUnread`); no
 * timers here (events, never polling).
 */

/** The selected mailbox: an account id or `'all'`, and a folder role (the only form for `'all'`) or id. */
export interface MailBox {
  scope: string;
  folder: MailFolderRef;
}

export const ALL_INBOXES: MailBox = { scope: 'all', folder: 'inbox' };

/** A thread row is a thread within one folder (contract: key = threadId + folderId). */
export const rowKey = (r: { threadId: string; folderId: string }): string => `${r.threadId}\n${r.folderId}`;

export const PAGE_SIZE = 50;

export type ListState = 'idle' | 'loading' | 'error';

export interface ThreadView {
  threadId: string;
  /** The row the thread was opened from (null: from a notification / link). */
  rowKey: string | null;
  /** Message ids, oldest first. */
  ids: string[];
  state: 'loading' | 'ready' | 'error';
}

export interface MailState {
  /** accounts / folders / settings are loaded once (the section can render). */
  loaded: boolean;
  engineDown: boolean;
  accounts: Record<string, MailAccount>;
  accountIds: string[];
  /** Complete folder lists per account (the `folders` event replaces one). */
  folders: Record<string, MailFolder[]>;
  /** Folder id → folder, every account. */
  folderById: Record<string, MailFolder>;
  settings: MailSettings;
  box: MailBox;
  unreadOnly: boolean;
  /** The active search ('' = the mailbox list). */
  query: string;
  rows: Record<string, MailThreadRow>;
  order: string[];
  next: MailCursor | null;
  listState: ListState;
  listError: MailErrorCode | null;
  /** «Загрузить более ранние»: running / nothing older on the server. */
  older: 'idle' | 'loading' | 'exhausted';
  selected: string | null;
  thread: ThreadView | null;
  /** Headers of the open thread's messages. */
  headers: Record<string, MailHeader>;
  /** Bodies of the open thread (dropped with it). */
  bodies: Record<string, MailMessage>;
  bodyState: Record<string, 'loading' | 'error'>;
  /** The expanded message of the open thread (the only one with an iframe, §9). */
  openId: string | null;
  /** Messages whose remote images were allowed this session («Показать»). */
  remoteAllowed: Record<string, true>;
  outgoing: Record<string, MailOutgoing>;
  drafts: MailDraft[];
}

const initial = (): MailState => ({
  loaded: false,
  engineDown: false,
  accounts: {},
  accountIds: [],
  folders: {},
  folderById: {},
  settings: DEFAULT_MAIL_SETTINGS,
  box: ALL_INBOXES,
  unreadOnly: false,
  query: '',
  rows: {},
  order: [],
  next: null,
  listState: 'idle',
  listError: null,
  older: 'idle',
  selected: null,
  thread: null,
  headers: {},
  bodies: {},
  bodyState: {},
  openId: null,
  remoteAllowed: {},
  outgoing: {},
  drafts: [],
});

export const useMail = create<MailState>()(() => initial());

// ---------------------------------------------------------------- pure helpers (unit-tested)

/** List order: newest first, then message id desc (the contract's cursor order). */
export function cmpRows(a: MailThreadRow, b: MailThreadRow): number {
  if (a.date !== b.date) return b.date - a.date;
  return a.messageId < b.messageId ? 1 : a.messageId > b.messageId ? -1 : 0;
}

/** The folder of a box when it names one folder (an id, or a role within one account). */
export function boxFolder(s: Pick<MailState, 'folders' | 'folderById'>, box: MailBox): MailFolder | null {
  if (typeof box.folder !== 'string') return s.folderById[box.folder.id] ?? null;
  if (box.scope === 'all') return null;
  const role = box.folder;
  return s.folders[box.scope]?.find((f) => f.role === role) ?? null;
}

/** The role a box lists (a folder id resolves to its folder's role). */
export function boxRole(s: Pick<MailState, 'folderById'>, box: MailBox): MailFolderRole | null {
  return typeof box.folder === 'string' ? box.folder : (s.folderById[box.folder.id]?.role ?? null);
}

/** Does a row belong to the box on screen? */
export function inBox(s: Pick<MailState, 'folderById'>, box: MailBox, row: MailThreadRow): boolean {
  if (typeof box.folder !== 'string') return row.folderId === box.folder.id;
  if (box.scope !== 'all' && row.accountId !== box.scope) return false;
  return s.folderById[row.folderId]?.role === box.folder;
}

export const boxEquals = (a: MailBox, b: MailBox): boolean =>
  a.scope === b.scope && (typeof a.folder === 'string' ? a.folder === b.folder : typeof b.folder !== 'string' && a.folder.id === b.folder.id);

/** The rail badge: unread in the inboxes of every account (a number — one primitive selector). */
export function inboxUnread(s: Pick<MailState, 'folders'>): number {
  let n = 0;
  for (const id in s.folders) for (const f of s.folders[id] ?? []) if (f.role === 'inbox') n += f.unread;
  return n;
}

/** Unread of a box (the switcher's counters): a folder's own, or the role summed for «Все …». */
export function boxUnread(s: Pick<MailState, 'folders' | 'folderById'>, box: MailBox): number {
  const f = boxFolder(s, box);
  if (f) return f.unread;
  if (typeof box.folder !== 'string') return 0;
  let n = 0;
  for (const id in s.folders) for (const x of s.folders[id] ?? []) if (x.role === box.folder) n += x.unread;
  return n;
}

/**
 * Inserts / moves `row` into `order` (sorted by cmpRows) when it falls inside the loaded range:
 * above the last loaded row, or anywhere once the list is complete (`next === null`).
 * Returns the same array when nothing changes.
 */
export function placeRow(order: string[], rows: Record<string, MailThreadRow>, row: MailThreadRow, complete: boolean): string[] {
  const key = rowKey(row);
  const at = order.indexOf(key);
  const without = at >= 0 ? [...order.slice(0, at), ...order.slice(at + 1)] : order;
  const last = without.length ? rows[without[without.length - 1] ?? ''] : undefined;
  if (!complete && last && cmpRows(row, last) > 0) return at >= 0 ? without : order;
  let lo = 0;
  let hi = without.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const m = rows[without[mid] ?? ''];
    if (m && cmpRows(m, row) <= 0) lo = mid + 1;
    else hi = mid;
  }
  if (at === lo) return order;
  return [...without.slice(0, lo), key, ...without.slice(lo)];
}

function indexFolders(folders: Record<string, MailFolder[]>): Record<string, MailFolder> {
  const out: Record<string, MailFolder> = {};
  for (const id in folders) for (const f of folders[id] ?? []) out[f.id] = f;
  return out;
}

const sameRow = (a: MailThreadRow | undefined, b: MailThreadRow): boolean =>
  !!a &&
  a.messageId === b.messageId &&
  a.date === b.date &&
  a.unread === b.unread &&
  a.flagged === b.flagged &&
  a.count === b.count &&
  a.subject === b.subject &&
  a.snippet === b.snippet &&
  a.hasAttachments === b.hasAttachments &&
  a.from.address === b.from.address &&
  a.from.name === b.from.name;

/**
 * Applies a row upsert event to the list. Rows outside the box are ignored; a search keeps its
 * hits (only existing rows are patched). An identical row keeps its object (no re-render).
 */
export function applyRows(s: MailState, rows: MailThreadRow[], insert: boolean): Partial<MailState> | null {
  let map = s.rows;
  let order = s.order;
  for (const row of rows) {
    const key = rowKey(row);
    const had = map[key];
    if (!had && (s.query || !insert || !inBox(s, s.box, row))) continue;
    if (!had && s.unreadOnly && !row.unread) continue;
    if (sameRow(had, row)) continue;
    if (map === s.rows) map = { ...s.rows };
    map[key] = row;
    if (!had || had.date !== row.date || had.messageId !== row.messageId) order = placeRow(order, map, row, s.next === null);
    if (!order.includes(key)) delete map[key];
  }
  if (map === s.rows && order === s.order) return null;
  return { rows: map, order };
}

/** A pure reducer of the list / account parts of an engine event (the thread refresh is separate). */
export function reduceEvent(s: MailState, e: MailEvent): Partial<MailState> | null {
  switch (e.type) {
    case 'account_state': {
      if (e.account) {
        const accountIds = s.accountIds.includes(e.accountId) ? s.accountIds : [...s.accountIds, e.accountId];
        return { accounts: { ...s.accounts, [e.accountId]: e.account }, accountIds };
      }
      if (!s.accounts[e.accountId]) return null;
      const accounts = { ...s.accounts };
      delete accounts[e.accountId];
      const folders = { ...s.folders };
      delete folders[e.accountId];
      const rows: Record<string, MailThreadRow> = {};
      for (const k of s.order) {
        const r = s.rows[k];
        if (r && r.accountId !== e.accountId) rows[k] = r;
      }
      const outgoing = Object.fromEntries(Object.entries(s.outgoing).filter(([, o]) => o.accountId !== e.accountId));
      const boxGone = s.box.scope === e.accountId;
      const threadGone = s.thread && s.headers[s.thread.ids[0] ?? '']?.accountId === e.accountId;
      return {
        accounts,
        accountIds: s.accountIds.filter((x) => x !== e.accountId),
        folders,
        folderById: indexFolders(folders),
        rows,
        order: s.order.filter((k) => rows[k]),
        outgoing,
        ...(boxGone ? { box: ALL_INBOXES } : {}),
        ...(s.selected && !rows[s.selected] ? { selected: null } : {}),
        ...(threadGone ? { thread: null, headers: {}, bodies: {}, bodyState: {}, openId: null } : {}),
      };
    }
    case 'folders': {
      const folders = { ...s.folders, [e.accountId]: e.folders };
      return { folders, folderById: indexFolders(folders) };
    }
    case 'messages_added':
      return applyRows(s, e.rows, true);
    case 'messages_changed':
      return applyRows(s, e.rows, true);
    case 'messages_removed': {
      const gone = new Set(e.threadIds.map((t) => rowKey({ threadId: t, folderId: e.folderId })));
      if (!s.order.some((k) => gone.has(k))) return null;
      const rows = { ...s.rows };
      for (const k of gone) delete rows[k];
      return { rows, order: s.order.filter((k) => !gone.has(k)) };
    }
    case 'outgoing': {
      if (e.removed) {
        if (!s.outgoing[e.item.id]) return null;
        const outgoing = { ...s.outgoing };
        delete outgoing[e.item.id];
        return { outgoing };
      }
      return { outgoing: { ...s.outgoing, [e.item.id]: e.item } };
    }
    case 'engine':
      return { engineDown: e.state === 'down' };
    case 'new_mail':
      return null;
  }
}

// ---------------------------------------------------------------- the controller

let api: MailApi | null = null;
let unsubscribe: (() => void) | null = null;
let listSeq = 0;
let threadSeq = 0;
const listeners = new Set<(e: MailEvent) => void>();

/** Extra event listeners (notifications): called after the store applied the event. */
export function onMailEvent(cb: (e: MailEvent) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function mailApi(): MailApi | null {
  return api;
}

const errCode = (e: unknown): MailErrorCode => (isMailError(e) ? e.code : 'ENGINE_DOWN');

/** Mail errors for the toasts; `code` from the contract, the text the UI's own (i18n). */
let reportError: (code: MailErrorCode, what: 'flags' | 'move' | 'load' | 'send' | 'generic') => void = () => undefined;
export function setMailErrorReporter(fn: typeof reportError): void {
  reportError = fn;
}

/**
 * Binds the store to the API and subscribes to its events — once per page (idempotent). Loads
 * accounts, folders, settings and the outgoing queue, then the selected mailbox.
 */
export function initMail(a: MailApi): Promise<void> {
  if (api === a && unsubscribe) return Promise.resolve();
  unsubscribe?.();
  api = a;
  unsubscribe = a.onEvent(handleEvent);
  return reloadAll();
}

/** Tests: forget the API and the state. */
export function resetMail(): void {
  unsubscribe?.();
  unsubscribe = null;
  api = null;
  listeners.clear();
  useMail.setState(initial(), true);
}

async function reloadAll(): Promise<void> {
  const a = api;
  if (!a) return;
  try {
    const [accounts, settings, outgoing] = await Promise.all([a.accounts.list(), a.settings.get(), a.outgoing.list()]);
    const lists = await Promise.all(accounts.map((x) => a.folders.list(x.id).catch(() => [] as MailFolder[])));
    const folders: Record<string, MailFolder[]> = {};
    accounts.forEach((x, i) => (folders[x.id] = lists[i] ?? []));
    const s = useMail.getState();
    const box = s.box.scope === 'all' || accounts.some((x) => x.id === s.box.scope) ? s.box : ALL_INBOXES;
    useMail.setState({
      loaded: true,
      engineDown: false,
      accounts: Object.fromEntries(accounts.map((x) => [x.id, x])),
      accountIds: accounts.map((x) => x.id),
      folders,
      folderById: indexFolders(folders),
      settings,
      outgoing: Object.fromEntries(outgoing.map((o) => [o.id, o])),
      box,
    });
  } catch (e) {
    useMail.setState({ loaded: true, engineDown: errCode(e) === 'ENGINE_DOWN' });
    return;
  }
  await reloadList();
  const th = useMail.getState().thread;
  if (th) void refreshThread();
}

function handleEvent(e: MailEvent): void {
  const s = useMail.getState();
  const patch = reduceEvent(s, e);
  if (patch) useMail.setState(patch);
  if (e.type === 'engine' && e.state === 'up') void reloadAll();
  if (e.type === 'messages_added' || e.type === 'messages_changed' || e.type === 'messages_removed') {
    const th = useMail.getState().thread;
    if (th && th.state !== 'loading') {
      const touched = e.messageIds.some((id) => th.ids.includes(id)) || (e.type === 'messages_removed' ? e.threadIds : e.rows.map((r) => r.threadId)).includes(th.threadId);
      if (touched) void refreshThread();
    }
  }
  if (e.type === 'folders' || e.type === 'account_state') {
    // Drafts are local (§6): their folder's counter moves when one is saved / removed.
    const role = boxRole(useMail.getState(), useMail.getState().box);
    if (role === 'drafts' && e.type === 'folders') void loadDrafts();
  }
  for (const l of listeners) l(e);
}

// ---------------------------------------------------------------- list

/** Switches the mailbox (clears the search and the selection). */
export function selectBox(box: MailBox): void {
  const s = useMail.getState();
  if (boxEquals(s.box, box) && !s.query) return;
  useMail.setState({ box, query: '', selected: null, older: 'idle' });
  void reloadList();
}

export function setUnreadOnly(on: boolean): void {
  if (useMail.getState().unreadOnly === on) return;
  useMail.setState({ unreadOnly: on, selected: null });
  void reloadList();
}

/** The search field (already debounced by the view); '' returns to the mailbox. */
export function setQuery(text: string): void {
  const query = text.trim();
  if (useMail.getState().query === query) return;
  useMail.setState({ query, selected: null });
  void reloadList();
}

function fetchPage(before: MailCursor | undefined): Promise<MailPage> {
  const a = api;
  if (!a) return Promise.resolve({ rows: [], next: null });
  const s = useMail.getState();
  if (s.query) {
    return a.search({ text: s.query, scope: s.box.scope, limit: PAGE_SIZE, ...(before ? { before } : {}) });
  }
  const role = boxRole(s, s.box);
  // Local drafts and the outgoing queue are not thread rows (§6): their own lists.
  if (role === 'drafts' || role === 'outbox') return Promise.resolve({ rows: [], next: null });
  return a.messages.list({ scope: s.box.scope, folder: s.box.folder, limit: PAGE_SIZE, ...(before ? { before } : {}), ...(s.unreadOnly ? { unreadOnly: true } : {}) });
}

function pageState(rows: MailThreadRow[]): { rows: Record<string, MailThreadRow>; order: string[] } {
  const map: Record<string, MailThreadRow> = {};
  const order: string[] = [];
  for (const r of rows) {
    const k = rowKey(r);
    if (map[k]) continue;
    map[k] = r;
    order.push(k);
  }
  return { rows: map, order };
}

/** Reloads the first page of the mailbox / search on screen. */
export async function reloadList(): Promise<void> {
  const seq = ++listSeq;
  useMail.setState({ listState: 'loading', listError: null });
  if (boxRole(useMail.getState(), useMail.getState().box) === 'drafts' && !useMail.getState().query) void loadDrafts();
  try {
    const page = await fetchPage(undefined);
    if (seq !== listSeq) return;
    useMail.setState({ ...pageState(page.rows), next: page.next, listState: 'idle' });
  } catch (e) {
    if (seq !== listSeq) return;
    useMail.setState({ rows: {}, order: [], next: null, listState: 'error', listError: errCode(e) });
  }
}

/** The next page at the end of the list (Virtuoso endReached). */
export async function loadMore(): Promise<void> {
  const s = useMail.getState();
  if (!s.next || s.listState === 'loading') return;
  const seq = listSeq;
  useMail.setState({ listState: 'loading' });
  try {
    const page = await fetchPage(s.next);
    if (seq !== listSeq) return;
    const cur = useMail.getState();
    const rows = { ...cur.rows };
    const order = [...cur.order];
    for (const r of page.rows) {
      const k = rowKey(r);
      if (rows[k]) continue;
      rows[k] = r;
      order.push(k);
    }
    useMail.setState({ rows, order, next: page.next, listState: 'idle' });
  } catch (e) {
    if (seq === listSeq) useMail.setState({ listState: 'error', listError: errCode(e) });
  }
}

/** «Загрузить более ранние» (§3): the engine syncs 90 more days of the box's folder(s); rows arrive as events. */
export async function loadOlder(): Promise<void> {
  const a = api;
  const s = useMail.getState();
  if (!a || s.older === 'loading') return;
  const one = boxFolder(s, s.box);
  const role = boxRole(s, s.box);
  const ids = one ? [one.id] : s.accountIds.map((acc) => s.folders[acc]?.find((f) => f.role === role)?.id).filter((x): x is string => !!x);
  if (!ids.length) return;
  useMail.setState({ older: 'loading' });
  try {
    const res = await Promise.all(ids.map((id) => a.messages.loadOlder(id)));
    useMail.setState({ older: res.every((r) => r.exhausted) ? 'exhausted' : 'idle' });
  } catch (e) {
    useMail.setState({ older: 'idle' });
    reportError(errCode(e), 'load');
  }
}

export async function loadDrafts(): Promise<void> {
  const a = api;
  if (!a) return;
  const s = useMail.getState();
  try {
    const list = await a.drafts.list(s.box.scope === 'all' ? undefined : s.box.scope);
    useMail.setState({ drafts: list });
  } catch (e) {
    reportError(errCode(e), 'load');
  }
}

// ---------------------------------------------------------------- the thread

/** Opens a list row: its thread, the row's message expanded. */
export function openRow(key: string): void {
  const row = useMail.getState().rows[key];
  if (!row) return;
  useMail.setState({ selected: key });
  void openThread(row.threadId, row.messageId, key);
}

/** Opens a thread (a row, a notification); `messageId` is expanded. */
export async function openThread(threadId: string, messageId: string, fromRow: string | null = null): Promise<void> {
  const a = api;
  if (!a) return;
  const seq = ++threadSeq;
  const same = useMail.getState().thread?.threadId === threadId;
  useMail.setState({
    thread: { threadId, rowKey: fromRow, ids: same ? (useMail.getState().thread?.ids ?? []) : [], state: 'loading' },
    openId: messageId,
    ...(same ? {} : { headers: {}, bodies: {}, bodyState: {} }),
  });
  void loadBody(messageId);
  try {
    const list = await a.messages.thread(threadId);
    if (seq !== threadSeq) return;
    setThreadHeaders(threadId, list, fromRow);
  } catch {
    if (seq === threadSeq) useMail.setState((s) => (s.thread ? { thread: { ...s.thread, state: 'error' } } : {}));
  }
}

function setThreadHeaders(threadId: string, list: MailHeader[], fromRow: string | null): void {
  const s = useMail.getState();
  const headers: Record<string, MailHeader> = {};
  for (const h of list) {
    const old = s.headers[h.id];
    // Keep the object when nothing changed (the message header rows are memo'd by it).
    headers[h.id] = old && sameHeader(old, h) ? old : h;
  }
  const ids = list.map((h) => h.id);
  const openId = s.openId && headers[s.openId] ? s.openId : (ids[ids.length - 1] ?? null);
  const bodies: Record<string, MailMessage> = {};
  for (const id of ids) {
    const b = s.bodies[id];
    if (b) bodies[id] = b;
  }
  useMail.setState({
    thread: { threadId, rowKey: fromRow ?? s.thread?.rowKey ?? null, ids: sameIds(s.thread?.ids, ids) ? (s.thread?.ids ?? ids) : ids, state: 'ready' },
    headers,
    bodies,
    openId,
  });
  if (openId && !bodies[openId]) void loadBody(openId);
}

const sameIds = (a: string[] | undefined, b: string[]): boolean => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
const sameHeader = (a: MailHeader, b: MailHeader): boolean =>
  a.flags.seen === b.flags.seen && a.flags.flagged === b.flags.flagged && a.flags.answered === b.flags.answered && a.folderId === b.folderId && a.subject === b.subject;

/** Re-reads the open thread's headers (an event touched it). */
export async function refreshThread(): Promise<void> {
  const a = api;
  const th = useMail.getState().thread;
  if (!a || !th) return;
  const seq = ++threadSeq;
  try {
    const list = await a.messages.thread(th.threadId);
    if (seq !== threadSeq || useMail.getState().thread?.threadId !== th.threadId) return;
    setThreadHeaders(th.threadId, list, null);
  } catch {
    // The thread is gone (deleted / moved away entirely): close it.
    if (seq === threadSeq && useMail.getState().thread?.threadId === th.threadId) useMail.setState({ thread: null, headers: {}, bodies: {}, bodyState: {}, openId: null });
  }
}

export function closeThread(): void {
  threadSeq++;
  useMail.setState({ thread: null, headers: {}, bodies: {}, bodyState: {}, openId: null, selected: null });
}

/** Expands a message of the open thread (collapses the previous one: one iframe at a time, §9). */
export function expandMessage(id: string): void {
  if (useMail.getState().openId === id) return;
  useMail.setState({ openId: id });
  void loadBody(id);
}

export async function loadBody(id: string): Promise<void> {
  const a = api;
  const s = useMail.getState();
  if (!a || s.bodies[id] || s.bodyState[id] === 'loading') return;
  useMail.setState({ bodyState: { ...s.bodyState, [id]: 'loading' } });
  try {
    const m = await a.messages.get(id);
    const cur = useMail.getState();
    const bodyState = { ...cur.bodyState };
    delete bodyState[id];
    if (!cur.thread) useMail.setState({ bodyState });
    else useMail.setState({ bodies: { ...cur.bodies, [id]: m }, bodyState });
  } catch {
    useMail.setState((cur) => ({ bodyState: { ...cur.bodyState, [id]: 'error' } }));
  }
}

export function allowRemote(messageId: string): void {
  useMail.setState((s) => (s.remoteAllowed[messageId] ? {} : { remoteAllowed: { ...s.remoteAllowed, [messageId]: true } }));
}

// ---------------------------------------------------------------- actions (optimistic, §5)

const rowSel = (rows: MailThreadRow[]): MailSelection => ({ threads: rows.map((r) => ({ threadId: r.threadId, folderId: r.folderId })) });

function patchRowFlags(r: MailThreadRow, patch: MailFlagPatch): MailThreadRow {
  return { ...r, unread: patch.seen === undefined ? r.unread : !patch.seen, flagged: patch.flagged ?? r.flagged };
}

function patchHeader(h: MailHeader, patch: MailFlagPatch): MailHeader {
  return { ...h, flags: { ...h.flags, seen: patch.seen ?? h.flags.seen, flagged: patch.flagged ?? h.flags.flagged } };
}

/**
 * Flags on list rows (whole threads in their folders), applied at once and rolled back if the
 * engine refuses (§5). The open thread's headers of those rows follow.
 */
export async function setRowFlags(keys: string[], patch: MailFlagPatch): Promise<void> {
  const a = api;
  const s = useMail.getState();
  const before = keys.map((k) => s.rows[k]).filter((r): r is MailThreadRow => !!r);
  if (!a || !before.length) return;
  const rows = { ...s.rows };
  const after: MailThreadRow[] = [];
  for (const r of before) {
    const next = patchRowFlags(r, patch);
    rows[rowKey(r)] = next;
    after.push(next);
  }
  const th = s.thread;
  const headerPatch: Record<string, MailHeader> = {};
  if (th) {
    for (const id of th.ids) {
      const h = s.headers[id];
      if (h && before.some((r) => r.threadId === h.threadId && r.folderId === h.folderId)) headerPatch[id] = patchHeader(h, patch);
    }
  }
  useMail.setState({ rows, ...(Object.keys(headerPatch).length ? { headers: { ...s.headers, ...headerPatch } } : {}) });
  try {
    await a.messages.setFlags(rowSel(before), patch);
  } catch (e) {
    // Roll back only the rows still as we left them (an event may have moved on since).
    const cur = useMail.getState();
    const back = { ...cur.rows };
    let changed = false;
    for (let i = 0; i < after.length; i++) {
      const r = after[i];
      const orig = before[i];
      if (!r || !orig || cur.rows[rowKey(r)] !== r) continue;
      back[rowKey(r)] = orig;
      changed = true;
    }
    const headers = { ...cur.headers };
    for (const [id, patched] of Object.entries(headerPatch)) {
      const orig = s.headers[id];
      if (orig && cur.headers[id] === patched) headers[id] = orig;
    }
    useMail.setState({ ...(changed ? { rows: back } : {}), headers });
    reportError(errCode(e), 'flags');
  }
}

/** Flags on messages of the open thread (the action bar), the list row of that thread follows. */
export async function setMessageFlags(ids: string[], patch: MailFlagPatch): Promise<void> {
  const a = api;
  const s = useMail.getState();
  if (!a || !ids.length) return;
  const prev: Record<string, MailHeader> = {};
  const headers = { ...s.headers };
  for (const id of ids) {
    const h = s.headers[id];
    if (!h) continue;
    prev[id] = h;
    headers[id] = patchHeader(h, patch);
  }
  // The row of the thread in this folder: unread / flagged as its messages now are.
  const rows = { ...s.rows };
  const rowPrev: Record<string, MailThreadRow> = {};
  for (const h of Object.values(prev)) {
    const k = rowKey(h);
    const r = s.rows[k];
    if (!r || rowPrev[k]) continue;
    const inRow = (s.thread?.ids ?? []).map((id) => headers[id]).filter((x): x is MailHeader => !!x && x.folderId === h.folderId);
    rowPrev[k] = r;
    rows[k] = { ...r, unread: inRow.some((x) => !x.flags.seen), flagged: inRow.some((x) => x.flags.flagged) };
  }
  useMail.setState({ headers, rows });
  try {
    await a.messages.setFlags({ messageIds: ids }, patch);
  } catch (e) {
    const cur = useMail.getState();
    const hs = { ...cur.headers };
    for (const id in prev) if (cur.headers[id] === headers[id] && prev[id]) hs[id] = prev[id];
    const rs = { ...cur.rows };
    for (const k in rowPrev) if (cur.rows[k] === rows[k] && rowPrev[k]) rs[k] = rowPrev[k];
    useMail.setState({ headers: hs, rows: rs });
    reportError(errCode(e), 'flags');
  }
}

export type MoveOp = { kind: 'archive' } | { kind: 'trash' } | { kind: 'move'; folderId: string };

/** The row after `key` in the list (else before): the selection after a move (Apple Mail). */
function neighbour(order: string[], gone: Set<string>, key: string | null): string | null {
  if (!key) return null;
  const at = order.indexOf(key);
  for (let i = at + 1; i < order.length; i++) if (!gone.has(order[i] ?? '')) return order[i] ?? null;
  for (let i = at - 1; i >= 0; i--) if (!gone.has(order[i] ?? '')) return order[i] ?? null;
  return null;
}

/**
 * Archive / trash / move list rows: they leave the list at once (the selection goes to the next
 * row) and come back in place if the engine refuses.
 */
export async function moveRows(keys: string[], op: MoveOp): Promise<void> {
  const a = api;
  const s = useMail.getState();
  const rows = keys.map((k) => s.rows[k]).filter((r): r is MailThreadRow => !!r);
  if (!a || !rows.length) return;
  const gone = new Set(keys);
  const selectedGone = s.selected !== null && gone.has(s.selected);
  const next = selectedGone ? neighbour(s.order, gone, s.selected) : s.selected;
  useMail.setState({ order: s.order.filter((k) => !gone.has(k)), selected: next });
  if (selectedGone) {
    if (next) openRow(next);
    else closeThread();
  }
  const sel = rowSel(rows);
  try {
    if (op.kind === 'archive') await a.messages.archive(sel);
    else if (op.kind === 'trash') await a.messages.trash(sel);
    else await a.messages.move(sel, op.folderId);
  } catch (e) {
    const cur = useMail.getState();
    let order = cur.order;
    const map = { ...cur.rows };
    for (const r of rows) {
      map[rowKey(r)] = r;
      order = placeRow(order, map, r, true);
    }
    useMail.setState({ rows: map, order });
    reportError(errCode(e), 'move');
  }
}

/** The same for messages of a thread opened without a row (a notification). */
export async function moveMessages(ids: string[], op: MoveOp): Promise<void> {
  const a = api;
  if (!a || !ids.length) return;
  const sel: MailSelection = { messageIds: ids };
  try {
    if (op.kind === 'archive') await a.messages.archive(sel);
    else if (op.kind === 'trash') await a.messages.trash(sel);
    else await a.messages.move(sel, op.folderId);
  } catch (e) {
    reportError(errCode(e), 'move');
  }
}

// ---------------------------------------------------------------- settings

export async function updateSettings(patch: Partial<MailSettings>): Promise<void> {
  const a = api;
  if (!a) return;
  const prev = useMail.getState().settings;
  useMail.setState({ settings: { ...prev, ...patch } });
  try {
    useMail.setState({ settings: await a.settings.set(patch) });
  } catch (e) {
    useMail.setState({ settings: prev });
    reportError(errCode(e), 'generic');
  }
}

// ---------------------------------------------------------------- selectors

/** Addresses seen in the rows on screen (the composer's autocomplete), unique by address. */
export function seenAddresses(s: Pick<MailState, 'rows' | 'order' | 'headers'>): Array<{ name: string; address: string }> {
  const out = new Map<string, { name: string; address: string }>();
  const add = (a: { name: string; address: string }): void => {
    const k = a.address.toLowerCase();
    if (!k || out.has(k)) return;
    out.set(k, { name: a.name, address: k });
  };
  for (const k of s.order) {
    const r = s.rows[k];
    if (r) add(r.from);
  }
  for (const id in s.headers) {
    const h = s.headers[id];
    if (!h) continue;
    add(h.from);
    for (const x of [...h.to, ...h.cc]) add(x);
  }
  return [...out.values()];
}

/** The outgoing items of the box's scope, oldest first (the «Исходящие» list). */
export function outgoingOf(s: Pick<MailState, 'outgoing' | 'box'>): MailOutgoing[] {
  return Object.values(s.outgoing)
    .filter((o) => o.state !== 'sent' && (s.box.scope === 'all' || o.accountId === s.box.scope))
    .sort((a, b) => a.createdAt - b.createdAt);
}
