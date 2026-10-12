/**
 * Event coalescing (ADR-0088 §7): at most one event of a type per folder (per account for
 * `account_state` / `folders`, per item for `outgoing`) per 250 ms. The first event of a quiet key
 * goes out at once; what follows within the window is merged (rows by threadId, newest wins; id
 * lists united) and flushed when the window ends. Row upserts and removals of the same thread in
 * the same folder cancel out, so the renderer always ends in the engine's state.
 */
import type { MailEvent, MailThreadRow } from '../../shared/mail';

export const COALESCE_MS = 250;
/** `sync_progress`: at most 2 per second per account (3.1.2), the newest wins. */
export const PROGRESS_MS = 500;

type RowEvent = Extract<MailEvent, { type: 'messages_added' | 'messages_changed' }>;

function keyOf(e: MailEvent): string | null {
  switch (e.type) {
    case 'account_state':
      return `as:${e.accountId}`;
    case 'folders':
      return `f:${e.accountId}`;
    case 'messages_added':
      return `ma:${e.folderId}`;
    case 'messages_changed':
      return `mc:${e.folderId}`;
    case 'messages_removed':
      return `mr:${e.folderId}`;
    case 'outgoing':
      return `o:${e.item.id}`;
    case 'sync_progress':
      return `sp:${e.accountId}`;
    default:
      return null; // new_mail, engine, compose: never merged
  }
}

const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];

function mergeRows(a: MailThreadRow[], b: MailThreadRow[]): MailThreadRow[] {
  const m = new Map(a.map((r) => [r.threadId, r]));
  for (const r of b) m.set(r.threadId, r);
  return [...m.values()];
}

function merge(prev: MailEvent, next: MailEvent): MailEvent {
  if ((prev.type === 'messages_added' || prev.type === 'messages_changed') && prev.type === next.type) {
    return { ...prev, rows: mergeRows(prev.rows, next.rows), messageIds: union(prev.messageIds, next.messageIds) };
  }
  if (prev.type === 'messages_removed' && next.type === 'messages_removed') {
    return { ...prev, threadIds: union(prev.threadIds, next.threadIds), messageIds: union(prev.messageIds, next.messageIds) };
  }
  return next;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(t: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

export class EventCoalescer {
  /** Keys inside their window → the merged event waiting for the window end (null = none yet). */
  private readonly open = new Map<string, MailEvent | null>();

  constructor(
    private readonly send: (e: MailEvent) => void,
    private readonly windowMs = COALESCE_MS,
    private readonly timers: Timers = realTimers,
  ) {}

  emit(e: MailEvent): void {
    this.cancelOpposite(e);
    const key = keyOf(e);
    if (key === null) {
      this.send(e);
      return;
    }
    if (this.open.has(key)) {
      const prev = this.open.get(key) ?? null;
      this.open.set(key, prev ? merge(prev, e) : e);
      return;
    }
    this.send(e);
    this.openWindow(key);
  }

  private openWindow(key: string): void {
    this.open.set(key, null);
    const ms = key.startsWith('sp:') ? Math.max(this.windowMs, PROGRESS_MS) : this.windowMs;
    this.timers.set(() => {
      const pending = this.open.get(key) ?? null;
      this.open.delete(key);
      if (pending && !isEmpty(pending)) {
        this.send(pending);
        this.openWindow(key);
      }
    }, ms);
  }

  /**
   * Upserts drop the same threads from a pending removal of the folder, and vice versa. A new
   * account state drops the account's pending progress (it would land after the sync ended).
   */
  private cancelOpposite(e: MailEvent): void {
    if (e.type === 'account_state') {
      const k = `sp:${e.accountId}`;
      if (this.open.get(k)) this.open.set(k, null);
    } else if (e.type === 'messages_added' || e.type === 'messages_changed') {
      const k = `mr:${e.folderId}`;
      const p = this.open.get(k);
      if (p?.type === 'messages_removed') {
        const threads = new Set(e.rows.map((r) => r.threadId));
        this.open.set(k, { ...p, threadIds: p.threadIds.filter((t) => !threads.has(t)) });
      }
    } else if (e.type === 'messages_removed') {
      const gone = new Set(e.threadIds);
      for (const k of [`ma:${e.folderId}`, `mc:${e.folderId}`]) {
        const p = this.open.get(k) as RowEvent | null | undefined;
        if (p) this.open.set(k, { ...p, rows: p.rows.filter((r) => !gone.has(r.threadId)) });
      }
    }
  }
}

function isEmpty(e: MailEvent): boolean {
  if (e.type === 'messages_added' || e.type === 'messages_changed') return e.rows.length === 0 && e.messageIds.length === 0;
  if (e.type === 'messages_removed') return (e).threadIds.length === 0 && e.messageIds.length === 0;
  return false;
}
