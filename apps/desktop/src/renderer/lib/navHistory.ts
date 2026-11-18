/**
 * Navigation history (title bar ‹ ›, ⌘[ / ⌘], Alt+←/→; board #113): browser-like back / forward
 * stacks of the places the desktop shows — a room / DM, a board, an open task, the calendar day,
 * mail, the Disk, the wiki, the canvas, telephony, a workspace web app, an opened office file.
 * Pure functions: `locOf` reads a snapshot of the section stores, `recordNav` / `step` move the
 * stacks; services/navHistory.ts records and replays them.
 */
import type { MailBox } from '../stores/mail';

export type Loc =
  | { kind: 'room'; ws: string; room: string | null }
  | { kind: 'cal'; ws: string; day: string; event: string | null }
  /** `board`: a board id or «Мои задачи» (MY_TASKS). */
  | { kind: 'board'; ws: string; board: string }
  /** `from`: the «Все задачи» query the task was opened from ('' = none). */
  | { kind: 'task'; ws: string; board: string; task: string; from: string }
  | { kind: 'disk'; ws: string; folder: string; trash: boolean }
  | { kind: 'wiki'; ws: string; page: string }
  | { kind: 'canvas'; ws: string; item: string }
  | { kind: 'tel'; ws: string; page: string; detail: string | null }
  | { kind: 'app'; ws: string; app: string }
  /** Personal, not tied to a workspace (ADR-0088). `boxKey` is the box as one string (equality). */
  | { kind: 'mail'; box: MailBox; boxKey: string; thread: string | null; message: string | null; row: string | null }
  /** An office file tab on screen (ADR-0143). */
  | { kind: 'file'; ws: string; tab: string };

export interface History {
  back: Loc[];
  forward: Loc[];
}

export const HISTORY_LIMIT = 50;
export const emptyHistory = (): History => ({ back: [], forward: [] });

/** A place as one string: two locations are the same place when their keys are equal. */
export function locKey(l: Loc): string {
  switch (l.kind) {
    case 'room':
      return `room\n${l.ws}\n${l.room ?? ''}`;
    case 'cal':
      return `cal\n${l.ws}\n${l.day}\n${l.event ?? ''}`;
    case 'board':
      return `board\n${l.ws}\n${l.board}`;
    case 'task':
      // The board it is opened over and the search it came from don't make it another place.
      return `task\n${l.ws}\n${l.task}`;
    case 'disk':
      return `disk\n${l.ws}\n${l.trash ? '\ntrash' : l.folder}`;
    case 'wiki':
      return `wiki\n${l.ws}\n${l.page}`;
    case 'canvas':
      return `canvas\n${l.ws}\n${l.item}`;
    case 'tel':
      return `tel\n${l.ws}\n${l.page}\n${l.detail ?? ''}`;
    case 'app':
      return `app\n${l.ws}\n${l.app}`;
    case 'mail':
      return `mail\n${l.boxKey}\n${l.thread ?? ''}`;
    case 'file':
      return `file\n${l.tab}`;
  }
}

export const sameLoc = (a: Loc | null | undefined, b: Loc | null | undefined): boolean => !!a && !!b && locKey(a) === locKey(b);

/** A workspace with no room yet (still loading / empty) is not worth returning to. */
const worth = (l: Loc): boolean => l.kind !== 'room' || l.room !== null;

/**
 * A navigation from `from` to `to`: `from` goes on the back stack, forward is cleared. `replace`
 * (J/K to the next task, ↑/↓ in the mail list) moves within the current entry: nothing is pushed.
 */
export function recordNav(h: History, from: Loc | null, to: Loc, replace = false): History {
  if (replace || !from || !worth(from) || sameLoc(from, to)) return h;
  const back = sameLoc(h.back.at(-1), from) ? h.back : [...h.back, from].slice(-HISTORY_LIMIT);
  return { back, forward: [] };
}

/** {@link recordNav} without replace — the room-only API it grew from. */
export const pushLoc = (h: History, from: Loc | null, to: Loc): History => recordNav(h, from, to);

/**
 * One step back (dir -1) or forward (+1) from `cur`. Entries rejected by `valid` (deleted rooms,
 * closed boards, left workspaces, closed file tabs) are skipped. Returns null when there is nowhere to go.
 */
export function step(h: History, cur: Loc | null, dir: -1 | 1, valid: (l: Loc) => boolean): { history: History; to: Loc } | null {
  let from = dir < 0 ? [...h.back] : [...h.forward];
  const other = dir < 0 ? [...h.forward] : [...h.back];
  for (;;) {
    const to = from.pop();
    if (!to) return null;
    if (!valid(to) || sameLoc(to, cur)) continue;
    if (cur && worth(cur)) other.push(cur);
    from = from.slice(-HISTORY_LIMIT);
    const history = dir < 0 ? { back: from, forward: other.slice(-HISTORY_LIMIT) } : { back: other.slice(-HISTORY_LIMIT), forward: from };
    return { history, to };
  }
}

/** What the section stores say is on screen (services/navHistory.ts reads them). */
export interface NavSnapshot {
  /** The active workspace (HOME for «Личные»). */
  ws: string | null;
  home: boolean;
  guest: boolean;
  /** The remembered room / DM of `ws`. */
  room: string | null;
  /** The office file tab on screen. */
  fileTab: string | null;
  /** The mail section is on: what it shows. */
  mail: { box: MailBox; boxKey: string; thread: string | null; message: string | null; row: string | null } | null;
  /** The open web app of `ws`. */
  app: string | null;
  disk: { folder: string; trash: boolean } | null;
  wiki: { page: string } | null;
  canvas: { item: string } | null;
  tel: { page: string; detail: string | null } | null;
  boards: { board: string; task: string | null; from: string } | null;
  cal: { day: string; event: string | null } | null;
}

/** The place on screen, in the order AppShell picks what fills the window (file, mail, «Личные», app, sections, day, room). */
export function locOf(s: NavSnapshot): Loc | null {
  const ws = s.ws;
  // In «Личные» and a guest workspace too (CBF-195): the file view covers the chat there as well.
  if (s.fileTab && ws) return { kind: 'file', ws, tab: s.fileTab };
  if (s.mail) return { kind: 'mail', ...s.mail };
  if (!ws) return null;
  if (s.home) return { kind: 'room', ws, room: s.room };
  if (s.app) return { kind: 'app', ws, app: s.app };
  if (!s.guest) {
    if (s.disk) return { kind: 'disk', ws, ...s.disk };
    if (s.wiki) return { kind: 'wiki', ws, page: s.wiki.page };
    if (s.canvas) return { kind: 'canvas', ws, item: s.canvas.item };
    if (s.tel) return { kind: 'tel', ws, ...s.tel };
    if (s.boards) {
      const { board, task, from } = s.boards;
      return task ? { kind: 'task', ws, board, task, from } : { kind: 'board', ws, board };
    }
  }
  if (s.cal) return { kind: 'cal', ws, ...s.cal };
  return { kind: 'room', ws, room: s.room };
}
