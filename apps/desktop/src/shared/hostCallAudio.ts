/** Optional iOS audio transport. Authentication and call decisions stay in the shared renderer. */
export interface HostAudioControls {
  muted: boolean;
  deafened: boolean;
  volume: number;
  userVolumes: Record<string, number>;
}
export interface HostAudioConnect {
  eventId: string;
  connectionId: string;
  roomId: string;
  url: string;
  token: string;
  relayOnly: boolean;
  bitrate: number;
  canSpeak: boolean;
  controls: HostAudioControls;
}
export interface HostAudioState {
  eventId: string;
  connectionId: string;
  phase: 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'failed';
  microphoneReady: boolean;
  muted: boolean;
  canSpeak: boolean;
  speakers: string[];
  error?: 'permission' | 'connection' | 'audio' | 'superseded' | 'removed' | 'duplicate' | 'closed' | 'network';
}
export type HostAudioOperation =
  | ({ operation: 'audioConnect' } & HostAudioConnect)
  | { operation: 'audioControl'; eventId: string; connectionId: string; controls: HostAudioControls }
  | { operation: 'audioDisconnect'; eventId: string; connectionId: string };
export interface HostCallAudioCapability {
  connect(input: HostAudioConnect): Promise<HostAudioState | null>;
  control(eventId: string, connectionId: string, controls: HostAudioControls): void;
  disconnect(eventId: string, connectionId: string): void;
  subscribe(listener: (state: HostAudioState) => void): () => void;
}
export const audioUUID = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) && v !== '00000000-0000-0000-0000-000000000000';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string) => Object.keys(v).sort().join(',') === expected;
const volume = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
export function parseAudioControls(v: unknown): HostAudioControls | null {
  if (!record(v) || !keys(v, 'deafened,muted,userVolumes,volume') || typeof v.muted !== 'boolean' || typeof v.deafened !== 'boolean' || !volume(v.volume) || !record(v.userVolumes)) return null;
  const users = Object.entries(v.userVolumes);
  if (users.length > 64 || users.some(([id, level]) => !audioUUID(id) || !volume(level))) return null;
  return v as unknown as HostAudioControls;
}
export function parseAudioOperation(v: Record<string, unknown>): HostAudioOperation | null {
  if (!audioUUID(v.eventId) || !audioUUID(v.connectionId)) return null;
  if (v.operation === 'audioDisconnect' && keys(v, 'connectionId,eventId,operation')) return v as unknown as HostAudioOperation;
  if (v.operation === 'audioControl' && keys(v, 'connectionId,controls,eventId,operation') && parseAudioControls(v.controls)) return v as unknown as HostAudioOperation;
  if (v.operation !== 'audioConnect' || !keys(v, 'bitrate,canSpeak,connectionId,controls,eventId,operation,relayOnly,roomId,token,url') || !audioUUID(v.roomId) || !parseAudioControls(v.controls) || typeof v.relayOnly !== 'boolean' || typeof v.canSpeak !== 'boolean' || !Number.isInteger(v.bitrate) || Number(v.bitrate) < 8000 || Number(v.bitrate) > 64000 || typeof v.token !== 'string' || v.token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v.token) || typeof v.url !== 'string' || v.url.length > 1024) return null;
  try { const u = new URL(v.url); if (u.protocol !== 'wss:' || !u.hostname || u.username || u.password || u.hash) return null; } catch { return null; }
  return v as unknown as HostAudioOperation;
}
export function parseAudioState(v: unknown): HostAudioState | null {
  if (!record(v) || Object.keys(v).some(k => !['eventId', 'connectionId', 'phase', 'microphoneReady', 'muted', 'canSpeak', 'speakers', 'error'].includes(k)) || !audioUUID(v.eventId) || !audioUUID(v.connectionId) || !['connecting', 'connected', 'reconnecting', 'ended', 'failed'].includes(String(v.phase)) || typeof v.microphoneReady !== 'boolean' || typeof v.muted !== 'boolean' || typeof v.canSpeak !== 'boolean' || !Array.isArray(v.speakers) || v.speakers.length > 64 || !v.speakers.every(audioUUID)) return null;
  if (v.error !== undefined && (typeof v.error !== 'string' || !['permission', 'connection', 'audio', 'superseded', 'removed', 'duplicate', 'closed', 'network'].includes(v.error))) return null;
  return v as unknown as HostAudioState;
}
