import type { CalendarWidgetAction } from '../../shared/calendarWidgetLink';
import { externalKey } from '../lib/calendar/external';
import { freebusyApi } from '../lib/calendar/freebusyApi';
import { addDays, dayStart } from '../lib/calendar/time';
import { useFreeBusy } from '../stores/freebusy';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { useWorkspaces } from '../stores/workspaces';
import { calendarAvailable, ensureMonth, openEventOccurrence } from './calendar';

/** Runs only after READY. Every async result is fenced to the same account/session. */
export async function openCalendarWidget(action: CalendarWidgetAction): Promise<void> {
  const session = useSession.getState();
  if (!session.ready || session.status !== 'authed') return;
  const current = () => useSession.getState().sessionId === session.sessionId && useSession.getState().ready;
  const ui = useUi.getState();
  const wanted = action.kind === 'event' ? action.workspace : ui.activeWorkspaceId;
  const ws = wanted && calendarAvailable(wanted) ? wanted : Object.keys(useWorkspaces.getState().byId).find(calendarAvailable);
  if (!ws) return;
  ui.setWorkspace(ws);
  useUi.getState().openCalendarDay(action.day, null);
  ensureMonth(ws, action.day.slice(0, 7));
  if (action.kind === 'create') {
    const { newEvent, defaultDraft } = await import('../features/calendar/actions');
    if (current()) newEvent(ws, defaultDraft(action.day));
  } else if (action.kind === 'event') {
    await openEventOccurrence(action.event, Date.parse(action.start));
  } else if (action.kind === 'external') {
    try {
      const events = await freebusyApi.externalEvents(ws, dayStart(addDays(action.day, -1)), dayStart(addDays(action.day, 2)));
      if (!current() || useUi.getState().activeWorkspaceId !== ws || useUi.getState().calDay !== action.day) return;
      const event = events.find(e => e.uid === action.uid && e.start === Date.parse(action.start));
      if (!event) return; // Removed or access changed: keep the requested calendar day open.
      useFreeBusy.setState(s => ({ externalWs: ws, externalChunks: s.externalWs === ws ? s.externalChunks : {}, external: { ...(s.externalWs === ws ? s.external : {}), [action.day]: events } }));
      useUi.getState().selectCalEvent(externalKey(event));
    } catch { /* Offline, removed or denied: the day remains available. */ }
  }
}
