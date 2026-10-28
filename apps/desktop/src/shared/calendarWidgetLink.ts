/** Native widget destinations carry identifiers only. Authorization stays with the normal web API. */
export type CalendarWidgetAction =
  | { kind: 'day' | 'create'; day: string }
  | { kind: 'event'; day: string; event: string; workspace: string; start: string }
  | { kind: 'external'; day: string; uid: string; start: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseCalendarWidgetAction(value: unknown): CalendarWidgetAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.day !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(v.day)) return null;
  const day = new Date(v.day + 'T00:00:00Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== v.day) return null;
  const keys = v.kind === 'day' || v.kind === 'create' ? ['kind', 'day'] : v.kind === 'event' ? ['kind', 'day', 'event', 'workspace', 'start'] : v.kind === 'external' ? ['kind', 'day', 'uid', 'start'] : [];
  if (Object.keys(v).length !== keys.length || !Object.keys(v).every(k => keys.includes(k))) return null;
  if (v.kind === 'event' || v.kind === 'external') {
    if (typeof v.start !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v.start) || !Number.isFinite(Date.parse(v.start))) return null;
    if (v.kind === 'event' && (typeof v.event !== 'string' || !uuid.test(v.event) || typeof v.workspace !== 'string' || !uuid.test(v.workspace))) return null;
    if (v.kind === 'external' && (typeof v.uid !== 'string' || !/^[0-9a-f]{16,64}$/.test(v.uid))) return null;
  }
  return v as CalendarWidgetAction;
}
export function parseCalendarWidgetLink(raw: string, scheme: string): CalendarWidgetAction | null {
  if (raw.length > 1024) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== scheme + ':' || u.hostname !== 'calendar' || u.port || u.username || u.password || u.hash || (u.pathname !== '' && u.pathname !== '/')) return null;
    const value: Record<string, string> = {};
    for (const [key, v] of u.searchParams) { if (Object.hasOwn(value, key)) return null; value[key] = v; }
    return parseCalendarWidgetAction(value);
  } catch { return null; }
}
