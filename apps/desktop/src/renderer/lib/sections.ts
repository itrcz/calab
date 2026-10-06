import type { PhoneTab } from './phoneNav';
import { isDm } from '../stores/dms';
import { showsUnread } from '../stores/rooms';

/**
 * The sections of the desktop rail (ADR-0074): the same four as the phone's tabs (ADR-0073) —
 * «Чаты», «Личные», «Календарь», «Доски». Pure helpers: which section is on screen, the section
 * remembered per workspace, the workspace the sections work in, and the rail / switcher badges.
 */
export type Section = PhoneTab;
/** Sections that live inside a workspace («Личные» is the HOME pseudo-workspace). */
export type WsSection = Exclude<Section, 'dms'>;

/**
 * The section on screen, from the state that already decides the content: «Личные» = HOME, the
 * boards mode wins over a day view (as the centre does), else the rooms. `app`: a web app of the
 * workspace fills the screen — no section is selected (its icon carries the mark).
 */
export function currentSection(s: { home: boolean; boards: boolean; calendar: boolean; app?: boolean }): Section | null {
  if (s.home) return 'dms';
  if (s.app) return null;
  return s.boards ? 'boards' : s.calendar ? 'calendar' : 'chats';
}

/** The memory with `section` stored for `wsId`; the same object when nothing changes (no store write). */
export function rememberSection(map: Readonly<Record<string, WsSection>>, wsId: string, section: WsSection): Readonly<Record<string, WsSection>> {
  return map[wsId] === section ? map : { ...map, [wsId]: section };
}

/** The section a workspace opens on: the remembered one; guests have rooms only (no calendar, no boards). */
export function sectionFor(map: Readonly<Record<string, WsSection>>, wsId: string, guest: boolean): WsSection {
  const s = map[wsId] ?? 'chats';
  return guest ? 'chats' : s;
}

/**
 * The workspace «Чаты», «Календарь», «Доски» and the switcher title refer to: the open one; on
 * «Личные» (or with nothing open) the last one used if it still exists, else the first one.
 */
export function contextWorkspace(active: string | null, last: string | null, home: string, order: readonly string[], known: (id: string) => boolean): string | null {
  if (active && active !== home && known(active)) return active;
  if (last && known(last)) return last;
  return order.find(known) ?? null;
}

type UnreadSource = Parameters<typeof showsUnread>[1] & { mentions: Readonly<Record<string, number>> };

/**
 * A badge as one primitive (store selectors compare it by value): > 0 — that many mentions (the
 * red count); -1 — unread without mentions (the dot); 0 — nothing. Muted rooms count only their
 * mentions (docs/09 item 22).
 */
export type Badge = number;
export const UNREAD_DOT: Badge = -1;

function badgeOf(s: UnreadSource, match: (workspaceId: string) => boolean): Badge {
  let mentions = 0;
  let unread = false;
  for (const r of Object.values(s.byId)) {
    if (isDm(r) || r.workspaceId === '' || !match(r.workspaceId)) continue;
    mentions += s.mentions[r.id] ?? 0;
    if (!unread && mentions === 0 && showsUnread(r.id, s)) unread = true;
  }
  return mentions > 0 ? mentions : unread ? UNREAD_DOT : 0;
}

/** The rooms of one workspace: the «Чаты» section's badge and a switcher row's. */
export const workspaceBadge = (s: UnreadSource, wsId: string): Badge => badgeOf(s, (w) => w === wsId);

/** Every workspace but `except` (the title's dot: something waits elsewhere). */
export const otherWorkspacesBadge = (s: UnreadSource, except: string | null): Badge => badgeOf(s, (w) => w !== except);

/** «Личные»: unread DM messages — each counts as a mention (docs/05). */
export function dmBadge(s: UnreadSource): number {
  let n = 0;
  for (const id in s.mentions) if (isDm(s.byId[id])) n += s.mentions[id] ?? 0;
  return n;
}
