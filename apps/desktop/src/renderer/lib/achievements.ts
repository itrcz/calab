import { timestampMs } from '@bufbuild/protobuf/wkt';
import { MessageKind, type Achievement, type AchievementCard, type MemberAchievement, type Message } from '@calaba/protocol';

/**
 * Achievements (ADR-0061, docs/08 «Ачивки»): the pure parts — the chat card of a system message,
 * «is this card addressed to me» (its author is the recipient, so the @-mention check misses it),
 * the «за что» rules, the profile stacks of repeated grants and the catalog lookups. No stores:
 * unit-tested.
 */

/** «За что»: 1..120 characters after trimming (the server says the same, 422 otherwise). */
export const NOTE_MAX = 120;

export const noteValid = (note: string): boolean => {
  const n = note.trim().length;
  return n >= 1 && n <= NOTE_MAX;
};

/** The achievement card of a system message, if it is one. */
export function achievementCardOf(m: Pick<Message, 'kind' | 'system'>): AchievementCard | null {
  if (m.kind !== MessageKind.SYSTEM) return null;
  const p = m.system?.payload;
  return p?.case === 'achievement' ? p.value : null;
}

/**
 * The card names me as the recipient (author = recipient, ADR-0061 §4): the server stores it as
 * a mention of me, so the client treats it as one (inbox, toast, unread mention). A forwarded
 * copy mentions nobody (ADR-0033).
 */
export function achievementForMe(m: { authorId: string; kind?: MessageKind; system?: Message['system']; forward?: unknown }, myId: string): boolean {
  if (!myId || m.forward || m.authorId !== myId || m.kind === undefined) return false;
  return achievementCardOf({ kind: m.kind, system: m.system }) !== null;
}

/** One grant as the viewer shows it (from the profile list or from a chat card). */
export interface GrantLine {
  id: string;
  note: string;
  grantedBy: string;
  /** ms; 0 = unknown. */
  grantedAt: number;
  messageId: string;
  roomId: string;
}

export function grantLine(g: MemberAchievement): GrantLine {
  return { id: g.id, note: g.note, grantedBy: g.grantedBy, grantedAt: g.grantedAt ? timestampMs(g.grantedAt) : 0, messageId: g.messageId, roomId: g.roomId };
}

/** Repeated grants of one achievement: one tile with «×N» (newest grant first). */
export interface AchievementStack {
  achievementId: string;
  grants: GrantLine[];
}

/**
 * The profile's tiles: grants (newest first, as the server lists them) grouped by achievement,
 * in the order of each achievement's newest grant.
 */
export function stackGrants(items: readonly MemberAchievement[]): AchievementStack[] {
  const by = new Map<string, AchievementStack>();
  for (const g of items) {
    const line = grantLine(g);
    const s = by.get(g.achievementId);
    if (s) s.grants.push(line);
    else by.set(g.achievementId, { achievementId: g.achievementId, grants: [line] });
  }
  for (const s of by.values()) s.grants.sort((a, b) => b.grantedAt - a.grantedAt);
  return [...by.values()].sort((a, b) => (b.grants[0]?.grantedAt ?? 0) - (a.grants[0]?.grantedAt ?? 0));
}

/** What may be granted: the live achievements by catalog position, filtered by title. */
export function grantable(catalog: readonly Achievement[], query = ''): Achievement[] {
  const q = query.trim().toLocaleLowerCase();
  return catalog
    .filter((a) => !a.archivedAt && (!q || a.title.toLocaleLowerCase().includes(q)))
    .sort((a, b) => a.position - b.position);
}

/** The thumbs row of the profile card: at most `max`, the rest as «+N». */
export function thumbsRow<T>(items: readonly T[], max = 6): { shown: T[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}

/**
 * The grid cell after an arrow key (the grant dialog, ADR-0061 §5): ←/→ step, ↑/↓ jump a row;
 * clamped to the grid; -1 (nothing chosen) starts at the first cell.
 */
export function gridStep(index: number, key: string, count: number, columns: number): number {
  if (count <= 0) return -1;
  if (index < 0) return 0;
  const step = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : key === 'ArrowDown' ? columns : key === 'ArrowUp' ? -columns : 0;
  const next = index + step;
  return next < 0 || next >= count ? index : next;
}

/** Catalog positions are plain numbers (PATCH position, 0..1 000 000); new ones go to the end. */
export const POSITION_STEP = 1024;
export const POSITION_MAX = 1_000_000;

/**
 * The PATCHes of a drag in the workspace catalog (settings → Библиотека → Ачивки): the moved item takes a free position between
 * its new neighbours; when there is none, the whole list is renumbered by POSITION_STEP (only the
 * items whose position changes are returned). `from` / `to` are indices of `list` (by position).
 */
export function movePositions(list: ReadonlyArray<{ id: string; position: number }>, from: number, to: number): Array<{ id: string; position: number }> {
  if (from === to || !list[from] || to < 0 || to >= list.length) return [];
  const order = [...list];
  const [moved] = order.splice(from, 1);
  if (!moved) return [];
  order.splice(to, 0, moved);
  const prev = order[to - 1]?.position;
  const next = order[to + 1]?.position;
  const p = prev === undefined ? (next ?? 0) - POSITION_STEP : next === undefined ? prev + POSITION_STEP : Math.floor((prev + next) / 2);
  const fits = p >= 0 && p <= POSITION_MAX && (prev === undefined || p > prev) && (next === undefined || p < next);
  if (fits) return [{ id: moved.id, position: p }];
  return order.map((x, i) => ({ id: x.id, position: (i + 1) * POSITION_STEP })).filter((x, i) => order[i]?.position !== x.position);
}
