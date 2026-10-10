/** OS authorization only. This capability never starts capture or changes an audio session. */
export type MediaPermissionKind = 'microphone' | 'camera';
export type MediaPermissionStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'n/a';
export interface MediaPermissionsState { microphone: MediaPermissionStatus; camera: MediaPermissionStatus }
export type MediaPermissionsOperation = { operation: 'status' | 'settings' } | { operation: 'request'; kind: MediaPermissionKind };
export interface MediaPermissionsReply { state: MediaPermissionsState; opened?: boolean }
export interface HostMediaPermissionsCapability {
  state(): Promise<MediaPermissionsState>;
  request(kind: MediaPermissionKind): Promise<MediaPermissionsState>;
  openSettings(): Promise<boolean>;
  subscribe(listener: (state: MediaPermissionsState) => void): () => void;
}
export const unavailableMediaPermissions = (): MediaPermissionsState => ({ microphone: 'n/a', camera: 'n/a' });
export function parseMediaPermissionsOperation(value: Record<string, unknown>): MediaPermissionsOperation | null {
  const keys = Object.keys(value);
  if ((value.operation === 'status' || value.operation === 'settings') && keys.length === 1) return { operation: value.operation };
  if (value.operation === 'request' && keys.length === 2 && (value.kind === 'microphone' || value.kind === 'camera')) return { operation: 'request', kind: value.kind };
  return null;
}
export function parseMediaPermissionsState(value: unknown): MediaPermissionsState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  const valid = (status: unknown): status is MediaPermissionStatus => typeof status === 'string' && ['granted', 'denied', 'not-determined', 'restricted', 'n/a'].includes(status);
  if (Object.keys(state).length !== 2 || !valid(state.microphone) || !valid(state.camera)) return null;
  return { microphone: state.microphone, camera: state.camera };
}
