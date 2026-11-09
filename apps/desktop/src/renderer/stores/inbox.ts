import type { Message, TaskNoticeEntry } from '@calaba/protocol';
import { create } from 'zustand';

/**
 * Mentions inbox (title bar «Упоминания», ADR-0141): chat mentions — history from
 * GET /api/me/mentions merged with the ones that arrive live over the gateway — and task notices —
 * GET /api/me/task-notices merged with the live TASK_UPDATE notices. Each list newest first,
 * unique by id (uuidv7: the two interleave by id).
 */
interface InboxState {
  items: Message[];
  /** Task notices (ADR-0141). */
  notices: TaskNoticeEntry[];
  /** History was fetched at least once (the first open shows a spinner until then). */
  loaded: boolean;
  loading: boolean;
  /** Older mention history exists on the server. */
  hasMore: boolean;
  /** Older task notices exist on the server. */
  noticesHasMore: boolean;
  /**
   * The next older page of task notices: the server's next_before — the last history row it
   * scanned, which may be a notice of a task hidden now (not listed), so not the last entry's id.
   */
  noticesCursor: string;
  setLoading: (v: boolean) => void;
  /** Merges a history page; `hasMore` only moves forward from the oldest page. */
  addPage: (list: Message[], hasMore: boolean, older: boolean) => void;
  /** Merges a page of task notices, like addPage; `cursor` is the page's next_before. */
  addNotices: (list: TaskNoticeEntry[], hasMore: boolean, older: boolean, cursor?: string) => void;
  addLive: (m: Message) => void;
  addLiveNotice: (e: TaskNoticeEntry) => void;
  /** Edit: keeps the new content, or drops the item when it no longer mentions me. */
  update: (m: Message, stillMentions: boolean) => void;
  remove: (messageId: string) => void;
  removeRooms: (keep: (roomId: string) => boolean) => void;
  /** A task gone for me (purged, or a scoped viewer lost it): its notices leave. */
  removeTask: (taskId: string) => void;
  /**
   * Ids (message or notice) dismissed with the ✕ (CBF-155, ADR-0163) on this device or another
   * (INBOX_DISMISS): they leave the lists and stay out of every later merge — a history page that
   * raced the dismissal, or an edit that mentions me again.
   */
  dismissed: ReadonlySet<string>;
  dismiss: (ids: readonly string[]) => void;
  /** The server refused a dismissal: the items come back (rollback of the optimistic removal). */
  undismiss: (items: Message[], notices: TaskNoticeEntry[]) => void;
  reset: () => void;
}

/** uuidv7 ids are time-ordered: newest first; dismissed ids never enter. */
const merge = <T extends { id: string }>(a: T[], b: T[], dismissed: ReadonlySet<string>): T[] => {
  const byId = new Map<string, T>();
  for (const m of [...a, ...b]) if (!dismissed.has(m.id)) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
};

const NONE: ReadonlySet<string> = new Set();

/** Kept in memory; older pages are fetched on demand. */
const MAX_ITEMS = 500;

export const useInbox = create<InboxState>()((set) => ({
  items: [],
  notices: [],
  loaded: false,
  loading: false,
  hasMore: false,
  noticesHasMore: false,
  noticesCursor: '',
  dismissed: NONE,
  setLoading: (loading) => set({ loading }),
  addPage: (list, hasMore, older) =>
    set((s) => ({ items: merge(s.items, list, s.dismissed).slice(0, MAX_ITEMS), loaded: true, hasMore: older || !s.loaded ? hasMore : s.hasMore })),
  addNotices: (list, hasMore, older, cursor) =>
    set((s) => {
      const notices = merge(s.notices, list, s.dismissed).slice(0, MAX_ITEMS);
      if (!older && s.loaded) return { notices };
      // An older server has no next_before: the oldest listed notice is the cursor then.
      const next = hasMore ? cursor || list.at(-1)?.id || '' : '';
      return { notices, noticesHasMore: hasMore && next !== '', noticesCursor: next };
    }),
  addLive: (m) => set((s) => (s.dismissed.has(m.id) ? {} : { items: merge([m], s.items, s.dismissed).slice(0, MAX_ITEMS) })),
  addLiveNotice: (e) => set((s) => (s.dismissed.has(e.id) ? {} : { notices: merge([e], s.notices, s.dismissed).slice(0, MAX_ITEMS) })),
  update: (m, still) =>
    set((s) => {
      if (s.dismissed.has(m.id)) return {};
      if (!s.items.some((x) => x.id === m.id)) return still ? { items: merge([m], s.items, s.dismissed) } : {};
      return { items: still ? s.items.map((x) => (x.id === m.id ? m : x)) : s.items.filter((x) => x.id !== m.id) };
    }),
  remove: (id) => set((s) => (s.items.some((x) => x.id === id) ? { items: s.items.filter((x) => x.id !== id) } : {})),
  removeRooms: (keep) => set((s) => ({ items: s.items.filter((m) => keep(m.roomId)) })),
  removeTask: (taskId) =>
    set((s) => (s.notices.some((e) => e.taskId === taskId) ? { notices: s.notices.filter((e) => e.taskId !== taskId) } : {})),
  dismiss: (ids) =>
    set((s) => {
      const fresh = ids.filter((id) => !s.dismissed.has(id));
      if (!fresh.length) return {};
      const dismissed = new Set([...s.dismissed, ...fresh]);
      const items = s.items.some((x) => dismissed.has(x.id)) ? s.items.filter((x) => !dismissed.has(x.id)) : s.items;
      const notices = s.notices.some((x) => dismissed.has(x.id)) ? s.notices.filter((x) => !dismissed.has(x.id)) : s.notices;
      return { dismissed, items, notices };
    }),
  undismiss: (items, notices) =>
    set((s) => {
      const dismissed = new Set(s.dismissed);
      for (const x of [...items, ...notices]) dismissed.delete(x.id);
      return {
        dismissed,
        items: merge(s.items, items, dismissed).slice(0, MAX_ITEMS),
        notices: merge(s.notices, notices, dismissed).slice(0, MAX_ITEMS),
      };
    }),
  reset: () =>
    set({ items: [], notices: [], loaded: false, loading: false, hasMore: false, noticesHasMore: false, noticesCursor: '', dismissed: NONE }),
}));
