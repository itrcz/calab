import type { CalendarWidgetAction } from './calendarWidgetLink';
/** Optional, scoped calendar capability. A grant cannot be used for general API access. */
export type CalendarWidgetOperation =
  | { operation: 'opened'; tap: number }
  | { operation: 'bind'; binding: string }
  | { operation: 'configure'; token: string; expiresAt: string }
  | { operation: 'refresh' | 'clear' };

export interface HostCalendarWidgetCapability {
  onOpen?(listener: (action: CalendarWidgetAction) => void): () => void;
  bind(binding: string): Promise<boolean>;
  configure(token: string, expiresAt: string): Promise<boolean>;
  refresh(): Promise<boolean>;
  clear(): Promise<boolean>;
}

export function parseCalendarWidgetOperation(value: unknown): CalendarWidgetOperation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.length === 2 && v.operation === 'opened' && typeof v.tap === 'number' && Number.isSafeInteger(v.tap) && v.tap > 0) return v as CalendarWidgetOperation;
  if (keys.length === 2 && v.operation === 'bind' && typeof v.binding === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.binding)) return v as CalendarWidgetOperation;
  if (keys.length === 1 && (v.operation === 'refresh' || v.operation === 'clear')) return v as CalendarWidgetOperation;
  if (keys.length !== 3 || !keys.every(key => ['operation', 'token', 'expiresAt'].includes(key)) || v.operation !== 'configure' ||
      typeof v.token !== 'string' || v.token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v.token) ||
      typeof v.expiresAt !== 'string' || v.expiresAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T.+Z$/.test(v.expiresAt) || !Number.isFinite(Date.parse(v.expiresAt))) return null;
  return v as CalendarWidgetOperation;
}
