import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { parseNotificationState, type HostNotificationState } from '../../desktop/src/shared/hostActivity';

interface NativePush {
  pushState(document: string, requestPermission: boolean): Promise<unknown>;
  acknowledgePush(document: string, eventId: string): Promise<void>;
  addListener(name: 'onPushChanged', callback: (value: { document: string; state: unknown }) => void): { remove(): void };
}
const native = Platform.OS === 'ios' ? requireOptionalNativeModule<NativePush>('CalabMessageNotifications') : null;
// The channel can truthfully report unsupported even on a build without APNs; Activity permission is unrelated.
export const hostChannelEnabled = Platform.OS === 'ios';
export async function notificationState(document: string, request: boolean): Promise<HostNotificationState> {
  try { return parseNotificationState(await native?.pushState(document, request)) ?? { permission: 'unsupported' }; }
  catch { return { permission: 'unsupported' }; }
}
export function subscribeNotifications(callback: (document: string, state: HostNotificationState) => void): () => void {
  const subscription = native?.addListener('onPushChanged', (value) => {
    const state = parseNotificationState(value.state);
    if (state) callback(value.document, state);
  });
  return () => subscription?.remove();
}
export function notificationReply(host: number, document: string, request: number, state: HostNotificationState): string {
  const detail = JSON.stringify({ v: 1, host, document, request, state });
  return `window.dispatchEvent(new CustomEvent('calab-host-notifications', {detail: ${detail}})); true;`;
}

export function acknowledgeNotification(document: string, eventId: string): void { void native?.acknowledgePush(document, eventId).catch(() => undefined); }
