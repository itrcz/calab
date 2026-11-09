import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { parseNotificationState, parseNotificationTestResult, type HostNotificationTestResult, type HostNotificationState } from '../../desktop/src/shared/hostActivity';

interface NativePush {
  setBadge(document: string, count: number): Promise<void>;
  testNotification(document: string, body: string): Promise<unknown>;
  pushState(document: string, requestPermission: boolean): Promise<unknown>;
  acknowledgePush(document: string, eventId: string): Promise<void>;
  addListener(name: 'onPushChanged', callback: (value: { document: string; state: unknown }) => void): { remove(): void };
  /**
   * Android only: the handshaken document, which the iOS WebView patch hands to its push module
   * natively; on Android the RN host passes it (ADR-0070, Android). Null revokes it.
   */
  setDocument?(document: string | null, logout: boolean): void;
}
const native = Platform.OS === 'ios' || Platform.OS === 'android' ? requireOptionalNativeModule<NativePush>('CalabMessageNotifications') : null;
/**
 * The channel can truthfully report unsupported even on a build without APNs/FCM; Activity
 * permission is unrelated. Android (DEV-5033): the patched WebMessageListener delivers only
 * main-frame messages of the exact app origin, as the iOS patch does with WKFrameInfo.
 */
export const hostChannelEnabled = Platform.OS === 'ios' || Platform.OS === 'android';

/**
 * Android: hand the handshaken document to the push module, or revoke it (null: navigation, reload,
 * remount, revoke; `logout` also forgets the cold tap and Calab's notifications).
 */
export function setNotificationsDocument(document: string | null, logout: boolean): void {
  if (Platform.OS === 'android') native?.setDocument?.(document, logout);
}
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

export async function testNotification(document: string, body: string): Promise<HostNotificationTestResult> {
  if (!native) return 'unsupported';
  try { return parseNotificationTestResult(await native.testNotification(document, body)) ?? 'failed'; }
  catch { return 'failed'; }
}
export function notificationTestReply(host: number, document: string, request: number, result: HostNotificationTestResult): string {
  return `window.dispatchEvent(new CustomEvent('calab-host-notification-test', {detail: ${JSON.stringify({ v: 1, host, document, request, result })}})); true;`;
}

export function acknowledgeNotification(document: string, eventId: string): void { void native?.acknowledgePush(document, eventId).catch(() => undefined); }

/** The native module rechecks the trusted document; no permission prompt here. */
export function setNotificationBadge(document: string, count: number): void {
  if (Platform.OS === 'ios') void native?.setBadge(document, count).catch(() => undefined);
}
