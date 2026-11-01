import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import type { HostMediaSession } from '../../desktop/src/shared/hostActivity';

interface NativeMediaSession {
  set(document: string, session: string, language: string): void;
  clear(): void;
  addListener(name: 'onMediaAction', callback: (value: { document: string; action: string }) => void): { remove(): void };
}

/**
 * Android only (board #141): a `microphone` foreground service while the shared web client is in
 * a voice room or a call, so Android keeps the microphone when the app goes to the background.
 * The module starts it only while the app is in the foreground and RECORD_AUDIO is granted
 * (Android 12+/14+ rules); its ongoing notification opens the app and offers «Выйти» /
 * «Завершить», which comes back here as `leave` for the document that started it. iOS keeps
 * the call with `UIBackgroundModes audio` and has no such module.
 */
const native = Platform.OS === 'android' ? requireOptionalNativeModule<NativeMediaSession>('CalabMediaSession') : null;
export const mediaSessionEnabled = native !== null;

export function setMediaSession(document: string, session: HostMediaSession, language: 'ru' | 'en'): void {
  try {
    if (session === 'none') native?.clear();
    else native?.set(document, session, language);
  } catch {
    // Best effort: without the service the call still works in the foreground.
  }
}

/** Navigation, reload, crash, remount, revoke and logout: the page that asked is gone. */
export function clearMediaSession(): void {
  try { native?.clear(); } catch { /* best effort */ }
}

export function subscribeMediaSession(callback: (document: string) => void): () => void {
  const subscription = native?.addListener('onMediaAction', (value) => {
    if (value.action === 'leave' && typeof value.document === 'string') callback(value.document);
  });
  return () => subscription?.remove();
}
