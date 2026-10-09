import { parseCallsOperation, type HostCallsOperation } from './hostCalls';
/** Local, optional host capability (ADR-0056), not a server/auth protocol. No product identifiers. */
export interface SessionActivitySnapshot {
  generation: number;
  status: 'connected' | 'reconnecting' | 'ended';
  muted: boolean;
  language: 'ru' | 'en';
}

export interface SessionActivityCapability {
  publish(snapshot: SessionActivitySnapshot): void;
  clear: (reason?: 'logout') => void;
}

export type HostActivityMessage =
  | ({ v:1; type:'calls'; host:number; document:string; seq:number; request:number } & HostCallsOperation)
  | { v: 1; type: 'hello'; host: number; document: string }
  | { v: 1; type: 'revoke'; host: number; document: string; seq: number; reason?: 'logout' }
  | { v: 1; type: 'notifications'; host: number; document: string; seq: number; request: number; operation: 'status' | 'request' | 'clear' | 'ack' | 'test'; eventId?: string; body?: string }
  | { v: 1; type: 'activity'; host: number; document: string; seq: number; snapshot: SessionActivitySnapshot };

export const HOST_ACTIVITY_MAX_LENGTH = 8192;
export const HOST_ACTIVITY_HEARTBEAT_MS = 30_000;
export const HOST_ACTIVITY_LEASE_SECONDS = 90;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseHostActivityMessage(raw: string): HostActivityMessage | null {
  if (raw.length > HOST_ACTIVITY_MAX_LENGTH) return null;
  // Also runs inside the native JS host: do not require a browser encoding global.
  let bytes = 0;
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > HOST_ACTIVITY_MAX_LENGTH) return null;
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!record(value) || value.v !== 1 || !counter(value.host) || typeof value.document !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(value.document)) return null;
  const base = ['v', 'type', 'host', 'document'];
  if (value.type === 'hello' && keys(value, base)) return value as unknown as HostActivityMessage;
  if (!counter(value.seq) || value.seq < 1) return null;
  if (value.type === 'revoke' && (keys(value, [...base, 'seq']) || (value.reason === 'logout' && keys(value, [...base, 'seq', 'reason'])))) return value as unknown as HostActivityMessage;
  if (value.type === 'calls' && counter(value.request) && value.request > 0) {
    const fields = Object.fromEntries(Object.entries(value).filter(([key]) => ![...base, 'seq', 'request'].includes(key)));
    if (parseCallsOperation(fields)) return value as unknown as HostActivityMessage;
    return null;
  }
  if (value.type === 'notifications' && value.operation === 'ack' && keys(value, [...base, 'seq', 'request', 'operation', 'eventId']) && counter(value.request) && value.request > 0 && typeof value.eventId === 'string' && /^[0-9a-f-]{36}$/i.test(value.eventId)) return value as unknown as HostActivityMessage;
  if (value.type === 'notifications' && value.operation === 'test' && keys(value, [...base, 'seq', 'request', 'operation', 'body']) && counter(value.request) && value.request > 0 && typeof value.body === 'string' && value.body.trim().length > 0 && value.body.length <= 512) return value as unknown as HostActivityMessage;
  if (value.type === 'notifications' && keys(value, [...base, 'seq', 'request', 'operation']) && counter(value.request) && value.request > 0 &&
      ['status', 'request', 'clear'].includes(String(value.operation))) return value as unknown as HostActivityMessage;
  if (value.type !== 'activity' || !keys(value, [...base, 'seq', 'snapshot']) || !record(value.snapshot)) return null;
  const s = value.snapshot;
  if (!keys(s, ['generation', 'status', 'muted', 'language']) || !counter(s.generation) ||
      !['connected', 'reconnecting', 'ended'].includes(String(s.status)) || typeof s.muted !== 'boolean' ||
      (s.language !== 'ru' && s.language !== 'en')) return null;
  return value as unknown as HostActivityMessage;
}

export type HostNotificationPermission = 'unsupported' | 'default' | 'denied' | 'granted';
export type HostNotificationTestResult = 'scheduled' | 'denied' | 'unsupported' | 'failed';
export function parseNotificationTestResult(value: unknown): HostNotificationTestResult | null {
 return value === 'scheduled' || value === 'denied' || value === 'unsupported' || value === 'failed' ? value : null;
}
export interface HostPushReference { binding: string; eventId: string; expiresAt: number }
export interface HostNotificationState {
 permission: HostNotificationPermission;
 appId?: string; environment?: 'development' | 'production'; installationId?: string; token?: string;
 tap?: HostPushReference;
}
export interface HostNotificationsCapability {
 /** A local OS banner only; does not prove remote APNs delivery. Absent on older binaries. */
 test?: (body: string) => Promise<HostNotificationTestResult>;
 state: (requestPermission?: boolean) => Promise<HostNotificationState>;
 subscribe: (listener: (state: HostNotificationState) => void) => () => void;
 clear: (reason?: 'logout') => void;
 acknowledge: (reference: HostPushReference) => void;
}
export function parsePushReference(value: unknown): HostPushReference | null {
 if (!record(value) || !keys(value, ['binding', 'eventId', 'expiresAt']) ||
  typeof value.binding !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.binding) ||
  typeof value.eventId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.eventId) ||
  typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) return null;
 return value as unknown as HostPushReference;
}
export function parseNotificationState(value: unknown): HostNotificationState | null {
 if (!record(value) || !['unsupported', 'default', 'denied', 'granted'].includes(String(value.permission)) ||
  Object.keys(value).some(k => !['permission','appId','environment','installationId','token','tap'].includes(k))) return null;
 if (value.token !== undefined && (value.permission !== 'granted' || typeof value.token !== 'string' || !/^[0-9a-f]{32,512}$/i.test(value.token) ||
  typeof value.appId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/.test(value.appId) || value.appId.length > 255 ||
  !['development','production'].includes(String(value.environment)) || typeof value.installationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.installationId))) return null;
 if (value.tap !== undefined && !parsePushReference(value.tap)) return null;
 return value as unknown as HostNotificationState;
}
