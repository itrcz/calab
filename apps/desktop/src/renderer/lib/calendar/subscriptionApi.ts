import { CalendarSubscriptionSchema } from '@calaba/protocol';
import { call, callBytes, callEmpty, qs } from '../api/client';

const path = (workspaceId: string): string => `/api/workspaces/${encodeURIComponent(workspaceId)}/calendar-subscription`;
export const calendarSubscription = (workspaceId: string, method: 'GET' | 'POST' | 'PUT' = 'GET', signal?: AbortSignal) =>
  call(method, path(workspaceId), CalendarSubscriptionSchema, undefined, signal);
export const revokeCalendarSubscription = (workspaceId: string): Promise<void> => callEmpty('DELETE', path(workspaceId));

/** Range is inclusive in the form, exclusive on the wire, in the user's local timezone. */
export function exportRange(from: string, through: string): { from: string; to: string } | null {
  const parse = (day: string): Date | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const d = new Date(`${day}T00:00:00`);
    if (
      !Number.isFinite(d.getTime()) ||
      d.getFullYear() !== Number(day.slice(0, 4)) ||
      d.getMonth() + 1 !== Number(day.slice(5, 7)) ||
      d.getDate() !== Number(day.slice(8))
    )
      return null;
    return d;
  };
  const a = parse(from),
    b = parse(through);
  if (!a || !b) return null;
  b.setDate(b.getDate() + 1);
  const span = b.getTime() - a.getTime();
  return span > 0 && span <= 400 * 86400000 ? { from: a.toISOString(), to: b.toISOString() } : null;
}

async function download(path: string, signal?: AbortSignal): Promise<void> {
  const bytes = await callBytes(path, signal);
  if (signal?.aborted) return;
  const blob = new Blob([new Uint8Array(bytes)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'calab.ics';
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const downloadCalendar = (workspaceId: string, range: { from: string; to: string }, signal?: AbortSignal): Promise<void> =>
  download(`/api/workspaces/${encodeURIComponent(workspaceId)}/calendar.ics${qs(range)}`, signal);
export const downloadCalendarEvent = (eventId: string): Promise<void> => download(`/api/events/${encodeURIComponent(eventId)}/calendar.ics`);
