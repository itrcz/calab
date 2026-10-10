/*
 * Which native phone shell hosts this web client (apps/mobile, ADR-0067), if any. The App Store
 * forbids payment UI that bypasses in-app purchase in the iOS shell, so purchases, prices and
 * money actions hide there; the Android shell, every browser (Safari on an iPhone included) and
 * the desktop keep them (owner, 2026-10-10).
 *
 * The signal: the native host bridge `window.CalabHostActivity` (declared only by the shell, main
 * frame only) and its `platform` field (Platform.OS, added 2026-10-10). Fail closed on iOS: a
 * shell is Android only when its user agent says Android too and the bridge does not say iOS — an
 * older binary without the field, an iPad with a desktop user agent, anything unproven is iOS.
 * No new binary is needed for either platform: the user agent tells Android shells apart.
 */

export type NativeShell = 'ios' | 'android' | null;

interface ShellBridge {
  version?: unknown;
  platform?: unknown;
}

export function detectNativeShell(bridge: ShellBridge | undefined, userAgent: string): NativeShell {
  if (!bridge || bridge.version !== 1) return null;
  const androidUa = /\bAndroid\b/i.test(userAgent);
  if (androidUa && bridge.platform !== 'ios') return 'android';
  return 'ios';
}

let cached: NativeShell | undefined;

/** The shell of this window (the bridge is immutable for the page's life: computed once). */
export function nativeShell(): NativeShell {
  if (cached === undefined) {
    cached =
      typeof window === 'undefined'
        ? null
        : detectNativeShell(window.CalabHostActivity, typeof navigator === 'undefined' ? '' : navigator.userAgent);
  }
  return cached;
}

/** The iOS shell: no payment UI, no prices, no links to pay elsewhere (anti-steering). */
export const iosNativeShell = (): boolean => nativeShell() === 'ios';

/** Tests only. */
export function resetNativeShellForTests(): void {
  cached = undefined;
}
