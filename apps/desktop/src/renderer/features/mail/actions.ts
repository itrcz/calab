import { moveMessages, moveRows, openRow, setMessageFlags, setRowFlags, useMail, type MoveOp } from '../../stores/mail';
import { useMailUi } from '../../stores/mailUi';

/**
 * The thread actions shared by the action bar and the hotkeys (ADR-0088 §8). Reply / flags /
 * read state act on the open message; archive, trash and move act on the selected list row (the
 * thread in that folder, as Apple Mail's conversation view), or on the open message when the
 * thread was opened without a row (a notification).
 */

export function replyOpen(kind: 'reply' | 'replyAll' | 'forward'): void {
  const id = useMail.getState().openId;
  if (id) useMailUi.getState().openCompose({ kind, messageId: id });
}

export function composeNew(): void {
  const s = useMail.getState();
  const accountId = s.box.scope !== 'all' ? s.box.scope : undefined;
  useMailUi.getState().openCompose({ kind: 'new', ...(accountId ? { accountId } : {}) });
}

/** Moves the thread on screen: the row (selection follows), else the open message. */
export function moveOpen(op: MoveOp): void {
  const s = useMail.getState();
  const key = s.thread?.rowKey ?? s.selected;
  if (key && s.rows[key]) {
    void moveRows([key], op);
    return;
  }
  if (s.openId) void moveMessages([s.openId], op);
}

/** ⌘⌫ / Delete in the list: the selected row to the trash. */
export function trashSelected(): void {
  const s = useMail.getState();
  if (s.selected && s.rows[s.selected]) void moveRows([s.selected], { kind: 'trash' });
  else if (s.openId) void moveMessages([s.openId], { kind: 'trash' });
}

/** Marks the open message, the next auto-read must not undo it (see `noteManualRead`). */
export function toggleOpenRead(): void {
  const s = useMail.getState();
  const id = s.openId;
  const h = id ? s.headers[id] : undefined;
  if (h && id) {
    noteManualRead(id);
    void setMessageFlags([id], { seen: !h.flags.seen });
    return;
  }
  const row = s.selected ? s.rows[s.selected] : undefined;
  if (row && s.selected) void setRowFlags([s.selected], { seen: row.unread });
}

export function toggleOpenFlag(): void {
  const s = useMail.getState();
  const id = s.openId;
  const h = id ? s.headers[id] : undefined;
  if (h && id) {
    void setMessageFlags([id], { flagged: !h.flags.flagged });
    return;
  }
  const row = s.selected ? s.rows[s.selected] : undefined;
  if (row && s.selected) void setRowFlags([s.selected], { flagged: !row.flagged });
}

/** ↑ / ↓ in the list (Apple Mail): the neighbour row opens. */
export function stepSelection(dir: -1 | 1): void {
  const s = useMail.getState();
  if (!s.order.length) return;
  const at = s.selected ? s.order.indexOf(s.selected) : -1;
  const next = s.order[at < 0 ? (dir > 0 ? 0 : s.order.length - 1) : Math.max(0, Math.min(s.order.length - 1, at + dir))];
  if (next && next !== s.selected) openRow(next);
}

// The message opened is marked read after 1 s (§8) — once: a «Не прочитано» right after opening
// must stick, so the auto-read remembers which message it already handled.
let handled: string | null = null;
export function noteManualRead(id: string): void {
  handled = id;
}
export function autoReadDue(id: string): boolean {
  return handled !== id;
}

const MAC = typeof navigator !== 'undefined' && /Mac OS X|Macintosh/.test(navigator.userAgent);
const combo = (key: string, shift = false): string => (MAC ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`);

/** The hotkeys' labels for tooltips (⌘ on macOS, Ctrl elsewhere). */
export const MAIL_KEYS = {
  reply: combo('R'),
  replyAll: combo('R', true),
  forward: combo('F', true),
  trash: MAC ? '⌘⌫' : 'Delete',
  unread: combo('U', true),
  send: MAC ? '⌘↩' : 'Ctrl+Enter',
} as const;
