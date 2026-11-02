import type { CalendarWidgetAction } from '../../shared/calendarWidgetLink';
import { CalendarWidgetGrantSchema } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { call } from '../lib/api/client';
import { CalendarWidgetSync } from '../lib/calendar/widgetSync';
import { platform } from '../platform';
import { useCalendar } from '../stores/calendar';
import { useFreeBusy } from '../stores/freebusy';
import { useSession } from '../stores/session';

export function installCalendarWidgets(): () => void {
  if (!platform.calendarWidget) return () => undefined;
  const sync = new CalendarWidgetSync(platform.calendarWidget, async signal => {
    const grant = await call('POST', '/api/me/calendar-widget', CalendarWidgetGrantSchema, undefined, signal);
    if (!grant.expiresAt) throw new Error('Calendar grant missing expiry');
    return { token: grant.token, expiresAt: timestampDate(grant.expiresAt).toISOString() };
  });
  let pending: CalendarWidgetAction | null = null;
  const takePending = () => {
    if (!pending || !useSession.getState().ready || useSession.getState().status !== 'authed') return;
    const action = pending; pending = null;
    void import('./calendarWidgetNavigation').then(m => m.openCalendarWidget(action));
  };
  const stopOpen = platform.calendarWidget.onOpen?.(action => { pending = action; takePending(); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const session = () => {
    const s = useSession.getState();
    if (s.status === 'booting' || s.status === 'offline' || (s.status === 'authed' && !s.me)) return;
    sync.session(s.status === 'authed' && s.me?.user && !s.me.user.isBot && !s.me.user.isGuest ? `${s.me.user.id}:${s.sessionId}` : null);
    takePending();
  };
  const changed = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; sync.refresh(); }, 2000);
  };
  const foreground = () => { if (document.visibilityState === 'visible') sync.refresh(); };
  const stops = [useSession.subscribe(session), useCalendar.subscribe(changed), useFreeBusy.subscribe(changed)];
  document.addEventListener('visibilitychange', foreground);
  session();
  return () => { stopOpen?.(); pending = null; for (const stop of stops) stop(); if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', foreground); };
}
