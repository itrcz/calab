import type { Message, Room, TaskNoticeEntry } from '@calaba/protocol';
import { isDm } from './dms';
import { idAfter } from './rooms';

/**
 * «Read» for the mentions inbox is derived from the per-room read marker the client already
 * keeps (READY read_states, READ_STATE_UPDATE, own reads): a mention is unread while its
 * message id is after the room's marker. No extra server state.
 */
interface InboxSlice {
  items: ReadonlyArray<{ id: string; roomId: string }>;
  loaded: boolean;
  hasMore: boolean;
}

/** Inbox items (newest first) of known non-DM rooms still after the room's read marker. */
export function unreadInboxItems<T extends { id: string; roomId: string }>(
  items: ReadonlyArray<T>,
  readState: Record<string, string>,
  known: (roomId: string) => boolean = () => true,
): T[] {
  return items.filter((m) => known(m.roomId) && idAfter(m.id, readState[m.roomId]));
}

/**
 * Title bar badge. Per room the loaded history is exact when it reaches back to the room's
 * read marker (or the whole history is loaded); otherwise older unread mentions may exist
 * that are not loaded, so the server-counted `mentions` (READY, kept live) is the floor.
 * DMs are never in the inbox (ADR-0020).
 */
export function inboxBadgeCount(
  inbox: InboxSlice,
  readState: Record<string, string>,
  mentions: Record<string, number>,
  byId: Record<string, Room>,
): number {
  const known = (id: string): boolean => !!byId[id] && !isDm(byId[id]);
  const perRoom: Record<string, number> = {};
  if (inbox.loaded) for (const m of unreadInboxItems(inbox.items, readState, known)) perRoom[m.roomId] = (perRoom[m.roomId] ?? 0) + 1;
  const oldest = inbox.items.at(-1)?.id;
  let total = 0;
  const rooms = new Set([...Object.keys(perRoom), ...Object.keys(mentions)]);
  for (const id of rooms) {
    if (!known(id)) continue;
    const fromItems = perRoom[id] ?? 0;
    const marker = readState[id];
    const covered = inbox.loaded && (!inbox.hasMore || (oldest !== undefined && !!marker && oldest <= marker));
    total += covered ? fromItems : Math.max(fromItems, mentions[id] ?? 0);
  }
  return total;
}

/** A row of the inbox (ADR-0141): a chat mention or a task notice; `latest`: the newest notice of its task. */
export interface InboxRow {
  id: string;
  m?: Message;
  e?: TaskNoticeEntry;
  latest: boolean;
}

/**
 * Mentions and task notices in one list, newest first: both ids are uuidv7, so they interleave by
 * id. Each task's newest notice is `latest` (only it shows the task's unread mark).
 */
export function inboxRows(mentions: ReadonlyArray<Message>, notices: ReadonlyArray<TaskNoticeEntry>): InboxRow[] {
  const seen = new Set<string>();
  const rows: InboxRow[] = mentions.map((m) => ({ id: m.id, m, latest: false }));
  // Notices come newest first: the first one of a task is its newest.
  for (const e of notices) {
    rows.push({ id: e.id, e, latest: !seen.has(e.taskId) });
    seen.add(e.taskId);
  }
  return rows.sort((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
}

/**
 * Unread task notices for the title badge (bug #146): the tasks with a notice in the inbox that are
 * still unread (the boards' unread set: opening the task clears it), one per task like the row dot.
 */
export function unreadNoticeTasks(notices: ReadonlyArray<{ taskId: string }>, unread: Readonly<Record<string, string>>): number {
  const seen = new Set<string>();
  for (const e of notices) if (unread[e.taskId] !== undefined) seen.add(e.taskId);
  return seen.size;
}
