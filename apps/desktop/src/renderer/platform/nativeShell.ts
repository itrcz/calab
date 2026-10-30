/*
 * Which native phone shell hosts this web client (apps/mobile, ADR-0067), if any, and whether any
 * native shell hosts it at all (`inNativeShell`). Purchases, prices and money actions hide in
 * every native shell, iOS and Android alike (owner, 2026-10-30, docs/adr/0148: the App Store rule
 * against payment UI that bypasses in-app purchase started it for iOS; Android gets the same
 * treatment until store billing there is decided). Every browser (Safari on an iPhone included),
 * the PWA and the desktop keep purchases, prices and money actions.
 *
 * Two independent signals, either is enough:
 *  1. the native host bridge `window.CalabHostActivity` (declared only by the shell, main frame
 *     only) and its `platform` field (Platform.OS, added 2026-10-10). Fail closed on iOS: a shell
 *     is Android only when its user agent says Android too and the bridge does not say iOS — an
 *     older binary without the field, a newer bridge version, an iPad with a desktop user agent,
 *     anything unproven is iOS.
 *  2. the UA marker `SHELL_UA_MARKER` the shell's WebView appends to its user agent (DEV-4947):
 *     Android binaries before DEV-5033 declare no bridge (`hostChannelEnabled`,
 *     apps/mobile/src/notifications.ts), so this is their only signal; newer ones declare the
 *     bridge with `platform: 'android'`. With the marker and no bridge, the user agent alone decides Android vs.
 *     iOS. With both present, the bridge's iOS rule above still wins (fail closed on iOS).
 * No new binary is needed for either platform: the user agent tells Android shells apart.
 */

import { shellFromUserAgent } from '../../shared/nativeShell';

export type NativeShell = 'ios' | 'android' | null;

interface ShellBridge {
  version?: unknown;
  platform?: unknown;
}

export function detectNativeShell(bridge: ShellBridge | undefined, userAgent: string): NativeShell {
  if (bridge == null) return shellFromUserAgent(userAgent);
  // Any bridge is a shell, whatever its version: a newer handshake must not show payments (ADR-0148).
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

/** Any native shell, iOS or Android: no payment UI, no prices, no links to pay elsewhere (ADR-0148). */
export const inNativeShell = (): boolean => nativeShell() !== null;

/** Tests only. */
export function resetNativeShellForTests(): void {
  cached = undefined;
}
