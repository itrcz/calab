import { describe, expect, it } from 'vitest';
import { detectNativeShell } from './nativeShell';

const IPHONE_WK = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const ANDROID_WV = 'Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Calab/3.0.6 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';
/** The shell's WebView appends `applicationNameForUserAgent` to the stock UA (DEV-4947). */
const ANDROID_SHELL_UA = `${ANDROID_WV} CalabShell/1`;
const IPHONE_SHELL_UA = `${IPHONE_WK} CalabShell/1`;

/** The App Store rule's detection matrix (owner 2026-10-10): fail closed on iOS. */
describe('detectNativeShell', () => {
  it('iOS shell, old handshake (no platform field): iOS by the user agent', () => {
    expect(detectNativeShell({ version: 1 }, IPHONE_WK)).toBe('ios');
  });
  it('iOS shell, new handshake', () => {
    expect(detectNativeShell({ version: 1, platform: 'ios' }, IPHONE_WK)).toBe('ios');
  });
  it('an unproven shell is iOS: an iPad desktop user agent, a field that contradicts the user agent', () => {
    expect(detectNativeShell({ version: 1 }, IPAD_DESKTOP)).toBe('ios');
    expect(detectNativeShell({ version: 1, platform: 'android' }, IPAD_DESKTOP)).toBe('ios');
    expect(detectNativeShell({ version: 1, platform: 'ios' }, ANDROID_WV)).toBe('ios');
  });
  it('Android shell, old and new handshake: no new binary needed', () => {
    expect(detectNativeShell({ version: 1 }, ANDROID_WV)).toBe('android');
    expect(detectNativeShell({ version: 1, platform: 'android' }, ANDROID_WV)).toBe('android');
  });
  it('no shell: Safari on an iPhone, the desktop', () => {
    expect(detectNativeShell(undefined, IPHONE_SAFARI)).toBeNull();
    expect(detectNativeShell(undefined, DESKTOP)).toBeNull();
  });
  it('a bridge of an unknown version is still a shell (fail closed on iOS)', () => {
    expect(detectNativeShell({ version: 2 }, IPHONE_WK)).toBe('ios');
    expect(detectNativeShell({}, IPHONE_WK)).toBe('ios');
    expect(detectNativeShell({ version: 2 }, ANDROID_WV)).toBe('android');
  });
});

/** The Android shell has no bridge (DEV-4947): the UA marker is its only signal. */
describe('detectNativeShell: UA marker (DEV-4947)', () => {
  it('Android shell UA without a bridge is Android', () => {
    expect(detectNativeShell(undefined, ANDROID_SHELL_UA)).toBe('android');
  });
  it('iOS marker without a bridge is iOS', () => {
    expect(detectNativeShell(undefined, IPHONE_SHELL_UA)).toBe('ios');
  });
  it('marker plus a bridge that says iOS stays iOS (the bridge rule wins)', () => {
    expect(detectNativeShell({ version: 1, platform: 'ios' }, ANDROID_SHELL_UA)).toBe('ios');
  });
  it('plain Chrome on Android, no marker, is not a shell', () => {
    expect(detectNativeShell(undefined, ANDROID_CHROME)).toBeNull();
  });
  it('Safari on an iPhone, no marker, is not a shell', () => {
    expect(detectNativeShell(undefined, IPHONE_SAFARI)).toBeNull();
  });
});
