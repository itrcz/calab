/**
 * Phone navigation (ADR-0073 §1–§2): root tabs with a bottom tab bar and a stack of pushed
 * screens above the tab root. Pure functions; `useUi.phone` holds the state, services/phoneNav.ts
 * keeps it in step with the browser history (Android back, the browser's back, the edge swipe)
 * and with the older per-feature flags (members, search, calendar event, task…).
 */

export type PhoneTab = 'chats' | 'dms' | 'boards' | 'calendar' | 'profile';
export const PHONE_TABS: readonly PhoneTab[] = ['chats', 'dms', 'boards', 'calendar', 'profile'];

/**
 * A pushed screen. Chats carry their ids (back from room B shows room A again); the other kinds
 * mirror a flag of their feature store, which is the source of their content.
 */
export type PhoneScreen =
  | { kind: 'room'; ws: string; room: string }
  | { kind: 'dm'; room: string }
  | { kind: 'members'; ws: string; room: string }
  | { kind: 'search' }
  | { kind: 'event'; key: string }
  | { kind: 'findTime' }
  | { kind: 'board'; ws: string }
  | { kind: 'task'; id: string }
  | { kind: 'archived'; room: string }
  /**
   * A settings window (app, workspace, room or board; its source is `useUi.dialog` / `useBoardsUi.settingsFor`)
   * as a screen: `section` null = the list of sections (also the search), else that section.
   * The list → section hop is one more screen, so back returns to the list.
   */
  | { kind: 'settings'; section: string | null };

export type ScreenKind = PhoneScreen['kind'];

export interface PhoneNav {
  /** The phone layout drives navigation (services/phoneNav installed); false on the desktop. */
  on: boolean;
  tab: PhoneTab;
  /** Pushed screens over the tab root, bottom first; empty = the tab root with the tab bar. */
  stack: readonly PhoneScreen[];
}

/** Deeper stacks drop their bottom screen (the history keeps working: it counts levels only). */
export const MAX_DEPTH = 8;

export const emptyPhoneNav = (): PhoneNav => ({ on: false, tab: 'chats', stack: [] });

export const topScreen = (nav: Pick<PhoneNav, 'stack'>): PhoneScreen | undefined => nav.stack.at(-1);

const isChat = (s: PhoneScreen): s is Extract<PhoneScreen, { kind: 'room' | 'dm' }> => s.kind === 'room' || s.kind === 'dm';

/** The room / DM the top screen shows, else null (the root list shows no room as read). */
export function visibleRoom(nav: Pick<PhoneNav, 'stack'>): string | null {
  const top = topScreen(nav);
  return top && (top.kind === 'room' || top.kind === 'dm' || top.kind === 'archived') ? top.room : null;
}

export function sameScreen(a: PhoneScreen, b: PhoneScreen): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'room':
    case 'members':
      return a.room === (b as typeof a).room && a.ws === (b as typeof a).ws;
    case 'dm':
    case 'archived':
      return a.room === (b as typeof a).room;
    case 'event':
      return a.key === (b as typeof a).key;
    case 'board':
      return a.ws === (b as typeof a).ws;
    case 'task':
      return a.id === (b as typeof a).id;
    case 'settings':
      return a.section === (b as typeof a).section;
    case 'search':
    case 'findTime':
      return true;
  }
}

/**
 * Pushes a screen. The same screen already in the stack is returned to instead (its screens
 * above are dropped), so a loop room A → B → A never grows the stack.
 */
export function pushScreen(nav: PhoneNav, s: PhoneScreen): PhoneNav {
  const at = nav.stack.findIndex((x) => sameScreen(x, s));
  if (at >= 0) return at === nav.stack.length - 1 ? nav : { ...nav, stack: nav.stack.slice(0, at + 1) };
  return { ...nav, stack: [...nav.stack, s].slice(-MAX_DEPTH) };
}

/** A settings section picked on the list: pushed over the list (a screen of its own). */
export function openSettingsSection(nav: PhoneNav, section: string): PhoneNav {
  return pushScreen(nav, { kind: 'settings', section });
}

export function popScreen(nav: PhoneNav, n = 1): PhoneNav {
  if (n <= 0 || nav.stack.length === 0) return nav;
  return { ...nav, stack: nav.stack.slice(0, Math.max(0, nav.stack.length - n)) };
}

/** Drops every screen of a kind (its feature flag went off elsewhere). */
export function removeKind(nav: PhoneNav, kind: ScreenKind): PhoneNav {
  return nav.stack.some((s) => s.kind === kind) ? { ...nav, stack: nav.stack.filter((s) => s.kind !== kind) } : nav;
}

export const hasKind = (nav: Pick<PhoneNav, 'stack'>, kind: ScreenKind): boolean => nav.stack.some((s) => s.kind === kind);

/** A tab: its root, nothing pushed. Tapping the open tab also returns to its root. */
export function switchTab(nav: PhoneNav, tab: PhoneTab): PhoneNav {
  return nav.tab === tab && nav.stack.length === 0 ? nav : { ...nav, tab, stack: [] };
}

/** The tab a chat lives under: DMs and notes in «Личные», rooms in «Команда». */
export const tabOfChat = (s: Extract<PhoneScreen, { kind: 'room' | 'dm' }>): PhoneTab => (s.kind === 'dm' ? 'dms' : 'chats');

/**
 * Opening a room or a DM from anywhere (the list, a link, a notification, ⌘K, search). Another
 * tab: «tab root → chat» (a deep link). The same tab: the screens that are not chats (members,
 * search, an event…) close — opening a room leaves them in their stores too — and the chat is
 * pushed over the chats below it, so back returns to the room the link was tapped in.
 */
export function openChat(nav: PhoneNav, s: Extract<PhoneScreen, { kind: 'room' | 'dm' }>): PhoneNav {
  const tab = tabOfChat(s);
  if (nav.tab !== tab) return { ...nav, tab, stack: [s] };
  const chats = nav.stack.filter(isChat);
  return pushScreen({ ...nav, stack: chats }, s);
}

/** A screen of a tab: pushed when that tab is open, else «tab root → screen». */
export function pushOnTab(nav: PhoneNav, tab: PhoneTab, s: PhoneScreen): PhoneNav {
  return nav.tab === tab ? pushScreen(nav, s) : { ...nav, tab, stack: [s] };
}

/** What one «back» does: close the open sheet / menu first, else drop the top screen. */
export type BackStep = 'overlay' | 'screen' | 'none';

export function backStep(o: { overlay: boolean; depth: number }): BackStep {
  if (o.overlay) return 'overlay';
  return o.depth > 0 ? 'screen' : 'none';
}

/**
 * The browser history entries the app needs above its base entry: one per pushed screen, plus one
 * per open layer — a dialog, a menu card and each of its sub-levels (owner 07.10: «back» walks a
 * sub-menu back one level), so «back» closes the top one first, even on a tab root.
 */
export const historyTarget = (depth: number, layers: number): number => depth + Math.max(0, layers);

/** How to bring the history from `current` levels to `target`: push entries, or go back. */
export type HistoryPlan = { push: number } | { go: number } | null;

export function historyPlan(target: number, current: number): HistoryPlan {
  if (target > current) return { push: target - current };
  if (target < current) return { go: target - current };
  return null;
}

/** Our level stored in a history entry's state (absent = the base entry). */
export function depthOfState(state: unknown): number {
  const d = (state as { calabaNav?: unknown } | null)?.calabaNav;
  return typeof d === 'number' && Number.isInteger(d) && d >= 0 ? d : 0;
}
