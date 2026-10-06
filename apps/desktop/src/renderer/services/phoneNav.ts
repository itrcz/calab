import { dayKey } from '../lib/calendar/time';
import {
  backStep,
  depthOfState,
  historyPlan,
  historyTarget,
  popScreen,
  pushOnTab,
  pushScreen,
  removeKind,
  switchTab,
  topScreen,
  type PhoneNav,
  type PhoneScreen,
  type PhoneTab,
} from '../lib/phoneNav';
import { closeLayer } from '../lib/phoneMenus';
import { setSettingsQuery } from '../lib/settingsQuery';
import { useArchiveView } from '../stores/archiveView';
import { useBoardsUi } from '../stores/boardsUi';
import { HOME } from '../stores/dms';
import { useFreeBusy } from '../stores/freebusy';
import { useSearchPanel } from '../stores/searchPanel';
import { useUi } from '../stores/ui';
import { useWorkspaces } from '../stores/workspaces';

/**
 * Phone navigation runtime (ADR-0073 §1–§2), installed by MobileShell while the phone layout is on:
 *  - the browser history holds one entry per pushed screen, plus one per open layer (a dialog, a menu
 *    card, each sub-level of a menu),
 *    so Android back (the shell's WebView goBack), the browser's back and our edge swipe all arrive
 *    as `popstate` — which closes the sheet first, else pops the top screen;
 *  - the older per-feature flags (members overlay, search results, calendar event, find time,
 *    task, archived room, «Личные» = the HOME workspace, the calendar day) push / drop their screens
 *    and switch tabs, so every existing entry point keeps working on the phone.
 * Stack logic: lib/phoneNav.ts (unit-tested).
 */

let installed = false;
/** Our level of the current history entry (0 = the base entry). */
let hDepth = 0;
/** A history.go() in flight: the level it lands on (its popstate is ours, not a user's back). */
let pendingGo: number | null = null;
let scheduled = false;
/** The sheet a back just asked to close: not counted while it animates out. */
let closing: { el: Element; until: number } | null = null;
/** This module itself restores the open room: the mirrors must not read it as a user's pick. */
let restoring = false;

const OVERLAY = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [aria-modal="true"]';

/** The topmost open sheet / menu / dialog: a portal next to the app root (Radix layers). */
function openOverlay(): Element | null {
  const now = Date.now();
  if (closing && closing.until < now) closing = null;
  const kids = document.body.children;
  for (let i = kids.length - 1; i >= 0; i--) {
    const el = kids[i];
    if (!el || el.id === 'root') continue;
    const hit = el.matches(OVERLAY) ? el : el.querySelector(OVERLAY);
    if (hit && hit !== closing?.el) return hit;
  }
  return null;
}

/** Open layers (each portal with an open sheet / menu / dialog: a sub-menu is one more). */
function openLayers(): number {
  const now = Date.now();
  if (closing && closing.until < now) closing = null;
  let n = 0;
  for (const el of Array.from(document.body.children)) {
    if (el.id === 'root') continue;
    const hit = el.matches(OVERLAY) ? el : el.querySelector(OVERLAY);
    if (hit && hit !== closing?.el) n += 1;
  }
  return n;
}

function target(): number {
  return historyTarget(useUi.getState().phone.stack.length, openLayers());
}

function sync(): void {
  scheduled = false;
  if (!installed || pendingGo !== null) return;
  const plan = historyPlan(target(), hDepth);
  if (!plan) return;
  if ('push' in plan) {
    for (let i = 0; i < plan.push; i++) {
      hDepth += 1;
      history.pushState({ calabaNav: hDepth }, '');
    }
    return;
  }
  pendingGo = hDepth + plan.go;
  history.go(plan.go);
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(sync);
}

/**
 * Closes the topmost layer: a sub-menu back to its parent level, anything else by Esc (Radix
 * dismisses it; a modal that must not close ignores it) — lib/phoneMenus.ts.
 */
function closeOverlay(el: Element): void {
  closing = { el, until: Date.now() + 600 };
  closeLayer(el);
  // Still open after its exit animation (a call screen answers only to its buttons): its history
  // entry comes back.
  window.setTimeout(() => {
    if (closing?.el === el) closing = null;
    schedule();
  }, 650);
}

/** Turns a screen's feature flag off after the screen was popped (its content source). */
function closeFlag(s: PhoneScreen, next: PhoneScreen | undefined): void {
  switch (s.kind) {
    case 'members':
      if (useUi.getState().membersOverlay) useUi.getState().setMembersOverlay(false);
      break;
    case 'search':
      if (useSearchPanel.getState().open) useSearchPanel.getState().close();
      break;
    case 'event':
      if (useUi.getState().calEvent !== null) useUi.getState().selectCalEvent(null);
      break;
    case 'findTime':
      if (useFreeBusy.getState().find) useFreeBusy.getState().setFind(null);
      break;
    case 'task':
      // Task → its subtask → back: the previous task again.
      useBoardsUi.getState().openTask(next?.kind === 'task' ? next.id : null);
      break;
    case 'archived':
      if (useArchiveView.getState().room) useArchiveView.getState().close();
      break;
    case 'board':
      // Back to the boards list: the boards mode (and a board's task) is off with the screen.
      if (useBoardsUi.getState().active) useBoardsUi.getState().setActive(false);
      break;
    case 'settings':
      // The last settings screen closes its window; the list under a section stays.
      if (next?.kind !== 'settings') closeSettingsSource();
      break;
    case 'room':
    case 'dm':
      break;
  }
  // Back to a chat below: it is the open room again (the list's highlight, read state, links).
  if (next && (next.kind === 'room' || next.kind === 'dm') && (s.kind === 'room' || s.kind === 'dm')) {
    const ws = next.kind === 'dm' ? HOME : next.ws;
    restoring = true;
    try {
      useUi.setState((u) => ({ activeWorkspaceId: ws, lastRoom: u.lastRoom[ws] === next.room ? u.lastRoom : { ...u.lastRoom, [ws]: next.room } }));
    } finally {
      restoring = false;
    }
  }
}

const SETTINGS_DIALOGS = ['settings', 'workspace-settings', 'room-settings'];
/** Identity of the open settings window (its kind and target), null when none: a change replaces the screens. */
function settingsKey(dialog: ReturnType<typeof useUi.getState>['dialog'], board: ReturnType<typeof useBoardsUi.getState>['settingsFor']): string | null {
  if (dialog && SETTINGS_DIALOGS.includes(dialog.kind)) {
    const d = dialog as { kind: string; workspaceId?: string; roomId?: string; tab?: string };
    return `${d.kind}|${d.workspaceId ?? ''}|${d.roomId ?? ''}|${d.tab ?? ''}`;
  }
  if (board?.boardId) return `board|${board.boardId}|${board.tab ?? ''}`;
  return null;
}
const settingsTab = (dialog: ReturnType<typeof useUi.getState>['dialog'], board: ReturnType<typeof useBoardsUi.getState>['settingsFor']): string | null =>
  (dialog && SETTINGS_DIALOGS.includes(dialog.kind) ? (dialog as { tab?: string }).tab : board?.tab) ?? null;

let settingsShown: string | null = null;

/**
 * A settings window opened (or changed) anywhere pushes its screen (the list of sections, or the
 * requested one); closed — the screens go. Every entry point (the profile, the workspace and room
 * menus, a board) keeps calling openDialog / openSettings.
 */
function syncSettings(): void {
  const key = settingsKey(useUi.getState().dialog, useBoardsUi.getState().settingsFor);
  if (key === settingsShown) return;
  settingsShown = key;
  setSettingsQuery('');
  if (key === null) {
    setPhone((n) => removeKind(n, 'settings'));
    return;
  }
  const section = settingsTab(useUi.getState().dialog, useBoardsUi.getState().settingsFor);
  setPhone((n) => pushScreen(removeKind(n, 'settings'), { kind: 'settings', section }));
}

/** The settings window behind the screen is closed (back from it): dialog and board settings alike. */
function closeSettingsSource(): void {
  const ui = useUi.getState();
  if (ui.dialog && SETTINGS_DIALOGS.includes(ui.dialog.kind)) ui.openDialog(null);
  const bu = useBoardsUi.getState();
  if (bu.settingsFor?.boardId) bu.openSettings(null);
}

/** Drops the top screen (one «back»). */
function popTop(): void {
  const ui = useUi.getState();
  const top = topScreen(ui.phone);
  if (!top) return;
  ui.setPhone((n) => popScreen(n));
  closeFlag(top, topScreen(useUi.getState().phone));
}

function onPopState(e: PopStateEvent): void {
  const d = depthOfState(e.state);
  if (pendingGo !== null) {
    pendingGo = null;
    hDepth = d;
    schedule();
    return;
  }
  const prev = hDepth;
  hDepth = d;
  if (d < prev) {
    const overlay = openOverlay();
    const step = backStep({ overlay: overlay !== null, depth: useUi.getState().phone.stack.length });
    if (step === 'overlay' && overlay) {
      closeOverlay(overlay);
      return;
    }
    if (step === 'screen') popTop();
  }
  schedule();
}

/**
 * «←» of a pushed screen and the left-edge swipe: through the history, so the entry goes with the
 * screen (the popstate pops it).
 */
export function phoneBack(): void {
  if (installed && hDepth > 0 && pendingGo === null) history.back();
  else popTop();
}

/** A workspace to show on «Чаты» / «Календарь»: the open one, else the first in the rail. */
export function realWorkspace(): string | null {
  const active = useUi.getState().activeWorkspaceId;
  const ws = useWorkspaces.getState();
  if (active && active !== HOME && ws.byId[active]) return active;
  return ws.order.find((id) => !!ws.byId[id]) ?? (active && active !== HOME ? active : null);
}

/** A tap on the tab bar: the tab's root (the open tab too — back to its root). */
export function openTab(tab: PhoneTab): void {
  const ui = useUi.getState();
  ui.setPhone((n) => switchTab(n, tab));
  if (tab !== 'calendar' && ui.calDay !== null) useUi.getState().closeCalendar();
  // A board / task screen goes with its tab's stack: the boards mode and the open task are off.
  if (ui.phone.stack.some((x) => x.kind === 'board' || x.kind === 'task')) {
    const bu = useBoardsUi.getState();
    if (bu.taskId) bu.openTask(null);
    if (bu.active) bu.setActive(false);
  }
  if (tab === 'dms') {
    if (useUi.getState().activeWorkspaceId !== HOME) useUi.getState().setWorkspace(HOME);
    return;
  }
  // «Профиль» is the account's, not a workspace's: the open workspace stays.
  if (tab === 'profile') return;
  // «Чаты», «Доски», «Календарь»: a real workspace (not «Личные»).
  const ws = realWorkspace();
  if (ws && useUi.getState().activeWorkspaceId !== ws) useUi.getState().setWorkspace(ws);
  if (tab === 'calendar' && useUi.getState().calDay === null) {
    useFreeBusy.getState().setFind(null);
    useUi.getState().openCalendarDay(dayKey(Date.now()), null);
  }
}

const setPhone = (update: (n: PhoneNav) => PhoneNav): void => useUi.getState().setPhone(update);

/** The tab the app opens on: «Личные» when HOME is open, the calendar when a day is. */
function initialTab(): PhoneTab {
  const ui = useUi.getState();
  return ui.activeWorkspaceId === HOME ? 'dms' : ui.calDay !== null ? 'calendar' : 'chats';
}

/** Keeps the stack in step with the feature flags (every existing entry point keeps working). */
function installMirrors(): () => void {
  const offUi = useUi.subscribe((s, prev) => {
    if (restoring) return;
    // «Личные» is the HOME workspace: whoever opens it (⌘K, a link) lands on the tab.
    if (s.activeWorkspaceId !== prev.activeWorkspaceId) {
      if (s.activeWorkspaceId === HOME && s.phone.tab !== 'dms') setPhone((n) => switchTab(n, 'dms'));
      else if (s.activeWorkspaceId !== HOME && prev.activeWorkspaceId === HOME && s.phone.tab === 'dms') setPhone((n) => switchTab(n, 'chats'));
      // Another workspace picked (rail, an invite) without opening a room: its root list.
      else if (s.phone === prev.phone && s.phone.tab === 'chats' && s.phone.stack.length > 0) setPhone((n) => switchTab(n, 'chats'));
    }
    // A day opened from anywhere (a room's meeting badge, a reminder) is the calendar tab.
    if (s.calDay !== null && prev.calDay === null && s.phone.tab !== 'calendar') setPhone((n) => switchTab(n, 'calendar'));
    else if (s.calDay === null && prev.calDay !== null && s.phone.tab === 'calendar' && s.phone === prev.phone) setPhone((n) => switchTab(n, 'chats'));
    if (s.calEvent !== prev.calEvent) {
      const key = s.calEvent;
      if (key) setPhone((n) => pushScreen(n, { kind: 'event', key }));
      else setPhone((n) => removeKind(n, 'event'));
    }
    if (s.membersOverlay !== prev.membersOverlay) {
      const ws = s.activeWorkspaceId;
      const room = ws ? s.lastRoom[ws] : undefined;
      if (s.membersOverlay && ws && ws !== HOME && room) setPhone((n) => pushScreen(n, { kind: 'members', ws, room }));
      else if (!s.membersOverlay) setPhone((n) => removeKind(n, 'members'));
    }
    if (s.dialog !== prev.dialog) syncSettings();
  });
  const offSearch = useSearchPanel.subscribe((s, prev) => {
    if (s.open && (!prev.open || s.seq !== prev.seq)) setPhone((n) => pushScreen(n, { kind: 'search' }));
    else if (!s.open && prev.open) setPhone((n) => removeKind(n, 'search'));
  });
  const offBoards = useBoardsUi.subscribe((s, prev) => {
    if (!s.active && prev.active) setPhone((n) => removeKind(removeKind(n, 'task'), 'board'));
    if (s.settingsFor !== prev.settingsFor) syncSettings();
    if (s.taskId !== prev.taskId) {
      const id = s.taskId;
      if (id) setPhone((n) => pushOnTab(n, 'boards', { kind: 'task', id }));
      else setPhone((n) => removeKind(n, 'task'));
    }
  });
  const offArchive = useArchiveView.subscribe((s, prev) => {
    if (s.room === prev.room) return;
    const room = s.room?.id;
    if (room) setPhone((n) => pushOnTab(n, 'chats', { kind: 'archived', room }));
    else setPhone((n) => removeKind(n, 'archived'));
  });
  const offFind = useFreeBusy.subscribe((s, prev) => {
    if (!!s.find === !!prev.find) return;
    if (s.find) setPhone((n) => pushScreen(n, { kind: 'findTime' }));
    else setPhone((n) => removeKind(n, 'findTime'));
  });
  return () => {
    offUi();
    offSearch();
    offBoards();
    offArchive();
    offFind();
  };
}

/**
 * Installs the phone navigation (MobileShell, once per phone layout). The stack starts at the
 * tab root (a reload lands on the list, as in a messenger); the base history entry is ours.
 */
export function installPhoneNav(): () => void {
  if (installed) return () => undefined;
  installed = true;
  const ui = useUi.getState();
  if (ui.membersOverlay) ui.setMembersOverlay(false);
  ui.setPhone(() => ({ on: true, tab: initialTab(), stack: [] }));
  hDepth = 0;
  pendingGo = null;
  settingsShown = null;
  try {
    history.replaceState({ ...(history.state as object | null), calabaNav: 0 }, '');
  } catch {
    // a sandboxed frame: back stays in-app only
  }
  const offMirrors = installMirrors();
  const offStack = useUi.subscribe((s, prev) => {
    if (s.phone.stack !== prev.phone.stack) schedule();
  });
  const mo = new MutationObserver(schedule);
  mo.observe(document.body, { childList: true });
  window.addEventListener('popstate', onPopState);
  return () => {
    installed = false;
    offMirrors();
    offStack();
    mo.disconnect();
    window.removeEventListener('popstate', onPopState);
    useUi.getState().setPhone((n) => ({ ...n, on: false, stack: [] }));
  };
}
