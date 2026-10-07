import { WorkspaceRole } from '@calaba/protocol';
import { dayKey } from '../../lib/calendar/time';
import { MOBILE_QUERY } from '../../lib/phone';
import { sectionFor, type Section, type WsSection } from '../../lib/sections';
import { useBoardsUi } from '../../stores/boardsUi';
import { HOME } from '../../stores/dms';
import { useFreeBusy } from '../../stores/freebusy';
import { contextWorkspaceNow, useSections } from '../../stores/sections';
import { useUi } from '../../stores/ui';
import { useWebApps } from '../../stores/webApps';
import { useWorkspaces } from '../../stores/workspaces';

export type Mode = 'voice' | 'calendar' | 'boards';

/**
 * Switches the workspace mode: «Голос» — the room (calendar and boards off); «Календарь» — today's
 * day view with the mini month (boards off, ADR-0041 §3); «Доски» — the boards (calendar off,
 * ADR-0042 §5). The stores keep the two exclusive on their own as well (a board or a day opened
 * from anywhere turns the other off). The desktop rail's sections (ADR-0074) and the phone's
 * workspace icon go through it.
 */
export function showMode(mode: Mode): void {
  const ui = useUi.getState();
  const boards = useBoardsUi.getState();
  if (mode === 'calendar') {
    if (ui.calDay !== null) return;
    ui.setCalMonth(null);
    useFreeBusy.getState().setFind(null);
    ui.openCalendarDay(dayKey(Date.now()), null);
    ui.toggleMiniCal(true);
    return;
  }
  if (ui.calDay !== null) ui.closeCalendar();
  ui.toggleMiniCal(false);
  if (boards.active !== (mode === 'boards')) boards.setActive(mode === 'boards');
}

/** The phone layout (the web build at ≤ 768 px) — lib/mobile.ts without the platform import (unit tests run in Node). */
const onPhone = (): boolean => typeof window !== 'undefined' && document.documentElement.classList.contains('web') && window.matchMedia(MOBILE_QUERY).matches;

const MODE: Record<WsSection, Mode> = { chats: 'voice', calendar: 'calendar', boards: 'boards' };

const isGuest = (wsId: string): boolean => useWorkspaces.getState().byId[wsId]?.role === WorkspaceRole.GUEST;

/**
 * A click on a section of the rail (ADR-0074 §1): «Личные» opens HOME; the others open in the
 * context workspace (the open one, from «Личные» the last one used). The open section too: a web
 * app is closed and the section shows its content again.
 */
export function openSection(section: Section): void {
  const ui = useUi.getState();
  if (section === 'dms') {
    if (ui.activeWorkspaceId !== HOME) ui.setWorkspace(HOME);
    else if (useWebApps.getState().open) useWebApps.getState().setOpen(null);
    return;
  }
  const ws = contextWorkspaceNow();
  if (!ws) return;
  // setWorkspace closes a web app (ADR-0050 §3); within the same workspace close it here.
  if (ui.activeWorkspaceId !== ws) ui.setWorkspace(ws);
  else if (useWebApps.getState().open) useWebApps.getState().setOpen(null);
  showMode(MODE[isGuest(ws) ? 'chats' : section]);
}

/**
 * A workspace picked in the title bar's switcher (or by ⌘1…⌘9): it opens on the section it was
 * left on (ADR-0074 §1 «Раздел помнится для каждого пространства»); on the phone — on the same tab.
 */
export function openWorkspace(id: string): void {
  // Phone (ADR-0073, no rail): the tab stays (chats / boards / calendar of the new workspace); a
  // guest workspace has no boards or calendar — its rooms.
  if (onPhone()) {
    useUi.getState().setWorkspace(id);
    if (isGuest(id)) showMode('voice');
    return;
  }
  const target = sectionFor(useSections.getState().of, id, isGuest(id));
  useUi.getState().setWorkspace(id);
  showMode(MODE[target]);
}
