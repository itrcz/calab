import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { parseMediaPermissionsState, unavailableMediaPermissions, type MediaPermissionKind, type MediaPermissionsOperation, type MediaPermissionsReply, type MediaPermissionsState } from '../../desktop/src/shared/hostPermissions';

interface NativePermissions {
  mediaPermissions(document: string): Promise<unknown>;
  requestMediaPermission(document: string, kind: MediaPermissionKind): Promise<unknown>;
  openAppSettings(document: string): Promise<boolean>;
  addListener(name: 'onPermissionsChanged', callback: (value: { document: string; state: unknown }) => void): { remove(): void };
}
const native = Platform.OS === 'ios' ? requireOptionalNativeModule<NativePermissions>('CalabSessionActivity') : null;
export async function permissionsOperation(document: string, operation: MediaPermissionsOperation): Promise<MediaPermissionsReply> {
  try {
    if (operation.operation === 'request') return { state: parseMediaPermissionsState(await native?.requestMediaPermission(document, operation.kind)) ?? unavailableMediaPermissions() };
    const opened = operation.operation === 'settings' ? await native?.openAppSettings(document) === true : undefined;
    return { state: parseMediaPermissionsState(await native?.mediaPermissions(document)) ?? unavailableMediaPermissions(), ...(opened !== undefined ? { opened } : {}) };
  } catch { return { state: unavailableMediaPermissions() }; }
}
export function permissionsReply(host: number, document: string, request: number, reply: MediaPermissionsReply): string {
  return `window.dispatchEvent(new CustomEvent('calab-host-permissions', {detail: ${JSON.stringify({ v: 1, host, document, request, ...reply })}})); true;`;
}
export function subscribePermissions(callback: (document: string, state: MediaPermissionsState) => void): () => void {
  const subscription = native?.addListener('onPermissionsChanged', value => {
    const state = parseMediaPermissionsState(value.state); if (state) callback(value.document, state);
  });
  return () => subscription?.remove();
}
