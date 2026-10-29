/**
 * The UA marker the phone shell (apps/mobile) appends to the WebView's engine user agent via
 * `applicationNameForUserAgent` (react-native-webview, both platforms) — appended to the stock
 * UA, nothing else in it changes. It lets the web client recognize the Android shell without a
 * bridge (DEV-4947): Android never got `window.CalabHostActivity` (`hostChannelEnabled`,
 * apps/mobile/src/notifications.ts, is iOS-only), so the web treated an Android shell like any
 * other browser — a task link opened a "open in the app" card whose `calab://` the shell's
 * navigation policy then blocked.
 *
 * Shared by both sides (precedent: `hostActivity.ts` is imported by apps/mobile).
 */

export const SHELL_UA_MARKER = 'CalabShell/1';

/** Android vs. iOS from a user agent carrying the marker; null when the marker is absent. */
export function shellFromUserAgent(userAgent: string): 'ios' | 'android' | null {
  if (!userAgent.includes(SHELL_UA_MARKER)) return null;
  return /\bAndroid\b/i.test(userAgent) ? 'android' : 'ios';
}
